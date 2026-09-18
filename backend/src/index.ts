// Entry point del backend.
// Expone una API HTTP mínima que el panel web consume.

import Fastify from 'fastify';
import { z } from 'zod';
import { catalogo } from './orchestrator/catalog.js';
import { enrutar } from './orchestrator/router.js';
import { supabase } from './connectors/supabase.js';

const app = Fastify({ logger: true });

const TareaSchema = z.object({
    canal: z.enum(['correo', 'whatsapp', 'panel']),
    clienteId: z.string().uuid().optional(),
    conversacionId: z.string().uuid().optional(),
    texto: z.string().min(1),
    metadata: z.record(z.unknown()).optional(),
});

app.get('/health', async () => ({ ok: true }));

app.get('/asistentes', async () => {
    return { asistentes: catalogo.listarActivos().map((a) => a.config) };
});

app.post('/tareas', async (req, res) => {
    const parseo = TareaSchema.safeParse(req.body);
    if (!parseo.success) {
        return res.status(400).send({ error: parseo.error.flatten() });
    }
    const resultado = await enrutar(parseo.data);
    return { resultado };
});

app.get('/metricas/hoy', async () => {
    const hoy = new Date().toISOString().slice(0, 10);
    const { data: sistema } = await supabase
        .from('metricas_diarias')
        .select('*')
        .eq('fecha', hoy);
    const { data: negocio } = await supabase
        .from('metricas_negocio')
        .select('*')
        .eq('fecha', hoy)
        .maybeSingle();
    return { sistema: sistema ?? [], negocio: negocio ?? null };
});

async function main() {
    try {
        await catalogo.cargar();
    } catch (err) {
        app.log.warn({ err }, 'no se pudo cargar catálogo — arrancando vacío');
    }
    const port = Number(process.env.PORT ?? 3000);
    await app.listen({ port, host: '0.0.0.0' });
}

main().catch((err) => {
    app.log.error(err);
    process.exit(1);
});
