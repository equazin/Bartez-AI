// Gráficos chicos del Inicio, sin librerías: una línea de tendencia para los
// indicadores, columnas apiladas por día y barras del embudo.
// Colores: --serie-1 / --serie-2 (validados para claro y oscuro); los textos
// siempre en tinta de texto, nunca en el color de la serie.

import { useState } from 'react';

const TZ = 'America/Argentina/Buenos_Aires';

function diaLargo(d: string): string {
    return new Date(`${d}T12:00:00-03:00`).toLocaleDateString('es-AR', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' });
}
function diaEje(d: string): string {
    return new Date(`${d}T12:00:00-03:00`).toLocaleDateString('es-AR', { timeZone: TZ, day: 'numeric', month: 'numeric' });
}

// Máximo "redondo" para el eje: 1, 2, 5, 10, 20, 50…
function techo(max: number): number {
    if (max <= 0) return 1;
    const base = 10 ** Math.floor(Math.log10(max));
    for (const m of [1, 2, 5, 10]) if (m * base >= max) return m * base;
    return 10 * base;
}

export function Sparkline({ valores, titulo }: { valores: number[]; titulo: string }) {
    if (valores.length < 2) return null;
    const max = Math.max(...valores, 1);
    const paso = 100 / (valores.length - 1);
    const y = (v: number) => 28 - (v / max) * 26;
    const pts = valores.map((v, i) => `${(i * paso).toFixed(2)},${y(v).toFixed(2)}`);
    const ultimo = valores[valores.length - 1]!;
    // El punto de hoy va en HTML: dentro del SVG estirado se deformaría.
    return (
        <span className="spark">
            <svg className="sparkline" viewBox="0 0 100 30" preserveAspectRatio="none" role="img" aria-label={titulo}>
                <polygon points={`0,30 ${pts.join(' ')} 100,30`} className="spark-area" />
                <polyline points={pts.join(' ')} className="spark-linea" vectorEffect="non-scaling-stroke" />
            </svg>
            <span className="spark-hoy" style={{ top: `${(y(ultimo) / 30) * 100}%` }} aria-hidden="true" />
        </span>
    );
}

export interface Serie { nombre: string; valores: number[]; clase: 'serie-1' | 'serie-2' }

export function ColumnasApiladas({ dias, series, unidad, titulo = diaLargo, eje = diaEje, cadaEje = 7, anchas = false }: {
    dias: string[]; series: Serie[]; unidad: string;
    // Cómo se nombra cada columna en el tooltip y en el eje (días por defecto).
    titulo?: (d: string) => string; eje?: (d: string) => string; cadaEje?: number; anchas?: boolean;
}) {
    const [foco, setFoco] = useState<number | null>(null);
    const totales = dias.map((_, i) => series.reduce((s, x) => s + (x.valores[i] ?? 0), 0));
    const max = techo(Math.max(...totales));
    const marcas = [max, max / 2, 0];
    const promedio = totales.reduce((a, b) => a + b, 0) / (totales.length || 1);
    return (
        <div className={`columnas ${anchas ? 'anchas' : ''}`}>
            <div className="leyenda" aria-hidden="true">
                {series.map((s) => (
                    <span key={s.nombre}><i className={`muestra ${s.clase}`} />{s.nombre}</span>
                ))}
            </div>
            <div className="columnas-cuerpo">
                <div className="columnas-eje" aria-hidden="true">
                    {marcas.map((m) => <span key={m}>{Number.isInteger(m) ? m : m.toFixed(1)}</span>)}
                </div>
                <div className="columnas-plot" onMouseLeave={() => setFoco(null)}>
                    {marcas.map((m) => <div key={m} className="grilla-linea" style={{ bottom: `${(m / max) * 100}%` }} />)}
                    {promedio > 0 && (
                        <div className="promedio-linea" style={{ bottom: `${(promedio / max) * 100}%` }}>
                            <span>prom. {promedio.toLocaleString('es-AR', { maximumFractionDigits: 1 })}</span>
                        </div>
                    )}
                    {dias.map((d, i) => (
                        <div
                            key={d}
                            className={`columna ${foco === i ? 'foco' : ''}`}
                            onMouseEnter={() => setFoco(i)}
                            onFocus={() => setFoco(i)}
                            onBlur={() => setFoco(null)}
                            tabIndex={0}
                            aria-label={`${titulo(d)}: ${series.map((s) => `${s.nombre} ${s.valores[i] ?? 0}`).join(', ')}`}
                        >
                            <div className="columna-pila" style={{ height: `${(totales[i]! / max) * 100}%` }}>
                                {series.map((s) => {
                                    const v = s.valores[i] ?? 0;
                                    return v > 0 ? <div key={s.nombre} className={`segmento ${s.clase}`} style={{ flexGrow: v }} /> : null;
                                })}
                            </div>
                        </div>
                    ))}
                    {foco != null && (
                        <div className={`tooltip ${foco > dias.length * 0.6 ? 'izq' : ''}`} style={{ left: `${((foco + 0.5) / dias.length) * 100}%` }}>
                            <strong>{titulo(dias[foco]!)}</strong>
                            {series.map((s) => (
                                <span key={s.nombre} className="tooltip-fila"><i className={`muestra ${s.clase}`} />{s.nombre}<b>{s.valores[foco] ?? 0}</b></span>
                            ))}
                            <span className="tooltip-fila total">Total<b>{totales[foco]} {unidad}</b></span>
                        </div>
                    )}
                </div>
            </div>
            <div className="columnas-x" aria-hidden="true">
                {dias.map((d, i) => <span key={d}>{i % cadaEje === (dias.length - 1) % cadaEje ? eje(d) : ''}</span>)}
            </div>
        </div>
    );
}

export function BarrasEmbudo({ pasos }: { pasos: Array<{ etiqueta: string; valor: number }> }) {
    const max = Math.max(...pasos.map((p) => p.valor), 1);
    return (
        <div className="embudo" role="table" aria-label="Embudo de prospectos">
            <div className="embudo-fila embudo-titulos" role="row">
                <span role="columnheader">Etapa</span>
                <span role="columnheader" aria-hidden="true" />
                <span role="columnheader">Cant.</span>
                <span role="columnheader">Pasa</span>
            </div>
            {pasos.map((p, i) => {
                const previo = i > 0 ? pasos[i - 1]!.valor : null;
                const conv = previo ? Math.round((p.valor / previo) * 100) : null;
                return (
                    <div key={p.etiqueta} className="embudo-fila" role="row" title={`${p.etiqueta}: ${p.valor}${conv != null ? ` (${conv}% del paso anterior)` : ''}`}>
                        <span className="embudo-etq" role="cell">{p.etiqueta}</span>
                        <span className="embudo-barra" role="cell"><span style={{ width: `${Math.max((p.valor / max) * 100, p.valor ? 1.5 : 0)}%` }} /></span>
                        <span className="embudo-num" role="cell">{p.valor.toLocaleString('es-AR')}</span>
                        <span className="embudo-conv" role="cell">{conv != null ? `${conv}%` : '—'}</span>
                    </div>
                );
            })}
        </div>
    );
}
