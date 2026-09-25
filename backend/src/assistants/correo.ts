// Asistente de Correo — el más crítico de Fase 1 porque es la cara del negocio.
// El prompt vive en la base (tabla `asistentes`) para poder iterarlo sin redeploy.
// Aquí solo se define la lógica: qué herramientas puede usar y cómo interpreta la salida.

import { AsistenteBase, contextoFecha } from './base.js';
import type { ResultadoAsistente, TareaEntrante } from '../orchestrator/types.js';
import { buscarEnCatalogo } from '../orchestrator/notion_sync.js';
import { textoWebBartez } from '../connectors/bartez_web.js';
import { conMemoria } from '../orchestrator/memoria.js';
import { conLecciones } from '../orchestrator/aprendizaje.js';
import { historicoConCliente, historicoConEmail } from '../inbound/importar_historico.js';

const PROMPT_PANEL = `
Estás hablando con el operador de Bartez Tecnología (el dueño) desde el
panel interno. Actuás como su copiloto para el área de Correo — no como
si fueras un cliente ni como si respondieras un correo entrante.

Reglas de este modo:
- Respondé breve, directo, en español rioplatense, sin formalismo excesivo.
- Podés usar markdown (negritas, listas, encabezados) — se ven bien en el panel.
- Si el operador te pide "redactame un correo para X", devolvé el correo
  entre triple backticks para que lo copie fácil, y firma como Bartez Tecnología.
- Si te hace una pregunta operativa (métricas, cómo funciona algo, etc.),
  contestá con lo que sabés.
- Si algo no lo sabés o no está en tu alcance, decilo directo — no inventes.
`.trim();

const PROMPT_DEFAULT = `
Sos parte del equipo de Bartez Tecnología, un negocio de equipamiento IT
para empresas, agencias, PyMEs y cualquier organización que necesite
soluciones IT.

Escribís correos como una persona más del equipo. Nunca aclarás que sos un
asistente automático, un bot, ni una IA — te presentás siempre como Bartez
Tecnología o como parte del equipo.

Tono:
- Cercano, humano, en español rioplatense (voseo natural: "te confirmo",
  "podés", "necesitás").
- Profesional pero sin acartonarse — como un vendedor experto que
  también es buena onda.
- Directo y útil: nadie tiene tiempo para vueltas.
- Adaptás el registro al del cliente: si escribe formal, respondés con más
  formalidad; si escribe relajado, seguís esa onda.

Objetivo de cada correo:
- Que el cliente sienta que del otro lado hay alguien que lo entendió y
  le está resolviendo — no un formulario.
- Mover la conversación un paso adelante por escrito: pedir el dato que
  falta, mandar la información concreta, o proponer el próximo paso
  puntual del caso.
- No proponer llamadas ni reuniones por tu cuenta — solo si el cliente
  las pide explícitamente. Todo se resuelve por escrito salvo pedido
  contrario.

Reglas duras:
- Nunca prometas precios, plazos o stock específicos sin confirmarlos —
  usá frases como "te confirmo esto en el día" o "lo chequeo con logística
  y te vuelvo".
- Firmá siempre como "Bartez Tecnología" (sin nombre propio inventado; si
  hace falta un nombre, dejalo genérico como "Equipo Bartez Tecnología").
- Si el correo trae una queja, un problema técnico serio, un pedido de
  descuento o reembolso, o menciona plata en juego — proponé la respuesta
  pero marcá que requiere aprobación humana.
- Consultas genéricas (horarios, catálogo general, cómo comprar, formas de
  pago) las respondés directo.
- Si no tenés la información, no la inventes: decilo con naturalidad y
  ofrecé conseguirla ("no tengo ese dato acá pero te lo consigo").

Formato de tu respuesta (obligatorio, respetá los tags):
<respuesta>...el texto del correo a enviar, listo para copiar y pegar...</respuesta>
<destinatario>email del cliente</destinatario>
`.trim();

