// Asistente General del panel: responde preguntas del día a día usando los
// datos reales del sistema (resumen del día, catálogo de proveedores, fichas de
// clientes, cotizaciones) y puede armar cotizaciones. Es el destino por defecto
// del chat del panel; los pedidos específicos (redactar correos, prospectar,
// seguimientos) siguen yendo a su asistente.

import Anthropic from '@anthropic-ai/sdk';
import { anthropic, calcularCosto, idModelo, maxTokens, opcionesModelo } from '../connectors/anthropic.js';
import { supabase } from '../connectors/supabase.js';
import { contextoFecha } from '../assistants/base.js';
import { historicoConCliente } from '../inbound/importar_historico.js';
import { cotizar } from './cotizador.js';
import { enviarFactura, facturasRecientes, prepararFactura } from './facturador.js';
import { prepararDesdePedido, resumenFacturacion } from './facturacion.js';
import { crearCliente } from './clientes.js';
import { documentosDeCliente, notasDeCliente, textoDeNota, ultimoInforme } from './memoria.js';
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
- Si te piden crear, cargar o dar de alta un cliente, usá crear_cliente con los
  datos que te dieron; no inventes email, teléfono ni CUIT. Si devuelve
  parecidos, preguntá si es alguno de esos antes de crear otro. Al terminar,
  decí qué quedó cargado y cuántos correos y chats de WhatsApp se vincularon.
