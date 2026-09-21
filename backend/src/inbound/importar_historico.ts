// Importa correos históricos de la casilla Ferozo (INBOX + carpeta de enviados)
// hacia la tabla correos_historicos. Cada correo se vincula a un cliente si su
// email matchea con alguno en la Base. Idempotente por message_id.
//
// Uso:
//   POST /correos/importar?dias=90&carpetas=INBOX,Sent
// Al arrancar el server tambien podemos disparar un import inicial "corto"
// si nunca se hizo (una sola vez, marca en integraciones_config).

import { ImapFlow } from 'imapflow';
import { simpleParser, ParsedMail } from 'mailparser';
import { supabase } from '../connectors/supabase.js';
import { ferozoConfigurado } from '../connectors/ferozo.js';
import { clasificarCorreo } from './clasificador.js';

// Reglas de filtro rápido (antes de gastar tokens en Haiku). Devuelven true
// si el correo se debe skipear directamente.
const RE_REMITENTE_BOT = /^(no[-.]?reply|noreply|mailer[-.]?daemon|postmaster|notifications?|alerts?|updates?|news|marketing|hello|info)@/i;
const DOMINIOS_NEWSLETTER = ['mailchimp', 'sendgrid', 'sendinblue', 'brevo.com', 'activecampaign', 'mailerlite', 'campaign-archive'];
const ASUNTOS_TRIVIALES = /\b(unsubscribe|desuscrib|newsletter|bolet(í|i)n|promoci(ó|o)n|oferta especial|black friday|cyber monday)\b/i;

function esRuidoObvio(de: string, asunto: string): boolean {
    const deLower = de.toLowerCase();
    if (RE_REMITENTE_BOT.test(deLower)) return true;
    if (DOMINIOS_NEWSLETTER.some((d) => deLower.includes(d))) return true;
    if (ASUNTOS_TRIVIALES.test(asunto ?? '')) return true;
    return false;
}

const emailBartez = (process.env.FEROZO_EMAIL ?? '').toLowerCase();
const password = process.env.FEROZO_PASSWORD ?? '';
const imapHost = process.env.FEROZO_IMAP_HOST ?? '';
const imapPort = Number(process.env.FEROZO_IMAP_PORT ?? 993);

// Nombres típicos de carpeta "Enviados" en distintos servidores/idiomas.
const CANDIDATOS_ENVIADOS = ['Sent', 'INBOX.Sent', 'Enviados', 'INBOX.Enviados', 'Sent Items', 'INBOX.Sent Items'];

export interface ResultadoImport {
    ok: boolean;
    carpetas_procesadas: Array<{ carpeta: string; leidos: number; nuevos: number; vinculados: number; ruido_saltado: number; ignorables_marcados: number; errores: number }>;
    total_nuevos: number;
    total_vinculados: number;
    total_ruido_saltado: number;
    total_ignorables_marcados: number;
    costo_clasificador_usd: number;
    detalle?: string;
    duracion_ms: number;
}

interface MapaEmailACliente {
    [email: string]: string; // email → cliente_id
}

async function cargarMapaClientes(): Promise<MapaEmailACliente> {
    const map: MapaEmailACliente = {};
    const { data } = await supabase.from('clientes').select('id, email').not('email', 'is', null);
    for (const c of (data ?? []) as Array<{ id: string; email: string }>) {
        map[c.email.toLowerCase()] = c.id;
    }
    return map;
}

function detectarDireccion(parsed: ParsedMail, esCarpetaEnviados: boolean): 'entrante' | 'saliente' {
    if (esCarpetaEnviados) return 'saliente';
    const from = (parsed.from?.value?.[0]?.address ?? '').toLowerCase();
    return from === emailBartez ? 'saliente' : 'entrante';
}

