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
import { presupuestosSinRespuesta } from './cotizador.js';
import { mensajesWhatsappDeCliente } from './whatsapp.js';

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

// Genera un correo de seguimiento para UN cliente específico, sin filtros de
// días de silencio. Útil desde la pestaña Seguimientos cuando el operador quiere
// redactar a mano. Recibe opcionalmente un informe_previo (el análisis Sonnet)
// para dar contexto extra al asistente.
export async function generarSeguimientoIndividual(
    clienteId: string,
    opts: { informe_previo?: string; contexto_extra?: string } = {},
): Promise<{
    ok: boolean;
    accion_id?: string;
    respuesta?: string;
    detalle?: string;
}> {
    const asistente = catalogo.obtenerPorArea('seguimientos');
    if (!asistente) return { ok: false, detalle: 'Asistente Seguimientos no está activo' };

    const { data: c } = await supabase
        .from('clientes')
        .select('id, nombre, email, intentos_contacto, ultimo_contacto_en, metadata')
        .eq('id', clienteId)
        .maybeSingle();
    if (!c) return { ok: false, detalle: 'Cliente no encontrado' };
    if (!c.email) return { ok: false, detalle: 'Este cliente no tiene email cargado' };

    const historia = await historicoConCliente(clienteId, 10);
    const bloqueHistoria = historia.length > 0
        ? '\n\nHistorial de correos previos (cronológico):\n' +
          historia.slice().reverse().map((h) => {
              const quien = h.direccion === 'saliente' ? 'BARTEZ →' : 'CLIENTE →';
              const fecha = new Date(h.fecha).toISOString().slice(0, 10);
              const cuerpo = (h.cuerpo ?? '').replace(/\s+/g, ' ').slice(0, 400);
              return `[${fecha}] ${quien} ${h.asunto ?? '(sin asunto)'}\n${cuerpo}`;
          }).join('\n\n')
        : '';

    const wa = await mensajesWhatsappDeCliente(clienteId, 15);
    const bloqueWhatsapp = wa.length > 0
        ? '\n\nConversación de WhatsApp reciente (cronológica):\n' +
          wa.slice().reverse().map((m) => {
              const quien = m.origen === 'cliente' ? 'CLIENTE →' : m.origen === 'bot' ? 'BOT WEB →' : 'BARTEZ →';
              return `[${new Date(m.creado_en).toISOString().slice(0, 10)}] ${quien} ${(m.cuerpo ?? '').replace(/\s+/g, ' ').slice(0, 300)}`;
          }).join('\n')
        : '';

    const intentos = c.intentos_contacto ?? 0;
    const diasSilencio = c.ultimo_contacto_en
        ? Math.floor((Date.now() - new Date(c.ultimo_contacto_en).getTime()) / (24 * 3600_000))
        : 0;

    const bloqueInforme = opts.informe_previo
        ? `\n\nInforme diagnóstico previo (generado por el analista):\n${opts.informe_previo.slice(0, 2000)}\n\nUsalo como referencia para el próximo paso sugerido.`
        : '';

    const bloqueExtra = opts.contexto_extra?.trim()
        ? `\n\nCONTEXTO ADICIONAL DEL OPERADOR (info que NO está en los correos — llamadas, WhatsApp, mensajes verbales, notas propias):\n${opts.contexto_extra.trim().slice(0, 1500)}\n\nTratalo como fuente de verdad — el operador lo aporta desde canales que el sistema no ve. Referí a esta info al redactar el correo si corresponde.`
        : '';

    const contexto = [
        `Lead: ${c.nombre}`,
        c.metadata?.sitio_web ? `Sitio: ${c.metadata.sitio_web}` : null,
        c.metadata?.senial ? `Señal detectada en prospección: ${c.metadata.senial}` : null,
        c.metadata?.razon_prospeccion ? `Encaje ICP: ${c.metadata.razon_prospeccion}` : null,
        typeof c.metadata?.puntaje_icp === 'number' ? `Puntaje ICP: ${c.metadata.puntaje_icp}/10` : null,
        intentos > 0 ? `Intentos previos desde Bartez: ${intentos}` : 'Sin contactos previos oficiales desde Bartez (pero puede haber correos históricos importados).',
        c.ultimo_contacto_en ? `Días desde último contacto Bartez: ${diasSilencio}` : null,
        bloqueHistoria,
        bloqueWhatsapp,
        bloqueInforme,
        bloqueExtra,
        '',
        'Redactá un correo de seguimiento siguiendo las reglas de tu prompt.',
        historia.length > 0
            ? 'IMPORTANTE: hay correos previos con este cliente. NO hagas un primer contacto en frío ni una presentación desde cero — retomá la conversación desde donde quedó. Si hay compromisos pendientes, cotizaciones sin respuesta, o preguntas sin cerrar, respondé a eso. Si el último toque fue de Bartez y no hubo respuesta, hacé un follow-up ameno.'
            : 'Este cliente no tiene correos previos. Presentá Bartez brevemente y abrí la puerta a una charla.',
    ].filter(Boolean).join('\n');

    const resultado = await asistente.procesar({
        canal: 'correo',
        clienteId: c.id,
        texto: contexto,
        metadata: {
            emailDestino: c.email,
            nombreDestino: c.nombre,
            asuntoOriginal: `Retomando contacto — Bartez Tecnología`,
            origen: 'seguimiento_individual',
            intento: intentos + 1,
        },
    });

    await supabase.from('logs_asistente').insert({
        asistente_id: asistente.config.id,
        entrada: { origen: 'seguimiento_individual', cliente_id: c.id, intento: intentos + 1 },
        salida: { respuesta: resultado.respuesta, accion: resultado.accionPropuesta },
        tokens_in: resultado.tokensIn,
        tokens_out: resultado.tokensOut,
        costo_usd: resultado.costoUsd,
        duracion_ms: resultado.duracionMs,
    });

    if (!resultado.accionPropuesta) {
        return { ok: false, detalle: 'El asistente no propuso ninguna acción — probablemente el prompt necesita ajuste' };
    }

    const { data: nuevaAccion } = await supabase.from('acciones_pendientes').insert({
        asistente_id: asistente.config.id,
        accion: resultado.accionPropuesta.tipo,
        payload: resultado.accionPropuesta.payload,
        estado: 'pendiente',
        respuesta: { por: 'sistema', origen: 'seguimiento_individual', cliente_id: c.id },
    }).select('id').single();

    return { ok: true, accion_id: nuevaAccion?.id, respuesta: resultado.respuesta };
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

// Presupuestos enviados sin respuesta: a los 5 días se propone un seguimiento
// (uno solo por presupuesto, y solo si está vinculado a un cliente con email).
export async function seguirPresupuestosEnviados(): Promise<{ revisados: number; generados: number }> {
    const lista = await presupuestosSinRespuesta(5, 30);
    let generados = 0;
    for (const q of lista) {
        if (!q.cliente_id || q.seguimiento_en) continue;
        const dias = Math.floor((Date.now() - new Date(q.enviada_en).getTime()) / 86_400_000);
        if (dias > 30) continue;
        const r = await generarSeguimientoIndividual(q.cliente_id, {
            contexto_extra: `Seguimiento del presupuesto${q.numero ? ` N° ${q.numero}` : ''} por USD ${q.total_usd.toLocaleString('es-AR')} (IVA incluido), enviado hace ${dias} días y todavía sin respuesta. Pedido original: "${q.pedido.slice(0, 300)}". Preguntá con buena onda si pudieron verlo, si tienen dudas o si quieren que ajustemos algo (cantidades, modelos, plazos de entrega). Nada de presión ni de descuentos que Andrés no autorizó.`,
        });
        if (r.ok) {
            generados++;
            await supabase.from('cotizaciones').update({ seguimiento_en: new Date().toISOString() }).eq('id', q.id);
        }
    }
    return { revisados: lista.length, generados };
}
