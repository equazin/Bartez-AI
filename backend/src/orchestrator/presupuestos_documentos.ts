// Presupuestos que llegan como documento (un PDF armado fuera del Cotizador, una
// foto o captura de una lista con precios, un Excel…) subido a la ficha del
// cliente. La IA saca emisor, número, fecha y el total de cada opción; si es de
// Bartez o no dice de quién es, queda como una cotización más (origen
// "documento"): suma a Cotizado, aparece en el Cotizador y en el mapa, se marca
// ganada o perdida y entra en los seguimientos de presupuestos sin respuesta.
// Andrés puede corregir: "es nuestro", el total a mano o "no sumarlo".

import { supabase } from '../connectors/supabase.js';
import { tipoDeCambio } from './catalogo_proveedores.js';

export interface OpcionPresupuesto { nombre: string; total: number }

export interface DatosPresupuesto {
    // 'desconocido': no dice de quién es (una foto, una lista suelta). Como lo
    // subió Andrés a la ficha del cliente, cuenta como de Bartez.
    emisor: 'bartez' | 'otro' | 'desconocido';
    emisor_nombre: string | null;
    para: string | null;
    numero: string | null;
    fecha: string | null; // AAAA-MM-DD
    objeto: string | null;
    moneda: 'USD' | 'ARS';
    iva_incluido: boolean;
    tipo_cambio: number | null;
    opciones: OpcionPresupuesto[];
}

// Lo que se guarda en cliente_documentos.datos.
export interface DatosDocumento {
    version: number;
    presupuesto: DatosPresupuesto | null;
    // Opción que cuenta en Cotizado (índice). Si no se eligió, la más baja.
    opcion?: number;
    // Andrés dijo que es un presupuesto de Bartez aunque la IA leyó otro emisor.
    nuestro?: boolean;
    // Total que cargó Andrés a mano: pisa lo que leyó la IA (también al releer).
    total_manual?: TotalManual;
}

export interface TotalManual { monto: number; moneda: 'USD' | 'ARS' }

// Sube cuando cambia lo que se extrae: los documentos con una versión anterior
// se vuelven a leer solos (ver necesitaRelectura).
// 2: fotos y listas con precios cuentan como presupuesto; emisor "desconocido".
export const VERSION_DATOS = 2;

// ¿Hay que volver a leer el documento? La versión 2 solo cambia los que no se
// habían tomado como presupuesto de Bartez; los que ya lo eran quedan como están.
export function necesitaRelectura(datos: DatosDocumento | null): boolean {
    const v = datos?.version ?? 0;
    if (v >= VERSION_DATOS) return false;
    if (v < 1) return true;
    return datos?.presupuesto?.emisor !== 'bartez';
}

const TZ = 'America/Argentina/Buenos_Aires';
const r2 = (n: number) => Math.round(n * 100) / 100;
const hoyAr = () => new Date().toLocaleDateString('en-CA', { timeZone: TZ });

// "74.851,90", "74,851.90", 74851.9 → 74851.9
export function numeroDe(v: unknown): number | null {
    if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? v : null;
    if (typeof v !== 'string') return null;
    let s = v.replace(/[^\d.,-]/g, '');
    if (!s) return null;
    const coma = s.lastIndexOf(','), punto = s.lastIndexOf('.');
    if (coma > punto) s = s.replace(/\./g, '').replace(',', '.');       // 74.851,90
    else if (punto > coma && coma >= 0) s = s.replace(/,/g, '');          // 74,851.90
    else if (coma >= 0) s = /,\d{3}$/.test(s) ? s.replace(/,/g, '') : s.replace(',', '.');
    else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');     // 74.851
    const n = Number(s);
    return Number.isFinite(n) && n > 0 ? n : null;
}

const texto = (v: unknown, max = 200): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

