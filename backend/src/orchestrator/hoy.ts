// Resumen del día para la pantalla de Inicio: "La línea" (entra → el asistente
// propone → tu OK → sale) más la foto del negocio que ya usa Notion.
// Se cachea 60 s porque el panel lo consulta seguido y la foto consulta Notion.

import { supabase } from '../connectors/supabase.js';
import { fotoNegocio, FotoNegocio } from './notion_autonomo.js';
import { calcularPulso, Pulso } from './pulso.js';

const TZ = 'America/Argentina/Buenos_Aires';

// Medianoche de hoy en Argentina, en ISO (UTC-3 fijo, sin horario de verano).
function inicioDeHoy(): string {
    const hoy = new Date().toLocaleDateString('en-CA', { timeZone: TZ });
    return new Date(`${hoy}T00:00:00-03:00`).toISOString();
}

export interface ResumenHoy {
    linea: {
        entra: { total: number; correos: number; whatsapp: number };
        propone: number;
        tu_ok: number;
        sale: { total: number; aprobadas: number; rechazadas: number };
    };
    costo_hoy_usd: number;
    prioridades: { fecha: string; items: Array<{ texto: string; por_que?: string }> } | null;
    foto: FotoNegocio;
    pulso: Pulso | null;
    generado_en: string;
}

let cache: { en: number; datos: ResumenHoy } | null = null;

export async function resumenHoy(forzar = false): Promise<ResumenHoy> {
    if (!forzar && cache && Date.now() - cache.en < 60_000) return cache.datos;
    const desde = inicioDeHoy();

    const [foto, pulso, correos, wa, propuestas, pendientes, resueltas, logs, prio] = await Promise.all([
        fotoNegocio(),
        calcularPulso().catch((err) => { console.warn('[hoy] pulso:', (err as Error).message); return null; }),
        supabase.from('correos_historicos').select('id', { count: 'exact', head: true }).eq('direccion', 'entrante').eq('ignorable', false).gte('fecha', desde),
        supabase.from('wa_mensajes').select('id', { count: 'exact', head: true }).eq('origen', 'cliente').gte('creado_en', desde),
        supabase.from('acciones_pendientes').select('id', { count: 'exact', head: true }).gte('creado_en', desde),
        supabase.from('acciones_pendientes').select('id', { count: 'exact', head: true }).eq('estado', 'pendiente'),
        supabase.from('acciones_pendientes').select('estado').gte('resuelto_en', desde),
        supabase.from('logs_asistente').select('costo_usd').gte('creado_en', desde),
        supabase.from('integraciones_config').select('valor').eq('clave', 'notion_prioridades').maybeSingle(),
    ]);

    const estados = (resueltas.data ?? []).map((r) => r.estado as string);
    const aprobadas = estados.filter((e) => e === 'aprobada' || e === 'editada' || e === 'ejecutada').length;
    const rechazadas = estados.filter((e) => e === 'rechazada').length;
    let prioridades: ResumenHoy['prioridades'] = null;
    try { prioridades = prio.data?.valor ? JSON.parse(prio.data.valor as string) : null; } catch { prioridades = null; }

    const datos: ResumenHoy = {
        linea: {
            entra: { total: (correos.count ?? 0) + (wa.count ?? 0), correos: correos.count ?? 0, whatsapp: wa.count ?? 0 },
            propone: propuestas.count ?? 0,
            tu_ok: pendientes.count ?? 0,
            sale: { total: aprobadas, aprobadas, rechazadas },
        },
        costo_hoy_usd: (logs.data ?? []).reduce((s, l) => s + Number(l.costo_usd ?? 0), 0),
        prioridades,
        foto,
        pulso,
        generado_en: new Date().toISOString(),
    };
    cache = { en: Date.now(), datos };
    return datos;
}

// Cuando se aprueba o rechaza algo, el Inicio tiene que reflejarlo al toque.
export function invalidarResumenHoy(): void {
    cache = null;
}