// Categorías que se pueden autoresponder si la autonomía lo permite.
// El resto (cotizacion_detalle, queja, soporte, otro) SIEMPRE requiere aprobación.
const CATEGORIAS_AUTORESPONDIBLES = new Set(['consulta_simple', 'cotizacion_vaga']);

export class AsistenteCorreo extends AsistenteBase {
    protected override async construirSystem(tarea: TareaEntrante): Promise<string> {
        const fecha = contextoFecha();
        // Desde el panel el operador está chateando con su copiloto — otro modo.
        if (tarea.canal === 'panel') return `${fecha}\n\n${PROMPT_PANEL}`;

        const base = this.config.prompt?.trim() || PROMPT_DEFAULT;
        const clasif = (tarea.metadata?.clasificacion as { categoria?: string; razon?: string } | undefined);

        // Bloque de contexto que se suma al system prompt. Empieza con la
        // clasificación y puede incluir items del catálogo (Fase 3D).
        const extra: string[] = [];

        // Info de Bartez extraída de www.bartez.com.ar (cacheada). El asistente la
        // usa como referencia real de qué vende Bartez cuando arma presentaciones
        // o describe la oferta. Si no hay caché aún, no se agrega el bloque.
        const web = await textoWebBartez();
        if (web) {
            extra.push(
                `---\nINFORMACIÓN DE BARTEZ (extraída de www.bartez.com.ar):\n${web.slice(0, 2500)}\n\nUsá esta información como referencia real de qué vende Bartez. NUNCA inventes servicios o productos que no aparezcan acá o en el catálogo. Cuando presentes la empresa en un primer contacto, sacá lo esencial de acá — no todo lo que hay.`,
            );
        }

        // Historial de correos previos con este cliente (importado de IMAP o generado
        // por la app). Le da continuidad al asistente para no repetir cosas ya dichas
        // ni contradecir cotizaciones anteriores. Se limita a 5 correos + 500 chars
        // por cuerpo para no explotar el contexto.
        const emailContraparte = tarea.metadata?.emailDestino as string | undefined;
        const historia = tarea.clienteId
            ? await historicoConCliente(tarea.clienteId, 5)
            : emailContraparte ? await historicoConEmail(emailContraparte, 5) : [];
        if (historia.length > 0) {
            const bloque = historia
                .slice()
                .reverse() // orden cronológico: viejo primero, actual último
                .map((h) => {
                    const quien = h.direccion === 'saliente' ? 'BARTEZ →' : 'CLIENTE →';
                    const fecha = new Date(h.fecha).toISOString().slice(0, 10);
                    const cuerpo = (h.cuerpo ?? '').replace(/\s+/g, ' ').slice(0, 500);
                    return `[${fecha}] ${quien} ${h.asunto ?? '(sin asunto)'}\n${cuerpo}${(h.cuerpo?.length ?? 0) > 500 ? '…' : ''}`;
                })
                .join('\n\n');
            extra.push(
                `---\nHISTORIAL DE CORREOS CON ESTE CLIENTE (últimos ${historia.length}, cronológico):\n${bloque}\n\nUsalo para dar continuidad: no repitas presentaciones ni preguntas ya hechas, referí a lo que ya se habló si aplica, y respetá cotizaciones o compromisos previos.`,
            );
        }

        if (clasif?.categoria) {
            extra.push(
                `---\nContexto de este correo (según clasificador previo):\n- Categoría: ${clasif.categoria}\n- Motivo: ${clasif.razon ?? '(sin motivo)'}\n\nSi la categoría es "cotizacion_vaga", tu respuesta debe centrarse en pedir los datos que faltan para armar una propuesta real (uso, cantidad, especificaciones, presupuesto, plazo).`,
            );
        }

        // Fase 3D — catálogo bidireccional: si la categoría huele a cotización,
        // extraer términos del correo y buscar en el catálogo de Notion. Los items
        // matcheados se pasan como referencia al asistente (best-effort).
        const cat = clasif?.categoria ?? '';
        if (cat === 'cotizacion_vaga' || cat === 'cotizacion_detalle') {
            const terminos = extraerTerminosParaCatalogo(tarea.texto);
            if (terminos.length > 0) {
                const items = await buscarEnCatalogo(terminos, 8);
                if (items.length > 0) {
                    const bloque = items.map((i) => `- ${i.nombre}${i.detalle ? ' — ' + i.detalle : ''}`).join('\n');
                    extra.push(
                        `---\nCATÁLOGO — items relacionados encontrados en Notion (usalos como referencia real, no inventes stock/precio):\n${bloque}\n\nSi vas a mencionar productos específicos en tu respuesta, sacalos de esta lista o pedí más precisión sobre cuál. Nunca inventes items que no aparezcan acá.`,
                    );
                }
            }
        }

        const cot = tarea.metadata?.cotizacion as { total_usd: number; items: Array<{ cantidad: number; descripcion: string; precio_unit_usd: number; iva_pct: number }>; faltantes: string[]; comentario: string } | undefined;
        if (cot) {
            const lineas = cot.items.map((i) => `- ${i.cantidad} x ${i.descripcion} — US$ ${i.precio_unit_usd.toLocaleString('es-AR')} + IVA ${i.iva_pct}% c/u`).join('\n');
            extra.push(
                `---\nPRESUPUESTO YA ARMADO (va ADJUNTO en PDF cuando se apruebe el envío):\n${lineas}\nTotal final con IVA: US$ ${cot.total_usd.toLocaleString('es-AR', { minimumFractionDigits: 2 })}\n${cot.faltantes.length ? `No se encontró en las listas: ${cot.faltantes.join('; ')}\n` : ''}${cot.comentario ? `Notas del cotizador: ${cot.comentario}\n` : ''}\nTu respuesta tiene que presentar el presupuesto adjunto: agradecé el pedido, contá en 1 o 2 líneas qué incluye y el total, aclará lo que no se encontró (ofrecé buscar alternativa), mencioná que la validez es de 7 días y que el precio está en dólares. NO pegues la tabla completa: está en el PDF. Nunca menciones proveedores, costos ni márgenes.`,
            );
        }

        return conMemoria(await conLecciones(`${fecha}\n\n${base}${extra.length > 0 ? '\n\n' + extra.join('\n\n') : ''}`, this.config.id), tarea.clienteId);
    }

