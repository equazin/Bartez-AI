// Entrada de correos: cada correo nuevo se convierte en una tarea del orquestador.
// Flujo: correo entra → buscar/crear cliente por email → crear conversación →
// enrutar(canal='correo') → el asistente de Correo genera respuesta → si
// autonomía < 100, va a acciones_pendientes esperando aprobación.

import { supabase } from '../connectors/supabase.js';
import { CorreoEntrante, iniciarListener } from '../connectors/ferozo.js';
import { enrutar } from '../orchestrator/router.js';
import { clasificarCorreo } from './clasificador.js';

async function buscarOCrearCliente(emailCliente: string, nombre?: string): Promise<string | null> {
    // Buscar cliente existente por email
    const { data: existente } = await supabase
        .from('clientes')
        .select('id')
        .eq('email', emailCliente)
        .maybeSingle();
    if (existente) return existente.id as string;

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

async function procesarCorreoEntrante(c: CorreoEntrante): Promise<void> {
    console.log(`[inbound-correo] correo de ${c.de}: "${c.asunto}"`);

    // 1. Clasificar primero — filtra spam/newsletter/informativo antes de gastar en el asistente principal
    const asistenteCorreoId = await idAsistente('correo');
    const clasificacion = await clasificarCorreo({
        asunto: c.asunto,
        cuerpo: c.cuerpo,
        de: c.de,
        asistenteId: asistenteCorreoId ?? undefined,
    });

    console.log(`[inbound-correo] categoría: ${clasificacion.categoria} (${clasificacion.prioridad}) — ${clasificacion.razon}`);

    if (clasificacion.ignorable) {
        // Descartado: no crear cliente ni conversación. Log y listo.
        console.log(`[inbound-correo] ignorado por categoría "${clasificacion.categoria}"`);
        return;
    }

    // 2. Crear/reusar cliente y conversación
    const clienteId = await buscarOCrearCliente(c.de, c.deNombre);
    if (!clienteId) {
        console.warn('[inbound-correo] descartado, sin cliente');
        return;
    }

    const conversacionId = (await buscarConversacionAbierta(clienteId, c.inReplyTo)) ?? undefined;

    // 3. Enrutar al asistente principal con la clasificación en la metadata
    const texto = `Asunto: ${c.asunto}\n\n${c.cuerpo.slice(0, 4000)}`;

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
            },
        });
    } catch (err) {
        console.error('[inbound-correo] error enrutando:', err);
    }
}

async function idAsistente(area: string): Promise<string | null> {
    const { data } = await supabase.from('asistentes').select('id').eq('area', area).maybeSingle();
    return (data?.id as string) ?? null;
}

export async function iniciarInboundCorreo(): Promise<void> {
    await iniciarListener(procesarCorreoEntrante);
}
