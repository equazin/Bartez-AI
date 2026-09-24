// Formato común al que cada conector traduce la lista de su proveedor.
export interface ItemCatalogo {
    sku: string;
    descripcion: string;
    marca?: string | null;
    categoria?: string | null;
    precio?: number | null;
    moneda: 'USD' | 'ARS';
    iva_pct?: number | null;
    stock?: number | null;
    url_imagen?: string | null;
    raw?: unknown;
}

export interface AdaptadorProveedor {
    codigo: 'elit' | 'air' | 'invid';
    // Devuelve null si está configurado, o el motivo por el que no puede sincronizar.
    faltaConfig(): string | null;
    traerCatalogo(): Promise<ItemCatalogo[]>;
}