// Lo que devolvió la IA, validado. null si no es un presupuesto con montos.
export function normalizarPresupuesto(raw: unknown): DatosPresupuesto | null {
    if (!raw || typeof raw !== 'object') return null;
    const p = raw as Record<string, unknown>;
    const opciones: OpcionPresupuesto[] = [];
    if (Array.isArray(p.opciones)) {
        for (const o of p.opciones.slice(0, 8)) {
            const total = numeroDe((o as Record<string, unknown>)?.total);
            if (total == null) continue;
            opciones.push({ nombre: texto((o as Record<string, unknown>)?.nombre, 80) ?? (opciones.length ? `Opción ${opciones.length + 1}` : 'Total'), total: r2(total) });
        }
    }
    const fecha = typeof p.fecha === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(p.fecha) && !Number.isNaN(Date.parse(p.fecha)) ? p.fecha : null;
    const tc = numeroDe(p.tipo_cambio);
    const emisor = String(p.emisor ?? '').toLowerCase();
    return {
        emisor: emisor === 'bartez' ? 'bartez' : emisor === 'otro' ? 'otro' : 'desconocido',
        emisor_nombre: texto(p.emisor_nombre, 120),
        para: texto(p.para, 120),
        numero: texto(p.numero, 40),
        fecha,
        objeto: texto(p.objeto, 300),
        moneda: String(p.moneda ?? '').toUpperCase() === 'ARS' ? 'ARS' : 'USD',
        iva_incluido: p.iva_incluido !== false,
        tipo_cambio: tc && tc > 50 ? tc : null,
        opciones,
    };
}

// La opción que cuenta: la elegida por Andrés o, si no, la más baja (lo seguro).
export function opcionQueCuenta(p: DatosPresupuesto, elegida?: number): number {
    if (typeof elegida === 'number' && elegida >= 0 && elegida < p.opciones.length) return elegida;
    let min = 0;
    p.opciones.forEach((o, i) => { if (o.total < p.opciones[min]!.total) min = i; });
    return min;
}

// Lo que cargó Andrés a mano sobre lo que leyó la IA: un total propio
// reemplaza las opciones (y arma el presupuesto si la IA no vio uno).
export function aplicarTotalManual(p: DatosPresupuesto | null, manual: TotalManual | undefined): DatosPresupuesto | null {
    if (!manual) return p;
    const base: DatosPresupuesto = p ?? {
        emisor: 'desconocido', emisor_nombre: null, para: null, numero: null, fecha: null,
        objeto: null, moneda: manual.moneda, iva_incluido: true, tipo_cambio: null, opciones: [],
    };
    return { ...base, moneda: manual.moneda, opciones: [{ nombre: 'Total', total: r2(manual.monto) }] };
}

// Suma a Cotizado si tiene un total, no lo emitió otra empresa (o Andrés dijo
// que es nuestro) y no se marcó "no sumarlo".
export function cuentaEnCotizado(datos: DatosDocumento | null, sinCotizado: boolean): boolean {
    const p = datos?.presupuesto;
    if (!p || !p.opciones.length || sinCotizado) return false;
    return p.emisor !== 'otro' || datos?.nuestro === true;
}

// Fecha del presupuesto para Cotizado: la del documento (si es creíble) o la de subida.
function fechaDelPresupuesto(fecha: string | null, subido: string): string {
    if (!fecha || fecha < '2015-01-01' || fecha > hoyAr()) return subido;
    if (fecha === hoyAr()) return new Date().toISOString();
    return new Date(`${fecha}T12:00:00-03:00`).toISOString();
}

// Qué se cotiza, cuando la IA no lo dijo: "Presupuesto (lista de componentes)".
// Nunca el nombre del archivo (las fotos de WhatsApp tienen nombres como "6dc5e097….jpg").
function descripcionSinObjeto(tipoDocumento: string | null): string {
    const t = tipoDocumento?.trim();
    if (!t) return 'Presupuesto';
    return /presupuesto|cotizaci/i.test(t) ? t : `Presupuesto (${t.charAt(0).toLowerCase()}${t.slice(1)})`;
}

