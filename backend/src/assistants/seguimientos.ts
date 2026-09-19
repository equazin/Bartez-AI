// Asistente de Seguimientos — redacta correos de follow-up a leads
// que ya recibieron un primer contacto y no respondieron en varios días.
// La lógica de "a quién vale la pena reengancha" la resuelve el cron/endpoint
// en index.ts (barrido de la Base); este asistente solo escribe el mensaje.
//
// Mismo formato que Correo: cuerpo entre <respuesta>...</respuesta>.
// El destinatario nunca lo decide el LLM: viene de metadata.emailDestino.

import { AsistenteBase } from './base.js';
import type { ResultadoAsistente, TareaEntrante } from '../orchestrator/types.js';

export class AsistenteSeguimientos extends AsistenteBase {
    protected override extraerAccion(texto: string, tarea: TareaEntrante): ResultadoAsistente['accionPropuesta'] {
        const para = (tarea.metadata?.emailDestino as string | undefined)?.trim();
        if (!para) return undefined;

        const match = /<respuesta>([\s\S]*?)<\/respuesta>/i.exec(texto);
        const respuesta = (match?.[1] ?? texto).trim();
        if (!respuesta) return undefined;

        return {
            tipo: 'enviar_correo',
            payload: {
                para,
                asunto: (tarea.metadata?.asuntoOriginal as string) ?? 'Retomando contacto',
                cuerpo: respuesta,
                clienteId: tarea.clienteId,
                origen: 'seguimiento',
            },
        };
    }

    // Todos los seguimientos requieren aprobación humana, por más autonomía que tenga
    // el asistente. Nunca autorespondemos follow-ups en frío.
    protected override decidirAprobacion(): boolean {
        return true;
    }
}
