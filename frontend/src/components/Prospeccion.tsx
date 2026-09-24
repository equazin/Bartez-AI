import { useState } from 'react';
import { Buscar } from './prospeccion/Buscar.tsx';
import { ListaProspectos } from './prospeccion/ListaProspectos.tsx';

type Sub = 'lista' | 'buscar';

export function Prospeccion() {
    const [sub, setSub] = useState<Sub>('lista');

    return (
        <section className="prospeccion">
            <div className="acciones-header">
                <div>
                    <h2>Prospección</h2>
                    <p className="sub">Tu base de prospectos y la búsqueda de empresas nuevas que encajan con Bartez.</p>
                </div>
                <div className="segmentos" role="tablist" aria-label="Sección">
                    <button role="tab" aria-selected={sub === 'lista'} className={sub === 'lista' ? 'on' : ''} onClick={() => setSub('lista')}>
                        Base de prospectos
                    </button>
                    <button role="tab" aria-selected={sub === 'buscar'} className={sub === 'buscar' ? 'on' : ''} onClick={() => setSub('buscar')}>
                        Buscar nuevos
                    </button>
                </div>
            </div>
            {sub === 'lista' && <ListaProspectos />}
            {sub === 'buscar' && <Buscar />}
        </section>
    );
}
