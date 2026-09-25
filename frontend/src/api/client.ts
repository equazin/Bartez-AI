// Cliente HTTP mínimo al backend de Bartez AI.
// La URL del backend se toma de VITE_BACKEND_URL en build; por defecto localhost.

// Backend de esta PC para desarrollo: ?backend=http://localhost:3000 en el link lo
// guarda en este navegador; ?backend=local vuelve al default. Solo se acepta
// localhost: un link ajeno no puede mandar el token ni la contraseña del panel a
// otro servidor (antes se aceptaba cualquier túnel *.trycloudflare.com, y
// cualquiera puede crear uno).
const CLAVE_BACKEND = 'bartez_backend';
const DEFAULT_BACKEND = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3000';

function backendPermitido(u: string): boolean {
    try {
        const url = new URL(u);
        return url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname);
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
// El backend "normal" es el servidor en internet (Railway) o, sin él, el de esta PC.
export const BACKEND_NORMAL_ES_LOCAL = /^http:\/\/(localhost|127\.0\.0\.1)/.test(DEFAULT_BACKEND);

// Olvida el backend guardado y vuelve al normal (el de esta PC o el publicado).
export function volverAlBackendNormal(): void {
    try { localStorage.removeItem(CLAVE_BACKEND); } catch { /* sin storage */ }
    window.location.reload();
}

// Links a sitios de afuera (web de un cliente o prospecto, Notion): solo http(s).
// Un "javascript:" que venga de la IA o de un dato cargado no se vuelve un link.
export function urlSegura(u: string | null | undefined): string | undefined {
    const t = (u ?? '').trim();
    if (!t) return undefined;
    // "javascript:", "data:"… no; "empresa.com.ar:8080" es un sitio con puerto.
    if (!/^https?:\/\//i.test(t) && /^[a-z][a-z0-9+.-]*:(?!\d)/i.test(t)) return undefined;
    try {
        const url = new URL(/^https?:\/\//i.test(t) ? t : `https://${t}`);
        return url.hostname.includes('.') ? url.href : undefined;
    } catch {
        return undefined;
    }
}

// ---------- Login ----------
// El token se guarda en el navegador; cada pedido lo manda en Authorization.
// Si el backend responde 401, se borra y la app vuelve a pedir la contraseña.

// El token queda atado al backend que lo emitió: nunca se manda a otro.
const CLAVE_TOKEN = BACKEND_ES_DEMO ? `bartez_token:${BASE}` : 'bartez_token';
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
        // Cargados a mano (alta o edición del cliente)
        contacto?: string;
        cuit?: string;
    } | null;
    creado_en: string;
    actualizado_en: string;
}

// ---------- Alta y edición manual de clientes ----------

export interface DatosClienteForm {
    nombre: string;
    email: string | null;
    whatsapp: string | null;
    estado: 'lead' | 'cliente' | 'inactivo' | 'descartado';
    contacto: string | null;
    sitio_web: string | null;
    cuit: string | null;
}
export interface ClienteParecido { id: string; nombre: string; email: string | null; whatsapp: string | null; estado: string; motivo: string }
export type ResultadoGuardarCliente =
    | { ok: true; cliente: { id: string; nombre: string; estado: string }; vinculados: { correos: number; whatsapp: number } }
    | { ok: false; error: string; parecidos: ClienteParecido[] };

async function guardarClienteFetch(url: string, method: 'POST' | 'PUT', body: unknown): Promise<ResultadoGuardarCliente> {
    const res = await apiFetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({})) as { error?: string; parecidos?: ClienteParecido[]; cliente?: { id: string; nombre: string; estado: string }; vinculados?: { correos: number; whatsapp: number } };
    // 409 = hay un cliente parecido: se muestran para decidir.
    if (!res.ok) return { ok: false, error: data.error || `Backend respondió ${res.status}`, parecidos: data.parecidos ?? [] };
    return { ok: true, cliente: data.cliente!, vinculados: data.vinculados ?? { correos: 0, whatsapp: 0 } };
}

export function crearClienteManual(datos: DatosClienteForm & { nota?: string | null }, crear_igual = false): Promise<ResultadoGuardarCliente> {
    return guardarClienteFetch(`${BASE}/clientes`, 'POST', { ...datos, crear_igual });
}

