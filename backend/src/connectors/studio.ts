// Cliente de la API v1 de bartez.com.ar (Bartez-Studio). La web ya tiene el
// bot de WhatsApp conectado a Meta: acá solo leemos sus conversaciones y
// mandamos mensajes a través de ella, igual que la app de escritorio Asimov.
//
//   GET  /api/v1/conversations?page=&limit=      lista (con el último mensaje)
//   GET  /api/v1/conversations/{waId}            detalle con todos los mensajes
//   POST /api/v1/conversations/{waId}/messages   { message }
//   POST /api/v1/conversations/{waId}/template   { template, languageCode, bodyParams, preview }

const base = () => (process.env.STUDIO_API_URL ?? 'https://bartez.com.ar').trim().replace(/\/+$/, '');
const token = () => (process.env.STUDIO_API_TOKEN ?? '').trim();

export const studioConfigurado = () => token().length > 0;

export interface MensajeStudio {
    id: string;
    waMessageId: string;
    direction: 'inbound' | 'outbound';
    type: string;
    body: string | null;
    category: string | null;
    metadata: Record<string, unknown> | null;
    createdAt: string;
}

export interface ConversacionStudio {
    id: string;
    waId: string;
    profileName: string | null;
    category: string | null;
    status: string;
    updatedAt: string;
    messages: MensajeStudio[];
}

async function pedir<T>(ruta: string, init: RequestInit = {}): Promise<T> {
    if (!studioConfigurado()) throw new Error('Falta STUDIO_API_TOKEN en el .env');
    let ultimoError: unknown;
    // Un reintento ante cortes de red; los errores HTTP no se reintentan.
    for (let intento = 0; intento < 2; intento++) {
        try {
            const res = await fetch(`${base()}${ruta}`, {
                ...init,
                headers: {
                    Authorization: `Bearer ${token()}`,
                    Accept: 'application/json',
                    ...(init.body ? { 'Content-Type': 'application/json' } : {}),
                },
                signal: AbortSignal.timeout(30_000),
            });
            const json = await res.json().catch(() => null) as { ok?: boolean; data?: T; error?: string } | null;
            if (!res.ok || !json?.ok) {
                throw Object.assign(new Error(`Web: ${json?.error ?? `HTTP ${res.status}`}`), { http: true });
            }
            return json.data as T;
        } catch (err) {
            if ((err as { http?: boolean }).http) throw err;
            ultimoError = err;
        }
    }
    throw new Error(`Web: no se pudo conectar (${(ultimoError as Error)?.message ?? 'error de red'})`);
}

export async function listarConversacionesStudio(): Promise<ConversacionStudio[]> {
    const todas: ConversacionStudio[] = [];
    for (let page = 1; page <= 50; page++) {
        const lote = await pedir<ConversacionStudio[]>(`/api/v1/conversations?page=${page}&limit=200`);
        todas.push(...lote);
        if (lote.length < 200) break;
    }
    return todas;
}

export function obtenerConversacionStudio(waId: string): Promise<ConversacionStudio> {
    return pedir<ConversacionStudio>(`/api/v1/conversations/${encodeURIComponent(waId)}`);
}

export function enviarTextoStudio(waId: string, mensaje: string): Promise<MensajeStudio> {
    return pedir<MensajeStudio>(`/api/v1/conversations/${encodeURIComponent(waId)}/messages`, {
        method: 'POST',
        body: JSON.stringify({ message: mensaje }),
    });
}

export function enviarPlantillaStudio(
    waId: string,
    plantilla: { nombre: string; idioma?: string; parametros?: string[]; vista?: string },
): Promise<MensajeStudio> {
    return pedir<MensajeStudio>(`/api/v1/conversations/${encodeURIComponent(waId)}/template`, {
        method: 'POST',
        body: JSON.stringify({
            template: plantilla.nombre,
            languageCode: plantilla.idioma ?? 'es_AR',
            bodyParams: plantilla.parametros ?? [],
            preview: plantilla.vista ?? '',
        }),
    });
}
