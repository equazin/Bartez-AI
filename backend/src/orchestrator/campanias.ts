// Campañas nuevas de Google Ads, una por página de bartez.com.ar.
//
// El asistente propone la campaña completa (presupuesto diario, zona, palabras
// clave y anuncios) y va a Para aprobar. Al aprobarla se crea todo junto en
// Google Ads —o nada, si algo falla— con la campaña PAUSADA: sale recién cuando
// la prendés en Google Ads.
//
// El presupuesto se controla contra el tope mensual: la suma de lo que ya está
// prendido, lo que creó el asistente y lo que espera tu ok no puede pasarlo.

import { supabase } from '../connectors/supabase.js';
import { consultarAds, customerId, estadoConexion, mutarVarios, type FilaAds } from '../connectors/google_ads.js';
import { tipoDeCambio } from './catalogo_proveedores.js';
import { cuentaAds, leerConfig, normalizarUrl } from './publicidad.js';
import { invalidarAnuncios, revisarVariante, paginaAnunciable, type Variante } from './anuncios.js';

export const DIAS_MES = 30.4;               // Google gasta como máximo el diario × 30,4 por mes
export const PREFIJO = 'Bartez AI · ';
const ROSARIO = { lat: -32.9442, lng: -60.6505 };
const ARGENTINA = 'geoTargetConstants/2032';
const ESPANOL = 'languageConstants/1003';

// Búsquedas de gente que no compra: se excluyen en toda campaña nueva.
export const NEGATIVAS = ['gratis', 'gratuito', 'empleo', 'trabajo', 'curso', 'tutorial', 'descargar', 'pdf', 'usado', 'usados', 'segunda mano'];

export type Zona = { tipo: 'pais' } | { tipo: 'radio'; km: number };

// Ajustes guarda la zona como texto: "pais", "rosario:80" o lo que haya escrito
// el usuario ("Rosario y 100 km", "todo el país").
export function zonaDeTexto(z: string | null | undefined): Zona {
    const t = (z ?? '').toLowerCase();
    if (/^pais$|pa[ií]s|argentina|nacional/.test(t)) return { tipo: 'pais' };
    const km = Number(t.match(/\d+/)?.[0]);
    return { tipo: 'radio', km: km >= 5 && km <= 500 ? km : 80 };
}

export function textoZona(z: Zona): string {
    return z.tipo === 'pais' ? 'Todo el país' : `Rosario y ${z.km} km alrededor`;
}

const redondear = (n: number) => Math.round(n * 100) / 100;

// Tope mensual en la moneda de la cuenta (se carga en pesos).
async function topeCuenta(): Promise<{ tope: number | null; moneda: string }> {
    const [config, cuenta] = await Promise.all([leerConfig(), cuentaAds()]);
    const moneda = cuenta?.moneda ?? 'ARS';
    if (config.tope_mensual_ars == null) return { tope: null, moneda };
    if (moneda !== 'USD') return { tope: config.tope_mensual_ars, moneda };
    try { return { tope: redondear(config.tope_mensual_ars / (await tipoDeCambio()).valor), moneda }; } catch { return { tope: null, moneda }; }
}

// Grupo de anuncios que ya lleva a esa página (si hay).
export async function grupoParaUrl(url: string): Promise<string | null> {
    const filas = await consultarAds(`SELECT ad_group.name, ad_group_ad.ad.final_urls FROM ad_group_ad WHERE ad_group_ad.status != 'REMOVED' AND ad_group.status != 'REMOVED' AND campaign.status != 'REMOVED'`);
    const f = filas.find((g: FilaAds) => (g.adGroupAd?.ad?.finalUrls ?? []).some((u: string) => normalizarUrl(u) === normalizarUrl(url)));
    return f ? String(f.adGroup?.name ?? 'sin nombre') : null;
}

