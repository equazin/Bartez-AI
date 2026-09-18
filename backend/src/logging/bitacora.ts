// Bitácora: registra cada acción de cada asistente. Base para observabilidad y
// para el sandbox de prompts (que corre versiones nuevas contra casos reales).

import { supabase } from '../connectors/supabase.js';

export interface RegistroLog {
    asistenteId: string;
    conversacionId?: string;
    entrada?: Record<string, unknown>;
    salida?: Record<string, unknown>;
    herramienta?: string;
    tokensIn?: number;
    tokensOut?: number;
    costoUsd?: number;
    duracionMs?: number;
    error?: string;
}

export const bitacora = {
    async registrar(r: RegistroLog): Promise<void> {
        const { error } = await supabase.from('logs_asistente').insert({
            asistente_id: r.asistenteId,
            conversacion_id: r.conversacionId,
            entrada: r.entrada,
            salida: r.salida,
            herramienta: r.herramienta,
            tokens_in: r.tokensIn,
            tokens_out: r.tokensOut,
            costo_usd: r.costoUsd,
            duracion_ms: r.duracionMs,
            error: r.error,
        });
        if (error) {
            console.error('[bitacora] fallo al escribir log', error.message);
        }
    },
};
