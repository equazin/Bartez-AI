// Asistente General del panel: responde preguntas del día a día usando los
// datos reales del sistema (resumen del día, catálogo de proveedores, fichas de
// clientes, cotizaciones) y puede armar cotizaciones. Es el destino por defecto
// del chat del panel; los pedidos específicos (redactar correos, prospectar,
// seguimientos) siguen yendo a su asistente.

import Anthropic from '@anthropic-ai/sdk';
import { anthropic, calcularCosto, idModelo } from '../connectors/anthropic.js';
import { supabase } from '../connectors/supabase.js';
import { contextoFecha } from '../assistants/base.js';
import { historicoConCliente } from '../inbound/importar_historico.js';
import { cotizar } from './cotizador.js';
import { resumenHoy } from './hoy.js';
import { mensajesWhatsappDeCliente } from './whatsapp.js';
import type { ModeloClaude } from './types.js';

const PROMPT_DEFAULT = `Sos el asistente general de Bartez Tecnología (distribuidor mayorista de IT,
Rosario, Santa Fe). Hablás con el dueño desde su panel. Respondés preguntas
sobre el negocio y resolvés pedidos usando las herramientas: no sabés nada del
negocio que no salga de ellas.

Reglas:
- Usá las herramientas antes de responder sobre pendientes, clientes, precios,
  stock o cotizaciones. Nunca inventes números, precios ni nombres.
- Precios: usá precio_venta (ya tiene el margen de Bartez). El costo del
  proveedor mostralo solo si te lo piden.
- Si te piden cotizar varios artículos, usá la herramienta cotizar: arma la
  cotización completa y la deja guardada en el Cotizador.
- Si el pedido es redactar un correo, prospectar empresas o preparar un
  seguimiento, decile que lo pida así ("redactá un correo para…", "buscá
  prospectos de…", "hacé un seguimiento a…") y se lo derivás al asistente
  correspondiente.
- Respuestas cortas y concretas, en español rioplatense, sin relleno. Usá
  listas cuando haya varios ítems. Montos en US$ con dos decimales.`;

const TOOLS: Anthropic.Tool[] = [
    {
        name: 'resumen_del_dia',
        description: 'Estado del negocio hoy: lo que espera aprobación, WhatsApp y correos sin responder, cotizaciones recientes, leads calientes, tareas, proveedores y prioridades del día.',
        input_schema: { type: 'object', properties: {} },
    },
    {
        name: 'buscar_articulos',
        description: 'Busca en las listas de los proveedores (Elit, Air, Invid). Devuelve descripción, proveedor, stock, costo y precio de venta con margen, sin IVA y con IVA, en US$.',
        input_schema: {
            type: 'object',
            properties: {
                consulta: { type: 'string', description: 'Términos concretos: tipo de producto, marca, specs, número de parte.' },
                solo_con_stock: { type: 'boolean' },
            },
            required: ['consulta'],
        },
    },
    {
        name: 'cotizar',
        description: 'Arma una cotización completa para un pedido (varios renglones), eligiendo artículos iguales o similares, y la guarda en el Cotizador. Tarda unos segundos.',
        input_schema: { type: 'object', properties: { pedido: { type: 'string' } }, required: ['pedido'] },
    },
    {
        name: 'buscar_cliente',
        description: 'Busca un cliente o lead por nombre, empresa o email y devuelve su ficha: estado, último contacto, correos y WhatsApp recientes, y cotizaciones a su nombre.',
        input_schema: { type: 'object', properties: { nombre: { type: 'string' } }, required: ['nombre'] },
    },
];

async function margenes(): Promise<Map<string, number>> {
    const { data } = await supabase.from('proveedores').select('codigo, margen_pct');
    return new Map((data ?? []).map((p) => [p.codigo as string, Number(p.margen_pct ?? 15)]));
}