// Presupuesto diario ya comprometido: campañas prendidas, las que creó el
// asistente (aunque estén pausadas: se prenden con un clic) y las propuestas
// que esperan tu ok. `excepto` deja afuera la propuesta que se está ejecutando.
export async function comprometidoDiario(excepto?: string): Promise<{ total: number; detalle: Array<{ nombre: string; diario: number; estado: string }> }> {
    const camps = await consultarAds(`SELECT campaign.name, campaign.status, campaign_budget.amount_micros FROM campaign WHERE campaign.status != 'REMOVED'`);
    const detalle: Array<{ nombre: string; diario: number; estado: string }> = [];
    for (const c of camps) {
        const nombre = String(c.campaign?.name ?? '');
        const estado = String(c.campaign?.status ?? '');
        if (estado !== 'ENABLED' && !nombre.startsWith(PREFIJO)) continue;
        detalle.push({ nombre, diario: redondear(Number(c.campaignBudget?.amountMicros ?? 0) / 1_000_000), estado: estado === 'ENABLED' ? 'prendida' : 'pausada' });
    }
    const { data } = await supabase.from('acciones_pendientes').select('payload').eq('accion', 'ads_campania').eq('estado', 'pendiente');
    for (const a of data ?? []) {
        const p = a.payload as { url?: string; ruta?: string; presupuesto_diario?: number };
        if (excepto && normalizarUrl(String(p.url ?? '')) === normalizarUrl(excepto)) continue;
        detalle.push({ nombre: `${PREFIJO}${p.ruta ?? ''}`, diario: Number(p.presupuesto_diario ?? 0), estado: 'espera tu ok' });
    }
    return { total: redondear(detalle.reduce((s, d) => s + d.diario, 0)), detalle };
}

export interface InfoCampania {
    conectado: boolean;
    grupo_existente: string | null;
    propuesta_pendiente: boolean;
    moneda: string;
    tope: number | null;
    comprometido_diario: number;
    disponible_diario: number | null;
    sugerido_diario: number | null;
    zona: Zona;
}

// Lo que necesita el panel para armar la propuesta de una página.
export async function infoCampania(url: string): Promise<InfoCampania> {
    const [con, config, t] = await Promise.all([estadoConexion(), leerConfig(), topeCuenta()]);
    const zona = zonaDeTexto(config.zona);
    const { data: pend } = await supabase.from('acciones_pendientes').select('payload').eq('accion', 'ads_campania').eq('estado', 'pendiente');
    const propuesta_pendiente = (pend ?? []).some((a) => normalizarUrl(String((a.payload as { url?: string }).url ?? '')) === normalizarUrl(url));
    if (!con.conectado) {
        return { conectado: false, grupo_existente: null, propuesta_pendiente, moneda: t.moneda, tope: t.tope, comprometido_diario: 0, disponible_diario: null, sugerido_diario: null, zona };
    }
    const [grupo, comp] = await Promise.all([grupoParaUrl(url), comprometidoDiario()]);
    const disponible = t.tope == null ? null : Math.max(0, redondear(t.tope / DIAS_MES - comp.total));
    // Sugerido: lo que queda, sin pasar de un tercio del tope (para que entren otras páginas).
    const sugerido = disponible == null ? null : Math.floor(Math.min(disponible, t.tope! / DIAS_MES / 3) / (t.moneda === 'USD' ? 1 : 100)) * (t.moneda === 'USD' ? 1 : 100);
    return { conectado: true, grupo_existente: grupo, propuesta_pendiente, moneda: t.moneda, tope: t.tope, comprometido_diario: comp.total, disponible_diario: disponible, sugerido_diario: sugerido || null, zona };
}

// Palabras clave: texto simple, sin símbolos que Google no acepta.
export function limpiarPalabras(xs: string[]): string[] {
    const vistas = new Set<string>();
    const out: string[] = [];
    for (const x of xs) {
        const k = x.toLowerCase().replace(/[^\p{L}\p{N}\s.&-]/gu, ' ').replace(/\s+/g, ' ').trim();
        if (k.length < 3 || k.length > 80 || k.split(' ').length > 10 || vistas.has(k)) continue;
        vistas.add(k); out.push(k);
    }
    return out.slice(0, 20);
}

