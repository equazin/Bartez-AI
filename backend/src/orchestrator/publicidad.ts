// Asistente de Publicidad — fase 1 (solo mirar).
// Baja de Google Ads las métricas por campaña, por página de destino y las
// búsquedas reales; las cruza con el mapa de la web; controla el gasto contra el
// tope y avisa si algo se dispara o si una página que recibe clics da error.
// No cambia nada en Google Ads.

import { supabase } from '../connectors/supabase.js';
import { consultarAds, estadoConexion, type FilaAds } from '../connectors/google_ads.js';
import { enviarCorreo } from '../connectors/ferozo.js';
import { tipoDeCambio } from './catalogo_proveedores.js';

const TZ = 'America/Argentina/Buenos_Aires';
const micros = (v: unknown) => Math.round((Number(v ?? 0) / 1_000_000) * 100) / 100;
const num = (v: unknown) => Number(v ?? 0) || 0;

// Fecha "YYYY-MM-DD" en hora argentina, corrida `dias` días.
export function fechaAR(dias = 0, base = new Date()): string {
    return new Date(base.getTime() + dias * 86_400_000).toLocaleDateString('en-CA', { timeZone: TZ });
}

// Misma URL escrita distinto (barra final, www, parámetros) → una sola.
export function normalizarUrl(u: string): string {
    try {
        const x = new URL(u);
        const host = x.hostname.replace(/^www\./, '');
        const ruta = x.pathname.replace(/\/+$/, '') || '';
        return `https://${host}${ruta}`;
    } catch {
        return u.trim();
    }
}

export interface Config { tope_mensual_ars: number | null; zona: string | null; modo: string }

export async function leerConfig(): Promise<Config> {
    const { data } = await supabase.from('ads_config').select('tope_mensual_ars, zona, modo').eq('id', 1).maybeSingle();
    return { tope_mensual_ars: data?.tope_mensual_ars != null ? Number(data.tope_mensual_ars) : null, zona: (data?.zona as string) ?? null, modo: (data?.modo as string) ?? 'solo_lectura' };
}

export async function guardarConfig(c: Partial<Pick<Config, 'tope_mensual_ars' | 'zona'>>): Promise<Config> {
    await supabase.from('ads_config').upsert({ id: 1, ...c, actualizado_en: new Date().toISOString() });
    return leerConfig();
}

export interface CuentaAds { nombre: string | null; moneda: string; zona_horaria: string | null; autoetiquetado: boolean | null }

export interface ResultadoSync { ok: boolean; desde: string; hasta: string; campanias: number; paginas: number; busquedas: number; detalle?: string }

