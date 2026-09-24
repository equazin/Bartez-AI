// WhatsApp a través del bot de bartez.com.ar.
//
// - sincronizarWhatsapp(): trae de la web las conversaciones que cambiaron,
//   guarda los mensajes en wa_mensajes y vincula cada número con un cliente.
// - Cuando una conversación está escalada (el bot la derivó a una persona) y
//   el cliente escribió dentro de las últimas 24 h sin respuesta humana, el
//   asistente propone una respuesta que queda en Acciones para aprobar.
// - enviarWhatsapp(): lo usa el ejecutor al aprobar; manda por la API de la web.
//
// El bot de la web sigue atendiendo el primer contacto: Bartez AI solo
// propone en conversaciones escaladas, para no responder dos veces.

import { anthropic, calcularCosto, idModelo } from '../connectors/anthropic.js';
import type { ModeloClaude } from './types.js';
import { textoWebBartez } from '../connectors/bartez_web.js';
import {
    ConversacionStudio,
    MensajeStudio,
    enviarTextoStudio,
    listarConversacionesStudio,
    obtenerConversacionStudio,
    studioConfigurado,
} from '../connectors/studio.js';
import { supabase } from '../connectors/supabase.js';
import { contextoFecha } from '../assistants/base.js';
import { conLecciones } from './aprendizaje.js';
import { historicoConCliente } from '../inbound/importar_historico.js';

const VENTANA_MS = 24 * 3600_000;

const PROMPT_DEFAULT = `Sos quien atiende el WhatsApp comercial de Bartez Tecnología, distribuidor
mayorista de IT en Rosario (Santa Fe) que vende a empresas, organismos y
revendedores de todo el país.

La conversación empezó con el bot automático de la web, que la derivó a una
persona. Ahora respondés vos, como parte del equipo comercial.

Reglas:
- Mensaje de WhatsApp: corto (2 a 5 líneas), claro, cordial y directo. Tuteo
  o voseo natural rioplatense, sin exagerar.
- Nada de adulación ni frases de relleno ("¡Excelente pregunta!", "Será un
  placer…"). Sin firmas largas.
- Respondé a lo último que pidió el cliente, retomando el hilo. Si el bot ya
  pidió datos, no los vuelvas a pedir.
- No inventes precios, stock ni plazos. Si piden cotización, pedí lo que falte
  (cantidades, modelo, uso, facturación) o decí que se la preparás.
- Si falta información para responder bien, hacé una sola pregunta concreta.
- Emojis: como mucho uno, y solo si suma.
- Si lo último del cliente es solo un agradecimiento o un cierre ("gracias",
  "dale", "ok"), respondé con un cierre breve y quedá a disposición.
- Si el mensaje del cliente figura "(sin texto)" es un audio, imagen o archivo
  que no podés ver: pedile amablemente que te lo escriba o que te cuente qué envió.

Respondé SOLO con el texto del mensaje a enviar, sin comillas ni explicaciones.`;

// ---------- Teléfonos ----------

const soloDigitos = (s: string) => s.replace(/\D/g, '');

// Últimos 8 dígitos: el número local, igual escrito con 549/54/0/15.
function colaTelefono(s: string): string {
    const d = soloDigitos(s);
    return d.length >= 8 ? d.slice(-8) : '';
}

async function clientePorTelefono(waId: string): Promise<string | null> {
    const cola = colaTelefono(waId);
    if (!cola) return null;
    const { data } = await supabase.from('clientes').select('id, whatsapp').not('whatsapp', 'is', null).ilike('whatsapp', `%${cola.slice(-4)}%`);
    const coinciden = (data ?? []).filter((c) => colaTelefono(String(c.whatsapp ?? '')) === cola);
    return coinciden.length === 1 ? (coinciden[0]!.id as string) : null;
}

// ---------- Sincronización ----------

function origenDe(m: MensajeStudio): 'cliente' | 'bot' | 'humano' {
    if (m.direction === 'inbound') return 'cliente';
    return m.waMessageId.startsWith('bot_') ? 'bot' : 'humano';
}