const cerca = (a: number, b: number, tolerancia: number) => Math.abs(a - b) <= Math.max(a, b) * tolerancia;

interface FilaCot { id: string; origen: string | null; estado: string; cliente_id: string | null; total_usd: number | string | null; creado_en: string; numero: number | null }

// ¿Ya está este presupuesto? Otra versión del mismo documento (mismo N° y
// cliente) o el mismo presupuesto hecho en el Cotizador (mismo N° y total).
async function buscarMismoPresupuesto(clienteId: string, p: DatosPresupuesto, totalUsd: number, fecha: string): Promise<FilaCot | null> {
    const campos = 'id, origen, estado, cliente_id, total_usd, creado_en, numero';
    if (p.numero) {
        const { data } = await supabase.from('cotizaciones').select(campos)
            .eq('origen', 'documento').eq('cliente_id', clienteId).eq('numero_externo', p.numero).limit(1);
        if (data?.[0]) return data[0] as FilaCot;

        // El Cotizador numera "AAAA-NNNN" (año de creación y número). El número
        // solo no alcanza: otros presupuestos usan el mismo formato.
        const m = p.numero.match(/(\d{4})\s*[-/]\s*0*(\d{1,6})$/);
        if (m) {
            const { data: cot } = await supabase.from('cotizaciones').select(campos).eq('numero', Number(m[2])).neq('origen', 'documento').maybeSingle();
            const q = cot as FilaCot | null;
            if (q && q.creado_en.startsWith(m[1]!) && (!q.cliente_id || q.cliente_id === clienteId) && cerca(Number(q.total_usd ?? 0), totalUsd, 0.01)) return q;
        }
        return null;
    }
    // Sin número: mismo cliente, mismo día y mismo total.
    const { data } = await supabase.from('cotizaciones').select(campos)
        .eq('origen', 'documento').eq('cliente_id', clienteId).is('numero_externo', null)
        .gte('creado_en', new Date(Date.parse(fecha) - 36 * 3600_000).toISOString())
        .lte('creado_en', new Date(Date.parse(fecha) + 36 * 3600_000).toISOString());
    return ((data ?? []) as FilaCot[]).find((q) => cerca(Number(q.total_usd ?? 0), totalUsd, 0.005)) ?? null;
}

// Desvincula el documento. Si la cotización salió de documentos, sigue abierta
// y ningún otro documento la usa, se borra (deja de contar en Cotizado). Las
// ganadas o perdidas quedan: son ventas cerradas.
export async function soltarCotizacion(docId: string, cotId: string): Promise<void> {
    await supabase.from('cliente_documentos').update({ cotizacion_id: null }).eq('id', docId);
    const { data: q } = await supabase.from('cotizaciones').select('id, origen, estado').eq('id', cotId).maybeSingle();
    if (!q || q.origen !== 'documento' || q.estado === 'ganada' || q.estado === 'perdida') return;
    const { count } = await supabase.from('cliente_documentos').select('id', { count: 'exact', head: true }).eq('cotizacion_id', cotId);
    if ((count ?? 0) > 0) return;
    await supabase.from('cotizaciones').delete().eq('id', cotId);
}