export async function sincronizarAds(opts: { dias?: number; incluirHoy?: boolean } = {}): Promise<ResultadoSync> {
    // Google ajusta las conversiones de los últimos días: se vuelven a bajar.
    const dias = Math.max(1, Math.min(opts.dias ?? 3, 90));
    const hasta = opts.incluirHoy ? fechaAR(0) : fechaAR(-1);
    const desde = fechaAR(opts.incluirHoy ? -(dias - 1) : -dias);
    const rango = `segments.date BETWEEN '${desde}' AND '${hasta}'`;
    const ahora = new Date().toISOString();

    const [cuenta] = await consultarAds('SELECT customer.descriptive_name, customer.currency_code, customer.time_zone, customer.auto_tagging_enabled FROM customer LIMIT 1');
    if (cuenta) {
        const c: CuentaAds = {
            nombre: cuenta.customer?.descriptiveName ?? null,
            moneda: cuenta.customer?.currencyCode ?? 'ARS',
            zona_horaria: cuenta.customer?.timeZone ?? null,
            autoetiquetado: cuenta.customer?.autoTaggingEnabled ?? null,
        };
        await supabase.from('integraciones_config').upsert({ clave: 'google_ads_cuenta', valor: JSON.stringify(c), actualizado_en: ahora });
    }

    const camp = await consultarAds(`SELECT segments.date, campaign.id, campaign.name, campaign.status, campaign_budget.amount_micros, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value FROM campaign WHERE ${rango}`);
    const filasCamp = camp.map((f: FilaAds) => ({
        fecha: f.segments?.date,
        campania_id: String(f.campaign?.id ?? ''),
        campania: f.campaign?.name ?? null,
        estado: f.campaign?.status ?? null,
        presupuesto_diario: f.campaignBudget?.amountMicros != null ? micros(f.campaignBudget.amountMicros) : null,
        impresiones: num(f.metrics?.impressions),
        clics: num(f.metrics?.clicks),
        costo: micros(f.metrics?.costMicros),
        conversiones: num(f.metrics?.conversions),
        valor_conversiones: num(f.metrics?.conversionsValue),
        actualizado_en: ahora,
    })).filter((f) => f.fecha && f.campania_id);
    if (filasCamp.length) await supabase.from('ads_metricas_diarias').upsert(filasCamp, { onConflict: 'fecha,campania_id' });

    const pags = await consultarAds(`SELECT segments.date, landing_page_view.unexpanded_final_url, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions FROM landing_page_view WHERE ${rango}`);
    // Varias variantes de la misma URL se suman.
    const porPagina = new Map<string, { fecha: string; url: string; impresiones: number; clics: number; costo: number; conversiones: number }>();
    for (const f of pags) {
        const url = normalizarUrl(String(f.landingPageView?.unexpandedFinalUrl ?? ''));
        const fecha = f.segments?.date as string | undefined;
        if (!url || !fecha) continue;
        const k = `${fecha}|${url}`;
        const a = porPagina.get(k) ?? { fecha, url, impresiones: 0, clics: 0, costo: 0, conversiones: 0 };
        a.impresiones += num(f.metrics?.impressions); a.clics += num(f.metrics?.clicks);
        a.costo = Math.round((a.costo + micros(f.metrics?.costMicros)) * 100) / 100; a.conversiones += num(f.metrics?.conversions);
        porPagina.set(k, a);
    }
    const filasPag = [...porPagina.values()].map((p) => ({ ...p, actualizado_en: ahora }));
    if (filasPag.length) await supabase.from('ads_paginas_diarias').upsert(filasPag, { onConflict: 'fecha,url' });

    const bus = await consultarAds(`SELECT segments.date, search_term_view.search_term, campaign.name, ad_group.name, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions FROM search_term_view WHERE ${rango}`);
    const filasBus = bus.map((f: FilaAds) => ({
        fecha: f.segments?.date,
        termino: String(f.searchTermView?.searchTerm ?? '').slice(0, 300),
        campania: f.campaign?.name ?? '',
        grupo: f.adGroup?.name ?? '',
        impresiones: num(f.metrics?.impressions),
        clics: num(f.metrics?.clicks),
        costo: micros(f.metrics?.costMicros),
        conversiones: num(f.metrics?.conversions),
        actualizado_en: ahora,
    })).filter((f) => f.fecha && f.termino);
    // Solo las métricas: la decisión que se haya tomado sobre cada búsqueda se conserva.
    for (let i = 0; i < filasBus.length; i += 500) {
        await supabase.from('ads_busquedas').upsert(filasBus.slice(i, i + 500), { onConflict: 'fecha,termino,campania,grupo' });
    }

    await supabase.from('integraciones_config').upsert({ clave: 'google_ads_sincronizado_en', valor: ahora, actualizado_en: ahora });
    return { ok: true, desde, hasta, campanias: new Set(filasCamp.map((f) => f.campania_id)).size, paginas: filasPag.length, busquedas: filasBus.length };
}

async function leerClave(clave: string): Promise<string | null> {
    const { data } = await supabase.from('integraciones_config').select('valor').eq('clave', clave).maybeSingle();
    return (data?.valor as string) ?? null;
}

export async function cuentaAds(): Promise<CuentaAds | null> {
    const v = await leerClave('google_ads_cuenta');
    try { return v ? JSON.parse(v) as CuentaAds : null; } catch { return null; }
}

const suma = <T>(xs: T[], f: (x: T) => number) => Math.round(xs.reduce((s, x) => s + f(x), 0) * 100) / 100;

export interface ResumenPublicidad {
    conexion: Awaited<ReturnType<typeof estadoConexion>>;
    cuenta: CuentaAds | null;
    config: Config;
    sincronizado_en: string | null;
    web_leida_en: string | null;
    tipo_cambio: number | null;
    mes: {
        desde: string; hasta: string;
        gasto: number; clics: number; impresiones: number; conversiones: number;
        cpc: number | null; costo_por_conversion: number | null;
        tope: number | null; uso_tope: number | null; proyeccion: number | null;
        presupuesto_diario_activo: number;
    };
    hoy: { gasto: number; clics: number };
    campanias: Array<{ id: string; nombre: string; estado: string | null; gasto: number; clics: number; conversiones: number; presupuesto_diario: number | null }>;
    alertas: Alerta[];
}

