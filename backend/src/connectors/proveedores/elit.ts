// Elit — https://clientes.elit.com.ar/v1/api/productos
// POST con { user_id, token } en el body; paginado con limit (máx 100) y offset
// (índice del primer artículo; la API rechaza offset=0).
// `precio` es el costo según tu lista (sin IVA); `pvp_*` es el precio sugerido
// de venta al público, que no usamos. moneda: 1 = pesos, 2 = dólares.

import { AdaptadorProveedor, CatalogoTraido, ItemCatalogo, conPartNumber, env, pedirJson } from './tipos.js';

const URL_BASE = 'https://clientes.elit.com.ar/v1/api/productos';
const PAGINA = 100;

interface ProductoElit {
    id: number;
    codigo_alfa?: string;
    codigo_producto?: string;
    nombre: string;
    categoria?: string;
    sub_categoria?: string;
    marca?: string;
    precio?: number;
    impuesto_interno?: number;
    iva?: number;
    moneda?: number;
    cotizacion?: number;
    pvp_usd?: number;
    nivel_stock?: string;
    stock_total?: number;
    link?: string;
    imagenes?: string[];
}

const userId = () => env('ELIT_USER_ID') || env('ELIT_API_USER');
const token = () => env('ELIT_TOKEN') || env('ELIT_API_TOKEN');

function mapear(p: ProductoElit): ItemCatalogo | null {
    if (!p.nombre || p.id == null) return null;
    return {
        sku: String(p.id),
        descripcion: conPartNumber(p.nombre, p.codigo_producto),
        marca: p.marca ?? null,
        categoria: [p.categoria, p.sub_categoria].filter(Boolean).join(' / ') || null,
        precio: typeof p.precio === 'number' && p.precio > 0 ? p.precio : null,
        moneda: p.moneda === 1 ? 'ARS' : 'USD',
        iva_pct: p.iva ?? null,
        stock: p.stock_total ?? null,
        url_imagen: p.imagenes?.[0] ?? null,
        raw: {
            codigo_alfa: p.codigo_alfa,
            part_number: p.codigo_producto,
            impuesto_interno: p.impuesto_interno,
            nivel_stock: p.nivel_stock,
            pvp_usd: p.pvp_usd,
            cotizacion_elit: p.cotizacion,
            link: p.link,
        },
    };
}

export const elit: AdaptadorProveedor = {
    codigo: 'elit',
    faltaConfig() {
        if (!userId() || !token()) return 'Faltan ELIT_USER_ID y ELIT_TOKEN en el .env';
        if (!/^\d+$/.test(userId())) return 'ELIT_USER_ID tiene que ser el número de cliente';
        return null;
    },
    async traerCatalogo(): Promise<CatalogoTraido> {
        const body = JSON.stringify({ user_id: Number(userId()), token: token() });
        const items: ItemCatalogo[] = [];
        let total = Infinity;
        for (let offset = 0; offset < total; offset += PAGINA) {
            // Elit rechaza offset=0: la primera página va sin offset.
            const qs = offset === 0 ? `limit=${PAGINA}` : `limit=${PAGINA}&offset=${offset}`;
            const j = await pedirJson(`${URL_BASE}?${qs}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
                body,
            }, 'Elit') as { codigo?: number; paginador?: { total?: number }; resultado?: ProductoElit[]; mensaje?: string; error?: string };
            if (j.codigo && j.codigo !== 200) throw new Error(`Elit: ${j.mensaje ?? j.error ?? `código ${j.codigo}`}`);
            total = j.paginador?.total ?? 0;
            const pagina = j.resultado ?? [];
            if (pagina.length === 0) break;
            for (const p of pagina) {
                const it = mapear(p);
                if (it) items.push(it);
            }
        }
        return { items, completo: true };
    },
};
