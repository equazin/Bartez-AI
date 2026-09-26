// Entry point del backend.
// Expone una API HTTP mínima que el panel web consume.

import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import cron from 'node-cron';
import { registrarAuth } from './auth.js';
import { z } from 'zod';
import { catalogo } from './orchestrator/catalog.js';
import { enrutar } from './orchestrator/router.js';
import { supabase } from './connectors/supabase.js';
import { iniciarInboundCorreo } from './inbound/correo.js';
import { ejecutarAccion } from './orchestrator/ejecutor.js';
import { correrBarridoSeguimientos, generarSeguimientoIndividual, seguirPresupuestosEnviados } from './orchestrator/seguimientos.js';
import { bootstrapNotion, notionConfigurado } from './connectors/notion.js';
import { actualizarProspectoEnNotion, backfillProspectosANotion, catalogoDbId, guardarCatalogoDbId } from './orchestrator/notion_sync.js';
import { correrNotionAgent } from './orchestrator/notion_agent.js';
import { actualizarTablero, correrCurador, estadoNotionAutonomo } from './orchestrator/notion_autonomo.js';
import { invalidarResumenHoy, resumenHoy } from './orchestrator/hoy.js';
import { calcularMapa } from './orchestrator/mapa.js';
import { crearCliente, editarCliente } from './orchestrator/clientes.js';
import { NOTA_LARGA, borrarDocumento, borrarNota, cambiarCotizadoDocumento, completarDatosDocumentos, crearNota, retomarPendientes, documentosDeCliente, informesDeCliente, notasDeCliente, reprocesarDocumento, subirDocumento, urlDocumento } from './orchestrator/memoria.js';
import { correrAnalitica, listarReportes, obtenerReporte } from './orchestrator/analitica.js';
import { COSTO_ESTIMADO_POR_CASO, armarBanco, evaluacionEnCurso, iniciarEvaluacion } from './orchestrator/evaluacion.js';
import { refrescarWebBartez, textoWebBartez } from './connectors/bartez_web.js';
import { importarCsv, sincronizarProveedor, sincronizarTodos, tipoDeCambio } from './orchestrator/catalogo_proveedores.js';
import { ajustesWa, borradorWhatsapp, crearClienteDesdeWa, enviarPlantillaAMano, detalleConversacionWa, guardarAjustesWa, guardarPlantillasWa, listarConversacionesWa, listarPlantillasWa, proponerPlantillaWa, proponerRespuestaWhatsapp, responderWhatsappAMano, sincronizarWhatsapp, vincularClienteWa } from './orchestrator/whatsapp.js';
import { studioConfigurado } from './connectors/studio.js';
import { DE_DOCUMENTO, actualizarCotizacion, borrarCotizacion, cerrarCotizacion, cotizar, listarCotizaciones, numeroPresupuesto, obtenerCotizacion, proponerEnvioCotizacion } from './orchestrator/cotizador.js';
import { generarPresupuestoPdf } from './pdf/presupuesto.js';
import { importarHistorico, historicoConCliente } from './inbound/importar_historico.js';
import { destilarLecciones, destilarPendientes, listarAprendizajes, olvidarCacheLecciones, registrarCorreccion } from './orchestrator/aprendizaje.js';
import { actualizarMemoriasPendientes, descartarContactoDetectado, detalleContactoDetectado, detalleEmpresa, generarInformeCliente, listarEmpresasParaSeguimiento, promoverContactoDetectado } from './orchestrator/informe_cliente.js';

// trustProxy: detrás del proxy de Railway, req.ip es la IP real del cliente.
const app = Fastify({ logger: true, trustProxy: true });