export async function resumenPublicidad(): Promise<ResumenPublicidad> {
    const [conexion, cuenta, config, sincronizado_en, web_leida_en] = await Promise.all([
        estadoConexion(), cuentaAds(), leerConfig(), leerClave('google_ads_sincronizado_en'), leerClave('web_mapa_leida'),
    ]);
    const hoy = fechaAR(0);
    const desde = `${hoy.slice(0, 8)}01`;
    const { data } = await supabase.from('ads_metricas_diarias').select('*').gte('fecha', desde).lte('fecha', hoy);
    const filas = (data ?? []) as Array<{ fecha: string; campania_id: string; campania: string | null; estado: string | null; presupuesto_diario: number | null; impresiones: number; clics: number; costo: number; conversiones: number }>;
    const gasto = suma(filas, (f) => num(f.costo));
    const clics = suma(filas, (f) => num(f.clics));
    const conversiones = suma(filas, (f) => num(f.conversiones));
    const deHoy = filas.filter((f) => f.fecha === hoy);

    let tc: number | null = null;
    try { tc = (await tipoDeCambio()).valor; } catch { /* sin tipo de cambio */ }
    // El tope se carga en pesos; si la cuenta factura en dólares se convierte.
    const moneda = cuenta?.moneda ?? 'ARS';
    const tope = config.tope_mensual_ars == null ? null : moneda === 'USD' ? (tc ? Math.round((config.tope_mensual_ars / tc) * 100) / 100 : null) : config.tope_mensual_ars;

    const [a, m] = hoy.split('-').map(Number) as [number, number];
    const diasMes = new Date(a, m, 0).getDate();
    const diaHoy = Number(hoy.slice(8));
    const cerrados = filas.filter((f) => f.fecha < hoy);
    const gastoCerrado = suma(cerrados, (f) => num(f.costo));
    const proyeccion = diaHoy > 1 ? Math.round((gastoCerrado / (diaHoy - 1)) * diasMes * 100) / 100 : null;

    const porCamp = new Map<string, ResumenPublicidad['campanias'][number] & { ultimaFecha: string }>();
    for (const f of filas) {
        const c = porCamp.get(f.campania_id) ?? { id: f.campania_id, nombre: f.campania ?? f.campania_id, estado: f.estado, gasto: 0, clics: 0, conversiones: 0, presupuesto_diario: f.presupuesto_diario, ultimaFecha: '' };
        c.gasto = Math.round((c.gasto + num(f.costo)) * 100) / 100; c.clics += num(f.clics); c.conversiones += num(f.conversiones);
        if (f.fecha >= c.ultimaFecha) { c.ultimaFecha = f.fecha; c.estado = f.estado; c.presupuesto_diario = f.presupuesto_diario; c.nombre = f.campania ?? c.nombre; }
        porCamp.set(f.campania_id, c);
    }
    const campanias = [...porCamp.values()].sort((x, y) => y.gasto - x.gasto).map(({ ultimaFecha: _u, ...c }) => c);
    const presupuesto_diario_activo = suma(campanias.filter((c) => c.estado === 'ENABLED'), (c) => num(c.presupuesto_diario));

    return {
        conexion, cuenta, config, sincronizado_en, web_leida_en, tipo_cambio: tc,
        mes: {
            desde, hasta: hoy, gasto, clics, impresiones: suma(filas, (f) => num(f.impresiones)), conversiones,
            cpc: clics ? Math.round((gasto / clics) * 100) / 100 : null,
            costo_por_conversion: conversiones ? Math.round((gasto / conversiones) * 100) / 100 : null,
            tope, uso_tope: tope ? Math.round((gasto / tope) * 1000) / 10 : null, proyeccion, presupuesto_diario_activo,
        },
        hoy: { gasto: suma(deHoy, (f) => num(f.costo)), clics: suma(deHoy, (f) => num(f.clics)) },
        campanias,
        alertas: await alertasRecientes(),
    };
}

