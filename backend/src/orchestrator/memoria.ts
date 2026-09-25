// Memoria por cliente: notas del operador, documentos que la IA leyó y el
// último informe. Se guarda en Supabase (cliente_notas, cliente_documentos,
// cliente_informes; los archivos en el bucket "documentos-clientes") y se suma
// al contexto de todos los asistentes cuando atienden a ese cliente
// (conMemoria / bloqueMemoria).

import type Anthropic from '@anthropic-ai/sdk';
import { anthropic, calcularCosto, idModelo } from '../connectors/anthropic.js';
import { supabase } from '../connectors/supabase.js';

export const BUCKET_DOCUMENTOS = 'documentos-clientes';
export const MAX_BYTES_DOCUMENTO = 12 * 1024 * 1024;
// Una nota puede ser una conversación de WhatsApp pegada entera. Las largas
// se resumen con IA: el resumen es lo que va en cada respuesta de los asistentes.
export const MAX_CHARS_NOTA = 60_000;
export const NOTA_LARGA = 1500;

const TZ = 'America/Argentina/Buenos_Aires';
const dia = (iso: string) => new Date(iso).toLocaleDateString('es-AR', { timeZone: TZ, day: 'numeric', month: 'numeric', year: '2-digit' });

export interface Nota { id: string; texto: string; resumen: string | null; creado_en: string }
export interface Documento {
    id: string; nombre: string; tipo_mime: string | null; tamano_bytes: number | null;
    estado: 'procesando' | 'listo' | 'error'; tipo_documento: string | null; resumen: string | null;
    error: string | null; creado_en: string; procesado_en: string | null;
}
export interface InformeGuardado {
    id: string; resumen_md: string; origen: 'manual' | 'automatico'; base_id: string | null;
    costo_usd: number | null; creado_en: string;
}

// ---------- Lectura ----------

export async function notasDeCliente(clienteId: string, limite = 30): Promise<Nota[]> {
    const { data, error } = await supabase.from('cliente_notas').select('id, texto, resumen, creado_en')
        .eq('cliente_id', clienteId).order('creado_en', { ascending: false }).limit(limite);
    if (error) throw new Error(error.message);
    return (data ?? []) as Nota[];
}

export async function documentosDeCliente(clienteId: string): Promise<Documento[]> {
    const { data, error } = await supabase.from('cliente_documentos')
        .select('id, nombre, tipo_mime, tamano_bytes, estado, tipo_documento, resumen, error, creado_en, procesado_en')
        .eq('cliente_id', clienteId).order('creado_en', { ascending: false }).limit(60);
    if (error) throw new Error(error.message);
    return (data ?? []) as Documento[];
}

export async function informesDeCliente(clienteId: string, limite = 12): Promise<InformeGuardado[]> {
    const { data, error } = await supabase.from('cliente_informes')
        .select('id, resumen_md, origen, base_id, costo_usd, creado_en')
        .eq('cliente_id', clienteId).order('creado_en', { ascending: false }).limit(limite);
    if (error) throw new Error(error.message);
    return (data ?? []).map((f) => ({ ...f, costo_usd: f.costo_usd == null ? null : Number(f.costo_usd) })) as InformeGuardado[];
}

export async function ultimoInforme(clienteId: string): Promise<InformeGuardado | null> {
    return (await informesDeCliente(clienteId, 1))[0] ?? null;
}

