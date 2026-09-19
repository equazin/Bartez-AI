// Registro de implementaciones de asistentes.
// El catálogo carga la config desde la base; este archivo mapea `area` → clase.
// Sumar un asistente nuevo = una fila en la tabla + una línea acá + su clase.

import type { Asistente, AsistenteConfig } from '../orchestrator/types.js';
import { AsistenteCorreo } from './correo.js';
import { AsistenteNotion } from './notion.js';
import { AsistenteProspeccion } from './prospeccion.js';

type Factory = (config: AsistenteConfig) => Asistente;

export function registrarAsistentes(): Map<string, Factory> {
    const m = new Map<string, Factory>();
    m.set('correo', (c) => new AsistenteCorreo(c));
    m.set('notion', (c) => new AsistenteNotion(c));
    m.set('prospeccion', (c) => new AsistenteProspeccion(c));
    // seguimientos, whatsapp, analitica → se agregan cuando estén sus clases
    return m;
}
