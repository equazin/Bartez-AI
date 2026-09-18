import { useCallback, useEffect, useState } from 'react';
import {
    AccionPendiente,
    LogEntry,
    listarAcciones,
    listarLogs,
    metricasHoy,
} from '../api/client.ts';
import { Chat } from './Chat.tsx';

interface MetricaNegocio {
    propuestas_enviadas: number;
    ventas_cerradas: number;
    prospectos_calificados: number;
}

interface MetricaSistema {
    asistente_id: string;
    nombre?: string;
    tokens_totales: number;
    costo_usd_total: number;
}

type IrA = 'chat' | 'acciones' | 'asistentes' | 'dashboard' | 'bitacora';

export function Home({ irA }: { irA: (t: IrA) => void }) {
    const [acciones, setAcciones] = useState<AccionPendiente[]>([]);
    const [negocio, setNegocio] = useState<MetricaNegocio | null>(null);
    const [sistema, setSistema] = useState<MetricaSistema[]>([]);
    const [logs, setLogs] = useState<LogEntry[]>([]);
    const [error, setError] = useState<string>();

    const cargar = useCallback(async () => {
        try {
            setError(undefined);
            const [ac, m, lg] = await Promise.all([
                listarAcciones('pendiente'),
                metricasHoy(),
                listarLogs({ limit: 5 }),
            ]);
            setAcciones(ac.acciones.slice(0, 5));
            setNegocio(m.negocio as MetricaNegocio | null);
            setSistema(m.sistema as MetricaSistema[]);
            setLogs(lg.logs);
        } catch (e) {
            setError((e as Error).message);
        }
    }, []);

    useEffect(() => {
        cargar();
        const t = setInterval(cargar, 30_000); // refresco cada 30s
        return () => clearInterval(t);
    }, [cargar]);

    const costoHoy = sistema.reduce((s, m) => s + Number(m.costo_usd_total ?? 0), 0);
    const tokensHoy = sistema.reduce((s, m) => s + (m.tokens_totales ?? 0), 0);
    const mensajesHoy = sistema.length; // placeholder, ver más abajo

    return (
        <section className="home">
            {error && <p className="error">Error: {error}</p>}

            {/* Fila superior — resumen de lo urgente */}
            <div className="home-grid">
                <button className="home-tile alerta" onClick={() => irA('acciones')}>
                    <span className="tile-label">Acciones pendientes</span>
                    <span className="tile-valor">{acciones.length}</span>
                    <span className="tile-detalle">
                        {acciones.length === 0 ? 'Todo al día' : 'Clic para revisar'}
                    </span>
                </button>

                <button className="home-tile" onClick={() => irA('dashboard')}>
                    <span className="tile-label">Ventas hoy</span>
                    <span className="tile-valor">{negocio?.ventas_cerradas ?? 0}</span>
                    <span className="tile-detalle">
                        {negocio?.propuestas_enviadas ?? 0} propuestas · {negocio?.prospectos_calificados ?? 0} prospectos
                    </span>
                </button>

                <button className="home-tile" onClick={() => irA('dashboard')}>
                    <span className="tile-label">Costo IA hoy</span>
                    <span className="tile-valor">USD {costoHoy.toFixed(4)}</span>
                    <span className="tile-detalle">
                        {tokensHoy.toLocaleString('es-AR')} tokens · {mensajesHoy} asistentes activos
                    </span>
                </button>
            </div>

            {/* Fila media — acciones pendientes + últimos logs, lado a lado */}
            <div className="home-cols">
                <div className="home-col">
                    <div className="acciones-header">
                        <h2>Acciones esperándote</h2>
                        <button className="secundario" onClick={() => irA('acciones')}>
                            Ver todas
                        </button>
                    </div>
                    {acciones.length === 0 ? (
                        <p className="vacio">Nada esperando aprobación.</p>
                    ) : (
                        <ul className="lista-mini">
                            {acciones.map((a) => (
                                <li key={a.id} onClick={() => irA('acciones')}>
                                    <span className="tag tipo">{a.accion}</span>
                                    <span className="lista-mini-txt">
                                        {a.asistente_nombre ?? 'asistente'}
                                    </span>
                                    <span className="ts">
                                        {new Date(a.creado_en).toLocaleTimeString('es-AR', {
                                            hour: '2-digit',
                                            minute: '2-digit',
                                        })}
                                    </span>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>

                <div className="home-col">
                    <div className="acciones-header">
                        <h2>Actividad reciente</h2>
                        <button className="secundario" onClick={() => irA('bitacora')}>
                            Ver bitácora
                        </button>
                    </div>
                    {logs.length === 0 ? (
                        <p className="vacio">Sin actividad todavía.</p>
                    ) : (
                        <ul className="lista-mini">
                            {logs.map((l) => (
                                <li key={l.id} onClick={() => irA('bitacora')}>
                                    <span className={`tag ${l.error ? 'peligro' : ''}`}>
                                        {l.asistente_nombre ?? '—'}
                                    </span>
                                    <span className="lista-mini-txt">
                                        {l.error ? `error: ${l.error.slice(0, 60)}` : `${(l.tokens_in ?? 0) + (l.tokens_out ?? 0)} tokens`}
                                    </span>
                                    <span className="ts">
                                        {new Date(l.creado_en).toLocaleTimeString('es-AR', {
                                            hour: '2-digit',
                                            minute: '2-digit',
                                        })}
                                    </span>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            </div>

            {/* Chat abajo — mismo componente, sin duplicar lógica */}
            <div className="home-chat">
                <h2>Chat con el copiloto</h2>
                <Chat />
            </div>
        </section>
    );
}
