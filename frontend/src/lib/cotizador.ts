// La cotización abierta se recuerda en este navegador: el Cotizador la reabre al
// entrar. Sirve también para mandar a una cotización puntual desde otra pantalla.
export const CLAVE_COTIZACION_ABIERTA = 'bartez_cotizacion_abierta';

export function abrirEnCotizador(id: string): void {
    try { localStorage.setItem(CLAVE_COTIZACION_ABIERTA, id); } catch { /* sin storage */ }
}
