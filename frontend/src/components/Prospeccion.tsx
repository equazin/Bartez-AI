import { useState } from 'react';
import { Buscar } from './prospeccion/Buscar.tsx';
import { ListaProspectos } from './prospeccion/ListaProspectos.tsx';

type Sub = 'lista' | 'buscar';

export function Prospeccion() {
    const [sub, setSub] = useState<Sub>('lista');

    return (
        <section className="prospeccion">
            <div className="acciones-header">
                <h2>Prospección</h2>
                <div className="filtros-fecha">
                    <span className={sub === 'lista' ? 'on' : ''} onClick={() => setSub('lista')}>
                        Base de prospectos
                    </span>
                    <span className={sub === 'buscar' ? 'on' : ''} onClick={() => setSub('buscar')}>
                        Buscar nuevos
                    </span>
                </div>
            </div>
            {sub === 'lista' && <ListaProspectos />}
            {sub === 'buscar' && <Buscar />}
        </section>
    );
}
