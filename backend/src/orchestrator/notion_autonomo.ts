// Notion autónomo: que cada vez que el operador entre a Notion esté todo claro.
//
// 1) Tablero (la página principal de Bartez AI): se REESCRIBE entero en cada
//    actualización con datos exactos calculados acá (nunca por la IA), así
//    nunca queda viejo ni duplicado. Corre cada 30 min en horario laboral.
// 2) Curador: un agente con decisión propia que lee la foto completa del
//    negocio (lo que generaron todos los asistentes) y el estado de Notion, y
//    crea / actualiza / completa / archiva tareas y notas. Deja las prioridades del día para el tablero. Cada cambio queda en
//    notion_cambios. Corre 3 veces por día hábil y a demanda.
//
// Límites: el curador solo toca filas de los databases Tareas y Notas. Prospectos es de solo lectura (su fuente de verdad
// es Bartez AI y se sincroniza sola). Nunca borra: archiva (recuperable).

import Anthropic from '@anthropic-ai/sdk';
import { anthropic, calcularCosto, idModelo } from '../connectors/anthropic.js';
import { idsNotion, notion, notionConfigurado } from '../connectors/notion.js';
import { supabase } from '../connectors/supabase.js';
import { contextoFecha } from '../assistants/base.js';
import type { ModeloClaude } from './types.js';

const ROOT = process.env.NOTION_PARENT_PAGE_ID ?? '';
const TZ = 'America/Argentina/Buenos_Aires';
const DIA_MS = 24 * 3600_000;

const fechaCorta = (iso: string | null | undefined) =>
    iso ? new Date(iso).toLocaleDateString('es-AR', { timeZone: TZ, day: '2-digit', month: '2-digit' }) : '—';
