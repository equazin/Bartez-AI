// Anuncios de Google Ads: los que ya existen (con su preview y cómo rinde cada
// título), la generación de anuncios nuevos a pedido y su paso por Para aprobar.
//
// Regla de siempre: todo texto de un anuncio sale de bartez.com.ar. Lo que el
// pedido agregue y la página no diga se usa para elegir a quién mostrárselo,
// nunca como promesa. El código lo verifica (largos, cifras, marcas, frases
// prohibidas) antes de que llegue a Para aprobar.

import { supabase } from '../connectors/supabase.js';
import { anthropic, calcularCosto, maxTokens, opcionesModelo, textoDe } from '../connectors/anthropic.js';
import { consultarAds, estadoConexion, mutarAds, adsConfig, type FilaAds } from '../connectors/google_ads.js';
import { normalizar } from './web_mapa.js';
import { normalizarUrl } from './publicidad.js';

const micros = (v: unknown) => Math.round(Number(v ?? 0) / 1_000_000);
const num = (v: unknown) => Number(v ?? 0) || 0;

export type Rendimiento = 'muy_bueno' | 'bueno' | 'bajo' | 'aprendiendo' | null;
const RENDIMIENTO: Record<string, Rendimiento> = { BEST: 'muy_bueno', GOOD: 'bueno', LOW: 'bajo', LEARNING: 'aprendiendo', PENDING: 'aprendiendo' };

export interface AnuncioGoogle {
    id: string;                 // resourceName del anuncio en Google, o id de la acción pendiente
    origen: 'google' | 'propuesta';
    campania: string | null;
    grupo: string | null;
    url: string | null;
    ruta: string | null;
    ruta1: string | null;
    ruta2: string | null;
    titulos: Array<{ texto: string; rendimiento: Rendimiento }>;
    descripciones: Array<{ texto: string; rendimiento: Rendimiento }>;
    estado: 'activo' | 'pausado' | 'rechazado' | 'limitado' | 'en_revision' | 'pendiente_ok' | 'sin_cargar';
    fuerza: string | null;
    problema: string | null;    // página caída, rechazado, rinde poco
    metricas: { impresiones: number; clics: number; costo: number; conversiones: number } | null;
}

let cache: { en: number; datos: AnuncioGoogle[] } | null = null;
export function invalidarAnuncios(): void { cache = null; }

async function asistentePublicidad(): Promise<string | null> {
    const { data } = await supabase.from('asistentes').select('id').eq('area', 'publicidad').maybeSingle();
    return (data?.id as string) ?? null;
}

