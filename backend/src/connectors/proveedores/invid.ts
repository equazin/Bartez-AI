// Invid — https://invidcomputers.com/api/v1 (OpenAPI en /api/openapi.yaml)
// 1) POST /auth.php { username, password } → access_token (JWT, 24 h)
// 2) GET /articulo.php?offset=N con Bearer → 100 artículos por página;
//    next_page_url indica si hay más.
// Límite: 50 requests por hora → como mucho ~4.500 artículos por corrida.
// Si el catálogo es más grande, la corrida queda parcial (no se borra lo que
// no vino) y la siguiente sigue desde donde quedó.
// PRICE es "sin impuestos". STOCK solo viene si la cuenta tiene permiso.

import { supabase } from '../supabase.js';
import { AdaptadorProveedor, CatalogoTraido, ItemCatalogo, conPartNumber, env, pedirJson } from './tipos.js';

const URL_BASE = 'https://invidcomputers.com/api/v1';
const PAGINA = 100;
const MAX_REQUESTS = 45; // de 50/h; dejamos margen (el login no cuenta en este límite)

interface ArticuloInvid {
    ID: string;
    TITLE?: string;
    DESCRIPTION?: string;
    PRICE?: string | number;
    CURRENCY?: string;
    PART_NUMBER?: string;
    BRAND?: string;
    STOCK_STATUS?: string;
    STOCK?: number;
    IMAGE_URL?: string;
    CATEGORY?: string;
    CATEGORIES?: Array<{ NAME?: string; PARENT?: { NAME?: string } }>;
}

const usuario = () => env('INVID_USER') || env('INVID_API_USER');
const clave = () => env('INVID_PASSWORD') || env('INVID_API_PASSWORD');

function stockDe(a: ArticuloInvid): number | null {
    if (typeof a.STOCK === 'number') return a.STOCK;
    if (/sin stock/i.test(a.STOCK_STATUS ?? '')) return 0;
    return null; // hay stock pero Invid no informa cuánto
}

function mapear(a: ArticuloInvid): ItemCatalogo | null {
    const titulo = (a.TITLE || a.DESCRIPTION || '').trim();
    if (!a.ID || !titulo) return null;
    const precio = Number(a.PRICE);
    const moneda = String(a.CURRENCY ?? '').toUpperCase();
    const cat = a.CATEGORIES?.[0];
    return {
        sku: String(a.ID).trim(),
        descripcion: conPartNumber(titulo, a.PART_NUMBER),
        marca: a.BRAND ?? null,
        categoria: (cat ? [cat.PARENT?.NAME, cat.NAME].filter(Boolean).join(' / ') : a.CATEGORY) || null,
        precio: Number.isFinite(precio) && precio > 0 ? precio : null,
        moneda: moneda.includes('U') || moneda.includes('D') ? 'USD' : 'ARS',
        iva_pct: null, // Invid no lo informa: el cotizador usa 21%
        stock: stockDe(a),
        url_imagen: a.IMAGE_URL ?? null,
        raw: { part_number: a.PART_NUMBER, stock_status: a.STOCK_STATUS },
    };
}

async function login(): Promise<string> {
    const j = await pedirJson(`${URL_BASE}/auth.php`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ username: usuario(), password: clave() }),
    }, 'Invid') as { status?: number; access_token?: string; message?: string };
    if (!j.access_token) throw new Error(`Invid: ${j.message ?? 'el login no devolvió token'}`);
    return j.access_token;
}

// Dónde quedó la corrida anterior si el catálogo no entró en una sola.
async function leerOffset(): Promise<number> {
    const { data } = await supabase.from('proveedores').select('cursor_sync').eq('codigo', 'invid').maybeSingle();
    return Number((data as { cursor_sync?: number } | null)?.cursor_sync ?? 0) || 0;
}
async function guardarOffset(n: number): Promise<void> {
    await supabase.from('proveedores').update({ cursor_sync: n }).eq('codigo', 'invid');
}

export const invid: AdaptadorProveedor = {
    codigo: 'invid',
    faltaConfig() {
        if (!usuario() || !clave()) return 'Faltan INVID_USER e INVID_PASSWORD en el .env';
        return null;
    },
    async traerCatalogo(): Promise<CatalogoTraido> {
        const token = await login();
        const inicio = await leerOffset();
        const items: ItemCatalogo[] = [];
        let offset = inicio;
        let hayMas = true;
        for (let n = 0; n < MAX_REQUESTS && hayMas; n++) {
            const j = await pedirJson(`${URL_BASE}/articulo.php?offset=${offset}&exclude_zero_price=1`, {
                headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
            }, 'Invid') as { status?: number; data?: ArticuloInvid[]; next_page_url?: string | null; message?: string };
            if (j.status !== 1) throw new Error(`Invid: ${j.message ?? 'respuesta inesperada'}`);
            const pagina = Array.isArray(j.data) ? j.data : [];
            for (const a of pagina) {
                const it = mapear(a);
                if (it) items.push(it);
            }
            hayMas = Boolean(j.next_page_url) && pagina.length > 0;
            offset += PAGINA;
        }
        // Terminó el catálogo → la próxima corrida arranca de cero.
        await guardarOffset(hayMas ? offset : 0);
        const completo = inicio === 0 && !hayMas;
        return {
            items,
            completo,
            nota: completo ? undefined
                : hayMas ? `Catálogo grande: se trajeron ${items.length} artículos (límite de 50 consultas/hora de Invid). La próxima sincronización sigue desde el ${offset}.`
                : `Se completó el resto del catálogo (${items.length} artículos en esta tanda).`,
        };
    },
};