// Texto listo para sumar al prompt de un asistente. Vacío si no hay memoria.
export async function bloqueMemoria(clienteId: string | null | undefined, opts: { conInforme?: boolean } = {}): Promise<string> {
    if (!clienteId) return '';
    try {
        const [notas, docs, informe] = await Promise.all([
            notasDeCliente(clienteId, 15),
            documentosDeCliente(clienteId),
            opts.conInforme === false ? Promise.resolve(null) : ultimoInforme(clienteId),
        ]);
        const listos = docs.filter((d) => d.estado === 'listo' && d.resumen);
        if (!notas.length && !listos.length && !informe) return '';
        const partes: string[] = ['---\nMEMORIA DE ESTE CLIENTE (lo que Bartez ya sabe; usala y no la contradigas):'];
        if (informe) partes.push(`Último informe (${dia(informe.creado_en)}):\n${informe.resumen_md.slice(0, 2200)}`);
        if (notas.length) {
            partes.push('Notas de Andrés (verdad aportada por el operador, más nuevas primero):\n' +
                // Las más nuevas van completas (o su resumen); las viejas, recortadas.
                notas.map((n, i) => `- [${dia(n.creado_en)}] ${textoDeNota(n, i < 6 ? NOTA_LARGA : 300)}`).join('\n'));
        }
        if (listos.length) {
            partes.push('Documentos del cliente (resúmenes):\n' + listos.slice(0, 12).map((d) =>
                `- [${dia(d.creado_en)}] ${d.nombre}${d.tipo_documento ? ` (${d.tipo_documento})` : ''}: ${(d.resumen ?? '').replace(/\n+/g, ' ').slice(0, 600)}`,
            ).join('\n'));
        }
        return partes.join('\n\n');
    } catch (err) {
        // La memoria suma, pero nunca debe frenar una respuesta.
        console.warn('[memoria] no se pudo leer:', (err as Error).message);
        return '';
    }
}

export async function conMemoria(system: string, clienteId: string | null | undefined): Promise<string> {
    const b = await bloqueMemoria(clienteId);
    return b ? `${system}\n\n${b}` : system;
}

// ---------- Notas ----------

export async function crearNota(clienteId: string, texto: string): Promise<Nota> {
    const limpio = texto.trim();
    if (!limpio) throw new Error('La nota está vacía');
    if (limpio.length > MAX_CHARS_NOTA) {
        throw new Error(`La nota tiene ${limpio.length.toLocaleString('es-AR')} caracteres y el máximo es ${MAX_CHARS_NOTA.toLocaleString('es-AR')}. Si es más larga, guardala en un .txt y subila como documento.`);
    }
    const { data, error } = await supabase.from('cliente_notas').insert({ cliente_id: clienteId, texto: limpio })
        .select('id, texto, resumen, creado_en').single();
    if (error) throw new Error(error.message);
    const nota = data as Nota;
    if (limpio.length > NOTA_LARGA) {
        // El resumen tarda unos segundos: se hace en segundo plano y el panel consulta.
        void resumirNota(nota.id, limpio, clienteId).catch((err) => console.warn('[memoria] resumir nota', nota.id, (err as Error).message));
    }
    return nota;
}

// Lo que ven los asistentes de una nota: el resumen si es larga, si no el texto.
export function textoDeNota(n: Pick<Nota, 'texto' | 'resumen'>, max: number): string {
    const base = n.resumen?.trim() || n.texto;
    const plano = base.replace(/\s+/g, ' ').trim();
    const limite = n.resumen ? Math.max(max, 1400) : max;
    return plano.length > limite ? `${plano.slice(0, limite)}… (recortada)` : plano;
}

const PROMPT_NOTA = `Sos el archivista de Bartez Tecnología (mayorista de informática en Rosario).
Andrés pegó en la ficha de un cliente un texto largo: casi siempre una conversación
de WhatsApp o de correo, o apuntes de una llamada. Dejá un resumen que después usan
los asistentes (correo, WhatsApp, seguimientos, informes) para no preguntar de nuevo
lo que ya se habló.

Respondé en markdown corto (máximo 15 líneas, viñetas), solo con datos del texto:
- Quién es quién (nombre, empresa, teléfono si aparece).
- Qué pide o qué se cotizó: productos con modelo, especificaciones, cantidades.
- Precios, moneda, condiciones (pago, entrega, validez) si se mencionan.
- Qué quedó acordado, qué quedó pendiente y de quién es el próximo paso, con fechas.
- Si no está claro, no lo inventes.`;

