// Cola con deshacer para aprobar, editar o rechazar propuestas: la decisión
// se ve al instante, pero el pedido al backend sale recién a los 5 s. Lo usan
// el Inicio y Para aprobar, así las dos pantallas se comportan igual.

import { useCallback, useEffect, useRef, useState } from 'react';
import { resolverAccion } from '../api/client.ts';

export const DESHACER_MS = 5000;
// Avisa al resto del panel (contadores del menú) que se resolvió algo.
export const EVENTO_RESUELTA = 'bartez:resuelta';

export type Resolucion = 'aprobar' | 'editar' | 'rechazar';
export interface EnCola { id: string; tipo: Resolucion; destino: string; payload?: Record<string, unknown>; timer: number }

async function resolver(x: EnCola): Promise<string | undefined> {
    const res = await resolverAccion(x.id, x.tipo, x.payload ? { payload: x.payload } : {});
    window.dispatchEvent(new Event(EVENTO_RESUELTA));
    if (x.tipo !== 'rechazar' && res.ejecucion && !res.ejecucion.ok) {
        return `Se aprobó la respuesta a ${x.destino} pero no se pudo enviar: ${res.ejecucion.detalle ?? 'error desconocido'}`;
    }
    return undefined;
}

export function useColaDeshacer(alTerminar: (error?: string) => void) {
    const [enCola, setEnCola] = useState<EnCola[]>([]);
    const colaRef = useRef<EnCola[]>([]);
    const terminarRef = useRef(alTerminar);
    terminarRef.current = alTerminar;

    const quitar = useCallback((id: string) => {
        colaRef.current = colaRef.current.filter((x) => x.id !== id);
        setEnCola(colaRef.current);
    }, []);

    const encolar = useCallback((id: string, tipo: Resolucion, destino: string, payload?: Record<string, unknown>) => {
        if (colaRef.current.some((x) => x.id === id)) return;
        const item: EnCola = { id, tipo, destino: destino || 'sin destinatario', payload, timer: 0 };
        item.timer = window.setTimeout(async () => {
            quitar(id);
            let error: string | undefined;
            try { error = await resolver(item); } catch (e) { error = (e as Error).message; }
            terminarRef.current(error);
        }, DESHACER_MS);
        colaRef.current = [...colaRef.current, item];
        setEnCola(colaRef.current);
    }, [quitar]);

    const deshacer = useCallback((id: string) => {
        const x = colaRef.current.find((c) => c.id === id);
        if (x) clearTimeout(x.timer);
        quitar(id);
    }, [quitar]);

    // Si se cambia de pantalla con algo en cola, se ejecuta igual: ya lo decidiste.
    useEffect(() => () => {
        for (const x of colaRef.current) {
            clearTimeout(x.timer);
            resolver(x).catch(() => { /* queda pendiente en Para aprobar */ });
        }
        colaRef.current = [];
    }, []);

    // Cerrar la pestaña con algo en cola: el navegador pide confirmación.
    useEffect(() => {
        if (!enCola.length) return;
        const avisar = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
        window.addEventListener('beforeunload', avisar);
        return () => window.removeEventListener('beforeunload', avisar);
    }, [enCola.length]);

    return { enCola, encolar, deshacer, estaEnCola: (id: string) => enCola.some((x) => x.id === id) };
}

const TEXTO: Record<Resolucion, string> = {
    aprobar: 'Enviando a',
    editar: 'Enviando la versión editada a',
    rechazar: 'Rechazando la respuesta a',
};

export function AvisosDeshacer({ enCola, deshacer }: { enCola: EnCola[]; deshacer: (id: string) => void }) {
    if (!enCola.length) return null;
    return (
        <div className="avisos" role="status" aria-live="polite">
            {enCola.map((x) => (
                <div key={x.id} className={`aviso aviso-${x.tipo}`}>
                    <span>{TEXTO[x.tipo]} <strong>{x.destino}</strong>…</span>
                    <button className="aviso-deshacer" onClick={() => deshacer(x.id)}>Deshacer</button>
                    <span className="aviso-tiempo" style={{ animationDuration: `${DESHACER_MS}ms` }} aria-hidden="true" />
                </div>
            ))}
        </div>
    );
}

export const escribiendo = (el: EventTarget | null) =>
    el instanceof HTMLElement && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));
