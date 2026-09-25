// Memoria por cliente: notas del operador, documentos que la IA leyó y el
// último informe. Se guarda en Supabase (cliente_notas, cliente_documentos,
// cliente_informes; los archivos en el bucket "documentos-clientes") y se suma
// al contexto de todos los asistentes cuando atienden a ese cliente
// (conMemoria / bloqueMemoria).

import type Anthropic from '@anthropic-ai/sdk';
import { anthropic, calcularCosto, idModelo } from '../connectors/anthropic.js';
import { supabase } from '../connectors/supabase.js';
import {
    DatosDocumento, TotalManual, VERSION_DATOS, aplicarTotalManual, necesitaRelectura, normalizarPresupuesto,
    soltarCotizacion, sincronizarPresupuestoDeDocumento,
} from './presupuestos_documentos.js';

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
    // Si es un presupuesto: lo que se leyó, si cuenta en Cotizado y su cotización.
    datos: DatosDocumento | null; sin_cotizado: boolean; cotizacion_id: string | null;
    cotizacion: { id: string; total_usd: number | null; estado: string; origen: string; numero: number | null; numero_externo: string | null } | null;
}
const CAMPOS_DOC = 'id, nombre, tipo_mime, tamano_bytes, estado, tipo_documento, resumen, error, creado_en, procesado_en, datos, sin_cotizado, cotizacion_id, '
    + 'cotizacion:cotizaciones(id, total_usd, estado, origen, numero, numero_externo)';
const aDocumento = (f: Record<string, unknown>): Documento => {
    const q = f.cotizacion as Documento['cotizacion'] | Documento['cotizacion'][] | null;
    const cot = Array.isArray(q) ? q[0] ?? null : q;
    return { ...(f as unknown as Documento), cotizacion: cot ? { ...cot, total_usd: cot.total_usd == null ? null : Number(cot.total_usd) } : null };
};
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
    const { data, error } = await supabase.from('cliente_documentos').select(CAMPOS_DOC)
        .eq('cliente_id', clienteId).order('creado_en', { ascending: false }).limit(60);
    if (error) throw new Error(error.message);
    return ((data ?? []) as unknown as Record<string, unknown>[]).map(aDocumento);
}

export async function documento(id: string): Promise<Documento | null> {
    const { data, error } = await supabase.from('cliente_documentos').select(CAMPOS_DOC).eq('id', id).maybeSingle();
    if (error) throw new Error(error.message);
    return data ? aDocumento(data as unknown as Record<string, unknown>) : null;
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
    }).select(CAMPOS_DOC).single();
    if (error) throw new Error(error.message);

    // La lectura con IA tarda unos segundos: se hace en segundo plano y el
    // panel consulta el estado.
    const doc = aDocumento(data as unknown as Record<string, unknown>);
    void procesarDocumento(doc.id, buffer).catch((err) => console.warn('[memoria] documento', doc.id, (err as Error).message));
    return doc;
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
{"tipo_documento": "...", "resumen": "...", "presupuesto": null}

- tipo_documento: 2 a 4 palabras (ej. "Presupuesto de Bartez", "Presupuesto de competencia",
  "Lista de componentes", "Orden de compra", "Pliego de licitación", "Factura", "Foto de equipo").
- resumen: markdown corto (máximo 12 líneas) con lo que sirve para vender y hacer
  seguimiento: quién lo emite y para quién, fecha, número si tiene, productos con
  cantidades y precios, total y moneda, condiciones (pago, entrega, validez),
  plazos y cualquier compromiso o pedido concreto. Solo datos que estén en el
  documento; si algo no está, no lo inventes.