async function guardarConversacion(c: ConversacionStudio): Promise<void> {
    const mensajes = [...c.messages].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    if (mensajes.length > 0) {
        const filas = mensajes.map((m) => ({
            id: m.id,
            wa_id: c.waId,
            wa_message_id: m.waMessageId,
            direccion: m.direction,
            origen: origenDe(m),
            tipo: m.type,
            cuerpo: m.body,
            creado_en: m.createdAt,
        }));
        // Primero la conversación (FK), después los mensajes.
        await upsertConversacion(c, mensajes);
        for (let i = 0; i < filas.length; i += 500) {
            const { error } = await supabase.from('wa_mensajes').upsert(filas.slice(i, i + 500), { onConflict: 'id' });
            if (error) throw new Error(`wa_mensajes: ${error.message}`);
        }
    } else {
        await upsertConversacion(c, mensajes);
    }
}

async function upsertConversacion(c: ConversacionStudio, mensajes: MensajeStudio[]): Promise<void> {
    const ultimo = mensajes[mensajes.length - 1];
    const ultimoEntrante = [...mensajes].reverse().find((m) => m.direction === 'inbound');
    const { data: previa } = await supabase.from('wa_conversaciones').select('cliente_id').eq('wa_id', c.waId).maybeSingle();
    const clienteId = (previa?.cliente_id as string | null) ?? await clientePorTelefono(c.waId);
    const { error } = await supabase.from('wa_conversaciones').upsert({
        wa_id: c.waId,
        studio_id: c.id,
        nombre: c.profileName,
        estado: c.status,
        categoria: c.category,
        cliente_id: clienteId,
        actualizado_en: c.updatedAt,
        ultimo_entrante_en: ultimoEntrante?.createdAt ?? null,
        ultimo_mensaje: ultimo?.body?.slice(0, 500) ?? null,
        ultimo_direccion: ultimo ? origenDe(ultimo) : null,
        sincronizado_en: new Date().toISOString(),
    }, { onConflict: 'wa_id' });
    if (error) throw new Error(`wa_conversaciones: ${error.message}`);
}

export interface ResultadoSyncWa {
    ok: boolean;
    conversaciones: number;
    actualizadas: number;
    borradores: number;
    detalle?: string;
}

let sincronizando = false;

export async function sincronizarWhatsapp(opts: { proponer?: boolean } = {}): Promise<ResultadoSyncWa> {
    if (!studioConfigurado()) return { ok: false, conversaciones: 0, actualizadas: 0, borradores: 0, detalle: 'Falta STUDIO_API_TOKEN en el .env' };
    if (sincronizando) return { ok: false, conversaciones: 0, actualizadas: 0, borradores: 0, detalle: 'Ya hay una sincronización en curso' };
    sincronizando = true;
    try {
        const remotas = await listarConversacionesStudio();
        const { data: locales } = await supabase.from('wa_conversaciones').select('wa_id, actualizado_en');
        const conocida = new Map((locales ?? []).map((l) => [l.wa_id as string, l.actualizado_en as string | null]));

        let actualizadas = 0;
        const tocadas: string[] = [];
        for (const r of remotas) {
            const previa = conocida.get(r.waId);
            if (previa && new Date(previa).getTime() >= new Date(r.updatedAt).getTime()) continue;
            const completa = await obtenerConversacionStudio(r.waId);
            await guardarConversacion(completa);
            actualizadas++;
            tocadas.push(r.waId);
        }

        let borradores = 0;
        if (opts.proponer !== false) {
            for (const waId of tocadas) {
                const r = await proponerSiCorresponde(waId).catch((err) => {
                    console.warn('[whatsapp] no se pudo proponer respuesta', waId, (err as Error).message);
                    return false;
                });
                if (r) borradores++;
            }
        }
        return { ok: true, conversaciones: remotas.length, actualizadas, borradores };
    } catch (err) {
        return { ok: false, conversaciones: 0, actualizadas: 0, borradores: 0, detalle: (err as Error).message };
    } finally {
        sincronizando = false;
    }
}

// ---------- Propuesta de respuesta ----------

interface FilaConv {
    wa_id: string;
    nombre: string | null;
    estado: string | null;
    categoria: string | null;
    cliente_id: string | null;
    ultimo_entrante_en: string | null;
    borrador_para_msg: string | null;
}

export function dentroDeVentana(ultimoEntrante: string | null): boolean {
    return !!ultimoEntrante && Date.now() - new Date(ultimoEntrante).getTime() < VENTANA_MS;
}

async function mensajesDe(waId: string, limite = 40) {
    const { data } = await supabase
        .from('wa_mensajes')
        .select('id, direccion, origen, cuerpo, creado_en')
        .eq('wa_id', waId)
        .order('creado_en', { ascending: false })
        .limit(limite);
    return (data ?? []).reverse() as Array<{ id: string; direccion: string; origen: string; cuerpo: string | null; creado_en: string }>;
}

