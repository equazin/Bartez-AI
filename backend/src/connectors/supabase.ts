import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL ?? '';
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

if (!url || !key) {
    console.warn('[supabase] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY sin definir — modo sin persistencia');
}

export const supabase = createClient(url || 'http://localhost:54321', key || 'stub');
