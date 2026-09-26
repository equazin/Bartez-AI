// Mapa de www.bartez.com.ar para el asistente de Publicidad: lee el sitemap y
// cada página, guarda lo que dice (título, descripción, subtítulos, listas,
// preguntas frecuentes, texto) y detecta cambios. Los anuncios salen de acá: lo
// que no está en la web no va en un anuncio.
//
// Para cada página que se puede anunciar arma una "ficha" (qué ofrece, para
// quién, frases textuales de la página). Las frases se verifican contra el texto:
// si la IA devuelve algo que no está escrito en la página, se descarta.

import { createHash } from 'node:crypto';
import { supabase } from '../connectors/supabase.js';
import { anthropic, calcularCosto, maxTokens, opcionesModelo, textoDe } from '../connectors/anthropic.js';

const SITIO = (process.env.BARTEZ_WEB_URL || 'https://www.bartez.com.ar').replace(/\/+$/, '');
const AGENTE = 'BartezAI/1.0 (+https://bartez.com.ar)';
const MAX_PAGINAS = 300;

export type TipoPagina = 'portada' | 'solucion' | 'servicio' | 'vertical' | 'canal' | 'producto' | 'conversion'
    | 'caso' | 'recurso' | 'descarga' | 'posventa' | 'legal' | 'institucional' | 'otra';

export interface Ficha {
    tema: string;
    publico: string;
    ofrece: string[];
    marcas: string[];
    frases: string[];          // textuales de la página, verificadas
    palabras_clave: string[];  // cómo lo buscaría una empresa en Google
}

export interface PaginaLeida {
    url: string;
    ruta: string;
    estado_http: number;
    titulo: string | null;
    descripcion: string | null;
    h1: string | null;
    subtitulos: string[];
    items: string[];
    faq: Array<{ p: string; r: string }>;
    texto: string;
    empresa?: Record<string, unknown> | null;
}

const SERVICIOS = ['/servicios-profesionales', '/servicios-administrados', '/renting-leasing', '/cloud-licenciamiento', '/ciberseguridad', '/soporte-corporativo'];
const VERTICALES = ['/empresas', '/gobierno', '/educacion', '/salud', '/industria', '/logistica'];
const CONVERSION = ['/rfq', '/contacto', '/configurador', '/comparador'];

// Tipo de página por su ruta, y si se anuncia de entrada (después se cambia desde el panel).
export function clasificarRuta(ruta: string): { tipo: TipoPagina; anunciable: boolean } {
    const r = ruta.replace(/\/+$/, '') || '/';
    const empieza = (p: string) => r === p || r.startsWith(`${p}/`);
    if (r === '/') return { tipo: 'portada', anunciable: true };
    if (empieza('/soluciones')) return { tipo: 'solucion', anunciable: r !== '/soluciones' };
    if (SERVICIOS.some(empieza)) return { tipo: 'servicio', anunciable: true };
    if (VERTICALES.some(empieza)) return { tipo: 'vertical', anunciable: r === '/empresas' };
    if (empieza('/revendedores')) return { tipo: 'canal', anunciable: true };
    if (empieza('/barpos')) return { tipo: 'producto', anunciable: true };
    if (CONVERSION.some(empieza)) return { tipo: 'conversion', anunciable: false };
    if (empieza('/casos')) return { tipo: 'caso', anunciable: false };
    if (empieza('/recursos')) return { tipo: 'recurso', anunciable: false };
    if (empieza('/descargas')) return { tipo: 'descarga', anunciable: false };
    if (empieza('/garantias-rma') || empieza('/ayuda')) return { tipo: 'posventa', anunciable: false };
    if (empieza('/legales')) return { tipo: 'legal', anunciable: false };
    return { tipo: 'institucional', anunciable: false };
}

