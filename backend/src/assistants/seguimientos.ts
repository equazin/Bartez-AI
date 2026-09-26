// Asistente de Seguimientos — redacta correos de follow-up a leads
// que ya recibieron un primer contacto y no respondieron en varios días.
// La lógica de "a quién vale la pena reengancha" la resuelve el cron/endpoint
// en index.ts (barrido de la Base); este asistente solo escribe el mensaje.
//
// Mismo formato que Correo: cuerpo entre <respuesta>...</respuesta>.
// El destinatario nunca lo decide el LLM: viene de metadata.emailDestino.

import { AsistenteBase, contextoFecha } from './base.js';
import type { ResultadoAsistente, TareaEntrante } from '../orchestrator/types.js';
import { conLecciones } from '../orchestrator/aprendizaje.js';
import { conMemoria } from '../orchestrator/memoria.js';
import { EMPRESA } from '../config/empresa.js';

// Datos fijos de Bartez: la IA llegó a escribir "equipamos empresas acá en
// Mendoza". Con esto no hay de dónde inventar.
export const DATOS_BARTEZ = `DATOS REALES DE BARTEZ (no inventes otros):
- ${EMPRESA.nombre}: ${EMPRESA.descripcion.toLowerCase()} con base en Rosario (${EMPRESA.direccion}), vende a empresas de todo el país.
- Hace equipamiento IT (notebooks, PCs, servidores, redes, almacenamiento), infraestructura y soporte técnico.
- Web: ${EMPRESA.web}. Teléfono: ${EMPRESA.telefono}.
- Nunca digas que Bartez está en otra ciudad ("acá en Mendoza") ni inventes clientes, años de trayectoria, obras o números.`;

// "Asunto: …" en la primera línea del texto pasa a ser el asunto del correo
// (antes quedaba escrito dentro del cuerpo y el correo salía con el asunto genérico).
export function separarAsunto(texto: string): { asunto: string | null; cuerpo: string } {
    const m = texto.match(/^\s*asunto\s*:\s*(.+)\n+/i);
    if (!m) return { asunto: null, cuerpo: texto.trim() };
    return { asunto: m[1]!.trim().slice(0, 150), cuerpo: texto.slice(m[0].length).trim() };
}

export class AsistenteSeguimientos extends AsistenteBase {
    protected override async construirSystem(tarea: TareaEntrante): Promise<string> {
        const base = this.config.prompt || 'Sos el asistente de seguimientos de Bartez AI.';
        return conMemoria(await conLecciones(`${contextoFecha()}\n\n${base}\n\n${DATOS_BARTEZ}\n\nSi querés proponer un asunto, ponelo en la primera línea como "Asunto: …" dentro de <respuesta>.`, this.config.id), tarea.clienteId);
    }

    protected override extraerAccion(texto: string, tarea: TareaEntrante): ResultadoAsistente['accionPropuesta'] {
        const para = (tarea.metadata?.emailDestino as string | undefined)?.trim();
        if (!para) return undefined;

        const match = /<respuesta>([\s\S]*?)<\/respuesta>/i.exec(texto);
        const { asunto, cuerpo: respuesta } = separarAsunto((match?.[1] ?? texto).trim());
        if (!respuesta) return undefined;

        return {
            tipo: 'enviar_correo',
            payload: {
                para,
                asunto: asunto ?? (tarea.metadata?.asuntoOriginal as string) ?? 'Retomando contacto',
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