async function hayPendiente(waId: string): Promise<boolean> {
    const { count } = await supabase
        .from('acciones_pendientes')
        .select('id', { count: 'exact', head: true })
        .eq('accion', 'enviar_whatsapp')
        .eq('estado', 'pendiente')
        .contains('payload', { waId });
    return (count ?? 0) > 0;
}

// Automático: solo escaladas, con un mensaje del cliente sin respuesta humana,
// dentro de la ventana de 24 h, y una sola propuesta por mensaje.
async function proponerSiCorresponde(waId: string): Promise<boolean> {
    const { data: conv } = await supabase.from('wa_conversaciones').select('*').eq('wa_id', waId).maybeSingle();
    if (!conv || conv.estado !== 'escalated' || !dentroDeVentana(conv.ultimo_entrante_en as string | null)) return false;
    const msgs = await mensajesDe(waId, 60);
    const ultimoCliente = [...msgs].reverse().find((m) => m.origen === 'cliente');
    if (!ultimoCliente || conv.borrador_para_msg === ultimoCliente.id) return false;
    const humanoDespues = msgs.some((m) => m.origen === 'humano' && m.creado_en > ultimoCliente.creado_en);
    if (humanoDespues || await hayPendiente(waId)) return false;
    const r = await proponerRespuestaWhatsapp(waId, {});
    return r.ok;
}

export async function proponerRespuestaWhatsapp(
    waId: string,
    opts: { contexto_extra?: string },
): Promise<{ ok: boolean; accion_id?: string; detalle?: string }> {
    const { data: conv } = await supabase.from('wa_conversaciones').select('*').eq('wa_id', waId).maybeSingle() as { data: FilaConv | null };
    if (!conv) return { ok: false, detalle: 'Conversación no encontrada (sincronizá primero)' };
    if (await hayPendiente(waId)) return { ok: false, detalle: 'Ya hay una respuesta esperando aprobación en Acciones' };

    const msgs = await mensajesDe(waId, 40);
    if (msgs.length === 0) return { ok: false, detalle: 'La conversación no tiene mensajes' };
    const ultimoCliente = [...msgs].reverse().find((m) => m.origen === 'cliente');

    const { data: fila } = await supabase.from('asistentes').select('id, prompt, modelo, activo').eq('area', 'whatsapp').maybeSingle();
    if (fila && fila.activo === false) return { ok: false, detalle: 'El asistente WhatsApp está desactivado' };
    const modelo = ((fila?.modelo as ModeloClaude | undefined) ?? 'sonnet');
    const promptBase = (fila?.prompt as string | null)?.trim() || PROMPT_DEFAULT;

    type ClienteCtx = { nombre: string; email: string | null; estado: string | null; metadata: Record<string, unknown> | null };
    let cliente: ClienteCtx | null = null;
    let bloqueCorreos = '';
    if (conv.cliente_id) {
        const { data } = await supabase.from('clientes').select('nombre, email, estado, metadata').eq('id', conv.cliente_id).maybeSingle();
        cliente = (data as ClienteCtx | null) ?? null;
        const correos = await historicoConCliente(conv.cliente_id, 5);
        if (correos.length > 0) {
            bloqueCorreos = '\n\nCORREOS RECIENTES CON ESTE CLIENTE:\n' + correos.slice().reverse().map((h) =>
                `[${new Date(h.fecha).toISOString().slice(0, 10)}] ${h.direccion === 'saliente' ? 'BARTEZ →' : 'CLIENTE →'} ${h.asunto ?? ''}\n${(h.cuerpo ?? '').replace(/\s+/g, ' ').slice(0, 300)}`,
            ).join('\n\n');
        }
    }

    const web = (await textoWebBartez().catch(() => '')).slice(0, 3000);
    const system = await conLecciones([
        promptBase,
        contextoFecha(),
        web ? `\nINFORMACIÓN DE BARTEZ (de la web):\n${web}` : '',
    ].join('\n'), fila?.id as string | undefined);

    const quien = (o: string) => (o === 'cliente' ? 'CLIENTE' : o === 'bot' ? 'BOT WEB' : 'BARTEZ');
    const hilo = msgs.map((m) =>
        `[${new Date(m.creado_en).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' })}] ${quien(m.origen)}: ${(m.cuerpo ?? '(sin texto)').slice(0, 600)}`,
    ).join('\n');

    const consigna = [
        `Contacto: ${conv.nombre ?? 'sin nombre'} (WhatsApp)`,
        conv.categoria ? `Categoría que asignó el bot: ${conv.categoria}` : null,
        cliente ? `Cliente registrado: ${cliente.nombre}${cliente.estado ? ` (estado: ${cliente.estado})` : ''}` : 'No está registrado como cliente todavía.',
        cliente?.metadata?.senial ? `Señal comercial: ${String(cliente.metadata.senial)}` : null,
        bloqueCorreos,
        `\nCONVERSACIÓN DE WHATSAPP (cronológica):\n${hilo}`,
        opts.contexto_extra?.trim()
            ? `\nCONTEXTO DEL OPERADOR (tratalo como verdad, puede venir de llamadas u otros canales):\n${opts.contexto_extra.trim().slice(0, 1500)}`
            : null,
        '\nRedactá el próximo mensaje de Bartez para este cliente.',
    ].filter(Boolean).join('\n');

    const inicio = Date.now();
    const resp = await anthropic.messages.create({
        model: idModelo(modelo),
        max_tokens: 600,
        system,
        messages: [{ role: 'user', content: consigna }],
    });
    const texto = resp.content
        .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
        .map((c) => c.text).join('\n').trim()
        .replace(/^["«]|["»]$/g, '');
    if (!texto) return { ok: false, detalle: 'El asistente no devolvió texto' };
    const costo = calcularCosto(modelo, resp.usage.input_tokens, resp.usage.output_tokens);

    if (fila?.id) {
        await supabase.from('logs_asistente').insert({
            asistente_id: fila.id,
            entrada: { origen: 'whatsapp', wa_id: waId },
            salida: { respuesta: texto },
            tokens_in: resp.usage.input_tokens,
            tokens_out: resp.usage.output_tokens,
            costo_usd: costo,
            duracion_ms: Date.now() - inicio,
        });
    }

    const { data: accion, error } = await supabase.from('acciones_pendientes').insert({
        asistente_id: fila?.id ?? null,
        accion: 'enviar_whatsapp',
        estado: 'pendiente',
        payload: {
            waId,
            cuerpo: texto,
            nombreContacto: conv.nombre,
            nombreCliente: cliente?.nombre ?? null,
            clienteId: conv.cliente_id,
            ultimoEntranteEn: conv.ultimo_entrante_en,
            conversacion: msgs.slice(-8).map((m) => ({ origen: m.origen, cuerpo: m.cuerpo, fecha: m.creado_en })),
        },
        respuesta: conv.cliente_id ? { cliente_id: conv.cliente_id } : null,
    }).select('id').single();
    if (error) return { ok: false, detalle: error.message };

    if (ultimoCliente) await supabase.from('wa_conversaciones').update({ borrador_para_msg: ultimoCliente.id }).eq('wa_id', waId);
    return { ok: true, accion_id: accion.id as string };
}