export function editarDatosCliente(id: string, datos: DatosClienteForm): Promise<ResultadoGuardarCliente> {
    return guardarClienteFetch(`${BASE}/clientes/${id}/datos`, 'PUT', datos);
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

export interface ResultadoCuradorNotion {
    ok: boolean;
    resumen: string;
    prioridades: Array<{ texto: string; por_que?: string }>;
    cambios: number;
    costo_usd: number;
    duracion_ms: number;
    tablero_url?: string;
    detalle?: string;
}

export async function organizarNotion(instruccion?: string): Promise<{ resultado: ResultadoCuradorNotion }> {
    return jsonOError(await apiFetch(`${BASE}/notion/organizar`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ instruccion }),
    }));
}

export async function actualizarTableroNotion(): Promise<{ resultado: { ok: boolean; url?: string; bloques?: number; detalle?: string } }> {
    return jsonOError(await apiFetch(`${BASE}/notion/tablero`, { method: 'POST' }));
}

export interface EstadoNotionAutonomo {
    configurado: boolean;
    tablero_url: string | null;
    tablero_actualizado: string | null;
    curador: { fecha: string; resumen: string; cambios: number } | null;
    prioridades: { fecha: string; items: Array<{ texto: string; por_que?: string }> } | null;
    cambios: Array<{ creado_en: string; origen: string; tipo: string; detalle: string; url: string | null }>;
}

export async function estadoNotionAutonomo(): Promise<EstadoNotionAutonomo> {
    return jsonOError(await apiFetch(`${BASE}/notion/autonomo`));
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
    numero?: number | null;
    datos_cliente?: DatosCliente;
    creado_en?: string;
    cliente_id?: string | null;
    estado?: EstadoVenta;
    enviada_en?: string | null;
    cerrada_en?: string | null;
    // 'documento': presupuesto hecho fuera del Cotizador, subido a la ficha del cliente
    origen?: 'cotizador' | 'documento';
    numero_externo?: string | null;
    documento?: { id: string; nombre: string; tipo_mime?: string | null } | null;
    motivo_cierre?: string | null;
}

export interface DatosCliente {
    cuit?: string;
    direccion?: string;
    localidad?: string;
    atencion?: string;
    email?: string;
    objeto?: string;
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
    numero: number | null;
    estado: EstadoVenta;
    enviada_en: string | null;
    cerrada_en: string | null;
    motivo_cierre: string | null;
    cliente_id: string | null;
    origen?: 'cotizador' | 'documento';
    numero_externo?: string | null;
    // Tipo del archivo si vino de la ficha (PDF, foto…)
    documento_mime?: string | null;
}

// Cómo se nombra el archivo de un presupuesto que vino de la ficha. Sin tipo
// (backend viejo), se deduce del nombre del archivo.
export function tipoArchivo(mime: string | null | undefined, nombre?: string | null): { etiqueta: string; de: string; abrir: string } {
    const ext = (nombre ?? '').toLowerCase().split('.').pop() ?? '';
    const deExt: Record<string, string> = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', xlsx: 'excel', csv: 'csv', docx: 'word' };
    const m = mime || deExt[ext] || '';
    if (m.startsWith('image/')) return { etiqueta: 'FOTO', de: 'una foto', abrir: 'Ver foto' };
    if (m === 'application/pdf') return { etiqueta: 'PDF', de: 'un PDF', abrir: 'Abrir PDF' };
    if (/sheet|excel|csv/.test(m)) return { etiqueta: 'EXCEL', de: 'un Excel', abrir: 'Abrir Excel' };
    if (/word/.test(m)) return { etiqueta: 'WORD', de: 'un Word', abrir: 'Abrir Word' };
    return { etiqueta: 'DOC', de: 'un documento', abrir: 'Abrir archivo' };
}

export type EstadoVenta = 'abierta' | 'enviada' | 'ganada' | 'perdida';

export async function cerrarCotizacion(id: string, estado: EstadoVenta, motivo?: string | null): Promise<{ ok: boolean; cliente_actualizado?: boolean }> {
    return jsonOError(await apiFetch(`${BASE}/cotizaciones/${id}/cierre`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ estado, motivo: motivo ?? null }),
    }));
}

