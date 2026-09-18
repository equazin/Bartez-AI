// Escalamiento a humano: cuando un asistente propone una acción que requiere
// aprobación, la guarda en `acciones_pendientes` y avisa al humano por correo.
// Fase 1: solo correo (gratis). WhatsApp se suma cuando el volumen lo justifique.

import { supabase } from '../connectors/supabase.js';
import { enviarCorreo } from '../connectors/gmail.js';

const emailEscalacion = process.env.ESCALACION_EMAIL ?? '';

export interface AccionParaAprobar {
    asistenteId: string;
    conversacionId?: string;
    accion: string;
    payload: Record<string, unknown>;
}

export async function escalar(a: AccionParaAprobar): Promise<void> {
    const { data, error } = await supabase
        .from('acciones_pendientes')
        .insert({
            asistente_id: a.asistenteId,
            conversacion_id: a.conversacionId,
            accion: a.accion,
            payload: a.payload,
        })
        .select('id')
        .single();

    if (error) {
        console.error('[escalacion] no se pudo guardar la acción', error.message);
        return;
    }

    if (emailEscalacion) {
        await enviarCorreo({
            para: emailEscalacion,
            asunto: `[Bartez AI] Acción pendiente: ${a.accion}`,
            cuerpo: [
                `Un asistente propone la siguiente acción y necesita tu aprobación:`,
                ``,
                `Acción: ${a.accion}`,
                `Payload: ${JSON.stringify(a.payload, null, 2)}`,
                ``,
                `Aprobar/editar/rechazar desde el panel:`,
                `  /acciones/${data.id}`,
            ].join('\n'),
        });

        await supabase
            .from('acciones_pendientes')
            .update({ notificado_en: new Date().toISOString() })
            .eq('id', data.id);
    }
}
