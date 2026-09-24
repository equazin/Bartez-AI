// Registro de conectores de proveedores, uno por mayorista.
// El conector genérico (generico.ts) queda para la importación manual por CSV.

import { air } from './air.js';
import { elit } from './elit.js';
import { invid } from './invid.js';
import type { AdaptadorProveedor } from './tipos.js';

export const adaptadores: Record<string, AdaptadorProveedor> = { elit, air, invid };

export type { AdaptadorProveedor, ItemCatalogo } from './tipos.js';