const fechaHora = (iso: string | Date) =>
    new Date(iso).toLocaleString('es-AR', { timeZone: TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const usd = (n: number) => `US$ ${n.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const notionUrl = (id: string) => `https://www.notion.so/${id.replace(/-/g, '')}`;
const sinGuiones = (id: string) => id.replace(/-/g, '');

async function leerConfig(clave: string): Promise<string | null> {
    const { data } = await supabase.from('integraciones_config').select('valor').eq('clave', clave).maybeSingle();
    return (data?.valor as string | null) ?? null;
}
async function guardarConfig(clave: string, valor: string): Promise<void> {
    await supabase.from('integraciones_config').upsert({ clave, valor, actualizado_en: new Date().toISOString() });
}

// ====================================================================
// Foto del negocio (todo lo que generaron los demás asistentes)
// ====================================================================

export interface TareaNotion {
    id: string;
    titulo: string;
    cliente: string;
    estado: string | null;
    fecha_limite: string | null;
    contexto: string;
    creada_por: string | null;
    creada_en: string;
}

export interface FotoNegocio {
    generado_en: string;
    acciones_pendientes: Array<{ tipo: string; destino: string; resumen: string; creada: string; asistente: string | null }>;
    whatsapp: {
        derivadas: number;
        sin_responder_en_ventana: Array<{ contacto: string; ultimo: string; hace_horas: number; vence: string }>;
        sin_responder_vencidas: Array<{ contacto: string; ultimo: string; dias: number }>;
    };
    correos_3_dias: {
        por_categoria: Record<string, number>;
        relevantes: Array<{ de: string; asunto: string; categoria: string | null; fecha: string; respondido: boolean }>;
    };
    cotizaciones_14_dias: Array<{ numero: string | null; cliente: string; total_usd: number; fecha: string; renglones: number; estado: string; desde_documento: boolean }>;
    pipeline: {
        por_estado: Record<string, number>;
        leads_calientes: Array<{ nombre: string; icp: number | null; ultimo_contacto: string | null; intentos: number }>;
        leads_sin_contacto_7d: number;
    };
    proveedores: Array<{ nombre: string; estado: string | null; articulos: number | null; ultima_sync: string | null }>;
    analitica: { fecha: string; periodo: string; resumen: string; propuestas: string[] } | null;
    tareas_notion: TareaNotion[];
}

function textoProp(p: unknown): string {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const v = p as any;
    if (!v) return '';
    if (v.type === 'title' || v.type === 'rich_text') return (v[v.type] ?? []).map((r: { plain_text: string }) => r.plain_text).join('');
    if (v.type === 'select') return v.select?.name ?? '';
    if (v.type === 'date') return v.date?.start ?? '';
    return '';
}

export async function tareasNotion(soloPendientes = false): Promise<TareaNotion[]> {
    const dbId = idsNotion().tareas;
    if (!notion || !dbId) return [];
    const out: TareaNotion[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 5; i++) {
        const resp = await notion.databases.query({
            database_id: dbId,
            page_size: 100,
            start_cursor: cursor,
            ...(soloPendientes ? { filter: { property: 'Estado', select: { equals: 'pendiente' } } } : {}),
        });
        for (const r of resp.results) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const pg = r as any;
            const pr = pg.properties ?? {};
            out.push({
                id: pg.id,
                titulo: textoProp(pr['Título']),
                cliente: textoProp(pr['Cliente']),
                estado: textoProp(pr['Estado']) || null,
                fecha_limite: textoProp(pr['Fecha límite']) || null,
                contexto: textoProp(pr['Contexto']).slice(0, 300),
                creada_por: textoProp(pr['Creada por']) || null,
                creada_en: pg.created_time,
            });
        }
        if (!resp.has_more) break;
        cursor = resp.next_cursor ?? undefined;
    }
    return out;
}

function destinoAccion(accion: string, p: Record<string, unknown>): { destino: string; resumen: string } {
    if (accion === 'enviar_correo') return { destino: String(p.nombreCliente ?? p.para ?? ''), resumen: String(p.asunto ?? '') };
    if (accion === 'enviar_whatsapp') return { destino: String(p.nombreCliente ?? p.nombreContacto ?? `+${p.waId ?? ''}`), resumen: String(p.cuerpo ?? '').slice(0, 80) };
    return { destino: '', resumen: accion };
}

export async function fotoNegocio(): Promise<FotoNegocio> {
    const ahora = Date.now();
    const hace = (ms: number) => new Date(ahora - ms).toISOString();

    const [acc, wa, correos, cots, clientes, provs, anal, tareas] = await Promise.all([
        supabase.from('acciones_pendientes').select('accion, payload, creado_en, asistentes(nombre)').eq('estado', 'pendiente').order('creado_en', { ascending: true }).limit(50),
        supabase.from('wa_conversaciones').select('nombre, wa_id, estado, ultimo_direccion, ultimo_entrante_en, ultimo_mensaje, clientes(nombre)').eq('estado', 'escalated'),
        supabase.from('correos_historicos').select('de_email, de_nombre, asunto, categoria, fecha, cliente_id').eq('direccion', 'entrante').eq('ignorable', false).gte('fecha', hace(3 * DIA_MS)).order('fecha', { ascending: false }).limit(200),
        supabase.from('cotizaciones').select('numero, numero_externo, titulo, total_usd, creado_en, items, estado, origen').gte('creado_en', hace(14 * DIA_MS)).order('creado_en', { ascending: false }).limit(30),
        supabase.from('clientes').select('nombre, estado, metadata, ultimo_contacto_en, intentos_contacto').limit(2000),
        supabase.from('proveedores').select('nombre, ultimo_estado, items_sincronizados, ultima_sync, activo').eq('activo', true),
        supabase.from('reportes_analitica').select('creado_en, periodo_desde, periodo_hasta, resumen_md, propuestas').order('creado_en', { ascending: false }).limit(1).maybeSingle(),
        tareasNotion(false).catch(() => [] as TareaNotion[]),
    ]);

    // Correos: ¿hubo respuesta nuestra después? (una consulta por correo relevante)
    const relevantes = (correos.data ?? []).filter((c) => ['consulta', 'cotizacion', 'queja', 'soporte'].includes(String(c.categoria ?? ''))).slice(0, 8);
    const respondidos = await Promise.all(relevantes.map(async (c) => {
        const { count } = await supabase.from('correos_historicos').select('id', { count: 'exact', head: true })
            .eq('direccion', 'saliente').ilike('para_email', `%${c.de_email}%`).gt('fecha', c.fecha);
        return (count ?? 0) > 0;
    }));
    const porCategoria: Record<string, number> = {};
    for (const c of correos.data ?? []) porCategoria[String(c.categoria ?? 'sin categoría')] = (porCategoria[String(c.categoria ?? 'sin categoría')] ?? 0) + 1;

    const convs = wa.data ?? [];
    const nombreWa = (c: (typeof convs)[number]) =>
        ((c as { clientes?: { nombre?: string } | null }).clientes?.nombre) ?? c.nombre ?? `+${c.wa_id}`;
    const sinResponder = convs.filter((c) => c.ultimo_direccion === 'cliente' && c.ultimo_entrante_en);
    const enVentana = sinResponder.filter((c) => ahora - new Date(c.ultimo_entrante_en as string).getTime() < DIA_MS);
    const vencidas = sinResponder.filter((c) => ahora - new Date(c.ultimo_entrante_en as string).getTime() >= DIA_MS);

    const cls = clientes.data ?? [];
    const porEstado: Record<string, number> = {};
    for (const c of cls) porEstado[String(c.estado ?? 'sin estado')] = (porEstado[String(c.estado ?? 'sin estado')] ?? 0) + 1;
    const leads = cls.filter((c) => c.estado === 'lead');
    const icp = (c: (typeof cls)[number]) => Number((c.metadata as { puntaje_icp?: number } | null)?.puntaje_icp ?? 0) || null;

    return {
        generado_en: new Date().toISOString(),
        acciones_pendientes: (acc.data ?? []).map((a) => {
            const d = destinoAccion(a.accion as string, (a.payload ?? {}) as Record<string, unknown>);
            return {
                tipo: a.accion as string,
                destino: d.destino,
                resumen: d.resumen,
                creada: a.creado_en as string,
                asistente: ((a as { asistentes?: { nombre?: string } | null }).asistentes?.nombre) ?? null,
            };
        }),
        whatsapp: {
            derivadas: convs.length,
            sin_responder_en_ventana: enVentana.map((c) => ({
                contacto: nombreWa(c),
                ultimo: String(c.ultimo_mensaje ?? '(sin texto)').slice(0, 120),
                hace_horas: Math.round((ahora - new Date(c.ultimo_entrante_en as string).getTime()) / 3600_000),
                vence: new Date(new Date(c.ultimo_entrante_en as string).getTime() + DIA_MS).toISOString(),
            })),
            sin_responder_vencidas: vencidas.slice(0, 10).map((c) => ({
                contacto: nombreWa(c),
                ultimo: String(c.ultimo_mensaje ?? '(sin texto)').slice(0, 120),
                dias: Math.floor((ahora - new Date(c.ultimo_entrante_en as string).getTime()) / DIA_MS),
            })),
        },
        correos_3_dias: {
            por_categoria: porCategoria,
            relevantes: relevantes.map((c, i) => ({
                de: String(c.de_nombre || c.de_email || ''),
                asunto: String(c.asunto ?? '(sin asunto)').slice(0, 100),
                categoria: c.categoria as string | null,
                fecha: c.fecha as string,
                respondido: respondidos[i] ?? false,
            })),
        },
        cotizaciones_14_dias: (cots.data ?? []).map((c) => ({
            numero: (c.numero_externo as string | null) ?? (c.numero ? `${new Date(c.creado_en as string).getFullYear()}-${String(c.numero).padStart(4, '0')}` : null),
            cliente: String(c.titulo ?? 'sin nombre'),
            total_usd: Number(c.total_usd ?? 0),
            fecha: c.creado_en as string,
            renglones: Array.isArray(c.items) ? c.items.length : 0,
            // 'abierta' = borrador del Cotizador: no cuenta como cotizado.
            estado: String(c.estado ?? 'abierta'),
            desde_documento: c.origen === 'documento',
        })),
        pipeline: {
            por_estado: porEstado,
            leads_calientes: leads.slice().sort((a, b) => (icp(b) ?? 0) - (icp(a) ?? 0)).slice(0, 6).map((c) => ({
                nombre: String(c.nombre),
                icp: icp(c),
                ultimo_contacto: (c.ultimo_contacto_en as string | null) ?? null,
                intentos: Number(c.intentos_contacto ?? 0),
            })),
            leads_sin_contacto_7d: leads.filter((c) => !c.ultimo_contacto_en || ahora - new Date(c.ultimo_contacto_en as string).getTime() > 7 * DIA_MS).length,
        },
        proveedores: (provs.data ?? []).map((p) => ({
            nombre: String(p.nombre),
            estado: (p.ultimo_estado as string | null) ?? null,
            articulos: (p.items_sincronizados as number | null) ?? null,
            ultima_sync: (p.ultima_sync as string | null) ?? null,
        })),
        analitica: anal.data ? {
            fecha: anal.data.creado_en as string,
            periodo: `${anal.data.periodo_desde} a ${anal.data.periodo_hasta}`,
            resumen: String(anal.data.resumen_md ?? '').slice(0, 1500),
            propuestas: ((anal.data.propuestas ?? []) as Array<{ titulo?: string }>).map((p) => String(p.titulo ?? '')).filter(Boolean).slice(0, 5),
        } : null,
        tareas_notion: tareas,
    };
}

// ====================================================================
// Bloques de Notion (helpers)
// ====================================================================

type Seg = string | { t: string; b?: boolean; link?: string; color?: string };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Bloque = any;

function rich(...segs: Seg[]) {
    return segs.filter((s) => (typeof s === 'string' ? s : s.t)).map((s) => {
        const seg = typeof s === 'string' ? { t: s } : s;
        return {
            type: 'text',
            text: { content: seg.t.slice(0, 1900), ...(seg.link ? { link: { url: seg.link } } : {}) },
            annotations: { bold: !!seg.b, color: (seg.color ?? 'default') as 'default' },
        };
    });
}
const h2 = (t: string): Bloque => ({ object: 'block', type: 'heading_2', heading_2: { rich_text: rich(t) } });
const p = (...s: Seg[]): Bloque => ({ object: 'block', type: 'paragraph', paragraph: { rich_text: rich(...s) } });
const li = (...s: Seg[]): Bloque => ({ object: 'block', type: 'bulleted_list_item', bulleted_list_item: { rich_text: rich(...s) } });
const num = (...s: Seg[]): Bloque => ({ object: 'block', type: 'numbered_list_item', numbered_list_item: { rich_text: rich(...s) } });
const callout = (emoji: string, color: string, ...s: Seg[]): Bloque => ({
    object: 'block', type: 'callout', callout: { rich_text: rich(...s), icon: { type: 'emoji', emoji }, color },
});
const divider = (): Bloque => ({ object: 'block', type: 'divider', divider: {} });
const gris = (t: string): Seg => ({ t, color: 'gray' });

// ====================================================================
// Tablero
// ====================================================================

// El Tablero ES la página principal de Bartez AI. Como la API de Notion no
// permite reordenar bloques, se usa un título fijo ("ancla"): el sistema
// borra y reescribe todo lo que no sea base de datos ni subpágina, y lo
// inserta justo debajo del ancla. El operador arrastra el ancla arriba de
// todo una sola vez y desde ahí el tablero queda primero.

const PRESERVAR = new Set(['child_database', 'child_page', 'link_to_page']);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function hijos(pageId: string): Promise<any[]> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out: any[] = [];
    let cursor: string | undefined;
    do {
        const r = await notion!.blocks.children.list({ block_id: pageId, page_size: 100, start_cursor: cursor });
        out.push(...r.results);
        cursor = r.has_more ? r.next_cursor ?? undefined : undefined;
    } while (cursor);
    return out;
}

