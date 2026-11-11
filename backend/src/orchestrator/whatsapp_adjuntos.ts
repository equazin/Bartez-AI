// Archivos por WhatsApp: presupuestos del Cotizador, documentos de la ficha del
// cliente y archivos que se suben desde la compu.
//
// Cada archivo que sale queda guardado (bucket whatsapp-adjuntos) para volver
// a abrirlo desde el chat. Si la web ya manda archivos (POST .../media) sale
// como adjunto de WhatsApp; si todavía no, sale un mensaje con un link propio
// (/d/<token>) para abrirlo. Las dos formas quedan en el chat de bartez.com.ar.

import { randomBytes } from 'node:crypto';
import { supabase } from '../connectors/supabase.js';
import { enviarAdjuntoStudio, esSinRuta } from '../connectors/studio.js';
import { generarPresupuestoPdf } from '../pdf/presupuesto.js';
import { obtenerCotizacion, numeroPresupuesto } from './cotizador.js';
import { BUCKET_DOCUMENTOS } from './memoria.js';
import { dentroDeVentana, enviarWhatsapp, registrarSalienteWa } from './whatsapp.js';

export const BUCKET_ADJUNTOS = 'whatsapp-adjuntos';
export const MAX_BYTES_ADJUNTO = 15 * 1024 * 1024;
const MAX_BYTES_IMAGEN = 5 * 1024 * 1024;   // WhatsApp no acepta fotos más pesadas
export const MAX_TEXTO_ADJUNTO = 1024;      // lo que puede acompañar a un archivo
const VIGENCIA_LINK_DIAS = 120;

// Lo que WhatsApp deja mandar: documentos y fotos JPG/PNG.
const TIPOS: Record<string, string> = {
    pdf: 'application/pdf',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    txt: 'text/plain',
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
};
const MIMES = new Set(Object.values(TIPOS));
export const NO_SE_PUEDE = 'WhatsApp no deja mandar ese tipo de archivo. Mandá PDF, Word, Excel, PowerPoint, texto o una foto JPG/PNG.';

export function tipoAdjunto(nombre: string, mime?: string | null): string | null {
    if (mime && MIMES.has(mime)) return mime;
    const ext = nombre.toLowerCase().split('.').pop() ?? '';
    return TIPOS[ext] ?? null;
}

export const esImagen = (mime: string) => mime.startsWith('image/');

export type OrigenAdjunto =
    | { tipo: 'cotizacion'; id: string }
    | { tipo: 'documento'; id: string }
    | { tipo: 'archivo'; nombre: string; mime?: string; base64: string };

interface Archivo {
    nombre: string;
    mime: string;
    contenido: Buffer;
    origen: 'cotizacion' | 'documento' | 'archivo';
    origen_id: string | null;
    // Si sale mal el envío, el presupuesto vuelve a borrador.
    revertir?: () => Promise<void>;
}

const slug = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 80);

function validar(nombre: string, mime: string | null, bytes: number): string {
    const tipo = tipoAdjunto(nombre, mime);
    if (!tipo) throw new Error(NO_SE_PUEDE);
    if (!bytes) throw new Error('El archivo está vacío');
    const max = esImagen(tipo) ? MAX_BYTES_IMAGEN : MAX_BYTES_ADJUNTO;
    if (bytes > max) throw new Error(`WhatsApp acepta ${esImagen(tipo) ? 'fotos' : 'archivos'} de hasta ${max / 1024 / 1024} MB`);
    return tipo;
}

async function documentoDeFicha(id: string): Promise<Archivo> {
    const { data: doc } = await supabase.from('cliente_documentos').select('id, nombre, tipo_mime, ruta').eq('id', id).maybeSingle();
    if (!doc) throw new Error('Ese documento ya no está en la ficha del cliente');
    const bajada = await supabase.storage.from(BUCKET_DOCUMENTOS).download(doc.ruta as string);
    if (bajada.error || !bajada.data) throw new Error(`No se pudo leer el documento: ${bajada.error?.message ?? 'vacío'}`);
    const contenido = Buffer.from(await bajada.data.arrayBuffer());
    const nombre = String(doc.nombre);
    return { nombre, mime: validar(nombre, doc.tipo_mime as string | null, contenido.length), contenido, origen: 'documento', origen_id: id };
}

