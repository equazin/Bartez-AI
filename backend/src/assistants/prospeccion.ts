// Asistente de Prospección — motor de crecimiento.
// Usa la herramienta web_search de Anthropic para buscar empresas que
// puedan necesitar equipamiento IT y propone primer contacto por correo.
// El destinatario NUNCA lo decide el LLM sin un email real encontrado en
// web (política estricta: sin fabricar direcciones).

import { anthropic, calcularCosto, idModelo } from '../connectors/anthropic.js';
import type { Asistente, AsistenteConfig, ResultadoAsistente, TareaEntrante } from '../orchestrator/types.js';
import { contextoFecha } from './base.js';

// Fallback mínimo — el prompt real vive en Supabase (asistentes.prompt).
const PROMPT_DEFAULT = `
Sos el asistente de Prospección de Bartez Tecnología (equipamiento IT
para empresas en Argentina). Usá web_search para encontrar empresas
que necesiten hardware IT. Devolvé cada prospecto en un bloque
<prospecto>{...}</prospecto> con campos: nombre, sitio_web, email,
razon, señal, puntaje_icp, propuesta_contacto.
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
        const modo = (tarea.metadata?.modo as string | undefined) === 'sweep' ? 'sweep' : 'focal';

        const consignaBase = tarea.texto?.trim() ||
            (modo === 'sweep'
                ? 'Barrido nacional: buscá prospectos IT en todas las regiones del país.'
                : 'Buscá entre 5 y 8 prospectos que encajen con el ICP. Priorizá empresas con señales recientes de crecimiento IT.');

        const consigna = modo === 'sweep'
            ? `${consignaBase}

MODO BARRIDO NACIONAL — instrucciones especiales:
1. Primero planificá mentalmente 5-7 regiones a barrer (ej. AMBA,
   Litoral, Córdoba/Centro, Cuyo, NOA, NEA, Patagonia) y 2-3 rubros
   dentro de cada una del ICP.
2. Hacé una búsqueda web específica por cada combinación región+rubro
   (ej. "software houses en Córdoba contratando 2026", "metalúrgicas
   medianas en Rosario expansión", "estudios contables Mendoza").
3. De cada barrido, quedate con los 2-3 mejores prospectos que cumplan
   ICP + señal IT clara.
4. Apuntá a **entre 30 y 40 prospectos totales** cubriendo todo el país.
   Es un mínimo — si no llegás a 30, hacé más búsquedas en otras
   regiones o rubros. No devuelvas menos de 30 salvo que sea imposible.
5. Podés usar hasta 40 búsquedas web. Usalas con criterio, no todas en
   la misma región/rubro.
6. NO repitas empresas ya conocidas del ICP obvio (evitá los "sospechosos
   habituales" tipo Mercado Libre, Globant, Despegar) — apuntá a
   empresas medianas con señales concretas.

Recordá: sin fabricar emails. Mejor un prospecto real sin email que
uno inventado. Sin sector público ni bancos.`
            : consignaBase;

        const maxUses = modo === 'sweep' ? 40 : 20;
        const maxTokens = modo === 'sweep' ? 16384 : 8192;

        try {
            const respuesta = await anthropic.messages.create({
                model: idModelo(this.config.modelo),
                max_tokens: maxTokens,
                system: `${contextoFecha()}\n\n${prompt}`,
                messages: [{ role: 'user', content: consigna }],
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: maxUses } as any],
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

            // Si el modelo no propuso nada, devolvemos su texto crudo para poder
            // ver qué razonó (aparece en el log y sirve para diagnosticar).
            const resumen = prospectos.length > 0
                ? `Encontré ${prospectos.length} prospectos:\n\n${prospectos
                    .map((p) => `- ${p.nombre} (ICP ${p.puntaje_icp}/10) — ${p.razon ?? 'sin razón'}`)
                    .join('\n')}`
                : `No propuse prospectos. Texto del modelo:\n\n${texto.slice(0, 3000) || '(sin salida)'}`;

            return {
                respuesta: resumen,
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