// La primera vez: lo que había escrito en la página principal se copia a una
// subpágina de respaldo antes de reemplazarlo.
async function respaldarPortada(ancla: string | null): Promise<void> {
    if (await leerConfig('notion_raiz_respaldada')) return;
    const viejos = (await hijos(ROOT)).filter((b) => !PRESERVAR.has(b.type) && b.id !== ancla);
    if (viejos.length > 0) {
        const pg = await notion!.pages.create({
            parent: { type: 'page_id', page_id: ROOT },
            icon: { type: 'emoji', emoji: '🗄️' },
            properties: { title: { title: [{ type: 'text', text: { content: 'Portada anterior (respaldo)' } }] } },
        });
        const copias: Bloque[] = viejos.map((b) => {
            const c = b[b.type] ?? {};
            const texto = Array.isArray(c.rich_text) ? c.rich_text.map((r: { plain_text: string }) => r.plain_text).join('') : '';
            if (b.type === 'divider') return divider();
            const tipo = ['heading_1', 'heading_2', 'heading_3', 'paragraph', 'bulleted_list_item', 'numbered_list_item', 'quote'].includes(b.type) ? b.type : 'paragraph';
            return { object: 'block', type: tipo, [tipo]: { rich_text: rich(texto || ' ') } };
        });
        for (let k = 0; k < copias.length; k += 90) {
            await notion!.blocks.children.append({ block_id: pg.id, children: copias.slice(k, k + 90) });
        }
    }
    await guardarConfig('notion_raiz_respaldada', new Date().toISOString());
}

