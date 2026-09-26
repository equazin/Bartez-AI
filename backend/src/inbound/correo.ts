// Entrada de correos: cada correo nuevo se convierte en una tarea del orquestador.
// Flujo: correo entra → buscar/crear cliente por email → crear conversación →
// enrutar(canal='correo') → el asistente de Correo genera respuesta → si
// autonomía < 100, va a acciones_pendientes esperando aprobación.

import { emailNormal, supabase } from '../connectors/supabase.js';
import { CorreoEntrante, iniciarListener } from '../connectors/ferozo.js';
import { enrutar } from '../orchestrator/router.js';
import { actualizarCotizacion, cotizar } from '../orchestrator/cotizador.js';
import { clasificarCorreo } from './clasificador.js';
import { registrarCorreoEnHistoria } from './registro_correos.js';
import { casillaCorreo } from '../connectors/ferozo.js';
import { esCorreoPropio, esLeadWeb, esProveedor, leerCorreoDeProveedor, parsearLeadWeb } from './filtros_correo.js';
import { crearCliente } from '../orchestrator/clientes.js';
import { crearNota } from '../orchestrator/memoria.js';
import { crearTareaEnNotion } from '../orchestrator/notion_sync.js';

// Aviso "Nuevo lead web" (formulario o bot de WhatsApp de la web): no se le
// contesta al aviso; el lead queda cargado con su teléfono y lo que necesita.
async function registrarLeadWeb(c: CorreoEntrante): Promise<string | null> {
    const l = parsearLeadWeb(c.cuerpo);
    if (!l.telefono && !l.email) return null;
    const nota = l.necesidad ? `Lead de la web${l.telefono ? ' (WhatsApp)' : ''}: ${l.necesidad}` : null;
    const r = await crearCliente({
        nombre: l.empresa || l.nombre || 'Lead web', email: l.email, whatsapp: l.telefono, estado: 'lead',
        contacto: l.empresa ? l.nombre : null, nota,
    }, { origen: 'web' });
    if (r.ok && r.cliente) return r.cliente.id;
    // Ya estaba (mismo teléfono o email): se le suma lo que pidió ahora.
    const mismo = r.parecidos?.find((p) => p.motivo === 'mismo teléfono' || p.motivo === 'mismo email');
    if (mismo) {
        if (nota) await crearNota(mismo.id, nota).catch(() => undefined);
        return mismo.id;
    }
    const nuevo = await crearCliente({ nombre: l.empresa || l.nombre || 'Lead web', email: l.email, whatsapp: l.telefono, estado: 'lead', contacto: l.empresa ? l.nombre : null, nota }, { origen: 'web', crearIgual: true });
    return nuevo.ok && nuevo.cliente ? nuevo.cliente.id : null;
}

async function buscarOCrearCliente(emailRecibido: string, nombre?: string): Promise<string | null> {
    // Buscar cliente existente por email, exacto y en minúscula: "MMarsilla@…" es
    // el mismo que "mmarsilla@…" (los emails de clientes se guardan en minúscula).
    const emailCliente = emailNormal(emailRecibido);
    const { data: existentes } = await supabase
        .from('clientes')
        .select('id')
        .eq('email', emailCliente)
        .limit(1);
    if (existentes?.[0]) return existentes[0].id as string;

    // Crear nuevo
    const { data: nuevo, error } = await supabase
        .from('clientes')
        .insert({
            nombre: nombre || emailCliente.split('@')[0] || 'Sin nombre',
            email: emailCliente,
            origen: 'entrante',
            estado: 'lead',
        })
        .select('id')
        .single();
    if (error || !nuevo) {
        console.error('[inbound-correo] no se pudo crear cliente:', error?.message);
        return null;
    }
    return nuevo.id as string;
}

async function buscarConversacionAbierta(clienteId: string, threadRef?: string): Promise<string | null> {
    // Si el correo es respuesta (In-Reply-To), buscar la conversación que ya existía
    if (threadRef) {
        const { data } = await supabase
            .from('conversaciones')
            .select('id')
            .eq('cliente_id', clienteId)
            .eq('canal', 'correo')
            .eq('estado', 'abierta')
            .order('creado_en', { ascending: false })
            .limit(1)
            .maybeSingle();
        if (data) return data.id as string;
    }
    return null;
}