export interface PropuestaCampania {
    url: string;
    ruta: string;
    pedido: string;
    variantes: Variante[];
    palabras_clave: string[];
    presupuesto_diario: number;
    zona: Zona;
}

async function controlarPresupuesto(url: string, diario: number): Promise<void> {
    const t = await topeCuenta();
    if (t.tope == null) throw new Error('Primero cargá el tope mensual en Publicidad → Ajustes: con eso se controla el presupuesto de cada campaña.');
    const comp = await comprometidoDiario(url);
    const mensual = (comp.total + diario) * DIAS_MES;
    if (mensual > t.tope + 0.01) {
        const libre = Math.max(0, Math.floor(t.tope / DIAS_MES - comp.total));
        throw new Error(`Con esta campaña el gasto posible del mes sería ${Math.round(mensual).toLocaleString('es-AR')} y el tope es ${Math.round(t.tope).toLocaleString('es-AR')}. Queda lugar para ${libre.toLocaleString('es-AR')} por día.`);
    }
}

export async function proponerCampania(c: PropuestaCampania): Promise<{ ok: true }> {
    if (!(await estadoConexion()).conectado) throw new Error('Conectá Google Ads para proponer campañas');
    const pagina = await paginaAnunciable(c.url);
    if (!pagina) throw new Error('La página de destino no está entre las que se anuncian');
    if (!(c.presupuesto_diario > 0)) throw new Error('Poné un presupuesto diario');
    const grupo = await grupoParaUrl(pagina.url);
    if (grupo) throw new Error(`Ya hay un grupo de anuncios que lleva a esa página (“${grupo}”): mandá los anuncios sueltos, sin campaña nueva.`);
    const info = await infoCampania(pagina.url);
    if (info.propuesta_pendiente) throw new Error('Ya hay una campaña para esa página esperando tu ok en Para aprobar');
    await controlarPresupuesto(pagina.url, c.presupuesto_diario);
    for (const v of c.variantes) {
        const problemas = revisarVariante(v, pagina);
        if (problemas.length) throw new Error(`Un anuncio tiene problemas: ${problemas[0]}`);
    }
    const palabras = limpiarPalabras(c.palabras_clave);
    if (palabras.length < 3) throw new Error('Hacen falta al menos 3 palabras clave');
    const { data: asis } = await supabase.from('asistentes').select('id').eq('area', 'publicidad').maybeSingle();
    await supabase.from('acciones_pendientes').insert({
        asistente_id: (asis?.id as string) ?? null,
        accion: 'ads_campania',
        estado: 'pendiente',
        payload: {
            url: pagina.url, ruta: pagina.ruta, titulo: pagina.titulo,
            presupuesto_diario: redondear(c.presupuesto_diario), moneda: info.moneda, zona: c.zona,
            palabras_clave: palabras, negativas: NEGATIVAS,
            anuncios: c.variantes.map((v) => ({ titulos: v.titulos, descripciones: v.descripciones, ruta1: v.ruta1, ruta2: v.ruta2, fuentes: v.fuentes })),
            pedido: c.pedido.slice(0, 500),
        },
        respuesta: { por: 'sistema', origen: 'generar_anuncios' },
    });
    invalidarAnuncios();
    return { ok: true };
}

