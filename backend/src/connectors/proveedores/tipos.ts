// Formato común al que cada conector traduce la lista de su proveedor.
export interface ItemCatalogo {
    sku: string;
    descripcion: string;
    marca?: string | null;
    categoria?: string | null;
    precio?: number | null; // costo para Bartez, sin IVA
    moneda: 'USD' | 'ARS';
    iva_pct?: number | null;
    stock?: number | null;
    url_imagen?: string | null;
    raw?: unknown;
}

export interface CatalogoTraido {
    items: ItemCatalogo[];
    // false = la corrida no trajo todo el catálogo (ej. límite de la API):
    // se actualiza lo que vino pero no se borra lo que faltó.
    completo: boolean;
    nota?: string;
}

export interface AdaptadorProveedor {
    codigo: 'elit' | 'air' | 'invid';
    // Devuelve null si está configurado, o el motivo por el que no puede sincronizar.
    faltaConfig(): string | null;
    traerCatalogo(): Promise<CatalogoTraido>;
}

// Helpers compartidos por los conectores.
export const env = (k: string) => (process.env[k] ?? '').trim();

export async function pedirJson(url: string, init: RequestInit, proveedor: string): Promise<unknown> {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(90_000) });
    const txt = await res.text();
    let json: unknown;
    try { json = JSON.parse(txt); } catch { json = null; }
    if (!res.ok) {
        const j = json as Record<string, unknown> | null;
        const msg = j?.message ?? j?.error_name ?? j?.error ?? j?.mensaje ?? txt.slice(0, 200);
        // Air devuelve sus errores con status HTTP y cuerpo { error_id, ... }: se
        // pasan como dato para que el conector decida (ej. "Too many queries").
        if (j && typeof j === 'object' && 'error_id' in j) return j;
        const retry = res.headers.get('retry-after');
        throw new Error(`${proveedor}: HTTP ${res.status} — ${String(msg)}${retry ? ` (reintentar en ${Math.ceil(Number(retry) / 60)} min)` : ''}`);
    }
    if (json === null) throw new Error(`${proveedor}: respuesta no es JSON (${txt.slice(0, 120)})`);
    return json;
}

export function conPartNumber(desc: string, pn: unknown): string {
    const p = pn == null ? '' : String(pn).trim();
    if (!p || desc.toUpperCase().includes(p.toUpperCase())) return desc;
    return `${desc} · PN ${p}`;
}
