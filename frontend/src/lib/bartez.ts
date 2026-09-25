// Abrir Bartez AI (el chat flotante) desde cualquier pantalla, con un pedido
// ya escrito. Si `enviar` es true, lo manda directo; si no, lo deja en el campo
// para que se complete o corrija antes de enviarlo.

export const EVENTO_PREGUNTAR = 'bartez:preguntar';

export interface Pregunta { texto: string; enviar: boolean }

export function preguntarABartez(texto: string, enviar = true): void {
    window.dispatchEvent(new CustomEvent<Pregunta>(EVENTO_PREGUNTAR, { detail: { texto, enviar } }));
}