- Si el pedido es redactar un correo, prospectar empresas o preparar un
  seguimiento, decile que lo pida así ("redactá un correo para…", "buscá
  prospectos de…", "hacé un seguimiento a…") y se lo derivás al asistente
  correspondiente.
- Respuestas cortas y concretas, en español rioplatense, sin relleno. Usá
  listas cuando haya varios ítems. Montos en US$ con dos decimales.`;

// Van siempre, aunque el prompt del General se haya editado desde el panel.
const REGLAS_FACTURACION = `Facturación (Asimov):
- Si te piden facturar ("facturale a X…", "haceme una factura…"), usá preparar_factura con
  los productos, cantidades y precios que te dieron, o con el número de cotización. No
  inventes precios, cantidades ni CUIT: si falta algo, preguntalo.
- Precios: si no dicen si incluyen IVA, preguntá ("¿el precio es con IVA o más IVA?").
  Moneda: US$ si dicen dólares/USD/u$s; si no, pesos. Si dan alícuota de IVA, pasala.
- preparar_factura NO manda nada: mostrá la vista (tipo, cliente, renglones, neto, IVA,
  total, dólar y avisos) y preguntá si la manda a Asimov. Solo con un sí claro llamá
  enviar_factura con el factura_id. Si pide cambios, prepará una nueva.
- "Solo el total" (ej. "facturale una PC completa a 1.200 dólares"): un único renglón con esa
  descripción, cantidad 1 y ese total como precio. Si nombran los componentes sin precio,
  agregalos a la descripción ("PC completa — Incluye: i5 14400, 16 GB, SSD 1 TB"). Si dan precio de
  cada componente pero quieren que la factura muestre una sola línea, cargá los renglones y pasá
  una_linea con la descripción ("PC completa").
- Proforma o prefactura: la factura preparada (sin mandar) ya es eso; el PDF de la proforma sin
  validez fiscal está en Facturación → Preparadas. No hace falta mandarla a Asimov para verla.
- Al enviarla queda como BORRADOR en Asimov: el CAE se pide desde Asimov con
  "Autorizar ARCA". Decilo así; nunca digas que la factura quedó emitida o autorizada.`;

const TOOLS: Anthropic.Tool[] = [
    {
        name: 'preparar_factura',
        description: 'Arma una factura para Asimov (no la manda): busca el cliente en Asimov, decide A o B según su condición de IVA, discrimina IVA y pasa a pesos si los precios son en dólares. Devuelve la vista para mostrarle al usuario y un factura_id. Se puede facturar cualquier cosa que diga el usuario, no hace falta una cotización.',
        input_schema: {
            type: 'object',
            properties: {
                cliente: { type: 'string', description: 'Razón social, nombre o CUIT del cliente' },
                cliente_nuevo: {
                    type: 'object', description: 'Solo si el cliente no está en Asimov y el usuario dio sus datos',
                    properties: { razon_social: { type: 'string' }, cuit: { type: 'string' }, condicion_iva: { type: 'string', enum: ['responsable_inscripto', 'monotributista', 'exento', 'consumidor_final'] }, email: { type: 'string' } },
                    required: ['razon_social', 'condicion_iva'],
                },
                renglones: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            descripcion: { type: 'string' }, cantidad: { type: 'number' },
                            precio_unitario: { type: 'number', description: 'Precio por unidad tal como lo dijo el usuario' },
                            codigo: { type: 'string', description: 'Código o número de parte, si lo dio' },
                            iva_pct: { type: 'number', description: 'Alícuota (21, 10.5, 27, 0…) si la dijo' },
                        },
                        required: ['descripcion', 'cantidad', 'precio_unitario'],
                    },
                },
                cotizacion: { type: 'string', description: 'Número de cotización del Cotizador, si pide facturar una cotización' },
                moneda: { type: 'string', enum: ['ARS', 'USD'] },
                precios_con_iva: { type: 'boolean', description: 'true si los precios que dio ya incluyen IVA' },
                cotizacion_usd: { type: 'number', description: 'Dólar a usar, solo si el usuario lo dijo' },
                observaciones: { type: 'string', description: 'Texto para la factura (orden de compra, condición de pago), si lo dio' },
                una_linea: { type: 'string', description: 'Si quiere que la factura muestre una sola línea (ej. "PC completa") con los renglones como detalle sin precio' },
            },
            required: ['cliente'],
        },
    },
    {
        name: 'enviar_factura',
        description: 'Manda a Asimov, como borrador, una factura ya preparada y mostrada. Solo después de que el usuario dijo que sí.',
        input_schema: { type: 'object', properties: { factura_id: { type: 'string' } }, required: ['factura_id'] },
    },
    {
        name: 'facturar_pedido',
        description: 'Prepara (no manda) la factura de un pedido de venta de Asimov por su número, con el mismo cliente y renglones. Devuelve la vista y el factura_id, igual que preparar_factura.',
        input_schema: { type: 'object', properties: { pedido: { type: 'string', description: 'Número del pedido en Asimov' } }, required: ['pedido'] },
    },
    {
        name: 'cobranzas',
        description: 'Facturas autorizadas de Asimov con saldo pendiente (de todos, no solo de Bartez AI): cliente, número, fecha, saldo, días y si está vencida. También totales por cobrar y vencido.',
        input_schema: { type: 'object', properties: {} },
    },
    {
        name: 'facturas_recientes',
        description: 'Las últimas facturas que Bartez AI mandó a Asimov y su estado: enviada (borrador, falta autorizar), autorizada (con número y CAE), rechazada por ARCA (con el motivo) o descartada.',
        input_schema: { type: 'object', properties: {} },
    },
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
        name: 'crear_cliente',
        description: 'Da de alta un cliente o lead en Clientes y seguimientos. Primero busca parecidos (mismo email, teléfono o nombre): si hay, NO lo crea y devuelve los parecidos para que le preguntes al usuario si es el mismo; solo si confirma que es otro, llamala de nuevo con crear_igual: true. Vincula los correos y chats de WhatsApp que ya había de ese email o teléfono. Usala solo cuando te pidan crear o cargar un cliente, y solo con datos que te dieron.',
        input_schema: {
            type: 'object',
            properties: {
                nombre: { type: 'string', description: 'Empresa o persona' },
                email: { type: 'string' },
                whatsapp: { type: 'string', description: 'Teléfono o WhatsApp tal como lo dieron (con característica)' },
                estado: { type: 'string', enum: ['lead', 'cliente'], description: 'cliente si ya compró; si no, lead (por defecto)' },
                contacto: { type: 'string', description: 'Persona de contacto en la empresa' },
                sitio_web: { type: 'string' },
                cuit: { type: 'string' },
                nota: { type: 'string', description: 'Lo que contaron del cliente: queda en su memoria' },
                crear_igual: { type: 'boolean', description: 'Solo si el usuario confirmó que no es ninguno de los parecidos' },
            },
            required: ['nombre'],
        },
    },
    {
        name: 'buscar_cliente',
        description: 'Busca un cliente o lead por nombre, empresa o email y devuelve su ficha: estado, último contacto, correos y WhatsApp recientes, cotizaciones a su nombre y su memoria (último informe, notas de Andrés y resúmenes de los documentos que subió, como órdenes de compra o presupuestos de la competencia).',
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
async function ejecutarTool(nombre: string, e: any, texto = ''): Promise<string> {
    if (nombre === 'preparar_factura') {
        return JSON.stringify(await prepararFactura({ ...e, pedido: texto }));
    }
    if (nombre === 'enviar_factura') {
        return JSON.stringify(await enviarFactura(String(e.factura_id ?? '')));
    }
    if (nombre === 'facturar_pedido') {
        return JSON.stringify(await prepararDesdePedido(String(e.pedido ?? '')));
    }
    if (nombre === 'cobranzas') {
        const r = await resumenFacturacion();
        if (!r.api_lista) return JSON.stringify({ error: 'Asimov todavía no tiene la consulta de documentos publicada' });
        return JSON.stringify({ totales: r.totales, pendientes: r.cobranzas.slice(0, 40).map((c) => ({ cliente: c.factura.cliente, factura: `${c.factura.tipo} ${c.factura.numero}`, fecha: c.factura.fecha, total: c.factura.total, saldo: c.factura.saldo, dias: c.dias, vencida: c.vencida })) });
    }
    if (nombre === 'facturas_recientes') {
        return JSON.stringify(await facturasRecientes());
    }

    if (nombre === 'crear_cliente') {
        const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
        const r = await crearCliente({
            nombre: String(e.nombre ?? ''),
            email: str(e.email), whatsapp: str(e.whatsapp), contacto: str(e.contacto), sitio_web: str(e.sitio_web), cuit: str(e.cuit),
            estado: e.estado === 'cliente' ? 'cliente' : 'lead',
            nota: str(e.nota),
        }, { origen: 'chat', crearIgual: e.crear_igual === true });
        if (!r.ok && r.parecidos?.length) {
            return JSON.stringify({
                creado: false,
                motivo: 'Hay clientes parecidos. Preguntá si es alguno de estos antes de crear otro.',
                parecidos: r.parecidos.map((p) => ({ nombre: p.nombre, email: p.email, whatsapp: p.whatsapp, estado: p.estado, por: p.motivo })),
            });
        }
        if (!r.ok) return JSON.stringify({ creado: false, error: r.detalle });
        return JSON.stringify({ creado: true, cliente: r.cliente, vinculados: r.vinculados, donde: 'Clientes y seguimientos' });
    }

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
            // Los mismos números que la tarjeta del mes en Inicio. Cotizado = presupuestos
            // emitidos (enviados, ganados o perdidos, también los cargados como documento);
            // los borradores no cuentan.
            mes: r.pulso?.kpis ?? null,
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
        const [correos, wa, cots, informe, notas, docs] = await Promise.all([
            historicoConCliente(c.id as string, 6),
            mensajesWhatsappDeCliente(c.id as string, 10),
            supabase.from('cotizaciones').select('numero, numero_externo, titulo, total_usd, estado, creado_en')
                .or(`cliente_id.eq.${c.id},titulo.ilike.%${q}%`).order('creado_en', { ascending: false }).limit(8),
            ultimoInforme(c.id as string),
            notasDeCliente(c.id as string, 15),
            documentosDeCliente(c.id as string),
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
                // Memoria del cliente: lo que Andrés anotó, los documentos que subió y el último informe.
                ultimo_informe: informe ? { fecha: informe.creado_en.slice(0, 10), texto: informe.resumen_md.slice(0, 2500) } : null,
                notas_de_andres: notas.map((n) => ({ fecha: n.creado_en.slice(0, 10), texto: textoDeNota(n, 600) })),
                documentos: docs.filter((d) => d.estado === 'listo').map((d) => ({ fecha: d.creado_en.slice(0, 10), archivo: d.nombre, tipo: d.tipo_documento, resumen: (d.resumen ?? '').slice(0, 1200) })),
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
    const system = `${(fila?.prompt as string | null)?.trim() || PROMPT_DEFAULT}\n\n${REGLAS_FACTURACION}\n\n${contextoFecha()}`;

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
        const resp = await anthropic.messages.create({ ...opcionesModelo(modelo), max_tokens: maxTokens(modelo, 1500), system, tools: TOOLS, messages: mensajes });
        tokensIn += resp.usage.input_tokens;
        tokensOut += resp.usage.output_tokens;
        mensajes.push({ role: 'assistant', content: resp.content });
        const usos = resp.content.filter((c): c is Anthropic.ToolUseBlock => c.type === 'tool_use');
        respuesta = resp.content.filter((c): c is Anthropic.TextBlock => c.type === 'text').map((c) => c.text).join('\n').trim();
        if (usos.length === 0) break;
        const resultados: Anthropic.ToolResultBlockParam[] = [];
        for (const u of usos) {
            try {
                resultados.push({ type: 'tool_result', tool_use_id: u.id, content: (await ejecutarTool(u.name, u.input, texto)).slice(0, 40_000) });
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
