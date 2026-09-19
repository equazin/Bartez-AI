// Entry point del backend.
// Expone una API HTTP mínima que el panel web consume.

import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { z } from 'zod';
import { catalogo } from './orchestrator/catalog.js';
import { enrutar } from './orchestrator/router.js';
import { supabase } from './connectors/supabase.js';
import { iniciarInboundCorreo } from './inbound/correo.js';
import { ejecutarAccion } from './orchestrator/ejecutor.js';

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
    // Lee TODOS los asistentes del catálogo (activos y dormidos) para el editor
    const { data, error } = await supabase
        .from('asistentes')
        .select('id, nombre, area, modelo, prompt, autonomia, activo, actualizado_en')
        .order('activo', { ascending: false })
        .order('nombre', { ascending: true });
    if (error) throw error;
    return { asistentes: data ?? [] };
});

const AsistenteUpdateSchema = z.object({
    prompt: z.string().optional(),
    modelo: z.enum(['sonnet', 'haiku']).optional(),
    autonomia: z.number().int().min(0).max(100).optional(),
    activo: z.boolean().optional(),
});

app.patch('/asistentes/:id', async (req, res) => {
    const { id } = req.params as { id: string };
    const parseo = AsistenteUpdateSchema.safeParse(req.body ?? {});
    if (!parseo.success) return res.status(400).send({ error: parseo.error.flatten() });

    const cambios = { ...parseo.data, actualizado_en: new Date().toISOString() };
    const { data, error } = await supabase
        .from('asistentes')
        .update(cambios)
        .eq('id', id)
        .select()
        .single();
    if (error) return res.status(404).send({ error: 'Asistente no encontrado' });

    // Recarga el catálogo en memoria para que los cambios apliquen sin reiniciar
    try {
        await catalogo.cargar();
    } catch (err) {
        app.log.warn({ err }, 'no se pudo recargar el catálogo tras patch');
    }

    return { asistente: data };
});

app.post('/tareas', async (req, res) => {
    const parseo = TareaSchema.safeParse(req.body);
    if (!parseo.success) {
        return res.status(400).send({ error: parseo.error.flatten() });
    }
    const resultado = await enrutar(parseo.data);
    return { resultado };
});

const ProspeccionSchema = z.object({ foco: z.string().optional() });

app.post('/prospeccion/buscar', async (req, res) => {
    const parseo = ProspeccionSchema.safeParse(req.body ?? {});
    if (!parseo.success) return res.status(400).send({ error: parseo.error.flatten() });

    const asistente = catalogo.obtenerPorArea('prospeccion');
    if (!asistente) return res.status(400).send({ error: 'Asistente Prospección no está activo' });

    const texto = parseo.data.foco ??
        'Buscá 4 prospectos que encajen con el ICP en Mendoza y alrededores. Priorizá empresas con señales recientes de crecimiento.';

    try {
        const resultado = await asistente.procesar({ canal: 'panel', texto });

        // Loguear la corrida en la bitácora
        await supabase.from('logs_asistente').insert({
            asistente_id: asistente.config.id,
            entrada: { canal: 'panel', foco: parseo.data.foco ?? null },
            salida: { respuesta: resultado.respuesta, accion: resultado.accionPropuesta },
            tokens_in: resultado.tokensIn,
            tokens_out: resultado.tokensOut,
            costo_usd: resultado.costoUsd,
            duracion_ms: resultado.duracionMs,
        });

        // Si trajo prospectos, encola la acción como pendiente
        // (al aprobar vas a crear clientes + acciones de primer contacto)
        if (resultado.accionPropuesta) {
            await supabase.from('acciones_pendientes').insert({
                asistente_id: asistente.config.id,
                accion: resultado.accionPropuesta.tipo,
                payload: resultado.accionPropuesta.payload,
                estado: 'pendiente',
            });
        }

        return { resultado };
    } catch (err) {
        return res.status(500).send({ error: (err as Error).message });
    }
});

