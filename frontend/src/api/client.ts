// Cliente HTTP mínimo al backend de Bartez AI.
// La URL del backend se toma de VITE_BACKEND_URL en build; por defecto localhost.

const BASE = import.meta.env.VITE_BACKEND_URL ?? 'http://localhost:3000';

export interface TareaEntrada {
    canal: 'correo' | 'whatsapp' | 'panel';
    texto: string;
    conversacionId?: string;
    metadata?: Record<string, unknown>;
}

export interface RespuestaTarea {
    respuesta: string;
    conversacionId: string;
    requiereAprobacion: boolean;
}

export async function enviarTarea(t: TareaEntrada): Promise<{ resultado: RespuestaTarea }> {
    const res = await fetch(`${BASE}/tareas`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(t),
    });
    if (!res.ok) throw new Error(`Backend respondió ${res.status}`);
    return res.json();
}

export interface MensajePersistido {
    id: string;
    remitente: string;
    texto: string;
    creado_en: string;
}

export interface LogEntry {
    id: string;
    asistente_id: string;
    asistente_nombre: string | null;
    conversacion_id: string | null;
    entrada: Record<string, unknown> | null;
    salida: Record<string, unknown> | null;
    herramienta: string | null;
    tokens_in: number | null;
    tokens_out: number | null;
    costo_usd: number | null;
    duracion_ms: number | null;
    error: string | null;
    creado_en: string;
}

export interface PuntoSerie {
    fecha: string;
    tokens: number;
    costo_usd: number;
}

export async function serieMetricas(dias = 7): Promise<{ serie: PuntoSerie[] }> {
    const res = await fetch(`${BASE}/metricas/serie?dias=${dias}`);
    if (!res.ok) throw new Error(`Backend respondió ${res.status}`);
    return res.json();
}

export async function listarLogs(params: { asistente_id?: string; limit?: number } = {}): Promise<{ logs: LogEntry[] }> {
    const qs = new URLSearchParams();
    if (params.asistente_id) qs.set('asistente_id', params.asistente_id);
    if (params.limit) qs.set('limit', String(params.limit));
    const res = await fetch(`${BASE}/logs?${qs.toString()}`);
    if (!res.ok) throw new Error(`Backend respondió ${res.status}`);
    return res.json();
}

export async function cargarMensajes(conversacionId: string): Promise<MensajePersistido[]> {
    const res = await fetch(`${BASE}/conversaciones/${conversacionId}/mensajes`);
    if (!res.ok) return [];
    const data = await res.json();
    return data.mensajes ?? [];
}

export async function metricasHoy(): Promise<{ sistema: unknown[]; negocio: unknown }> {
    const res = await fetch(`${BASE}/metricas/hoy`);
    if (!res.ok) throw new Error(`Backend respondió ${res.status}`);
    return res.json();
}

export interface MetricaNegocioInput {
    propuestas_enviadas?: number;
    ventas_cerradas?: number;
    prospectos_calificados?: number;
    notas?: string;
}

export interface ResultadoProspeccion {
    resultado: {
        respuesta: string;
        requiereAprobacion: boolean;
        accionPropuesta?: { tipo: string; payload: Record<string, unknown> };
        tokensIn: number;
        tokensOut: number;
        costoUsd: number;
        duracionMs: number;
    };
    guardado?: {
        creados?: number;
        existentes?: number;
        saltados?: number;
        sin_email?: number;
        total?: number;
    };
}

export interface Prospecto {
    id: string;
    nombre: string;
    email: string | null;
    whatsapp: string | null;
    estado: 'lead' | 'cliente' | 'inactivo' | 'descartado';
    metadata: {
        sitio_web?: string;
        senial?: string;
        razon_prospeccion?: string;
        puntaje_icp?: number;
    } | null;
    creado_en: string;
    actualizado_en: string;
}

export async function listarProspectos(estado = 'todos'): Promise<{ prospectos: Prospecto[] }> {
    const res = await fetch(`${BASE}/prospectos?estado=${estado}`);
    if (!res.ok) throw new Error(`Backend respondió ${res.status}`);
    return res.json();
}

