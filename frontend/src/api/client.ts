// Cliente HTTP mínimo al backend de Bartez AI.
// La URL del backend se toma de VITE_BACKEND_URL en build; por defecto localhost.

// Backend temporal para demos: ?backend=https://xxxx.trycloudflare.com en el link
// lo guarda en este navegador; ?backend=local vuelve al default. Solo se aceptan
// túneles de Cloudflare o localhost, para que un link ajeno no pueda mandar la
// contraseña del panel a otro servidor.
const CLAVE_BACKEND = 'bartez_backend';
const DEFAULT_BACKEND = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3000';

function backendPermitido(u: string): boolean {
    try {
        const url = new URL(u);
        return (url.protocol === 'https:' && url.hostname.endsWith('.trycloudflare.com'))
            || (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname));
    } catch {
        return false;
    }
}

function resolverBackend(): string {
    try {
        const params = new URLSearchParams(window.location.search);
        const pedido = params.get('backend');
        if (pedido === 'local') localStorage.removeItem(CLAVE_BACKEND);
        else if (pedido && backendPermitido(pedido)) localStorage.setItem(CLAVE_BACKEND, pedido.replace(/\/+$/, ''));
        if (pedido) {
            params.delete('backend');
            const qs = params.toString();
            window.history.replaceState(null, '', window.location.pathname + (qs ? `?${qs}` : '') + window.location.hash);
        }
        const guardado = localStorage.getItem(CLAVE_BACKEND);
        if (guardado && backendPermitido(guardado)) return guardado;
    } catch { /* sin storage: default */ }
    return DEFAULT_BACKEND;
}

const BASE = resolverBackend();
export const BACKEND_URL = BASE;
export const BACKEND_ES_DEMO = BASE !== DEFAULT_BACKEND;

// ---------- Login ----------
// El token se guarda en el navegador; cada pedido lo manda en Authorization.
// Si el backend responde 401, se borra y la app vuelve a pedir la contraseña.

const CLAVE_TOKEN = 'bartez_token';
export const EVENTO_LOGOUT = 'bartez:logout';

function leerToken(): string | null {
    try { return localStorage.getItem(CLAVE_TOKEN); } catch { return null; }
}

function guardarToken(t: string | null): void {
    try {
        if (t) localStorage.setItem(CLAVE_TOKEN, t);
        else localStorage.removeItem(CLAVE_TOKEN);
    } catch { /* sin storage: la sesión dura lo que la pestaña */ }
}

async function apiFetch(url: string, init: RequestInit = {}): Promise<Response> {
    const token = leerToken();
    const headers = new Headers(init.headers);
    if (token) headers.set('Authorization', `Bearer ${token}`);
    const res = await fetch(url, { ...init, headers });
    if (res.status === 401 && !url.endsWith('/auth/login')) {
        guardarToken(null);
        window.dispatchEvent(new Event(EVENTO_LOGOUT));
    }
    return res;
}

export async function estadoAuth(): Promise<{ requerida: boolean; valido: boolean }> {
    const res = await apiFetch(`${BASE}/auth/estado`);
    if (!res.ok) throw new Error(`Backend respondió ${res.status}`);
    return res.json();
}

