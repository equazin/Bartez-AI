// Ejecutor de acciones: sabe cómo llevar a cabo cada tipo de acción propuesta.
// Usado tanto por el router (cuando el asistente autoresponde) como por
// /acciones/:id/aprobar (cuando la aprueba un humano).

import { enviarCorreo, ferozoConfigurado } from '../connectors/ferozo.js';
import { supabase } from '../connectors/supabase.js';

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
        if (a.accion === 'otra' && a.payload.subtipo === 'prospectos_propuestos') {
            return await ejecutarProspectos(a.payload);
        }

        return { ok: true, detalle: `tipo "${a.accion}" sin ejecutor` };
    } catch (err) {
        return { ok: false, detalle: (err as Error).message };
    }
}

interface ProspectoRaw {
    nombre: string;
    email?: string | null;
    sitio_web?: string;
    razon?: string;
    señal?: string;
    puntaje_icp?: number;
    propuesta_contacto?: string;
}

async function ejecutarProspectos(payload: Record<string, unknown>): Promise<ResultadoEjecucion> {
    const prospectos = Array.isArray(payload.prospectos) ? (payload.prospectos as ProspectoRaw[]) : [];
    if (prospectos.length === 0) return { ok: false, detalle: 'no hay prospectos en el payload' };

    const asistenteProspId = await idAsistente('prospeccion');
    let creados = 0;
    let accionesGeneradas = 0;
    let saltados = 0;

    for (const p of prospectos) {
        if (!p.nombre) { saltados++; continue; }

        // Guardar cliente (dedupe por email si viene, si no dedupe por nombre)
        const filtro = p.email ? { email: p.email } : { nombre: p.nombre };
        const { data: existente } = await supabase
            .from('clientes')
            .select('id')
            .match(filtro)
            .maybeSingle();

        let clienteId = existente?.id as string | undefined;
        if (!clienteId) {
            const { data: nuevo, error } = await supabase
                .from('clientes')
                .insert({
                    nombre: p.nombre,
                    email: p.email ?? null,
                    origen: 'prospeccion',
                    estado: 'lead',
                    metadata: {
                        sitio_web: p.sitio_web,
                        senial: p.señal,
                        razon_prospeccion: p.razon,
                        puntaje_icp: p.puntaje_icp,
                    },
                })
                .select('id')
                .single();
            if (error || !nuevo) { saltados++; continue; }
            clienteId = nuevo.id as string;
            creados++;
        }

        // Si hay email y propuesta_contacto, crear acción de primer contacto para aprobar
        if (p.email && p.propuesta_contacto) {
            await supabase.from('acciones_pendientes').insert({
                asistente_id: asistenteProspId,
                accion: 'enviar_correo',
                payload: {
                    para: p.email,
                    asunto: `Bartez Tecnología — solución IT para ${p.nombre}`,
                    cuerpo: p.propuesta_contacto,
                },
                estado: 'pendiente',
                respuesta: {
                    por: 'sistema',
                    origen: 'prospeccion',
                    cliente_id: clienteId,
                    puntaje_icp: p.puntaje_icp,
                },
            });
            accionesGeneradas++;
        }
    }

    return {
        ok: true,
        resultado: { creados, accionesGeneradas, saltados, total: prospectos.length },
    };
}

async function idAsistente(area: string): Promise<string | null> {
    const { data } = await supabase.from('asistentes').select('id').eq('area', area).maybeSingle();
    return (data?.id as string) ?? null;
}
