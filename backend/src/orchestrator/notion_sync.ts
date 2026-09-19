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

// ---------- Notas de casos ----------

export interface NotaNueva {
    titulo: string;
    categoria: 'queja' | 'cotizacion_detalle' | 'soporte' | 'otro';
    contexto: string;
    cliente?: string;
    fecha?: string; // ISO date, default hoy
}

export async function crearNotaEnNotion(n: NotaNueva): Promise<void> {
    if (!notionConfigurado || !notion) return;
    const dbId = idsNotion().notas;
    if (!dbId) return;
    try {
        await notion.pages.create({
            parent: { database_id: dbId },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            properties: {
                'Título': { title: [{ text: { content: n.titulo.slice(0, 200) } }] },
                'Cliente': { rich_text: chunkText(n.cliente) },
                'Fecha': { date: { start: n.fecha ?? new Date().toISOString().slice(0, 10) } },
                'Categoría': { select: { name: n.categoria } },
                'Contexto': { rich_text: chunkText(n.contexto) },
            } as any,
        });
    } catch (err) {
        console.warn('[notion-sync] crear nota falló:', (err as Error).message);
    }
}

// ---------- Catálogo (Fase 3D — bidireccional) ----------

// El operador crea el DB Catálogo manualmente en Notion y registra su ID.
// Bartez lo consulta cuando el asistente Correo redacta una cotización.

export async function guardarCatalogoDbId(dbId: string): Promise<void> {
    await supabase.from('integraciones_config').upsert({
        clave: 'notion_db_catalogo',
        valor: dbId,
        actualizado_en: new Date().toISOString(),
    });
}

export async function catalogoDbId(): Promise<string | null> {
    const { data } = await supabase
        .from('integraciones_config')
        .select('valor')
        .eq('clave', 'notion_db_catalogo')
        .maybeSingle();
    return (data?.valor as string | undefined) ?? null;
}

export interface ItemCatalogo {
    nombre: string;
    detalle: string;
}

// Busca en el catálogo los items cuyo título/rich_text matchean algún término.
// Retorna máximo N items. Best-effort: si no hay catálogo configurado o falla,
// devuelve array vacío.
export async function buscarEnCatalogo(terminos: string[], limite = 8): Promise<ItemCatalogo[]> {
    if (!notionConfigurado || !notion) return [];
    const dbId = await catalogoDbId();
    if (!dbId || terminos.length === 0) return [];

    try {
        // Filtro OR sobre título de cada término. Notion no tiene "text search"
        // completo, así que hacemos filtro por "title contains" por cada término.
        const filtros = terminos.slice(0, 5).map((t) => ({
            property: 'Nombre',
            title: { contains: t.slice(0, 60) },
        }));
        const resp = await notion.databases.query({
            database_id: dbId,
            filter: filtros.length === 1 ? filtros[0] : { or: filtros },
            page_size: limite,
        });
        return resp.results.map((p) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const props = (p as any).properties ?? {};
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const nombre = props['Nombre']?.title?.map((r: any) => r.plain_text).join('') ?? '';
            // Concatenar el resto de propiedades como "detalle" (marca, precio, stock, notas...)
            const partes: string[] = [];
            for (const [k, v] of Object.entries(props)) {
                if (k === 'Nombre') continue;
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const anyV = v as any;
                let valor: string | number | null = null;
                if (anyV.type === 'rich_text') valor = anyV.rich_text?.map((r: { plain_text: string }) => r.plain_text).join('') ?? '';
                else if (anyV.type === 'number') valor = anyV.number ?? null;
                else if (anyV.type === 'select') valor = anyV.select?.name ?? null;
                else if (anyV.type === 'multi_select') valor = anyV.multi_select?.map((s: { name: string }) => s.name).join(', ') ?? '';
                else if (anyV.type === 'checkbox') valor = anyV.checkbox ? 'sí' : 'no';
                if (valor !== null && valor !== '') partes.push(`${k}: ${valor}`);
            }
            return { nombre, detalle: partes.join(' · ').slice(0, 400) };
        }).filter((i) => i.nombre.length > 0);
    } catch (err) {
        console.warn('[notion-sync] buscar catálogo falló:', (err as Error).message);
        return [];
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
