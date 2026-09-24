// Air — https://api.air-intra.com/v2
// 1) GET /login?user=&pass=  → { token, cotiza, ... }  (o AIR_TOKEN fijo)
// 2) POST /articulos?page=N con Authorization: Bearer  → 500 artículos por página,
//    la primera es 0; un array vacío [] marca el final.
// Errores vienen como { error_id, error_name, error_detail }. La API rechaza
// (403) la misma consulta repetida dentro de 5 minutos.
// `precio` es sin IVA (coincide con impuesto_iva.base_imponible). moneda 'DOL' = dólares.

import { AdaptadorProveedor, CatalogoTraido, ItemCatalogo, conPartNumber, env, pedirJson } from './tipos.js';

const URL_BASE = 'https://api.air-intra.com/v2';
const MAX_PAGINAS = 200; // tope de seguridad (100.000 artículos)

interface Deposito { disponible?: number | string }
interface ArticuloAir {
    codigo: string;
    descrip: string;
    part_number?: string;
    precio?: number;
    moneda?: string;
    impuesto_iva?: { alicuota?: number };
    impuesto_interno?: { alicuota?: number };
    estado?: { id?: string; name?: string };
    rubro?: string;
    grupo?: string;
    garantia?: string;
    air?: Deposito; ros?: Deposito; cba?: Deposito; mza?: Deposito; lug?: Deposito;
}
interface ErrorAir { error_id?: number; error_name?: string; error_detail?: string }

const usuario = () => env('AIR_USER') || env('AIR_API_USER');
const clave = () => env('AIR_PASSWORD') || env('AIR_API_PASSWORD');
// Token fijo generado en la intranet. Vence: si hay usuario y contraseña se
// renueva solo; si no, hay que generar uno nuevo y reemplazarlo en el .env.
const tokenFijo = () => env('AIR_TOKEN') || env('AIR_API_TOKEN');
const puedeLoguear = () => Boolean(usuario() && clave());

function esError(j: unknown): j is ErrorAir {
    return !!j && typeof j === 'object' && !Array.isArray(j) && 'error_id' in j;
}

function stockDe(a: ArticuloAir): number | null {
    const n = (d?: Deposito) => (d?.disponible == null ? null : Number(d.disponible));
    // "air" es el total general; si no viene, sumamos los depósitos.
    const general = n(a.air);
    if (general != null && Number.isFinite(general)) return general;
    const deps = [a.ros, a.cba, a.mza, a.lug].map(n).filter((x): x is number => x != null && Number.isFinite(x));
    return deps.length ? deps.reduce((s, x) => s + x, 0) : null;
}

function mapear(a: ArticuloAir): ItemCatalogo | null {
    if (!a.codigo || !a.descrip) return null;
    const moneda = String(a.moneda ?? '').toUpperCase();
    return {
        sku: String(a.codigo).trim(),
        descripcion: conPartNumber(a.descrip.trim(), a.part_number),
        marca: null,
        categoria: a.rubro ?? null,
        precio: typeof a.precio === 'number' && a.precio > 0 ? a.precio : null,
        moneda: moneda.startsWith('DOL') || moneda.includes('USD') || moneda.includes('U$') ? 'USD' : 'ARS',
        iva_pct: a.impuesto_iva?.alicuota ?? null,
        stock: stockDe(a),
        url_imagen: null,
        raw: {
            part_number: a.part_number,
            impuesto_interno: a.impuesto_interno?.alicuota,
            estado: a.estado?.name,
            grupo: a.grupo,
            garantia: a.garantia,
        },
    };
}

async function login(): Promise<string> {
    const qs = new URLSearchParams({ user: usuario(), pass: clave() });
    const j = await pedirJson(`${URL_BASE}/login?${qs}`, { headers: { Accept: 'application/json' } }, 'Air') as ErrorAir & { token?: string };
    if (j.error_id) throw new Error(`Air: ${j.error_name} — ${j.error_detail ?? ''}`);
    if (!j.token) throw new Error('Air: el login no devolvió token');
    return j.token;
}

export const air: AdaptadorProveedor = {
    codigo: 'air',
    faltaConfig() {
        if (!tokenFijo() && !puedeLoguear()) return 'Faltan AIR_TOKEN, o AIR_USER y AIR_PASSWORD, en el .env';
        return null;
    },
    async traerCatalogo(): Promise<CatalogoTraido> {
        let token = tokenFijo() || await login();
        let renovado = !tokenFijo();
        const items: ItemCatalogo[] = [];
        for (let page = 0; page < MAX_PAGINAS; page++) {
            const pedir = () => pedirJson(`${URL_BASE}/articulos?page=${page}`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
            }, 'Air').catch((e: Error) => {
                if (/HTTP 401/.test(e.message)) return { error_id: 401, error_name: e.message } as ErrorAir;
                throw e;
            });
            let j = await pedir();
            // Token vencido o inválido → pedir uno nuevo una sola vez.
            if (esError(j) && j.error_id === 401 && !renovado && puedeLoguear()) {
                token = await login();
                renovado = true;
                j = await pedir();
            }
            if (esError(j) && j.error_id === 401 && !puedeLoguear()) {
                throw new Error('Air: el token venció o no es válido. Generá uno nuevo en la intranet y reemplazá AIR_TOKEN, o cargá AIR_USER y AIR_PASSWORD para que se renueve solo.');
            }
            if (esError(j)) {
                const extra = j.error_id === 403 && /many/i.test(j.error_name ?? '')
                    ? ' (Air no deja repetir la misma consulta en 5 minutos; probá de nuevo en un rato)' : '';
                throw new Error(`Air: ${j.error_name} — ${j.error_detail ?? ''}${extra}`);
            }
            if (!Array.isArray(j) || j.length === 0) break;
            for (const a of j as ArticuloAir[]) {
                const it = mapear(a);
                if (it) items.push(it);
            }
        }
        return { items, completo: true };
    },
};