export async function listarCotizaciones(): Promise<{ cotizaciones: CotizacionResumen[] }> {
    return jsonOError(await apiFetch(`${BASE}/cotizaciones`));
}

export async function obtenerCotizacion(id: string): Promise<{ cotizacion: Cotizacion }> {
    return jsonOError(await apiFetch(`${BASE}/cotizaciones/${id}`));
}

export async function actualizarCotizacion(
    id: string,
    cambios: { titulo?: string | null; datos_cliente?: DatosCliente },
): Promise<{ ok: boolean }> {
    return jsonOError(await apiFetch(`${BASE}/cotizaciones/${id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cambios),
    }));
}

export async function numeroPresupuesto(id: string): Promise<{ numero: number }> {
    return jsonOError(await apiFetch(`${BASE}/cotizaciones/${id}/numero`, { method: 'POST' }));
}

// PDF generado en el backend (el mismo que se adjunta a los correos).
// Descargarlo asigna el número; `borrador` es una vista previa que no toca nada.
export async function pdfCotizacion(id: string, borrador = false): Promise<{ blob: Blob; archivo: string }> {
    const res = await apiFetch(`${BASE}/cotizaciones/${id}/pdf${borrador ? '?borrador=1' : ''}`);
    if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(typeof err.error === 'string' ? err.error : `Backend respondió ${res.status}`);
    }
    const disp = res.headers.get('Content-Disposition') ?? '';
    const archivo = /filename="([^"]+)"/.exec(disp)?.[1] ?? 'Presupuesto.pdf';
    return { blob: await res.blob(), archivo };
}

// Deja en Para aprobar un correo con el presupuesto adjunto.
export async function enviarCotizacionPorCorreo(id: string, para: string, nombre?: string): Promise<{ ok: boolean; accion_id?: string }> {
    return jsonOError(await apiFetch(`${BASE}/cotizaciones/${id}/enviar`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ para, nombre }),
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
    cliente: Omit<Prospecto, 'estado'> & {
        estado: EmpresaSeguimiento['estado'];
        intentos_contacto: number | null;
        ultimo_contacto_en: string | null;
    };
    correos: CorreoHistorico[];
    whatsapp?: MensajeWa[];
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
    // Informe guardado en la memoria del cliente
    id?: string;
    creado_en?: string;
    origen?: 'manual' | 'automatico';
    // Partió del informe anterior y sumó solo lo nuevo
    incremental?: boolean;
    // No había nada nuevo: es el mismo informe de antes, sin costo
    sin_novedades?: boolean;
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

export async function generarInformeCliente(
    id: string,
    opts: { contexto_extra?: string; desde_cero?: boolean } = {},
): Promise<{ informe: InformeCliente }> {
    const body: Record<string, unknown> = {};
    if (opts.contexto_extra) body.contexto_extra = opts.contexto_extra;
    if (opts.desde_cero) body.desde_cero = true;
    const res = await apiFetch(`${BASE}/seguimientos/empresas/${id}/informe`, {
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

// ---------- Memoria del cliente: informes guardados, notas y documentos ----------

export interface InformeGuardado {
    id: string;
    resumen_md: string;
    origen: 'manual' | 'automatico';
    base_id: string | null;
    costo_usd: number | null;
    creado_en: string;
}

// Las notas largas (una conversación pegada) las resume la IA en segundo plano.
export interface NotaCliente { id: string; texto: string; resumen?: string | null; creado_en: string }
export const MAX_CHARS_NOTA = 60_000;
export const NOTA_LARGA = 1500;

export interface DocumentoCliente {
    id: string;
    nombre: string;
    tipo_mime: string | null;
    tamano_bytes: number | null;
    estado: 'procesando' | 'listo' | 'error';
    tipo_documento: string | null;
    resumen: string | null;
    error: string | null;
    creado_en: string;
    procesado_en: string | null;
    // Si es un presupuesto: lo que leyó la IA, si cuenta en Cotizado y su cotización
    datos?: DatosDocumento | null;
    sin_cotizado?: boolean;
    cotizacion_id?: string | null;
    cotizacion?: { id: string; total_usd: number | null; estado: EstadoVenta; origen: string; numero: number | null; numero_externo: string | null } | null;
}

export interface OpcionPresupuesto { nombre: string; total: number }
export interface DatosDocumento {
    version: number;
    presupuesto: {
        // 'desconocido': no dice de quién es (foto, lista suelta); cuenta como de Bartez
        emisor: 'bartez' | 'otro' | 'desconocido';
        emisor_nombre: string | null;
        para: string | null;
        numero: string | null;
        fecha: string | null;
        objeto: string | null;
        moneda: 'USD' | 'ARS';
        iva_incluido: boolean;
        tipo_cambio: number | null;
        opciones: OpcionPresupuesto[];
    } | null;
    // Opción que cuenta en Cotizado; si no se eligió, la más baja
    opcion?: number;
    // Andrés dijo que es nuestro aunque la IA leyó otro emisor
    nuestro?: boolean;
    // Total cargado a mano (pisa lo que leyó la IA)
    total_manual?: { monto: number; moneda: 'USD' | 'ARS' };
}

export interface CambioCotizadoDoc {
    contar?: boolean;
    opcion?: number;
    nuestro?: boolean;
    total?: { monto: number; moneda: 'USD' | 'ARS' };
}

// Lo que se corrige desde la ficha: contarlo o no en Cotizado, qué opción
// cuenta, que es nuestro, o el total a mano.
export async function cotizadoDocumento(docId: string, cambios: CambioCotizadoDoc): Promise<{ documento: DocumentoCliente }> {
    return jsonOError(await apiFetch(`${BASE}/seguimientos/documentos/${docId}/cotizado`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cambios),
    }));
}

export interface MemoriaCliente { informes: InformeGuardado[]; notas: NotaCliente[]; documentos: DocumentoCliente[] }

export async function memoriaCliente(id: string): Promise<MemoriaCliente> {
    return jsonOError(await apiFetch(`${BASE}/seguimientos/empresas/${id}/memoria`));
}

export async function crearNotaCliente(id: string, texto: string): Promise<{ nota: NotaCliente }> {
    return jsonOError(await apiFetch(`${BASE}/seguimientos/empresas/${id}/notas`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ texto }),
    }));
}

export async function borrarNotaCliente(notaId: string): Promise<{ ok: boolean }> {
    return jsonOError(await apiFetch(`${BASE}/seguimientos/notas/${notaId}`, { method: 'DELETE' }));
}

export const MAX_MB_DOCUMENTO = 12;

export async function subirDocumentoCliente(id: string, archivo: File): Promise<{ documento: DocumentoCliente }> {
    const datos_base64 = await aBase64(archivo);
    return jsonOError(await apiFetch(`${BASE}/seguimientos/empresas/${id}/documentos`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nombre: archivo.name, tipo_mime: archivo.type || undefined, datos_base64 }),
    }));
}

export async function urlDocumentoCliente(docId: string): Promise<{ url: string }> {
    return jsonOError(await apiFetch(`${BASE}/seguimientos/documentos/${docId}/url`));
}

export async function reprocesarDocumentoCliente(docId: string): Promise<{ ok: boolean }> {
    return jsonOError(await apiFetch(`${BASE}/seguimientos/documentos/${docId}/reprocesar`, { method: 'POST' }));
}

export async function borrarDocumentoCliente(docId: string): Promise<{ ok: boolean }> {
    return jsonOError(await apiFetch(`${BASE}/seguimientos/documentos/${docId}`, { method: 'DELETE' }));
}

function aBase64(archivo: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const lector = new FileReader();
        lector.onload = () => resolve(String(lector.result).replace(/^data:[^,]*,/, ''));
        lector.onerror = () => reject(new Error(`No se pudo leer ${archivo.name}`));
        lector.readAsDataURL(archivo);
    });
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

// Aprobados que no se pudieron enviar (p. ej. el servidor de correo no respondió).
export interface EnvioFallido {
    id: string;
    accion: string;
    payload: Record<string, unknown>;
    estado: string;
    respuesta: { ejecucion?: { ok: boolean; detalle?: string }; reintento_en?: string } | null;
    resuelto_en: string | null;
    creado_en: string;
}

export async function listarEnviosFallidos(): Promise<{ acciones: EnvioFallido[] }> {
    return jsonOError(await apiFetch(`${BASE}/acciones/fallidas`));
}

export async function reintentarEnvio(id: string): Promise<{ ejecucion: { ok: boolean; detalle?: string } }> {
    return jsonOError(await apiFetch(`${BASE}/acciones/${id}/reintentar`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }));
}

export async function descartarEnvio(id: string): Promise<{ ok: boolean }> {
    return jsonOError(await apiFetch(`${BASE}/acciones/${id}/descartar`, { method: 'POST' }));
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
    lecciones?: string | null;
    lecciones_en?: string | null;
}

export interface Aprendizaje {
    id: string;
    tipo: 'rechazo' | 'edicion';
    canal: string | null;
    situacion: string | null;
    propuesto: string | null;
    corregido: string | null;
    motivo: string | null;
    destilado: boolean;
    creado_en: string;
}

export async function listarAprendizajes(asistenteId: string): Promise<{ aprendizajes: Aprendizaje[] }> {
    return jsonOError(await apiFetch(`${BASE}/asistentes/${asistenteId}/aprendizajes`));
}

// Convierte las correcciones en lecciones ahora, sin esperar a la corrida nocturna.
export async function actualizarLecciones(asistenteId: string): Promise<{ ok: boolean; lecciones?: string; usadas?: number }> {
    return jsonOError(await apiFetch(`${BASE}/asistentes/${asistenteId}/lecciones`, { method: 'POST' }));
}

export async function listarAsistentes(): Promise<{ asistentes: AsistenteEditable[] }> {
    const res = await apiFetch(`${BASE}/asistentes`);
    if (!res.ok) throw new Error(`Backend respondió ${res.status}`);
    return res.json();
}

export async function actualizarAsistente(
    id: string,
    cambios: Partial<Pick<AsistenteEditable, 'prompt' | 'modelo' | 'autonomia' | 'activo' | 'lecciones'>>,
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
): Promise<{ ejecucion?: { ok: boolean; detalle?: string } }> {
    const res = await apiFetch(`${BASE}/acciones/${id}/${resolucion}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || `Backend respondió ${res.status}`);
    }
    return res.json().catch(() => ({}));
}