// El tablero de la versión anterior era una subpágina: se archiva.
async function archivarTableroViejo(): Promise<void> {
    const viejo = await leerConfig('notion_page_tablero');
    if (!viejo) return;
    await notion!.pages.update({ page_id: viejo, archived: true }).catch(() => undefined);
    await guardarConfig('notion_page_tablero', '');
}

async function asegurarAncla(): Promise<string> {
    const guardada = await leerConfig('notion_raiz_ancla');
    if (guardada) {
        try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const b = await notion!.blocks.retrieve({ block_id: guardada }) as any;
            if (!b.archived && !b.in_trash && sinGuiones(b.parent?.page_id ?? '') === sinGuiones(ROOT)) return guardada;
        } catch { /* se borró: se crea de nuevo */ }
    }
    const r = await notion!.blocks.children.append({
        block_id: ROOT,
        children: [{ object: 'block', type: 'heading_1', heading_1: { rich_text: [{ type: 'text', text: { content: '📊 Tablero Bartez' } }] } }],
    });
    const id = r.results[0]!.id;
    await guardarConfig('notion_raiz_ancla', id);
    return id;
}

async function prepararRaiz(): Promise<string> {
    if (!notion) throw new Error('Notion no configurado');
    await respaldarPortada(await leerConfig('notion_raiz_ancla'));
    await archivarTableroViejo();
    return asegurarAncla();
}

async function limpiarRaiz(ancla: string): Promise<void> {
    const ids = (await hijos(ROOT)).filter((b) => !PRESERVAR.has(b.type) && b.id !== ancla).map((b) => b.id as string);
    // De a 3 en paralelo: el límite de Notion es ~3 pedidos por segundo.
    for (let k = 0; k < ids.length; k += 3) {
        await Promise.all(ids.slice(k, k + 3).map((id) => notion!.blocks.delete({ block_id: id }).catch(() => undefined)));
    }
}

interface Prioridad { texto: string; por_que?: string }

