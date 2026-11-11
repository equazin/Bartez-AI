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

import { anthropic, calcularCosto, idModelo, maxTokens, opcionesModelo, textoDe } from '../connectors/anthropic.js';
import type { ModeloClaude } from './types.js';
import { textoWebBartez } from '../connectors/bartez_web.js';
import {
    ConversacionStudio,
    MensajeStudio,
    enviarPlantillaStudio,
    enviarTextoStudio,
    listarConversacionesStudio,
    obtenerConversacionStudio,
    studioConfigurado,
} from '../connectors/studio.js';
import { supabase } from '../connectors/supabase.js';
import { contextoFecha } from '../assistants/base.js';
import { conLecciones, registrarCorreccion } from './aprendizaje.js';
import { historicoConCliente } from '../inbound/importar_historico.js';
import { bloqueMemoria } from './memoria.js';
import { claveTelefono } from './clientes.js';

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

// ---------- Ajustes: con qué nombre se presenta ----------

const CLAVE_AJUSTES = 'whatsapp_ajustes';
export interface AjustesWa { presentarse_como: string }

export async function ajustesWa(): Promise<AjustesWa> {
    const { data } = await supabase.from('integraciones_config').select('valor').eq('clave', CLAVE_AJUSTES).maybeSingle();
    try {
        const v = JSON.parse(String(data?.valor ?? '{}')) as Partial<AjustesWa>;
        return { presentarse_como: typeof v.presentarse_como === 'string' ? v.presentarse_como.trim() : '' };
    } catch { return { presentarse_como: '' }; }
}

export async function guardarAjustesWa(a: AjustesWa): Promise<void> {
    const valor = JSON.stringify({ presentarse_como: a.presentarse_como.trim().slice(0, 60) });
    const { error } = await supabase.from('integraciones_config').upsert({ clave: CLAVE_AJUSTES, valor, actualizado_en: new Date().toISOString() });
    if (error) throw new Error(error.message);
}

// Va siempre, aunque el prompt del asistente se haya editado: sin esto el modelo
// inventaba un nombre para presentarse ("Soy Magalí del equipo comercial").
function bloqueIdentidad(nombre: string): string {
    return [
        'QUIÉN RESPONDE:',
        nombre
            ? `- Escribís en nombre de ${nombre}, del equipo comercial de Bartez. Si te presentás, sos ${nombre}; nunca uses otro nombre.`
            : '- Si te presentás, decí solo que sos del equipo comercial de Bartez, sin nombre propio.',
        '- Nunca inventes nombres de personas: ni el tuyo ni los de otros.',
        '- Si Bartez ya le venía escribiendo en esta conversación, no hace falta presentarse de nuevo.',
    ].join('\n');
}

// ---------- Teléfonos ----------

async function clientePorTelefono(waId: string): Promise<string | null> {
    const clave = claveTelefono(waId);
    if (!clave) return null;
    const { data } = await supabase.from('clientes').select('id, whatsapp').not('whatsapp', 'is', null).ilike('whatsapp', `%${clave.slice(-4)}%`);
    // Mismo número aunque esté escrito con 0, 15, +54 o 9 (ver clientes.ts).
    const coinciden = (data ?? []).filter((c) => claveTelefono(String(c.whatsapp ?? '')) === clave);
    return coinciden.length === 1 ? (coinciden[0]!.id as string) : null;
}

// ---------- Sincronización ----------

function origenDe(m: MensajeStudio): 'cliente' | 'bot' | 'humano' {
    if (m.direction === 'inbound') return 'cliente';
    return m.waMessageId.startsWith('bot_') ? 'bot' : 'humano';
}

// Un archivo que mandó Bartez se ve como "📎 nombre" aunque la web no guarde texto.
function cuerpoDe(m: MensajeStudio): string | null {
    if (m.body) return m.body;
    const adj = (m.metadata as { attachment?: { filename?: unknown } } | null)?.attachment;
    return typeof adj?.filename === 'string' ? `📎 ${adj.filename}` : null;
}