// Páginas de la web con lo que gastaron y trajeron en Google (últimos N días).
export async function paginasConMetricas(dias = 30) {
    const desde = fechaAR(-dias);
    const [{ data: pags }, { data: met }] = await Promise.all([
        supabase.from('web_paginas').select('url, ruta, tipo, anunciable, estado_http, titulo, descripcion, h1, faq, ficha, en_sitemap, leida_en, cambio_en').order('ruta'),
        supabase.from('ads_paginas_diarias').select('url, clics, costo, conversiones, impresiones').gte('fecha', desde),
    ]);
    const m = new Map<string, { clics: number; costo: number; conversiones: number; impresiones: number }>();
    for (const f of met ?? []) {
        const k = normalizarUrl(f.url as string);
        const a = m.get(k) ?? { clics: 0, costo: 0, conversiones: 0, impresiones: 0 };
        a.clics += num(f.clics); a.costo = Math.round((a.costo + num(f.costo)) * 100) / 100; a.conversiones += num(f.conversiones); a.impresiones += num(f.impresiones);
        m.set(k, a);
    }
    const conocidas = new Set<string>();
    const paginas = (pags ?? []).map((p) => {
        const k = normalizarUrl(p.url as string);
        conocidas.add(k);
        return { ...p, faq: undefined, preguntas: Array.isArray(p.faq) ? p.faq.length : 0, metricas: m.get(k) ?? null };
    });
    // Destinos de anuncios que no son páginas del sitemap (conviene revisarlos).
    const fuera = [...m.entries()].filter(([k]) => !conocidas.has(k)).map(([url, metricas]) => ({ url, metricas }));
    return { paginas, destinos_fuera_de_la_web: fuera, dias };
}

export async function busquedasRecientes(dias = 30, limite = 300) {
    const { data } = await supabase.from('ads_busquedas').select('termino, campania, grupo, impresiones, clics, costo, conversiones, decision, motivo').gte('fecha', fechaAR(-dias)).limit(5000);
    const m = new Map<string, { termino: string; campanias: Set<string>; impresiones: number; clics: number; costo: number; conversiones: number; decision: string | null; motivo: string | null }>();
    for (const f of data ?? []) {
        const k = String(f.termino).toLowerCase();
        const a = m.get(k) ?? { termino: f.termino as string, campanias: new Set<string>(), impresiones: 0, clics: 0, costo: 0, conversiones: 0, decision: null, motivo: null };
        if (f.campania) a.campanias.add(f.campania as string);
        a.impresiones += num(f.impresiones); a.clics += num(f.clics); a.costo = Math.round((a.costo + num(f.costo)) * 100) / 100; a.conversiones += num(f.conversiones);
        a.decision = (f.decision as string) ?? a.decision; a.motivo = (f.motivo as string) ?? a.motivo;
        m.set(k, a);
    }
    return [...m.values()].map((b) => ({ ...b, campanias: [...b.campanias] })).sort((x, y) => y.costo - x.costo || y.clics - x.clics).slice(0, limite);
}

// ---------------------------------------------------------------- alertas

export interface Alerta { clave: string; tipo: 'gasto_dia' | 'tope' | 'pagina_caida' | 'conexion' | 'autoetiquetado'; nivel: 'aviso' | 'urgente'; texto: string; en: string }

async function alertasRecientes(): Promise<Alerta[]> {
    const v = await leerClave('ads_alertas');
    try {
        const xs = v ? JSON.parse(v) as Alerta[] : [];
        const corte = Date.now() - 7 * 86_400_000;
        return xs.filter((a) => new Date(a.en).getTime() > corte).slice(-30).reverse();
    } catch { return []; }
}