- presupuesto: va siempre que el documento le ofrezca productos o servicios CON PRECIOS
  a este cliente, aunque sea informal: un presupuesto o cotización en PDF, una lista de
  componentes o de un armado con su total, una foto o captura de pantalla de un
  presupuesto (de WhatsApp, de un correo, de una pantalla), una planilla con precios,
  algo escrito a mano. No hace falta membrete, número ni fecha. Va null solo si no hay
  precios (una foto de un equipo, un pliego, un pedido del cliente sin precios) o si es
  otra cosa: factura, orden de compra, remito, o la lista de precios general o el
  catálogo de un proveedor. Si es un presupuesto:
  {
    "emisor": "bartez" si lo emite Bartez Tecnología (su nombre o logo, un correo @bartez.com.ar, Andrés Benítez);
              "otro" solo si se ve que lo emite otra empresa (su membrete o su nombre como emisor, o va dirigido a Bartez: es de un proveedor);
              "desconocido" si no dice quién lo emite (una lista suelta, una foto, una captura),
    "emisor_nombre": "nombre de quien lo emite" o null,
    "para": "empresa o persona a la que va dirigido" o null,
    "numero": "número tal como figura (ej. \"2026-0215\")" o null,
    "fecha": "AAAA-MM-DD" o null,
    "objeto": "qué se cotiza, en una línea (ej. \"Servidor Dell R7715 para IA\", \"PC Ryzen 5 con RTX 4060\")",
    "moneda": "USD" o "ARS" (si el signo es ambiguo, deducilo por los montos: en pesos un equipo cuesta cientos de miles o millones),
    "iva_incluido": true si los totales incluyen IVA (o si no lo aclara),
    "tipo_cambio": número si el documento fija un tipo de cambio, si no null,
    "opciones": [{"nombre": "Opción A (uplink simple)", "total": 74851.90}]
  }
  En "opciones" va el TOTAL FINAL de cada alternativa que se ofrece (lo que pagaría el
  cliente, con IVA si el documento lo da), como número con punto decimal y sin
  separadores de miles. Si hay un solo total, una sola opción llamada "Total". Si es una
  lista de un solo armado o compra sin el total escrito, sumá cantidad × precio de los
  ítems. No sumes los ítems opcionales que no forman parte del total, no uses anticipos
  ni subtotales, y no inventes montos: si no hay un total claro, "opciones" va vacío.`;

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
        const { data: previo } = await supabase.from('cliente_documentos').select('datos').eq('id', id).maybeSingle();
        const { data: cliente } = await supabase.from('clientes').select('nombre').eq('id', doc.cliente_id).maybeSingle();
        const contenido = await contenidoParaClaude(buffer, doc.tipo_mime as string);
        const modelo = 'sonnet' as const;
        const r = await anthropic.messages.create({
            model: idModelo(modelo),
            max_tokens: 2000,
            system: PROMPT_DOCUMENTO,
            messages: [{ role: 'user', content: [...contenido, { type: 'text', text: `Cliente: ${cliente?.nombre ?? 'sin nombre'}\nArchivo: ${doc.nombre}\n\nDevolvé el JSON.` }] }],
        });
        const salida = r.content.map((c) => (c.type === 'text' ? c.text : '')).join('').trim();
        const json = salida.match(/\{[\s\S]*\}/)?.[0];
        let tipoDoc: string | null = null, resumen = '', presupuesto: unknown = null;
        try {
            const p = JSON.parse(json ?? '') as { tipo_documento?: string; resumen?: string; presupuesto?: unknown };
            tipoDoc = p.tipo_documento?.trim().slice(0, 60) || null;
            resumen = p.resumen?.trim() ?? '';
            presupuesto = p.presupuesto ?? null;
        } catch {
            resumen = salida; // si no vino JSON, el texto igual sirve como resumen
        }
        if (!resumen) throw new Error('La IA no devolvió un resumen');
        // Lo que decidió Andrés (opción, "es nuestro", total a mano) se respeta si
        // se vuelve a leer el documento.
        const antes = (previo?.datos as DatosDocumento | null) ?? null;
        const datos: DatosDocumento = {
            version: VERSION_DATOS,
            presupuesto: aplicarTotalManual(normalizarPresupuesto(presupuesto), antes?.total_manual),
            ...(typeof antes?.opcion === 'number' ? { opcion: antes.opcion } : {}),
            ...(antes?.nuestro ? { nuestro: true } : {}),
            ...(antes?.total_manual ? { total_manual: antes.total_manual } : {}),
        };
        await supabase.from('cliente_documentos').update({
            estado: 'listo', tipo_documento: tipoDoc, resumen: resumen.slice(0, 4000), error: null, datos,
            costo_usd: calcularCosto(modelo, r.usage.input_tokens, r.usage.output_tokens), procesado_en: new Date().toISOString(),
        }).eq('id', id);
    } catch (err) {
        await falla((err as Error).message);
        return;
    }
    // Si es un presupuesto de Bartez, suma a Cotizado. Un problema acá no invalida la lectura.
    try { await sincronizarPresupuestoDeDocumento(id); } catch (err) { console.warn('[memoria] presupuesto del documento', id, (err as Error).message); }
}

// Lo que Andrés corrige desde la ficha: contarlo o no en Cotizado, qué opción
// cuenta, que es nuestro (aunque la IA leyó otro emisor) o el total a mano
// (también para un documento que la IA no tomó como presupuesto).
export async function cambiarCotizadoDocumento(
    id: string,
    cambios: { contar?: boolean; opcion?: number; nuestro?: boolean; total?: TotalManual },
): Promise<Documento | null> {
    const { data: doc } = await supabase.from('cliente_documentos').select('datos').eq('id', id).maybeSingle();
    if (!doc) return null;
    const upd: Record<string, unknown> = {};
    if (typeof cambios.contar === 'boolean') upd.sin_cotizado = !cambios.contar;
    let datos: DatosDocumento = (doc.datos as DatosDocumento | null) ?? { version: 0, presupuesto: null };
    const antes = datos;
    if (typeof cambios.opcion === 'number') {
        const ops = datos.presupuesto?.opciones ?? [];
        if (!Number.isInteger(cambios.opcion) || cambios.opcion < 0 || cambios.opcion >= ops.length) throw new Error('Esa opción no existe');
        datos = { ...datos, opcion: cambios.opcion };
    }
    if (typeof cambios.nuestro === 'boolean') {
        datos = { ...datos, nuestro: cambios.nuestro };
        if (cambios.nuestro) upd.sin_cotizado = false;
    }
    if (cambios.total) {
        const monto = Math.round(cambios.total.monto * 100) / 100;
        if (!(monto > 0)) throw new Error('Poné un total mayor a cero');
        const total_manual: TotalManual = { monto, moneda: cambios.total.moneda === 'ARS' ? 'ARS' : 'USD' };
        // Un total propio es una sola opción: la elegida antes ya no aplica.
        const { opcion: _opcion, ...resto } = datos;
        datos = { ...resto, nuestro: true, total_manual, presupuesto: aplicarTotalManual(datos.presupuesto, total_manual) };
        upd.sin_cotizado = false;
    }
    if (datos !== antes) upd.datos = datos;
    if (Object.keys(upd).length) {
        const { error } = await supabase.from('cliente_documentos').update(upd).eq('id', id);
        if (error) throw new Error(error.message);
    }
    await sincronizarPresupuestoDeDocumento(id);
    return documento(id);
}

// Lo que quedó a medias por un reinicio del servidor (cada publicación lo
// reinicia): documentos que se estaban leyendo (quedaban "leyendo…" para
// siempre) y notas largas que no llegaron a resumirse. Corre al arrancar.
const ARRANQUE = new Date().toISOString();
export async function retomarPendientes(): Promise<{ documentos: number; notas: number }> {
    // Solo lo anterior al arranque: lo que se sube ahora ya se está leyendo.
    const { data: docs } = await supabase.from('cliente_documentos').select('id').eq('estado', 'procesando')
        .lt('creado_en', ARRANQUE).order('creado_en', { ascending: true }).limit(20);
    for (const d of docs ?? []) await procesarDocumento(d.id as string);
    const { data: notas } = await supabase.from('cliente_notas').select('id, texto, cliente_id').is('resumen', null)
        .lt('creado_en', ARRANQUE).order('creado_en', { ascending: false }).limit(60);
    const largas = (notas ?? []).filter((n) => String(n.texto ?? '').length > NOTA_LARGA).slice(0, 20);
    for (const n of largas) {
        await resumirNota(n.id as string, n.texto as string, n.cliente_id as string)
            .catch((err) => console.warn('[memoria] resumir nota pendiente', n.id, (err as Error).message));
    }
    return { documentos: docs?.length ?? 0, notas: largas.length };
}

// Documentos leídos con una versión vieja de la extracción: se vuelven a leer
// de a uno los que cambian con la versión nueva; al resto solo se le sube la
// versión. Corre al arrancar el servidor.
export async function completarDatosDocumentos(limite = 30): Promise<number> {
    const { data, error } = await supabase.from('cliente_documentos').select('id, datos').eq('estado', 'listo')
        .order('creado_en', { ascending: false }).limit(300);
    if (error) throw new Error(error.message);
    const viejos = (data ?? []).filter((d) => ((d.datos as DatosDocumento | null)?.version ?? 0) < VERSION_DATOS);
    for (const d of viejos.filter((x) => !necesitaRelectura(x.datos as DatosDocumento | null))) {
        await supabase.from('cliente_documentos').update({ datos: { ...(d.datos as DatosDocumento), version: VERSION_DATOS } }).eq('id', d.id);
    }
    const releer = viejos.filter((d) => necesitaRelectura(d.datos as DatosDocumento | null)).slice(0, limite);
    for (const d of releer) await procesarDocumento(d.id as string);
    return releer.length;
}

// Vuelve a leer un documento (p. ej. si falló). Queda en "procesando" ya, para
// que el panel lo muestre así mientras la IA trabaja.
export async function reprocesarDocumento(id: string): Promise<void> {
    const { error } = await supabase.from('cliente_documentos').update({ estado: 'procesando', error: null }).eq('id', id);
    if (error) throw new Error(error.message);
    void procesarDocumento(id).catch((err) => console.warn('[memoria] reprocesar', id, (err as Error).message));
}

export async function borrarDocumento(id: string): Promise<void> {
    const { data: doc } = await supabase.from('cliente_documentos').select('ruta, cotizacion_id').eq('id', id).maybeSingle();
    if (!doc) return;
    // Su presupuesto deja de contar en Cotizado (salvo que ya esté ganado o perdido).
    if (doc.cotizacion_id) await soltarCotizacion(id, doc.cotizacion_id as string);
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