export function armarTablero(f: FotoNegocio, prioridades: { fecha: string; items: Prioridad[] } | null, cambios: Array<{ creado_en: string; detalle: string }>): Bloque[] {
    const ids = idsNotion();
    const hoy = new Date().toLocaleDateString('en-CA', { timeZone: TZ });
    const b: Bloque[] = [];

    b.push(callout('🕒', 'gray_background',
        { t: `Actualizado ${fechaHora(f.generado_en)}`, b: true },
        ' · Bartez AI reescribe esta página sola cada 30 minutos (7 a 21 h). Lo que escribas acá se borra en la próxima actualización: usá subpáginas o las bases de datos.'));

    // Resumen rápido
    const tareasPend = f.tareas_notion.filter((t) => t.estado === 'pendiente');
    const vencidas = tareasPend.filter((t) => t.fecha_limite && t.fecha_limite < hoy);
    const deHoy = tareasPend.filter((t) => t.fecha_limite === hoy);
    const alertas: Seg[] = [];
    const sumar = (n: number, txt: string) => { if (n > 0) alertas.push({ t: `${n} ${txt}`, b: true }, '   '); };
    sumar(f.acciones_pendientes.length, `esperando tu aprobación`);
    sumar(f.whatsapp.sin_responder_en_ventana.length, `WhatsApp sin responder`);
    sumar(f.correos_3_dias.relevantes.filter((c) => !c.respondido).length, `correos sin respuesta`);
    sumar(vencidas.length, `tareas vencidas`);
    sumar(deHoy.length, `tareas para hoy`);
    b.push(alertas.length > 0
        ? callout('🔔', 'yellow_background', ...alertas)
        : callout('✅', 'green_background', { t: 'Nada urgente pendiente.', b: true }));

    // Prioridades del curador
    b.push(h2('🎯 Prioridades'));
    if (prioridades && prioridades.items.length > 0) {
        if (prioridades.fecha.slice(0, 10) !== hoy) b.push(p(gris(`Análisis del ${fechaHora(prioridades.fecha)} (todavía no hay uno de hoy).`)));
        for (const it of prioridades.items) b.push(num({ t: it.texto, b: true }, it.por_que ? gris(` — ${it.por_que}`) : ''));
    } else {
        b.push(p(gris('El asistente todavía no analizó el día. Corre a las 8:30, 13 y 18 h, o a pedido desde el panel.')));
    }

    // Aprobaciones
    b.push(h2(`⏳ Esperando tu aprobación (${f.acciones_pendientes.length})`));
    if (f.acciones_pendientes.length === 0) b.push(p(gris('Nada pendiente.')));
    for (const a of f.acciones_pendientes.slice(0, 10)) {
        const canal = a.tipo === 'enviar_whatsapp' ? 'WhatsApp' : a.tipo === 'enviar_correo' ? 'Correo' : a.tipo;
        b.push(li({ t: `${canal} → ${a.destino || '—'}`, b: true }, a.resumen ? ` · ${a.resumen}` : '', gris(` · desde ${fechaHora(a.creada)}`)));
    }
    if (f.acciones_pendientes.length > 10) b.push(p(gris(`…y ${f.acciones_pendientes.length - 10} más. Se aprueban en Bartez AI → Acciones.`)));

    // WhatsApp
    b.push(h2('💬 WhatsApp'));
    if (f.whatsapp.sin_responder_en_ventana.length === 0) b.push(p(gris('Ningún cliente esperando respuesta dentro de las 24 h.')));
    for (const w of f.whatsapp.sin_responder_en_ventana) {
        b.push(li({ t: w.contacto, b: true }, ` · "${w.ultimo}"`, gris(` · hace ${w.hace_horas} h · se puede responder hasta ${fechaHora(w.vence)}`)));
    }
    if (f.whatsapp.sin_responder_vencidas.length > 0) {
        b.push(p(gris(`Sin respuesta y con la ventana de 24 h vencida (solo plantilla): ${f.whatsapp.sin_responder_vencidas.map((w) => `${w.contacto} (${w.dias} d)`).join(', ')}.`)));
    }

    // Correos
    const cats = Object.entries(f.correos_3_dias.por_categoria).sort((a, c) => c[1] - a[1]);
    b.push(h2('📨 Correos de los últimos 3 días'));
    b.push(p(cats.length > 0 ? cats.map(([k, v]) => `${k}: ${v}`).join(' · ') : 'Sin correos entrantes relevantes.'));
    for (const c of f.correos_3_dias.relevantes) {
        b.push(li(c.respondido ? '✓ ' : { t: '● ', color: 'red' }, { t: c.de, b: true }, ` · ${c.asunto}`, gris(` · ${c.categoria ?? ''} · ${fechaHora(c.fecha)}${c.respondido ? ' · respondido' : ' · sin respuesta'}`)));
    }

    // Cotizaciones
    b.push(h2('💰 Cotizaciones de las últimas 2 semanas'));
    if (f.cotizaciones_14_dias.length === 0) b.push(p(gris('Sin cotizaciones.')));
    for (const c of f.cotizaciones_14_dias.slice(0, 12)) {
        b.push(li({ t: c.cliente, b: true }, ` · ${usd(c.total_usd)}`, gris(` · ${c.desde_documento ? 'PDF subido a la ficha' : `${c.renglones} renglones`} · ${fechaCorta(c.fecha)}${c.numero ? ` · N ${c.numero}` : ' · sin PDF'}`)));
    }

    // Tareas
    b.push(h2(`✅ Tareas pendientes (${tareasPend.length})`));
    const orden = tareasPend.slice().sort((a, c) => (a.fecha_limite ?? '9999').localeCompare(c.fecha_limite ?? '9999'));
    if (orden.length === 0) b.push(p(gris('No hay tareas pendientes.')));
    for (const t of orden.slice(0, 15)) {
        const vence = t.fecha_limite ? (t.fecha_limite < hoy ? { t: ` · venció ${fechaCorta(t.fecha_limite)}`, color: 'red' } : t.fecha_limite === hoy ? { t: ' · hoy', color: 'orange' } : gris(` · ${fechaCorta(t.fecha_limite)}`)) : gris(' · sin fecha');
        b.push(li({ t: t.titulo || '(sin título)', b: true, link: notionUrl(t.id) }, t.cliente ? ` · ${t.cliente}` : '', vence));
    }
    if (ids.tareas) b.push(p({ t: 'Ver todas las tareas →', link: notionUrl(ids.tareas) }));

    // Pipeline
    const pe = f.pipeline.por_estado;
    b.push(h2('🧭 Pipeline'));
    b.push(p(`Leads: ${pe.lead ?? 0} · Clientes: ${pe.cliente ?? 0} · Inactivos: ${pe.inactivo ?? 0} · Descartados: ${pe.descartado ?? 0} · Leads sin contacto hace más de 7 días: ${f.pipeline.leads_sin_contacto_7d}`));
    for (const l of f.pipeline.leads_calientes) {
        b.push(li({ t: l.nombre, b: true }, l.icp ? ` · ICP ${l.icp}/10` : '', gris(` · último contacto: ${l.ultimo_contacto ? fechaCorta(l.ultimo_contacto) : 'nunca'} · ${l.intentos} intentos`)));
    }
    if (ids.prospectos) b.push(p({ t: 'Ver todos los prospectos →', link: notionUrl(ids.prospectos) }));

    // Proveedores
    b.push(h2('📦 Listas de proveedores'));
    for (const pr of f.proveedores) {
        b.push(li({ t: pr.nombre, b: true }, ` · ${pr.estado === 'ok' ? `${pr.articulos ?? 0} artículos` : (pr.estado ?? 'sin sincronizar')}`, gris(pr.ultima_sync ? ` · actualizada ${fechaHora(pr.ultima_sync)}` : '')));
    }

    // Analítica
    if (f.analitica) {
        b.push(h2('📈 Último informe de Analítica'));
        b.push(p(gris(`Período ${f.analitica.periodo}`)));
        for (const pr of f.analitica.propuestas) b.push(li(pr));
    }

    // Cambios del asistente
    b.push(h2('🤖 Lo último que hizo el asistente en Notion'));
    if (cambios.length === 0) b.push(p(gris('Todavía no hizo cambios.')));
    for (const c of cambios) b.push(li(gris(`${fechaHora(c.creado_en)} · `), c.detalle));

    b.push(divider());
    b.push(p(gris('Bartez AI · datos exactos del sistema; las prioridades las decide el asistente de Notion. Las bases de datos y subpáginas de esta página no se tocan.')));
    return b;
}

let actualizandoTablero = false;

