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
import { responderOperador } from './operador.js';

export interface ResultadoRuteo extends ResultadoAsistente {
    conversacionId: string;
}

export async function enrutar(tarea: TareaEntrante): Promise<ResultadoRuteo> {
    const area = decidirArea(tarea);
    if (area === 'operador') return enrutarOperador(tarea);
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

// Asistente General: no tiene clase en el catálogo, responde con herramientas
// sobre los datos del sistema (ver operador.ts).
async function enrutarOperador(tarea: TareaEntrante): Promise<ResultadoRuteo> {
    const { data: fila } = await supabase.from('asistentes').select('id').eq('area', 'operador').maybeSingle();
    const asistenteId = (fila?.id as string | undefined) ?? null;
    const conversacionId = await asegurarConversacion(tarea, asistenteId);
    await guardarMensaje(conversacionId, 'humano', tarea.texto);
    const inicio = Date.now();
    try {
        const r = await responderOperador(tarea.texto, conversacionId);
        await guardarMensaje(conversacionId, 'asistente', r.respuesta);
        if (asistenteId) {
            await bitacora.registrar({
                asistenteId, conversacionId,
                entrada: { canal: tarea.canal, texto: tarea.texto },
                salida: { respuesta: r.respuesta },
                tokensIn: r.tokensIn, tokensOut: r.tokensOut, costoUsd: r.costoUsd, duracionMs: r.duracionMs,
            });
        }
        return {
            respuesta: r.respuesta, requiereAprobacion: false,
            tokensIn: r.tokensIn, tokensOut: r.tokensOut, costoUsd: r.costoUsd, duracionMs: r.duracionMs,
            conversacionId,
        };
    } catch (err) {
        if (asistenteId) {
            await bitacora.registrar({
                asistenteId, conversacionId,
                entrada: { canal: tarea.canal, texto: tarea.texto },
                error: err instanceof Error ? err.message : String(err),
                duracionMs: Date.now() - inicio,
            });
        }
        throw err;
    }
}

async function asegurarConversacion(tarea: TareaEntrante, asistenteId: string | null): Promise<string> {
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
            // Se puede forzar un área; si no, se decide por lo que se pide.
            return (tarea.metadata?.area as string) ?? areaDelPedido(tarea.texto);
    }
}

// Pedidos específicos van a su asistente; el resto, al asistente General,
// que conoce el estado del negocio y puede cotizar.
function areaDelPedido(texto: string): string {
    const t = texto.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    if (/\b(prospect|busca(me)? (empresas|clientes|prospectos|leads)|nuevos (clientes|leads))/.test(t)) return 'prospeccion';
    if (/\b(segui?miento|retoma|recontact|hace(me)? un seguimiento)/.test(t)) return 'seguimientos';
    if (/\b(redacta|escribi(le)?|arma(me)? un (correo|mail|email)|responde(le)? (el|al|este) (correo|mail))/.test(t)) return 'correo';
    if (/\b(analitica|informe semanal|como venimos (esta|la) semana)/.test(t)) return 'analitica';
    return 'operador';
}
