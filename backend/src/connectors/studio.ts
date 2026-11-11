// Cliente de la API v1 de bartez.com.ar (Bartez-Studio). La web ya tiene el
// bot de WhatsApp conectado a Meta: acá solo leemos sus conversaciones y
// mandamos mensajes a través de ella, igual que la app de escritorio Asimov.
//
//   GET  /api/v1/conversations?page=&limit=      lista (con el último mensaje)
//   GET  /api/v1/conversations/{waId}            detalle con todos los mensajes
//   POST /api/v1/conversations/{waId}/messages   { message }
//   POST /api/v1/conversations/{waId}/template   { template, languageCode, bodyParams, preview }
//   POST /api/v1/conversations/{waId}/media      { url, filename, mimeType, caption }
//        (archivo adjunto: la web lo baja de `url`, lo sube a Meta y lo manda.
//         Si la web todavía no lo tiene publicado responde 404 sin JSON.)

import { createHmac, timingSafeEqual } from 'node:crypto';

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

// Errores en los que el pedido seguro no llegó a la web (se puede repetir sin
// riesgo de mandar dos veces el mismo mensaje).
const NO_LLEGO = /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH/;

async function pedir<T>(ruta: string, init: RequestInit = {}, timeoutMs = 30_000): Promise<T> {
    if (!studioConfigurado()) throw new Error('Falta STUDIO_API_TOKEN en el .env');
    let ultimoError: unknown;
    // Un reintento ante cortes de red; los errores HTTP no se reintentan. Un
    // envío solo se repite si el pedido no llegó (si no, podría salir dos veces).
    for (let intento = 0; intento < 2; intento++) {
        try {
            const res = await fetch(`${base()}${ruta}`, {
                ...init,
                headers: {
                    Authorization: `Bearer ${token()}`,
                    Accept: 'application/json',
                    ...(init.body ? { 'Content-Type': 'application/json' } : {}),
                },
                signal: AbortSignal.timeout(timeoutMs),
            });
            const json = await res.json().catch(() => null) as { ok?: boolean; data?: T; error?: string } | null;
            if (!res.ok || !json?.ok) {
                // 404 sin JSON = esa ruta no existe en la web (no es "conversación no encontrada").
                throw Object.assign(new Error(`Web: ${json?.error ?? `HTTP ${res.status}`}`), { http: true, status: res.status, sinRuta: res.status === 404 && !json });
            }
            return json.data as T;
        } catch (err) {
            if ((err as { http?: boolean }).http) throw err;
            ultimoError = err;
            const codigo = String((err as { cause?: { code?: string } }).cause?.code ?? (err as { code?: string }).code ?? '');
            if ((init.method ?? 'GET') !== 'GET' && !NO_LLEGO.test(codigo)) break;
        }
    }
    const vencido = /TimeoutError|AbortError/.test(String((ultimoError as Error)?.name ?? ''));
    if (vencido && (init.method ?? 'GET') !== 'GET') {
        throw new Error('Web: tardó demasiado en responder. Puede que el mensaje haya salido igual: revisá el chat antes de volver a mandarlo.');
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

export interface AdjuntoStudio {
    url: string;        // de donde la web baja el archivo (link firmado, vence en minutos)
    nombre: string;
    mime: string;
    texto?: string;     // lo que acompaña al archivo (hasta 1024 caracteres)
}

export function enviarAdjuntoStudio(waId: string, a: AdjuntoStudio): Promise<MensajeStudio> {
    return pedir<MensajeStudio>(`/api/v1/conversations/${encodeURIComponent(waId)}/media`, {
        method: 'POST',
        body: JSON.stringify({ url: a.url, filename: a.nombre, mimeType: a.mime, caption: a.texto ?? '' }),
    }, 90_000); // la web baja el archivo y lo sube a Meta antes de mandarlo

}

// La web todavía no tiene el envío de archivos publicado.
export const esSinRuta = (err: unknown) => Boolean((err as { sinRuta?: boolean } | null)?.sinRuta);

// Aviso de la web (POST /whatsapp/aviso): viene firmado con el mismo token de
// la API, sin mandarlo. Firma = HMAC-SHA256(token, "<ts>.<waId>") en hex.
export function firmaAviso(waId: string, ts: number): string {
    return createHmac('sha256', token()).update(`${ts}.${waId}`).digest('hex');
}

export function firmaAvisoValida(waId: string, ts: number, firma: string): boolean {
    if (!studioConfigurado() || !/^[0-9a-f]{64}$/.test(firma)) return false;
    return timingSafeEqual(Buffer.from(firmaAviso(waId, ts), 'hex'), Buffer.from(firma, 'hex'));
}