// ---------- WhatsApp (vía la web de Bartez) ----------

export interface ConversacionWa {
    wa_id: string;
    nombre: string | null;
    estado: string | null;
    categoria: string | null;
    cliente_id: string | null;
    cliente_nombre: string | null;
    actualizado_en: string | null;
    ultimo_mensaje: string | null;
    ultimo_origen: string | null;
    en_ventana: boolean;
    ventana_hasta: string | null;
    respuesta_pendiente: boolean;
}

export interface MensajeWa {
    id: string;
    direccion: string;
    origen: 'cliente' | 'bot' | 'humano' | string;
    cuerpo: string | null;
    creado_en: string;
}

export interface ResultadoSyncWa {
    ok: boolean;
    conversaciones: number;
    actualizadas: number;
    borradores: number;
    detalle?: string;
}

export async function estadoWhatsapp(): Promise<{ configurado: boolean }> {
    return jsonOError(await apiFetch(`${BASE}/whatsapp/estado`));
}

export async function sincronizarWa(): Promise<{ resultado: ResultadoSyncWa }> {
    return jsonOError(await apiFetch(`${BASE}/whatsapp/sincronizar`, { method: 'POST' }));
}

// Plantillas aprobadas en Meta: las únicas que WhatsApp deja mandar fuera de
// la ventana de 24 h. {{1}}, {{2}}… son los valores de cada envío.
export interface PlantillaWa { nombre: string; idioma: string; texto: string; descripcion?: string }

