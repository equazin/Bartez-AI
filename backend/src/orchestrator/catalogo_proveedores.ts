// Sincronización del catálogo de proveedores → tabla catalogo_proveedores.
// - sincronizarProveedor(codigo): trae la lista por API y hace upsert.
// - importarCsv(codigo, csv): alternativa manual (lista en Excel/CSV exportada).
// - tipoDeCambio(): dólar oficial venta (dolarapi.com), cacheado 1 h,
//   con override por .env (TIPO_CAMBIO_FIJO).

import { supabase } from '../connectors/supabase.js';
import { adaptadores, ItemCatalogo } from '../connectors/proveedores/index.js';
import { mapearItem } from '../connectors/proveedores/generico.js';

export interface ResultadoSync {
    proveedor: string;
    ok: boolean;
    items: number;
    detalle?: string;
    duracion_ms: number;
}

async function guardarItems(codigo: string, items: ItemCatalogo[], inicio: Date): Promise<void> {
    const ahora = new Date().toISOString();
    // Dedupe por SKU dentro del lote (Postgres rechaza upserts con claves repetidas)
    const porSku = new Map<string, ItemCatalogo>();
    for (const i of items) porSku.set(i.sku, i);
    const filas = Array.from(porSku.values()).map((i) => ({
        proveedor: codigo,
        sku: i.sku,
        descripcion: i.descripcion.slice(0, 500),
        marca: i.marca ?? null,
        categoria: i.categoria ?? null,
        precio: i.precio ?? null,
        moneda: i.moneda,
        iva_pct: i.iva_pct ?? null,
        stock: i.stock != null ? Math.round(i.stock) : null,
        url_imagen: i.url_imagen ?? null,
        raw: i.raw ?? null,
        actualizado_en: ahora,
    }));

    for (let i = 0; i < filas.length; i += 500) {
        const { error } = await supabase
            .from('catalogo_proveedores')
            .upsert(filas.slice(i, i + 500), { onConflict: 'proveedor,sku' });
        if (error) throw new Error(`upsert: ${error.message}`);
    }

    // Lo que no vino en esta corrida ya no está en la lista del proveedor.
    await supabase
        .from('catalogo_proveedores')
        .delete()
        .eq('proveedor', codigo)
        .lt('actualizado_en', inicio.toISOString());
}

async function registrarEstado(codigo: string, estado: 'ok' | 'error' | 'sin_configurar', detalle: string | null, items: number) {
    await supabase.from('proveedores').update({
        ultima_sync: new Date().toISOString(),
        ultimo_estado: estado,
        ultimo_detalle: detalle,
        ...(estado === 'ok' ? { items_sincronizados: items } : {}),
    }).eq('codigo', codigo);
}

export async function sincronizarProveedor(codigo: string): Promise<ResultadoSync> {
    const inicio = new Date();
    const adaptador = adaptadores[codigo];
    if (!adaptador) return { proveedor: codigo, ok: false, items: 0, detalle: 'proveedor desconocido', duracion_ms: 0 };

    const falta = adaptador.faltaConfig();
    if (falta) {
        await registrarEstado(codigo, 'sin_configurar', falta, 0);
        return { proveedor: codigo, ok: false, items: 0, detalle: falta, duracion_ms: 0 };
    }

    try {
        const items = await adaptador.traerCatalogo();
        await guardarItems(codigo, items, inicio);
        await registrarEstado(codigo, 'ok', null, items.length);
        return { proveedor: codigo, ok: true, items: items.length, duracion_ms: Date.now() - inicio.getTime() };
    } catch (err) {
        const detalle = (err as Error).message;
        await registrarEstado(codigo, 'error', detalle, 0);
        return { proveedor: codigo, ok: false, items: 0, detalle, duracion_ms: Date.now() - inicio.getTime() };
    }
}

export async function sincronizarTodos(): Promise<ResultadoSync[]> {
    const { data } = await supabase.from('proveedores').select('codigo').eq('activo', true);
    const out: ResultadoSync[] = [];
    for (const p of data ?? []) out.push(await sincronizarProveedor(p.codigo as string));
    return out;
}

// ---------- Importación manual por CSV ----------

function parsearCsv(texto: string): Record<string, string>[] {
    const lineas = texto.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (lineas.length < 2) return [];
    const cab0 = lineas[0] ?? '';
    const sep = (cab0.match(/;/g)?.length ?? 0) > (cab0.match(/,/g)?.length ?? 0) ? ';' : ',';
    const partir = (l: string): string[] => {
        const out: string[] = [];
        let cur = '';
        let comillas = false;
        for (let i = 0; i < l.length; i++) {
            const ch = l[i];
            if (ch === '"') {
                if (comillas && l[i + 1] === '"') { cur += '"'; i++; } else comillas = !comillas;
            } else if (ch === sep && !comillas) { out.push(cur); cur = ''; }
            else cur += ch;
        }
        out.push(cur);
        return out.map((s) => s.trim());
    };
    const cab = partir(cab0).map((c) => c.toLowerCase().replace(/\s+/g, '_'));
    return lineas.slice(1).map((l) => {
        const v = partir(l);
        const o: Record<string, string> = {};
        cab.forEach((c, i) => { o[c] = v[i] ?? ''; });
        return o;
    });
}

export async function importarCsv(codigo: string, csv: string, moneda: 'USD' | 'ARS' = 'USD'): Promise<ResultadoSync> {
    const inicio = new Date();
    if (!adaptadores[codigo]) return { proveedor: codigo, ok: false, items: 0, detalle: 'proveedor desconocido', duracion_ms: 0 };
    const filas = parsearCsv(csv);
    const items = filas.map((f) => mapearItem(f, moneda)).filter((x): x is ItemCatalogo => x !== null);
    if (items.length === 0) {
        return { proveedor: codigo, ok: false, items: 0, detalle: 'No reconocí columnas de código y descripción en el CSV', duracion_ms: 0 };
    }
    try {
        await guardarItems(codigo, items, inicio);
        await registrarEstado(codigo, 'ok', `importado por CSV (${items.length} items)`, items.length);
        return { proveedor: codigo, ok: true, items: items.length, duracion_ms: Date.now() - inicio.getTime() };
    } catch (err) {
        return { proveedor: codigo, ok: false, items: 0, detalle: (err as Error).message, duracion_ms: Date.now() - inicio.getTime() };
    }
}

// ---------- Tipo de cambio ----------

let cacheTc: { valor: number; fuente: string; en: number } | null = null;

export async function tipoDeCambio(): Promise<{ valor: number; fuente: string }> {
    const fijo = Number(process.env.TIPO_CAMBIO_FIJO ?? '');
    if (Number.isFinite(fijo) && fijo > 0) return { valor: fijo, fuente: 'TIPO_CAMBIO_FIJO (.env)' };
    if (cacheTc && Date.now() - cacheTc.en < 3600_000) return { valor: cacheTc.valor, fuente: cacheTc.fuente };
    try {
        const res = await fetch('https://dolarapi.com/v1/dolares/oficial', { signal: AbortSignal.timeout(10_000) });
        const j = await res.json() as { venta?: number };
        if (j.venta && j.venta > 0) {
            cacheTc = { valor: j.venta, fuente: 'dólar oficial venta (dolarapi.com)', en: Date.now() };
            return { valor: j.venta, fuente: cacheTc.fuente };
        }
    } catch { /* cae al fallback */ }
    if (cacheTc) return { valor: cacheTc.valor, fuente: cacheTc.fuente + ' (cache vieja)' };
    throw new Error('No pude obtener el tipo de cambio. Configurá TIPO_CAMBIO_FIJO en el .env.');
}