export async function listarAnuncios(forzar = false): Promise<AnuncioGoogle[]> {
    if (!forzar && cache && Date.now() - cache.en < 5 * 60_000) return cache.datos;
    const out: AnuncioGoogle[] = [];
    const { data: webs } = await supabase.from('web_paginas').select('url, ruta, estado_http');
    const webDe = new Map((webs ?? []).map((w) => [normalizarUrl(w.url as string), w]));

    if ((await estadoConexion()).conectado) {
        const [attrs, mets] = await Promise.all([
            consultarAds(`SELECT ad_group_ad.resource_name, ad_group_ad.status, ad_group_ad.ad_strength, ad_group_ad.policy_summary.approval_status, ad_group_ad.policy_summary.review_status, ad_group_ad.ad.final_urls, ad_group_ad.ad.responsive_search_ad.headlines, ad_group_ad.ad.responsive_search_ad.descriptions, ad_group_ad.ad.responsive_search_ad.path1, ad_group_ad.ad.responsive_search_ad.path2, ad_group.name, campaign.name, campaign.status FROM ad_group_ad WHERE ad_group_ad.status != 'REMOVED' AND ad_group_ad.ad.type = 'RESPONSIVE_SEARCH_AD'`),
            consultarAds(`SELECT ad_group_ad.resource_name, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions FROM ad_group_ad WHERE ad_group_ad.status != 'REMOVED' AND segments.date DURING LAST_30_DAYS`),
        ]);
        const metDe = new Map(mets.map((m: FilaAds) => [m.adGroupAd?.resourceName as string, m.metrics]));
        const costosPorConv: number[] = [];
        for (const f of attrs) {
            const m = metDe.get(f.adGroupAd?.resourceName);
            if (m && num(m.conversions) > 0) costosPorConv.push(micros(m.costMicros) / num(m.conversions));
        }
        const promedio = costosPorConv.length ? costosPorConv.reduce((a, b) => a + b, 0) / costosPorConv.length : null;
        for (const f of attrs as FilaAds[]) {
            const ag = f.adGroupAd ?? {};
            const rsa = ag.ad?.responsiveSearchAd ?? {};
            const url = (ag.ad?.finalUrls?.[0] as string | undefined) ?? null;
            const web = url ? webDe.get(normalizarUrl(url)) : undefined;
            const m = metDe.get(ag.resourceName);
            const metricas = m ? { impresiones: num(m.impressions), clics: num(m.clicks), costo: micros(m.costMicros), conversiones: Math.round(num(m.conversions) * 10) / 10 } : null;
            const aprobacion = ag.policySummary?.approvalStatus as string | undefined;
            const revision = ag.policySummary?.reviewStatus as string | undefined;
            const pausado = ag.status === 'PAUSED' || f.campaign?.status === 'PAUSED';
            const estado: AnuncioGoogle['estado'] = aprobacion === 'DISAPPROVED' ? 'rechazado'
                : revision === 'REVIEW_IN_PROGRESS' ? 'en_revision'
                    : pausado ? 'pausado'
                        : aprobacion === 'APPROVED_LIMITED' || aprobacion === 'AREA_OF_INTEREST_ONLY' ? 'limitado' : 'activo';
            let problema: string | null = null;
            if (web && web.estado_http !== 200) problema = `La página da error (${web.estado_http || 'sin respuesta'})`;
            else if (estado === 'rechazado') problema = 'Google rechazó el anuncio';
            else if (metricas && metricas.clics >= 50 && (metricas.conversiones === 0 || (promedio && metricas.costo / metricas.conversiones > promedio * 2))) problema = 'Rinde poco';
            const textos = (xs: Array<{ text?: string; assetPerformanceLabel?: string }> | undefined) =>
                (xs ?? []).map((x) => ({ texto: String(x.text ?? ''), rendimiento: RENDIMIENTO[x.assetPerformanceLabel ?? ''] ?? null })).filter((x) => x.texto);
            out.push({
                id: ag.resourceName, origen: 'google', campania: f.campaign?.name ?? null, grupo: f.adGroup?.name ?? null,
                url, ruta: web?.ruta as string ?? (url ? new URL(url).pathname : null), ruta1: rsa.path1 ?? null, ruta2: rsa.path2 ?? null,
                titulos: textos(rsa.headlines), descripciones: textos(rsa.descriptions), estado, fuerza: ag.adStrength ?? null, problema, metricas,
            });
        }
    }

    // Los que esperan tu ok y los aprobados que Google todavía no pudo cargar.
    const { data: pend } = await supabase.from('acciones_pendientes').select('id, estado, payload, respuesta, creado_en').eq('accion', 'ads_anuncio')
        .or('estado.eq.pendiente,respuesta->ejecucion->>ok.eq.false').order('creado_en', { ascending: false }).limit(50);
    for (const a of pend ?? []) {
        const p = a.payload as Record<string, unknown>;
        const sinCargar = a.estado !== 'pendiente';
        const detalle = ((a.respuesta as { ejecucion?: { detalle?: string } } | null)?.ejecucion?.detalle) ?? null;
        out.push({
            id: a.id as string, origen: 'propuesta', campania: null, grupo: null,
            url: String(p.url ?? ''), ruta: String(p.ruta ?? ''), ruta1: (p.ruta1 as string) ?? null, ruta2: (p.ruta2 as string) ?? null,
            titulos: ((p.titulos as string[]) ?? []).map((t) => ({ texto: t, rendimiento: null })),
            descripciones: ((p.descripciones as string[]) ?? []).map((t) => ({ texto: t, rendimiento: null })),
            estado: sinCargar ? 'sin_cargar' : 'pendiente_ok', fuerza: null, problema: sinCargar ? (detalle ?? 'Aprobado, falta cargarlo en Google Ads') : null, metricas: null,
        });
    }
    cache = { en: Date.now(), datos: out };
    return out;
}

