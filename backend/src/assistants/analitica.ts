// Asistente Analítica — no usa el patrón procesar()/tareas del router.
// El motor real vive en orchestrator/analitica.ts (correrAnalitica) porque
// consulta datos agregados de la DB en lugar de responder a inputs sueltos.
// Este stub existe solo para que el catálogo lo registre y no tire warning.

import { AsistenteBase } from './base.js';

export class AsistenteAnalitica extends AsistenteBase {}