async function resumirNota(id: string, texto: string, clienteId: string): Promise<void> {
    const { data: cliente } = await supabase.from('clientes').select('nombre').eq('id', clienteId).maybeSingle();
    const modelo = 'sonnet' as const;
    const r = await anthropic.messages.create({
        model: idModelo(modelo),
        max_tokens: 1200,
        system: PROMPT_NOTA,
        messages: [{ role: 'user', content: `Cliente: ${cliente?.nombre ?? 'sin nombre'}\n\n<texto>\n${texto}\n</texto>` }],
    });
    const resumen = r.content.map((c) => (c.type === 'text' ? c.text : '')).join('').trim();
    if (!resumen) return;
    await supabase.from('cliente_notas').update({
        resumen: resumen.slice(0, 4000), costo_usd: calcularCosto(modelo, r.usage.input_tokens, r.usage.output_tokens),
    }).eq('id', id);
}

export async function borrarNota(id: string): Promise<void> {
    const { error } = await supabase.from('cliente_notas').delete().eq('id', id);
    if (error) throw new Error(error.message);
}

// ---------- Documentos ----------

const TIPOS: Record<string, 'pdf' | 'imagen' | 'excel' | 'word' | 'texto'> = {
    'application/pdf': 'pdf',
    'image/jpeg': 'imagen', 'image/png': 'imagen', 'image/webp': 'imagen', 'image/gif': 'imagen',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'excel',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'word',
    'text/plain': 'texto', 'text/csv': 'texto', 'text/markdown': 'texto',
};
// Algunos navegadores mandan el tipo vacío: se deduce por la extensión.
const POR_EXTENSION: Record<string, string> = {
    pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    txt: 'text/plain', csv: 'text/csv', md: 'text/markdown',
};

export function tipoDeArchivo(nombre: string, mime: string | undefined): string | null {
    if (mime && TIPOS[mime]) return mime;
    const ext = nombre.toLowerCase().split('.').pop() ?? '';
    return POR_EXTENSION[ext] ?? null;
}

// Un bloque del contenido de un mensaje del usuario (texto, imagen, etc.).
type BloqueUsuario = Exclude<Anthropic.MessageParam['content'], string>[number];

const slug = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 80);

export async function subirDocumento(clienteId: string, nombre: string, mime: string | undefined, datosBase64: string): Promise<Documento> {
    const tipo = tipoDeArchivo(nombre, mime);
    if (!tipo) throw new Error('Formato no soportado. Subí PDF, foto (JPG/PNG), Excel (.xlsx), Word (.docx) o texto/CSV. Los .xls y .doc viejos guardalos como .xlsx/.docx o PDF.');
    const buffer = Buffer.from(datosBase64, 'base64');
    if (!buffer.length) throw new Error('El archivo está vacío');
    if (buffer.length > MAX_BYTES_DOCUMENTO) throw new Error(`El archivo pesa más de ${MAX_BYTES_DOCUMENTO / 1024 / 1024} MB`);

    const { data: cliente } = await supabase.from('clientes').select('id').eq('id', clienteId).maybeSingle();
    if (!cliente) throw new Error('Cliente no encontrado');

    const ruta = `${clienteId}/${Date.now()}-${slug(nombre)}`;
    const subida = await supabase.storage.from(BUCKET_DOCUMENTOS).upload(ruta, buffer, { contentType: tipo, upsert: false });
    if (subida.error) throw new Error(`No se pudo guardar el archivo: ${subida.error.message}`);

    const { data, error } = await supabase.from('cliente_documentos').insert({
        cliente_id: clienteId, nombre: nombre.slice(0, 200), tipo_mime: tipo, tamano_bytes: buffer.length, ruta, estado: 'procesando',
    }).select('id, nombre, tipo_mime, tamano_bytes, estado, tipo_documento, resumen, error, creado_en, procesado_en').single();
    if (error) throw new Error(error.message);

    // La lectura con IA tarda unos segundos: se hace en segundo plano y el
    // panel consulta el estado.
    void procesarDocumento(data.id as string, buffer).catch((err) => console.warn('[memoria] documento', data.id, (err as Error).message));
    return data as Documento;
}