export async function actualizarTablero(): Promise<{ ok: boolean; url?: string; bloques?: number; detalle?: string }> {
    if (!notionConfigurado || !notion) return { ok: false, detalle: 'Notion no configurado' };
    if (actualizandoTablero) return { ok: false, detalle: 'Ya se está actualizando' };
    actualizandoTablero = true;
    try {
        const [ancla, foto, prioRaw, cambios] = await Promise.all([
            prepararRaiz(),
            fotoNegocio(),
            leerConfig('notion_prioridades'),
            supabase.from('notion_cambios').select('creado_en, detalle').order('creado_en', { ascending: false }).limit(10),
        ]);
        let prioridades: { fecha: string; items: Prioridad[] } | null = null;
        try { prioridades = prioRaw ? JSON.parse(prioRaw) : null; } catch { prioridades = null; }
        const bloques = armarTablero(foto, prioridades, (cambios.data ?? []) as Array<{ creado_en: string; detalle: string }>);
        await limpiarRaiz(ancla);
        // Se inserta debajo del ancla, en orden, lote por lote.
        let despues = ancla;
        for (let i = 0; i < bloques.length; i += 90) {
            const r = await notion.blocks.children.append({ block_id: ROOT, children: bloques.slice(i, i + 90), after: despues });
            despues = r.results[r.results.length - 1]?.id ?? despues;
        }
        await guardarConfig('notion_tablero_actualizado', new Date().toISOString());
        return { ok: true, url: notionUrl(ROOT), bloques: bloques.length };
    } catch (err) {
        return { ok: false, detalle: (err as Error).message };
    } finally {
        actualizandoTablero = false;
    }
}

// ====================================================================
// Curador (agente con decisión propia)
// ====================================================================

const PROMPT_CURADOR = `Sos el asistente de Notion de Bartez Tecnología (distribuidor mayorista de IT,
Rosario). Trabajás solo, con decisión propia: tu trabajo es que cuando el
dueño entre a Notion encuentre todo claro, al día y sin ruido.

Recibís la FOTO DEL NEGOCIO: lo que generaron los demás asistentes (correos,
WhatsApp, cotizaciones, prospección, seguimientos, analítica, proveedores) y
las tareas que hay hoy en Notion.

Qué decidís y hacés vos:
1. TAREAS (database Tareas): creá las que falten para que nada se pierda, con
   título accionable ("Responder a X por Y", "Llamar a X por la cotización
   N°…"), cliente, fecha límite realista y contexto breve con el porqué.
   Casos típicos: WhatsApp sin responder, correos de consulta/cotización/queja
   sin respuesta, cotizaciones sin novedad hace varios días, leads calientes
   sin contacto, acciones esperando aprobación hace más de un día.
   - Antes de crear, revisá las existentes: NO dupliques (mismo cliente y
     mismo motivo = misma tarea; actualizala en vez de crear otra).
   - Marcá "hecha" las que ya están resueltas según la foto (por ejemplo, el
     correo ya fue respondido o el WhatsApp ya tiene respuesta de Bartez).
   - Marcá "cancelada" las que perdieron sentido. Ajustá fechas vencidas si
     siguen vigentes.
2. NOTAS (database Notas de casos): creá una nota solo si hay una situación
   que conviene tener documentada (queja, negociación grande, problema con
   un proveedor). No hagas notas de rutina.
3. PRIORIDADES: al final, definí de 3 a 6 prioridades concretas para hoy,
   ordenadas por impacto en ventas. Van al Tablero, que es la página
   principal de Bartez AI y la escribe el sistema (vos no la modificás).

Límites:
- Prospectos es de solo lectura (lo sincroniza Bartez AI).
- No borres: archivá (se puede recuperar). Hacé como mucho 20 cambios por
  corrida; si hay más, priorizá lo más importante.
- No inventes datos: todo tiene que salir de la foto o de lo que leas en Notion.
- Español rioplatense, directo, sin relleno.

Cuando termines, respondé SOLO con:
<prioridades>[{"texto": "…", "por_que": "…"}]</prioridades>
<resumen>1-3 líneas de qué cambiaste</resumen>`;

const TOOLS_CURADOR: Anthropic.Tool[] = [
    {
        name: 'notion_leer_pagina',
        description: 'Lee los bloques de una página (sin page_id: la página raíz). Devuelve id, tipo y texto de cada bloque.',
        input_schema: { type: 'object', properties: { page_id: { type: 'string' } } },
    },
    {
        name: 'notion_crear_tarea',
        description: 'Crea una tarea en el database Tareas.',
        input_schema: {
            type: 'object',
            properties: {
                titulo: { type: 'string' },
                cliente: { type: 'string' },
                fecha_limite: { type: 'string', description: 'AAAA-MM-DD' },
                contexto: { type: 'string', description: 'Por qué existe la tarea y qué hay que hacer (máx. 3 líneas).' },
            },
            required: ['titulo', 'contexto'],
        },
    },
    {
        name: 'notion_actualizar_tarea',
        description: 'Actualiza una tarea existente (id de la foto o de notion_leer_pagina). Pasá solo lo que cambia.',
        input_schema: {
            type: 'object',
            properties: {
                tarea_id: { type: 'string' },
                estado: { type: 'string', enum: ['pendiente', 'hecha', 'cancelada'] },
                fecha_limite: { type: 'string', description: 'AAAA-MM-DD' },
                titulo: { type: 'string' },
                contexto: { type: 'string' },
                motivo: { type: 'string', description: 'Por qué la cambiás (queda en el registro).' },
            },
            required: ['tarea_id', 'motivo'],
        },
    },
    {
        name: 'notion_crear_nota',
        description: 'Crea una nota en el database Notas de casos.',
        input_schema: {
            type: 'object',
            properties: {
                titulo: { type: 'string' },
                cliente: { type: 'string' },
                categoria: { type: 'string', enum: ['queja', 'cotizacion_detalle', 'soporte', 'otro'] },
                contexto: { type: 'string' },
            },
            required: ['titulo', 'categoria', 'contexto'],
        },
    },
    {
        name: 'notion_archivar',
        description: 'Archiva una fila de Tareas o Notas (duplicada o sin sentido). Se puede recuperar desde la papelera de Notion.',
        input_schema: { type: 'object', properties: { page_id: { type: 'string' }, motivo: { type: 'string' } }, required: ['page_id', 'motivo'] },
    },
];