export async function listarPlantillasWa(): Promise<{ plantillas: PlantillaWa[] }> {
    return jsonOError(await apiFetch(`${BASE}/whatsapp/plantillas`));
}

export async function guardarPlantillasWa(plantillas: PlantillaWa[]): Promise<{ ok: boolean }> {
    return jsonOError(await apiFetch(`${BASE}/whatsapp/plantillas`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plantillas }),
    }));
}

// Plantilla elegida y completada por el operador: sale ya, sin Para aprobar.
export async function enviarPlantillaWaAMano(waId: string, nombre: string, parametros: string[]): Promise<{ ok: boolean; mensaje: MensajeWa }> {
    return jsonOError(await apiFetch(`${BASE}/whatsapp/conversaciones/${waId}/plantilla/enviar`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nombre, parametros }),
    }));
}

export async function proponerPlantillaWa(waId: string, nombre: string, parametros: string[]): Promise<{ ok: boolean; accion_id?: string }> {
    return jsonOError(await apiFetch(`${BASE}/whatsapp/conversaciones/${waId}/plantilla`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nombre, parametros }),
    }));
}

export async function listarConversacionesWa(): Promise<{ conversaciones: ConversacionWa[] }> {
    return jsonOError(await apiFetch(`${BASE}/whatsapp/conversaciones`));
}

