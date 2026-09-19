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

    let creados = 0;
    let existentes = 0;
    let saltados = 0;

    for (const p of prospectos) {
        if (!p.nombre) { saltados++; continue; }

        // Dedupe por email si hay, sino por nombre
        const filtro = p.email ? { email: p.email } : { nombre: p.nombre };
        const { data: existente } = await supabase
            .from('clientes')
            .select('id')
            .match(filtro)
            .maybeSingle();

        if (existente) { existentes++; continue; }

        const { error } = await supabase
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
                    propuesta_contacto: p.propuesta_contacto, // guardamos la propuesta como referencia
                },
            });
        if (error) { saltados++; continue; }
        creados++;
    }

    // NOTA: ya no generamos acciones de primer contacto automáticamente.
    // El operador revisa la Base y decide a cuáles contactar con el botón dedicado.
    return {
        ok: true,
        resultado: { creados, existentes, saltados, total: prospectos.length },
    };
}
