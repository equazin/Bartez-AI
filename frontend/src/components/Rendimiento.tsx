// Rendimiento: en un solo lugar lo que antes eran tres pantallas que se
// pisaban (Métricas, Analítica y Bitácora), como pestañas.

import { useState } from 'react';
import { Dashboard } from './Dashboard.tsx';
import { Analitica } from './Analitica.tsx';
import { Bitacora } from './Bitacora.tsx';
import { PruebaModelos } from './PruebaModelos.tsx';

export type SeccionRendimiento = 'hoy' | 'informes' | 'bitacora' | 'modelos';

const SECCIONES: Array<{ id: SeccionRendimiento; etq: string; sub: string }> = [
    { id: 'hoy', etq: 'Hoy', sub: 'Resultados comerciales del día y la actividad de cada asistente.' },
    { id: 'informes', etq: 'Informes semanales', sub: 'El análisis de los lunes: diagnóstico y hasta 3 propuestas de ajuste.' },
    { id: 'bitacora', etq: 'Bitácora', sub: 'Cada paso de los asistentes: qué hicieron, cuánto tardaron y cuánto costaron.' },
    { id: 'modelos', etq: 'Prueba de modelos', sub: 'Tus correos reales, repetidos con el modelo de antes y el nuevo.' },
];

export function Rendimiento({ inicial = 'hoy' }: { inicial?: SeccionRendimiento }) {
    const [seccion, setSeccion] = useState<SeccionRendimiento>(inicial);
    const actual = SECCIONES.find((x) => x.id === seccion)!;
    return (
        <section className="rendimiento">
            <div className="acciones-header">
                <div>
                    <h2>Rendimiento</h2>
                    <p className="sub">{actual.sub}</p>
                </div>
                <div className="segmentos" role="tablist" aria-label="Sección">
                    {SECCIONES.map((x) => (
                        <button key={x.id} role="tab" aria-selected={seccion === x.id} className={seccion === x.id ? 'on' : ''} onClick={() => setSeccion(x.id)}>
                            {x.etq}
                        </button>
                    ))}
                </div>
            </div>
            <div className="rend-contenido">
                {seccion === 'hoy' && <Dashboard />}
                {seccion === 'informes' && <Analitica />}
                {seccion === 'bitacora' && <Bitacora />}
                {seccion === 'modelos' && <PruebaModelos />}
            </div>
        </section>
    );
}