export async function detalleConversacionWa(waId: string): Promise<{
    conversacion: ConversacionWa & { ultimo_entrante_en: string | null; clientes?: { nombre: string; email: string | null } | null };
    mensajes: MensajeWa[];
    // La respuesta que Bartez dejó en Para aprobar para esta conversación
    propuesta?: { accion_id: string; cuerpo: string; creado_en: string } | null;
}> {
    return jsonOError(await apiFetch(`${BASE}/whatsapp/conversaciones/${waId}`));
}

// Lo que escribió el operador sale ya (dentro de las 24 h), sin pasar por Para aprobar.
export async function enviarWhatsappAMano(waId: string, texto: string, desde_propuesta?: string | null): Promise<{ ok: boolean; mensaje: MensajeWa }> {
    return jsonOError(await apiFetch(`${BASE}/whatsapp/conversaciones/${waId}/enviar`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ texto, desde_propuesta: desde_propuesta ?? null }),
    }));
}

// Borrador de Bartez para la caja del chat: desde cero o a partir de lo escrito.
export async function borradorWhatsapp(waId: string, borrador?: string): Promise<{ texto: string }> {
    return jsonOError(await apiFetch(`${BASE}/whatsapp/conversaciones/${waId}/borrador`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ borrador: borrador || undefined }),
    }));
}

export interface AjustesWa { presentarse_como: string }
export async function ajustesWhatsapp(): Promise<{ ajustes: AjustesWa }> {
    return jsonOError(await apiFetch(`${BASE}/whatsapp/ajustes`));
}
export async function guardarAjustesWhatsapp(ajustes: AjustesWa): Promise<{ ajustes: AjustesWa }> {
    return jsonOError(await apiFetch(`${BASE}/whatsapp/ajustes`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ajustes),
    }));
}

export async function proponerRespuestaWa(waId: string, contexto_extra?: string): Promise<{ ok: boolean; accion_id?: string }> {
    return jsonOError(await apiFetch(`${BASE}/whatsapp/conversaciones/${waId}/proponer`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contexto_extra }),
    }));
}

export async function vincularClienteWa(waId: string, cliente_id: string | null): Promise<{ ok: boolean }> {
    return jsonOError(await apiFetch(`${BASE}/whatsapp/conversaciones/${waId}/vincular`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cliente_id }),
    }));
}

export async function crearClienteDesdeWa(waId: string, nombre?: string): Promise<{ ok: boolean; cliente_id?: string }> {
    return jsonOError(await apiFetch(`${BASE}/whatsapp/conversaciones/${waId}/crear-cliente`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nombre }),
    }));
}

// ---------- Resumen del día (Inicio y contadores del menú) ----------

export interface ResumenHoy {
    linea: {
        entra: { total: number; correos: number; whatsapp: number };
        propone: number;
        tu_ok: number;
        sale: { total: number; aprobadas: number; rechazadas: number };
    };
    costo_hoy_usd: number;
    prioridades: { fecha: string; items: Array<{ texto: string; por_que?: string }> } | null;
    foto: {
        generado_en: string;
        acciones_pendientes: Array<{ tipo: string; destino: string; resumen: string; creada: string; asistente: string | null }>;
        whatsapp: {
            derivadas: number;
            sin_responder_en_ventana: Array<{ contacto: string; ultimo: string; hace_horas: number; vence: string }>;
            sin_responder_vencidas: Array<{ contacto: string; ultimo: string; dias: number }>;
        };
        correos_3_dias: {
            por_categoria: Record<string, number>;
            relevantes: Array<{ de: string; asunto: string; categoria: string | null; fecha: string; respondido: boolean }>;
        };
        cotizaciones_14_dias: Array<{ numero: string | null; cliente: string; total_usd: number; fecha: string; renglones: number }>;
        pipeline: {
            por_estado: Record<string, number>;
            leads_calientes: Array<{ nombre: string; icp: number | null; ultimo_contacto: string | null; intentos: number }>;
            leads_sin_contacto_7d: number;
        };
        proveedores: Array<{ nombre: string; estado: string | null; articulos: number | null; ultima_sync: string | null }>;
        tareas_notion: Array<{ id: string; titulo: string; cliente: string; estado: string | null; fecha_limite: string | null }>;
    };
    pulso: Pulso | null;
    generado_en: string;
}

