// Wrapper de Gmail — usa OAuth 2.0 con refresh token.
// Requiere credenciales del proyecto Google Cloud con la Gmail API habilitada.

import { google } from 'googleapis';

const clientId = process.env.GMAIL_CLIENT_ID ?? '';
const clientSecret = process.env.GMAIL_CLIENT_SECRET ?? '';
const refreshToken = process.env.GMAIL_REFRESH_TOKEN ?? '';
const userEmail = process.env.GMAIL_USER_EMAIL ?? '';

const configurado = Boolean(clientId && clientSecret && refreshToken && userEmail);

const oauth2 = new google.auth.OAuth2(clientId, clientSecret);
if (refreshToken) {
    oauth2.setCredentials({ refresh_token: refreshToken });
}

const gmail = google.gmail({ version: 'v1', auth: oauth2 });

export interface CorreoEntrante {
    id: string;
    threadId: string;
    de: string;
    asunto: string;
    cuerpo: string;
    fecha: string;
}

export async function listarNoLeidos(max = 20): Promise<CorreoEntrante[]> {
    if (!configurado) {
        console.warn('[gmail] credenciales sin configurar — devolviendo lista vacía');
        return [];
    }
    const { data } = await gmail.users.messages.list({
        userId: 'me',
        q: 'is:unread',
        maxResults: max,
    });
    if (!data.messages) return [];

    const detalles = await Promise.all(
        data.messages.map((m) => gmail.users.messages.get({ userId: 'me', id: m.id! }))
    );

    return detalles.map((res) => {
        const msg = res.data;
        const headers = msg.payload?.headers ?? [];
        const de = headers.find((h) => h.name === 'From')?.value ?? '';
        const asunto = headers.find((h) => h.name === 'Subject')?.value ?? '';
        const fecha = headers.find((h) => h.name === 'Date')?.value ?? '';
        return {
            id: msg.id!,
            threadId: msg.threadId!,
            de,
            asunto,
            cuerpo: extraerCuerpo(msg.payload),
            fecha,
        };
    });
}

export async function enviarCorreo(params: {
    para: string;
    asunto: string;
    cuerpo: string;
    inReplyTo?: string;
    threadId?: string;
}): Promise<void> {
    if (!configurado) {
        console.warn(`[gmail] STUB — enviaría a ${params.para}: "${params.asunto}"`);
        return;
    }
    const raw = construirMime({ ...params, de: userEmail });
    await gmail.users.messages.send({
        userId: 'me',
        requestBody: { raw, threadId: params.threadId },
    });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extraerCuerpo(payload: any): string {
    if (!payload) return '';
    if (payload.body?.data) {
        return Buffer.from(payload.body.data, 'base64').toString('utf-8');
    }
    if (payload.parts) {
        for (const parte of payload.parts) {
            const texto = extraerCuerpo(parte);
            if (texto) return texto;
        }
    }
    return '';
}

function construirMime(p: { de: string; para: string; asunto: string; cuerpo: string; inReplyTo?: string }): string {
    const lineas = [
        `From: ${p.de}`,
        `To: ${p.para}`,
        `Subject: ${p.asunto}`,
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset="UTF-8"',
    ];
    if (p.inReplyTo) {
        lineas.push(`In-Reply-To: ${p.inReplyTo}`);
        lineas.push(`References: ${p.inReplyTo}`);
    }
    lineas.push('', p.cuerpo);
    return Buffer.from(lineas.join('\r\n')).toString('base64url');
}