// ---------------------------------------------------------------- generar

export interface Variante {
    titulos: string[];
    descripciones: string[];
    ruta1: string | null;
    ruta2: string | null;
    fuentes: Array<{ texto: string; fuente: string }>;
    palabras_clave: string[];
    problemas: string[];        // si tiene alguno, no se puede proponer
}

export interface Generacion { url: string; ruta: string; titulo: string | null; variantes: Variante[]; avisos: string[]; costo_usd: number }

type Pagina = { url: string; ruta: string; titulo: string | null; descripcion: string | null; h1: string | null; subtitulos: string[]; items: string[]; faq: Array<{ p: string; r: string }>; texto: string | null; ficha: { tema?: string; frases?: string[]; marcas?: string[] } | null };

// Promesas que Google no deja sin comprobar, o que Bartez no puede sostener si
// no están en la web.
const PROHIBIDAS = /\b(mejor(es)?|n[uú]mero\s*1|n°\s*1|l[ií]der(es)?|m[aá]s\s+barat[oa]s?|el\s+m[aá]s|gratis|descuento|oferta|promo(ci[oó]n)?|garantizad[oa])\b|%|\$/i;

function fuenteDe(p: Pagina): string {
    return normalizar([p.titulo, p.descripcion, p.h1, ...(p.subtitulos ?? []), ...(p.items ?? []), ...(p.faq ?? []).flatMap((f) => [f.p, f.r]), ...(p.ficha?.frases ?? []), p.texto ?? ''].filter(Boolean).join(' \n '));
}

const sinTildes = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');

// Controles de código sobre una variante: largos, cifras, marcas, promesas.
export function revisarVariante(v: Omit<Variante, 'problemas'>, p: Pagina): string[] {
    const fuente = fuenteDe(p);
    const fuentePlana = sinTildes(fuente);
    const problemas: string[] = [];
    if (v.titulos.length < 3) problemas.push('Hacen falta al menos 3 títulos');
    if (v.descripciones.length < 2) problemas.push('Hacen falta al menos 2 descripciones');
    for (const t of v.titulos) if (t.length > 30) problemas.push(`“${t}” tiene ${t.length} letras (máximo 30)`);
    for (const d of v.descripciones) if (d.length > 90) problemas.push(`“${d.slice(0, 40)}…” tiene ${d.length} letras (máximo 90)`);
    for (const r of [v.ruta1, v.ruta2]) if (r && r.length > 15) problemas.push(`La ruta visible “${r}” tiene más de 15 letras`);
    for (const texto of [...v.titulos, ...v.descripciones]) {
        const prom = texto.match(PROHIBIDAS);
        if (prom && !fuentePlana.includes(sinTildes(normalizar(prom[0])))) problemas.push(`“${texto}” promete “${prom[0]}”, que la web no dice`);
        for (const n of texto.match(/\d[\d.,]*/g) ?? []) {
            if (!fuente.includes(n.replace(/[.,]$/, ''))) problemas.push(`“${texto}” usa la cifra ${n}, que no está en la página`);
        }
        // Palabras con mayúscula en el medio de la frase (marcas, modelos): tienen que estar en la página.
        const palabras = texto.split(/[\s|,.;:·()/-]+/).filter(Boolean);
        palabras.forEach((w, i) => {
            if (i === 0 || !/^[A-ZÁÉÍÓÚÑ][\wÁÉÍÓÚÑáéíóúñ]{2,}$/.test(w)) return;
            if (/^(Para|Con|Sin|Por|Desde|Hasta|Empresas?|Todo|Todas?|Cotización|Entrega|Factura|Medida|Lote|País|Nacional|Argentina|Rosario|Bartez|Tecnología|Soluciones?|Equipos?|Servicio|Soporte)$/i.test(w)) return;
            if (!fuentePlana.includes(sinTildes(w.toLowerCase()))) problemas.push(`“${w}” no aparece en la página`);
        });
    }
    for (const f of v.fuentes) {
        if (f.fuente && !fuente.includes(normalizar(f.fuente)) && !fuentePlana.includes(sinTildes(normalizar(f.fuente)))) {
            problemas.push(`La fuente de “${f.texto}” no está escrita así en la página`);
        }
    }
    return [...new Set(problemas)];
}