    protected override extraerAccion(texto: string, tarea: TareaEntrante): ResultadoAsistente['accionPropuesta'] {
        // En el panel no proponemos "enviar_correo" — es una charla con el operador.
        if (tarea.canal === 'panel') return undefined;

        // El destinatario NUNCA lo decide el LLM — sale del correo entrante que nos llegó por IMAP.
        // Así evitamos alucinaciones tipo "[email del remitente]".
        const para = (tarea.metadata?.emailDestino as string | undefined)?.trim();
        if (!para) return undefined;

        // Extraer respuesta del LLM: primero busca <respuesta>...</respuesta>, si no está
        // usa todo el texto (fallback por si el asistente olvidó el tag).
        const match = /<respuesta>([\s\S]*?)<\/respuesta>/i.exec(texto);
        const respuesta = (match?.[1] ?? texto).trim();
        if (!respuesta) return undefined;

        // Extraer compromisos: bloque opcional <tareas>[{...}, {...}]</tareas>.
        // Se persisten después en Notion Tareas cuando se aprueba y ejecuta el correo.
        const tareas = extraerTareas(texto);

        const clasif = tarea.metadata?.clasificacion as { categoria?: string; razon?: string } | undefined;

        return {
            tipo: 'enviar_correo',
            payload: {
                para,
                asunto: (tarea.metadata?.asuntoOriginal as string) ?? 'Re:',
                cuerpo: respuesta,
                inReplyTo: tarea.metadata?.messageId as string | undefined,
                references: tarea.metadata?.messageId as string | undefined,
                clienteId: tarea.clienteId,
                nombreCliente: tarea.metadata?.nombreDestino as string | undefined,
                tareas,
                categoria: clasif?.categoria,
                motivoClasif: clasif?.razon,
                textoEntrante: tarea.texto?.slice(0, 2000),
                ...(tarea.metadata?.cotizacion ? {
                    cotizacion_id: (tarea.metadata.cotizacion as { id: string }).id,
                    adjunto: { tipo: 'presupuesto', total_usd: (tarea.metadata.cotizacion as { total_usd: number }).total_usd },
                } : {}),
            },
        };
    }

