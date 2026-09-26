// Conexión con la API de Google Ads (REST). Fase 1: solo lectura.
//
// Credenciales en el entorno (Railway): GOOGLE_ADS_CLIENT_ID,
// GOOGLE_ADS_CLIENT_SECRET, GOOGLE_ADS_CUSTOMER_ID y, si se entra por una cuenta
// administradora, GOOGLE_ADS_LOGIN_CUSTOMER_ID.
// Google dio de baja los tokens de desarrollador el 9/9/2026: el nivel de acceso
// (Test, Explorer, Basic) ahora es del proyecto de Google Cloud dueño del
// ID de cliente OAuth, y se pide en console.cloud.google.com/google/ads-apis/overview.
// Por eso no se manda el token aunque esté cargado.
// El permiso de acceso (refresh token) no se copia a mano: se obtiene con el
// botón "Conectar Google Ads" del panel y queda cifrado en la base.

import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { supabase } from './supabase.js';

const env = (k: string) => (process.env[k] ?? '').trim();
const soloDigitos = (s: string) => s.replace(/\D/g, '');

export const adsConfig = () => ({
    clientId: env('GOOGLE_ADS_CLIENT_ID'),
    clientSecret: env('GOOGLE_ADS_CLIENT_SECRET'),
    customerId: soloDigitos(env('GOOGLE_ADS_CUSTOMER_ID')),
    loginCustomerId: soloDigitos(env('GOOGLE_ADS_LOGIN_CUSTOMER_ID')),
    redirectUri: env('GOOGLE_ADS_REDIRECT_URI') || 'https://bartez-ai-production.up.railway.app/ads/oauth/callback',
    panelUrl: env('PANEL_URL') || 'https://equazin.github.io/Bartez-AI/',
});

// Qué falta para poder conectar (nombres de variables, nunca valores).
export function faltantesAds(): string[] {
    const c = adsConfig();
    return [
        !c.clientId && 'GOOGLE_ADS_CLIENT_ID',
        !c.clientSecret && 'GOOGLE_ADS_CLIENT_SECRET',
        !c.customerId && 'GOOGLE_ADS_CUSTOMER_ID',
    ].filter(Boolean) as string[];
}

const CLAVE_TOKEN = 'google_ads_refresh_token';
const CLAVE_CONECTADO = 'google_ads_conectado_en';

// Cifrado del refresh token (AES-256-GCM). Si cambia el client secret, el token
// guardado deja de servir y hay que volver a conectar, que es lo correcto.
function claveCifrado(): Buffer {
    return createHash('sha256').update(`bartez-ads:${adsConfig().clientSecret}:${env('SUPABASE_SERVICE_ROLE_KEY')}`).digest();
}
export function cifrar(texto: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', claveCifrado(), iv);
    const datos = Buffer.concat([c.update(texto, 'utf8'), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), datos]).toString('base64');
}
export function descifrar(b64: string): string | null {
    try {
        const b = Buffer.from(b64, 'base64');
        const d = createDecipheriv('aes-256-gcm', claveCifrado(), b.subarray(0, 12));
        d.setAuthTag(b.subarray(12, 28));
        return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
    } catch {
        return null;
    }
}

// "state" del OAuth: firmado y con vencimiento, para que nadie pueda colar su
// propia cuenta de Google en la de Bartez.
function secretoState(): string {
    return createHash('sha256').update(`ads-state:${env('AUTH_SECRET')}:${env('PANEL_PASSWORD')}:${adsConfig().clientSecret}`).digest('hex');
}
export function crearState(): string {
    const p = Buffer.from(JSON.stringify({ exp: Date.now() + 10 * 60_000, n: randomBytes(8).toString('hex') })).toString('base64url');
    return `${p}.${createHmac('sha256', secretoState()).update(p).digest('base64url')}`;
}
export function stateValido(state: string | undefined): boolean {
    if (!state) return false;
    const [p, f] = state.split('.');
    if (!p || !f) return false;
    const esperada = Buffer.from(createHmac('sha256', secretoState()).update(p).digest('base64url'));
    const recibida = Buffer.from(f);
    if (esperada.length !== recibida.length || !timingSafeEqual(esperada, recibida)) return false;
    try {
        const { exp } = JSON.parse(Buffer.from(p, 'base64url').toString()) as { exp: number };
        return typeof exp === 'number' && exp > Date.now();
    } catch { return false; }
}

export function urlAutorizacion(): string {
    const c = adsConfig();
    const q = new URLSearchParams({
        client_id: c.clientId,
        redirect_uri: c.redirectUri,
        response_type: 'code',
        scope: 'https://www.googleapis.com/auth/adwords',
        access_type: 'offline',
        prompt: 'consent',
        include_granted_scopes: 'true',
        state: crearState(),
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
}

export async function canjearCodigo(code: string): Promise<void> {
    const c = adsConfig();
    const r = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ code, client_id: c.clientId, client_secret: c.clientSecret, redirect_uri: c.redirectUri, grant_type: 'authorization_code' }),
        signal: AbortSignal.timeout(20_000),
    });
    const j = await r.json().catch(() => ({})) as { refresh_token?: string; error?: string; error_description?: string };
    if (!r.ok) throw new Error(j.error_description || j.error || `Google respondió ${r.status}`);
    if (!j.refresh_token) throw new Error('Google no devolvió permiso permanente. Quitá el acceso de "Bartez AI" en tu cuenta de Google y volvé a conectar.');
    const ahora = new Date().toISOString();
    await supabase.from('integraciones_config').upsert({ clave: CLAVE_TOKEN, valor: cifrar(j.refresh_token), actualizado_en: ahora });
    await supabase.from('integraciones_config').upsert({ clave: CLAVE_CONECTADO, valor: ahora, actualizado_en: ahora });
    tokenCache = null;
}