async function paginasAnunciables(): Promise<Pagina[]> {
    const { data } = await supabase.from('web_paginas').select('url, ruta, titulo, descripcion, h1, subtitulos, items, faq, texto, ficha').eq('anunciable', true).eq('en_sitemap', true);
    return (data ?? []) as Pagina[];
}

async function elegirPagina(pedido: string, paginas: Pagina[]): Promise<{ pagina: Pagina; costo: number }> {
    const lista = paginas.map((p, i) => `${i}. ${p.ruta} — ${p.titulo ?? ''}${p.ficha?.tema ? ` (${p.ficha.tema})` : ''}`).join('\n');
    const r = await anthropic.messages.create({
        ...opcionesModelo('haiku'),
        max_tokens: 100,
        system: 'Elegís a qué página de bartez.com.ar tiene que llevar un anuncio de Google según lo que se quiere anunciar. Respondé SOLO el número de la página, nada más.',
        messages: [{ role: 'user', content: `Qué se quiere anunciar: ${pedido}\n\nPáginas:\n${lista}` }],
    });
    const i = Number(textoDe(r).match(/\d+/)?.[0] ?? -1);
    return { pagina: paginas[i] ?? paginas.find((p) => p.ruta === '/') ?? paginas[0]!, costo: calcularCosto('haiku', r.usage.input_tokens, r.usage.output_tokens) };
}

const PROMPT_GENERAR = `Sos el redactor de anuncios de Google (búsqueda) de Bartez Tecnología, distribuidor IT de Rosario que vende a empresas, organismos y revendedores de todo el país.
Escribís anuncios adaptables de búsqueda con UNA regla que no se rompe: todo lo que dice el anuncio tiene que estar en la página que te paso. Podés acortar, reordenar y combinar frases de la página, pero no agregar datos, cifras, marcas, plazos ni promesas que no estén.
Lo que pida el usuario (público, zona, tono, énfasis) sirve para elegir qué frases usar y para las palabras clave. Si pide algo que la página no dice (un rubro, un descuento, una ciudad), NO lo escribas en el anuncio: avisalo en "avisos" y, si es un público o una zona, usalo en palabras_clave.
Nada de superlativos sin respaldo ("el mejor", "líder", "número 1"), ni precios, ni descuentos, ni signos de exclamación. Castellano de Argentina, estilo sobrio y B2B. Mayúscula inicial en cada palabra importante de los títulos, como se usa en Google.
Límites: títulos de hasta 30 caracteres (contá bien), descripciones de hasta 90, rutas visibles (ruta1, ruta2) de hasta 15 sin espacios.
Respondé SOLO JSON:
{"variantes":[{"titulos":["5 títulos"],"descripciones":["2 descripciones"],"ruta1":"...","ruta2":"...","fuentes":[{"texto":"título o descripción","fuente":"frase copiada TEXTUAL de la página de donde sale"}],"palabras_clave":["5 a 10 búsquedas"]}],"avisos":["..."]}
Cada variante tiene que ser distinta (otro ángulo: producto, condiciones comerciales, respaldo, público).`;