function contraparteEmail(parsed: ParsedMail, direccion: 'entrante' | 'saliente'): string {
    if (direccion === 'entrante') {
        return (parsed.from?.value?.[0]?.address ?? '').toLowerCase();
    }
    // Saliente: agarrar el primer destinatario del "To"
    const to = parsed.to;
    if (to && !Array.isArray(to)) {
        return (to.value?.[0]?.address ?? '').toLowerCase();
    }
    return '';
}

export async function importarHistorico(
    diasAtras = 90,
    carpetasSolicitadas?: string[],
): Promise<ResultadoImport> {
    const inicio = Date.now();
    if (!ferozoConfigurado) {
        return { ok: false, carpetas_procesadas: [], total_nuevos: 0, total_vinculados: 0, total_ruido_saltado: 0, total_ignorables_marcados: 0, costo_clasificador_usd: 0, detalle: 'Ferozo no configurado', duracion_ms: 0 };
    }

    const mapa = await cargarMapaClientes();
    const desde = new Date(Date.now() - diasAtras * 24 * 3600_000);

    const client = new ImapFlow({
        host: imapHost,
        port: imapPort,
        secure: true,
        auth: { user: emailBartez, pass: password },
        logger: false,
    });

    try {
        await client.connect();
    } catch (err) {
        return { ok: false, carpetas_procesadas: [], total_nuevos: 0, total_vinculados: 0, total_ruido_saltado: 0, total_ignorables_marcados: 0, costo_clasificador_usd: 0, detalle: `IMAP connect falló: ${(err as Error).message}`, duracion_ms: Date.now() - inicio };
    }

    // Detectar carpeta de enviados si no la especificaron
    let carpetas = carpetasSolicitadas;
    if (!carpetas || carpetas.length === 0) {
        carpetas = ['INBOX'];
        try {
            const boxes = await client.list();
            const enviados = CANDIDATOS_ENVIADOS.find((c) => boxes.some((b) => b.path === c || b.name === c));
            if (enviados) {
                const found = boxes.find((b) => b.path === enviados || b.name === enviados);
                if (found) carpetas.push(found.path);
            }
        } catch { /* seguir con INBOX solo */ }
    }

    const salida: ResultadoImport['carpetas_procesadas'] = [];
    let totalNuevos = 0;
    let totalVinculados = 0;
    let totalRuido = 0;
    let totalIgnorables = 0;
    let costoClasificador = 0;

    for (const carpeta of carpetas) {
        const esEnviados = /sent|enviad/i.test(carpeta);
        let leidos = 0, nuevos = 0, vinculados = 0, ruidoSaltado = 0, ignorablesMarcados = 0, errores = 0;

        try {
            const lock = await client.getMailboxLock(carpeta);
            try {
                const uids = await client.search({ since: desde }) as number[];
                leidos = uids.length;

                for (const uid of uids) {
                    try {
                        const msg = await client.fetchOne(uid, { source: true, envelope: true, uid: true });
                        if (!msg?.source) continue;
                        const parsed = await simpleParser(msg.source);
                        const messageId = parsed.messageId ?? `uid-${carpeta}-${uid}`;

                        // Dedupe por message_id
                        const { data: existe } = await supabase
                            .from('correos_historicos')
                            .select('id')
                            .eq('message_id', messageId)
                            .maybeSingle();
                        if (existe) continue;

                        const direccion = detectarDireccion(parsed, esEnviados);
                        const contraparte = contraparteEmail(parsed, direccion);
                        const clienteId = contraparte ? mapa[contraparte] ?? null : null;

                        const toStr = parsed.to && !Array.isArray(parsed.to) ? (parsed.to.value?.[0]?.address ?? null) : null;
                        const cuerpo = (parsed.text ?? '').slice(0, 15000);
                        const asunto = parsed.subject ?? '';
                        const deEmail = (parsed.from?.value?.[0]?.address ?? '').toLowerCase();

                        // Filtro 1 — ruido obvio por reglas (baratísimo).
                        // Solo aplica a entrantes; los salientes son de Bartez y siempre valen.
                        if (direccion === 'entrante' && esRuidoObvio(deEmail, asunto)) {
                            ruidoSaltado++;
                            continue;
                        }

                        // Filtro 2 — clasificación Haiku para entrantes que pasaron el filtro rápido.
                        // Los ignorables (spam/newsletter/informativo) se guardan igual pero
                        // marcados, así podés auditar qué llegó y por qué no se usa.
                        let categoria: string | null = null;
                        let ignorable = false;
                        if (direccion === 'entrante' && cuerpo.length > 30) {
                            try {
                                const clasif = await clasificarCorreo({ asunto, cuerpo, de: deEmail });
                                categoria = clasif.categoria;
                                ignorable = clasif.ignorable;
                                costoClasificador += clasif.costoUsd;
                                if (ignorable) ignorablesMarcados++;
                            } catch {
                                // Si el clasificador falla, guardamos sin categoría (nunca perder mails).
                            }
                        }

                        const { error: errIns } = await supabase.from('correos_historicos').insert({
                            cliente_id: clienteId,
                            direccion,
                            de_email: deEmail || null,
                            de_nombre: parsed.from?.value?.[0]?.name ?? null,
                            para_email: toStr?.toLowerCase() ?? null,
                            asunto: asunto || null,
                            cuerpo,
                            fecha: parsed.date?.toISOString() ?? new Date().toISOString(),
                            message_id: messageId,
                            carpeta,
                            categoria,
                            ignorable,
                        });
                        if (errIns) { errores++; continue; }
                        nuevos++;
                        if (clienteId) vinculados++;
                    } catch {
                        errores++;
                    }
                }
            } finally {
                lock.release();
            }
        } catch (err) {
            errores++;
            console.warn(`[import-historico] carpeta ${carpeta} falló:`, (err as Error).message);
        }

        salida.push({ carpeta, leidos, nuevos, vinculados, ruido_saltado: ruidoSaltado, ignorables_marcados: ignorablesMarcados, errores });
        totalNuevos += nuevos;
        totalVinculados += vinculados;
        totalRuido += ruidoSaltado;
        totalIgnorables += ignorablesMarcados;
    }

    try { await client.logout(); } catch { /* ignore */ }

    return {
        ok: true,
        carpetas_procesadas: salida,
        total_nuevos: totalNuevos,
        total_vinculados: totalVinculados,
        total_ruido_saltado: totalRuido,
        total_ignorables_marcados: totalIgnorables,
        costo_clasificador_usd: Number(costoClasificador.toFixed(4)),
        duracion_ms: Date.now() - inicio,
    };
}

