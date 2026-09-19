// Asistente Notion agentic: recibe una consigna en lenguaje natural y ejecuta
// un loop de tool use contra el SDK de Notion, con libertad para leer y
// modificar la página raíz que el operador le autorizó (NOTION_PARENT_PAGE_ID).
//
// Uso:
// - correrNotionAgent(consigna, maxIteraciones?) — devuelve el texto final del modelo
//   y un log de las tools que llamó.
// - Endpoints en index.ts:
//     POST /notion/organizar → consigna default "organizá la página raíz"
//     POST /notion/pedir { texto } → consigna custom

import Anthropic from '@anthropic-ai/sdk';
import { anthropic, calcularCosto, idModelo } from '../connectors/anthropic.js';
import { idsNotion, notion, notionConfigurado } from '../connectors/notion.js';
import { supabase } from '../connectors/supabase.js';

const parentPageId = process.env.NOTION_PARENT_PAGE_ID ?? '';

// ---------- Tool definitions expuestas al modelo ----------

const TOOLS: Anthropic.Tool[] = [
    {
        name: 'notion_leer_pagina',
        description:
            'Lee los bloques (contenido) de una página de Notion. Si no pasás page_id, lee la página raíz de Bartez AI. Devuelve una representación resumida de los bloques (tipo + texto + ids).',
        input_schema: {
            type: 'object',
            properties: {
                page_id: { type: 'string', description: 'Opcional. ID de la página. Omitir para leer la raíz.' },
            },
        },
    },
    {
        name: 'notion_agregar_bloques',
        description:
            'Agrega uno o más bloques al final de una página. Cada bloque tiene tipo y contenido. Si no pasás page_id, agrega a la página raíz.',
        input_schema: {
            type: 'object',
            properties: {
                page_id: { type: 'string', description: 'Opcional. Omitir para la raíz.' },
                bloques: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            tipo: {
                                type: 'string',
                                enum: ['heading_1', 'heading_2', 'heading_3', 'paragraph', 'callout', 'divider', 'bulleted_list_item', 'numbered_list_item', 'to_do', 'quote', 'toggle'],
                            },
                            texto: { type: 'string' },
                            emoji: { type: 'string', description: 'Solo para callout. Ej "💡", "📊".' },
                        },
                        required: ['tipo'],
                    },
                },
            },
            required: ['bloques'],
        },
    },
    {
        name: 'notion_actualizar_bloque',
        description:
            'Edita el texto de un bloque existente (tomás el block_id de notion_leer_pagina). No cambia el tipo del bloque.',
        input_schema: {
            type: 'object',
            properties: {
                block_id: { type: 'string' },
                texto: { type: 'string' },
            },
            required: ['block_id', 'texto'],
        },
    },
    {
        name: 'notion_listar_databases_bartez',
        description:
            'Devuelve los IDs y nombres de los 3 databases de Bartez: Prospectos, Tareas, Notas de casos. Usalos para armar link_to_database o para consultar stats.',
        input_schema: { type: 'object', properties: {} },
    },
    {
        name: 'notion_consultar_database',
        description:
            'Consulta las filas de un database. Devuelve un array con las propiedades principales (nombre, estado, fechas). Útil para calcular stats o listar top items. Máximo 25 filas por consulta.',
        input_schema: {
            type: 'object',
            properties: {
                database_id: { type: 'string' },
                limite: { type: 'number', description: 'Default 25.' },
            },
            required: ['database_id'],
        },
    },
];

