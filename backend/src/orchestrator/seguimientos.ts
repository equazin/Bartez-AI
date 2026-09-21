// Motor de seguimientos: barre la Base de clientes y, para cada lead que ya
// recibió un primer contacto y no respondió en varios días, invoca al asistente
// Seguimientos para que redacte un follow-up. La acción propuesta va a
// acciones_pendientes (siempre requiere aprobación humana, sin excepción).
//
// Se dispara desde dos lugares:
//   1. cron diario 9 AM AR (setup en index.ts)
//   2. endpoint POST /seguimientos/correr (para testeo o disparo manual)

import { supabase } from '../connectors/supabase.js';
import { catalogo } from './catalog.js';
import { historicoConCliente } from '../inbound/importar_historico.js';

const DIAS_SILENCIO = 7;
const MAX_INTENTOS = 4;

interface ClienteParaSeguimiento {
    id: string;
    nombre: string;
    email: string | null;
    intentos_contacto: number;
    ultimo_contacto_en: string;
    metadata: {
        sitio_web?: string;
        senial?: string;
        razon_prospeccion?: string;
        puntaje_icp?: number;
    } | null;
}

export interface ResultadoBarrido {
    revisados: number;
    generados: number;
    descartados_max_intentos: number;
    errores: string[];
    duracion_ms: number;
}

export async function correrBarridoSeguimientos(): Promise<ResultadoBarrido> {
    const inicio = Date.now();
    const asistente = catalogo.obtenerPorArea('seguimientos');
    if (!asistente) {
        return {
            revisados: 0, generados: 0, descartados_max_intentos: 0,
            errores: ['Asistente Seguimientos no está activo en el catálogo'],
            duracion_ms: Date.now() - inicio,
        };
    }

    const corteISO = new Date(Date.now() - DIAS_SILENCIO * 24 * 3600_000).toISOString();

    // Candidatos: leads con al menos 1 intento previo, último toque hace más de N días,
    // que todavía no lleguen al tope de intentos.
    const { data: candidatos, error } = await supabase
        .from('clientes')
        .select('id, nombre, email, intentos_contacto, ultimo_contacto_en, metadata')
        .eq('estado', 'lead')
        .eq('origen', 'prospeccion')
        .gte('intentos_contacto', 1)
        .lt('intentos_contacto', MAX_INTENTOS)
        .not('ultimo_contacto_en', 'is', null)
        .lt('ultimo_contacto_en', corteISO)
        .not('email', 'is', null)
        .limit(50);

    if (error) {
        return {
            revisados: 0, generados: 0, descartados_max_intentos: 0,
            errores: [error.message], duracion_ms: Date.now() - inicio,
        };
    }

    const lista = (candidatos ?? []) as ClienteParaSeguimiento[];
    const errores: string[] = [];
    let generados = 0;

    // Evitar duplicar: si ya hay una acción pendiente de seguimiento sin resolver
    // para este cliente, la salteamos.
    const idsCandidatos = lista.map((c) => c.id);
    let idsConPendiente = new Set<string>();
    if (idsCandidatos.length > 0) {
        const { data: pendientes } = await supabase
            .from('acciones_pendientes')
            .select('payload')
            .eq('estado', 'pendiente')
            .eq('accion', 'enviar_correo');
        idsConPendiente = new Set(
            (pendientes ?? [])
                .map((r) => (r.payload as Record<string, unknown>)?.clienteId as string | undefined)
                .filter((id): id is string => !!id && idsCandidatos.includes(id)),
        );
    }

    for (const c of lista) {
        if (idsConPendiente.has(c.id)) continue;
        try {
            const diasSilencio = Math.floor(
                (Date.now() - new Date(c.ultimo_contacto_en).getTime()) / (24 * 3600_000),
            );
            // Traer histórico de correos previos con este cliente para no repetir
            // cosas ni contradecir compromisos. Se pasan hasta 5 correos.
            const historia = await historicoConCliente(c.id, 5);
            const bloqueHistoria = historia.length > 0
                ? '\n\nHistorial de correos previos (cronológico):\n' +
                  historia.slice().reverse().map((h) => {
                      const quien = h.direccion === 'saliente' ? 'BARTEZ →' : 'CLIENTE →';
                      const fecha = new Date(h.fecha).toISOString().slice(0, 10);
                      const cuerpo = (h.cuerpo ?? '').replace(/\s+/g, ' ').slice(0, 400);
                      return `[${fecha}] ${quien} ${h.asunto ?? '(sin asunto)'}\n${cuerpo}`;
                  }).join('\n\n')
                : '';

            const contexto = [
                `Lead: ${c.nombre}`,
                c.metadata?.sitio_web ? `Sitio: ${c.metadata.sitio_web}` : null,
                c.metadata?.senial ? `Señal detectada en prospección: ${c.metadata.senial}` : null,
                c.metadata?.razon_prospeccion ? `Encaje ICP: ${c.metadata.razon_prospeccion}` : null,
                typeof c.metadata?.puntaje_icp === 'number' ? `Puntaje ICP: ${c.metadata.puntaje_icp}/10` : null,
                `Intento actual: ${c.intentos_contacto + 1} (van ${c.intentos_contacto} previos sin respuesta)`,
                `Días desde último contacto: ${diasSilencio}`,
                bloqueHistoria,
                '',
                'Redactá el correo de follow-up siguiendo las reglas de tu prompt. Si en el historial hay algo puntual (una cotización, un compromiso, un pedido), retomá desde ahí.',
            ].filter(Boolean).join('\n');

            const resultado = await asistente.procesar({
                canal: 'correo',
                clienteId: c.id,
                texto: contexto,
                metadata: {
                    emailDestino: c.email,
                    nombreDestino: c.nombre,
                    asuntoOriginal: `Retomando contacto — Bartez Tecnología`,
                    origen: 'seguimiento_automatico',
                    intento: c.intentos_contacto + 1,
                },
            });

            // Log de la corrida
            await supabase.from('logs_asistente').insert({
                asistente_id: asistente.config.id,
                entrada: { origen: 'barrido_seguimientos', cliente_id: c.id, intento: c.intentos_contacto + 1 },
                salida: { respuesta: resultado.respuesta, accion: resultado.accionPropuesta },
                tokens_in: resultado.tokensIn,
                tokens_out: resultado.tokensOut,
                costo_usd: resultado.costoUsd,
                duracion_ms: resultado.duracionMs,
            });

            if (resultado.accionPropuesta) {
                await supabase.from('acciones_pendientes').insert({
                    asistente_id: asistente.config.id,
                    accion: resultado.accionPropuesta.tipo,
                    payload: resultado.accionPropuesta.payload,
                    estado: 'pendiente',
                    respuesta: { por: 'sistema', origen: 'barrido_seguimientos', cliente_id: c.id },
                });
                generados++;
            }
        } catch (err) {
            errores.push(`${c.nombre}: ${(err as Error).message}`);
        }
    }

    return {
        revisados: lista.length,
        generados,
        descartados_max_intentos: 0, // se calcula aparte si querés reportarlo
        errores,
        duracion_ms: Date.now() - inicio,
    };
}