async function armarArchivo(o: OrigenAdjunto): Promise<Archivo> {
    if (o.tipo === 'archivo') {
        const contenido = Buffer.from(o.base64, 'base64');
        const nombre = o.nombre.trim().slice(0, 200) || 'archivo';
        return { nombre, mime: validar(nombre, o.mime ?? null, contenido.length), contenido, origen: 'archivo', origen_id: null };
    }
    if (o.tipo === 'documento') return documentoDeFicha(o.id);

    const q = await obtenerCotizacion(o.id);
    if (!q) throw new Error('Ese presupuesto ya no existe');
    // Presupuesto que vino de un documento de la ficha: el presupuesto es ese archivo.
    if (q.origen === 'documento') {
        if (!q.documento) throw new Error('No encontré el archivo original de ese presupuesto');
        return { ...(await documentoDeFicha(q.documento.id)), origen: 'cotizacion', origen_id: o.id };
    }
    if (!q.lineas.some((l) => l.elegido)) throw new Error('El presupuesto no tiene artículos');
    const estabaAbierta = q.estado === 'abierta';
    // Mismo criterio que el correo: el número definitivo se asigna al mandarlo.
    const numero = await numeroPresupuesto(o.id);
    const { pdf, archivo } = generarPresupuestoPdf(q, numero);
    return {
        nombre: archivo, mime: 'application/pdf', contenido: pdf, origen: 'cotizacion', origen_id: o.id,
        revertir: estabaAbierta
            ? async () => { await supabase.from('cotizaciones').update({ estado: 'abierta', enviada_en: null }).eq('id', o.id).eq('estado', 'enviada'); }
            : undefined,
    };
}

// ¿La web ya manda archivos? Se recuerda un rato para no probar en cada envío.
let mediaEnLaWeb: { valor: boolean; hasta: number } | null = null;
export const estadoMediaWeb = (): 'si' | 'no' | 'sin_probar' =>
    !mediaEnLaWeb || mediaEnLaWeb.hasta < Date.now() ? 'sin_probar' : mediaEnLaWeb.valor ? 'si' : 'no';

export interface MensajeSaliente {
    id: string;
    cuerpo: string;
    origen: 'humano';
    creado_en: string;
    tipo: string;
    adjunto: { id: string; nombre: string; mime: string; como: 'adjunto' | 'link'; texto: string | null } | null;
}

export interface ResultadoAdjunto {
    ok: boolean;
    detalle?: string;
    como?: 'adjunto' | 'link';
    mensajes?: MensajeSaliente[];
}

export function textoConLink(texto: string, nombre: string, link: string): string {
    const t = texto.trim();
    return `${t ? `${t}\n\n` : ''}📄 ${nombre}\n${link}`;
}

// La web contestó con un error: el mensaje seguro no salió. (Si se cortó la
// conexión o tardó demasiado, puede haber salido: no se borra nada.)
const noSalio = (err: unknown) => Boolean((err as { http?: boolean } | null)?.http);