export async function actualizarCliente(id: string, cambios: Partial<Pick<Prospecto, 'estado' | 'nombre' | 'email' | 'whatsapp'>>): Promise<Prospecto> {
    const res = await fetch(`${BASE}/clientes/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cambios),
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || `Backend respondió ${res.status}`);
    }
    const d = await res.json();
    return d.cliente;
}

export async function contactarProspecto(id: string, area: 'correo' | 'whatsapp' = 'correo', contexto?: string): Promise<{ mensaje: string }> {
    const res = await fetch(`${BASE}/clientes/${id}/contactar`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ area, contexto }),
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || `Backend respondió ${res.status}`);
    }
    return res.json();
}

export interface ResultadoBarrido {
    revisados: number;
    generados: number;
    errores: string[];
    duracion_ms: number;
}

export interface ResultadoNotionAgent {
    ok: boolean;
    respuesta: string;
    tools_llamadas: number;
    tokens_in: number;
    tokens_out: number;
    costo_usd: number;
    duracion_ms: number;
    detalle?: string;
}

export async function registrarCatalogoNotion(databaseId: string): Promise<{ ok: boolean; catalogo_id: string }> {
    const res = await fetch(`${BASE}/notion/catalogo/registrar`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ database_id: databaseId }),
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || `Backend respondió ${res.status}`);
    }
    return res.json();
}

export async function estadoCatalogoNotion(): Promise<{ registrado: boolean; id: string | null }> {
    const res = await fetch(`${BASE}/notion/catalogo`);
    if (!res.ok) throw new Error(`Backend respondió ${res.status}`);
    return res.json();
}

export async function organizarNotion(): Promise<{ resultado: ResultadoNotionAgent }> {
    const res = await fetch(`${BASE}/notion/organizar`, { method: 'POST' });
    if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || `Backend respondió ${res.status}`);
    }
    return res.json();
}

export async function pedirANotion(texto: string): Promise<{ resultado: ResultadoNotionAgent }> {
    const res = await fetch(`${BASE}/notion/pedir`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ texto }),
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || `Backend respondió ${res.status}`);
    }
    return res.json();
}

export interface PropuestaAnalitica {
    tipo: 'ajuste_prompt' | 'cambio_modelo' | 'ajuste_autonomia' | 'proceso' | 'otro';
    asistente?: string;
    titulo: string;
    razon: string;
    accion_sugerida: string;
}

export interface InformeAnalitica {
    id: string;
    periodo_desde: string;
    periodo_hasta: string;
    resumen_md: string;
    propuestas: PropuestaAnalitica[];
    stats: Record<string, unknown>;
    tokens_in?: number;
    tokens_out?: number;
    costo_usd: number;
    notion_page_id: string | null;
    email_enviado: boolean;
    creado_en: string;
}

export async function listarInformesAnalitica(): Promise<{ informes: InformeAnalitica[] }> {
    const res = await fetch(`${BASE}/analitica/informes`);
    if (!res.ok) throw new Error(`Backend respondió ${res.status}`);
    return res.json();
}

export async function obtenerInformeAnalitica(id: string): Promise<{ informe: InformeAnalitica }> {
    const res = await fetch(`${BASE}/analitica/informes/${id}`);
    if (!res.ok) throw new Error(`Backend respondió ${res.status}`);
    return res.json();
}

export async function correrAnaliticaAhora(dias = 7): Promise<{ resultado: InformeAnalitica }> {
    const res = await fetch(`${BASE}/analitica/correr?dias=${dias}`, { method: 'POST' });
    if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || `Backend respondió ${res.status}`);
    }
    return res.json();
}

export interface ResultadoImportCorreos {
    ok: boolean;
    carpetas_procesadas: Array<{ carpeta: string; leidos: number; nuevos: number; vinculados: number; ruido_saltado: number; ignorables_marcados: number; errores: number }>;
    total_nuevos: number;
    total_vinculados: number;
    total_ruido_saltado: number;
    total_ignorables_marcados: number;
    costo_clasificador_usd: number;
    ejemplos_descartes: Array<{ de: string; asunto: string; motivo: string }>;
    detalle?: string;
    duracion_ms: number;
}

export interface JobImportCorreos {
    id: string;
    estado: 'en_curso' | 'completado' | 'error';
    dias: number;
    resultado: ResultadoImportCorreos | null;
    error: string | null;
    creado_en: string;
    terminado_en: string | null;
}

// Arranca el job. Devuelve el jobId; el import corre en background.
export async function arrancarImportCorreos(dias = 90): Promise<{ ok: boolean; jobId: string; mensaje?: string; detalle?: string }> {
    const res = await fetch(`${BASE}/correos/importar?dias=${dias}`, { method: 'POST' });
    if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || `Backend respondió ${res.status}`);
    }
    return res.json();
}

export async function estadoImportCorreos(jobId: string): Promise<JobImportCorreos> {
    const res = await fetch(`${BASE}/correos/importar/${jobId}`);
    if (!res.ok) throw new Error(`Backend respondió ${res.status}`);
    return res.json();
}

// Wrapper que arranca + polea + resuelve cuando termina.
export async function importarCorreosHistoricos(
    dias = 90,
    onTick?: (estado: string, elapsedMs: number) => void,
): Promise<ResultadoImportCorreos> {
    const inicio = Date.now();
    const { jobId } = await arrancarImportCorreos(dias);
    // eslint-disable-next-line no-constant-condition
    while (true) {
        await new Promise((r) => setTimeout(r, 3000));
        const job = await estadoImportCorreos(jobId);
        onTick?.(job.estado, Date.now() - inicio);
        if (job.estado === 'completado') {
            if (!job.resultado) throw new Error('Job terminó sin resultado');
            return job.resultado;
        }
        if (job.estado === 'error') {
            throw new Error(job.error ?? 'Import falló sin detalle');
        }
    }
}

export async function correrSeguimientos(): Promise<{ resultado: ResultadoBarrido }> {
    const res = await fetch(`${BASE}/seguimientos/correr`, { method: 'POST' });
    if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || `Backend respondió ${res.status}`);
    }
    return res.json();
}

export async function buscarProspectos(foco?: string, modo: 'focal' | 'sweep' = 'focal'): Promise<ResultadoProspeccion> {
    const body: Record<string, string> = { modo };
    if (foco) body.foco = foco;
    const res = await fetch(`${BASE}/prospeccion/buscar`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || `Backend respondió ${res.status}`);
    }
    return res.json();
}

export async function guardarMetricasNegocio(m: MetricaNegocioInput): Promise<void> {
    const res = await fetch(`${BASE}/metricas/negocio/hoy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(m),
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || `Backend respondió ${res.status}`);
    }
}