export async function login(password: string): Promise<void> {
    const res = await apiFetch(`${BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? `Backend respondió ${res.status}`);
    guardarToken(data.token || null);
}

export function logout(): void {
    guardarToken(null);
    window.dispatchEvent(new Event(EVENTO_LOGOUT));
}

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
    const res = await apiFetch(`${BASE}/tareas`, {
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
    const res = await apiFetch(`${BASE}/metricas/serie?dias=${dias}`);
    if (!res.ok) throw new Error(`Backend respondió ${res.status}`);
    return res.json();
}

export async function listarLogs(params: { asistente_id?: string; limit?: number } = {}): Promise<{ logs: LogEntry[] }> {
    const qs = new URLSearchParams();
    if (params.asistente_id) qs.set('asistente_id', params.asistente_id);
    if (params.limit) qs.set('limit', String(params.limit));
    const res = await apiFetch(`${BASE}/logs?${qs.toString()}`);
    if (!res.ok) throw new Error(`Backend respondió ${res.status}`);
    return res.json();
}

export async function cargarMensajes(conversacionId: string): Promise<MensajePersistido[]> {
    const res = await apiFetch(`${BASE}/conversaciones/${conversacionId}/mensajes`);
    if (!res.ok) return [];
    const data = await res.json();
    return data.mensajes ?? [];
}

export async function metricasHoy(): Promise<{ sistema: unknown[]; negocio: unknown }> {
    const res = await apiFetch(`${BASE}/metricas/hoy`);
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
    const res = await apiFetch(`${BASE}/prospectos?estado=${estado}`);
    if (!res.ok) throw new Error(`Backend respondió ${res.status}`);
    return res.json();
}

export async function actualizarCliente(id: string, cambios: Partial<Pick<Prospecto, 'estado' | 'nombre' | 'email' | 'whatsapp'>>): Promise<Prospecto> {
    const res = await apiFetch(`${BASE}/clientes/${id}`, {
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
    const res = await apiFetch(`${BASE}/clientes/${id}/contactar`, {
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
    const res = await apiFetch(`${BASE}/notion/catalogo/registrar`, {
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
    const res = await apiFetch(`${BASE}/notion/catalogo`);
    if (!res.ok) throw new Error(`Backend respondió ${res.status}`);
    return res.json();
}

export async function organizarNotion(): Promise<{ resultado: ResultadoNotionAgent }> {
    const res = await apiFetch(`${BASE}/notion/organizar`, { method: 'POST' });
    if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || `Backend respondió ${res.status}`);
    }
    return res.json();
}

export async function pedirANotion(texto: string): Promise<{ resultado: ResultadoNotionAgent }> {
    const res = await apiFetch(`${BASE}/notion/pedir`, {
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
    const res = await apiFetch(`${BASE}/analitica/informes`);
    if (!res.ok) throw new Error(`Backend respondió ${res.status}`);
    return res.json();
}

export async function obtenerInformeAnalitica(id: string): Promise<{ informe: InformeAnalitica }> {
    const res = await apiFetch(`${BASE}/analitica/informes/${id}`);
    if (!res.ok) throw new Error(`Backend respondió ${res.status}`);
    return res.json();
}

export async function correrAnaliticaAhora(dias = 7): Promise<{ resultado: InformeAnalitica }> {
    const res = await apiFetch(`${BASE}/analitica/correr?dias=${dias}`, { method: 'POST' });
    if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || `Backend respondió ${res.status}`);
    }
    return res.json();
}

// ---------- Proveedores y Cotizador ----------

export interface Proveedor {
    codigo: 'elit' | 'air' | 'invid';
    nombre: string;
    activo: boolean;
    margen_pct: number;
    ultima_sync: string | null;
    ultimo_estado: 'ok' | 'error' | 'sin_configurar' | null;
    ultimo_detalle: string | null;
    items_sincronizados: number | null;
}

export interface ArticuloPrecio {
    catalogo_id: number;
    proveedor: string;
    sku: string;
    descripcion: string;
    marca: string | null;
    stock: number | null;
    moneda_origen: string;
    costo_usd: number;
    margen_pct: number;
    precio_unit_usd: number;
    iva_pct: number;
    precio_unit_final_usd: number;
}

export interface LineaCotizada {
    pedido: string;
    cantidad: number;
    nota: string;
    elegido: ArticuloPrecio | null;
    alternativas: ArticuloPrecio[];
}

export interface Cotizacion {
    ok: boolean;
    id?: string;
    pedido: string;
    lineas: LineaCotizada[];
    comentario: string;
    tipo_cambio: number;
    fuente_tc: string;
    subtotal_usd: number;
    iva_usd: number;
    total_usd: number;
    total_ars: number;
    busquedas: number;
    costo_ia_usd: number;
    duracion_ms: number;
    titulo?: string | null;
    creado_en?: string;
}

async function jsonOError<T>(res: Response): Promise<T> {
    if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(typeof err.error === 'string' ? err.error : `Backend respondió ${res.status}`);
    }
    return res.json();
}

export async function listarProveedores(): Promise<{ proveedores: Proveedor[]; tipo_cambio: { valor: number; fuente: string } | null }> {
    return jsonOError(await apiFetch(`${BASE}/proveedores`));
}

export async function actualizarProveedor(codigo: string, cambios: { activo?: boolean; margen_pct?: number }): Promise<{ proveedor: Proveedor }> {
    return jsonOError(await apiFetch(`${BASE}/proveedores/${codigo}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cambios),
    }));
}