// Manda el archivo a la conversación. `baseUrl`: dirección pública del backend
// (para el link, si la web todavía no manda archivos).
export async function enviarAdjuntoWhatsapp(
    waId: string,
    origen: OrigenAdjunto,
    texto: string,
    baseUrl: string,
): Promise<ResultadoAdjunto> {
    const { data: conv } = await supabase.from('wa_conversaciones').select('cliente_id, ultimo_entrante_en').eq('wa_id', waId).maybeSingle();
    if (!conv) return { ok: false, detalle: 'Conversación no encontrada (sincronizá primero)' };
    if (!dentroDeVentana(conv.ultimo_entrante_en as string | null)) {
        return { ok: false, detalle: 'Pasaron más de 24 h desde el último mensaje del cliente: WhatsApp no deja mandarle archivos hasta que vuelva a escribir. Retomá con una plantilla.' };
    }
    const clienteId = (conv.cliente_id as string | null) ?? null;

    let archivo: Archivo;
    try { archivo = await armarArchivo(origen); }
    catch (err) { return { ok: false, detalle: (err as Error).message }; }

    const ruta = `${waId}/${Date.now()}-${slug(archivo.nombre)}`;
    const subida = await supabase.storage.from(BUCKET_ADJUNTOS).upload(ruta, archivo.contenido, { contentType: archivo.mime, upsert: false });
    if (subida.error) {
        await archivo.revertir?.();
        return { ok: false, detalle: `No se pudo guardar el archivo: ${subida.error.message}` };
    }
    const token = randomBytes(18).toString('base64url');
    const { data: fila, error } = await supabase.from('wa_adjuntos').insert({
        wa_id: waId, token, nombre: archivo.nombre, tipo_mime: archivo.mime, tamano_bytes: archivo.contenido.length,
        ruta, origen: archivo.origen, origen_id: archivo.origen_id, texto: texto.trim() || null,
        vence_en: new Date(Date.now() + VIGENCIA_LINK_DIAS * 86400_000).toISOString(),
    }).select('id').single();
    if (error || !fila) {
        await supabase.storage.from(BUCKET_ADJUNTOS).remove([ruta]);
        await archivo.revertir?.();
        return { ok: false, detalle: `No se pudo guardar el archivo: ${error?.message ?? 'sin respuesta'}` };
    }
    const adjuntoId = fila.id as string;
    const deshacer = async () => {
        await supabase.from('wa_adjuntos').delete().eq('id', adjuntoId);
        await supabase.storage.from(BUCKET_ADJUNTOS).remove([ruta]);
        await archivo.revertir?.();
    };
    const fallo = async (err: unknown): Promise<ResultadoAdjunto> => {
        if (noSalio(err)) await deshacer();
        return { ok: false, detalle: (err as Error).message };
    };

    const t = texto.trim();
    // Un archivo lleva hasta 1024 caracteres de texto; si es más, va aparte.
    const leyenda = t.length <= MAX_TEXTO_ADJUNTO ? t : '';
    const info = { id: adjuntoId, nombre: archivo.nombre, mime: archivo.mime, texto: t || null };
    const mensajes: MensajeSaliente[] = [];
    let como: 'adjunto' | 'link' = 'link';
    let aviso: string | undefined;

    let enviado: Awaited<ReturnType<typeof enviarAdjuntoStudio>> | null = null;
    if (estadoMediaWeb() !== 'no') {
        try {
            const firmado = await supabase.storage.from(BUCKET_ADJUNTOS).createSignedUrl(ruta, 15 * 60);
            if (firmado.error || !firmado.data) {
                await deshacer();
                return { ok: false, detalle: `No se pudo preparar el archivo: ${firmado.error?.message ?? 'sin link'}` };
            }
            enviado = await enviarAdjuntoStudio(waId, { url: firmado.data.signedUrl, nombre: archivo.nombre, mime: archivo.mime, texto: leyenda });
            mediaEnLaWeb = { valor: true, hasta: Date.now() + 3600_000 };
        } catch (err) {
            if (!esSinRuta(err)) return fallo(err);
            mediaEnLaWeb = { valor: false, hasta: Date.now() + 10 * 60_000 };
        }
    }

    if (enviado) {
        // Salió como adjunto de WhatsApp.
        como = 'adjunto';
        const cuerpo = `📎 ${archivo.nombre}${leyenda ? `\n${leyenda}` : ''}`;
        const tipo = esImagen(archivo.mime) ? 'image' : 'document';
        await registrarSalienteWa(waId, enviado, cuerpo, tipo, clienteId);
        await supabase.from('wa_adjuntos').update({ mensaje_id: enviado.id, enviado_como: 'adjunto', texto: leyenda || null }).eq('id', adjuntoId);
        mensajes.push({ id: enviado.id, cuerpo, origen: 'humano', creado_en: enviado.createdAt ?? new Date().toISOString(), tipo, adjunto: { ...info, texto: leyenda || null, como } });
        if (t && !leyenda) {
            try {
                const r = await enviarWhatsapp(waId, t, clienteId);
                if (r.ok && r.id) mensajes.push({ id: r.id, cuerpo: t, origen: 'humano', creado_en: new Date().toISOString(), tipo: 'text', adjunto: null });
                else aviso = `El archivo salió, pero el texto no: ${r.detalle ?? 'error'}`;
            } catch (err) { aviso = `El archivo salió, pero el texto no: ${(err as Error).message}`; }
        }
    } else {
        // La web todavía no manda archivos: sale el link para abrirlo.
        const cuerpo = textoConLink(t, archivo.nombre, `${baseUrl.replace(/\/+$/, '')}/d/${token}`);
        let r: Awaited<ReturnType<typeof enviarWhatsapp>>;
        try { r = await enviarWhatsapp(waId, cuerpo, clienteId); }
        catch (err) { return fallo(err); }
        if (!r.ok || !r.id) { await deshacer(); return { ok: false, detalle: r.detalle ?? 'No se pudo enviar' }; }
        await supabase.from('wa_adjuntos').update({ mensaje_id: r.id, enviado_como: 'link' }).eq('id', adjuntoId);
        mensajes.push({ id: r.id, cuerpo, origen: 'humano', creado_en: new Date().toISOString(), tipo: 'text', adjunto: { ...info, como } });
    }

    // Presupuesto mandado a un cliente: queda vinculado si no tenía cliente.
    if (archivo.origen === 'cotizacion' && archivo.origen_id && clienteId) {
        await supabase.from('cotizaciones').update({ cliente_id: clienteId }).eq('id', archivo.origen_id).is('cliente_id', null);
    }
    return { ok: true, como, mensajes, detalle: aviso };
}

