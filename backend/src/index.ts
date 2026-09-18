// Entry point del backend.
// Expone una API HTTP mínima que el panel web consume.

import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
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
    const inicioHoy = `${hoy}T00:00:00Z`;

    // Agregar en vivo desde logs_asistente: agrupar por asistente y sumar.
    const { data: logs } = await supabase
        .from('logs_asistente')
        .select('asistente_id, tokens_in, tokens_out, costo_usd')
        .gte('creado_en', inicioHoy);

    const porAsistente = new Map<string, {
        asistente_id: string;
        conversaciones: number;
        mensajes: number;
        acciones_aprobadas: number;
        acciones_editadas: number;
        acciones_rechazadas: number;
        tokens_totales: number;
        costo_usd_total: number;
    }>();

    for (const l of logs ?? []) {
        const id = l.asistente_id as string;
        if (!id) continue;
        const acc = porAsistente.get(id) ?? {
            asistente_id: id,
            conversaciones: 0,
            mensajes: 0,
            acciones_aprobadas: 0,
            acciones_editadas: 0,
            acciones_rechazadas: 0,
            tokens_totales: 0,
            costo_usd_total: 0,
        };
        acc.mensajes += 1;
        acc.tokens_totales += (l.tokens_in ?? 0) + (l.tokens_out ?? 0);
        acc.costo_usd_total += Number(l.costo_usd ?? 0);
        porAsistente.set(id, acc);
    }

    // Contar conversaciones únicas por asistente hoy
    const { data: convs } = await supabase
        .from('conversaciones')
        .select('id, asistente_id')
        .gte('creado_en', inicioHoy);
    for (const c of convs ?? []) {
        const acc = porAsistente.get(c.asistente_id as string);
        if (acc) acc.conversaciones += 1;
    }

    // Acciones aprobadas/editadas/rechazadas de hoy
    const { data: acciones } = await supabase
        .from('acciones_pendientes')
        .select('asistente_id, estado')
        .gte('creado_en', inicioHoy);
    for (const a of acciones ?? []) {
        const acc = porAsistente.get(a.asistente_id as string);
        if (!acc) continue;
        if (a.estado === 'aprobada') acc.acciones_aprobadas += 1;
        if (a.estado === 'editada') acc.acciones_editadas += 1;
        if (a.estado === 'rechazada') acc.acciones_rechazadas += 1;
    }

    const { data: negocio } = await supabase
        .from('metricas_negocio')
        .select('*')
        .eq('fecha', hoy)
        .maybeSingle();

    // Agregar el nombre del asistente para que el dashboard no muestre UUIDs
    const { data: asistentes } = await supabase.from('asistentes').select('id, nombre');
    const nombres = new Map((asistentes ?? []).map((a) => [a.id, a.nombre]));
    const sistema = Array.from(porAsistente.values()).map((m) => ({
        ...m,
        nombre: nombres.get(m.asistente_id) ?? m.asistente_id.slice(0, 8),
    }));

    return { sistema, negocio: negocio ?? null };
});

async function main() {
    await app.register(cors, {
        origin: true, // en dev acepta cualquier origen local (localhost:5173, etc.)
    });
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
