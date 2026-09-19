// Cliente + helpers de Notion.
//
// Uso:
// - En .env: NOTION_TOKEN=secret_..., NOTION_PARENT_PAGE_ID=<page id>
// - Al arrancar el server, llamamos a bootstrapNotion() para asegurar que existan
//   los databases de Bartez (Prospectos, Tareas, Notas). Sus IDs se guardan en
//   la tabla integraciones_config para no re-crearlos en cada reinicio.
// - El sync de prospectos vive en un módulo aparte (orchestrator/notion_sync.ts).

import { Client, isFullPage } from '@notionhq/client';
import { supabase } from './supabase.js';

const token = process.env.NOTION_TOKEN ?? '';
const parentPageId = process.env.NOTION_PARENT_PAGE_ID ?? '';

export const notionConfigurado = Boolean(token && parentPageId);

export const notion = notionConfigurado ? new Client({ auth: token }) : null;

// IDs de databases en cache (cargados por bootstrapNotion).
interface NotionDbIds {
    prospectos?: string;
    tareas?: string;
    notas?: string;
}

const dbIds: NotionDbIds = {};

export function idsNotion(): NotionDbIds {
    return { ...dbIds };
}

// Bootstrap: crea (o encuentra) los 3 databases y guarda sus IDs en Supabase.
// Idempotente: si ya están, solo carga los IDs de la DB.
export async function bootstrapNotion(): Promise<{ ok: boolean; detalle: string; ids?: NotionDbIds }> {
    if (!notionConfigurado || !notion) {
        return { ok: false, detalle: 'NOTION_TOKEN o NOTION_PARENT_PAGE_ID no configurados' };
    }

    // Cargar IDs guardados
    const { data: configs } = await supabase
        .from('integraciones_config')
        .select('clave, valor')
        .in('clave', ['notion_db_prospectos', 'notion_db_tareas', 'notion_db_notas']);
    for (const c of configs ?? []) {
        if (c.clave === 'notion_db_prospectos') dbIds.prospectos = c.valor;
        if (c.clave === 'notion_db_tareas') dbIds.tareas = c.valor;
        if (c.clave === 'notion_db_notas') dbIds.notas = c.valor;
    }

    // Crear los que falten
    try {
        if (!dbIds.prospectos) {
            const db = await crearDatabaseProspectos();
            dbIds.prospectos = db.id;
            await guardarConfig('notion_db_prospectos', db.id);
        }
        if (!dbIds.tareas) {
            const db = await crearDatabaseTareas();
            dbIds.tareas = db.id;
            await guardarConfig('notion_db_tareas', db.id);
        }
        if (!dbIds.notas) {
            const db = await crearDatabaseNotas();
            dbIds.notas = db.id;
            await guardarConfig('notion_db_notas', db.id);
        }
    } catch (err) {
        return { ok: false, detalle: `Error creando databases: ${(err as Error).message}` };
    }

    return { ok: true, detalle: 'Notion listo', ids: dbIds };
}

async function guardarConfig(clave: string, valor: string): Promise<void> {
    await supabase.from('integraciones_config').upsert({ clave, valor, actualizado_en: new Date().toISOString() });
}

async function crearDatabaseProspectos() {
    return notion!.databases.create({
        parent: { type: 'page_id', page_id: parentPageId },
        title: [{ type: 'text', text: { content: 'Prospectos — Bartez AI' } }],
        properties: {
            'Nombre': { title: {} },
            'Email': { email: {} },
            'Sitio web': { url: {} },
            'Estado': {
                select: {
                    options: [
                        { name: 'lead', color: 'blue' },
                        { name: 'cliente', color: 'green' },
                        { name: 'inactivo', color: 'gray' },
                        { name: 'descartado', color: 'red' },
                    ],
                },
            },
            'ICP': { number: { format: 'number' } },
            'Señal': { rich_text: {} },
            'Encaje': { rich_text: {} },
            'Intentos contacto': { number: { format: 'number' } },
            'Último contacto': { date: {} },
            'Origen': { select: { options: [{ name: 'prospeccion', color: 'purple' }, { name: 'manual', color: 'default' }] } },
            'ID Supabase': { rich_text: {} },
        },
    });
}

async function crearDatabaseTareas() {
    return notion!.databases.create({
        parent: { type: 'page_id', page_id: parentPageId },
        title: [{ type: 'text', text: { content: 'Tareas — Bartez AI' } }],
        properties: {
            'Título': { title: {} },
            'Cliente': { rich_text: {} },
            'Fecha límite': { date: {} },
            'Estado': {
                select: {
                    options: [
                        { name: 'pendiente', color: 'yellow' },
                        { name: 'hecha', color: 'green' },
                        { name: 'cancelada', color: 'gray' },
                    ],
                },
            },
            'Contexto': { rich_text: {} },
            'Creada por': { select: { options: [{ name: 'correo', color: 'blue' }, { name: 'manual', color: 'default' }] } },
        },
    });
}

async function crearDatabaseNotas() {
    return notion!.databases.create({
        parent: { type: 'page_id', page_id: parentPageId },
        title: [{ type: 'text', text: { content: 'Notas de casos — Bartez AI' } }],
        properties: {
            'Título': { title: {} },
            'Cliente': { rich_text: {} },
            'Fecha': { date: {} },
            'Categoría': {
                select: {
                    options: [
                        { name: 'queja', color: 'red' },
                        { name: 'cotizacion_detalle', color: 'orange' },
                        { name: 'soporte', color: 'blue' },
                        { name: 'otro', color: 'default' },
                    ],
                },
            },
            'Contexto': { rich_text: {} },
        },
    });
}

// Helper para chunkear texto (Notion rich_text tiene límite de 2000 chars).
export function chunkText(t: string | null | undefined, max = 2000): { text: { content: string } }[] {
    const s = (t ?? '').slice(0, max);
    if (!s) return [];
    return [{ text: { content: s } }];
}

export { isFullPage };