// `guardados`: ids que ya están en wa_mensajes (solo se escriben los demás).
async function guardarConversacion(c: ConversacionStudio, guardados?: Set<string>): Promise<void> {
    const mensajes = [...c.messages].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    if (mensajes.length > 0) {
        const filas = mensajes.filter((m) => !guardados?.has(m.id)).map((m) => ({
            id: m.id,
            wa_id: c.waId,
            wa_message_id: m.waMessageId,
            direccion: m.direction,
            origen: origenDe(m),
            tipo: m.type,
            cuerpo: cuerpoDe(m),
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
    // La web no mueve updatedAt con cada mensaje: para ordenar la lista vale lo
    // más nuevo entre los dos.
    const actualizado = ultimo && new Date(ultimo.createdAt).getTime() > new Date(c.updatedAt).getTime() ? ultimo.createdAt : c.updatedAt;
    const { error } = await supabase.from('wa_conversaciones').upsert({
        wa_id: c.waId,
        studio_id: c.id,
        nombre: c.profileName,
        estado: c.status,
        categoria: c.category,
        cliente_id: clienteId,
        actualizado_en: actualizado,
        ultimo_entrante_en: ultimoEntrante?.createdAt ?? null,
        ultimo_mensaje: (ultimo ? cuerpoDe(ultimo) : null)?.slice(0, 500) ?? null,
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

// Ids de mensajes que ya están guardados.
async function idsGuardados(ids: string[]): Promise<Set<string>> {
    const tenemos = new Set<string>();
    for (let i = 0; i < ids.length; i += 100) {
        const { data, error } = await supabase.from('wa_mensajes').select('id').in('id', ids.slice(i, i + 100));
        if (error) throw new Error(`wa_mensajes: ${error.message}`);
        for (const f of data ?? []) tenemos.add(f.id as string);
    }
    return tenemos;
}

// Qué conversaciones hay que traer completas. La web no mueve el updatedAt de
// la conversación cuando escribe el cliente ni cuando contesta el bot (solo al
// cambiar estado o categoría, o al responder por su API): por eso además se
// mira el último mensaje que trae la lista. Si no lo tenemos, hay mensajes nuevos.
export function conversacionesACambiar(
    remotas: ConversacionStudio[],
    conocidas: Map<string, string | null>,
    guardados: Set<string>,
): ConversacionStudio[] {
    return remotas.filter((r) => {
        if (!conocidas.has(r.waId)) return true;
        const previa = conocidas.get(r.waId);
        if (!previa || new Date(r.updatedAt).getTime() > new Date(previa).getTime()) return true;
        const ultimo = r.messages?.[0];
        return !!ultimo && !guardados.has(ultimo.id);
    });
}

export async function sincronizarWhatsapp(opts: { proponer?: boolean } = {}): Promise<ResultadoSyncWa> {
    if (!studioConfigurado()) return { ok: false, conversaciones: 0, actualizadas: 0, borradores: 0, detalle: 'Falta STUDIO_API_TOKEN en el .env' };
    if (sincronizando) return { ok: false, conversaciones: 0, actualizadas: 0, borradores: 0, detalle: 'Ya hay una sincronización en curso' };
    sincronizando = true;
    try {
        const remotas = await listarConversacionesStudio();
        const { data: locales, error } = await supabase.from('wa_conversaciones').select('wa_id, actualizado_en');
        if (error) throw new Error(`wa_conversaciones: ${error.message}`);
        const conocidas = new Map((locales ?? []).map((l) => [l.wa_id as string, l.actualizado_en as string | null]));
        const ultimos = remotas.map((r) => r.messages?.[0]?.id).filter((id): id is string => !!id);
        const cambiadas = conversacionesACambiar(remotas, conocidas, await idsGuardados(ultimos));

        let actualizadas = 0;
        const tocadas: string[] = [];
        for (const r of cambiadas) {
            const completa = await obtenerConversacionStudio(r.waId);
            await guardarConversacion(completa);
            ultimaConsulta.set(r.waId, Date.now());
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

// ---------- Una conversación puntual ----------
//
// Directo de la web: al abrirla en el panel, mientras se chatea o cuando la web
// avisa que entró un mensaje. Una sola consulta cada `cadaMs` por conversación,
// para no cargar la web (su base tiene cuota de transferencia).

const ultimaConsulta = new Map<string, number>();

export async function refrescarConversacionWa(
    waId: string,
    opts: { cadaMs?: number; proponer?: boolean } = {},
): Promise<{ consultada: boolean; nuevos: number }> {
    if (!studioConfigurado()) return { consultada: false, nuevos: 0 };
    const ahora = Date.now();
    if (ahora - (ultimaConsulta.get(waId) ?? 0) < (opts.cadaMs ?? 10_000)) return { consultada: false, nuevos: 0 };
    ultimaConsulta.set(waId, ahora);
    if (ultimaConsulta.size > 1000) {
        for (const [k, t] of ultimaConsulta) if (ahora - t > 3600_000) ultimaConsulta.delete(k);
    }
    const completa = await obtenerConversacionStudio(waId);
    const guardados = await idsGuardados(completa.messages.map((m) => m.id));
    const nuevos = completa.messages.filter((m) => !guardados.has(m.id)).length;
    await guardarConversacion(completa, guardados); // solo escribe lo que falta
    if (nuevos > 0 && opts.proponer !== false) {
        await proponerSiCorresponde(waId).catch((err) => {
            console.warn('[whatsapp] no se pudo proponer respuesta', waId, (err as Error).message);
            return false;
        });
    }
    return { consultada: true, nuevos };
}

// ---------- Aviso de la web ----------
//
// Cuando la web avisa (POST /whatsapp/aviso) que una conversación tuvo un
// mensaje, se trae esa sola en ~1 segundo. Mientras los avisos lleguen, la
// lista completa se revisa cada 5 minutos como red de seguridad.

let ultimoAviso = 0;
const avisosEnEspera = new Map<string, ReturnType<typeof setTimeout>>();

export const avisosActivos = () => Date.now() - ultimoAviso < 24 * 3600_000;

export function avisoDeLaWeb(waId: string): void {
    ultimoAviso = Date.now();
    if (avisosEnEspera.has(waId)) return; // juntamos los que llegan seguidos
    avisosEnEspera.set(waId, setTimeout(() => {
        avisosEnEspera.delete(waId);
        refrescarConversacionWa(waId, { cadaMs: 0 })
            .catch((err) => console.warn('[whatsapp] aviso de la web', waId, (err as Error).message));
    }, 1200));
}

// Cada cuántos minutos se revisa la lista completa de la web: cada minuto en
// horario comercial (lunes a sábado de 8 a 20), cada 5 el resto del tiempo o
// si los avisos de la web ya están funcionando.
export function minutosEntreSyncs(fecha: Date, conAvisos: boolean): number {
    if (conAvisos) return 5;
    const partes = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Argentina/Buenos_Aires', weekday: 'short', hour: 'numeric', hourCycle: 'h23',
    }).formatToParts(fecha);
    const dia = partes.find((p) => p.type === 'weekday')?.value;
    const hora = Number(partes.find((p) => p.type === 'hour')?.value);
    return dia !== 'Sun' && hora >= 8 && hora < 20 ? 1 : 5;
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
        .select('id, direccion, origen, tipo, cuerpo, creado_en')
        .eq('wa_id', waId)
        .order('creado_en', { ascending: false })
        .limit(limite);
    return (data ?? []).reverse() as Array<{ id: string; direccion: string; origen: string; tipo: string | null; cuerpo: string | null; creado_en: string }>;
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

// Una propuesta a la vez por conversación (la sync, los avisos de la web y el
// panel pueden llegar juntos).
const proponiendo = new Set<string>();

async function proponerSiCorresponde(waId: string): Promise<boolean> {
    if (proponiendo.has(waId)) return false;
    proponiendo.add(waId);
    try { return await proponerSiCorrespondeSinGuardia(waId); }
    finally { proponiendo.delete(waId); }
}

// Automático: solo escaladas, con un mensaje del cliente sin respuesta humana,
// dentro de la ventana de 24 h, y una sola propuesta por mensaje.
async function proponerSiCorrespondeSinGuardia(waId: string): Promise<boolean> {
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

interface Redaccion {
    ok: boolean;
    detalle?: string;
    texto?: string;
    conv?: FilaConv;
    asistenteId?: string;
    clienteNombre?: string | null;
    msgs?: Awaited<ReturnType<typeof mensajesDe>>;
    ultimoClienteId?: string;
}

// Pide al asistente el próximo mensaje para la conversación. No envía nada ni
// deja nada en Para aprobar: eso lo deciden proponerRespuestaWhatsapp o el panel.
async function redactarWhatsapp(
    waId: string,
    opts: { contexto_extra?: string; borrador_operador?: string },
): Promise<Redaccion> {
    const { data: conv } = await supabase.from('wa_conversaciones').select('*').eq('wa_id', waId).maybeSingle() as { data: FilaConv | null };
    if (!conv) return { ok: false, detalle: 'Conversación no encontrada (sincronizá primero)' };

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
    const { presentarse_como } = await ajustesWa();
    const system = await conLecciones([
        promptBase,
        bloqueIdentidad(presentarse_como),
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
        conv.cliente_id ? await bloqueMemoria(conv.cliente_id) : null,
        `\nCONVERSACIÓN DE WHATSAPP (cronológica):\n${hilo}`,
        opts.contexto_extra?.trim()
            ? `\nCONTEXTO DEL OPERADOR (tratalo como verdad, puede venir de llamadas u otros canales):\n${opts.contexto_extra.trim().slice(0, 1500)}`
            : null,
        opts.borrador_operador?.trim()
            ? `\nLO QUE QUIERE DECIR EL OPERADOR (un borrador o una indicación): respetá lo que quiere decir y dejalo listo para enviar, sin agregar datos que no estén:\n${opts.borrador_operador.trim().slice(0, 3000)}`
            : null,
        '\nRedactá el próximo mensaje de Bartez para este cliente.',
    ].filter(Boolean).join('\n');

    const inicio = Date.now();
    const resp = await anthropic.messages.create({
        ...opcionesModelo(modelo, 'low'),
        max_tokens: maxTokens(modelo, 600),
        system,
        messages: [{ role: 'user', content: consigna }],
    });
    const texto = textoDe(resp)
        .replace(/^["«]|["»]$/g, '');
    if (!texto) return { ok: false, detalle: 'El asistente no devolvió texto' };
    const costo = calcularCosto(modelo, resp.usage.input_tokens, resp.usage.output_tokens);

    if (fila?.id) {
        await supabase.from('logs_asistente').insert({
            asistente_id: fila.id,
            entrada: { origen: 'whatsapp', wa_id: waId, borrador: !!opts.borrador_operador },
            salida: { respuesta: texto },
            tokens_in: resp.usage.input_tokens,
            tokens_out: resp.usage.output_tokens,
            costo_usd: costo,
            duracion_ms: Date.now() - inicio,
        });
    }
    return { ok: true, texto, conv, asistenteId: fila?.id as string | undefined, clienteNombre: cliente?.nombre ?? null, msgs, ultimoClienteId: ultimoCliente?.id };
}

// Borrador para la caja del chat: lo que escribió el operador (si escribió algo)
// pasado en limpio, o una respuesta desde cero. No queda en Para aprobar.
export async function borradorWhatsapp(waId: string, borradorOperador?: string): Promise<{ ok: boolean; texto?: string; detalle?: string }> {
    const r = await redactarWhatsapp(waId, { borrador_operador: borradorOperador });
    return r.ok ? { ok: true, texto: r.texto } : { ok: false, detalle: r.detalle };
}

// Propuesta que queda en Para aprobar (la usa la sincronización cuando el bot
// deriva una conversación).
export async function proponerRespuestaWhatsapp(
    waId: string,
    opts: { contexto_extra?: string },
): Promise<{ ok: boolean; accion_id?: string; detalle?: string }> {
    if (await hayPendiente(waId)) return { ok: false, detalle: 'Ya hay una respuesta esperando aprobación en Acciones' };
    const r = await redactarWhatsapp(waId, opts);
    if (!r.ok || !r.texto || !r.conv || !r.msgs) return { ok: false, detalle: r.detalle };
    const { texto, conv, msgs } = r;

    const { data: accion, error } = await supabase.from('acciones_pendientes').insert({
        asistente_id: r.asistenteId ?? null,
        accion: 'enviar_whatsapp',
        estado: 'pendiente',
        payload: {
            waId,
            cuerpo: texto,
            nombreContacto: conv.nombre,
            nombreCliente: r.clienteNombre ?? null,
            clienteId: conv.cliente_id,
            ultimoEntranteEn: conv.ultimo_entrante_en,
            conversacion: msgs.slice(-8).map((m) => ({ origen: m.origen, cuerpo: m.cuerpo, fecha: m.creado_en })),
        },
        respuesta: conv.cliente_id ? { cliente_id: conv.cliente_id } : null,
    }).select('id').single();
    if (error) return { ok: false, detalle: error.message };

    if (r.ultimoClienteId) await supabase.from('wa_conversaciones').update({ borrador_para_msg: r.ultimoClienteId }).eq('wa_id', waId);
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
    await registrarSalienteWa(waId, enviado, cuerpo, 'text', clienteId);
    return { ok: true, id: enviado.id };
}

// Lo que salió por la web queda al instante en el chat y en la ficha del cliente.
export async function registrarSalienteWa(
    waId: string,
    enviado: MensajeStudio,
    cuerpo: string,
    tipo: string,
    clienteId?: string | null,
): Promise<void> {
    const creado = enviado.createdAt ?? new Date().toISOString();
    await supabase.from('wa_mensajes').upsert({
        id: enviado.id,
        wa_id: waId,
        wa_message_id: enviado.waMessageId,
        direccion: 'outbound',
        origen: 'humano',
        tipo,
        cuerpo,
        creado_en: creado,
    }, { onConflict: 'id' });
    await supabase.from('wa_conversaciones').update({
        ultimo_mensaje: cuerpo.slice(0, 500),
        ultimo_direccion: 'humano',
        actualizado_en: creado,
    }).eq('wa_id', waId);
    if (clienteId) {
        const { data: c } = await supabase.from('clientes').select('intentos_contacto').eq('id', clienteId).maybeSingle();
        await supabase.from('clientes').update({
            ultimo_contacto_en: new Date().toISOString(),
            intentos_contacto: (c?.intentos_contacto ?? 0) + 1,
        }).eq('id', clienteId);
    }
}

// ---------- Respuesta a mano desde el panel ----------

// Manda lo que escribió el operador (dentro de las 24 h). Si había una propuesta
// esperando en Para aprobar, queda descartada para que no salga después; si el
// texto partió de esa propuesta, lo que cambió se guarda como aprendizaje.
export async function responderWhatsappAMano(
    waId: string,
    texto: string,
    desdePropuesta?: string | null,
): Promise<{ ok: boolean; detalle?: string; mensaje?: { id: string; cuerpo: string; origen: 'humano'; creado_en: string } }> {
    const cuerpo = texto.trim();
    if (!cuerpo) return { ok: false, detalle: 'El mensaje está vacío' };
    const { data: conv } = await supabase.from('wa_conversaciones').select('cliente_id').eq('wa_id', waId).maybeSingle();
    if (!conv) return { ok: false, detalle: 'Conversación no encontrada (sincronizá primero)' };
    const r = await enviarWhatsapp(waId, cuerpo, conv.cliente_id as string | null);
    if (!r.ok) return { ok: false, detalle: r.detalle };

    const { data: pendientes } = await supabase.from('acciones_pendientes').select('*')
        .eq('accion', 'enviar_whatsapp').eq('estado', 'pendiente').contains('payload', { waId });
    for (const a of pendientes ?? []) {
        if (a.id === desdePropuesta) {
            void registrarCorreccion(a, 'edicion', { payloadNuevo: { ...(a.payload as Record<string, unknown>), cuerpo } });
        }
        await supabase.from('acciones_pendientes').update({
            estado: 'descartada',
            respuesta: { por: 'humano', nota: 'Respondido a mano desde el chat de WhatsApp', enviado: cuerpo.slice(0, 500) },
            resuelto_en: new Date().toISOString(),
        }).eq('id', a.id).eq('estado', 'pendiente');
    }
    return { ok: true, mensaje: { id: r.id ?? `local-${Date.now()}`, cuerpo, origen: 'humano', creado_en: new Date().toISOString() } };
}

// El operador ya contestó por otro lado (un archivo con texto): la propuesta que
// esperaba en Para aprobar para este contacto queda descartada.
export async function descartarPropuestasWa(waId: string, nota: string): Promise<void> {
    await supabase.from('acciones_pendientes').update({
        estado: 'descartada',
        respuesta: { por: 'humano', nota },
        resuelto_en: new Date().toISOString(),
    }).eq('accion', 'enviar_whatsapp').eq('estado', 'pendiente').contains('payload', { waId });
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
    const lista = await mensajesDe(waId, 500);
    // Archivos que mandó Bartez (para abrirlos desde el chat).
    const { data: adjs } = await supabase.from('wa_adjuntos')
        .select('id, mensaje_id, nombre, tipo_mime, enviado_como, texto')
        .eq('wa_id', waId).not('mensaje_id', 'is', null);
    const porMensaje = new Map((adjs ?? []).map((a) => [a.mensaje_id as string, {
        id: a.id as string, nombre: a.nombre as string, mime: a.tipo_mime as string,
        como: a.enviado_como as 'adjunto' | 'link' | null, texto: (a.texto as string | null) ?? null,
    }]));
    const mensajes = lista.map((m) => ({ ...m, adjunto: porMensaje.get(m.id) ?? null }));
    // La propuesta de Bartez que espera en Para aprobar, para usarla desde el chat.
    const { data: pend } = await supabase.from('acciones_pendientes').select('id, payload, creado_en')
        .eq('accion', 'enviar_whatsapp').eq('estado', 'pendiente').contains('payload', { waId })
        .order('creado_en', { ascending: false }).limit(1);
    const p = pend?.[0];
    const propuesta = p && typeof (p.payload as { cuerpo?: unknown })?.cuerpo === 'string'
        ? { accion_id: p.id as string, cuerpo: (p.payload as { cuerpo: string }).cuerpo, creado_en: p.creado_en as string }
        : null;
    return { conversacion: { ...conv, en_ventana: dentroDeVentana(conv.ultimo_entrante_en as string | null) }, mensajes, propuesta };
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

// ---------- Plantillas (para escribir fuera de la ventana de 24 h) ----------
//
// WhatsApp solo deja iniciar o retomar una conversación vencida con una
// plantilla aprobada por Meta. La API del bot no las lista, así que se cargan
// acá con el mismo nombre, idioma y texto que tienen en Meta ({{1}}, {{2}}…
// son los valores que se completan en cada envío).

export interface PlantillaWa {
    nombre: string;
    idioma: string;
    texto: string;
    descripcion?: string;
}

const CLAVE_PLANTILLAS = 'wa_plantillas';

export async function listarPlantillasWa(): Promise<PlantillaWa[]> {
    const { data } = await supabase.from('integraciones_config').select('valor').eq('clave', CLAVE_PLANTILLAS).maybeSingle();
    try { return data?.valor ? (JSON.parse(data.valor as string) as PlantillaWa[]) : []; } catch { return []; }
}

export async function guardarPlantillasWa(plantillas: PlantillaWa[]): Promise<void> {
    await supabase.from('integraciones_config').upsert({ clave: CLAVE_PLANTILLAS, valor: JSON.stringify(plantillas), actualizado_en: new Date().toISOString() });
}

export const cantidadParametros = (texto: string) =>
    Math.max(0, ...[...texto.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1])));

export const textoConParametros = (texto: string, parametros: string[]) =>
    texto.replace(/\{\{(\d+)\}\}/g, (_m, n: string) => parametros[Number(n) - 1] ?? `{{${n}}}`);

// Deja en Para aprobar el envío de una plantilla (nada sale sin tu OK).
export async function proponerPlantillaWa(
    waId: string,
    nombre: string,
    parametros: string[],
): Promise<{ ok: boolean; accion_id?: string; detalle?: string }> {
    const plantilla = (await listarPlantillasWa()).find((p) => p.nombre === nombre);
    if (!plantilla) return { ok: false, detalle: 'Esa plantilla no está cargada' };
    const faltan = cantidadParametros(plantilla.texto) - parametros.filter((p) => p.trim()).length;
    if (faltan > 0) return { ok: false, detalle: `Faltan ${faltan} valor${faltan > 1 ? 'es' : ''} para completar la plantilla` };
    const { data: conv } = await supabase.from('wa_conversaciones').select('*').eq('wa_id', waId).maybeSingle() as { data: FilaConv | null };
    if (!conv) return { ok: false, detalle: 'Conversación no encontrada (sincronizá primero)' };
    if (await hayPendiente(waId)) return { ok: false, detalle: 'Ya hay un mensaje esperando aprobación para este contacto' };

    let nombreCliente: string | null = null;
    if (conv.cliente_id) {
        const { data } = await supabase.from('clientes').select('nombre').eq('id', conv.cliente_id).maybeSingle();
        nombreCliente = (data?.nombre as string | null) ?? null;
    }
    const msgs = await mensajesDe(waId, 8);
    const { data: asist } = await supabase.from('asistentes').select('id').eq('area', 'whatsapp').maybeSingle();
    const vista = textoConParametros(plantilla.texto, parametros);
    const { data: accion, error } = await supabase.from('acciones_pendientes').insert({
        asistente_id: asist?.id ?? null,
        accion: 'enviar_whatsapp',
        estado: 'pendiente',
        payload: {
            waId,
            cuerpo: vista,
            plantilla: { nombre: plantilla.nombre, idioma: plantilla.idioma, parametros },
            nombreContacto: conv.nombre,
            nombreCliente,
            clienteId: conv.cliente_id,
            ultimoEntranteEn: conv.ultimo_entrante_en,
            conversacion: msgs.slice(-8).map((m) => ({ origen: m.origen, cuerpo: m.cuerpo, fecha: m.creado_en })),
        },
        respuesta: { por: 'humano', origen: 'plantilla_whatsapp' },
    }).select('id').single();
    if (error) return { ok: false, detalle: error.message };
    return { ok: true, accion_id: accion.id as string };
}

// La elige y completa el operador: sale ya, sin pasar por Para aprobar.
export async function enviarPlantillaAMano(
    waId: string,
    nombre: string,
    parametros: string[],
): Promise<{ ok: boolean; detalle?: string; mensaje?: { id: string; cuerpo: string; origen: 'humano'; creado_en: string } }> {
    const plantilla = (await listarPlantillasWa()).find((p) => p.nombre === nombre);
    if (!plantilla) return { ok: false, detalle: 'Esa plantilla no está cargada' };
    const faltan = cantidadParametros(plantilla.texto) - parametros.filter((p) => p.trim()).length;
    if (faltan > 0) return { ok: false, detalle: `Faltan ${faltan} valor${faltan > 1 ? 'es' : ''} para completar la plantilla` };
    const { data: conv } = await supabase.from('wa_conversaciones').select('cliente_id').eq('wa_id', waId).maybeSingle();
    if (!conv) return { ok: false, detalle: 'Conversación no encontrada (sincronizá primero)' };
    const vista = textoConParametros(plantilla.texto, parametros);
    const r = await enviarPlantillaWa(waId, { nombre: plantilla.nombre, idioma: plantilla.idioma, parametros }, vista, conv.cliente_id as string | null);
    if (!r.ok) return { ok: false, detalle: r.detalle };
    // Lo que esperaba en Para aprobar para este contacto ya no hace falta.
    await supabase.from('acciones_pendientes').update({
        estado: 'descartada',
        respuesta: { por: 'humano', nota: 'Se mandó una plantilla a mano desde el chat de WhatsApp' },
        resuelto_en: new Date().toISOString(),
    }).eq('accion', 'enviar_whatsapp').eq('estado', 'pendiente').contains('payload', { waId });
    return { ok: true, mensaje: { id: r.id ?? `local-${Date.now()}`, cuerpo: vista, origen: 'humano', creado_en: new Date().toISOString() } };
}

export async function enviarPlantillaWa(
    waId: string,
    plantilla: { nombre: string; idioma: string; parametros: string[] },
    vista: string,
    clienteId?: string | null,
): Promise<{ ok: boolean; detalle?: string; id?: string }> {
    const enviado = await enviarPlantillaStudio(waId, { nombre: plantilla.nombre, idioma: plantilla.idioma, parametros: plantilla.parametros, vista });
    await registrarSalienteWa(waId, enviado, vista, 'template', clienteId);
    return { ok: true, id: enviado.id };
}
