// Historia de correos al día: cada correo que manda Bartez AI y cada uno que
// entra por la casilla queda en correos_historicos, que es lo que muestra la
// línea de tiempo de cada cliente. Sin esto, la historia quedaba congelada en
// la última importación manual. Idempotente por message_id.

import { supabase } from '../connectors/supabase.js';

export interface CorreoParaHistoria {
    direccion: 'entrante' | 'saliente';
    de: string;
    para: string;
    deNombre?: string | null;
    asunto: string;
    cuerpo: string;
    fecha?: Date;
    messageId: string;
    clienteId?: string | null;
    categoria?: string | null;
    ignorable?: boolean;
    carpeta: string;
}

async function clientePorEmail(email: string): Promise<string | null> {
    const { data } = await supabase.from('clientes').select('id').ilike('email', email).limit(2);
    return data && data.length === 1 ? (data[0]!.id as string) : null;
}

// Nunca frena el envío ni la recepción: si falla, avisa en el log y sigue.
export async function registrarCorreoEnHistoria(c: CorreoParaHistoria): Promise<void> {
    try {
        if (!c.messageId) return;
        const contraparte = (c.direccion === 'entrante' ? c.de : c.para).trim().toLowerCase();
        const clienteId = c.clienteId ?? (contraparte ? await clientePorEmail(contraparte) : null);
        const { error } = await supabase.from('correos_historicos').upsert({
            cliente_id: clienteId,
            direccion: c.direccion,
            de_email: c.de.trim().toLowerCase() || null,
            de_nombre: c.deNombre ?? null,
            para_email: c.para.trim().toLowerCase() || null,
            asunto: c.asunto || null,
            cuerpo: c.cuerpo.slice(0, 15000),
            fecha: (c.fecha ?? new Date()).toISOString(),
            message_id: c.messageId,
            carpeta: c.carpeta,
            categoria: c.categoria ?? null,
            ignorable: c.ignorable ?? false,
            dominio: contraparte.split('@')[1] || null,
        }, { onConflict: 'message_id', ignoreDuplicates: true });
        if (error) console.warn('[historia-correos] no se pudo registrar:', error.message);
    } catch (err) {
        console.warn('[historia-correos] no se pudo registrar:', (err as Error).message);
    }
}