export async function generarAnuncios(opts: { pedido: string; url?: string | null; variantes?: number; cambio?: string | null; anteriores?: Variante[] | null }): Promise<Generacion> {
    const pedido = opts.pedido.trim().slice(0, 1000);
    if (!pedido) throw new Error('Contá qué querés anunciar');
    const n = Math.min(Math.max(opts.variantes ?? 3, 1), 5);
    const paginas = await paginasAnunciables();
    if (!paginas.length) throw new Error('Todavía no se leyó la web: tocá “Releer la web” en Páginas');
    let costo = 0;
    let pagina = opts.url ? paginas.find((p) => normalizarUrl(p.url) === normalizarUrl(opts.url!)) : undefined;
    if (!pagina) {
        const e = await elegirPagina(pedido, paginas);
        pagina = e.pagina; costo += e.costo;
    }
    const contenido = [
        `URL: ${pagina.url}`,
        `Título: ${pagina.titulo ?? ''}`,
        `Descripción: ${pagina.descripcion ?? ''}`,
        pagina.h1 ? `Encabezado: ${pagina.h1}` : '',
        pagina.subtitulos?.length ? `Subtítulos:\n- ${pagina.subtitulos.join('\n- ')}` : '',
        pagina.items?.length ? `Listas:\n- ${pagina.items.slice(0, 40).join('\n- ')}` : '',
        pagina.faq?.length ? `Preguntas frecuentes:\n${pagina.faq.map((f) => `- ${f.p} ${f.r}`).join('\n')}` : '',
        pagina.ficha?.frases?.length ? `Frases destacadas:\n- ${pagina.ficha.frases.join('\n- ')}` : '',
        `Texto de la página:\n${(pagina.texto ?? '').slice(0, 9000)}`,
    ].filter(Boolean).join('\n\n');
    const pedidoCompleto = [
        `Qué quiere anunciar: ${pedido}`,
        `Cantidad de variantes: ${n}`,
        opts.cambio?.trim() ? `Cambio pedido sobre la tanda anterior: ${opts.cambio.trim().slice(0, 500)}\nTanda anterior:\n${JSON.stringify((opts.anteriores ?? []).map((v) => ({ titulos: v.titulos, descripciones: v.descripciones })))}` : '',
    ].filter(Boolean).join('\n');

    const r = await anthropic.messages.create({
        ...opcionesModelo('sonnet'),
        max_tokens: maxTokens('sonnet', 2500),
        system: PROMPT_GENERAR,
        messages: [{ role: 'user', content: `PÁGINA\n${contenido}\n\nPEDIDO\n${pedidoCompleto}` }],
    });
    costo += calcularCosto('sonnet', r.usage.input_tokens, r.usage.output_tokens);
    let j: { variantes?: Array<Partial<Variante>>; avisos?: string[] } = {};
    try { j = JSON.parse(textoDe(r).match(/\{[\s\S]*\}/)?.[0] ?? '{}'); } catch { throw new Error('La IA no devolvió anuncios válidos: probá de nuevo'); }
    const limpio = (xs: unknown, max: number) => (Array.isArray(xs) ? xs.map((x) => String(x).trim()).filter(Boolean).slice(0, max) : []);
    const variantes: Variante[] = (j.variantes ?? []).slice(0, n).map((v) => {
        const base = {
            titulos: limpio(v.titulos, 15),
            descripciones: limpio(v.descripciones, 4),
            ruta1: v.ruta1 ? String(v.ruta1).replace(/\s+/g, '-').slice(0, 30) : null,
            ruta2: v.ruta2 ? String(v.ruta2).replace(/\s+/g, '-').slice(0, 30) : null,
            fuentes: Array.isArray(v.fuentes) ? v.fuentes.map((f) => ({ texto: String((f as { texto?: string }).texto ?? ''), fuente: String((f as { fuente?: string }).fuente ?? '') })).slice(0, 20) : [],
            palabras_clave: limpio(v.palabras_clave, 12),
        };
        return { ...base, problemas: revisarVariante(base, pagina!) };
    });
    if (!variantes.length) throw new Error('La IA no devolvió anuncios: probá con otro pedido');
    return { url: pagina.url, ruta: pagina.ruta, titulo: pagina.titulo, variantes, avisos: limpio(j.avisos, 6), costo_usd: Math.round(costo * 10000) / 10000 };
}

// ---------------------------------------------------------------- Para aprobar

