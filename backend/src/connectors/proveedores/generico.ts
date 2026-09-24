// Mapeo genérico de una fila (JSON o CSV) al formato del catálogo: busca los
// campos por nombre (sku/codigo, descripcion/nombre, precio, stock, ...).
// Lo usa la importación manual de listas en CSV.

import type { ItemCatalogo } from './tipos.js';

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