// ---------- Para elegir qué mandar ----------

export async function opcionesAdjuntoWa(waId: string) {
    const { data: conv } = await supabase.from('wa_conversaciones').select('cliente_id, clientes(nombre)').eq('wa_id', waId).maybeSingle();
    if (!conv) return null;
    const clienteId = (conv.cliente_id as string | null) ?? null;
    const campos = 'id, titulo, pedido, numero, numero_externo, estado, total_usd, total_ars, creado_en, origen, cliente_id';
    const delCliente = clienteId
        ? (await supabase.from('cotizaciones').select(campos).eq('cliente_id', clienteId).order('creado_en', { ascending: false }).limit(15)).data ?? []
        : [];
    // También los recientes sin cliente (se armó el presupuesto sin vincularlo).
    const desde = new Date(Date.now() - 60 * 86400_000).toISOString();
    const sueltos = (await supabase.from('cotizaciones').select(campos).is('cliente_id', null).gte('creado_en', desde)
        .order('creado_en', { ascending: false }).limit(15)).data ?? [];
    const presupuesto = (f: Record<string, unknown>, propio: boolean) => ({
        id: f.id as string,
        titulo: ((f.titulo as string | null) ?? (f.pedido as string | null) ?? '').slice(0, 120),
        numero: (f.numero as number | null) ?? null,
        numero_externo: (f.numero_externo as string | null) ?? null,
        estado: (f.estado as string | null) ?? 'abierta',
        total_usd: Number(f.total_usd ?? 0),
        total_ars: Number(f.total_ars ?? 0),
        creado_en: f.creado_en as string,
        de_documento: f.origen === 'documento',
        del_cliente: propio,
    });
    const documentos = clienteId
        ? ((await supabase.from('cliente_documentos').select('id, nombre, tipo_mime, tamano_bytes, creado_en, cotizacion_id')
            .eq('cliente_id', clienteId).order('creado_en', { ascending: false }).limit(20)).data ?? [])
        : [];
    return {
        cliente_id: clienteId,
        cliente_nombre: ((conv as { clientes?: { nombre?: string } | null }).clientes?.nombre) ?? null,
        presupuestos: [...delCliente.map((f) => presupuesto(f, true)), ...sueltos.map((f) => presupuesto(f, false))],
        documentos: documentos.map((d) => ({
            id: d.id as string,
            nombre: d.nombre as string,
            tipo_mime: (d.tipo_mime as string | null) ?? null,
            tamano_bytes: Number(d.tamano_bytes ?? 0),
            creado_en: d.creado_en as string,
            se_puede: !!tipoAdjunto(String(d.nombre), d.tipo_mime as string | null),
        })),
        media_en_la_web: estadoMediaWeb(),
    };
}

// ---------- Para abrir lo que se mandó ----------

// El link que recibe el cliente (mientras la web no mande archivos).
export async function archivoPorToken(token: string): Promise<{ nombre: string; mime: string; contenido: Buffer } | null> {
    if (!/^[A-Za-z0-9_-]{20,40}$/.test(token)) return null;
    const { data: a } = await supabase.from('wa_adjuntos').select('nombre, tipo_mime, ruta, vence_en').eq('token', token).maybeSingle();
    if (!a || new Date(a.vence_en as string).getTime() < Date.now()) return null;
    const bajada = await supabase.storage.from(BUCKET_ADJUNTOS).download(a.ruta as string);
    if (bajada.error || !bajada.data) return null;
    return { nombre: a.nombre as string, mime: a.tipo_mime as string, contenido: Buffer.from(await bajada.data.arrayBuffer()) };
}

// Link temporal (10 minutos) para abrirlo desde el panel.
export async function urlAdjuntoWa(id: string): Promise<string> {
    const { data: a } = await supabase.from('wa_adjuntos').select('nombre, tipo_mime, ruta').eq('id', id).maybeSingle();
    if (!a) throw new Error('Archivo no encontrado');
    const mime = String(a.tipo_mime ?? '');
    const seVe = mime === 'application/pdf' || mime.startsWith('image/') || mime.startsWith('text/');
    const { data, error } = await supabase.storage.from(BUCKET_ADJUNTOS).createSignedUrl(a.ruta as string, 600, seVe ? undefined : { download: a.nombre as string });
    if (error || !data) throw new Error(error?.message ?? 'No se pudo generar el link');
    return data.signedUrl;
}
