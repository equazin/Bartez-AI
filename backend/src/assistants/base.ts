// Clase base para asistentes: encapsula la llamada al LLM, el cálculo de costo y
// la conversión a ResultadoAsistente. Cada asistente concreto define su prompt
// y qué herramientas puede llamar.

import { anthropic, calcularCosto, idModelo } from '../connectors/anthropic.js';
import { conLecciones } from '../orchestrator/aprendizaje.js';
import { conMemoria } from '../orchestrator/memoria.js';
import type { Asistente, AsistenteConfig, ResultadoAsistente, TareaEntrante } from '../orchestrator/types.js';

// Bloque de fecha que se inyecta al inicio del system prompt de todos los
// asistentes. Sin esto, el LLM usa la fecha de su entrenamiento (2024/2025)
// y mete referencias temporales incorrectas ("el año que viene" para 2026, etc).
export function contextoFecha(): string {
    const hoy = new Date();
    const fecha = hoy.toLocaleDateString('es-AR', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
        timeZone: 'America/Argentina/Buenos_Aires',
    });
    const iso = hoy.toISOString().slice(0, 10);
    return `CONTEXTO TEMPORAL — HOY ES ${fecha} (${iso}).
Cuando escribas fechas o hagas referencias temporales, usá SIEMPRE
esta fecha como "hoy". No confíes en tu conocimiento previo de qué año
es — puede estar desactualizado. Ejemplos correctos si hoy es ${iso}:
- "marzo 2026" es hace ${Math.max(0, hoy.getMonth() - 2)} meses (pasado, no futuro)
- "el año que viene" = ${hoy.getFullYear() + 1}
- "año pasado" = ${hoy.getFullYear() - 1}
- "en unos meses" o "próximamente" = fechas de ${hoy.getFullYear()} o ${hoy.getFullYear() + 1}
Verificá cada referencia temporal contra la fecha real antes de escribirla.`;
}

export abstract class AsistenteBase implements Asistente {
    constructor(public readonly config: AsistenteConfig) {}

    async procesar(tarea: TareaEntrante): Promise<ResultadoAsistente> {
        const inicio = Date.now();

        const respuesta = await anthropic.messages.create({
            model: idModelo(this.config.modelo),
            max_tokens: 1024,
            system: await this.construirSystem(tarea),
            messages: [{ role: 'user', content: tarea.texto }],
        });

        const bloqueTexto = respuesta.content.find((c) => c.type === 'text');
        const texto = bloqueTexto?.type === 'text' ? bloqueTexto.text : '';

        const tokensIn = respuesta.usage.input_tokens;
        const tokensOut = respuesta.usage.output_tokens;

        const accionPropuesta = this.extraerAccion(texto, tarea);
        const requiereAprobacion = accionPropuesta ? this.decidirAprobacion(accionPropuesta, tarea) : false;

        return {
            respuesta: texto,
            requiereAprobacion,
            accionPropuesta,
            tokensIn,
            tokensOut,
            costoUsd: calcularCosto(this.config.modelo, tokensIn, tokensOut),
            duracionMs: Date.now() - inicio,
        };
    }

    protected async construirSystem(tarea: TareaEntrante): Promise<string> {
        const promptBase = this.config.prompt || `Sos el asistente de ${this.config.area} de Bartez AI.`;
        // Si atiende a un cliente, se suma lo que Bartez ya sabe de él (notas, documentos, último informe).
        return conMemoria(await conLecciones(`${contextoFecha()}\n\n${promptBase}`, this.config.id), tarea.clienteId);
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    protected extraerAccion(_texto: string, _tarea: TareaEntrante): ResultadoAsistente['accionPropuesta'] {
        return undefined;
    }

    // Regla por defecto: aprueba solo si autonomía == 100.
    // Los asistentes concretos pueden refinar (ej. Correo decide por categoría).
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    protected decidirAprobacion(_accion: NonNullable<ResultadoAsistente['accionPropuesta']>, _tarea: TareaEntrante): boolean {
        return this.config.autonomia < 100;
    }
}
