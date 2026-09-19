// Asistente de Correo — el más crítico de Fase 1 porque es la cara del negocio.
// El prompt vive en la base (tabla `asistentes`) para poder iterarlo sin redeploy.
// Aquí solo se define la lógica: qué herramientas puede usar y cómo interpreta la salida.

import { AsistenteBase, contextoFecha } from './base.js';
import type { ResultadoAsistente, TareaEntrante } from '../orchestrator/types.js';

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
    protected override construirSystem(tarea: TareaEntrante): string {
        const fecha = contextoFecha();
        // Desde el panel el operador está chateando con su copiloto — otro modo.
        if (tarea.canal === 'panel') return `${fecha}\n\n${PROMPT_PANEL}`;

        const base = this.config.prompt?.trim() || PROMPT_DEFAULT;
        const clasif = (tarea.metadata?.clasificacion as { categoria?: string; razon?: string } | undefined);

        // Si viene con clasificación, la inyecto como hint al asistente para que
        // ajuste su respuesta (ej. cotizacion_vaga → foco en pedir datos).
        if (clasif?.categoria) {
            return `${fecha}\n\n${base}\n\n---\nContexto de este correo (según clasificador previo):\n- Categoría: ${clasif.categoria}\n- Motivo: ${clasif.razon ?? '(sin motivo)'}\n\nSi la categoría es "cotizacion_vaga", tu respuesta debe centrarse en pedir los datos que faltan para armar una propuesta real (uso, cantidad, especificaciones, presupuesto, plazo).`;
        }
        return `${fecha}\n\n${base}`;
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

        return {
            tipo: 'enviar_correo',
            payload: {
                para,
                asunto: (tarea.metadata?.asuntoOriginal as string) ?? 'Re:',
                cuerpo: respuesta,
                inReplyTo: tarea.metadata?.messageId as string | undefined,
                references: tarea.metadata?.messageId as string | undefined,
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
