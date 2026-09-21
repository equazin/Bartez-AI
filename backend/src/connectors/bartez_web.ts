// Fetch + caché del contenido de www.bartez.com.ar.
// Lo usamos como referencia en el system prompt del Correo para que el asistente
// sepa qué vende Bartez y arme presentaciones breves basadas en info real,
// sin tener que fetchear la web en cada llamada.

import { supabase } from './supabase.js';

const URL_BARTEZ = process.env.BARTEZ_WEB_URL || 'https://www.bartez.com.ar';
const CACHE_KEY = 'bartez_web_texto';
const CACHE_TIMESTAMP_KEY = 'bartez_web_actualizada';
const MAX_EDAD_DIAS = 7;

let cacheEnMemoria: string | null = null;

// Extrae texto plano de un HTML rústicamente (sin cheerio).
// Suficiente para meter en un prompt como "esto es lo que ofrece Bartez".
function limpiarHtml(html: string): string {
    return html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#\d+;/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

export async function refrescarWebBartez(): Promise<{ ok: boolean; texto?: string; detalle?: string }> {
    try {
        const res = await fetch(URL_BARTEZ, { signal: AbortSignal.timeout(15_000) });
        if (!res.ok) return { ok: false, detalle: `HTTP ${res.status}` };
        const html = await res.text();
        const texto = limpiarHtml(html).slice(0, 4000);
        if (!texto) return { ok: false, detalle: 'la web no devolvió texto útil' };

        await supabase.from('integraciones_config').upsert({
            clave: CACHE_KEY,
            valor: texto,
            actualizado_en: new Date().toISOString(),
        });
        await supabase.from('integraciones_config').upsert({
            clave: CACHE_TIMESTAMP_KEY,
            valor: new Date().toISOString(),
            actualizado_en: new Date().toISOString(),
        });
        cacheEnMemoria = texto;
        return { ok: true, texto };
    } catch (err) {
        return { ok: false, detalle: (err as Error).message };
    }
}

// Devuelve el texto cacheado. Si el caché tiene más de MAX_EDAD_DIAS o no existe,
// lo refresca en background (no bloquea la llamada, devuelve lo que hay).
export async function textoWebBartez(): Promise<string> {
    if (cacheEnMemoria) return cacheEnMemoria;

    const { data: filaTexto } = await supabase
        .from('integraciones_config')
        .select('valor')
        .eq('clave', CACHE_KEY)
        .maybeSingle();
    const { data: filaTs } = await supabase
        .from('integraciones_config')
        .select('valor')
        .eq('clave', CACHE_TIMESTAMP_KEY)
        .maybeSingle();

    const texto = (filaTexto?.valor as string | undefined) ?? '';
    const tsStr = (filaTs?.valor as string | undefined) ?? '';
    const ts = tsStr ? new Date(tsStr).getTime() : 0;
    const edad = Date.now() - ts;
    const stale = !texto || edad > MAX_EDAD_DIAS * 24 * 3600_000;

    if (stale) {
        refrescarWebBartez().catch(() => {});
    }

    cacheEnMemoria = texto;
    return texto;
}