// Una alerta con la misma clave no se repite (una por día y tipo).
async function alertar(a: Omit<Alerta, 'en'>): Promise<boolean> {
    const v = await leerClave('ads_alertas');
    let xs: Alerta[] = [];
    try { xs = v ? JSON.parse(v) as Alerta[] : []; } catch { xs = []; }
    if (xs.some((x) => x.clave === a.clave)) return false;
    const nueva: Alerta = { ...a, en: new Date().toISOString() };
    xs = [...xs, nueva].slice(-100);
    await supabase.from('integraciones_config').upsert({ clave: 'ads_alertas', valor: JSON.stringify(xs), actualizado_en: nueva.en });
    const para = process.env.ESCALACION_EMAIL ?? '';
    if (para) {
        await enviarCorreo({
            para,
            asunto: `[Bartez AI] Publicidad: ${a.nivel === 'urgente' ? 'URGENTE — ' : ''}${a.texto.slice(0, 90)}`,
            cuerpo: `${a.texto}\n\nEl asistente de Publicidad está en modo "solo mirar": no cambió nada en Google Ads. Revisalo desde el panel → Publicidad.`,
        }).catch((err) => console.warn('[publicidad] no se pudo mandar la alerta:', (err as Error).message));
    }
    return true;
}

const pesos = (n: number, moneda: string) => `${moneda === 'USD' ? 'USD ' : '$'}${Math.round(n).toLocaleString('es-AR')}`;

// Guardia de gasto: se corre cada 2 horas de 8 a 21.
export async function guardiaPublicidad(): Promise<{ revisado: boolean; alertas: number; detalle?: string }> {
    const con = await estadoConexion();
    let alertas = 0;
    const hoy = fechaAR(0);
    if (con.conectado) {
        try {
            await sincronizarAds({ dias: 1, incluirHoy: true });
        } catch (err) {
            const msg = (err as Error).message;
            if (await alertar({ clave: `conexion|${hoy}`, tipo: 'conexion', nivel: 'aviso', texto: `No se pudo leer Google Ads: ${msg}` })) alertas++;
            return { revisado: false, alertas, detalle: msg };
        }
        const r = await resumenPublicidad();
        const moneda = r.cuenta?.moneda ?? 'ARS';
        if (r.cuenta?.autoetiquetado === false && await alertar({ clave: `autoetiquetado|${hoy.slice(0, 7)}`, tipo: 'autoetiquetado', nivel: 'aviso', texto: 'El etiquetado automático de Google Ads está apagado: sin eso no se puede saber qué clic trajo cada consulta. Activalo en Configuración de la cuenta.' })) alertas++;
        // Gasto del día muy por encima de lo presupuestado.
        const esperado = r.mes.presupuesto_diario_activo;
        if (esperado > 0 && r.hoy.gasto > esperado * 1.3 && await alertar({ clave: `gasto_dia|${hoy}`, tipo: 'gasto_dia', nivel: 'aviso', texto: `Hoy ya se gastaron ${pesos(r.hoy.gasto, moneda)} en Google Ads, más de lo presupuestado para el día (${pesos(esperado, moneda)}).` })) alertas++;
        // Tope mensual.
        if (r.mes.tope && r.mes.uso_tope != null) {
            if (r.mes.uso_tope >= 100 && await alertar({ clave: `tope100|${hoy.slice(0, 7)}`, tipo: 'tope', nivel: 'urgente', texto: `Se llegó al tope mensual: ${pesos(r.mes.gasto, moneda)} de ${pesos(r.mes.tope, moneda)}. Las campañas siguen activas: pausalas en Google Ads si no querés gastar más.` })) alertas++;
            else if (r.mes.uso_tope >= 90 && await alertar({ clave: `tope90|${hoy.slice(0, 7)}`, tipo: 'tope', nivel: 'aviso', texto: `Va ${r.mes.uso_tope}% del tope mensual (${pesos(r.mes.gasto, moneda)} de ${pesos(r.mes.tope, moneda)}).` })) alertas++;
            else if (r.mes.proyeccion && r.mes.proyeccion > r.mes.tope * 1.1 && await alertar({ clave: `proyeccion|${hoy.slice(0, 7)}|${Math.floor(Number(hoy.slice(8)) / 7)}`, tipo: 'tope', nivel: 'aviso', texto: `Al ritmo actual el mes cerraría en ${pesos(r.mes.proyeccion, moneda)}, por encima del tope de ${pesos(r.mes.tope, moneda)}.` })) alertas++;
        }
    }
    // Páginas de la web que reciben clics (o que se anuncian) y dan error.
    const { data: caidas } = await supabase.from('web_paginas').select('url, ruta, estado_http, anunciable').neq('estado_http', 200).eq('en_sitemap', true);
    const { data: conClics } = await supabase.from('ads_paginas_diarias').select('url').gte('fecha', fechaAR(-7)).gt('clics', 0);
    const destinos = new Set((conClics ?? []).map((f) => normalizarUrl(f.url as string)));
    for (const p of caidas ?? []) {
        if (!p.anunciable && !destinos.has(normalizarUrl(p.url as string))) continue;
        if (await alertar({ clave: `pagina|${p.url}|${hoy}`, tipo: 'pagina_caida', nivel: destinos.has(normalizarUrl(p.url as string)) ? 'urgente' : 'aviso', texto: `La página ${p.ruta} de la web da error (${p.estado_http || 'sin respuesta'})${destinos.has(normalizarUrl(p.url as string)) ? ' y está recibiendo clics pagos' : ''}.` })) alertas++;
    }
    return { revisado: true, alertas };
}