// Solo filas de Tareas o Notas.
async function filaPermitida(pageId: string): Promise<'tareas' | 'notas'> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pg = await notion!.pages.retrieve({ page_id: pageId }) as any;
    const db = sinGuiones(pg.parent?.database_id ?? '');
    const ids = idsNotion();
    if (ids.tareas && db === sinGuiones(ids.tareas)) return 'tareas';
    if (ids.notas && db === sinGuiones(ids.notas)) return 'notas';
    throw new Error('Solo se pueden modificar filas de Tareas o Notas');
}

interface Cambio { tipo: string; detalle: string; pagina_id?: string }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function ejecutarToolCurador(nombre: string, e: any, cambios: Cambio[]): Promise<string> {
    if (!notion) throw new Error('Notion no configurado');
    const ids = idsNotion();
    const tope = () => { if (cambios.length >= 20) throw new Error('Llegaste al máximo de 20 cambios en esta corrida'); };

    if (nombre === 'notion_leer_pagina') {
        const pageId = e.page_id || ROOT;
        const r = await notion.blocks.children.list({ block_id: pageId, page_size: 100 });
        return JSON.stringify(r.results.map((blk) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const a = blk as any;
            const c = a[a.type] ?? {};
            const texto = Array.isArray(c.rich_text) ? c.rich_text.map((x: { plain_text: string }) => x.plain_text).join('') : (c.title ?? '');
            return { id: a.id, tipo: a.type, texto: String(texto).slice(0, 200) };
        }));
    }

    if (nombre === 'notion_crear_tarea') {
        tope();
        if (!ids.tareas) throw new Error('No existe el database Tareas');
        const pg = await notion.pages.create({
            parent: { database_id: ids.tareas },
            properties: {
                'Título': { title: [{ text: { content: String(e.titulo).slice(0, 200) } }] },
                'Cliente': { rich_text: e.cliente ? [{ text: { content: String(e.cliente).slice(0, 200) } }] : [] },
                'Estado': { select: { name: 'pendiente' } },
                'Contexto': { rich_text: [{ text: { content: String(e.contexto ?? '').slice(0, 1900) } }] },
                'Creada por': { select: { name: 'asistente' } },
                ...(e.fecha_limite ? { 'Fecha límite': { date: { start: String(e.fecha_limite).slice(0, 10) } } } : {}),
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            } as any,
        });
        cambios.push({ tipo: 'crear_tarea', detalle: `Nueva tarea: ${e.titulo}${e.cliente ? ` (${e.cliente})` : ''}`, pagina_id: pg.id });
        return JSON.stringify({ ok: true, id: pg.id });
    }

    if (nombre === 'notion_actualizar_tarea') {
        tope();
        if ((await filaPermitida(e.tarea_id)) !== 'tareas') throw new Error('No es una tarea');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const props: any = {};
        if (e.estado) props['Estado'] = { select: { name: e.estado } };
        if (e.fecha_limite) props['Fecha límite'] = { date: { start: String(e.fecha_limite).slice(0, 10) } };
        if (e.titulo) props['Título'] = { title: [{ text: { content: String(e.titulo).slice(0, 200) } }] };
        if (e.contexto) props['Contexto'] = { rich_text: [{ text: { content: String(e.contexto).slice(0, 1900) } }] };
        await notion.pages.update({ page_id: e.tarea_id, properties: props });
        const que = e.estado === 'hecha' ? 'Marqué como hecha' : e.estado === 'cancelada' ? 'Cancelé' : 'Actualicé';
        cambios.push({ tipo: 'actualizar_tarea', detalle: `${que} una tarea${e.titulo ? `: ${e.titulo}` : ''} (${e.motivo})`, pagina_id: e.tarea_id });
        return '{"ok":true}';
    }

    if (nombre === 'notion_crear_nota') {
        tope();
        if (!ids.notas) throw new Error('No existe el database Notas');
        const pg = await notion.pages.create({
            parent: { database_id: ids.notas },
            properties: {
                'Título': { title: [{ text: { content: String(e.titulo).slice(0, 200) } }] },
                'Cliente': { rich_text: e.cliente ? [{ text: { content: String(e.cliente).slice(0, 200) } }] : [] },
                'Categoría': { select: { name: e.categoria } },
                'Fecha': { date: { start: new Date().toISOString().slice(0, 10) } },
                'Contexto': { rich_text: [{ text: { content: String(e.contexto ?? '').slice(0, 1900) } }] },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            } as any,
        });
        cambios.push({ tipo: 'crear_nota', detalle: `Nueva nota: ${e.titulo}`, pagina_id: pg.id });
        return JSON.stringify({ ok: true, id: pg.id });
    }

    if (nombre === 'notion_archivar') {
        tope();
        const cual = await filaPermitida(e.page_id);
        await notion.pages.update({ page_id: e.page_id, archived: true });
        cambios.push({ tipo: 'archivar', detalle: `Archivé una ${cual === 'tareas' ? 'tarea' : 'nota'} (${e.motivo})`, pagina_id: e.page_id });
        return '{"ok":true}';
    }

    throw new Error(`tool desconocida: ${nombre}`);
}

export interface ResultadoCurador {
    ok: boolean;
    resumen: string;
    prioridades: Prioridad[];
    cambios: number;
    costo_usd: number;
    duracion_ms: number;
    tablero_url?: string;
    detalle?: string;
}

let curando = false;

