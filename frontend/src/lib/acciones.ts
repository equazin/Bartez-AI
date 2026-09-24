// Cómo se muestra una propuesta de los asistentes en listas: canal, a quién
// va, título y texto. Lo usan el Inicio y Para aprobar.

import type { AccionPendiente } from '../api/client.ts';

export const CANAL: Record<string, string> = { enviar_correo: 'Correo', enviar_whatsapp: 'WhatsApp' };

export function resumenAccion(a: AccionPendiente): { destino: string; titulo: string; cuerpo: string } {
    const p = a.payload ?? {};
    if (a.accion === 'enviar_whatsapp') {
        return {
            destino: String(p.nombreCliente || p.nombreContacto || `+${p.waId ?? ''}`),
            titulo: 'Respuesta de WhatsApp',
            cuerpo: String(p.cuerpo ?? ''),
        };
    }
    if (a.accion === 'enviar_correo') {
        return {
            destino: String(p.nombreCliente || p.para || ''),
            titulo: String(p.asunto ?? '(sin asunto)'),
            cuerpo: String(p.cuerpo ?? ''),
        };
    }
    return { destino: a.asistente_nombre ?? '', titulo: a.accion, cuerpo: JSON.stringify(p).slice(0, 200) };
}

export function hace(iso: string): string {
    const min = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
    if (min < 1) return 'recién';
    if (min < 60) return `hace ${min} min`;
    const h = Math.floor(min / 60);
    if (h < 24) return `hace ${h} h`;
    const d = Math.floor(h / 24);
    return `hace ${d} día${d > 1 ? 's' : ''}`;
}