// Revisa solo las páginas que reciben clics o se anuncian (rápido, sin releer todo).
export async function revisarDestinos(): Promise<number> {
    const { data } = await supabase.from('web_paginas').select('url').eq('anunciable', true).eq('en_sitemap', true);
    let cambios = 0;
    for (const p of data ?? []) {
        try {
            const r = await fetch(p.url as string, { method: 'GET', redirect: 'follow', headers: { 'User-Agent': 'BartezAI/1.0 (+https://bartez.com.ar)' }, signal: AbortSignal.timeout(15_000) });
            await supabase.from('web_paginas').update({ estado_http: r.status }).eq('url', p.url);
            if (r.status !== 200) cambios++;
        } catch {
            await supabase.from('web_paginas').update({ estado_http: 0 }).eq('url', p.url);
            cambios++;
        }
    }
    return cambios;
}

// Bloque para el informe semanal de Analítica.
export async function bloquePublicidadParaInforme(dias = 7): Promise<string | null> {
    const con = await estadoConexion();
    const desde = fechaAR(-dias);
    const { data: met } = await supabase.from('ads_metricas_diarias').select('campania, costo, clics, conversiones').gte('fecha', desde);
    const { data: pags } = await supabase.from('web_paginas').select('ruta, estado_http, cambio_en, en_sitemap, anunciable');
    const partes: string[] = [];
    if (con.conectado && met?.length) {
        const gasto = suma(met, (f) => num(f.costo));
        const clics = suma(met, (f) => num(f.clics));
        const conv = suma(met, (f) => num(f.conversiones));
        partes.push(`Google Ads, últimos ${dias} días: gasto ${gasto}, ${clics} clics, ${conv} conversiones${clics ? `, CPC ${Math.round((gasto / clics) * 100) / 100}` : ''}.`);
        const top = await paginasConMetricas(dias);
        const conDatos = top.paginas.filter((p) => p.metricas).sort((a, b) => (b.metricas!.costo - a.metricas!.costo)).slice(0, 8);
        if (conDatos.length) partes.push(`Por página de la web:\n${conDatos.map((p) => `- ${p.ruta}: gasto ${p.metricas!.costo}, ${p.metricas!.clics} clics, ${p.metricas!.conversiones} conv.`).join('\n')}`);
        const bus = (await busquedasRecientes(dias, 10)).filter((b) => b.clics > 0);
        if (bus.length) partes.push(`Búsquedas con más gasto:\n${bus.map((b) => `- "${b.termino}": ${b.clics} clics, gasto ${b.costo}, ${b.conversiones} conv.`).join('\n')}`);
    } else if (!con.conectado) {
        partes.push('Google Ads todavía no está conectado (fase 0 pendiente).');
    }
    const corte = new Date(Date.now() - dias * 86_400_000).toISOString();
    const cambiadas = (pags ?? []).filter((p) => p.cambio_en && (p.cambio_en as string) > corte && p.en_sitemap);
    const caidas = (pags ?? []).filter((p) => p.estado_http !== 200 && p.en_sitemap && p.anunciable);
    if (cambiadas.length) partes.push(`Páginas de la web nuevas o cambiadas esta semana: ${cambiadas.map((p) => p.ruta).join(', ')}.`);
    if (caidas.length) partes.push(`Páginas anunciables con error: ${caidas.map((p) => `${p.ruta} (${p.estado_http})`).join(', ')}.`);
    return partes.length ? `PUBLICIDAD Y WEB\n${partes.join('\n')}` : null;
}
