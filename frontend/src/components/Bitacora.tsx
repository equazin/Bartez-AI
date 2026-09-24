import { Fragment, useCallback, useEffect, useState } from 'react';
import { listarAsistentes, listarLogs, LogEntry, AsistenteEditable } from '../api/client.ts';

export function Bitacora() {
    const [logs, setLogs] = useState<LogEntry[]>([]);
    const [asistentes, setAsistentes] = useState<AsistenteEditable[]>([]);
    const [filtro, setFiltro] = useState<string>('');
    const [error, setError] = useState<string>();
    const [expandido, setExpandido] = useState<string | null>(null);

    const cargar = useCallback(async () => {
        try {
            setError(undefined);
            const { logs } = await listarLogs({
                asistente_id: filtro || undefined,
                limit: 100,
            });
            setLogs(logs);
        } catch (e) {
            setError((e as Error).message);
        }
    }, [filtro]);

    useEffect(() => {
        cargar();
    }, [cargar]);

    useEffect(() => {
        listarAsistentes().then((d) => setAsistentes(d.asistentes)).catch(() => {});
    }, []);

    return (
        <section className="bitacora">
            <div className="acciones-header">
                <div>
                    <h2>Bitácora</h2>
                    <p className="sub">Los últimos 100 pasos de los asistentes: qué hicieron, cuánto tardaron y cuánto costaron.</p>
                </div>
                <div className="filtros">
                    <select value={filtro} onChange={(e) => setFiltro(e.target.value)}>
                        <option value="">Todos los asistentes</option>
                        {asistentes.map((a) => (
                            <option key={a.id} value={a.id}>
                                {a.nombre}
                            </option>
                        ))}
                    </select>
                    <button className="secundario" onClick={cargar}>
                        Actualizar
                    </button>
                </div>
            </div>

            {error && <p className="error">Error: {error}</p>}
            {logs.length === 0 && !error && <p className="vacio">Sin registros.</p>}

            <div className="panel panel-tabla">
            <table className="log-table">
                <thead>
                    <tr>
                        <th>Hora</th>
                        <th>Asistente</th>
                        <th className="num">Tokens</th>
                        <th className="num">USD</th>
                        <th className="num">Tiempo</th>
                        <th></th>
                    </tr>
                </thead>
                <tbody>
                    {logs.map((l) => (
                        <Fragment key={l.id}>
                            <tr
                                className={l.error ? 'log-error' : ''}
                                onClick={() => setExpandido(expandido === l.id ? null : l.id)}
                            >
                                <td className="ts">{new Date(l.creado_en).toLocaleTimeString('es-AR')}</td>
                                <td>{l.asistente_nombre ?? l.asistente_id.slice(0, 8)}</td>
                                <td className="num">{((l.tokens_in ?? 0) + (l.tokens_out ?? 0)).toLocaleString('es-AR')}</td>
                                <td className="num">{(l.costo_usd ?? 0).toFixed(4)}</td>
                                <td className="num">{l.duracion_ms != null ? `${(l.duracion_ms / 1000).toLocaleString('es-AR', { maximumFractionDigits: 1 })} s` : '—'}</td>
                                <td className="log-flecha" aria-hidden="true">{expandido === l.id ? '▾' : '▸'}</td>
                            </tr>
                            {expandido === l.id && (
                                <tr className="log-detalle-row">
                                    <td colSpan={6}>
                                        {l.error && (
                                            <div className="log-bloque log-bloque-error">
                                                <strong>Error:</strong> {l.error}
                                            </div>
                                        )}
                                        <div className="log-bloque">
                                            <strong>Entrada</strong>
                                            <pre>{JSON.stringify(l.entrada, null, 2)}</pre>
                                        </div>
                                        <div className="log-bloque">
                                            <strong>Salida</strong>
                                            <pre>{JSON.stringify(l.salida, null, 2)}</pre>
                                        </div>
                                    </td>
                                </tr>
                            )}
                        </Fragment>
                    ))}
                </tbody>
            </table>
            </div>
        </section>
    );
}
