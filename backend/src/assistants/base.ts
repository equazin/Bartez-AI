// Clase base para asistentes: encapsula la llamada al LLM, el cálculo de costo y
// la conversión a ResultadoAsistente. Cada asistente concreto define su prompt
// y qué herramientas puede llamar.

import { anthropic, calcularCosto, idModelo } from '../connectors/anthropic.js';
import type { Asistente, AsistenteConfig, ResultadoAsistente, TareaEntrante } from '../orchestrator/types.js';

export abstract class AsistenteBase implements Asistente {
    constructor(public readonly config: AsistenteConfig) {}

    async procesar(tarea: TareaEntrante): Promise<ResultadoAsistente> {
        const inicio = Date.now();

        const respuesta = await anthropic.messages.create({
            model: idModelo(this.config.modelo),
            max_tokens: 1024,
            system: this.construirSystem(tarea),
            messages: [{ role: 'user', content: tarea.texto }],
        });

        const bloqueTexto = respuesta.content.find((c) => c.type === 'text');
        const texto = bloqueTexto?.type === 'text' ? bloqueTexto.text : '';

        const tokensIn = respuesta.usage.input_tokens;
        const tokensOut = respuesta.usage.output_tokens;

        const accionPropuesta = this.extraerAccion(texto, tarea);
        const requiereAprobacion = accionPropuesta ? this.config.autonomia < 100 : false;

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

    protected construirSystem(_tarea: TareaEntrante): string {
        return this.config.prompt || `Sos el asistente de ${this.config.area} de Bartez AI.`;
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    protected extraerAccion(_texto: string, _tarea: TareaEntrante): ResultadoAsistente['accionPropuesta'] {
        return undefined;
    }
}
