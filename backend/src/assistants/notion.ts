// Asistente de Notion — crea/actualiza páginas y tareas.
// Fase 1: stub que solo devuelve confirmación. Se implementa el cliente real en Fase 2
// junto con el asistente de Seguimientos, que lo usa intensivamente.

import { AsistenteBase } from './base.js';

export class AsistenteNotion extends AsistenteBase {
    protected override async construirSystem(): Promise<string> {
        return (
            this.config.prompt?.trim() ||
            'Sos el asistente de Notion de Bartez. Recibís pedidos para crear o actualizar páginas y tareas.'
        );
    }
}