// Pasa el archivo a algo que Claude pueda leer: PDF e imágenes van tal cual;
// Excel, Word y texto se convierten a texto.
export async function contenidoParaClaude(buffer: Buffer, mime: string): Promise<BloqueUsuario[]> {
    const tipo = TIPOS[mime];
    if (tipo === 'pdf') {
        // El SDK instalado no tiene el tipo "document" en su TypeScript, pero la
        // API recibe PDFs así (base64, sin cabecera beta).
        return [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') } } as unknown as BloqueUsuario];
    }
    if (tipo === 'imagen') {
        return [{ type: 'image', source: { type: 'base64', media_type: mime as 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif', data: buffer.toString('base64') } }];
    }
    let texto = '';
    if (tipo === 'excel') {
        const ExcelJS = (await import('exceljs')).default;
        const libro = new ExcelJS.Workbook();
        await libro.xlsx.load(buffer as unknown as ArrayBuffer);
        const hojas: string[] = [];
        libro.eachSheet((hoja) => {
            const filas: string[] = [];
            hoja.eachRow({ includeEmpty: false }, (fila) => {
                const valores = (fila.values as unknown[]).slice(1).map((c) => {
                    if (c == null) return '';
                    if (typeof c === 'object') {
                        const o = c as { result?: unknown; text?: unknown; richText?: Array<{ text: string }> };
                        if (o.result != null) return String(o.result);
                        if (o.text != null) return String(o.text);
                        if (o.richText) return o.richText.map((r) => r.text).join('');
                        if (c instanceof Date) return c.toISOString().slice(0, 10);
                    }
                    return String(c);
                });
                filas.push(valores.join(' | '));
            });
            hojas.push(`## Hoja: ${hoja.name}\n${filas.join('\n')}`);
        });
        texto = hojas.join('\n\n');
    } else if (tipo === 'word') {
        const mammoth = await import('mammoth');
        texto = (await mammoth.extractRawText({ buffer })).value;
    } else {
        texto = buffer.toString('utf8');
    }
    if (!texto.trim()) throw new Error('El archivo no tiene texto legible');
    // Tope para no mandar planillas gigantes enteras; se avisa en el texto.
    const MAX = 120_000;
    const recorte = texto.length > MAX ? `${texto.slice(0, MAX)}\n\n[… el archivo sigue; se leyeron los primeros ${MAX.toLocaleString('es-AR')} caracteres]` : texto;
    return [{ type: 'text', text: `Contenido del archivo:\n\n${recorte}` }];
}

const PROMPT_DOCUMENTO = `Sos el archivista de Bartez Tecnología (mayorista de informática en Rosario).
Te pasan un documento que Andrés subió a la ficha de un cliente. Tu trabajo es dejar
un resumen que después usan los asistentes (correo, WhatsApp, seguimientos, informes).

Respondé SOLO con un JSON válido, sin texto antes ni después:
{"tipo_documento": "...", "resumen": "..."}

- tipo_documento: 2 a 4 palabras (ej. "Presupuesto de competencia", "Orden de compra",
  "Pliego de licitación", "Lista de precios", "Factura", "Nota de pedido", "Foto de equipo").
- resumen: markdown corto (máximo 12 líneas) con lo que sirve para vender y hacer
  seguimiento: quién lo emite y para quién, fecha, número si tiene, productos con
  cantidades y precios, total y moneda, condiciones (pago, entrega, validez),
  plazos y cualquier compromiso o pedido concreto. Solo datos que estén en el
  documento; si algo no está, no lo inventes.`;

export async function procesarDocumento(id: string, bufferDado?: Buffer): Promise<void> {
    const { data: doc } = await supabase.from('cliente_documentos').select('id, nombre, tipo_mime, ruta, cliente_id').eq('id', id).maybeSingle();
    if (!doc) return;
    const falla = async (msg: string) => {
        await supabase.from('cliente_documentos').update({ estado: 'error', error: msg.slice(0, 500), procesado_en: new Date().toISOString() }).eq('id', id);
    };
    try {
        let buffer = bufferDado;
        if (!buffer) {
            const bajada = await supabase.storage.from(BUCKET_DOCUMENTOS).download(doc.ruta as string);
            if (bajada.error || !bajada.data) throw new Error(`No se pudo leer el archivo guardado: ${bajada.error?.message ?? 'vacío'}`);
            buffer = Buffer.from(await bajada.data.arrayBuffer());
        }
        await supabase.from('cliente_documentos').update({ estado: 'procesando', error: null }).eq('id', id);
        const { data: cliente } = await supabase.from('clientes').select('nombre').eq('id', doc.cliente_id).maybeSingle();
        const contenido = await contenidoParaClaude(buffer, doc.tipo_mime as string);
        const modelo = 'sonnet' as const;
        const r = await anthropic.messages.create({
            model: idModelo(modelo),
            max_tokens: 1500,
            system: PROMPT_DOCUMENTO,
            messages: [{ role: 'user', content: [...contenido, { type: 'text', text: `Cliente: ${cliente?.nombre ?? 'sin nombre'}\nArchivo: ${doc.nombre}\n\nDevolvé el JSON.` }] }],
        });
        const salida = r.content.map((c) => (c.type === 'text' ? c.text : '')).join('').trim();
        const json = salida.match(/\{[\s\S]*\}/)?.[0];
        let tipoDoc: string | null = null, resumen = '';
        try {
            const p = JSON.parse(json ?? '') as { tipo_documento?: string; resumen?: string };
            tipoDoc = p.tipo_documento?.trim().slice(0, 60) || null;
            resumen = p.resumen?.trim() ?? '';
        } catch {
            resumen = salida; // si no vino JSON, el texto igual sirve como resumen
        }
        if (!resumen) throw new Error('La IA no devolvió un resumen');
        await supabase.from('cliente_documentos').update({
            estado: 'listo', tipo_documento: tipoDoc, resumen: resumen.slice(0, 4000), error: null,
            costo_usd: calcularCosto(modelo, r.usage.input_tokens, r.usage.output_tokens), procesado_en: new Date().toISOString(),
        }).eq('id', id);
    } catch (err) {
        await falla((err as Error).message);
    }
}

// Vuelve a leer un documento (p. ej. si falló). Queda en "procesando" ya, para
// que el panel lo muestre así mientras la IA trabaja.
export async function reprocesarDocumento(id: string): Promise<void> {
    const { error } = await supabase.from('cliente_documentos').update({ estado: 'procesando', error: null }).eq('id', id);
    if (error) throw new Error(error.message);
    void procesarDocumento(id).catch((err) => console.warn('[memoria] reprocesar', id, (err as Error).message));
}

export async function borrarDocumento(id: string): Promise<void> {
    const { data: doc } = await supabase.from('cliente_documentos').select('ruta').eq('id', id).maybeSingle();
    if (!doc) return;
    await supabase.storage.from(BUCKET_DOCUMENTOS).remove([doc.ruta as string]);
    const { error } = await supabase.from('cliente_documentos').delete().eq('id', id);
    if (error) throw new Error(error.message);
}

// Link temporal (10 minutos) para abrir el archivo desde el panel: PDF, fotos y
// texto se ven en el navegador; Excel y Word se descargan con su nombre.
export async function urlDocumento(id: string): Promise<string> {
    const { data: doc } = await supabase.from('cliente_documentos').select('ruta, nombre, tipo_mime').eq('id', id).maybeSingle();
    if (!doc) throw new Error('Documento no encontrado');
    const mime = String(doc.tipo_mime ?? '');
    const seVe = mime === 'application/pdf' || mime.startsWith('image/') || mime.startsWith('text/');
    const { data, error } = await supabase.storage.from(BUCKET_DOCUMENTOS).createSignedUrl(doc.ruta as string, 600, seVe ? undefined : { download: doc.nombre as string });
    if (error || !data) throw new Error(error?.message ?? 'No se pudo generar el link');
    return data.signedUrl;
}