    protected override decidirAprobacion(_accion: NonNullable<ResultadoAsistente['accionPropuesta']>, tarea: TareaEntrante): boolean {
        // Queja o cotización con detalle → SIEMPRE aprobación (por más autonomía que haya).
        const clasif = tarea.metadata?.clasificacion as { categoria?: string } | undefined;
        const cat = clasif?.categoria ?? '';
        if (cat === 'queja' || cat === 'cotizacion_detalle') return true;

        // Consulta simple o cotización vaga: si la autonomía es >= 50, autoresponde.
        if (CATEGORIAS_AUTORESPONDIBLES.has(cat) && this.config.autonomia >= 50) return false;

        // Cualquier otra cosa: sigue la regla estándar de autonomía.
        return this.config.autonomia < 100;
    }
}

// Parsea bloque opcional <tareas>[{...}]</tareas> del texto del modelo.
// Devuelve array vacío si no hay bloque o si el JSON es inválido.
interface TareaExtractada {
    titulo: string;
    fecha_limite?: string | null;
    contexto?: string;
}
// Extrae 3-5 términos del correo entrante que sirvan como keywords para buscar
// en el catálogo de Notion. Simple heurística: palabras alfabéticas de 4+ chars
// no comunes, priorizando sustantivos técnicos.
const STOPWORDS = new Set([
    'hola', 'gracias', 'saludos', 'para', 'sobre', 'como', 'cuando', 'donde', 'cuanto', 'cuales',
    'necesito', 'necesitamos', 'quiero', 'queremos', 'consulta', 'pedido', 'presupuesto',
    'informacion', 'información', 'atentamente', 'cordial', 'buenas', 'buenos', 'tardes', 'dias',
    'días', 'noches', 'estimado', 'estimada', 'empresa', 'consulta', 'sobre', 'sobre',
    'contacto', 'muchas', 'muchos', 'mucho', 'poder', 'podria', 'podría', 'quisiera',
    'bartez', 'tecnología', 'tecnologia', 'ustedes', 'nosotros', 'nuestro', 'nuestra',
]);
function extraerTerminosParaCatalogo(texto: string): string[] {
    if (!texto) return [];
    const palabras = texto
        .toLowerCase()
        .replace(/[^\wáéíóúñü\s-]/g, ' ')
        .split(/\s+/)
        .filter((p) => p.length >= 4 && !STOPWORDS.has(p) && !/^\d+$/.test(p));
    // Dedupe manteniendo orden de aparición
    const vistos = new Set<string>();
    const out: string[] = [];
    for (const p of palabras) {
        if (vistos.has(p)) continue;
        vistos.add(p);
        out.push(p);
        if (out.length >= 5) break;
    }
    return out;
}

function extraerTareas(texto: string): TareaExtractada[] {
    const m = /<tareas>([\s\S]*?)<\/tareas>/i.exec(texto);
    if (!m) return [];
    try {
        const parsed = JSON.parse((m[1] ?? '').trim());
        if (!Array.isArray(parsed)) return [];
        return parsed
            .filter((t): t is Record<string, unknown> => typeof t === 'object' && t !== null)
            .map((t) => ({
                titulo: String(t.titulo ?? '').trim(),
                fecha_limite: typeof t.fecha_limite === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(t.fecha_limite)
                    ? t.fecha_limite
                    : null,
                contexto: typeof t.contexto === 'string' ? t.contexto : undefined,
            }))
            .filter((t) => t.titulo.length > 0);
    } catch {
        return [];
    }
}