// ---------- Handlers para cada tool ----------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function ejecutarTool(nombre: string, entrada: any): Promise<string> {
    if (!notion) throw new Error('Notion no configurado');

    if (nombre === 'notion_leer_pagina') {
        const pageId = entrada.page_id || parentPageId;
        const resp = await notion.blocks.children.list({ block_id: pageId, page_size: 50 });
        const resumen = resp.results.map((b) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const anyBlock = b as any;
            const tipo = anyBlock.type;
            const contenido = anyBlock[tipo];
            const texto = Array.isArray(contenido?.rich_text)
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                ? contenido.rich_text.map((r: any) => r.plain_text).join('')
                : contenido?.title
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    ? contenido.title.map((r: any) => r.plain_text).join('')
                    : '';
            return { id: anyBlock.id, tipo, texto: texto.slice(0, 200) };
        });
        return JSON.stringify({ page_id: pageId, bloques: resumen });
    }

    if (nombre === 'notion_agregar_bloques') {
        const pageId = entrada.page_id || parentPageId;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const bloques = (entrada.bloques as any[]).map((b) => bloqueAApiNotion(b));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await notion.blocks.children.append({ block_id: pageId, children: bloques as any });
        return JSON.stringify({ ok: true, agregados: bloques.length });
    }

    if (nombre === 'notion_actualizar_bloque') {
        const blockId = entrada.block_id as string;
        const texto = String(entrada.texto ?? '').slice(0, 2000);
        // Primero obtener el tipo del bloque
        const actual = await notion.blocks.retrieve({ block_id: blockId });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const tipo = (actual as any).type;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const update: any = {};
        update[tipo] = { rich_text: [{ type: 'text', text: { content: texto } }] };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await notion.blocks.update({ block_id: blockId, ...update } as any);
        return JSON.stringify({ ok: true });
    }

    if (nombre === 'notion_listar_databases_bartez') {
        const ids = idsNotion();
        return JSON.stringify({
            prospectos: { id: ids.prospectos, nombre: 'Prospectos — Bartez AI' },
            tareas: { id: ids.tareas, nombre: 'Tareas — Bartez AI' },
            notas: { id: ids.notas, nombre: 'Notas de casos — Bartez AI' },
        });
    }

    if (nombre === 'notion_consultar_database') {
        const dbId = entrada.database_id as string;
        const limite = Math.min(entrada.limite || 25, 25);
        const resp = await notion.databases.query({ database_id: dbId, page_size: limite });
        const filas = resp.results.map((p) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const anyPage = p as any;
            const props = anyPage.properties ?? {};
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const out: any = { id: anyPage.id };
            for (const [k, v] of Object.entries(props)) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const anyV = v as any;
                if (anyV.type === 'title' || anyV.type === 'rich_text') {
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    out[k] = (anyV[anyV.type] as any[])?.map((r: any) => r.plain_text).join('') ?? '';
                } else if (anyV.type === 'select') {
                    out[k] = anyV.select?.name ?? null;
                } else if (anyV.type === 'number') {
                    out[k] = anyV.number ?? null;
                } else if (anyV.type === 'date') {
                    out[k] = anyV.date?.start ?? null;
                } else if (anyV.type === 'email') {
                    out[k] = anyV.email ?? null;
                }
            }
            return out;
        });
        return JSON.stringify({ total: filas.length, filas });
    }

    throw new Error(`tool desconocida: ${nombre}`);
}

// Convierte {tipo, texto, emoji?} → bloque de la API de Notion.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function bloqueAApiNotion(b: { tipo: string; texto?: string; emoji?: string }): any {
    const texto = (b.texto ?? '').slice(0, 2000);
    const rich = texto ? [{ type: 'text', text: { content: texto } }] : [];
    switch (b.tipo) {
        case 'divider':
            return { object: 'block', type: 'divider', divider: {} };
        case 'callout':
            return {
                object: 'block',
                type: 'callout',
                callout: {
                    rich_text: rich,
                    icon: b.emoji ? { type: 'emoji', emoji: b.emoji } : { type: 'emoji', emoji: '💡' },
                },
            };
        case 'to_do':
            return { object: 'block', type: 'to_do', to_do: { rich_text: rich, checked: false } };
        default:
            return { object: 'block', type: b.tipo, [b.tipo]: { rich_text: rich } };
    }
}

// ---------- Runner del agent ----------

export interface ResultadoNotionAgent {
    ok: boolean;
    respuesta: string;
    tools_llamadas: number;
    tokens_in: number;
    tokens_out: number;
    costo_usd: number;
    duracion_ms: number;
    detalle?: string;
}