export async function procesarCorreoEntrante(c: CorreoEntrante): Promise<void> {
    console.log(`[inbound-correo] correo de ${c.de}: "${c.asunto}"`);
    const historia = (clienteId: string | null, categoria: string, ignorable: boolean) => registrarCorreoEnHistoria({
        direccion: 'entrante', de: c.de, deNombre: c.deNombre ?? null, para: casillaCorreo, asunto: c.asunto, cuerpo: c.cuerpo,
        fecha: c.fecha, messageId: c.messageId, clienteId, categoria, ignorable, carpeta: 'INBOX',
    });

    // 0. Reglas fijas, antes de la IA.
    // Correos propios (avisos de Bartez AI que llegan a ventas@, envíos internos):
    // nunca se responden. El "Nuevo lead web" se carga como lead.
    if (esCorreoPropio(c.de, c.asunto)) {
        if (esLeadWeb(c.asunto)) {
            const id = await registrarLeadWeb(c).catch((err) => { console.warn('[inbound-correo] lead web:', (err as Error).message); return null; });
            await historia(id, 'lead_web', true);
            console.log(`[inbound-correo] lead web ${id ? 'cargado' : 'sin datos de contacto'}`);
        } else {
            await historia(null, 'interno', true);
        }
        return;
    }
    // Proveedores: nunca se les responde solo ni se les confirma una compra. Si
    // mandan una cotización, queda la tarea de armar el presupuesto al cliente.
    const prov = await esProveedor(c.de);
    if (prov.proveedor) {
        await historia(prov.clienteId, 'proveedor', false);
        const leido = await leerCorreoDeProveedor(c);
        if (leido.tarea) {
            await crearTareaEnNotion({ titulo: leido.tarea, contexto: `Correo de ${c.deNombre ? `${c.deNombre} <${c.de}>` : c.de}: "${c.asunto}"` })
                .catch((err) => console.warn('[inbound-correo] tarea de proveedor:', (err as Error).message));
        }
        console.log(`[inbound-correo] proveedor ${c.de}: ${leido.tarea ?? 'sin cotización, solo historial'}`);
        return;
    }

    // 1. Clasificar primero — filtra spam/newsletter/informativo antes de gastar en el asistente principal
    const asistenteCorreoId = await idAsistente('correo');
    const clasificacion = await clasificarCorreo({
        asunto: c.asunto,
        cuerpo: c.cuerpo,
        de: c.de,
        asistenteId: asistenteCorreoId ?? undefined,
    });

    console.log(`[inbound-correo] categoría: ${clasificacion.categoria} (${clasificacion.prioridad}) — ${clasificacion.razon}`);

    // Todo lo que entra queda en la historia (lo ignorable, marcado): la línea de
    // tiempo de cada cliente se mantiene al día sin importar a mano.
    const aHistoria = (clienteId: string | null) => registrarCorreoEnHistoria({
        direccion: 'entrante', de: c.de, deNombre: c.deNombre ?? null, para: casillaCorreo, asunto: c.asunto, cuerpo: c.cuerpo,
        fecha: c.fecha, messageId: c.messageId, clienteId, categoria: clasificacion.categoria, ignorable: clasificacion.ignorable, carpeta: 'INBOX',
    });

    if (clasificacion.ignorable) {
        // Descartado: no crear cliente ni conversación. Log y listo.
        console.log(`[inbound-correo] ignorado por categoría "${clasificacion.categoria}"`);
        await aHistoria(null);
        return;
    }

    // Sin respuesta (acuse, "te aviso", ofertas para venderle a Bartez) o un
    // proveedor que no estaba en la lista: queda en la historia del contacto si ya
    // existe, sin crear clientes ni borradores.
    if (clasificacion.categoria === 'sin_respuesta' || clasificacion.categoria === 'proveedor') {
        const { data: yaEsta } = await supabase.from('clientes').select('id').eq('email', emailNormal(c.de)).limit(1);
        await aHistoria((yaEsta?.[0]?.id as string | undefined) ?? null);
        if (clasificacion.categoria === 'proveedor') {
            const leido = await leerCorreoDeProveedor(c);
            if (leido.tarea) await crearTareaEnNotion({ titulo: leido.tarea, contexto: `Correo de ${c.de}: "${c.asunto}"` }).catch(() => undefined);
        }
        console.log(`[inbound-correo] ${clasificacion.categoria}: sin borrador`);
        return;
    }

    // 2. Crear/reusar cliente y conversación
    const clienteId = await buscarOCrearCliente(c.de, c.deNombre);
    await aHistoria(clienteId);
    if (!clienteId) {
        console.warn('[inbound-correo] descartado, sin cliente');
        return;
    }

    const conversacionId = (await buscarConversacionAbierta(clienteId, c.inReplyTo)) ?? undefined;

    // 3. Enrutar al asistente principal con la clasificación en la metadata
    const texto = `Asunto: ${c.asunto}\n\n${c.cuerpo.slice(0, 4000)}`;

    // Pedido de cotización con datos concretos: el cotizador lo arma con los
    // precios de los proveedores y la respuesta sale con el PDF adjunto.
    const cotizacion = clasificacion.categoria === 'cotizacion_detalle'
        ? await cotizarDesdeCorreo(texto, clienteId, c.deNombre || c.de)
        : null;

    try {
        await enrutar({
            canal: 'correo',
            clienteId,
            conversacionId,
            texto,
            metadata: {
                messageId: c.messageId,
                inReplyTo: c.inReplyTo,
                asuntoOriginal: c.asunto.startsWith('Re:') ? c.asunto : `Re: ${c.asunto}`,
                emailDestino: c.de,
                nombreDestino: c.deNombre,
                clasificacion: {
                    categoria: clasificacion.categoria,
                    prioridad: clasificacion.prioridad,
                    razon: clasificacion.razon,
                },
                ...(cotizacion ? { cotizacion } : {}),
            },
        });
    } catch (err) {
        console.error('[inbound-correo] error enrutando:', err);
    }
}