// Las operaciones que se mandan a Google (separado para poder probarlo).
export function operacionesCampania(cid: string, p: Record<string, unknown>, fecha: string): Array<Record<string, unknown>> {
    const url = String(p.url);
    const ruta = String(p.ruta ?? url);
    const zona = (p.zona as Zona | undefined) ?? { tipo: 'radio', km: 80 };
    const presupuesto = `customers/${cid}/campaignBudgets/-1`;
    const campania = `customers/${cid}/campaigns/-2`;
    const grupo = `customers/${cid}/adGroups/-3`;
    const nombre = `${PREFIJO}${ruta} · ${fecha}`.slice(0, 250);
    const ops: Array<Record<string, unknown>> = [
        { campaignBudgetOperation: { create: { resourceName: presupuesto, name: `${nombre} · presupuesto`, amountMicros: String(Math.round(Number(p.presupuesto_diario) * 1_000_000)), deliveryMethod: 'STANDARD', explicitlyShared: false } } },
        { campaignOperation: { create: {
            resourceName: campania, name: nombre, status: 'PAUSED',
            advertisingChannelType: 'SEARCH', campaignBudget: presupuesto,
            targetSpend: {},    // "maximizar clics": sin seguimiento de conversiones todavía
            networkSettings: { targetGoogleSearch: true, targetSearchNetwork: false, targetContentNetwork: false, targetPartnerSearchNetwork: false },
            geoTargetTypeSetting: { positiveGeoTargetType: 'PRESENCE' },   // gente que está en la zona, no que "se interesa" por ella
            containsEuPoliticalAdvertising: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING',
        } } },
        { campaignCriterionOperation: { create: zona.tipo === 'pais'
            ? { campaign: campania, location: { geoTargetConstant: ARGENTINA } }
            : { campaign: campania, proximity: { geoPoint: { latitudeInMicroDegrees: Math.round(ROSARIO.lat * 1e6), longitudeInMicroDegrees: Math.round(ROSARIO.lng * 1e6) }, radius: zona.km, radiusUnits: 'KILOMETERS' } } } },
        { campaignCriterionOperation: { create: { campaign: campania, language: { languageConstant: ESPANOL } } } },
        ...((p.negativas as string[] | undefined) ?? []).map((text) => ({ campaignCriterionOperation: { create: { campaign: campania, negative: true, keyword: { text, matchType: 'BROAD' } } } })),
        { adGroupOperation: { create: { resourceName: grupo, name: ruta.slice(0, 250), campaign: campania, status: 'ENABLED', type: 'SEARCH_STANDARD' } } },
        ...((p.palabras_clave as string[] | undefined) ?? []).map((text) => ({ adGroupCriterionOperation: { create: { adGroup: grupo, status: 'ENABLED', keyword: { text, matchType: 'PHRASE' } } } })),
        ...((p.anuncios as Array<{ titulos: string[]; descripciones: string[]; ruta1?: string | null; ruta2?: string | null }> | undefined) ?? []).map((a) => ({
            adGroupAdOperation: { create: { adGroup: grupo, status: 'ENABLED', ad: {
                finalUrls: [url],
                responsiveSearchAd: {
                    headlines: a.titulos.map((text) => ({ text })),
                    descriptions: a.descripciones.map((text) => ({ text })),
                    ...(a.ruta1 ? { path1: String(a.ruta1).slice(0, 15) } : {}),
                    ...(a.ruta2 ? { path2: String(a.ruta2).slice(0, 15) } : {}),
                },
            } } },
        })),
    ];
    return ops;
}

export async function ejecutarCampania(p: Record<string, unknown>): Promise<{ ok: boolean; detalle?: string; resultado?: Record<string, unknown> }> {
    const url = String(p.url ?? '');
    const anuncios = (p.anuncios as unknown[] | undefined) ?? [];
    const palabras = (p.palabras_clave as string[] | undefined) ?? [];
    if (!url || !anuncios.length || palabras.length < 3 || !(Number(p.presupuesto_diario) > 0)) return { ok: false, detalle: 'A la campaña le faltan anuncios, palabras clave o presupuesto' };
    // Se vuelve a controlar al aprobar: pudo haber cambiado la cuenta o el tope.
    const grupo = await grupoParaUrl(url);
    if (grupo) return { ok: false, detalle: `Ya hay un grupo de anuncios que lleva a ${String(p.ruta ?? url)} (“${grupo}”). No se creó otra campaña.` };
    try { await controlarPresupuesto(url, Number(p.presupuesto_diario)); } catch (e) { return { ok: false, detalle: (e as Error).message }; }
    const fecha = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });
    const res = await mutarVarios(operacionesCampania(customerId(), p, fecha));
    invalidarAnuncios();
    const camp = res.map((r) => r.campaignResult?.resourceName).find(Boolean) ?? null;
    return { ok: true, resultado: { campania: camp, estado: 'pausada', anuncios: anuncios.length, palabras_clave: palabras.length } };
}