app.get('/metricas/serie', async (req) => {
    const query = req.query as { dias?: string };
    const dias = Math.min(Math.max(Number(query.dias ?? 7), 1), 90);
    const hasta = new Date();
    const desde = new Date(hasta.getTime() - dias * 24 * 60 * 60 * 1000);

    const { data: logs, error } = await supabase
        .from('logs_asistente')
        .select('creado_en, tokens_in, tokens_out, costo_usd')
        .gte('creado_en', desde.toISOString());
    if (error) throw error;

    // Agregar por día
    const buckets = new Map<string, { fecha: string; tokens: number; costo_usd: number }>();
    for (let i = 0; i < dias; i++) {
        const d = new Date(desde.getTime() + i * 24 * 60 * 60 * 1000);
        const key = d.toISOString().slice(0, 10);
        buckets.set(key, { fecha: key, tokens: 0, costo_usd: 0 });
    }
    for (const l of logs ?? []) {
        const key = (l.creado_en as string).slice(0, 10);
        const b = buckets.get(key);
        if (!b) continue;
        b.tokens += (l.tokens_in ?? 0) + (l.tokens_out ?? 0);
        b.costo_usd += Number(l.costo_usd ?? 0);
    }
    return { serie: Array.from(buckets.values()) };
});

app.get('/logs', async (req) => {
    const query = req.query as { asistente_id?: string; limit?: string; conversacion_id?: string };
    const limit = Math.min(Number(query.limit ?? 50), 200);

    let q = supabase
        .from('logs_asistente')
        .select('id, asistente_id, conversacion_id, entrada, salida, herramienta, tokens_in, tokens_out, costo_usd, duracion_ms, error, creado_en')
        .order('creado_en', { ascending: false })
        .limit(limit);
    if (query.asistente_id) q = q.eq('asistente_id', query.asistente_id);
    if (query.conversacion_id) q = q.eq('conversacion_id', query.conversacion_id);

    const { data, error } = await q;
    if (error) throw error;

    const { data: asistentes } = await supabase.from('asistentes').select('id, nombre');
    const nombres = new Map((asistentes ?? []).map((a) => [a.id, a.nombre]));
    return {
        logs: (data ?? []).map((l) => ({
            ...l,
            asistente_nombre: nombres.get(l.asistente_id) ?? null,
        })),
    };
});

app.get('/conversaciones/:id/mensajes', async (req, res) => {
    const { id } = req.params as { id: string };
    const { data, error } = await supabase
        .from('mensajes')
        .select('id, remitente, texto, creado_en')
        .eq('conversacion_id', id)
        .order('creado_en', { ascending: true });
    if (error) return res.status(404).send({ error: error.message });
    return { mensajes: data ?? [] };
});

// ---------- Acciones pendientes ----------

app.get('/acciones', async (req) => {
    const query = req.query as { estado?: string; limit?: string };
    const estado = query.estado ?? 'pendiente';
    const limit = Math.min(Number(query.limit ?? 50), 200);

    const { data, error } = await supabase
        .from('acciones_pendientes')
        .select('id, asistente_id, conversacion_id, accion, payload, estado, respuesta, notificado_en, resuelto_en, creado_en')
        .eq('estado', estado)
        .order('creado_en', { ascending: false })
        .limit(limit);
    if (error) throw error;

    const { data: asistentes } = await supabase.from('asistentes').select('id, nombre');
    const nombres = new Map((asistentes ?? []).map((a) => [a.id, a.nombre]));
    return {
        acciones: (data ?? []).map((a) => ({
            ...a,
            asistente_nombre: nombres.get(a.asistente_id) ?? null,
        })),
    };
});

const ResolucionSchema = z.object({
    payload: z.record(z.unknown()).optional(), // solo cuando estado="editada": el payload editado
    nota: z.string().optional(),
});

app.post('/acciones/:id/aprobar', async (req, res) => {
    const { id } = req.params as { id: string };
    const parseo = ResolucionSchema.safeParse(req.body ?? {});
    if (!parseo.success) return res.status(400).send({ error: parseo.error.flatten() });

    // Marcar aprobada primero, atómicamente (evita doble ejecución si el user hace clic dos veces)
    const { data, error } = await supabase
        .from('acciones_pendientes')
        .update({
            estado: 'aprobada',
            respuesta: { por: 'humano', nota: parseo.data.nota ?? null },
            resuelto_en: new Date().toISOString(),
        })
        .eq('id', id)
        .eq('estado', 'pendiente')
        .select()
        .single();
    if (error || !data) return res.status(404).send({ error: 'Acción no encontrada o ya resuelta' });

    const ejec = await ejecutarAccion({ accion: data.accion as string, payload: data.payload as Record<string, unknown> });
    // Registrar el resultado de la ejecución en la misma fila
    await supabase
        .from('acciones_pendientes')
        .update({ respuesta: { ...(data.respuesta ?? {}), ejecucion: ejec } })
        .eq('id', id);

    return { accion: data, ejecucion: ejec };
});

