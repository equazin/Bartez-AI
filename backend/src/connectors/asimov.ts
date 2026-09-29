// Conexión con Asimov (el sistema de gestión de Bartez) a través de su API en
// la nube: la misma que usan las PCs para sincronizarse entre sí.
//
// Bartez AI entra con un usuario propio de la empresa (ASIMOV_EMAIL /
// ASIMOV_PASSWORD en Railway). Nunca toca el certificado de ARCA: eso vive en
// la PC y el CAE lo pide Asimov.

const URL_DEFECTO = 'https://asimov-api-lwci.onrender.com/api/v1';

const env = (k: string) => (process.env[k] ?? '').trim();

export function asimovConfigurado(): { ok: boolean; faltan: string[] } {
    const faltan = ['ASIMOV_EMAIL', 'ASIMOV_PASSWORD'].filter((k) => !env(k));
    return { ok: faltan.length === 0, faltan };
}

function base(): string {
    return (env('ASIMOV_API_URL') || URL_DEFECTO).replace(/\/+$/, '');
}

let sesion: { token: string; vence: number } | null = null;

// El token es un JWT: se usa hasta un minuto antes de que venza.
function venceDe(jwt: string): number {
    try {
        const p = JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString('utf8')) as { exp?: number };
        return p.exp ? p.exp * 1000 : Date.now() + 10 * 60_000;
    } catch { return Date.now() + 10 * 60_000; }
}

async function entrar(): Promise<string> {
    const c = asimovConfigurado();
    if (!c.ok) throw new Error(`Falta cargar en Railway: ${c.faltan.join(', ')}`);
    // Render en plan gratis duerme el servicio: la primera llamada puede tardar ~1 minuto.
    const r = await fetch(`${base()}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-device-origin': 'web' },
        body: JSON.stringify({ email: env('ASIMOV_EMAIL'), password: env('ASIMOV_PASSWORD') }),
        signal: AbortSignal.timeout(90_000),
    });
    const j = await r.json().catch(() => null) as { data?: { accessToken?: string }; message?: string | string[] } | null;
    const token = j?.data?.accessToken;
    if (!r.ok || !token) {
        if (r.status === 401) throw new Error('Asimov rechazó el usuario o la contraseña de Bartez AI (revisá ASIMOV_EMAIL y ASIMOV_PASSWORD en Railway)');
        throw new Error(`No se pudo entrar a Asimov (${Array.isArray(j?.message) ? j?.message.join(', ') : j?.message ?? r.status})`);
    }
    sesion = { token, vence: venceDe(token) };
    return token;
}

async function token(): Promise<string> {
    if (sesion && sesion.vence > Date.now() + 60_000) return sesion.token;
    return entrar();
}

// Llamada a la API. Si el token venció en el medio, entra de nuevo una vez.
export async function asimov<T = unknown>(ruta: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    for (let intento = 0; intento < 2; intento++) {
        const r = await fetch(`${base()}${ruta}`, {
            method: init.method ?? 'GET',
            headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json', 'x-device-origin': 'web' },
            body: init.body === undefined ? undefined : JSON.stringify(init.body),
            signal: AbortSignal.timeout(90_000),
        });
        if (r.status === 401 && intento === 0) { sesion = null; continue; }
        const j = await r.json().catch(() => null) as { message?: string | string[] } | null;
        if (!r.ok) {
            const m = Array.isArray(j?.message) ? j?.message.join(', ') : j?.message;
            if (r.status === 403) throw new Error(`Asimov: el usuario de Bartez AI no tiene permiso para esto (${m ?? 'prohibido'})`);
            throw new Error(`Asimov: ${m ?? `HTTP ${r.status}`}`);
        }
        return j as T;
    }
    throw new Error('Asimov: no se pudo renovar la sesión');
}

// ---------------------------------------------------------------- clientes

export interface ClienteAsimov {
    id: string;
    businessName: string;
    cuit: string | null;
    fiscalType: string | null;
    email: string | null;
    city: string | null;
}

export async function buscarClientesAsimov(q: string): Promise<ClienteAsimov[]> {
    const r = await asimov<{ data?: ClienteAsimov[] }>(`/clients?search=${encodeURIComponent(q)}&limit=8&active=true`);
    return r.data ?? [];
}

export async function crearClienteAsimov(c: { razon_social: string; cuit: string | null; condicion_iva: string; email?: string | null; domicilio?: string | null; ciudad?: string | null }): Promise<ClienteAsimov> {
    const r = await asimov<{ data?: ClienteAsimov } & Partial<ClienteAsimov>>('/clients', {
        method: 'POST',
        body: {
            businessName: c.razon_social, cuit: c.cuit, fiscalType: c.condicion_iva,
            email: c.email ?? undefined, address: c.domicilio ?? undefined, city: c.ciudad ?? undefined,
            notes: 'Alta desde Bartez AI',
        },
    });
    const cli = r.data ?? (r.id ? r as ClienteAsimov : null);
    if (!cli?.id) throw new Error('Asimov no devolvió el cliente creado');
    return cli;
}

// ---------------------------------------------------------------- sincronización

export interface CambioAsimov { entity: string; action: string; id: string; data: Record<string, unknown>; updatedAt?: string }

export async function empujarCambios(changes: CambioAsimov[]): Promise<void> {
    const r = await asimov<{ data?: { processed?: number; conflictDetails?: Array<{ error?: string }> } }>('/sync/push', { method: 'POST', body: { changes } });
    const err = r.data?.conflictDetails?.[0]?.error;
    if (err || (r.data?.processed ?? changes.length) < changes.length) throw new Error(`Asimov no aceptó el documento: ${err ?? 'sin detalle'}`);
}

export async function traerCambios(desde: string): Promise<CambioAsimov[]> {
    const r = await asimov<{ data?: { changes?: CambioAsimov[] } | CambioAsimov[] }>(`/sync/pull?since=${encodeURIComponent(desde)}`);
    const d = r.data;
    return Array.isArray(d) ? d : d?.changes ?? [];
}