export interface CotizacionParaCorreo {
    id: string;
    total_usd: number;
    items: Array<{ cantidad: number; descripcion: string; precio_unit_usd: number; iva_pct: number }>;
    faltantes: string[];
    comentario: string;
}

async function cotizarDesdeCorreo(texto: string, clienteId: string, nombre: string): Promise<CotizacionParaCorreo | null> {
    try {
        const r = await cotizar(texto, { cliente_id: clienteId });
        const elegidas = r.lineas.filter((l) => l.elegido);
        if (!r.ok || !r.id || elegidas.length === 0) {
            console.log(`[inbound-correo] cotización automática sin resultado: ${r.detalle ?? 'sin artículos'}`);
            return null;
        }
        await actualizarCotizacion(r.id, { titulo: nombre.slice(0, 200) });
        return {
            id: r.id,
            total_usd: r.total_usd,
            items: elegidas.map((l) => ({ cantidad: l.cantidad, descripcion: l.elegido!.descripcion, precio_unit_usd: l.elegido!.precio_unit_usd, iva_pct: l.elegido!.iva_pct })),
            faltantes: r.lineas.filter((l) => !l.elegido).map((l) => l.pedido),
            comentario: r.comentario,
        };
    } catch (err) {
        // Si falla, el correo sigue su camino normal (sin presupuesto adjunto).
        console.warn('[inbound-correo] no se pudo cotizar automáticamente:', (err as Error).message);
        return null;
    }
}

async function idAsistente(area: string): Promise<string | null> {
    const { data } = await supabase.from('asistentes').select('id').eq('area', area).maybeSingle();
    return (data?.id as string) ?? null;
}

export async function iniciarInboundCorreo(): Promise<void> {
    await iniciarListener(procesarCorreoEntrante);
}
