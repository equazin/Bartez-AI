// Asistente Cotizador — el motor real vive en orchestrator/cotizador.ts (loop
// con la herramienta buscar_articulos). Este stub existe para que el catálogo
// lo registre y se pueda editar su prompt/modelo desde la pestaña Asistentes.
// Prompt vacío en la base = usa el PROMPT_DEFAULT del motor.

import { AsistenteBase } from './base.js';

export class AsistenteCotizador extends AsistenteBase {}
