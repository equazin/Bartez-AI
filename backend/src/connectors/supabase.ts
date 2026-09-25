import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL ?? '';
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

if (!url || !key) {
    console.warn('[supabase] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY sin definir — modo sin persistencia');
}

export const supabase = createClient(url || 'http://localhost:54321', key || 'stub');

// Los emails de clientes se guardan en minúscula y se buscan exacto (sin LIKE):
// en una dirección que llega de afuera, "%" o "_" funcionarían como comodines y
// un correo falsificado podría pegarse a otro cliente.
export const emailNormal = (s: string) => s.trim().toLowerCase();

// Para .ilike() con un dato de afuera: % y _ se buscan literal.
export const likeLiteral = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
