// Clasificador de correos entrantes.
// Corre en Haiku (barato, rápido) antes de invocar al asistente de Correo.
// Filtra spam/newsletters/informativos y tags la categoría de los que sí
// requieren respuesta, para que el asistente sepa qué tratamiento darle.

import { anthropic, calcularCosto, idModelo } from '../connectors/anthropic.js';
import { bitacora } from '../logging/bitacora.js';

export type CategoriaCorreo =
    | 'spam'
    | 'newsletter'
    | 'informativo'
    | 'consulta_simple'   // horarios, catálogo, formas de pago — se puede autoresponder
    | 'cotizacion_vaga'   // pide cotización pero sin detalles — pedimos datos solos
    | 'cotizacion_detalle' // pide cotización con datos concretos — requiere aprobación
    | 'queja'             // reclamo o problema — SIEMPRE requiere aprobación
    | 'soporte'           // consulta técnica sobre algo ya vendido
    | 'proveedor'         // un mayorista o fabricante que le vende o cotiza a Bartez — nunca se responde solo
    | 'sin_respuesta'     // acuse de recibo, "te aviso", ofertas para venderle a Bartez — no hace falta contestar
    | 'otro';

export interface ClasificacionCorreo {
    categoria: CategoriaCorreo;
    prioridad: 'alta' | 'media' | 'baja';
    razon: string;
    ignorable: boolean; // true si no vale la pena procesarlo (spam/newsletter/informativo)
    tokensIn: number;
    tokensOut: number;
    costoUsd: number;
}

const SYSTEM_PROMPT = `
Sos un clasificador de correos entrantes de una empresa de equipamiento IT
(Bartez Tecnología). Recibís asunto + cuerpo de un correo y devolvés su
categoría en JSON estricto.

Categorías posibles (elegí UNA):
- "spam" — correo no solicitado, engañoso, phishing, o promoción de dudosa procedencia.
- "newsletter" — boletín de una empresa/plataforma, correo automático de marketing legítimo.
- "informativo" — notificación automática (facturas emitidas, cambios de plataformas, avisos de bancos, reseñas de servicios, alertas del sistema, etc.). No requiere respuesta.
- "consulta_simple" — pregunta genérica que se puede responder al toque: horarios, dirección, formas de pago, catálogo general, "¿venden X?". SIN detalles específicos de una compra.
- "cotizacion_vaga" — pide cotización o presupuesto SIN datos concretos ("necesito una notebook", "quiero cotizar equipos"). Falta info para armar propuesta.
- "cotizacion_detalle" — pide cotización con datos suficientes (cantidad + tipo + uso o marca o presupuesto o plazo).
- "queja" — reclamo, queja formal, expresa malestar, menciona problema con algo comprado o servicio recibido.
- "soporte" — consulta técnica postventa: "no arranca", "cómo hago X en el equipo que me vendieron".
- "proveedor" — lo escribe un mayorista, distribuidor o fabricante que le VENDE o le COTIZA a Bartez (proformas, listas de precios para Bartez, "te paso la cotización que pediste", plazos de importación). Bartez es el que compra.
- "sin_respuesta" — no hace falta contestar: acuse de recibo ("recibido", "gracias", "te aviso cuando tenga"), cierre de una charla, alguien que le ofrece venderle algo a Bartez (equipos usados, servicios).
- "otro" — no encaja en ninguna anterior.

Ojo: si el correo le pide a Bartez un presupuesto, es de un cliente aunque sea otra empresa del rubro (un revendedor que le compra a Bartez es cliente).

Prioridad:
- "alta" — cotización con detalle, queja, cliente enojado, mención de plata/urgencia.
- "media" — cotización vaga, soporte, consulta simple de cliente activo.
- "baja" — spam, newsletter, informativo, consulta trivial.

Formato de tu respuesta (JSON estricto, sin markdown ni prosa):
{"categoria": "...", "prioridad": "alta|media|baja", "razon": "una línea explicando"}
`.trim();

export async function clasificarCorreo(params: {
    asunto: string;
    cuerpo: string;
    de: string;
    asistenteId?: string;
}): Promise<ClasificacionCorreo> {
    const inicio = Date.now();
    const cuerpoRecortado = params.cuerpo.slice(0, 3000);

    try {
        const respuesta = await anthropic.messages.create({
            model: idModelo('haiku'),
            max_tokens: 200,
            system: SYSTEM_PROMPT,
            messages: [{
                role: 'user',
                content: `De: ${params.de}\nAsunto: ${params.asunto}\n\n${cuerpoRecortado}`,
            }],
        });

        const bloque = respuesta.content.find((c) => c.type === 'text');
        const texto = bloque?.type === 'text' ? bloque.text : '';

        const tokensIn = respuesta.usage.input_tokens;
        const tokensOut = respuesta.usage.output_tokens;
        const costoUsd = calcularCosto('haiku', tokensIn, tokensOut);

        // Extraer JSON (con fallback si el modelo envolvió en ```json)
        const jsonMatch = /\{[\s\S]*\}/.exec(texto);
        const raw = jsonMatch ? jsonMatch[0] : '{}';
        let parsed: { categoria?: string; prioridad?: string; razon?: string } = {};
        try {
            parsed = JSON.parse(raw);
        } catch {
            parsed = {};
        }

        const categoria = normalizarCategoria(parsed.categoria);
        const prioridad = normalizarPrioridad(parsed.prioridad);

        const clasificacion: ClasificacionCorreo = {
            categoria,
            prioridad,
            razon: parsed.razon ?? 'sin razón dada',
            ignorable: categoria === 'spam' || categoria === 'newsletter' || categoria === 'informativo',
            tokensIn,
            tokensOut,
            costoUsd,
        };

        // Registrar la clasificación en bitácora (para poder auditar después)
        if (params.asistenteId) {
            await bitacora.registrar({
                asistenteId: params.asistenteId,
                entrada: { asunto: params.asunto, de: params.de, cuerpo_len: params.cuerpo.length },
                salida: { clasificacion },
                herramienta: 'clasificador',
                tokensIn,
                tokensOut,
                costoUsd,
                duracionMs: Date.now() - inicio,
            });
        }

        return clasificacion;
    } catch (err) {
        console.error('[clasificador] error, asumiendo "otro":', err);
        return {
            categoria: 'otro',
            prioridad: 'media',
            razon: `error de clasificación: ${(err as Error).message}`,
            ignorable: false,
            tokensIn: 0, tokensOut: 0, costoUsd: 0,
        };
    }
}

function normalizarCategoria(c: unknown): CategoriaCorreo {
    const validas: CategoriaCorreo[] = [
        'spam', 'newsletter', 'informativo', 'consulta_simple',
        'cotizacion_vaga', 'cotizacion_detalle', 'queja', 'soporte', 'proveedor', 'sin_respuesta', 'otro',
    ];
    if (typeof c === 'string' && (validas as string[]).includes(c)) return c as CategoriaCorreo;
    return 'otro';
}

function normalizarPrioridad(p: unknown): 'alta' | 'media' | 'baja' {
    if (p === 'alta' || p === 'media' || p === 'baja') return p;
    return 'media';
}