export async function desconectar(): Promise<void> {
    await supabase.from('integraciones_config').delete().in('clave', [CLAVE_TOKEN, CLAVE_CONECTADO]);
    tokenCache = null;
}

async function refreshToken(): Promise<string | null> {
    const { data } = await supabase.from('integraciones_config').select('valor').eq('clave', CLAVE_TOKEN).maybeSingle();
    return data?.valor ? descifrar(data.valor as string) : null;
}

export async function estadoConexion(): Promise<{ configurado: boolean; faltan: string[]; conectado: boolean; conectado_en: string | null }> {
    const faltan = faltantesAds();
    const { data } = await supabase.from('integraciones_config').select('clave, valor').in('clave', [CLAVE_TOKEN, CLAVE_CONECTADO]);
    const fila = (k: string) => data?.find((d) => d.clave === k)?.valor as string | undefined;
    const token = fila(CLAVE_TOKEN);
    return {
        configurado: faltan.length === 0,
        faltan,
        conectado: faltan.length === 0 && !!token && descifrar(token) !== null,
        conectado_en: fila(CLAVE_CONECTADO) ?? null,
    };
}

let tokenCache: { valor: string; vence: number } | null = null;

async function accessToken(): Promise<string> {
    if (tokenCache && tokenCache.vence > Date.now() + 60_000) return tokenCache.valor;
    const rt = await refreshToken();
    if (!rt) throw new Error('Google Ads no está conectado');
    const c = adsConfig();
    const r = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ refresh_token: rt, client_id: c.clientId, client_secret: c.clientSecret, grant_type: 'refresh_token' }),
        signal: AbortSignal.timeout(20_000),
    });
    const j = await r.json().catch(() => ({})) as { access_token?: string; expires_in?: number; error?: string };
    if (!r.ok || !j.access_token) {
        throw new Error(j.error === 'invalid_grant' ? 'El permiso de Google Ads venció o fue quitado: volvé a conectar desde el panel' : `No se pudo renovar el acceso a Google (${j.error ?? r.status})`);
    }
    tokenCache = { valor: j.access_token, vence: Date.now() + (j.expires_in ?? 3600) * 1000 };
    return j.access_token;
}

// Versión de la API: la más nueva publicada (Google retira las viejas cada año).
let versionCache: { v: string; en: number } | null = null;
export async function versionApi(): Promise<string> {
    const fija = env('GOOGLE_ADS_API_VERSION');
    if (fija) return fija;
    if (versionCache && Date.now() - versionCache.en < 24 * 3600_000) return versionCache.v;
    for (let n = 32; n >= 25; n--) {
        try {
            const r = await fetch(`https://googleads.googleapis.com/$discovery/rest?version=v${n}`, { method: 'GET', signal: AbortSignal.timeout(8_000) });
            if (r.ok) { versionCache = { v: `v${n}`, en: Date.now() }; return `v${n}`; }
        } catch { /* sigue probando */ }
    }
    return 'v25';
}

export type FilaAds = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

// Consulta GAQL (solo lectura). Devuelve las filas tal cual vienen (camelCase).
export async function consultarAds(gaql: string): Promise<FilaAds[]> {
    const c = adsConfig();
    if (faltantesAds().length) throw new Error(`Falta configurar: ${faltantesAds().join(', ')}`);
    const v = await versionApi();
    const headers: Record<string, string> = {
        Authorization: `Bearer ${await accessToken()}`,
        'Content-Type': 'application/json',
    };
    if (c.loginCustomerId) headers['login-customer-id'] = c.loginCustomerId;
    const r = await fetch(`https://googleads.googleapis.com/${v}/customers/${c.customerId}/googleAds:searchStream`, {
        method: 'POST', headers, body: JSON.stringify({ query: gaql }), signal: AbortSignal.timeout(60_000),
    });
    const j = await r.json().catch(() => null) as unknown;
    if (!r.ok) {
        const err = (Array.isArray(j) ? j[0] : j) as { error?: { message?: string; details?: Array<{ errors?: Array<{ message?: string; errorCode?: Record<string, string> }> }> } } | null;
        const e0 = err?.error?.details?.[0]?.errors?.[0];
        const codigo = Object.values(e0?.errorCode ?? {}).join(' ');
        if (/CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION|ACTION_NOT_PERMITTED/.test(codigo)) {
            throw new Error('Google Ads: el proyecto de Google Cloud todavía tiene acceso de prueba. Pedí el acceso "Explorer" en console.cloud.google.com/google/ads-apis/overview y volvé a probar.');
        }
        throw new Error(`Google Ads: ${e0?.message ?? err?.error?.message ?? `HTTP ${r.status}`}`);
    }
    return (Array.isArray(j) ? j : [j]).flatMap((b) => ((b as { results?: FilaAds[] })?.results ?? []));
}
