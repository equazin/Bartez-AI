// Ayudas de animación: respetan "reducir movimiento" del sistema.

import { useEffect, useRef, useState } from 'react';

export function movimientoReducido(): boolean {
    return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

export const suave = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

// Número que "cuenta" hasta el valor nuevo cada vez que cambia.
export function useContar(valor: number, ms = 800): number {
    const [mostrado, setMostrado] = useState(() => (movimientoReducido() ? valor : 0));
    const desde = useRef(mostrado);
    useEffect(() => {
        if (movimientoReducido()) { setMostrado(valor); return; }
        const inicio = performance.now(), origen = desde.current;
        let id = 0;
        const paso = (t: number) => {
            const p = Math.min(1, (t - inicio) / ms);
            const v = origen + (valor - origen) * suave(p);
            desde.current = v;
            setMostrado(v);
            if (p < 1) id = requestAnimationFrame(paso);
        };
        id = requestAnimationFrame(paso);
        return () => cancelAnimationFrame(id);
    }, [valor, ms]);
    return mostrado;
}