export interface ResultadoSync { proveedor: string; ok: boolean; items: number; detalle?: string; duracion_ms: number }

export async function sincronizarProveedor(codigo: string): Promise<{ resultado: ResultadoSync }> {
    return jsonOError(await apiFetch(`${BASE}/proveedores/${codigo}/sincronizar`, { method: 'POST' }));
}

export async function importarCsvProveedor(codigo: string, csv: string, moneda: 'USD' | 'ARS'): Promise<{ resultado: ResultadoSync }> {
    return jsonOError(await apiFetch(`${BASE}/proveedores/${codigo}/importar-csv`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ csv, moneda }),
    }));
}

export interface CotizacionResumen {
    id: string;
    titulo: string | null;
    pedido: string;
    total_usd: number;
    total_ars: number;
    renglones: number;
    creado_en: string;
}

export async function listarCotizaciones(): Promise<{ cotizaciones: CotizacionResumen[] }> {
    return jsonOError(await apiFetch(`${BASE}/cotizaciones`));
}

export async function obtenerCotizacion(id: string): Promise<{ cotizacion: Cotizacion }> {
    return jsonOError(await apiFetch(`${BASE}/cotizaciones/${id}`));
}

export async function renombrarCotizacion(id: string, titulo: string | null): Promise<{ ok: boolean }> {
    return jsonOError(await apiFetch(`${BASE}/cotizaciones/${id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ titulo }),
    }));
}

export async function borrarCotizacion(id: string): Promise<{ ok: boolean }> {
    return jsonOError(await apiFetch(`${BASE}/cotizaciones/${id}`, { method: 'DELETE' }));
}

export async function crearCotizacion(pedido: string): Promise<{ cotizacion: Cotizacion }> {
    return jsonOError(await apiFetch(`${BASE}/cotizaciones`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pedido }),
    }));
}

// ---------- Seguimientos ----------

export interface EmpresaSeguimiento {
    id: string;
    nombre: string;
    email: string | null;
    estado: 'lead' | 'cliente' | 'inactivo' | 'descartado' | 'detectado';
    origen: string;
    creado_en: string;
    actualizado_en: string;
    intentos_contacto: number | null;
    ultimo_contacto_en: string | null;
    metadata: {
        sitio_web?: string;
        senial?: string;
        razon_prospeccion?: string;
        puntaje_icp?: number;
        dominio?: string;
        emails_detectados?: string[];
    } | null;
    tipo: 'cliente' | 'detectado';
    correos_totales: number;
    correos_entrantes: number;
    correos_salientes: number;
    ultimo_correo_en: string | null;
    dominio?: string;
}

export interface CorreoHistorico {
    direccion: 'entrante' | 'saliente';
    de_email: string | null;
    para_email: string | null;
    asunto: string | null;
    cuerpo: string;
    fecha: string;
    categoria: string | null;
}

export interface DetalleEmpresa {
    cliente: Prospecto & {
        intentos_contacto: number | null;
        ultimo_contacto_en: string | null;
    };
    correos: CorreoHistorico[];
    acciones: Array<{
        id: string;
        accion: string;
        payload: Record<string, unknown>;
        estado: string;
        respuesta: Record<string, unknown> | null;
        creado_en: string;
    }>;
}

export interface InformeCliente {
    ok: boolean;
    resumen_md: string;
    tokens_in: number;
    tokens_out: number;
    costo_usd: number;
    duracion_ms: number;
}

export async function listarEmpresasSeguimiento(): Promise<{ empresas: EmpresaSeguimiento[] }> {
    const res = await apiFetch(`${BASE}/seguimientos/empresas`);
    if (!res.ok) throw new Error(`Backend respondió ${res.status}`);
    return res.json();
}

export async function detalleEmpresaSeguimiento(id: string): Promise<DetalleEmpresa> {
    const res = await apiFetch(`${BASE}/seguimientos/empresas/${id}`);
    if (!res.ok) throw new Error(`Backend respondió ${res.status}`);
    return res.json();
}

export async function descartarContactoDetectado(dominio: string): Promise<{ ok: boolean; borrados: number }> {
    const res = await apiFetch(`${BASE}/seguimientos/detectado/${encodeURIComponent(dominio)}`, { method: 'DELETE' });
    if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || `Backend respondió ${res.status}`);
    }
    return res.json();
}

export async function promoverContactoDetectado(dominio: string, nombre: string, email: string | null): Promise<{ ok: boolean; cliente: { id: string; nombre: string }; vinculados: number }> {
    const res = await apiFetch(`${BASE}/seguimientos/promover`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dominio, nombre, email }),
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || `Backend respondió ${res.status}`);
    }
    return res.json();
}

export async function redactarSeguimiento(
    id: string,
    opts: { informe_previo?: string; contexto_extra?: string } = {},
): Promise<{ ok: boolean; accion_id?: string; respuesta?: string }> {
    const body: Record<string, string> = {};
    if (opts.informe_previo) body.informe_previo = opts.informe_previo;
    if (opts.contexto_extra) body.contexto_extra = opts.contexto_extra;
    const res = await apiFetch(`${BASE}/seguimientos/empresas/${id}/redactar`, {
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

export async function generarInformeCliente(id: string, contexto_extra?: string): Promise<{ informe: InformeCliente }> {
    const res = await apiFetch(`${BASE}/seguimientos/empresas/${id}/informe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(contexto_extra ? { contexto_extra } : {}),
    });
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
    const res = await apiFetch(`${BASE}/correos/importar?dias=${dias}`, { method: 'POST' });
    if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || `Backend respondió ${res.status}`);
    }
    return res.json();
}