async function tipoCambioActual(): Promise<number | null> {
    const fijo = Number(process.env.TIPO_CAMBIO_FIJO);
    if (fijo > 0) return fijo;
    try {
        const r = await fetch('https://dolarapi.com/v1/dolares/oficial', { signal: AbortSignal.timeout(5000) });
        const j = await r.json() as { venta?: number };
        return j.venta ?? null;
    } catch { return null; }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function ejecutarTool(nombre: string, e: any): Promise<string> {
    if (nombre === 'resumen_del_dia') {
        const r = await resumenHoy();
        const f = r.foto;
        return JSON.stringify({
            linea: r.linea,
            costo_ia_hoy_usd: Number(r.costo_hoy_usd.toFixed(2)),
            prioridades: r.prioridades?.items ?? [],
            para_aprobar: f.acciones_pendientes,
            whatsapp_sin_responder: f.whatsapp.sin_responder_en_ventana,
            whatsapp_vencidos: f.whatsapp.sin_responder_vencidas,
            correos_sin_respuesta: f.correos_3_dias.relevantes.filter((c) => !c.respondido),
            cotizaciones_14_dias: f.cotizaciones_14_dias,
            pipeline: f.pipeline,
            tareas_pendientes: f.tareas_notion.filter((t) => t.estado === 'pendiente').slice(0, 20),
            proveedores: f.proveedores,
        });
    }

    if (nombre === 'buscar_articulos') {
        const { data, error } = await supabase.rpc('buscar_catalogo', { q: String(e.consulta ?? ''), limite: 12, solo_stock: !!e.solo_con_stock });
        if (error) throw new Error(error.message);
        const [mg, tc] = await Promise.all([margenes(), tipoCambioActual()]);
        return JSON.stringify((data ?? []).map((a: Record<string, unknown>) => {
            const precio = Number(a.precio ?? 0);
            const costoUsd = a.moneda === 'ARS' ? (tc ? precio / tc : null) : precio;
            const margen = mg.get(String(a.proveedor)) ?? 15;
            const iva = a.iva_pct != null ? Number(a.iva_pct) : 21;
            const venta = costoUsd != null ? costoUsd * (1 + margen / 100) : null;
            const r2 = (n: number | null) => (n == null ? null : Math.round(n * 100) / 100);
            return {
                descripcion: a.descripcion, marca: a.marca, proveedor: a.proveedor, stock: a.stock,
                costo_usd: r2(costoUsd), margen_pct: margen, iva_pct: iva,
                precio_venta_sin_iva_usd: r2(venta), precio_venta_con_iva_usd: r2(venta != null ? venta * (1 + iva / 100) : null),
            };
        }));
    }

    if (nombre === 'cotizar') {
        const r = await cotizar(String(e.pedido ?? ''));
        if (!r.ok) return JSON.stringify({ error: r.detalle ?? 'no se pudo cotizar' });
        return JSON.stringify({
            guardada_en_cotizador: true,
            renglones: r.lineas.map((l) => ({
                pedido: l.pedido, cantidad: l.cantidad, nota: l.nota,
                elegido: l.elegido ? { descripcion: l.elegido.descripcion, proveedor: l.elegido.proveedor, unitario_sin_iva_usd: l.elegido.precio_unit_usd, iva_pct: l.elegido.iva_pct, stock: l.elegido.stock } : null,
            })),
            subtotal_usd: r.subtotal_usd, iva_usd: r.iva_usd, total_usd: r.total_usd, total_ars: r.total_ars, tipo_cambio: r.tipo_cambio,
            comentario: r.comentario,
        });
    }

    if (nombre === 'buscar_cliente') {
        const q = String(e.nombre ?? '').trim().replace(/[%,()]/g, ' ');
        if (!q) return JSON.stringify({ error: 'falta el nombre' });
        const { data: cls } = await supabase.from('clientes')
            .select('id, nombre, email, whatsapp, estado, ultimo_contacto_en, intentos_contacto, metadata')
            .or(`nombre.ilike.%${q}%,email.ilike.%${q}%`)
            .limit(5);
        if (!cls || cls.length === 0) return JSON.stringify({ encontrados: 0 });
        const c = cls[0]!;
        const [correos, wa, cots] = await Promise.all([
            historicoConCliente(c.id as string, 6),
            mensajesWhatsappDeCliente(c.id as string, 10),
            supabase.from('cotizaciones').select('numero, titulo, total_usd, creado_en').ilike('titulo', `%${q}%`).order('creado_en', { ascending: false }).limit(5),
        ]);
        return JSON.stringify({
            encontrados: cls.length,
            otros: cls.slice(1).map((x) => x.nombre),
            ficha: {
                nombre: c.nombre, email: c.email, numero_whatsapp: c.whatsapp, estado: c.estado,
                ultimo_contacto: c.ultimo_contacto_en, intentos: c.intentos_contacto,
                senial: (c.metadata as { senial?: string } | null)?.senial ?? null,
                correos: correos.map((h) => ({ fecha: String(h.fecha).slice(0, 10), direccion: h.direccion, asunto: h.asunto, resumen: (h.cuerpo ?? '').replace(/\s+/g, ' ').slice(0, 250) })),
                mensajes_whatsapp: wa.slice().reverse().map((m) => ({ fecha: m.creado_en.slice(0, 16), de: m.origen, texto: (m.cuerpo ?? '').slice(0, 200) })),
                cotizaciones: cots.data ?? [],
            },
        });
    }

    throw new Error(`herramienta desconocida: ${nombre}`);
}

export interface RespuestaOperador {
    respuesta: string;
    tokensIn: number;
    tokensOut: number;
    costoUsd: number;
    duracionMs: number;
    asistenteId: string | null;
}

export async function responderOperador(texto: string, conversacionId: string | null): Promise<RespuestaOperador> {
    const inicio = Date.now();
    const { data: fila } = await supabase.from('asistentes').select('id, prompt, modelo').eq('area', 'operador').maybeSingle();
    const modelo = ((fila?.modelo as ModeloClaude | undefined) ?? 'sonnet');
    const system = `${(fila?.prompt as string | null)?.trim() || PROMPT_DEFAULT}\n\n${contextoFecha()}`;

    // Últimos mensajes de esta conversación, para que siga el hilo.
    const mensajes: Anthropic.MessageParam[] = [];
    if (conversacionId) {
        const { data: prev } = await supabase.from('mensajes').select('remitente, texto')
            .eq('conversacion_id', conversacionId).order('creado_en', { ascending: false }).limit(12);
        for (const m of (prev ?? []).reverse()) {
            const rol = m.remitente === 'asistente' ? 'assistant' : 'user';
            const ultimo = mensajes[mensajes.length - 1];
            if (ultimo && ultimo.role === rol) ultimo.content = `${ultimo.content as string}\n\n${m.texto}`;
            else mensajes.push({ role: rol, content: String(m.texto ?? '') });
        }
        // El mensaje actual ya fue guardado por el router: si quedó último, no lo duplicamos.
        const ultimo = mensajes[mensajes.length - 1];
        if (ultimo?.role === 'user' && String(ultimo.content).endsWith(texto)) mensajes.pop();
        while (mensajes[0]?.role === 'assistant') mensajes.shift();
    }
    mensajes.push({ role: 'user', content: texto });

    let tokensIn = 0, tokensOut = 0, respuesta = '';
    for (let i = 0; i < 8; i++) {
        const resp = await anthropic.messages.create({ model: idModelo(modelo), max_tokens: 1500, system, tools: TOOLS, messages: mensajes });
        tokensIn += resp.usage.input_tokens;
        tokensOut += resp.usage.output_tokens;
        mensajes.push({ role: 'assistant', content: resp.content });
        const usos = resp.content.filter((c): c is Anthropic.ToolUseBlock => c.type === 'tool_use');
        respuesta = resp.content.filter((c): c is Anthropic.TextBlock => c.type === 'text').map((c) => c.text).join('\n').trim();
        if (usos.length === 0) break;
        const resultados: Anthropic.ToolResultBlockParam[] = [];
        for (const u of usos) {
            try {
                resultados.push({ type: 'tool_result', tool_use_id: u.id, content: (await ejecutarTool(u.name, u.input)).slice(0, 40_000) });
            } catch (err) {
                resultados.push({ type: 'tool_result', tool_use_id: u.id, content: `ERROR: ${(err as Error).message}`, is_error: true });
            }
        }
        mensajes.push({ role: 'user', content: resultados });
    }

    return {
        respuesta: respuesta || 'No pude armar una respuesta. Probá reformular el pedido.',
        tokensIn, tokensOut,
        costoUsd: calcularCosto(modelo, tokensIn, tokensOut),
        duracionMs: Date.now() - inicio,
        asistenteId: (fila?.id as string | undefined) ?? null,
    };
}
