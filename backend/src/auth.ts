// Login del panel: una contraseña (PANEL_PASSWORD) y tokens firmados con HMAC.
// Sin PANEL_PASSWORD el login queda desactivado, salvo en producción (Railway),
// donde el backend se niega a arrancar para no quedar expuesto.

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

const DURACION_MS = 30 * 24 * 60 * 60 * 1000; // 30 días
const RUTAS_PUBLICAS = new Set(['/health', '/auth/login', '/auth/estado']);

const enProduccion = () => Boolean(process.env.RAILWAY_ENVIRONMENT) || process.env.NODE_ENV === 'production';
const password = () => process.env.PANEL_PASSWORD ?? '';
export const authActiva = () => password().length > 0;

// Cambiar la contraseña invalida todas las sesiones abiertas.
function secreto(): string {
    return createHash('sha256')
        .update(`bartez-auth:${process.env.AUTH_SECRET ?? ''}:${password()}:${process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''}`)
        .digest('hex');
}

function firmar(payload: string): string {
    return createHmac('sha256', secreto()).update(payload).digest('base64url');
}

function iguales(a: string, b: string): boolean {
    const ba = Buffer.from(a);
    const bb = Buffer.from(b);
    return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export function emitirToken(): string {
    const payload = Buffer.from(JSON.stringify({ exp: Date.now() + DURACION_MS })).toString('base64url');
    return `${payload}.${firmar(payload)}`;
}

export function tokenValido(token: string | undefined): boolean {
    if (!token) return false;
    const [payload, firma] = token.split('.');
    if (!payload || !firma || !iguales(firma, firmar(payload))) return false;
    try {
        const { exp } = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { exp: number };
        return typeof exp === 'number' && exp > Date.now();
    } catch {
        return false;
    }
}

function tokenDe(header: string | undefined): string | undefined {
    return header?.startsWith('Bearer ') ? header.slice(7) : undefined;
}

// Freno a la fuerza bruta: 10 intentos fallidos por IP cada 15 minutos y, para
// quien pruebe desde muchas IPs, 50 fallidos en total: pasado eso nadie entra con
// contraseña hasta que termine la ventana (las sesiones abiertas siguen andando).
const fallos = new Map<string, { n: number; desde: number }>();
const VENTANA_MS = 15 * 60 * 1000;
const MAX_POR_IP = 10;
const MAX_TOTAL = 50;
let fallosTotales = { n: 0, desde: 0 };
const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function registrarAuth(app: FastifyInstance): void {
    if (!authActiva()) {
        if (enProduccion()) {
            throw new Error('PANEL_PASSWORD no está configurada: el backend no arranca en producción sin login.');
        }
        app.log.warn('[auth] PANEL_PASSWORD vacía — login desactivado (solo aceptable en local)');
    }

    // preHandler (no onRequest) para que corra después de CORS: así el 401
    // lleva los headers CORS y el panel puede detectarlo y pedir login.
    app.addHook('preHandler', async (req, reply) => {
        if (!authActiva() || req.method === 'OPTIONS') return;
        const ruta = req.url.split('?')[0] ?? '';
        if (RUTAS_PUBLICAS.has(ruta)) return;
        if (!tokenValido(tokenDe(req.headers.authorization))) {
            return reply.code(401).send({ error: 'no autorizado' });
        }
    });

    app.get('/auth/estado', async (req) => ({
        requerida: authActiva(),
        valido: !authActiva() || tokenValido(tokenDe(req.headers.authorization)),
    }));

    app.post('/auth/login', async (req, reply) => {
        if (!authActiva()) return { token: '' };
        const ip = req.ip;
        const ahora = Date.now();
        if (ahora - fallosTotales.desde >= VENTANA_MS) fallosTotales = { n: 0, desde: ahora };
        const f = fallos.get(ip);
        if ((f && ahora - f.desde < VENTANA_MS && f.n >= MAX_POR_IP) || fallosTotales.n >= MAX_TOTAL) {
            return reply.code(429).send({ error: 'Demasiados intentos. Probá en 15 minutos.' });
        }
        const intento = String((req.body as { password?: unknown } | null)?.password ?? '');
        if (!iguales(createHash('sha256').update(intento).digest('hex'), createHash('sha256').update(password()).digest('hex'))) {
            const actual = f && ahora - f.desde < VENTANA_MS ? f : { n: 0, desde: ahora };
            fallos.set(ip, { n: actual.n + 1, desde: actual.desde });
            fallosTotales.n++;
            // Que la tabla no crezca sin fin con IPs viejas.
            if (fallos.size > 1000) for (const [k, v] of fallos) if (ahora - v.desde >= VENTANA_MS) fallos.delete(k);
            await esperar(400); // cada intento fallido cuesta tiempo
            return reply.code(401).send({ error: 'Contraseña incorrecta' });
        }
        fallos.delete(ip);
        return { token: emitirToken() };
    });
}
