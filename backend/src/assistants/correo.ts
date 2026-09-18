// Asistente de Correo — el más crítico de Fase 1 porque es la cara del negocio.
// El prompt vive en la base (tabla `asistentes`) para poder iterarlo sin redeploy.
// Aquí solo se define la lógica: qué herramientas puede usar y cómo interpreta la salida.

import { AsistenteBase } from './base.js';
import type { ResultadoAsistente, TareaEntrante } from '../orchestrator/types.js';

const PROMPT_DEFAULT = `
Sos el asistente de Correo de Bartez, un negocio de equipamiento IT.
Tu tarea es leer correos entrantes y proponer una respuesta.

Reglas:
- Tono profesional pero cercano, en español rioplatense.
- Firma siempre como "Equipo Bartez".
- Nunca prometas plazos, precios o stock específicos sin confirmar — usá frases como
  "podemos confirmarte eso a la brevedad".
- Si el correo menciona una queja, un problema técnico serio o un pedido de descuento,
  proponé una respuesta pero marcá que requiere aprobación humana.
- Si es una consulta genérica (horarios, catálogo, cómo comprar), respondé directo.

Formato de tu respuesta:
<respuesta>...el texto del correo a enviar...</respuesta>
<destinatario>email del cliente</destinatario>
`.trim();

export class AsistenteCorreo extends AsistenteBase {
    protected override construirSystem(): string {
        return this.config.prompt?.trim() || PROMPT_DEFAULT;
    }

    protected override extraerAccion(texto: string, tarea: TareaEntrante): ResultadoAsistente['accionPropuesta'] {
        const respuesta = /<respuesta>([\s\S]*?)<\/respuesta>/i.exec(texto)?.[1]?.trim();
        const destinatario = /<destinatario>([\s\S]*?)<\/destinatario>/i.exec(texto)?.[1]?.trim();

        if (!respuesta || !destinatario) return undefined;

        return {
            tipo: 'enviar_correo',
            payload: {
                para: destinatario,
                asunto: (tarea.metadata?.asuntoOriginal as string) ?? 'Re:',
                cuerpo: respuesta,
                inReplyTo: tarea.metadata?.messageId as string | undefined,
                threadId: tarea.metadata?.threadId as string | undefined,
            },
        };
    }
}
