// Sync de prospectos entre Supabase (fuente de verdad) y Notion.
// Todo el sync es "best effort" — si Notion falla, se loguea y sigue de largo:
// nunca romper el flujo de negocio por un problema del sync.

import { chunkText, idsNotion, notion, notionConfigurado } from '../connectors/notion.js';
import { supabase } from '../connectors/supabase.js';

interface ClienteRow {
    id: string;
    nombre: string;
    email: string | null;
    estado: 'lead' | 'cliente' | 'inactivo' | 'descartado';
    intentos_contacto: number | null;
    ultimo_contacto_en: string | null;
    notion_page_id: string | null;
    metadata: {
        sitio_web?: string;
        senial?: string;
        razon_prospeccion?: string;
        puntaje_icp?: number;
    } | null;
}

function propsProspecto(c: ClienteRow) {
    return {
        'Nombre': { title: [{ text: { content: c.nombre.slice(0, 200) } }] },
        'Email': { email: c.email || null },
        'Sitio web': { url: c.metadata?.sitio_web || null },
        'Estado': { select: { name: c.estado } },
        'ICP': { number: c.metadata?.puntaje_icp ?? null },
        'Señal': { rich_text: chunkText(c.metadata?.senial) },
        'Encaje': { rich_text: chunkText(c.metadata?.razon_prospeccion) },
        'Intentos contacto': { number: c.intentos_contacto ?? 0 },
        'Último contacto': c.ultimo_contacto_en ? { date: { start: c.ultimo_contacto_en } } : { date: null },
        'Origen': { select: { name: 'prospeccion' } },
        'ID Supabase': { rich_text: [{ text: { content: c.id } }] },
    };
}

// Crea la página en Notion para un cliente nuevo. Guarda notion_page_id en Supabase.
export async function crearProspectoEnNotion(clienteId: string): Promise<void> {
    if (!notionConfigurado || !notion) return;
    const dbId = idsNotion().prospectos;
    if (!dbId) return;

    try {
        const { data: c } = await supabase.from('clientes').select('*').eq('id', clienteId).maybeSingle();
        if (!c) return;
        const cliente = c as ClienteRow;
        if (cliente.notion_page_id) return; // ya está sincronizado

        const page = await notion.pages.create({
            parent: { database_id: dbId },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            properties: propsProspecto(cliente) as any,
        });
        await supabase.from('clientes').update({ notion_page_id: page.id }).eq('id', clienteId);
    } catch (err) {
        console.warn('[notion-sync] crear prospecto falló:', (err as Error).message);
    }
}

// Actualiza la página existente. Si no hay notion_page_id, la crea.
export async function actualizarProspectoEnNotion(clienteId: string): Promise<void> {
    if (!notionConfigurado || !notion) return;
    const dbId = idsNotion().prospectos;
    if (!dbId) return;

    try {
        const { data: c } = await supabase.from('clientes').select('*').eq('id', clienteId).maybeSingle();
        if (!c) return;
        const cliente = c as ClienteRow;

        if (!cliente.notion_page_id) {
            await crearProspectoEnNotion(clienteId);
            return;
        }

        await notion.pages.update({
            page_id: cliente.notion_page_id,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            properties: propsProspecto(cliente) as any,
        });
    } catch (err) {
        console.warn('[notion-sync] update prospecto falló:', (err as Error).message);
    }
}

// ---------- Tareas ----------

export interface TareaNueva {
    titulo: string;
    fecha_limite?: string | null; // ISO date (YYYY-MM-DD) o null
    contexto?: string;
    cliente?: string; // nombre del cliente asociado
}

export async function crearTareaEnNotion(t: TareaNueva): Promise<void> {
    if (!notionConfigurado || !notion) return;
    const dbId = idsNotion().tareas;
    if (!dbId) return;

    try {
        await notion.pages.create({
            parent: { database_id: dbId },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            properties: {
                'Título': { title: [{ text: { content: t.titulo.slice(0, 200) } }] },
                'Cliente': { rich_text: chunkText(t.cliente) },
                'Fecha límite': t.fecha_limite ? { date: { start: t.fecha_limite } } : { date: null },
                'Estado': { select: { name: 'pendiente' } },
                'Contexto': { rich_text: chunkText(t.contexto) },
                'Creada por': { select: { name: 'correo' } },
            } as any,
        });
    } catch (err) {
        console.warn('[notion-sync] crear tarea falló:', (err as Error).message);
    }
}

// Bulk: sincroniza a Notion todos los clientes prospeccion que no tienen notion_page_id.
// Útil como backfill después de configurar Notion por primera vez.
export async function backfillProspectosANotion(): Promise<{ creados: number; errores: number }> {
    if (!notionConfigurado || !notion) return { creados: 0, errores: 0 };
    const dbId = idsNotion().prospectos;
    if (!dbId) return { creados: 0, errores: 0 };

    const { data: pendientes } = await supabase
        .from('clientes')
        .select('id')
        .eq('origen', 'prospeccion')
        .is('notion_page_id', null)
        .limit(100);

    let creados = 0;
    let errores = 0;
    for (const p of (pendientes ?? []) as { id: string }[]) {
        try {
            await crearProspectoEnNotion(p.id);
            creados++;
        } catch {
            errores++;
        }
    }
    return { creados, errores };
}
