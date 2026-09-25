// Pulso comercial para el Inicio: series diarias de los últimos 30 días,
// indicadores comparados con el período anterior y el embudo de prospectos.
// Todo se agrupa por día en horario de Argentina.

import { presupuestosSinRespuesta } from './cotizador.js';
import { supabase } from '../connectors/supabase.js';

const TZ = 'America/Argentina/Buenos_Aires';
const DIA_MS = 24 * 3600_000;
const dia = (iso: string) => new Date(iso).toLocaleDateString('en-CA', { timeZone: TZ });

export interface Pulso {
    dias: string[];
    consultas_correo: number[];
    consultas_whatsapp: number[];
    // Consultas por semana (lunes a domingo), las últimas 8; la última es la actual.
    semanas: { inicio: string[]; correo: number[]; whatsapp: number[] };
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
        ganado_mes_usd: number;
        ganado_mes_anterior_usd: number;
        ganadas_90d: number;
        perdidas_90d: number;
    };
    // Enviados hace 5+ días sin respuesta (los más viejos primero).
    esperando: Array<{ id: string; titulo: string | null; numero: number | null; total_usd: number; enviada_en: string }>;
    esperando_total: number;
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
    // 64 días alcanzan para 8 semanas completas más la semana en curso.
    const hace60 = new Date(ahora - 64 * DIA_MS).toISOString();
    const hoyStr = dia(new Date(ahora).toISOString());

    const [correos, wa, cots, clientes, acciones, conCorreo, conWa, cerradas, esperando] = await Promise.all([
        todas<{ fecha: string }>((a, b) => supabase.from('correos_historicos').select('fecha').eq('direccion', 'entrante').eq('ignorable', false).gte('fecha', hace60).range(a, b)),
        todas<{ creado_en: string }>((a, b) => supabase.from('wa_mensajes').select('creado_en').eq('origen', 'cliente').gte('creado_en', hace60).range(a, b)),
        todas<{ creado_en: string; total_usd: number | string | null; numero: number | null }>((a, b) => supabase.from('cotizaciones').select('creado_en, total_usd, numero').gte('creado_en', new Date(ahora - 70 * DIA_MS).toISOString()).range(a, b)),
        todas<{ creado_en: string; estado: string | null; intentos_contacto: number | null; ultimo_contacto_en: string | null; id: string }>((a, b) => supabase.from('clientes').select('id, creado_en, estado, intentos_contacto, ultimo_contacto_en').range(a, b)),
        todas<{ estado: string; resuelto_en: string }>((a, b) => supabase.from('acciones_pendientes').select('estado, resuelto_en').gte('resuelto_en', new Date(ahora - 30 * DIA_MS).toISOString()).range(a, b)),
        todas<{ cliente_id: string }>((a, b) => supabase.from('correos_historicos').select('cliente_id').eq('direccion', 'entrante').not('cliente_id', 'is', null).range(a, b)),
        todas<{ cliente_id: string }>((a, b) => supabase.from('wa_conversaciones').select('cliente_id').not('cliente_id', 'is', null).range(a, b)),
        todas<{ estado: string; total_usd: number | string | null; cerrada_en: string }>((a, b) => supabase.from('cotizaciones').select('estado, total_usd, cerrada_en').in('estado', ['ganada', 'perdida']).gte('cerrada_en', new Date(ahora - 95 * DIA_MS).toISOString()).range(a, b)),
        presupuestosSinRespuesta(5, 200),
    ]);

    // Últimos 30 días (incluye hoy), en orden.
    const dias: string[] = [];
    for (let i = 29; i >= 0; i--) dias.push(dia(new Date(ahora - i * DIA_MS).toISOString()));
    const indice = new Map(dias.map((d, i) => [d, i]));
    const serie = () => dias.map(() => 0);
    const consultasCorreo = serie(), consultasWa = serie(), cotizado = serie(), leads = serie();
    for (const c of correos) { const i = indice.get(dia(c.fecha)); if (i != null) consultasCorreo[i]!++; }

    // Semanas que arrancan el lunes (en horario de Argentina).
    const hoyAr = new Date(`${dia(new Date(ahora).toISOString())}T12:00:00-03:00`);
    const lunes = new Date(hoyAr.getTime() - ((hoyAr.getUTCDay() + 6) % 7) * DIA_MS);
    const inicioSemanas: string[] = [];
    for (let k = 7; k >= 0; k--) inicioSemanas.push(dia(new Date(lunes.getTime() - k * 7 * DIA_MS).toISOString()));
    const semana = (d: string) => {
        for (let k = inicioSemanas.length - 1; k >= 0; k--) if (d >= inicioSemanas[k]!) return k;
        return -1;
    };
    const semCorreo = inicioSemanas.map(() => 0), semWa = inicioSemanas.map(() => 0);
    for (const c of correos) { const k = semana(dia(c.fecha)); if (k >= 0) semCorreo[k]!++; }
    for (const m of wa) { const i = indice.get(dia(m.creado_en)); if (i != null) consultasWa[i]!++; }
    for (const m of wa) { const k = semana(dia(m.creado_en)); if (k >= 0) semWa[k]!++; }
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

    let ganadoMes = 0, ganadoMesAnt = 0, ganadas90 = 0, perdidas90 = 0;
    const desde90 = dia(new Date(ahora - 89 * DIA_MS).toISOString());
    for (const c of cerradas) {
        const d = dia(c.cerrada_en);
        if (d >= desde90) { if (c.estado === 'ganada') ganadas90++; else perdidas90++; }
        if (c.estado !== 'ganada') continue;
        if (d >= inicioMes && d <= hoyStr) ganadoMes += Number(c.total_usd ?? 0);
        else if (d >= inicioMesAnt && d <= finTramoAnt) ganadoMesAnt += Number(c.total_usd ?? 0);
    }

    const activos = clientes.filter((c) => c.estado !== 'descartado');
    const respondieron = new Set([...conCorreo.map((c) => c.cliente_id), ...conWa.map((c) => c.cliente_id)]);

    return {
        dias,
        consultas_correo: consultasCorreo,
        consultas_whatsapp: consultasWa,
        semanas: { inicio: inicioSemanas, correo: semCorreo, whatsapp: semWa },
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
            ganado_mes_usd: Math.round(ganadoMes * 100) / 100,
            ganado_mes_anterior_usd: Math.round(ganadoMesAnt * 100) / 100,
            ganadas_90d: ganadas90,
            perdidas_90d: perdidas90,
        },
        esperando: esperando.slice(0, 5).map((q) => ({ id: q.id, titulo: q.titulo, numero: q.numero, total_usd: q.total_usd, enviada_en: q.enviada_en })),
        esperando_total: esperando.length,
        embudo: {
            prospectos: activos.length,
            contactados: activos.filter((c) => (c.intentos_contacto ?? 0) > 0 || c.ultimo_contacto_en).length,
            respondieron: activos.filter((c) => respondieron.has(c.id)).length,
            clientes: activos.filter((c) => c.estado === 'cliente').length,
        },
    };
}