app.post('/acciones/:id/editar', async (req, res) => {
    const { id } = req.params as { id: string };
    const parseo = ResolucionSchema.safeParse(req.body ?? {});
    if (!parseo.success || !parseo.data.payload) {
        return res.status(400).send({ error: 'Falta payload editado' });
    }

    const { data, error } = await supabase
        .from('acciones_pendientes')
        .update({
            estado: 'editada',
            payload: parseo.data.payload,
            respuesta: { por: 'humano', nota: parseo.data.nota ?? null },
            resuelto_en: new Date().toISOString(),
        })
        .eq('id', id)
        .eq('estado', 'pendiente')
        .select()
        .single();
    if (error || !data) return res.status(404).send({ error: 'Acción no encontrada o ya resuelta' });

    const ejec = await ejecutarAccion({ accion: data.accion as string, payload: data.payload as Record<string, unknown> });
    await supabase
        .from('acciones_pendientes')
        .update({ respuesta: { ...(data.respuesta ?? {}), ejecucion: ejec } })
        .eq('id', id);

    return { accion: data, ejecucion: ejec };
});

app.post('/acciones/:id/reintentar', async (req, res) => {
    const { id } = req.params as { id: string };
    const parseo = ResolucionSchema.safeParse(req.body ?? {});
    if (!parseo.success) return res.status(400).send({ error: parseo.error.flatten() });

    const { data, error } = await supabase
        .from('acciones_pendientes')
        .select('id, accion, payload, respuesta')
        .eq('id', id)
        .in('estado', ['aprobada', 'editada'])
        .single();
    if (error || !data) return res.status(404).send({ error: 'Acción no aprobada o inexistente' });

    // Aplicar overrides del payload editado si vinieron
    const payload = parseo.data.payload ? { ...(data.payload as Record<string, unknown>), ...parseo.data.payload } : (data.payload as Record<string, unknown>);
    const ejec = await ejecutarAccion({ accion: data.accion as string, payload });
    await supabase
        .from('acciones_pendientes')
        .update({
            payload,
            respuesta: { ...(data.respuesta ?? {}), ejecucion: ejec, reintento_en: new Date().toISOString() },
        })
        .eq('id', id);

    return { accion: data, ejecucion: ejec };
});

app.post('/acciones/:id/rechazar', async (req, res) => {
    const { id } = req.params as { id: string };
    const parseo = ResolucionSchema.safeParse(req.body ?? {});
    if (!parseo.success) return res.status(400).send({ error: parseo.error.flatten() });

    const { data, error } = await supabase
        .from('acciones_pendientes')
        .update({
            estado: 'rechazada',
            respuesta: { por: 'humano', nota: parseo.data.nota ?? null },
            resuelto_en: new Date().toISOString(),
        })
        .eq('id', id)
        .eq('estado', 'pendiente')
        .select()
        .single();
    if (error) return res.status(404).send({ error: 'Acción no encontrada o ya resuelta' });

    return { accion: data };
});

const MetricaNegocioSchema = z.object({
    propuestas_enviadas: z.number().int().min(0).optional(),
    ventas_cerradas: z.number().int().min(0).optional(),
    prospectos_calificados: z.number().int().min(0).optional(),
    notas: z.string().optional(),
});

app.post('/metricas/negocio/hoy', async (req, res) => {
    const parseo = MetricaNegocioSchema.safeParse(req.body ?? {});
    if (!parseo.success) return res.status(400).send({ error: parseo.error.flatten() });

    const hoy = new Date().toISOString().slice(0, 10);
    const fila = { fecha: hoy, ...parseo.data };

    const { data, error } = await supabase
        .from('metricas_negocio')
        .upsert(fila, { onConflict: 'fecha' })
        .select()
        .single();
    if (error) return res.status(500).send({ error: error.message });
    return { negocio: data };
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

    // Listener IMAP en paralelo (no bloquea el arranque del HTTP server).
    // Si Ferozo no está configurado, imprime un warning y no hace nada.
    iniciarInboundCorreo().catch((err) => app.log.error({ err }, 'inbound-correo cayó'));
}

main().catch((err) => {
    app.log.error(err);
    process.exit(1);
});