// Devuelve últimos N correos con un cliente. Por default filtra los ignorables
// (spam, newsletter, informativos) — pasá {incluirIgnorables: true} si querés
// ver TODO (por ejemplo para auditar qué se está descartando).
export async function historicoConCliente(clienteId: string, limite = 10, opts: { incluirIgnorables?: boolean } = {}) {
    let q = supabase
        .from('correos_historicos')
        .select('direccion, de_email, para_email, asunto, cuerpo, fecha, categoria')
        .eq('cliente_id', clienteId);
    if (!opts.incluirIgnorables) q = q.or('ignorable.is.null,ignorable.eq.false');
    const { data } = await q.order('fecha', { ascending: false }).limit(limite);
    return data ?? [];
}

export async function historicoConEmail(email: string, limite = 10, opts: { incluirIgnorables?: boolean } = {}) {
    const e = email.toLowerCase();
    let q = supabase
        .from('correos_historicos')
        .select('direccion, de_email, para_email, asunto, cuerpo, fecha, categoria')
        .or(`de_email.eq.${e},para_email.eq.${e}`);
    if (!opts.incluirIgnorables) q = q.or('ignorable.is.null,ignorable.eq.false');
    const { data } = await q.order('fecha', { ascending: false }).limit(limite);
    return data ?? [];
}
