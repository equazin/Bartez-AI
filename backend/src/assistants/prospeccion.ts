// Asistente de Prospección — motor de crecimiento.
// Usa la herramienta web_search de Anthropic para buscar empresas que
// puedan necesitar equipamiento IT y propone primer contacto por correo.
// El destinatario NUNCA lo decide el LLM sin un email real encontrado en
// web (política estricta: sin fabricar direcciones).

import { anthropic, calcularCosto, idModelo } from '../connectors/anthropic.js';
import type { Asistente, AsistenteConfig, ResultadoAsistente, TareaEntrante } from '../orchestrator/types.js';

const PROMPT_DEFAULT = `
Sos el asistente de Prospección de Bartez Tecnología (equipamiento IT
para empresas, agencias, PyMEs, cerealeras y organizaciones en Mendoza,
Argentina y alrededores).

Tu tarea: usar la herramienta web_search para encontrar entre 3 y 6
empresas o organizaciones que probablemente necesiten equipamiento IT
en el corto plazo. Priorizá señales de crecimiento o cambio: apertura
de sucursales, nuevas contrataciones, ronda de inversión, expansión.

Perfil de cliente ideal (ICP):
- PyMEs y medianas empresas (10 a 200 empleados) del centro y oeste de
  Argentina (Mendoza, San Juan, San Luis, Córdoba, CABA).
- Rubros preferidos: agencias digitales, estudios profesionales
  (contables, legales), cerealeras y agropecuarias, comercios con
  varias sucursales, empresas de servicios que crecen.
- Que necesiten hardware (notebooks, workstations, servidores, redes)
  o que estén digitalizándose.

Para CADA prospecto que propongas, devolvé un bloque JSON dentro de
<prospecto>...</prospecto>:

<prospecto>
{
  "nombre": "Razón social o nombre comercial",
  "sitio_web": "https://...",
  "email": "email real encontrado en la web, o null si no hay",
  "razon": "una línea explicando por qué encaja",
  "señal": "qué señal disparó el interés (ej. abrió sucursal en Rosario)",
  "puntaje_icp": 7,
  "propuesta_contacto": "un párrafo breve de primer contacto por correo, tono Bartez Tecnología, voseo. Firmá como 'Bartez Tecnología'."
}
</prospecto>

Reglas:
- puntaje_icp del 1 al 10 según qué tanto encaja con el ICP.
- Si no encontrás el email real de la empresa, dejá "email": null.
  Nunca lo inventes.
- Si la propuesta_contacto menciona precios/plazos, siempre con "te
  confirmamos" o "podemos coordinar" — nada específico.
- No propongas prospectos si no hay señal clara (no llenes por llenar).

Sin prosa fuera de los tags <prospecto>. Cada prospecto en su propio bloque.
`.trim();

interface ProspectoJson {
    nombre: string;
    sitio_web?: string;
    email?: string | null;
    razon?: string;
    señal?: string;
    puntaje_icp?: number;
    propuesta_contacto?: string;
}

export interface ProspectoPropuesto extends ProspectoJson {
    id_temp: string; // ID interno para trackear la propuesta antes de aceptarla
}

export class AsistenteProspeccion implements Asistente {
    constructor(public readonly config: AsistenteConfig) {}

    async procesar(tarea: TareaEntrante): Promise<ResultadoAsistente> {
        const inicio = Date.now();

        const prompt = this.config.prompt?.trim() || PROMPT_DEFAULT;
        // El "texto" de la tarea puede incluir un focus extra ("busca en Mendoza",
        // "focus en agencias", etc). Si viene vacío, usá una consigna por defecto.
        const consigna = tarea.texto?.trim() ||
            'Buscá 4 prospectos que encajen con el ICP en Mendoza y alrededores. Priorizá empresas con señales recientes de crecimiento.';

        try {
            const respuesta = await anthropic.messages.create({
                model: idModelo(this.config.modelo),
                max_tokens: 4096,
                system: prompt,
                messages: [{ role: 'user', content: consigna }],
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 8 } as any],
            });

            // Concatenar todos los bloques de texto de la respuesta
            const texto = respuesta.content
                .filter((c) => c.type === 'text')
                .map((c) => (c as { text: string }).text)
                .join('\n');

            const tokensIn = respuesta.usage.input_tokens;
            const tokensOut = respuesta.usage.output_tokens;
            const costoUsd = calcularCosto(this.config.modelo, tokensIn, tokensOut);

            const prospectos = extraerProspectos(texto);

            return {
                respuesta: `Encontré ${prospectos.length} prospectos:\n\n${prospectos
                    .map((p) => `- ${p.nombre} (ICP ${p.puntaje_icp}/10) — ${p.razon ?? 'sin razón'}`)
                    .join('\n')}`,
                requiereAprobacion: prospectos.length > 0,
                accionPropuesta: prospectos.length > 0
                    ? {
                        tipo: 'otra',
                        payload: { subtipo: 'prospectos_propuestos', prospectos },
                    }
                    : undefined,
                tokensIn,
                tokensOut,
                costoUsd,
                duracionMs: Date.now() - inicio,
            };
        } catch (err) {
            return {
                respuesta: `Error en prospección: ${(err as Error).message}`,
                requiereAprobacion: false,
                tokensIn: 0,
                tokensOut: 0,
                costoUsd: 0,
                duracionMs: Date.now() - inicio,
            };
        }
    }
}

function extraerProspectos(texto: string): ProspectoPropuesto[] {
    const bloques = texto.matchAll(/<prospecto>([\s\S]*?)<\/prospecto>/gi);
    const out: ProspectoPropuesto[] = [];
    let i = 0;
    for (const m of bloques) {
        const raw = m[1]?.trim();
        if (!raw) continue;
        try {
            const parsed = JSON.parse(raw) as ProspectoJson;
            if (!parsed.nombre) continue;
            out.push({ ...parsed, id_temp: `${Date.now()}-${i++}` });
        } catch {
            // ignorar bloques inválidos
        }
    }
    return out;
}