// Solo el panel (local o GitHub Pages) puede llamar al backend: evita que
// cualquier web que abras en el navegador use tu backend local.
const origenesPermitidos = [
    /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/,
    'https://equazin.github.io',
    ...(process.env.FRONTEND_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
];
await app.register(cors, { origin: origenesPermitidos });
// Chrome pide permiso explícito para que un sitio público hable con localhost.
app.addHook('onSend', async (req, reply) => {
    if (req.method === 'OPTIONS' && req.headers['access-control-request-private-network']) {
        reply.header('Access-Control-Allow-Private-Network', 'true');
    }
});
registrarAuth(app);

const TareaSchema = z.object({
    canal: z.enum(['correo', 'whatsapp', 'panel']),
    clienteId: z.string().uuid().optional(),
    conversacionId: z.string().uuid().optional(),
    texto: z.string().min(1),
    metadata: z.record(z.unknown()).optional(),
});

app.get('/health', async () => ({ ok: true }));

app.post('/seguimientos/correr', async () => {
    // Dispara el barrido a demanda. En condiciones normales corre solo por cron
    // a las 9 AM AR; este endpoint sirve para testeo o para forzar una revisión.
    const resultado = await correrBarridoSeguimientos();
    return { resultado };
});

app.post('/notion/bootstrap', async () => {
    // Crea los databases de Notion si no existen. Idempotente.
    return await bootstrapNotion();
});

app.post('/notion/backfill', async () => {
    // Sincroniza a Notion todos los prospectos que todavía no tienen notion_page_id.
    // Útil después de configurar Notion por primera vez si ya había prospectos en la Base.
    return await backfillProspectosANotion();
});

const NotionPedirSchema = z.object({ texto: z.string().min(1) });
app.post('/notion/pedir', async (req, res) => {
    const parseo = NotionPedirSchema.safeParse(req.body ?? {});
    if (!parseo.success) return res.status(400).send({ error: parseo.error.flatten() });
    const r = await correrNotionAgent(parseo.data.texto);
    return { resultado: r };
});

const CatalogoRegistrarSchema = z.object({ database_id: z.string().min(20) });
app.post('/notion/catalogo/registrar', async (req, res) => {
    const parseo = CatalogoRegistrarSchema.safeParse(req.body ?? {});
    if (!parseo.success) return res.status(400).send({ error: parseo.error.flatten() });
    // Normalizar: aceptar tanto UUID con guiones como sin guiones.
    const id = parseo.data.database_id.replace(/-/g, '').trim();
    await guardarCatalogoDbId(id);
    return { ok: true, catalogo_id: id };
});

app.get('/notion/catalogo', async () => {
    const id = await catalogoDbId();
    return { registrado: Boolean(id), id };
});

app.post('/analitica/correr', async (req) => {
    // Corre el barrido de Analítica ya. En producción corre solo cada lunes 8 AM AR.
    const q = (req.query as { dias?: string }) ?? {};
    const dias = Math.min(Math.max(Number(q.dias ?? 7), 1), 60);
    const r = await correrAnalitica(dias);
    return { resultado: r };
});

app.get('/analitica/informes', async () => {
    const informes = await listarReportes(30);
    return { informes };
});

app.get('/analitica/informes/:id', async (req, res) => {
    const { id } = req.params as { id: string };
    const informe = await obtenerReporte(id);
    if (!informe) return res.status(404).send({ error: 'Informe no encontrado' });
    return { informe };
});

// Notion autónomo: el curador decide qué crear/actualizar/archivar con la
// información de todos los asistentes y después reescribe el tablero.
app.post('/notion/organizar', async (req) => {
    const parseo = z.object({ instruccion: z.string().max(2000).optional() }).safeParse(req.body ?? {});
    const r = await correrCurador({ instruccion: parseo.success ? parseo.data.instruccion : undefined });
    return { resultado: r };
});

app.post('/notion/tablero', async () => ({ resultado: await actualizarTablero() }));

app.get('/notion/autonomo', async () => estadoNotionAutonomo());

app.post('/correos/importar', async (req) => {
    // Import ASYNC: arranca el job en background, devuelve jobId inmediatamente.
    // Para 90+ días el import puede tardar varios minutos (IMAP fetch + Haiku
    // por cada entrante) y superar timeouts del navegador. Se poletea con GET.
    const q = (req.query as { dias?: string; carpetas?: string }) ?? {};
    const dias = Math.min(Math.max(Number(q.dias ?? 90), 1), 365);
    const carpetas = q.carpetas ? q.carpetas.split(',').map((s) => s.trim()).filter(Boolean) : undefined;

    const { data: job, error: errIns } = await supabase
        .from('jobs_import_correos')
        .insert({ estado: 'en_curso', dias })
        .select('id')
        .single();
    if (errIns || !job) return { ok: false, detalle: 'No se pudo crear el job' };

    // Fire-and-forget — no bloqueamos la respuesta HTTP.
    importarHistorico(dias, carpetas)
        .then(async (r) => {
            await supabase.from('jobs_import_correos')
                .update({ estado: r.ok ? 'completado' : 'error', resultado: r as unknown as Record<string, unknown>, error: r.ok ? null : r.detalle, terminado_en: new Date().toISOString() })
                .eq('id', job.id);
        })
        .catch(async (err) => {
            await supabase.from('jobs_import_correos')
                .update({ estado: 'error', error: (err as Error).message, terminado_en: new Date().toISOString() })
                .eq('id', job.id);
        });

    return { ok: true, jobId: job.id, mensaje: 'Import arrancado — usá GET /correos/importar/:jobId para ver el progreso' };
});

app.get('/correos/importar/:jobId', async (req, res) => {
    const { jobId } = req.params as { jobId: string };
    const { data: job } = await supabase.from('jobs_import_correos').select('*').eq('id', jobId).maybeSingle();
    if (!job) return res.status(404).send({ error: 'Job no encontrado' });
    return job;
});

app.get('/clientes/:id/historico-correos', async (req) => {
    const { id } = req.params as { id: string };
    const historia = await historicoConCliente(id, 20);
    return { historico: historia };
});

app.get('/seguimientos/empresas', async () => {
    // Lista todas las empresas con datos agregados (correos, último toque, estado)
    // para el índice de la pestaña Seguimientos.
    const empresas = await listarEmpresasParaSeguimiento();
    return { empresas };
});

app.get('/seguimientos/empresas/:id', async (req, res) => {
    const { id } = req.params as { id: string };
    // ID sintético "det:<dominio>" para contactos detectados que aún no son clientes.
    if (id.startsWith('det:')) {
        const dominio = id.slice(4);
        const detalle = await detalleContactoDetectado(dominio);
        return detalle;
    }
    const detalle = await detalleEmpresa(id);
    if (!detalle) return res.status(404).send({ error: 'Empresa no encontrada' });
    return detalle;
});

const PromoverSchema = z.object({
    dominio: z.string().min(3),
    nombre: z.string().min(1),
    email: z.string().email().nullable().optional(),
});
app.delete('/seguimientos/detectado/:dominio', async (req, res) => {
    // Elimina todos los correos huérfanos de ese dominio. Los que ya están
    // vinculados a un cliente no se tocan.
    const { dominio } = req.params as { dominio: string };
    const r = await descartarContactoDetectado(dominio);
    if (!r.ok) return res.status(500).send({ error: r.detalle });
    return r;
});

app.post('/seguimientos/promover', async (req, res) => {
    const parseo = PromoverSchema.safeParse(req.body ?? {});
    if (!parseo.success) return res.status(400).send({ error: parseo.error.flatten() });
    const r = await promoverContactoDetectado({
        dominio: parseo.data.dominio,
        nombre: parseo.data.nombre,
        email: parseo.data.email ?? null,
    });
    if (!r.ok) return res.status(500).send({ error: r.detalle });
    return r;
});

const RedactarSchema = z.object({
    informe_previo: z.string().optional(),
    contexto_extra: z.string().optional(),
});
app.post('/seguimientos/empresas/:id/redactar', async (req, res) => {
    // Siempre usa el asistente Seguimientos. Toma como contexto los correos
    // históricos con ese cliente + opcionalmente el informe diagnóstico y/o
    // contexto extra que el operador aporta (llamadas, WhatsApp, notas).
    const { id } = req.params as { id: string };
    if (id.startsWith('det:')) {
        return res.status(400).send({ error: 'Primero convertí este contacto en prospecto y después redactá' });
    }
    const parseo = RedactarSchema.safeParse(req.body ?? {});
    if (!parseo.success) return res.status(400).send({ error: parseo.error.flatten() });

    // Lo que escribió el operador queda como nota del cliente (memoria) y le
    // llega al asistente por ahí, igual que el último informe guardado. Si es
    // largo (una conversación pegada), el resumen tarda: esta vez va entero.
    const extra = parseo.data.contexto_extra?.trim() ?? '';
    if (extra) {
        try { await crearNota(id, extra); } catch (err) { return res.status(400).send({ error: (err as Error).message }); }
    }
    const r = await generarSeguimientoIndividual(id, {
        informe_previo: parseo.data.informe_previo,
        contexto_extra: extra.length > NOTA_LARGA ? extra.slice(0, 20_000) : undefined,
    });
    if (!r.ok) return res.status(500).send({ error: r.detalle });
    return r;
});

const InformeSchema = z.object({ contexto_extra: z.string().optional(), desde_cero: z.boolean().optional() });
app.post('/seguimientos/empresas/:id/informe', async (req, res) => {
    const { id } = req.params as { id: string };
    if (id.startsWith('det:')) return res.status(400).send({ error: 'Primero convertí este contacto en prospecto' });
    const parseo = InformeSchema.safeParse(req.body ?? {});
    if (!parseo.success) return res.status(400).send({ error: parseo.error.flatten() });
    const r = await generarInformeCliente(id, { contexto_extra: parseo.data.contexto_extra, desdeCero: parseo.data.desde_cero });
    if (!r.ok) return res.status(500).send({ error: r.detalle ?? 'Falló la generación del informe' });
    return { informe: r };
});

// ---------- Memoria del cliente: informes, notas y documentos ----------

app.get('/seguimientos/empresas/:id/memoria', async (req) => {
    const { id } = req.params as { id: string };
    // Los contactos detectados todavía no son clientes: no tienen memoria.
    if (id.startsWith('det:')) return { informes: [], notas: [], documentos: [] };
    const [informes, notas, documentos] = await Promise.all([informesDeCliente(id), notasDeCliente(id), documentosDeCliente(id)]);
    return { informes, notas, documentos };
});

// El largo lo valida crearNota, con un mensaje que dice cuánto sobra.
const NotaSchema = z.object({ texto: z.string() });
app.post('/seguimientos/empresas/:id/notas', async (req, res) => {
    const { id } = req.params as { id: string };
    if (id.startsWith('det:')) return res.status(400).send({ error: 'Primero convertí este contacto en prospecto' });
    const parseo = NotaSchema.safeParse(req.body ?? {});
    if (!parseo.success) return res.status(400).send({ error: 'Falta el texto de la nota' });
    try { return { nota: await crearNota(id, parseo.data.texto) }; } catch (err) { return res.status(400).send({ error: (err as Error).message }); }
});

app.delete('/seguimientos/notas/:id', async (req) => {
    await borrarNota((req.params as { id: string }).id);
    return { ok: true };
});

// Los archivos llegan en base64 dentro del JSON (hasta 12 MB de archivo).
const DocumentoSchema = z.object({ nombre: z.string().min(1).max(200), tipo_mime: z.string().max(120).optional(), datos_base64: z.string().min(1) });
app.post('/seguimientos/empresas/:id/documentos', { bodyLimit: 20 * 1024 * 1024 }, async (req, res) => {
    const { id } = req.params as { id: string };
    if (id.startsWith('det:')) return res.status(400).send({ error: 'Primero convertí este contacto en prospecto' });
    const parseo = DocumentoSchema.safeParse(req.body ?? {});
    if (!parseo.success) return res.status(400).send({ error: 'Falta el archivo' });
    try {
        return { documento: await subirDocumento(id, parseo.data.nombre, parseo.data.tipo_mime, parseo.data.datos_base64) };
    } catch (err) {
        return res.status(400).send({ error: (err as Error).message });
    }
});

app.get('/seguimientos/documentos/:id/url', async (req, res) => {
    try { return { url: await urlDocumento((req.params as { id: string }).id) }; } catch (err) { return res.status(404).send({ error: (err as Error).message }); }
});

app.post('/seguimientos/documentos/:id/reprocesar', async (req) => {
    await reprocesarDocumento((req.params as { id: string }).id);
    return { ok: true };
});

// Presupuesto del documento: contarlo o no en Cotizado, o elegir qué opción cuenta.
const CotizadoDocSchema = z.object({
    contar: z.boolean().optional(),
    opcion: z.number().int().min(0).optional(),
    nuestro: z.boolean().optional(),
    total: z.object({ monto: z.number().positive().max(1e11), moneda: z.enum(['USD', 'ARS']) }).optional(),
});
app.post('/seguimientos/documentos/:id/cotizado', async (req, res) => {
    const parseo = CotizadoDocSchema.safeParse(req.body ?? {});
    if (!parseo.success) return res.status(400).send({ error: 'Pedido inválido' });
    try {
        const documento = await cambiarCotizadoDocumento((req.params as { id: string }).id, parseo.data);
        if (!documento) return res.status(404).send({ error: 'Documento no encontrado' });
        return { documento };
    } catch (err) {
        return res.status(400).send({ error: (err as Error).message });
    }
});

app.delete('/seguimientos/documentos/:id', async (req) => {
    await borrarDocumento((req.params as { id: string }).id);
    return { ok: true };
});

// ---------- Proveedores y Cotizador ----------

app.get('/proveedores', async () => {
    const { data } = await supabase.from('proveedores').select('*').order('codigo');
    let tc: { valor: number; fuente: string } | null = null;
    try { tc = await tipoDeCambio(); } catch { /* sin tipo de cambio */ }
    return { proveedores: data ?? [], tipo_cambio: tc };
});

const ProveedorUpdateSchema = z.object({
    activo: z.boolean().optional(),
    margen_pct: z.number().min(0).max(500).optional(),
});
app.patch('/proveedores/:codigo', async (req, res) => {
    const { codigo } = req.params as { codigo: string };
    const parseo = ProveedorUpdateSchema.safeParse(req.body ?? {});
    if (!parseo.success) return res.status(400).send({ error: parseo.error.flatten() });
    const { data, error } = await supabase.from('proveedores').update(parseo.data).eq('codigo', codigo).select().single();
    if (error) return res.status(404).send({ error: 'Proveedor no encontrado' });
    return { proveedor: data };
});

app.post('/proveedores/sincronizar', async () => ({ resultados: await sincronizarTodos() }));

app.post('/proveedores/:codigo/sincronizar', async (req) => {
    const { codigo } = req.params as { codigo: string };
    return { resultado: await sincronizarProveedor(codigo) };
});

const CsvSchema = z.object({ csv: z.string().min(10), moneda: z.enum(['USD', 'ARS']).optional() });
app.post('/proveedores/:codigo/importar-csv', { bodyLimit: 30 * 1024 * 1024 }, async (req, res) => {
    const { codigo } = req.params as { codigo: string };
    const parseo = CsvSchema.safeParse(req.body ?? {});
    if (!parseo.success) return res.status(400).send({ error: parseo.error.flatten() });
    return { resultado: await importarCsv(codigo, parseo.data.csv, parseo.data.moneda ?? 'USD') };
});

app.get('/catalogo/buscar', async (req) => {
    const q = (req.query as { q?: string; stock?: string }) ?? {};
    if (!q.q) return { items: [] };
    const { data, error } = await supabase.rpc('buscar_catalogo', { q: q.q, limite: 30, solo_stock: q.stock === '1' });
    if (error) return { items: [], error: error.message };
    return { items: data ?? [] };
});

const CotizarSchema = z.object({ pedido: z.string().min(3), cliente_id: z.string().uuid().optional() });
app.post('/cotizaciones', async (req, res) => {
    const parseo = CotizarSchema.safeParse(req.body ?? {});
    if (!parseo.success) return res.status(400).send({ error: parseo.error.flatten() });
    const r = await cotizar(parseo.data.pedido, { cliente_id: parseo.data.cliente_id });
    if (!r.ok) return res.status(400).send({ error: r.detalle });
    return { cotizacion: r };
});

app.get('/cotizaciones', async () => ({ cotizaciones: await listarCotizaciones() }));

app.get('/cotizaciones/:id', async (req, res) => {
    const { id } = req.params as { id: string };
    if (!z.string().uuid().safeParse(id).success) return res.status(400).send({ error: 'id inválido' });
    const cot = await obtenerCotizacion(id);
    if (!cot) return res.status(404).send({ error: 'cotización no encontrada' });
    return { cotizacion: cot };
});

const campoCliente = z.string().max(500).optional();
const ActualizarCotizacionSchema = z.object({
    titulo: z.string().max(200).nullable().optional(),
    datos_cliente: z.object({
        cuit: campoCliente, direccion: campoCliente, localidad: campoCliente, atencion: campoCliente, email: campoCliente,
        objeto: z.string().max(2000).optional(),
    }).optional(),
});

app.patch('/cotizaciones/:id', async (req, res) => {
    const { id } = req.params as { id: string };
    const parseo = ActualizarCotizacionSchema.safeParse(req.body ?? {});
    if (!z.string().uuid().safeParse(id).success || !parseo.success) return res.status(400).send({ error: 'datos inválidos' });
    const cambios: Parameters<typeof actualizarCotizacion>[1] = {};
    if (parseo.data.titulo !== undefined) cambios.titulo = parseo.data.titulo?.trim() || null;
    if (parseo.data.datos_cliente) {
        cambios.datos_cliente = Object.fromEntries(
            Object.entries(parseo.data.datos_cliente).map(([k, v]) => [k, (v ?? '').trim()]).filter(([, v]) => v),
        );
    }
    if (!(await actualizarCotizacion(id, cambios))) return res.status(404).send({ error: 'cotización no encontrada' });
    return { ok: true };
});

// PDF del presupuesto. Descargarlo asigna el número y lo marca enviado;
// con ?borrador=1 es una vista previa que no toca nada.
app.get('/cotizaciones/:id/pdf', async (req, res) => {
    const { id } = req.params as { id: string };
    const borrador = (req.query as { borrador?: string }).borrador === '1';
    if (!z.string().uuid().safeParse(id).success) return res.status(400).send({ error: 'id inválido' });
    const q = await obtenerCotizacion(id);
    if (!q) return res.status(404).send({ error: 'cotización no encontrada' });
    if (q.origen === 'documento') return res.status(400).send({ error: DE_DOCUMENTO });
    if (!q.lineas.some((l) => l.elegido)) return res.status(400).send({ error: 'La cotización no tiene artículos para presupuestar' });
    const numero = borrador ? q.numero : await numeroPresupuesto(id);
    const { pdf, archivo } = generarPresupuestoPdf(q, numero);
    if (!borrador) invalidarResumenHoy();
    return res
        .header('Content-Type', 'application/pdf')
        .header('Content-Disposition', `${borrador ? 'inline' : 'attachment'}; filename="${archivo}"`)
        .header('Access-Control-Expose-Headers', 'Content-Disposition')
        .send(pdf);
});

const EnviarCotizacionSchema = z.object({
    para: z.string().email(),
    nombre: z.string().max(200).optional(),
});

// Enviar un presupuesto por correo: arma el mensaje con el PDF adjunto y lo
// deja en Para aprobar (nada sale sin tu OK).
app.post('/cotizaciones/:id/enviar', async (req, res) => {
    const { id } = req.params as { id: string };
    const parseo = EnviarCotizacionSchema.safeParse(req.body ?? {});
    if (!z.string().uuid().safeParse(id).success || !parseo.success) return res.status(400).send({ error: 'Falta un email válido' });
    const r = await proponerEnvioCotizacion(id, parseo.data.para, parseo.data.nombre);
    if (!r.ok) return res.status(400).send({ error: r.detalle });
    invalidarResumenHoy();
    return r;
});

const CierreSchema = z.object({
    estado: z.enum(['abierta', 'enviada', 'ganada', 'perdida']),
    motivo: z.string().max(300).nullable().optional(),
});

// Cómo terminó un presupuesto: ganada o perdida (con motivo), o se reabre.
app.post('/cotizaciones/:id/cierre', async (req, res) => {
    const { id } = req.params as { id: string };
    const parseo = CierreSchema.safeParse(req.body ?? {});
    if (!z.string().uuid().safeParse(id).success || !parseo.success) return res.status(400).send({ error: 'datos inválidos' });
    const r = await cerrarCotizacion(id, parseo.data.estado, parseo.data.motivo);
    if (!r.ok) return res.status(404).send({ error: 'cotización no encontrada' });
    invalidarResumenHoy();
    return r;
});

app.post('/cotizaciones/:id/numero', async (req, res) => {
    const { id } = req.params as { id: string };
    if (!z.string().uuid().safeParse(id).success) return res.status(400).send({ error: 'id inválido' });
    let numero: number | null;
    try { numero = await numeroPresupuesto(id); } catch (err) { return res.status(400).send({ error: (err as Error).message }); }
    if (numero == null) return res.status(404).send({ error: 'cotización no encontrada' });
    return { numero };
});

app.delete('/cotizaciones/:id', async (req, res) => {
    const { id } = req.params as { id: string };
    if (!z.string().uuid().safeParse(id).success) return res.status(400).send({ error: 'id inválido' });
    if (!(await borrarCotizacion(id))) return res.status(404).send({ error: 'cotización no encontrada' });
    return { ok: true };
});

// ---------- WhatsApp (vía la API de bartez.com.ar) ----------

const esWaId = (v: string) => /^\d{8,15}$/.test(v);

app.get('/whatsapp/estado', async () => ({ configurado: studioConfigurado() }));

app.post('/whatsapp/sincronizar', async () => ({ resultado: await sincronizarWhatsapp() }));

app.get('/whatsapp/conversaciones', async () => ({ conversaciones: await listarConversacionesWa() }));

app.get('/whatsapp/conversaciones/:waId', async (req, res) => {
    const { waId } = req.params as { waId: string };
    if (!esWaId(waId)) return res.status(400).send({ error: 'número inválido' });
    const d = await detalleConversacionWa(waId);
    if (!d) return res.status(404).send({ error: 'conversación no encontrada' });
    return d;
});

// Con qué nombre se presenta el asistente en WhatsApp (vacío = sin nombre propio).
app.get('/whatsapp/ajustes', async () => ({ ajustes: await ajustesWa() }));
app.put('/whatsapp/ajustes', async (req, res) => {
    const parseo = z.object({ presentarse_como: z.string().max(60) }).safeParse(req.body ?? {});
    if (!parseo.success) return res.status(400).send({ error: 'El nombre puede tener hasta 60 caracteres' });
    await guardarAjustesWa(parseo.data);
    return { ajustes: await ajustesWa() };
});

// Respuesta escrita por el operador: sale ya, sin pasar por Para aprobar.
app.post('/whatsapp/conversaciones/:waId/enviar', async (req, res) => {
    const { waId } = req.params as { waId: string };
    const parseo = z.object({ texto: z.string().min(1).max(4000), desde_propuesta: z.string().uuid().nullable().optional() }).safeParse(req.body ?? {});
    if (!esWaId(waId) || !parseo.success) return res.status(400).send({ error: 'Escribí el mensaje (hasta 4000 caracteres)' });
    try {
        const r = await responderWhatsappAMano(waId, parseo.data.texto, parseo.data.desde_propuesta ?? null);
        if (!r.ok) return res.status(400).send({ error: r.detalle });
        invalidarResumenHoy();
        return r;
    } catch (err) {
        req.log.error({ err }, 'enviar WhatsApp a mano falló');
        return res.status(502).send({ error: `No se pudo enviar por la web: ${(err as Error).message}` });
    }
});

// Borrador para la caja del chat (no queda en Para aprobar).
app.post('/whatsapp/conversaciones/:waId/borrador', async (req, res) => {
    const { waId } = req.params as { waId: string };
    const parseo = z.object({ borrador: z.string().max(4000).optional() }).safeParse(req.body ?? {});
    if (!esWaId(waId) || !parseo.success) return res.status(400).send({ error: 'datos inválidos' });
    const r = await borradorWhatsapp(waId, parseo.data.borrador);
    if (!r.ok) return res.status(400).send({ error: r.detalle });
    return { texto: r.texto };
});

app.post('/whatsapp/conversaciones/:waId/proponer', async (req, res) => {
    const { waId } = req.params as { waId: string };
    const parseo = z.object({ contexto_extra: z.string().max(3000).optional() }).safeParse(req.body ?? {});
    if (!esWaId(waId) || !parseo.success) return res.status(400).send({ error: 'datos inválidos' });
    const r = await proponerRespuestaWhatsapp(waId, parseo.data);
    if (!r.ok) return res.status(400).send({ error: r.detalle });
    return r;
});

const PlantillaSchema = z.object({
    nombre: z.string().regex(/^[a-z0-9_]{1,512}$/, 'El nombre va en minúsculas, números y guiones bajos, igual que en Meta'),
    idioma: z.string().min(2).max(10),
    texto: z.string().min(1).max(1024),
    descripcion: z.string().max(200).optional(),
});

app.get('/whatsapp/plantillas', async () => ({ plantillas: await listarPlantillasWa() }));

app.put('/whatsapp/plantillas', async (req, res) => {
    const parseo = z.object({ plantillas: z.array(PlantillaSchema).max(50) }).safeParse(req.body ?? {});
    if (!parseo.success) return res.status(400).send({ error: parseo.error.issues[0]?.message ?? 'datos inválidos' });
    await guardarPlantillasWa(parseo.data.plantillas);
    return { ok: true };
});

app.post('/whatsapp/conversaciones/:waId/plantilla', async (req, res) => {
    const { waId } = req.params as { waId: string };
    const parseo = z.object({ nombre: z.string(), parametros: z.array(z.string().max(1000)).max(10) }).safeParse(req.body ?? {});
    if (!esWaId(waId) || !parseo.success) return res.status(400).send({ error: 'datos inválidos' });
    const r = await proponerPlantillaWa(waId, parseo.data.nombre, parseo.data.parametros);
    if (!r.ok) return res.status(400).send({ error: r.detalle });
    invalidarResumenHoy();
    return r;
});

// Plantilla elegida por el operador (fuera de las 24 h): sale ya.
app.post('/whatsapp/conversaciones/:waId/plantilla/enviar', async (req, res) => {
    const { waId } = req.params as { waId: string };
    const parseo = z.object({ nombre: z.string(), parametros: z.array(z.string().max(1000)).max(10) }).safeParse(req.body ?? {});
    if (!esWaId(waId) || !parseo.success) return res.status(400).send({ error: 'datos inválidos' });
    try {
        const r = await enviarPlantillaAMano(waId, parseo.data.nombre, parseo.data.parametros);
        if (!r.ok) return res.status(400).send({ error: r.detalle });
        invalidarResumenHoy();
        return r;
    } catch (err) {
        req.log.error({ err }, 'enviar plantilla de WhatsApp falló');
        return res.status(502).send({ error: `No se pudo enviar por la web: ${(err as Error).message}` });
    }
});

app.post('/whatsapp/conversaciones/:waId/vincular', async (req, res) => {
    const { waId } = req.params as { waId: string };
    const parseo = z.object({ cliente_id: z.string().uuid().nullable() }).safeParse(req.body ?? {});
    if (!esWaId(waId) || !parseo.success) return res.status(400).send({ error: 'datos inválidos' });
    if (!(await vincularClienteWa(waId, parseo.data.cliente_id))) return res.status(404).send({ error: 'conversación no encontrada' });
    return { ok: true };
});

app.post('/whatsapp/conversaciones/:waId/crear-cliente', async (req, res) => {
    const { waId } = req.params as { waId: string };
    const parseo = z.object({ nombre: z.string().max(200).optional() }).safeParse(req.body ?? {});
    if (!esWaId(waId) || !parseo.success) return res.status(400).send({ error: 'datos inválidos' });
    const r = await crearClienteDesdeWa(waId, parseo.data.nombre);
    if (!r.ok) return res.status(400).send({ error: r.detalle });
    return r;
});

app.post('/bartez/refresh-web', async () => {
    // Fuerza el refetch de www.bartez.com.ar. Al arrancar el backend también
    // se dispara si el caché tiene más de 7 días o no existe.
    const r = await refrescarWebBartez();
    return r;
});

app.get('/bartez/web', async () => {
    const texto = await textoWebBartez();
    return { largo: texto.length, muestra: texto.slice(0, 500) };
});

// Banco de prueba: compara el modelo de antes con el nuevo sobre tus casos reales.
app.get('/evaluaciones', async () => {
    const { data } = await supabase.from('evaluaciones')
        .select('id, creado_en, terminado_en, estado, modelos, casos, hechos, resumen, costo_usd, error')
        .order('creado_en', { ascending: false }).limit(10);
    const casos = (await armarBanco()).length;
    return { evaluaciones: data ?? [], banco: { casos, costo_estimado_usd: Math.round(casos * COSTO_ESTIMADO_POR_CASO * 100) / 100 }, corriendo: evaluacionEnCurso() };
});

app.get('/evaluaciones/:id', async (req, res) => {
    const { id } = req.params as { id: string };
    const { data } = await supabase.from('evaluaciones').select('*').eq('id', id).maybeSingle();
    if (!data) return res.status(404).send({ error: 'Evaluación no encontrada' });
    return { evaluacion: data };
});

app.post('/evaluaciones', async (req, res) => {
    const parseo = z.object({ limite: z.number().int().min(1).max(60).optional() }).safeParse(req.body ?? {});
    if (!parseo.success) return res.status(400).send({ error: parseo.error.flatten() });
    try {
        return await iniciarEvaluacion({ limite: parseo.data.limite });
    } catch (err) {
        return res.status(409).send({ error: (err as Error).message });
    }
});

app.post('/catalogo/recargar', async () => {
    // Fuerza recarga del catálogo desde Supabase — útil cuando se edita un prompt
    // por SQL directo (no por PATCH /asistentes), ya que en ese caso el catálogo
    // en memoria queda desactualizado.
    await catalogo.cargar();
    return { ok: true, cargados: catalogo.listarActivos().length };
});

app.get('/asistentes', async () => {
    // Lee TODOS los asistentes del catálogo (activos y dormidos) para el editor
    const { data, error } = await supabase
        .from('asistentes')
        .select('id, nombre, area, modelo, prompt, autonomia, activo, actualizado_en, lecciones, lecciones_en')
        .order('activo', { ascending: false })
        .order('nombre', { ascending: true });
    if (error) throw error;
    return { asistentes: data ?? [] };
});

const AsistenteUpdateSchema = z.object({
    prompt: z.string().optional(),
    modelo: z.enum(['sonnet', 'haiku', 'opus']).optional(),
    autonomia: z.number().int().min(0).max(100).optional(),
    activo: z.boolean().optional(),
    lecciones: z.string().max(4000).nullable().optional(),
});

app.patch('/asistentes/:id', async (req, res) => {
    const { id } = req.params as { id: string };
    const parseo = AsistenteUpdateSchema.safeParse(req.body ?? {});
    if (!parseo.success) return res.status(400).send({ error: parseo.error.flatten() });

    const cambios = { ...parseo.data, actualizado_en: new Date().toISOString() };
    if (parseo.data.lecciones !== undefined) olvidarCacheLecciones(id);
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

// Aprendizaje: correcciones recientes y lecciones destiladas de un asistente.
app.get('/asistentes/:id/aprendizajes', async (req) => {
    const { id } = req.params as { id: string };
    return { aprendizajes: await listarAprendizajes(id) };
});

app.post('/asistentes/:id/lecciones', async (req, res) => {
    const { id } = req.params as { id: string };
    const r = await destilarLecciones(id, true);
    if (!r.ok) return res.status(400).send({ error: r.detalle });
    return r;
});

app.post('/tareas', async (req, res) => {
    const parseo = TareaSchema.safeParse(req.body);
    if (!parseo.success) {
        return res.status(400).send({ error: parseo.error.flatten() });
    }
    const resultado = await enrutar(parseo.data);
    return { resultado };
});

// ---------- Prospectos (mini-CRM) ----------

app.get('/prospectos', async (req) => {
    const query = req.query as { estado?: string };
    let q = supabase
        .from('clientes')
        .select('id, nombre, email, whatsapp, estado, metadata, creado_en, actualizado_en')
        .eq('origen', 'prospeccion')
        .order('creado_en', { ascending: false });
    if (query.estado && query.estado !== 'todos') q = q.eq('estado', query.estado);

    const { data, error } = await q;
    if (error) throw error;
    return { prospectos: data ?? [] };
});

app.get('/clientes/:id', async (req, res) => {
    const { id } = req.params as { id: string };
    const { data: cliente, error } = await supabase.from('clientes').select('*').eq('id', id).single();
    if (error || !cliente) return res.status(404).send({ error: 'Cliente no encontrado' });

    const { data: convs } = await supabase
        .from('conversaciones')
        .select('id, canal, estado, asunto, creado_en')
        .eq('cliente_id', id)
        .order('creado_en', { ascending: false });

    const { data: acciones } = await supabase
        .from('acciones_pendientes')
        .select('id, accion, estado, payload, creado_en, resuelto_en')
        .in('conversacion_id', (convs ?? []).map((c) => c.id).concat(['00000000-0000-0000-0000-000000000000']))
        .order('creado_en', { ascending: false });

    return { cliente, conversaciones: convs ?? [], acciones: acciones ?? [] };
});

const ClienteUpdateSchema = z.object({
    estado: z.enum(['lead', 'cliente', 'inactivo', 'descartado', 'proveedor']).optional(),
    metadata: z.record(z.unknown()).optional(),
    nombre: z.string().optional(),
    email: z.string().email().optional(),
    whatsapp: z.string().optional(),
});

// ---------- Alta y edición manual de clientes ----------

const texto = (max: number) => z.string().max(max).nullable().optional();
const DatosClienteSchema = z.object({
    nombre: z.string().max(200),
    email: texto(200),
    whatsapp: texto(40),
    estado: z.enum(['lead', 'cliente', 'inactivo', 'descartado', 'proveedor']).optional(),
    contacto: texto(200),
    sitio_web: texto(300),
    cuit: texto(30),
});

// Crea un cliente. Si hay uno parecido (mismo email, teléfono o nombre) devuelve
// 409 con los parecidos; con crear_igual: true lo crea igual.
app.post('/clientes', async (req, res) => {
    const parseo = DatosClienteSchema.extend({ nota: z.string().max(60_000).nullable().optional(), crear_igual: z.boolean().optional() })
        .safeParse(req.body ?? {});
    if (!parseo.success) return res.status(400).send({ error: 'Revisá los datos del cliente' });
    const { crear_igual, ...datos } = parseo.data;
    const r = await crearCliente(datos, { origen: 'manual', crearIgual: crear_igual });
    if (!r.ok) return res.status(r.parecidos?.length ? 409 : 400).send({ error: r.detalle, parecidos: r.parecidos ?? [] });
    invalidarResumenHoy();
    return { cliente: r.cliente, vinculados: r.vinculados };
});

app.put('/clientes/:id/datos', async (req, res) => {
    const { id } = req.params as { id: string };
    if (!z.string().uuid().safeParse(id).success) return res.status(400).send({ error: 'id inválido' });
    const parseo = DatosClienteSchema.safeParse(req.body ?? {});
    if (!parseo.success) return res.status(400).send({ error: 'Revisá los datos del cliente' });
    const r = await editarCliente(id, parseo.data);
    if (!r.ok) return res.status(r.parecidos?.length ? 409 : r.detalle === 'Cliente no encontrado' ? 404 : 400).send({ error: r.detalle, parecidos: r.parecidos ?? [] });
    return { cliente: r.cliente, vinculados: r.vinculados };
});

app.patch('/clientes/:id', async (req, res) => {
    const { id } = req.params as { id: string };
    const parseo = ClienteUpdateSchema.safeParse(req.body ?? {});
    if (!parseo.success) return res.status(400).send({ error: parseo.error.flatten() });

    const cambios = { ...parseo.data, actualizado_en: new Date().toISOString() };
    const { data, error } = await supabase
        .from('clientes')
        .update(cambios)
        .eq('id', id)
        .select()
        .single();
    if (error) return res.status(404).send({ error: 'Cliente no encontrado' });
    // Best-effort sync a Notion.
    actualizarProspectoEnNotion(id).catch(() => {});
    return { cliente: data };
});

const ContactarSchema = z.object({
    area: z.enum(['correo', 'whatsapp']).default('correo'),
    contexto: z.string().optional(),
});

app.post('/clientes/:id/contactar', async (req, res) => {
    const { id } = req.params as { id: string };
    const parseo = ContactarSchema.safeParse(req.body ?? {});
    if (!parseo.success) return res.status(400).send({ error: parseo.error.flatten() });

    const { data: cliente, error } = await supabase.from('clientes').select('*').eq('id', id).single();
    if (error || !cliente) return res.status(404).send({ error: 'Cliente no encontrado' });

    const asistente = catalogo.obtenerPorArea(parseo.data.area);
    if (!asistente) return res.status(400).send({ error: `Asistente "${parseo.data.area}" no está activo` });

    if (parseo.data.area === 'correo' && !cliente.email) {
        return res.status(400).send({ error: 'Este prospecto no tiene email cargado' });
    }
    // Primer contacto por correo: lo escribe Seguimientos (con sus lecciones y
    // tu estilo: corto, datos reales de Bartez). Antes lo escribía Correo, que
    // está hecho para contestar clientes, y rechazabas casi todos.
    if (parseo.data.area === 'correo') {
        try {
            const r = await generarSeguimientoIndividual(id, { contexto_extra: parseo.data.contexto });
            if (!r.ok) return res.status(400).send({ error: r.detalle ?? 'No se pudo redactar' });
            return { resultado: { respuesta: r.respuesta }, mensaje: 'Contacto propuesto, va a Para aprobar esperando tu ok' };
        } catch (err) {
            return res.status(500).send({ error: (err as Error).message });
        }
    }
    if (parseo.data.area === 'whatsapp' && !cliente.whatsapp) {
        return res.status(400).send({ error: 'Este prospecto no tiene WhatsApp cargado' });
    }

    // Armar el "pedido" que ve el asistente: contexto del prospecto + hint del área.
    // Contexto mínimo del prospecto para el primer contacto. NO le pasamos
    // señal ni razón operativa — queremos un correo presentacional breve, no
    // uno que mencione "vi que abrieron sucursal" o "vi que contrataron gente".
    const meta = cliente.metadata as Record<string, unknown> | null;
    const ctxProspecto = [
        `Datos del prospecto:`,
        `- Nombre: ${cliente.nombre}`,
        meta?.sitio_web ? `- Sitio: ${meta.sitio_web}` : null,
    ].filter(Boolean).join('\n');

    const contextoExtra = parseo.data.contexto ? `\n\nContexto adicional del operador:\n${parseo.data.contexto}` : '';
    const texto =
        `PROSPECCIÓN — PRIMER CONTACTO EN FRÍO\n\n${ctxProspecto}${contextoExtra}\n\n` +
        `Redactá un correo BREVE (máx 5 líneas) presentando Bartez Tecnología. ` +
        `Contá qué hacemos (sacalo del bloque INFORMACIÓN DE BARTEZ del system prompt) en 1-2 líneas ` +
        `e invitá a que respondan si les interesa recibir más info o hablar de algún proyecto puntual. ` +
        `NO menciones nada operativo del prospecto (que abrió sucursal, que contrató gente, que se expandió, etc). ` +
        `NO uses la señal detectada como gancho — es un contacto en frío neutro y presentacional. ` +
        `Cerrá firmando "Bartez Tecnología · www.bartez.com.ar".`;

    try {
        // Invoco al asistente directamente (no vía enrutar) porque no queremos que
        // registre el "pedido" del operador como si fuera un correo entrante del cliente.
        const resultado = await asistente.procesar({
            canal: 'whatsapp',
            clienteId: id,
            texto,
            metadata: {
                emailDestino: cliente.email,
                nombreDestino: cliente.nombre,
                asuntoOriginal: `Bartez Tecnología — solución IT para ${cliente.nombre}`,
                clasificacion: { categoria: 'cotizacion_vaga', prioridad: 'media', razon: 'primer contacto de prospección' },
            },
        });

        // Log en bitácora
        await supabase.from('logs_asistente').insert({
            asistente_id: asistente.config.id,
            entrada: { origen: 'contactar_prospecto', cliente_id: id, area: parseo.data.area },
            salida: { respuesta: resultado.respuesta, accion: resultado.accionPropuesta },
            tokens_in: resultado.tokensIn,
            tokens_out: resultado.tokensOut,
            costo_usd: resultado.costoUsd,
            duracion_ms: resultado.duracionMs,
        });

        // Si propuso una acción, va a acciones_pendientes para tu aprobación.
        // No auto-envía primer contacto en frío — SIEMPRE requiere tu ok, más allá de autonomía.
        if (resultado.accionPropuesta) {
            await supabase.from('acciones_pendientes').insert({
                asistente_id: asistente.config.id,
                accion: resultado.accionPropuesta.tipo,
                payload: resultado.accionPropuesta.payload,
                estado: 'pendiente',
                respuesta: { por: 'sistema', origen: 'contactar_prospecto', cliente_id: id },
            });
        }

        return { resultado, mensaje: 'Contacto propuesto, va a Acciones esperando tu aprobación' };
    } catch (err) {
        return res.status(500).send({ error: (err as Error).message });
    }
});

const ProspeccionSchema = z.object({
    foco: z.string().optional(),
    modo: z.enum(['focal', 'sweep']).optional(),
});

app.post('/prospeccion/buscar', async (req, res) => {
    const parseo = ProspeccionSchema.safeParse(req.body ?? {});
    if (!parseo.success) return res.status(400).send({ error: parseo.error.flatten() });

    const asistente = catalogo.obtenerPorArea('prospeccion');
    if (!asistente) return res.status(400).send({ error: 'Asistente Prospección no está activo' });

    const modo = parseo.data.modo ?? 'focal';
    const texto = parseo.data.foco ?? '';

    try {
        const resultado = await asistente.procesar({
            canal: 'panel',
            texto,
            metadata: { modo },
        });

        await supabase.from('logs_asistente').insert({
            asistente_id: asistente.config.id,
            entrada: { canal: 'panel', foco: parseo.data.foco ?? null, modo },
            salida: { respuesta: resultado.respuesta, accion: resultado.accionPropuesta },
            tokens_in: resultado.tokensIn,
            tokens_out: resultado.tokensOut,
            costo_usd: resultado.costoUsd,
            duracion_ms: resultado.duracionMs,
        });

        // Si trajo prospectos, los guardamos directo en la Base (clientes)
        // sin pasar por acciones_pendientes. El operador ya disparó la búsqueda
        // = aprobación implícita para GUARDAR. La aprobación explícita sigue
        // existiendo pero solo para ENVIAR el primer contacto por correo.
        let ejec: Awaited<ReturnType<typeof ejecutarAccion>> | undefined;
        if (resultado.accionPropuesta) {
            ejec = await ejecutarAccion({
                accion: resultado.accionPropuesta.tipo,
                payload: resultado.accionPropuesta.payload,
            });
        }

        return { resultado, guardado: ejec?.resultado };
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
    invalidarResumenHoy();
    const { id } = req.params as { id: string };
    const parseo = ResolucionSchema.safeParse(req.body ?? {});
    if (!parseo.success) return res.status(400).send({ error: parseo.error.flatten() });

    // Marcar aprobada primero, atómicamente (evita doble ejecución si el user hace clic dos veces).
    // Se conserva lo que ya tenía "respuesta" (p. ej. cliente_id, que usa la ficha).
    const previa = await respuestaPrevia(id);
    const { data, error } = await supabase
        .from('acciones_pendientes')
        .update({
            estado: 'aprobada',
            respuesta: { ...previa, por: 'humano', nota: parseo.data.nota ?? null },
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
    invalidarResumenHoy();
    const { id } = req.params as { id: string };
    const parseo = ResolucionSchema.safeParse(req.body ?? {});
    if (!parseo.success || !parseo.data.payload) {
        return res.status(400).send({ error: 'Falta payload editado' });
    }

    // El original hace falta para aprender qué se corrigió.
    const { data: original } = await supabase
        .from('acciones_pendientes').select('id, asistente_id, accion, payload').eq('id', id).eq('estado', 'pendiente').maybeSingle();

    const previaEd = await respuestaPrevia(id);
    const { data, error } = await supabase
        .from('acciones_pendientes')
        .update({
            estado: 'editada',
            payload: parseo.data.payload,
            respuesta: { ...previaEd, por: 'humano', nota: parseo.data.nota ?? null },
            resuelto_en: new Date().toISOString(),
        })
        .eq('id', id)
        .eq('estado', 'pendiente')
        .select()
        .single();
    if (error || !data) return res.status(404).send({ error: 'Acción no encontrada o ya resuelta' });

    if (original) void registrarCorreccion(original, 'edicion', { payloadNuevo: parseo.data.payload, motivo: parseo.data.nota });
    const ejec = await ejecutarAccion({ accion: data.accion as string, payload: data.payload as Record<string, unknown> });
    await supabase
        .from('acciones_pendientes')
        .update({ respuesta: { ...(data.respuesta ?? {}), ejecucion: ejec } })
        .eq('id', id);

    return { accion: data, ejecucion: ejec };
});

async function respuestaPrevia(id: string): Promise<Record<string, unknown>> {
    const { data } = await supabase.from('acciones_pendientes').select('respuesta').eq('id', id).maybeSingle();
    const r = (data?.respuesta as Record<string, unknown> | null) ?? {};
    // Solo datos que identifican (no el resultado de una ejecución anterior).
    return typeof r.cliente_id === 'string' ? { cliente_id: r.cliente_id } : {};
}

// Correos y WhatsApp aprobados que no se pudieron enviar (últimos 30 días): se
// muestran en Para aprobar, en Inicio y en la ficha para reintentar o descartar.
app.get('/acciones/fallidas', async () => {
    const { data, error } = await supabase
        .from('acciones_pendientes')
        .select('id, asistente_id, accion, payload, estado, respuesta, resuelto_en, creado_en')
        .in('estado', ['aprobada', 'editada'])
        .in('accion', ['enviar_correo', 'enviar_whatsapp'])
        .eq('respuesta->ejecucion->>ok', 'false')
        .gte('creado_en', new Date(Date.now() - 30 * 86_400_000).toISOString())
        .order('resuelto_en', { ascending: false })
        .limit(50);
    if (error) throw error;
    return { acciones: data ?? [] };
});

app.post('/acciones/:id/descartar', async (req, res) => {
    const { id } = req.params as { id: string };
    const previa = await supabase.from('acciones_pendientes').select('respuesta').eq('id', id).maybeSingle();
    const { data, error } = await supabase
        .from('acciones_pendientes')
        .update({ estado: 'descartada', respuesta: { ...((previa.data?.respuesta as Record<string, unknown> | null) ?? {}), descartada_en: new Date().toISOString() } })
        .eq('id', id)
        .in('estado', ['aprobada', 'editada'])
        .eq('respuesta->ejecucion->>ok', 'false')
        .select('id');
    if (error) return res.status(400).send({ error: error.message });
    if (!data?.length) return res.status(404).send({ error: 'No hay un envío fallido con ese id' });
    invalidarResumenHoy();
    return { ok: true };
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
    invalidarResumenHoy();

    return { accion: data, ejecucion: ejec };
});

app.post('/acciones/:id/rechazar', async (req, res) => {
    invalidarResumenHoy();
    const { id } = req.params as { id: string };
    const parseo = ResolucionSchema.safeParse(req.body ?? {});
    if (!parseo.success) return res.status(400).send({ error: parseo.error.flatten() });

    const previaRe = await respuestaPrevia(id);
    const { data, error } = await supabase
        .from('acciones_pendientes')
        .update({
            estado: 'rechazada',
            respuesta: { ...previaRe, por: 'humano', nota: parseo.data.nota ?? null },
            resuelto_en: new Date().toISOString(),
        })
        .eq('id', id)
        .eq('estado', 'pendiente')
        .select()
        .single();
    if (error) return res.status(404).send({ error: 'Acción no encontrada o ya resuelta' });
    if (data) void registrarCorreccion(data, 'rechazo', { motivo: parseo.data.nota });

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

app.get('/hoy', async (req) => {
    const q = req.query as { refrescar?: string };
    return resumenHoy(q.refrescar === '1');
});

// Mapa del negocio del Inicio y sugerencias del botón flotante de Bartez AI.
app.get('/mapa', async (req) => {
    const q = req.query as { refrescar?: string };
    return calcularMapa(q.refrescar === '1');
});

app.get('/sugerencias', async () => {
    try { return { sugerencias: (await calcularMapa()).sugerencias }; } catch { return { sugerencias: [] }; }
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
    try {
        await catalogo.cargar();
    } catch (err) {
        app.log.warn({ err }, 'no se pudo cargar catálogo — arrancando vacío');
    }

    // Refrescar contenido de www.bartez.com.ar en background — el asistente
    // Correo lo usa como referencia de qué vende Bartez.
    refrescarWebBartez()
        .then((r) => {
            if (r.ok) app.log.info({ largo: r.texto?.length }, '[bartez-web] contenido actualizado');
            else app.log.warn({ detalle: r.detalle }, '[bartez-web] fetch falló — se usa el caché anterior si hay');
        })
        .catch((err) => app.log.warn({ err }, '[bartez-web] fetch error'));

    // Bootstrap de Notion: crea los databases si no existen. Si NOTION_TOKEN o
    // NOTION_PARENT_PAGE_ID faltan, avisa y sigue sin romper. Primera vez que
    // termina OK, dispara el agent para que organice la página raíz por sí solo.
    if (notionConfigurado) {
        try {
            const r = await bootstrapNotion();
            if (r.ok) {
                app.log.info({ ids: r.ids }, '[notion] listo');
                // Auto-organizar la página la primera vez (marca guardada en integraciones_config).
                const { data: flag } = await supabase
                    .from('integraciones_config')
                    .select('valor')
                    .eq('clave', 'notion_agent_primer_organizado')
                    .maybeSingle();
                if (!flag) {
                    app.log.info('[notion] primer arranque — disparando agent para organizar la página raíz');
                    correrNotionAgent(
                        'Es tu primera vez organizando esta página. Está recién creada, solo tiene los 3 databases sin contexto. Diseñá la portada como creas mejor: header con nombre, callout de bienvenida/contexto, sección de módulos con links a los 3 databases, sección de estado actual (consultá los DBs para stats reales — hoy es normal que tareas y notas estén vacías, prospectos ya tiene algunos), y una sección de tips de uso.',
                        15,
                    )
                        .then(async (res) => {
                            app.log.info({ tools: res.tools_llamadas, costo: res.costo_usd }, '[notion] agent primer organizado terminó');
                            await supabase.from('integraciones_config').upsert({
                                clave: 'notion_agent_primer_organizado',
                                valor: new Date().toISOString(),
                                actualizado_en: new Date().toISOString(),
                            });
                        })
                        .catch((err) => app.log.warn({ err }, '[notion] agent primer organizado falló'));
                }
            } else {
                app.log.warn({ detalle: r.detalle }, '[notion] bootstrap falló');
            }
        } catch (err) {
            app.log.warn({ err }, '[notion] bootstrap error');
        }
    } else {
        app.log.info('[notion] deshabilitado (NOTION_TOKEN o NOTION_PARENT_PAGE_ID no configurados)');
    }

    const port = Number(process.env.PORT ?? 3000);
    await app.listen({ port, host: '0.0.0.0' });

    // Historia de correos al día (línea de tiempo de cada cliente): lo que entra
    // y lo que se manda desde cualquier programa de correo. Al arrancar se trae
    // la última semana; después, cada hora, los últimos 2 días. No duplica.
    let importando = false;
    const importarReciente = async (dias: number) => {
        if (importando) return;
        importando = true;
        try {
            const r = await importarHistorico(dias);
            if (r.total_nuevos) app.log.info({ nuevos: r.total_nuevos, vinculados: r.total_vinculados }, 'historia de correos actualizada');
            if (!r.ok) app.log.warn({ detalle: r.detalle }, 'importar correos recientes falló');
        } catch (err) {
            app.log.warn({ err }, 'importar correos recientes falló');
        } finally { importando = false; }
    };
    setTimeout(() => { void importarReciente(7); }, 60_000);
    cron.schedule('20 * * * *', () => { void importarReciente(2); }, { timezone: 'America/Argentina/Buenos_Aires' });

    // Documentos que se leyeron antes de sacar los datos de presupuesto: se leen
    // de nuevo (de a uno, en segundo plano) para que sumen a Cotizado.
    setTimeout(() => {
        retomarPendientes()
            .then((r) => { if (r.documentos || r.notas) app.log.info(r, 'retomado lo que quedó a medias por el reinicio'); })
            .catch((err) => app.log.warn({ err }, 'retomar pendientes falló'))
            .then(() => completarDatosDocumentos())
            .then((n) => { if (n) app.log.info({ documentos: n }, 'documentos releídos para Cotizado'); })
            .catch((err) => app.log.warn({ err }, 'releer documentos falló'));
    }, 15_000);

    // Listener IMAP en paralelo (no bloquea el arranque del HTTP server).
    // Si Ferozo no está configurado, imprime un warning y no hace nada.
    iniciarInboundCorreo().catch((err) => app.log.error({ err }, 'inbound-correo cayó'));

    // Cron diario a las 9 AM hora Argentina (UTC-3) → barrido de seguimientos.
    // Genera acciones pendientes para todos los leads sin respuesta hace >=7 días.
    cron.schedule('0 9 * * *', async () => {
        app.log.info('[cron] arrancando barrido de seguimientos');
        try {
            const r = await correrBarridoSeguimientos();
            app.log.info({ r }, '[cron] barrido de seguimientos terminado');
        } catch (err) {
            app.log.error({ err }, '[cron] barrido de seguimientos falló');
        }
    }, { timezone: 'America/Argentina/Buenos_Aires' });
    app.log.info('[cron] barrido de seguimientos programado 09:00 AR (todos los días)');

    // Cron semanal — lunes 8 AM AR — informe de Analítica.
    cron.schedule('0 8 * * 1', async () => {
        app.log.info('[cron] arrancando informe semanal de Analítica');
        try {
            const r = await correrAnalitica(7);
            app.log.info({ costo: r.costo_usd, propuestas: r.propuestas.length, email: r.email_enviado, notion: !!r.notion_page_id }, '[cron] informe Analítica listo');
        } catch (err) {
            app.log.error({ err }, '[cron] informe Analítica falló');
        }
    }, { timezone: 'America/Argentina/Buenos_Aires' });
    app.log.info('[cron] informe Analítica programado lunes 08:00 AR (semanal)');

    // Cron cada 4 horas — sincronizar listas de proveedores (Elit, Air, Invid).
    // Los que no tienen credenciales en el .env quedan como 'sin_configurar'.
    // Presupuestos enviados hace 5+ días sin respuesta: se propone un seguimiento.
    cron.schedule('20 10 * * 1-5', async () => {
        try {
            const r = await seguirPresupuestosEnviados();
            if (r.generados) app.log.info(r, 'seguimientos de presupuestos propuestos');
        } catch (err) {
            app.log.error({ err }, 'seguimiento de presupuestos falló');
        }
    }, { timezone: 'America/Argentina/Buenos_Aires' });

    // Todas las noches, las correcciones del día se convierten en lecciones.
    cron.schedule('40 20 * * *', async () => {
        try {
            const n = await destilarPendientes();
            if (n) app.log.info({ asistentes: n }, 'lecciones actualizadas');
        } catch (err) {
            app.log.error({ err }, 'destilar lecciones falló');
        }
    }, { timezone: 'America/Argentina/Buenos_Aires' });

    // De madrugada se actualiza la memoria de los clientes que tuvieron movimiento.
    cron.schedule('10 3 * * *', async () => {
        try {
            const r = await actualizarMemoriasPendientes();
            if (r.candidatos) app.log.info(r, 'memoria de clientes actualizada');
        } catch (err) {
            app.log.error({ err }, 'actualizar memoria de clientes falló');
        }
    }, { timezone: 'America/Argentina/Buenos_Aires' });

    cron.schedule('15 */4 * * *', async () => {
        try {
            const r = await sincronizarTodos();
            app.log.info({ r: r.map((x) => ({ p: x.proveedor, ok: x.ok, items: x.items })) }, '[cron] sync proveedores');
        } catch (err) {
            app.log.error({ err }, '[cron] sync proveedores falló');
        }
    }, { timezone: 'America/Argentina/Buenos_Aires' });
    app.log.info('[cron] sync de proveedores programado cada 4 h');

    // Notion autónomo: tablero con datos exactos cada 30 min (7 a 21 h) y el
    // curador (IA con decisión propia) 3 veces por día hábil.
    if (notionConfigurado) {
        cron.schedule('*/30 7-21 * * *', async () => {
            const r = await actualizarTablero();
            if (!r.ok && r.detalle !== 'Ya se está actualizando') app.log.warn({ r }, '[cron] tablero Notion falló');
        }, { timezone: 'America/Argentina/Buenos_Aires' });
        const curar = async () => {
            const r = await correrCurador();
            app.log.info({ ok: r.ok, cambios: r.cambios, costo: r.costo_usd, detalle: r.detalle }, '[cron] curador Notion');
        };
        cron.schedule('30 8 * * 1-6', curar, { timezone: 'America/Argentina/Buenos_Aires' });
        cron.schedule('0 13,18 * * 1-5', curar, { timezone: 'America/Argentina/Buenos_Aires' });
        app.log.info('[cron] Notion: tablero cada 30 min (7-21 h), curador 8:30 / 13 / 18 h');
    }

    // Cada 2 minutos — traer conversaciones de WhatsApp del bot de la web y
    // proponer respuestas en las escaladas. Sin STUDIO_API_TOKEN no hace nada.
    if (studioConfigurado()) {
        cron.schedule('*/2 * * * *', async () => {
            const r = await sincronizarWhatsapp();
            if (!r.ok && r.detalle !== 'Ya hay una sincronización en curso') app.log.warn({ r }, '[cron] sync WhatsApp falló');
            else if (r.actualizadas > 0) app.log.info({ r }, '[cron] sync WhatsApp');
        });
        app.log.info('[cron] sync de WhatsApp programado cada 2 min');
    } else {
        app.log.info('[whatsapp] deshabilitado (falta STUDIO_API_TOKEN)');
    }
}

main().catch((err) => {
    app.log.error(err);
    process.exit(1);
});