const ENTIDADES: Record<string, string> = { '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&#x27;': "'", '&apos;': "'" };
function decodificar(s: string): string {
    return s
        .replace(/&(nbsp|amp|lt|gt|quot|apos|#39|#x27);/g, (m) => ENTIDADES[m] ?? m)
        .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
        .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}
// Texto de un fragmento de HTML: cada etiqueta separa palabras ("multi-marca</h3><p>Lenovo" → "multi-marca Lenovo").
const aTexto = (html: string) => decodificar(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

export function normalizar(s: string): string {
    return s.normalize('NFC').toLowerCase().replace(/[“”«»"]/g, '"').replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim();
}

export function leerHtml(url: string, estado: number, html: string): PaginaLeida {
    const ruta = new URL(url).pathname.replace(/\/+$/, '') || '/';
    const cuerpo = html
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
        .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
        // Menú, encabezado y pie se repiten en todas las páginas: no son contenido propio.
        .replace(/<(nav|header|footer)\b[\s\S]*?<\/\1>/gi, ' ');
    const titulo = aTexto(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '') || null;
    const descripcion = decodificar(
        html.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i)?.[1]
        ?? html.match(/<meta[^>]+content=["']([^"']*)["'][^>]*name=["']description["']/i)?.[1] ?? '',
    ).trim() || null;
    const h1 = aTexto(cuerpo.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? '') || null;
    const unicos = (xs: string[], max: number) => [...new Set(xs.filter((x) => x.length >= 3))].slice(0, max);
    const subtitulos = unicos([...cuerpo.matchAll(/<h([23])[^>]*>([\s\S]*?)<\/h\1>/gi)].map((m) => aTexto(m[2]!)), 60);
    const items = unicos([...cuerpo.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)].map((m) => aTexto(m[1]!)).filter((x) => x.length <= 300), 80);

    // Datos estructurados (JSON-LD): preguntas frecuentes y datos de la empresa.
    const faq: PaginaLeida['faq'] = [];
    let empresa: Record<string, unknown> | null = null;
    for (const m of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
        try {
            const d = JSON.parse(m[1]!) as Record<string, unknown> | Array<Record<string, unknown>>;
            const nodos = Array.isArray(d) ? d : ((d['@graph'] as Array<Record<string, unknown>> | undefined) ?? [d]);
            for (const n of nodos) {
                if (n['@type'] === 'FAQPage' && Array.isArray(n.mainEntity)) {
                    for (const q of n.mainEntity as Array<{ name?: string; acceptedAnswer?: { text?: string } }>) {
                        if (q.name && q.acceptedAnswer?.text) faq.push({ p: aTexto(q.name), r: aTexto(q.acceptedAnswer.text) });
                    }
                }
                if (n['@type'] === 'LocalBusiness' || n['@type'] === 'Organization') empresa = { ...(empresa ?? {}), ...n };
            }
        } catch { /* JSON-LD roto: se ignora */ }
    }
    const faqUnicas = [...new Map(faq.map((f) => [f.p, f])).values()].slice(0, 40);
    const texto = aTexto(cuerpo).slice(0, 30_000);
    return { url, ruta, estado_http: estado, titulo, descripcion, h1, subtitulos, items, faq: faqUnicas, texto, empresa };
}

export const huella = (p: Pick<PaginaLeida, 'titulo' | 'descripcion' | 'texto'>) =>
    createHash('sha256').update(`${p.titulo ?? ''}\n${p.descripcion ?? ''}\n${normalizar(p.texto)}`).digest('hex').slice(0, 32);

// Solo páginas de bartez.com.ar (el sitemap podría traer cualquier cosa).
export function esDelSitio(url: string): boolean {
    try {
        const u = new URL(url);
        return u.protocol === 'https:' && (u.hostname === 'bartez.com.ar' || u.hostname.endsWith('.bartez.com.ar'));
    } catch { return false; }
}

async function traer(url: string): Promise<{ estado: number; html: string }> {
    try {
        const r = await fetch(url, { headers: { 'User-Agent': AGENTE, Accept: 'text/html,application/xml' }, redirect: 'follow', signal: AbortSignal.timeout(20_000) });
        const tipo = r.headers.get('content-type') ?? '';
        const html = /html|xml/.test(tipo) ? (await r.text()).slice(0, 3_000_000) : '';
        return { estado: r.status, html };
    } catch {
        return { estado: 0, html: '' };
    }
}

export async function urlsDelSitemap(): Promise<string[]> {
    const { estado, html } = await traer(`${SITIO}/sitemap.xml`);
    if (estado !== 200 || !html) throw new Error(`No se pudo leer el sitemap (HTTP ${estado || 'sin respuesta'})`);
    const urls = [...html.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => decodificar(m[1]!).trim()).filter(esDelSitio);
    return [...new Set(urls)].slice(0, MAX_PAGINAS);
}

const PROMPT_FICHA = `Te paso el contenido de una página de www.bartez.com.ar (Bartez Tecnología, distribuidor IT de Rosario que vende a empresas, organismos y revendedores de todo el país).
Armá una ficha para usar después en anuncios de Google. Usá SOLO lo que dice la página.
Respondé SOLO JSON:
{"tema": "de qué trata la página, en pocas palabras",
 "publico": "a quién le habla (ej. empresas que renuevan notebooks por lote)",
 "ofrece": ["lo que ofrece, en frases cortas"],
 "marcas": ["marcas que nombra la página"],
 "frases": ["entre 8 y 20 frases COPIADAS TEXTUALMENTE de la página, de 15 a 90 caracteres, que sirvan como título o descripción de un anuncio: beneficios concretos, alcance, condiciones. Copiá letra por letra, sin cambiar ni resumir"],
 "palabras_clave": ["entre 5 y 15 búsquedas que haría en Google una empresa que necesita esto, en castellano de Argentina"]}`;

// Ficha de una página. Las frases que no están tal cual en la página se descartan.
export async function armarFicha(p: PaginaLeida): Promise<{ ficha: Ficha | null; costoUsd: number }> {
    const contenido = [
        `URL: ${p.url}`,
        p.titulo ? `Título: ${p.titulo}` : '',
        p.descripcion ? `Descripción: ${p.descripcion}` : '',
        p.h1 ? `Encabezado: ${p.h1}` : '',
        p.subtitulos.length ? `Subtítulos:\n- ${p.subtitulos.join('\n- ')}` : '',
        p.faq.length ? `Preguntas frecuentes:\n${p.faq.map((f) => `- ${f.p} ${f.r}`).join('\n')}` : '',
        `Texto:\n${p.texto.slice(0, 12_000)}`,
    ].filter(Boolean).join('\n\n');
    try {
        const r = await anthropic.messages.create({
            ...opcionesModelo('haiku'),
            max_tokens: maxTokens('haiku', 1500),
            system: PROMPT_FICHA,
            messages: [{ role: 'user', content: contenido }],
        });
        const costoUsd = calcularCosto('haiku', r.usage.input_tokens, r.usage.output_tokens);
        const j = JSON.parse(textoDe(r).match(/\{[\s\S]*\}/)?.[0] ?? '{}') as Partial<Ficha>;
        const lista = (x: unknown, max: number) => (Array.isArray(x) ? x.map(String).map((s) => s.trim()).filter(Boolean).slice(0, max) : []);
        const fuente = normalizar([p.titulo, p.descripcion, p.h1, ...p.subtitulos, ...p.items, ...p.faq.flatMap((f) => [f.p, f.r]), p.texto].join(' \n '));
        const frases = [...new Set(lista(j.frases, 30).map((f) => f.replace(/^["“]|["”]$/g, '').trim()))]
            .filter((f) => f.length >= 8 && f.length <= 120 && fuente.includes(normalizar(f)));
        const marcas = lista(j.marcas, 15).filter((m) => fuente.includes(normalizar(m)));
        return {
            costoUsd,
            ficha: {
                tema: String(j.tema ?? '').slice(0, 200),
                publico: String(j.publico ?? '').slice(0, 200),
                ofrece: lista(j.ofrece, 12),
                marcas,
                frases,
                palabras_clave: lista(j.palabras_clave, 20),
            },
        };
    } catch {
        return { ficha: null, costoUsd: 0 };
    }
}

export interface ResultadoLectura {
    paginas: number;
    nuevas: string[];
    cambiadas: string[];
    con_error: string[];
    quitadas: string[];
    fichas: number;
    costo_usd: number;
    duracion_ms: number;
}

let leyendo = false;

// Lee la web entera. Rehace la ficha solo de las páginas anunciables que cambiaron.
export async function leerWeb(opts: { rehacerFichas?: boolean } = {}): Promise<ResultadoLectura> {
    if (leyendo) throw new Error('Ya se está leyendo la web');
    leyendo = true;
    const inicio = Date.now();
    try {
        const urls = await urlsDelSitemap();
        const { data: previas } = await supabase.from('web_paginas').select('url, huella, ficha_huella, anunciable, en_sitemap');
        const antes = new Map((previas ?? []).map((p) => [p.url as string, p]));
        const res: ResultadoLectura = { paginas: urls.length, nuevas: [], cambiadas: [], con_error: [], quitadas: [], fichas: 0, costo_usd: 0, duracion_ms: 0 };
        let empresa: Record<string, unknown> | null = null;
        const ahora = new Date().toISOString();

        const una = async (url: string) => {
            const { estado, html } = await traer(url);
            const previa = antes.get(url);
            const { tipo, anunciable } = clasificarRuta(new URL(url).pathname);
            if (estado !== 200 || !html) {
                res.con_error.push(url);
                await supabase.from('web_paginas').upsert({
                    url, ruta: new URL(url).pathname.replace(/\/+$/, '') || '/', tipo,
                    ...(previa ? {} : { anunciable }), estado_http: estado, en_sitemap: true, leida_en: ahora,
                });
                return;
            }
            const p = leerHtml(url, estado, html);
            if (p.empresa && !empresa) empresa = p.empresa;
            const h = huella(p);
            const cambio = !!previa && previa.huella !== h;
            if (!previa) res.nuevas.push(url);
            else if (cambio) res.cambiadas.push(url);
            const fila: Record<string, unknown> = {
                url, ruta: p.ruta, tipo, estado_http: estado, titulo: p.titulo, descripcion: p.descripcion, h1: p.h1,
                subtitulos: p.subtitulos, items: p.items, faq: p.faq, texto: p.texto, huella: h, en_sitemap: true, leida_en: ahora,
            };
            if (!previa) fila.anunciable = anunciable;
            if (!previa || cambio) fila.cambio_en = ahora;
            // La elección hecha desde el panel se respeta.
            const seAnuncia = previa ? previa.anunciable === true : anunciable;
            if (seAnuncia && (opts.rehacerFichas || previa?.ficha_huella !== h)) {
                const { ficha, costoUsd } = await armarFicha(p);
                res.costo_usd += costoUsd;
                if (ficha) { fila.ficha = ficha; fila.ficha_huella = h; res.fichas++; }
            }
            await supabase.from('web_paginas').upsert(fila);
        };

        for (let i = 0; i < urls.length; i += 4) await Promise.all(urls.slice(i, i + 4).map(una));

        // Las que ya no están en el sitemap.
        const actuales = new Set(urls);
        for (const [url, p] of antes) {
            if (!actuales.has(url) && p.en_sitemap !== false) {
                res.quitadas.push(url);
                await supabase.from('web_paginas').update({ en_sitemap: false, cambio_en: ahora }).eq('url', url);
            }
        }
        if (empresa) {
            await supabase.from('integraciones_config').upsert({ clave: 'web_empresa', valor: JSON.stringify(empresa), actualizado_en: ahora });
        }
        await supabase.from('integraciones_config').upsert({ clave: 'web_mapa_leida', valor: ahora, actualizado_en: ahora });
        res.costo_usd = Math.round(res.costo_usd * 10000) / 10000;
        res.duracion_ms = Date.now() - inicio;
        return res;
    } finally {
        leyendo = false;
    }
}

export const leyendoWeb = () => leyendo;