// Deja la cotización del documento de acuerdo con lo que se leyó y lo que eligió
// Andrés (opción, contar o no). Se llama después de leer el documento y cuando
// se cambia algo desde la ficha.
export async function sincronizarPresupuestoDeDocumento(docId: string): Promise<void> {
    const { data: doc } = await supabase.from('cliente_documentos')
        .select('id, cliente_id, nombre, resumen, tipo_documento, datos, cotizacion_id, sin_cotizado, creado_en').eq('id', docId).maybeSingle();
    if (!doc) return;
    const datos = doc.datos as DatosDocumento | null;
    const p = datos?.presupuesto ?? null;

    if (!p || !cuentaEnCotizado(datos, !!doc.sin_cotizado)) {
        if (doc.cotizacion_id) await soltarCotizacion(doc.id as string, doc.cotizacion_id as string);
        return;
    }

    const idx = opcionQueCuenta(p, datos?.opcion);
    const total = p.opciones[idx]!.total;
    let tc = p.tipo_cambio;
    if (!tc) { try { tc = (await tipoDeCambio()).valor; } catch { tc = null; } }
    const totalUsd = p.moneda === 'ARS' ? (tc ? total / tc : null) : total;
    if (totalUsd == null) {
        console.warn('[presupuestos] sin tipo de cambio para pasar a dólares el documento', docId);
        return;
    }
    const totalArs = p.moneda === 'ARS' ? total : tc ? total * tc : null;
    const fecha = fechaDelPresupuesto(p.fecha, doc.creado_en as string);
    const { data: cliente } = await supabase.from('clientes').select('nombre').eq('id', doc.cliente_id).maybeSingle();

    const moneda = p.moneda === 'ARS' ? '$' : 'US$';
    const fmt = (n: number) => `${moneda} ${n.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const opciones = p.opciones.length > 1
        ? `\n\nOpciones: ${p.opciones.map((o, i) => `${o.nombre} ${fmt(o.total)}${i === idx ? ' (la que cuenta en Cotizado)' : ''}`).join(' · ')}`
        : '';
    const campos = {
        cliente_id: doc.cliente_id as string,
        titulo: (p.para || (cliente?.nombre as string | undefined) || (doc.nombre as string)).slice(0, 120),
        pedido: (p.objeto || [descripcionSinObjeto(doc.tipo_documento as string | null), p.numero && `N° ${p.numero}`].filter(Boolean).join(' ')).slice(0, 500),
        total_usd: r2(totalUsd),
        total_ars: totalArs != null ? r2(totalArs) : null,
        tipo_cambio: tc,
        numero_externo: p.numero,
        resumen_md: `${(doc.resumen as string | null) ?? ''}${opciones}${p.iva_incluido ? '' : '\n\nMontos sin IVA.'}`.trim(),
    };

    // 1) Este documento ya tiene su cotización (se volvió a leer o cambió la opción).
    if (doc.cotizacion_id) {
        const { data: q } = await supabase.from('cotizaciones').select('id, origen, estado').eq('id', doc.cotizacion_id).maybeSingle();
        if (q?.origen === 'documento') {
            await supabase.from('cotizaciones').update({ ...campos, creado_en: fecha, ...(q.estado === 'enviada' ? { enviada_en: fecha } : {}) }).eq('id', q.id);
            return;
        }
        if (q) return; // es del Cotizador: manda el Cotizador
    }

    // 2) El mismo presupuesto ya está cargado (otra versión, o salió del Cotizador).
    const mismo = await buscarMismoPresupuesto(doc.cliente_id as string, p, totalUsd, fecha);
    if (mismo) {
        await supabase.from('cliente_documentos').update({ cotizacion_id: mismo.id }).eq('id', docId);
        // La versión más nueva del documento actualiza montos y textos.
        if (mismo.origen === 'documento') await supabase.from('cotizaciones').update(campos).eq('id', mismo.id);
        return;
    }

    // 3) Presupuesto nuevo: se emitió en la fecha del documento.
    const { data: nueva, error } = await supabase.from('cotizaciones').insert({
        ...campos, origen: 'documento', estado: 'enviada', creado_en: fecha, enviada_en: fecha, items: [], datos_cliente: {},
    }).select('id').single();
    if (error || !nueva) throw new Error(`No se pudo registrar el presupuesto: ${error?.message ?? 'sin respuesta'}`);
    await supabase.from('cliente_documentos').update({ cotizacion_id: nueva.id }).eq('id', docId);
}
