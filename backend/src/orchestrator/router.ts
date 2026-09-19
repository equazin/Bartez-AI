// Router / orquestador.
// Decide qué asistente atiende cada tarea entrante y coordina el flujo.
// Diseño: el orquestador NUNCA ejecuta la tarea — solo decide y delega. Así, sumar
// asistentes no lo vuelve más lento ni frágil.

import { catalogo } from './catalog.js';
import { bitacora } from '../logging/bitacora.js';
import { escalar } from '../escalation/humano.js';
import { supabase } from '../connectors/supabase.js';
import { ejecutarAccion } from './ejecutor.js';
import type { TareaEntrante, ResultadoAsistente } from './types.js';

export interface ResultadoRuteo extends ResultadoAsistente {
    conversacionId: string;
}

export async function enrutar(tarea: TareaEntrante): Promise<ResultadoRuteo> {
    const area = decidirArea(tarea);
    const asistente = catalogo.obtenerPorArea(area);

    if (!asistente) {
        throw new Error(`No hay asistente activo para el área "${area}"`);
    }

    // Asegurar conversación: reusar la existente o crear una nueva
    const conversacionId = await asegurarConversacion(tarea, asistente.config.id);

    // Persistir el mensaje entrante (usuario / cliente)
    await guardarMensaje(conversacionId, tarea.canal === 'panel' ? 'humano' : 'cliente', tarea.texto);

    const inicio = Date.now();
    try {
        const resultado = await asistente.procesar({ ...tarea, conversacionId });

        // Persistir la respuesta del asistente
        await guardarMensaje(conversacionId, 'asistente', resultado.respuesta);

        await bitacora.registrar({
            asistenteId: asistente.config.id,
            conversacionId,
            entrada: { canal: tarea.canal, texto: tarea.texto, metadata: tarea.metadata },
            salida: { respuesta: resultado.respuesta, accion: resultado.accionPropuesta },
            tokensIn: resultado.tokensIn,
            tokensOut: resultado.tokensOut,
            costoUsd: resultado.costoUsd,
            duracionMs: resultado.duracionMs,
        });

        if (resultado.accionPropuesta) {
            if (resultado.requiereAprobacion) {
                // Requiere humano: va a acciones_pendientes y avisa
                await escalar({
                    asistenteId: asistente.config.id,
                    conversacionId,
                    accion: resultado.accionPropuesta.tipo,
                    payload: resultado.accionPropuesta.payload,
                });
            } else {
                // Autonomía suficiente: ejecutar directo (correo autoresponder, etc.)
                const ejec = await ejecutarAccion({
                    accion: resultado.accionPropuesta.tipo,
                    payload: resultado.accionPropuesta.payload,
                });
                console.log(`[router] autoejecutada acción "${resultado.accionPropuesta.tipo}" → ${ejec.ok ? 'ok' : 'error: ' + ejec.detalle}`);
                // Registrar como "aprobada por el sistema" en acciones_pendientes para trazabilidad
                await supabase.from('acciones_pendientes').insert({
                    asistente_id: asistente.config.id,
                    conversacion_id: conversacionId,
                    accion: resultado.accionPropuesta.tipo,
                    payload: resultado.accionPropuesta.payload,
                    estado: ejec.ok ? 'aprobada' : 'pendiente',
                    respuesta: { por: 'sistema', autonomia: asistente.config.autonomia, ejecucion: ejec },
                    resuelto_en: ejec.ok ? new Date().toISOString() : null,
                });
            }
        }

        return { ...resultado, conversacionId };
    } catch (err) {
        await bitacora.registrar({
            asistenteId: asistente.config.id,
            conversacionId,
            entrada: { canal: tarea.canal, texto: tarea.texto },
            error: err instanceof Error ? err.message : String(err),
            duracionMs: Date.now() - inicio,
        });
        throw err;
    }
}

async function asegurarConversacion(tarea: TareaEntrante, asistenteId: string): Promise<string> {
    if (tarea.conversacionId) return tarea.conversacionId;
    const { data, error } = await supabase
        .from('conversaciones')
        .insert({
            cliente_id: tarea.clienteId ?? null,
            asistente_id: asistenteId,
            canal: tarea.canal,
            estado: 'abierta',
        })
        .select('id')
        .single();
    if (error || !data) throw new Error(`No se pudo crear la conversación: ${error?.message}`);
    return data.id as string;
}

async function guardarMensaje(conversacionId: string, remitente: string, texto: string): Promise<void> {
    const { error } = await supabase
        .from('mensajes')
        .insert({ conversacion_id: conversacionId, remitente, texto });
    if (error) console.warn('[router] no se pudo guardar mensaje:', error.message);
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
