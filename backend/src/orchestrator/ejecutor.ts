// Ejecutor de acciones: sabe cómo llevar a cabo cada tipo de acción propuesta.
// Usado tanto por el router (cuando el asistente autoresponde) como por
// /acciones/:id/aprobar (cuando la aprueba un humano).

import { enviarCorreo, ferozoConfigurado } from '../connectors/ferozo.js';

export interface AccionAEjecutar {
    accion: string;
    payload: Record<string, unknown>;
}

export interface ResultadoEjecucion {
    ok: boolean;
    detalle?: string;
    resultado?: Record<string, unknown>;
}

export async function ejecutarAccion(a: AccionAEjecutar): Promise<ResultadoEjecucion> {
    try {
        if (a.accion === 'enviar_correo') {
            const p = a.payload;
            const para = String(p.para ?? '');
            const asunto = String(p.asunto ?? 'Re:');
            const cuerpo = String(p.cuerpo ?? '');
            if (!para || !cuerpo) return { ok: false, detalle: 'payload sin para/cuerpo' };
            if (!ferozoConfigurado) {
                return { ok: true, detalle: 'ferozo sin configurar — envío simulado', resultado: { simulado: true } };
            }
            const info = await enviarCorreo({
                para,
                asunto,
                cuerpo,
                inReplyTo: p.inReplyTo as string | undefined,
                references: p.references as string | undefined,
            });
            return { ok: true, resultado: { messageId: info.messageId, para } };
        }
        return { ok: true, detalle: `tipo "${a.accion}" sin ejecutor` };
    } catch (err) {
        return { ok: false, detalle: (err as Error).message };
    }
}
