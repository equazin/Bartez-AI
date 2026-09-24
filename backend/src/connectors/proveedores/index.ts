// Registro de conectores de proveedores. Hoy los tres usan el conector genérico
// configurable por .env; cuando tengamos la documentación de cada API se reemplaza
// por un adaptador específico (elit.ts, air.ts, invid.ts) sin tocar el resto.

import { crearAdaptadorGenerico } from './generico.js';
import type { AdaptadorProveedor } from './tipos.js';

export const adaptadores: Record<string, AdaptadorProveedor> = {
    elit: crearAdaptadorGenerico('elit', 'ELIT'),
    air: crearAdaptadorGenerico('air', 'AIR'),
    invid: crearAdaptadorGenerico('invid', 'INVID'),
};

export type { AdaptadorProveedor, ItemCatalogo } from './tipos.js';