export interface AccionPendiente {
    id: string;
    asistente_id: string;
    asistente_nombre: string | null;
    conversacion_id: string | null;
    accion: string;
    payload: Record<string, unknown>;
    estado: string;
    creado_en: string;
}

export async function listarAcciones(estado = 'pendiente'): Promise<{ acciones: AccionPendiente[] }> {
    const res = await fetch(`${BASE}/acciones?estado=${estado}`);
    if (!res.ok) throw new Error(`Backend respondió ${res.status}`);
    return res.json();
}

export interface AsistenteEditable {
    id: string;
    nombre: string;
    area: string;
    modelo: 'sonnet' | 'haiku' | 'opus';
    prompt: string;
    autonomia: number;
    activo: boolean;
    actualizado_en: string;
}

export async function listarAsistentes(): Promise<{ asistentes: AsistenteEditable[] }> {
    const res = await fetch(`${BASE}/asistentes`);
    if (!res.ok) throw new Error(`Backend respondió ${res.status}`);
    return res.json();
}

export async function actualizarAsistente(
    id: string,
    cambios: Partial<Pick<AsistenteEditable, 'prompt' | 'modelo' | 'autonomia' | 'activo'>>,
): Promise<AsistenteEditable> {
    const res = await fetch(`${BASE}/asistentes/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cambios),
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || `Backend respondió ${res.status}`);
    }
    const data = await res.json();
    return data.asistente;
}

export async function resolverAccion(
    id: string,
    resolucion: 'aprobar' | 'editar' | 'rechazar',
    body: { payload?: Record<string, unknown>; nota?: string } = {},
): Promise<void> {
    const res = await fetch(`${BASE}/acciones/${id}/${resolucion}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || `Backend respondió ${res.status}`);
    }
}
