// Conector Ferozo (IMAP + SMTP estándar).
// - `iniciarListener` mantiene conexión IMAP abierta con IDLE. Cada correo nuevo
//   se parsea y se pasa al handler que le indiquemos.
// - `enviarCorreo` envía por SMTP y devuelve el messageId del correo emitido.
// - Todo desde/hacia la casilla configurada en .env.

import { ImapFlow } from 'imapflow';
import { simpleParser, ParsedMail } from 'mailparser';
import nodemailer, { Transporter } from 'nodemailer';

const email = process.env.FEROZO_EMAIL ?? '';
const password = process.env.FEROZO_PASSWORD ?? '';
const imapHost = process.env.FEROZO_IMAP_HOST ?? '';
const imapPort = Number(process.env.FEROZO_IMAP_PORT ?? 993);
const smtpHost = process.env.FEROZO_SMTP_HOST ?? '';
const smtpPort = Number(process.env.FEROZO_SMTP_PORT ?? 465);
const smtpSecure = (process.env.FEROZO_SMTP_SECURE ?? 'true') === 'true';

export const ferozoConfigurado = Boolean(email && password && imapHost && smtpHost);
// La casilla desde la que sale todo (para registrar los enviados en la historia).
export const casillaCorreo = email;

// Envío por HTTPS (Resend) para cuando el SMTP no está disponible: por ejemplo
// en Railway Hobby, que bloquea los puertos de correo. Con RESEND_API_KEY
// cargada, los correos salen por Resend desde la misma casilla (el dominio
// tiene que estar verificado en Resend); la lectura sigue por IMAP.
const resendKey = process.env.RESEND_API_KEY ?? '';
export const envioPorApi = Boolean(resendKey);
const enRailway = Boolean(process.env.RAILWAY_PROJECT_ID || process.env.RAILWAY_ENVIRONMENT_NAME || process.env.RAILWAY_ENVIRONMENT);

// ---------- SMTP ----------

let transporter: Transporter | null = null;
function getTransporter(): Transporter {
    if (!transporter) {
        transporter = nodemailer.createTransport({
            host: smtpHost,
            port: smtpPort,
            secure: smtpSecure, // 465 = true, 587 = false (STARTTLS)
            auth: { user: email, pass: password },
            // Si el servidor no responde, fallar en segundos y no en minutos.
            connectionTimeout: 20_000,
            greetingTimeout: 15_000,
            socketTimeout: 60_000,
        });
    }
    return transporter;
}

export interface CorreoAEnviar {
    para: string;
    asunto: string;
    cuerpo: string;
    inReplyTo?: string;
    references?: string;
    adjuntos?: Array<{ nombre: string; contenido: Buffer; tipo?: string }>;
}

async function enviarPorResend(c: CorreoAEnviar): Promise<{ messageId: string }> {
    const headers: Record<string, string> = {};
    if (c.inReplyTo) headers['In-Reply-To'] = c.inReplyTo;
    if (c.references ?? c.inReplyTo) headers.References = (c.references ?? c.inReplyTo)!;
    const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            from: process.env.CORREO_REMITENTE || email,
            to: [c.para],
            reply_to: email || undefined,
            subject: c.asunto,
            text: c.cuerpo,
            headers,
            attachments: c.adjuntos?.map((a) => ({ filename: a.nombre, content: a.contenido.toString('base64') })),
        }),
        signal: AbortSignal.timeout(30_000),
    });
    const r = await res.json().catch(() => ({})) as { id?: string; message?: string; name?: string };
    if (!res.ok || !r.id) throw new Error(`No se pudo enviar por Resend: ${r.message ?? r.name ?? res.status}`);
    return { messageId: `<${r.id}@resend.dev>` };
}

// Errores de conexión al servidor de correo: se explican en castellano.
function errorDeConexion(err: unknown): boolean {
    const e = err as { code?: string; message?: string };
    return /ETIMEDOUT|ECONNECTION|ESOCKET|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH/.test(e.code ?? '')
        || /timeout|timed out|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH/i.test(e.message ?? '');
}

export async function enviarCorreo(c: CorreoAEnviar): Promise<{ messageId: string }> {
    if (envioPorApi) return enviarPorResend(c);
    if (!ferozoConfigurado) {
        console.warn(`[ferozo] STUB — no configurado; simulando envío a ${c.para}`);
        return { messageId: `<stub-${Date.now()}@bartez.local>` };
    }
    try {
        const info = await getTransporter().sendMail({
            from: email,
            to: c.para,
            subject: c.asunto,
            text: c.cuerpo,
            inReplyTo: c.inReplyTo,
            references: c.references ?? c.inReplyTo,
            attachments: c.adjuntos?.map((a) => ({ filename: a.nombre, content: a.contenido, contentType: a.tipo ?? 'application/pdf' })),
        });
        return { messageId: info.messageId };
    } catch (err) {
        if (!errorDeConexion(err)) throw err;
        throw new Error(enRailway
            ? 'No se pudo conectar al servidor de correo: Railway (plan Hobby) bloquea el envío por SMTP. El correo quedó para reintentar.'
            : 'No se pudo conectar al servidor de correo (SMTP). El correo quedó para reintentar.');
    }
}