export async function proponerAnuncios(g: { url: string; ruta: string; pedido: string; variantes: Variante[] }): Promise<{ creadas: number }> {
    const asistente = await asistentePublicidad();
    const paginas = await paginasAnunciables();
    const pagina = paginas.find((p) => normalizarUrl(p.url) === normalizarUrl(g.url));
    if (!pagina) throw new Error('La página de destino no está entre las que se anuncian');
    let creadas = 0;
    for (const v of g.variantes) {
        // Se vuelve a revisar acá: lo que llega del panel no se da por bueno.
        const problemas = revisarVariante(v, pagina);
        if (problemas.length) throw new Error(`Un anuncio tiene problemas: ${problemas[0]}`);
        await supabase.from('acciones_pendientes').insert({
            asistente_id: asistente,
            accion: 'ads_anuncio',
            estado: 'pendiente',
            payload: { url: pagina.url, ruta: pagina.ruta, titulos: v.titulos, descripciones: v.descripciones, ruta1: v.ruta1, ruta2: v.ruta2, palabras_clave: v.palabras_clave, fuentes: v.fuentes, pedido: g.pedido.slice(0, 500) },
            respuesta: { por: 'sistema', origen: 'generar_anuncios' },
        });
        creadas++;
    }
    invalidarAnuncios();
    return { creadas };
}

export async function proponerPausa(anuncio: { id: string; titulo: string; ruta: string | null }): Promise<void> {
    if (!/^customers\/\d+\/adGroupAds\/\d+~\d+$/.test(anuncio.id)) throw new Error('Anuncio inválido');
    await supabase.from('acciones_pendientes').insert({
        asistente_id: await asistentePublicidad(),
        accion: 'ads_pausar_anuncio',
        estado: 'pendiente',
        payload: { anuncio: anuncio.id, titulo: anuncio.titulo.slice(0, 200), ruta: anuncio.ruta },
        respuesta: { por: 'humano', origen: 'panel_publicidad' },
    });
}

// ---------------------------------------------------------------- ejecución (al aprobar)

export async function ejecutarAnuncio(p: Record<string, unknown>): Promise<{ ok: boolean; detalle?: string; resultado?: Record<string, unknown> }> {
    const url = String(p.url ?? '');
    const titulos = (p.titulos as string[] | undefined) ?? [];
    const descripciones = (p.descripciones as string[] | undefined) ?? [];
    if (!url || titulos.length < 3 || descripciones.length < 2) return { ok: false, detalle: 'Al anuncio le faltan títulos o descripciones' };
    // Va al grupo de anuncios que ya lleva a esa página.
    const grupos = await consultarAds(`SELECT ad_group.resource_name, ad_group.name, ad_group.status, ad_group_ad.ad.final_urls FROM ad_group_ad WHERE ad_group_ad.status != 'REMOVED' AND ad_group.status != 'REMOVED'`);
    const destino = grupos.find((g: FilaAds) => (g.adGroupAd?.ad?.finalUrls ?? []).some((u: string) => normalizarUrl(u) === normalizarUrl(url)));
    if (!destino) {
        return { ok: false, detalle: `En Google Ads no hay un grupo de anuncios que lleve a ${String(p.ruta ?? url)}. Hay que crear la campaña para esa página; el anuncio queda guardado para cargarlo ahí.` };
    }
    const res = await mutarAds('adGroupAds', [{
        create: {
            adGroup: destino.adGroup.resourceName,
            status: 'PAUSED',
            ad: {
                finalUrls: [url],
                responsiveSearchAd: {
                    headlines: titulos.map((text) => ({ text })),
                    descriptions: descripciones.map((text) => ({ text })),
                    ...(p.ruta1 ? { path1: String(p.ruta1).slice(0, 15) } : {}),
                    ...(p.ruta2 ? { path2: String(p.ruta2).slice(0, 15) } : {}),
                },
            },
        },
    }]);
    invalidarAnuncios();
    return { ok: true, resultado: { anuncio: res[0]?.resourceName ?? null, grupo: destino.adGroup.name, estado: 'pausado' } };
}

export async function ejecutarPausa(p: Record<string, unknown>): Promise<{ ok: boolean; detalle?: string; resultado?: Record<string, unknown> }> {
    const id = String(p.anuncio ?? '');
    if (!/^customers\/(\d+)\/adGroupAds\/\d+~\d+$/.test(id) || !id.startsWith(`customers/${adsConfig().customerId}/`)) return { ok: false, detalle: 'Anuncio inválido' };
    await mutarAds('adGroupAds', [{ update: { resourceName: id, status: 'PAUSED' }, updateMask: 'status' }]);
    invalidarAnuncios();
    return { ok: true, resultado: { anuncio: id, estado: 'pausado' } };
}
