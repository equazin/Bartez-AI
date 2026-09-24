// Conector HTTP genérico, configurable por variables de entorno. Se usa para
// los tres proveedores mientras no tengamos su documentación exacta: trae un
// JSON, busca el array de productos y mapea los campos por nombre (sku/codigo,
// descripcion/nombre, precio, stock, ...). Cuando llegue la doc de cada API,
// se ajusta el adaptador específico (paginación, auth, nombres de campos).
//
// Variables por proveedor (PREFIJO = ELIT | AIR | INVID):
//   <PREFIJO>_API_URL      URL que devuelve la lista de productos (obligatoria)
//   <PREFIJO>_API_TOKEN    token (se manda como Bearer, o como query/body si se indica)
//   <PREFIJO>_API_USER     usuario / user_id si la API lo pide
//   <PREFIJO>_API_METHOD   GET (default) o POST
//   <PREFIJO>_API_AUTH     'bearer' (default) | 'query' | 'body'
//   <PREFIJO>_MONEDA       USD (default) o ARS

import type { AdaptadorProveedor, ItemCatalogo } from './tipos.js';

const CAMPOS = {
    sku: ['sku', 'codigo', 'code', 'cod', 'id_producto', 'codigo_producto', 'part_number', 'partnumber', 'id'],
    descripcion: ['descripcion', 'description', 'nombre', 'name', 'titulo', 'title', 'detalle'],
    marca: ['marca', 'brand', 'fabricante', 'manufacturer'],
    categoria: ['categoria', 'category', 'rubro', 'subcategoria', 'familia'],
    precio: ['precio', 'price', 'precio_usd', 'pvp', 'precio_lista', 'costo', 'precio_final', 'precio_neto'],
    iva: ['iva', 'iva_pct', 'alicuota_iva', 'tax', 'impuesto_iva'],
    stock: ['stock', 'stock_total', 'cantidad', 'disponible', 'qty', 'quantity', 'existencia'],
    imagen: ['imagen', 'image', 'url_imagen', 'foto', 'img', 'thumbnail'],
};

function tomar(o: Record<string, unknown>, claves: string[]): unknown {
    const lower = new Map(Object.keys(o).map((k) => [k.toLowerCase(), k]));
    for (const c of claves) {
        const k = lower.get(c);
        if (k !== undefined && o[k] !== null && o[k] !== '') return o[k];
    }
    return undefined;
}

function num(v: unknown): number | null {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (typeof v === 'string') {
        // Soporta "1.234,56" y "1234.56"
        const s = v.trim().replace(/[^\d,.-]/g, '');
        const normal = s.includes(',') && s.lastIndexOf(',') > s.lastIndexOf('.')
            ? s.replace(/\./g, '').replace(',', '.')
            : s.replace(/,/g, '');
        const n = Number(normal);
        return Number.isFinite(n) ? n : null;
    }
    if (typeof v === 'boolean') return v ? 1 : 0;
    return null;
}

function texto(v: unknown): string | null {
    if (v === undefined || v === null) return null;
    if (typeof v === 'object') {
        const o = v as Record<string, unknown>;
        return (o.nombre ?? o.name ?? o.descripcion ?? null) as string | null;
    }
    return String(v).trim() || null;
}

// Encuentra el primer array de objetos dentro de la respuesta (data, resultado, productos, ...).
function encontrarArray(j: unknown, prof = 0): Record<string, unknown>[] {
    if (Array.isArray(j)) return j.filter((x) => x && typeof x === 'object') as Record<string, unknown>[];
    if (j && typeof j === 'object' && prof < 3) {
        for (const v of Object.values(j as Record<string, unknown>)) {
            const a = encontrarArray(v, prof + 1);
            if (a.length > 0) return a;
        }
    }
    return [];
}

export function mapearItem(o: Record<string, unknown>, monedaDefault: 'USD' | 'ARS'): ItemCatalogo | null {
    const sku = texto(tomar(o, CAMPOS.sku));
    const descripcion = texto(tomar(o, CAMPOS.descripcion));
    if (!sku || !descripcion) return null;
    const monedaRaw = String(tomar(o, ['moneda', 'currency']) ?? '').toUpperCase();
    const moneda: 'USD' | 'ARS' = monedaRaw.includes('ARS') || monedaRaw === '$' ? 'ARS'
        : monedaRaw.includes('USD') || monedaRaw.includes('U$') ? 'USD' : monedaDefault;
    return {
        sku,
        descripcion,
        marca: texto(tomar(o, CAMPOS.marca)),
        categoria: texto(tomar(o, CAMPOS.categoria)),
        precio: num(tomar(o, CAMPOS.precio)),
        moneda,
        iva_pct: num(tomar(o, CAMPOS.iva)),
        stock: num(tomar(o, CAMPOS.stock)),
        url_imagen: texto(tomar(o, CAMPOS.imagen)),
        raw: o,
    };
}

export function crearAdaptadorGenerico(codigo: AdaptadorProveedor['codigo'], prefijo: string): AdaptadorProveedor {
    const env = (k: string) => process.env[`${prefijo}_${k}`] ?? '';
    return {
        codigo,
        faltaConfig() {
            if (!env('API_URL')) return `Falta ${prefijo}_API_URL en el .env (y la documentación de la API para ajustar el conector)`;
            return null;
        },
        async traerCatalogo() {
            const url = new URL(env('API_URL'));
            const metodo = (env('API_METHOD') || 'GET').toUpperCase();
            const auth = (env('API_AUTH') || 'bearer').toLowerCase();
            const token = env('API_TOKEN');
            const user = env('API_USER');
            const moneda = (env('MONEDA') || 'USD').toUpperCase() === 'ARS' ? 'ARS' : 'USD';

            const headers: Record<string, string> = { Accept: 'application/json' };
            let body: string | undefined;
            if (auth === 'bearer' && token) headers.Authorization = `Bearer ${token}`;
            if (auth === 'query') {
                if (token) url.searchParams.set('token', token);
                if (user) url.searchParams.set('user_id', user);
            }
            if (auth === 'body' || metodo === 'POST') {
                headers['Content-Type'] = 'application/json';
                body = JSON.stringify({ ...(user ? { user_id: user } : {}), ...(token ? { token } : {}) });
            }

            const res = await fetch(url, { method: metodo, headers, body, signal: AbortSignal.timeout(60_000) });
            if (!res.ok) throw new Error(`${codigo}: HTTP ${res.status} ${res.statusText}`);
            const json = await res.json();
            const filas = encontrarArray(json);
            if (filas.length === 0) throw new Error(`${codigo}: la respuesta no trae una lista de productos reconocible`);
            return filas.map((f) => mapearItem(f, moneda)).filter((x): x is ItemCatalogo => x !== null);
        },
    };
}