export async function estadoImportCorreos(jobId: string): Promise<JobImportCorreos> {
    const res = await apiFetch(`${BASE}/correos/importar/${jobId}`);
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
    const res = await apiFetch(`${BASE}/seguimientos/correr`, { method: 'POST' });
    if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || `Backend respondió ${res.status}`);
    }
    return res.json();
}

export async function buscarProspectos(foco?: string, modo: 'focal' | 'sweep' = 'focal'): Promise<ResultadoProspeccion> {
    const body: Record<string, string> = { modo };
    if (foco) body.foco = foco;
    const res = await apiFetch(`${BASE}/prospeccion/buscar`, {
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
    const res = await apiFetch(`${BASE}/metricas/negocio/hoy`, {
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
    const res = await apiFetch(`${BASE}/acciones?estado=${estado}`);
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
    const res = await apiFetch(`${BASE}/asistentes`);
    if (!res.ok) throw new Error(`Backend respondió ${res.status}`);
    return res.json();
}

export async function actualizarAsistente(
    id: string,
    cambios: Partial<Pick<AsistenteEditable, 'prompt' | 'modelo' | 'autonomia' | 'activo'>>,
): Promise<AsistenteEditable> {
    const res = await apiFetch(`${BASE}/asistentes/${id}`, {
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
    const res = await apiFetch(`${BASE}/acciones/${id}/${resolucion}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || `Backend respondió ${res.status}`);
    }
}
