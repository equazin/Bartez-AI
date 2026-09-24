// Pulso comercial para el Inicio: series diarias de los últimos 30 días,
// indicadores comparados con el período anterior y el embudo de prospectos.
// Todo se agrupa por día en horario de Argentina.

import { supabase } from '../connectors/supabase.js';

const TZ = 'America/Argentina/Buenos_Aires';
const DIA_MS = 24 * 3600_000;
const dia = (iso: string) => new Date(iso).toLocaleDateString('en-CA', { timeZone: TZ });

export interface Pulso {
    dias: string[];
    consultas_correo: number[];
    consultas_whatsapp: number[];
    cotizado_usd: number[];
    leads_nuevos: number[];
    kpis: {
        cotizado_mes_usd: number;
        cotizado_mes_anterior_usd: number;
        presupuestos_mes: number;
        presupuestos_mes_anterior: number;
        consultas_30d: number;
        consultas_30d_anterior: number;
        leads_30d: number;
        leads_30d_anterior: number;
        aprobadas_30d: number;
        resueltas_30d: number;
    };
    embudo: { prospectos: number; contactados: number; respondieron: number; clientes: number };
}

// PostgREST corta en 1000 filas: se pagina.
async function todas<T>(armar: (desde: number, hasta: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
    const out: T[] = [];
    for (let i = 0; i < 50; i++) {
        const { data, error } = await armar(i * 1000, i * 1000 + 999);
        if (error) throw new Error(error.message);
        out.push(...(data ?? []));
        if (!data || data.length < 1000) break;
    }
    return out;
}

export async function calcularPulso(): Promise<Pulso> {
    const ahora = Date.now();
    const hace60 = new Date(ahora - 60 * DIA_MS).toISOString();
    const hoyStr = dia(new Date(ahora).toISOString());

    const [correos, wa, cots, clientes, acciones, conCorreo, conWa] = await Promise.all([
        todas<{ fecha: string }>((a, b) => supabase.from('correos_historicos').select('fecha').eq('direccion', 'entrante').eq('ignorable', false).gte('fecha', hace60).range(a, b)),
        todas<{ creado_en: string }>((a, b) => supabase.from('wa_mensajes').select('creado_en').eq('origen', 'cliente').gte('creado_en', hace60).range(a, b)),
        todas<{ creado_en: string; total_usd: number | string | null; numero: number | null }>((a, b) => supabase.from('cotizaciones').select('creado_en, total_usd, numero').gte('creado_en', new Date(ahora - 70 * DIA_MS).toISOString()).range(a, b)),
        todas<{ creado_en: string; estado: string | null; intentos_contacto: number | null; ultimo_contacto_en: string | null; id: string }>((a, b) => supabase.from('clientes').select('id, creado_en, estado, intentos_contacto, ultimo_contacto_en').range(a, b)),
        todas<{ estado: string; resuelto_en: string }>((a, b) => supabase.from('acciones_pendientes').select('estado, resuelto_en').gte('resuelto_en', new Date(ahora - 30 * DIA_MS).toISOString()).range(a, b)),
        todas<{ cliente_id: string }>((a, b) => supabase.from('correos_historicos').select('cliente_id').eq('direccion', 'entrante').not('cliente_id', 'is', null).range(a, b)),
        todas<{ cliente_id: string }>((a, b) => supabase.from('wa_conversaciones').select('cliente_id').not('cliente_id', 'is', null).range(a, b)),
    ]);

    // Últimos 30 días (incluye hoy), en orden.
    const dias: string[] = [];
    for (let i = 29; i >= 0; i--) dias.push(dia(new Date(ahora - i * DIA_MS).toISOString()));
    const indice = new Map(dias.map((d, i) => [d, i]));
    const serie = () => dias.map(() => 0);
    const consultasCorreo = serie(), consultasWa = serie(), cotizado = serie(), leads = serie();
    for (const c of correos) { const i = indice.get(dia(c.fecha)); if (i != null) consultasCorreo[i]!++; }
    for (const m of wa) { const i = indice.get(dia(m.creado_en)); if (i != null) consultasWa[i]!++; }
    for (const c of cots) { const i = indice.get(dia(c.creado_en)); if (i != null) cotizado[i]! += Number(c.total_usd ?? 0); }
    for (const c of clientes) { const i = indice.get(dia(c.creado_en)); if (i != null) leads[i]!++; }

    // Mes actual vs. mismo tramo del mes anterior (del 1 al día de hoy).
    const [anio, mes, diaMes] = hoyStr.split('-').map(Number) as [number, number, number];
    const inicioMes = `${anio}-${String(mes).padStart(2, '0')}-01`;
    const mesAnt = mes === 1 ? { a: anio - 1, m: 12 } : { a: anio, m: mes - 1 };
    const inicioMesAnt = `${mesAnt.a}-${String(mesAnt.m).padStart(2, '0')}-01`;
    const finTramoAnt = `${mesAnt.a}-${String(mesAnt.m).padStart(2, '0')}-${String(diaMes).padStart(2, '0')}`;
    let cotMes = 0, cotMesAnt = 0, presMes = 0, presMesAnt = 0;
    for (const c of cots) {
        const d = dia(c.creado_en);
        if (d >= inicioMes && d <= hoyStr) { cotMes += Number(c.total_usd ?? 0); if (c.numero) presMes++; }
        else if (d >= inicioMesAnt && d <= finTramoAnt) { cotMesAnt += Number(c.total_usd ?? 0); if (c.numero) presMesAnt++; }
    }

    const hace30 = dia(new Date(ahora - 29 * DIA_MS).toISOString());
    const hace60d = dia(new Date(ahora - 59 * DIA_MS).toISOString());
    const enRango = (d: string, desde: string, hasta: string) => d >= desde && d <= hasta;
    const antesDe30 = dia(new Date(ahora - 30 * DIA_MS).toISOString());
    const contar = <T>(arr: T[], fecha: (x: T) => string, desde: string, hasta: string) => arr.filter((x) => enRango(dia(fecha(x)), desde, hasta)).length;

    const activos = clientes.filter((c) => c.estado !== 'descartado');
    const respondieron = new Set([...conCorreo.map((c) => c.cliente_id), ...conWa.map((c) => c.cliente_id)]);

    return {
        dias,
        consultas_correo: consultasCorreo,
        consultas_whatsapp: consultasWa,
        cotizado_usd: cotizado.map((v) => Math.round(v * 100) / 100),
        leads_nuevos: leads,
        kpis: {
            cotizado_mes_usd: Math.round(cotMes * 100) / 100,
            cotizado_mes_anterior_usd: Math.round(cotMesAnt * 100) / 100,
            presupuestos_mes: presMes,
            presupuestos_mes_anterior: presMesAnt,
            consultas_30d: contar(correos, (x) => x.fecha, hace30, hoyStr) + contar(wa, (x) => x.creado_en, hace30, hoyStr),
            consultas_30d_anterior: contar(correos, (x) => x.fecha, hace60d, antesDe30) + contar(wa, (x) => x.creado_en, hace60d, antesDe30),
            leads_30d: contar(clientes, (x) => x.creado_en, hace30, hoyStr),
            leads_30d_anterior: contar(clientes, (x) => x.creado_en, hace60d, antesDe30),
            aprobadas_30d: acciones.filter((a) => ['aprobada', 'editada', 'ejecutada'].includes(a.estado)).length,
            resueltas_30d: acciones.filter((a) => a.estado !== 'pendiente').length,
        },
        embudo: {
            prospectos: activos.length,
            contactados: activos.filter((c) => (c.intentos_contacto ?? 0) > 0 || c.ultimo_contacto_en).length,
            respondieron: activos.filter((c) => respondieron.has(c.id)).length,
            clientes: activos.filter((c) => c.estado === 'cliente').length,
        },
    };
}