// ---------- IMAP listener ----------

export interface CorreoEntrante {
    uid: number;
    messageId: string;
    inReplyTo?: string;
    references?: string[];
    de: string;
    deNombre?: string;
    asunto: string;
    cuerpo: string; // texto plano
    cuerpoHtml?: string;
    fecha: Date;
}

type Handler = (c: CorreoEntrante) => Promise<void>;

let cliente: ImapFlow | null = null;
let corriendo = false;

export async function iniciarListener(handler: Handler): Promise<void> {
    if (!ferozoConfigurado) {
        const faltantes: string[] = [];
        if (!email) faltantes.push('FEROZO_EMAIL');
        if (!password) faltantes.push('FEROZO_PASSWORD');
        if (!imapHost) faltantes.push('FEROZO_IMAP_HOST');
        if (!smtpHost) faltantes.push('FEROZO_SMTP_HOST');
        console.warn(`[ferozo] IMAP no configurado — listener no arranca. Faltan: ${faltantes.join(', ')}`);
        return;
    }
    if (corriendo) return;
    corriendo = true;
    console.log(`[ferozo] intentando conectar IMAP a ${imapHost}:${imapPort} como ${email}...`);

    async function conectar() {
        cliente = new ImapFlow({
            host: imapHost,
            port: imapPort,
            secure: true,
            auth: { user: email, pass: password },
            logger: false,
        });

        try {
            await cliente.connect();
            const lock = await cliente.getMailboxLock('INBOX');
            try {
                // Procesar cualquier correo no leído pendiente al arrancar
                await procesarNoLeidos(handler);
            } finally {
                lock.release();
            }

            // Escuchar eventos de "correo nuevo" (IMAP EXISTS / IDLE)
            cliente.on('exists', async () => {
                const lock2 = await cliente!.getMailboxLock('INBOX');
                try {
                    await procesarNoLeidos(handler);
                } catch (err) {
                    console.error('[ferozo] error procesando correos:', err);
                } finally {
                    lock2.release();
                }
            });

            console.log(`[ferozo] listener IMAP conectado a ${imapHost} como ${email}`);
        } catch (err) {
            console.error('[ferozo] error conectando IMAP:', err);
            // Reintentar en 30 s
            setTimeout(conectar, 30_000);
        }
    }

    async function procesarNoLeidos(h: Handler) {
        if (!cliente) return;
        // Busca UIDs no leídos
        const uids = await cliente.search({ seen: false }, { uid: true });
        if (!uids || uids.length === 0) return;
        for (const uid of uids) {
            try {
                const msg = await cliente.fetchOne(String(uid), { source: true, envelope: true }, { uid: true });
                if (!msg || !msg.source) continue;
                const parsed: ParsedMail = await simpleParser(msg.source);
                const de = parsed.from?.value?.[0];
                const entrante: CorreoEntrante = {
                    uid: Number(uid),
                    messageId: parsed.messageId ?? `<no-id-${uid}@bartez.local>`,
                    inReplyTo: parsed.inReplyTo,
                    references: Array.isArray(parsed.references) ? parsed.references : parsed.references ? [parsed.references] : undefined,
                    de: de?.address ?? 'desconocido@',
                    deNombre: de?.name,
                    asunto: parsed.subject ?? '(sin asunto)',
                    cuerpo: parsed.text ?? '',
                    cuerpoHtml: parsed.html || undefined,
                    fecha: parsed.date ?? new Date(),
                };
                await h(entrante);
                // Marca como leído solo si el handler no tiró
                await cliente.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
            } catch (err) {
                console.error(`[ferozo] error procesando uid ${uid}:`, err);
            }
        }
    }

    // Reconectar si la conexión se cae
    const bucleReconexion = setInterval(async () => {
        if (!cliente || !cliente.usable) {
            console.warn('[ferozo] conexión IMAP caída, reconectando...');
            try { await cliente?.close(); } catch { /* ignore */ }
            cliente = null;
            await conectar();
        }
    }, 60_000);

    // Cerrar limpio si el proceso termina
    const cerrar = async () => {
        clearInterval(bucleReconexion);
        try { await cliente?.close(); } catch { /* ignore */ }
        cliente = null;
        corriendo = false;
    };
    process.on('SIGINT', cerrar);
    process.on('SIGTERM', cerrar);

    await conectar();
}
