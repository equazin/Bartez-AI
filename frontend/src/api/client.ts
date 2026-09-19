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