const SYSTEM_PROMPT_BASE = `Sos el asistente de Notion de Bartez Tecnología. Tenés acceso
directo a la página raíz de Bartez en Notion (donde el operador te autorizó) y
a los 3 databases: Prospectos, Tareas, Notas de casos.

Tu objetivo: que esa página sea un centro de operaciones útil, ordenado y
autoexplicativo. Podés leer el estado actual, agregar bloques (headers,
callouts, párrafos, listas, dividers, toggles), editar bloques existentes,
consultar los databases para armar resúmenes.

Reglas:
- Español rioplatense, voseo, tono directo y seco (mismo estándar que el
  resto del sistema — sin adulación).
- Cuando armes texto, contá qué hay hoy en los databases si es relevante
  (usá notion_consultar_database para stats reales).
- Evitá duplicar contenido: primero leé la página con notion_leer_pagina
  para ver qué ya existe. Si tenés que modificar algo, usá notion_actualizar_bloque
  en vez de agregar duplicados.
- Los links a databases usalos como texto tipo "Ver todos los prospectos"
  con URL "https://www.notion.so/{database_id sin guiones}" (aunque no
  tenés herramienta para link directo, podés escribirlos en párrafos).
- Cuando termines, respondé al operador en 2-3 líneas qué hiciste, sin
  listar cada bloque individual.`;

export async function correrNotionAgent(
    consigna: string,
    maxIteraciones = 10,
): Promise<ResultadoNotionAgent> {
    const inicio = Date.now();
    if (!notionConfigurado || !notion) {
        return {
            ok: false, respuesta: '', tools_llamadas: 0, tokens_in: 0, tokens_out: 0,
            costo_usd: 0, duracion_ms: Date.now() - inicio,
            detalle: 'Notion no está configurado (falta NOTION_TOKEN o NOTION_PARENT_PAGE_ID)',
        };
    }

    // Buscar el asistente Notion en la DB para usar su prompt custom y modelo
    const { data: filaAsist } = await supabase
        .from('asistentes')
        .select('prompt, modelo')
        .eq('area', 'notion')
        .maybeSingle();
    const modelo = (filaAsist?.modelo as 'sonnet' | 'haiku' | 'opus') ?? 'sonnet';
    const systemCustom = (filaAsist?.prompt as string | null)?.trim() || SYSTEM_PROMPT_BASE;

    const mensajes: Anthropic.MessageParam[] = [{ role: 'user', content: consigna }];
    let toolsLlamadas = 0;
    let tokensIn = 0;
    let tokensOut = 0;
    let respuestaFinal = '';

    for (let i = 0; i < maxIteraciones; i++) {
        const resp = await anthropic.messages.create({
            model: idModelo(modelo),
            max_tokens: 4096,
            system: systemCustom,
            tools: TOOLS,
            messages: mensajes,
        });
        tokensIn += resp.usage.input_tokens;
        tokensOut += resp.usage.output_tokens;

        // Sumar el assistant turn al historial
        mensajes.push({ role: 'assistant', content: resp.content });

        const toolUses = resp.content.filter((c): c is Anthropic.ToolUseBlock => c.type === 'tool_use');
        const textos = resp.content.filter((c): c is Anthropic.TextBlock => c.type === 'text').map((t) => t.text).join('\n');

        if (toolUses.length === 0) {
            respuestaFinal = textos.trim();
            break;
        }

        // Ejecutar todas las tool uses del turno y devolver resultados
        const toolResults: Anthropic.ToolResultBlockParam[] = [];
        for (const tu of toolUses) {
            toolsLlamadas++;
            try {
                const salida = await ejecutarTool(tu.name, tu.input);
                toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: salida });
            } catch (err) {
                toolResults.push({
                    type: 'tool_result', tool_use_id: tu.id,
                    content: `ERROR: ${(err as Error).message}`,
                    is_error: true,
                });
            }
        }
        mensajes.push({ role: 'user', content: toolResults });
    }

    const costo = calcularCosto(modelo, tokensIn, tokensOut);
    return {
        ok: true,
        respuesta: respuestaFinal || '(el agent terminó sin texto final)',
        tools_llamadas: toolsLlamadas,
        tokens_in: tokensIn,
        tokens_out: tokensOut,
        costo_usd: costo,
        duracion_ms: Date.now() - inicio,
    };
}