export async function correrCurador(opts: { instruccion?: string } = {}): Promise<ResultadoCurador> {
    const inicio = Date.now();
    const vacio = (detalle: string): ResultadoCurador => ({ ok: false, resumen: '', prioridades: [], cambios: 0, costo_usd: 0, duracion_ms: Date.now() - inicio, detalle });
    if (!notionConfigurado || !notion) return vacio('Notion no configurado');
    if (curando) return vacio('El asistente de Notion ya está trabajando');
    curando = true;
    const corridaId = `c${Date.now()}`;
    const cambios: Cambio[] = [];
    try {
        const [foto, filaAsist] = await Promise.all([
            fotoNegocio(),
            supabase.from('asistentes').select('id, modelo, activo').eq('area', 'notion').maybeSingle(),
        ]);
        if (filaAsist.data && filaAsist.data.activo === false) return vacio('El asistente de Notion está desactivado');
        const modelo = ((filaAsist.data?.modelo as ModeloClaude | undefined) ?? 'sonnet');

        const consigna = [
            `FOTO DEL NEGOCIO (${fechaHora(foto.generado_en)}):`,
            '```json',
            JSON.stringify(foto, null, 1).slice(0, 60_000),
            '```',
            `Página principal (es el Tablero, la escribe el sistema): ${ROOT}.`,
            opts.instruccion?.trim() ? `\nPEDIDO PUNTUAL DEL DUEÑO (priorizalo): ${opts.instruccion.trim().slice(0, 1500)}` : '',
            '\nHacé tu trabajo y terminá con <prioridades> y <resumen>.',
        ].join('\n');

        const mensajes: Anthropic.MessageParam[] = [{ role: 'user', content: consigna }];
        let tokensIn = 0, tokensOut = 0, texto = '';
        for (let i = 0; i < 25; i++) {
            const resp = await anthropic.messages.create({
                model: idModelo(modelo),
                max_tokens: 4096,
                system: `${PROMPT_CURADOR}\n\n${contextoFecha()}`,
                tools: TOOLS_CURADOR,
                messages: mensajes,
            });
            tokensIn += resp.usage.input_tokens;
            tokensOut += resp.usage.output_tokens;
            mensajes.push({ role: 'assistant', content: resp.content });
            const usos = resp.content.filter((c): c is Anthropic.ToolUseBlock => c.type === 'tool_use');
            texto = resp.content.filter((c): c is Anthropic.TextBlock => c.type === 'text').map((c) => c.text).join('\n');
            if (usos.length === 0) break;
            const resultados: Anthropic.ToolResultBlockParam[] = [];
            for (const u of usos) {
                try {
                    resultados.push({ type: 'tool_result', tool_use_id: u.id, content: await ejecutarToolCurador(u.name, u.input, cambios) });
                } catch (err) {
                    resultados.push({ type: 'tool_result', tool_use_id: u.id, content: `ERROR: ${(err as Error).message}`, is_error: true });
                }
            }
            mensajes.push({ role: 'user', content: resultados });
        }

        let prioridades: Prioridad[] = [];
        const mp = /<prioridades>([\s\S]*?)<\/prioridades>/i.exec(texto);
        if (mp) {
            try {
                const arr = JSON.parse((mp[1] ?? '').trim());
                if (Array.isArray(arr)) prioridades = arr.filter((x) => typeof x?.texto === 'string').slice(0, 6);
            } catch { /* se ignora */ }
        }
        const resumen = (/<resumen>([\s\S]*?)<\/resumen>/i.exec(texto)?.[1] ?? '').trim() || `${cambios.length} cambios.`;

        if (prioridades.length > 0) await guardarConfig('notion_prioridades', JSON.stringify({ fecha: new Date().toISOString(), items: prioridades }));
        if (cambios.length > 0) {
            await supabase.from('notion_cambios').insert(cambios.map((c) => ({
                origen: opts.instruccion ? 'pedido' : 'curador', tipo: c.tipo, detalle: c.detalle.slice(0, 500), pagina_id: c.pagina_id ?? null, corrida_id: corridaId,
            })));
        }
        const costo = calcularCosto(modelo, tokensIn, tokensOut);
        if (filaAsist.data?.id) {
            await supabase.from('logs_asistente').insert({
                asistente_id: filaAsist.data.id,
                entrada: { origen: 'curador_notion', instruccion: opts.instruccion ?? null },
                salida: { resumen, prioridades, cambios },
                tokens_in: tokensIn, tokens_out: tokensOut, costo_usd: costo, duracion_ms: Date.now() - inicio,
            });
        }
        await guardarConfig('notion_curador_ultimo', JSON.stringify({ fecha: new Date().toISOString(), resumen, cambios: cambios.length }));

        curando = false;
        const t = await actualizarTablero();
        return { ok: true, resumen, prioridades, cambios: cambios.length, costo_usd: costo, duracion_ms: Date.now() - inicio, tablero_url: t.url };
    } catch (err) {
        // Lo que alcanzó a hacer antes del error también queda registrado.
        if (cambios.length > 0) {
            await supabase.from('notion_cambios').insert(cambios.map((c) => ({ origen: 'curador', tipo: c.tipo, detalle: c.detalle.slice(0, 500), pagina_id: c.pagina_id ?? null, corrida_id: corridaId })));
        }
        return vacio((err as Error).message);
    } finally {
        curando = false;
    }
}

export async function estadoNotionAutonomo() {
    const [act, cur, prio, cambios] = await Promise.all([
        leerConfig('notion_tablero_actualizado'),
        leerConfig('notion_curador_ultimo'),
        leerConfig('notion_prioridades'),
        supabase.from('notion_cambios').select('creado_en, origen, tipo, detalle, pagina_id').order('creado_en', { ascending: false }).limit(30),
    ]);
    const parse = (s: string | null) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
    return {
        configurado: notionConfigurado,
        tablero_url: ROOT ? notionUrl(ROOT) : null,
        tablero_actualizado: act,
        curador: parse(cur),
        prioridades: parse(prio),
        cambios: (cambios.data ?? []).map((c) => ({ ...c, url: c.pagina_id ? notionUrl(c.pagina_id as string) : null })),
    };
}
