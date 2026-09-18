// Router / orquestador.
// Decide qué asistente atiende cada tarea entrante y coordina el flujo.
// Diseño: el orquestador NUNCA ejecuta la tarea — solo decide y delega. Así, sumar
// asistentes no lo vuelve más lento ni frágil.

import { catalogo } from './catalog.js';
import { bitacora } from '../logging/bitacora.js';
import { escalar } from '../escalation/humano.js';
import type { TareaEntrante, ResultadoAsistente } from './types.js';

export async function enrutar(tarea: TareaEntrante): Promise<ResultadoAsistente> {
    const area = decidirArea(tarea);
    const asistente = catalogo.obtenerPorArea(area);

    if (!asistente) {
        throw new Error(`No hay asistente activo para el área "${area}"`);
    }

    const inicio = Date.now();
    try {
        const resultado = await asistente.procesar(tarea);

        await bitacora.registrar({
            asistenteId: asistente.config.id,
            conversacionId: tarea.conversacionId,
            entrada: { canal: tarea.canal, texto: tarea.texto, metadata: tarea.metadata },
            salida: { respuesta: resultado.respuesta, accion: resultado.accionPropuesta },
            tokensIn: resultado.tokensIn,
            tokensOut: resultado.tokensOut,
            costoUsd: resultado.costoUsd,
            duracionMs: resultado.duracionMs,
        });

        if (resultado.requiereAprobacion && resultado.accionPropuesta) {
            await escalar({
                asistenteId: asistente.config.id,
                conversacionId: tarea.conversacionId,
                accion: resultado.accionPropuesta.tipo,
                payload: resultado.accionPropuesta.payload,
            });
        }

        return resultado;
    } catch (err) {
        await bitacora.registrar({
            asistenteId: asistente.config.id,
            conversacionId: tarea.conversacionId,
            entrada: { canal: tarea.canal, texto: tarea.texto },
            error: err instanceof Error ? err.message : String(err),
            duracionMs: Date.now() - inicio,
        });
        throw err;
    }
}

// Reglas simples de enrutado por canal. A futuro esto puede ser el propio LLM
// decidiendo, o un asistente-orquestador con function calling.
function decidirArea(tarea: TareaEntrante): string {
    switch (tarea.canal) {
        case 'correo':
            return 'correo';
        case 'whatsapp':
            return 'whatsapp';
        case 'panel':
            // En el panel se puede pedir a un área específica; por defecto va al de correo.
            return (tarea.metadata?.area as string) ?? 'correo';
    }
}