// ---------- Envío (lo llama el ejecutor al aprobar) ----------

export async function enviarWhatsapp(waId: string, cuerpo: string, clienteId?: string | null): Promise<{ ok: boolean; detalle?: string; id?: string }> {
    const { data: conv } = await supabase.from('wa_conversaciones').select('ultimo_entrante_en').eq('wa_id', waId).maybeSingle();
    if (conv && !dentroDeVentana(conv.ultimo_entrante_en as string | null)) {
        return {
            ok: false,
            detalle: 'Pasaron más de 24 h desde el último mensaje del cliente: WhatsApp solo permite escribirle con una plantilla aprobada.',
        };
    }
    const enviado = await enviarTextoStudio(waId, cuerpo);
    await supabase.from('wa_mensajes').upsert({
        id: enviado.id,
        wa_id: waId,
        wa_message_id: enviado.waMessageId,
        direccion: 'outbound',
        origen: 'humano',
        tipo: 'text',
        cuerpo,
        creado_en: enviado.createdAt ?? new Date().toISOString(),
    }, { onConflict: 'id' });
    await supabase.from('wa_conversaciones').update({
        ultimo_mensaje: cuerpo.slice(0, 500),
        ultimo_direccion: 'humano',
        actualizado_en: enviado.createdAt ?? new Date().toISOString(),
    }).eq('wa_id', waId);
    if (clienteId) {
        const { data: c } = await supabase.from('clientes').select('intentos_contacto').eq('id', clienteId).maybeSingle();
        await supabase.from('clientes').update({
            ultimo_contacto_en: new Date().toISOString(),
            intentos_contacto: (c?.intentos_contacto ?? 0) + 1,
        }).eq('id', clienteId);
    }
    return { ok: true, id: enviado.id };
}

