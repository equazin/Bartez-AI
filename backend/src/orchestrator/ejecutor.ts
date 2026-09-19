// Ejecutor de acciones: sabe cómo llevar a cabo cada tipo de acción propuesta.
// Usado tanto por el router (cuando el asistente autoresponde) como por
// /acciones/:id/aprobar (cuando la aprueba un humano).

import { enviarCorreo, ferozoConfigurado } from '../connectors/ferozo.js';
import { supabase } from '../connectors/supabase.js';
import { actualizarProspectoEnNotion, crearProspectoEnNotion, crearTareaEnNotion, TareaNueva } from './notion_sync.js';

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
            const clienteId = (p.clienteId as string | undefined) ?? null;

            let messageId: string | undefined;
            if (!ferozoConfigurado) {
                messageId = 'simulado';
            } else {
                const info = await enviarCorreo({
                    para,
                    asunto,
                    cuerpo,
                    inReplyTo: p.inReplyTo as string | undefined,
                    references: p.references as string | undefined,
                });
                messageId = info.messageId;
            }

            // Trackeo de contacto: si sabemos qué cliente es (viene de Contactar o
            // de Seguimientos), actualizamos ultimo_contacto_en y sumamos 1 al
            // contador de intentos. Sirve para que el asistente de Seguimientos
            // decida cuándo volver a insistir.
            if (clienteId) {
                const { data: actual } = await supabase
                    .from('clientes')
                    .select('intentos_contacto')
                    .eq('id', clienteId)
                    .maybeSingle();
                const nuevos = (actual?.intentos_contacto ?? 0) + 1;
                await supabase
                    .from('clientes')
                    .update({ ultimo_contacto_en: new Date().toISOString(), intentos_contacto: nuevos })
                    .eq('id', clienteId);
                // Best-effort sync a Notion (no bloqueante).
                actualizarProspectoEnNotion(clienteId).catch(() => {});
            }

            // Tareas detectadas por el asistente en el correo: se crean en Notion Tareas
            // best-effort. Si el modelo no detectó nada, el array está vacío.
            const tareas = Array.isArray(p.tareas) ? (p.tareas as TareaNueva[]) : [];
            const nombreCliente = (p.nombreCliente as string | undefined) ?? undefined;
            for (const t of tareas) {
                if (!t?.titulo) continue;
                crearTareaEnNotion({
                    titulo: t.titulo,
                    fecha_limite: t.fecha_limite ?? null,
                    contexto: t.contexto,
                    cliente: nombreCliente,
                }).catch(() => {});
            }

            return {
                ok: true,
                detalle: !ferozoConfigurado ? 'ferozo sin configurar — envío simulado' : undefined,
                resultado: !ferozoConfigurado
                    ? { messageId, para, simulado: true, tareasCreadas: tareas.length }
                    : { messageId, para, tareasCreadas: tareas.length },
            };
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
    telefono?: string | null;
    sitio_web?: string;
    fuente_email?: string;
    razon?: string;
    señal?: string;
    puntaje_icp?: number;
    propuesta_contacto?: string;
}

const RE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function ejecutarProspectos(payload: Record<string, unknown>): Promise<ResultadoEjecucion> {
    const prospectos = Array.isArray(payload.prospectos) ? (payload.prospectos as ProspectoRaw[]) : [];
    if (prospectos.length === 0) return { ok: false, detalle: 'no hay prospectos en el payload' };

    let creados = 0;
    let existentes = 0;
    let saltados = 0;
    let sin_email = 0;

    for (const p of prospectos) {
        if (!p.nombre) { saltados++; continue; }

        // Email preferencial, no excluyente: si viene, validamos formato y usamos para dedupe.
        const emailRaw = p.email?.trim().toLowerCase();
        const email = emailRaw && RE_EMAIL.test(emailRaw) ? emailRaw : null;
        if (!email) sin_email++;

        // Dedupe: por email si hay, sino por nombre.
        const filtro = email ? { email } : { nombre: p.nombre };
        const { data: existente } = await supabase
            .from('clientes')
            .select('id')
            .match(filtro)
            .maybeSingle();

        if (existente) { existentes++; continue; }

        const { data: nuevo, error } = await supabase
            .from('clientes')
            .insert({
                nombre: p.nombre,
                email,
                origen: 'prospeccion',
                estado: 'lead',
                metadata: {
                    sitio_web: p.sitio_web,
                    fuente_email: p.fuente_email,
                    telefono: p.telefono,
                    senial: p.señal,
                    razon_prospeccion: p.razon,
                    puntaje_icp: p.puntaje_icp,
                    propuesta_contacto: p.propuesta_contacto,
                },
            })
            .select('id')
            .single();
        if (error || !nuevo) { saltados++; continue; }
        creados++;
        // Best-effort sync a Notion (no bloqueante).
        crearProspectoEnNotion(nuevo.id).catch(() => {});
    }

    return {
        ok: true,
        resultado: { creados, existentes, saltados, sin_email, total: prospectos.length },
    };
}