// Series de los últimos 30 días (una posición por día, la última es hoy).
export interface Pulso {
    dias: string[];
    consultas_correo: number[];
    consultas_whatsapp: number[];
    // Últimas 8 semanas (lunes a domingo); falta si el backend es anterior.
    semanas?: { inicio: string[]; correo: number[]; whatsapp: number[] };
    cotizado_usd: number[];
    leads_nuevos: number[];
    kpis: {
        cotizado_mes_usd: number;
        cotizado_mes_anterior_usd: number;
        presupuestos_mes: number;
        presupuestos_mes_anterior: number;
        consultas_30d: number;
        consultas_30d_anterior: number;
        leads_30d: number;
        leads_30d_anterior: number;
        aprobadas_30d: number;
        resueltas_30d: number;
        ganado_mes_usd: number;
        ganado_mes_anterior_usd: number;
        ganadas_90d: number;
        perdidas_90d: number;
    };
    esperando: Array<{ id: string; titulo: string | null; numero: number | null; total_usd: number; enviada_en: string }>;
    esperando_total: number;
    embudo: { prospectos: number; contactados: number; respondieron: number; clientes: number };
}

export async function resumenHoy(refrescar = false): Promise<ResumenHoy> {
    return jsonOError(await apiFetch(`${BASE}/hoy${refrescar ? '?refrescar=1' : ''}`));
}

// ---------- Mapa del negocio (Inicio) y sugerencias de Bartez AI ----------

export type AreaMapa = 'seguimientos' | 'cotizador' | 'correo' | 'whatsapp' | 'prospeccion';
export type DestinoMapa = 'acciones' | 'cotizador' | 'seguimientos' | 'whatsapp' | 'prospeccion';

export interface NodoMapa {
    id: string;
    tipo: 'cliente' | 'presupuesto' | 'conversacion';
    nombre: string;
    subtitulo: string;
    urgente: boolean;
    consultas: number;
    presupuestos: number;
    en_juego_usd: number | null;
    dias_sin_respuesta: number | null;
    compras: number | null;
    historia: Array<{ fecha: string; texto: string; tipo: 'consulta' | 'presupuesto' | 'venta' | 'contacto' }>;
    sugerencia: string;
    acciones: Array<{ etiqueta: string; tipo: 'chat' | 'ir'; texto?: string; destino?: DestinoMapa; cotizacion_id?: string }>;
}

export interface AsistenteMapa {
    area: AreaMapa;
    nombre: string;
    aprobacion_pct: number | null;
    resueltas_30d: number;
    pendientes: number;
    nodos: NodoMapa[];
    mas: number;
}

export interface Sugerencia { texto: string; pedido: string }

export interface Mapa {
    cierre_pct: number | null;
    asistentes: AsistenteMapa[];
    meses: Array<{ mes: string; ganado_usd: number; perdido_usd: number }>;
    sugerencias: Sugerencia[];
    generado_en: string;
}

export const SIN_MAPA = 'SIN_MAPA';

export async function mapaNegocio(refrescar = false): Promise<Mapa> {
    const res = await apiFetch(`${BASE}/mapa${refrescar ? '?refrescar=1' : ''}`);
    // 404: el backend que está corriendo es anterior al mapa.
    if (res.status === 404) throw new Error(SIN_MAPA);
    return jsonOError(res);
}

export async function sugerenciasBartez(): Promise<{ sugerencias: Sugerencia[] }> {
    return jsonOError(await apiFetch(`${BASE}/sugerencias`));
}