// ---------- Consultas para el panel ----------

export async function listarConversacionesWa() {
    const { data, error } = await supabase
        .from('wa_conversaciones')
        .select('wa_id, nombre, estado, categoria, cliente_id, actualizado_en, ultimo_entrante_en, ultimo_mensaje, ultimo_direccion, clientes(nombre)')
        .order('actualizado_en', { ascending: false, nullsFirst: false })
        .limit(300);
    if (error) throw new Error(error.message);
    const { data: pend } = await supabase
        .from('acciones_pendientes')
        .select('payload')
        .eq('accion', 'enviar_whatsapp')
        .eq('estado', 'pendiente');
    const conPendiente = new Set((pend ?? []).map((p) => (p.payload as { waId?: string })?.waId));
    return (data ?? []).map((c) => ({
        wa_id: c.wa_id as string,
        nombre: c.nombre as string | null,
        estado: c.estado as string | null,
        categoria: c.categoria as string | null,
        cliente_id: c.cliente_id as string | null,
        cliente_nombre: ((c as { clientes?: { nombre?: string } | null }).clientes?.nombre) ?? null,
        actualizado_en: c.actualizado_en as string | null,
        ultimo_mensaje: c.ultimo_mensaje as string | null,
        ultimo_origen: c.ultimo_direccion as string | null,
        en_ventana: dentroDeVentana(c.ultimo_entrante_en as string | null),
        ventana_hasta: c.ultimo_entrante_en ? new Date(new Date(c.ultimo_entrante_en as string).getTime() + VENTANA_MS).toISOString() : null,
        respuesta_pendiente: conPendiente.has(c.wa_id as string),
    }));
}

export async function detalleConversacionWa(waId: string) {
    const { data: conv } = await supabase.from('wa_conversaciones').select('*, clientes(nombre, email)').eq('wa_id', waId).maybeSingle();
    if (!conv) return null;
    const mensajes = await mensajesDe(waId, 500);
    return { conversacion: { ...conv, en_ventana: dentroDeVentana(conv.ultimo_entrante_en as string | null) }, mensajes };
}

export async function mensajesWhatsappDeCliente(clienteId: string, limite = 30) {
    const { data: convs } = await supabase.from('wa_conversaciones').select('wa_id').eq('cliente_id', clienteId);
    const ids = (convs ?? []).map((c) => c.wa_id as string);
    if (ids.length === 0) return [];
    const { data } = await supabase
        .from('wa_mensajes')
        .select('id, wa_id, direccion, origen, cuerpo, creado_en')
        .in('wa_id', ids)
        .order('creado_en', { ascending: false })
        .limit(limite);
    return (data ?? []) as Array<{ id: string; wa_id: string; direccion: string; origen: string; cuerpo: string | null; creado_en: string }>;
}

export async function vincularClienteWa(waId: string, clienteId: string | null): Promise<boolean> {
    const { data, error } = await supabase.from('wa_conversaciones').update({ cliente_id: clienteId }).eq('wa_id', waId).select('wa_id');
    if (error) throw new Error(error.message);
    return (data ?? []).length > 0;
}

// Crea un cliente a partir de la conversación (nombre de perfil + número) y la vincula.
export async function crearClienteDesdeWa(waId: string, nombre?: string): Promise<{ ok: boolean; cliente_id?: string; detalle?: string }> {
    const { data: conv } = await supabase.from('wa_conversaciones').select('nombre, cliente_id').eq('wa_id', waId).maybeSingle();
    if (!conv) return { ok: false, detalle: 'Conversación no encontrada' };
    if (conv.cliente_id) return { ok: true, cliente_id: conv.cliente_id as string };
    const { data: nuevo, error } = await supabase.from('clientes').insert({
        nombre: (nombre?.trim() || (conv.nombre as string | null) || `WhatsApp ${waId.slice(-4)}`),
        whatsapp: `+${waId}`,
        origen: 'whatsapp',
        estado: 'lead',
    }).select('id').single();
    if (error) return { ok: false, detalle: error.message };
    await vincularClienteWa(waId, nuevo.id as string);
    return { ok: true, cliente_id: nuevo.id as string };
}
