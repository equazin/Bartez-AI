import { useCallback, useEffect, useMemo, useState } from 'react';
import {
    AccionPendiente,
    AsistenteEditable,
    LogEntry,
    PuntoSerie,
    listarAcciones,
    listarAsistentes,
    listarLogs,
    metricasHoy,
    resolverAccion,
    serieMetricas,
} from '../api/client.ts';

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
    mensajes: number;
}

type IrA = 'chat' | 'acciones' | 'asistentes' | 'dashboard' | 'bitacora';

export function Home({ irA }: { irA: (t: IrA) => void }) {
    const [acciones, setAcciones] = useState<AccionPendiente[]>([]);
    const [asistentes, setAsistentes] = useState<AsistenteEditable[]>([]);
    const [logs, setLogs] = useState<LogEntry[]>([]);
    const [negocio, setNegocio] = useState<MetricaNegocio | null>(null);
    const [sistema, setSistema] = useState<MetricaSistema[]>([]);
    const [serie, setSerie] = useState<PuntoSerie[]>([]);
    const [error, setError] = useState<string>();
    const [resolviendo, setResolviendo] = useState<string | null>(null);

    const cargar = useCallback(async () => {
        try {
            setError(undefined);
            const [ac, as, lg, m, sr] = await Promise.all([
                listarAcciones('pendiente'),
                listarAsistentes(),
                listarLogs({ limit: 40 }),
                metricasHoy(),
                serieMetricas(7),
            ]);
            setAcciones(ac.acciones);
            setAsistentes(as.asistentes);
            setLogs(lg.logs);
            setNegocio(m.negocio as MetricaNegocio | null);
            setSistema(m.sistema as MetricaSistema[]);
            setSerie(sr.serie);
        } catch (e) {
            setError((e as Error).message);
        }
    }, []);

    useEffect(() => {
        cargar();
        const t = setInterval(cargar, 30_000);
        return () => clearInterval(t);
    }, [cargar]);

    async function resolver(a: AccionPendiente, tipo: 'aprobar' | 'rechazar') {
        setResolviendo(a.id);
        try {
            await resolverAccion(a.id, tipo);
            await cargar();
        } catch (e) {
            setError((e as Error).message);
        } finally {
            setResolviendo(null);
        }
    }

    // --- Datos derivados ---
    const costoHoy = sistema.reduce((s, m) => s + Number(m.costo_usd_total ?? 0), 0);
    const tokensHoy = sistema.reduce((s, m) => s + (m.tokens_totales ?? 0), 0);

    // Estado por asistente: busy si tuvo log en último minuto; on si activo sin log reciente; off si dormido
    const ahora = Date.now();
    const ultimoLog = useMemo(() => {
        const m = new Map<string, number>();
        for (const l of logs) {
            const t = new Date(l.creado_en).getTime();
            const prev = m.get(l.asistente_id) ?? 0;
            if (t > prev) m.set(l.asistente_id, t);
        }
        return m;
    }, [logs]);
    const costoPorAsistente = useMemo(() => {
        const m = new Map<string, number>();
        for (const s of sistema) m.set(s.asistente_id, Number(s.costo_usd_total ?? 0));
        return m;
    }, [sistema]);

    function estadoAsistente(a: AsistenteEditable): 'busy' | 'on' | 'off' {
        if (!a.activo) return 'off';
        const t = ultimoLog.get(a.id);
        if (t && ahora - t < 60_000) return 'busy';
        return 'on';
    }

    const asistentesOrdenados = useMemo(() => {
        return [...asistentes].sort((a, b) => {
            const ea = estadoAsistente(a);
            const eb = estadoAsistente(b);
            const rank = { busy: 0, on: 1, off: 2 } as const;
            if (rank[ea] !== rank[eb]) return rank[ea] - rank[eb];
            return a.nombre.localeCompare(b.nombre);
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [asistentes, ultimoLog]);

    // En curso: logs de último minuto (heurística)
    const enCurso = useMemo(() => {
        return logs
            .filter((l) => ahora - new Date(l.creado_en).getTime() < 60_000)
            .slice(0, 5);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [logs]);

    // Hecho hoy: logs de hoy, excluidos los "en curso"
    const hoyStr = new Date().toISOString().slice(0, 10);
    const hechoHoy = useMemo(() => {
        return logs.filter(
            (l) => l.creado_en.slice(0, 10) === hoyStr && ahora - new Date(l.creado_en).getTime() >= 60_000,
        );
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [logs, hoyStr]);

    // Alertas: acciones esperando > 4h, errores recientes, costo alto de un asistente
    const alertas = useMemo(() => {
        const out: { tipo: 'hi' | 'warn' | 'info'; titulo: string; fuente: string }[] = [];
        const viejas = acciones.filter(
            (a) => ahora - new Date(a.creado_en).getTime() > 4 * 3600_000,
        );
        if (viejas.length > 0) {
            out.push({
                tipo: 'warn',
                titulo: `${viejas.length} acción${viejas.length > 1 ? 'es' : ''} esperando hace más de 4 h`,
                fuente: 'Revisar en Acciones',
            });
        }
        const errores = logs.filter((l) => l.error).slice(0, 1);
        for (const e of errores) {
            out.push({
                tipo: 'warn',
                titulo: `Error reciente: ${e.error?.slice(0, 80)}`,
                fuente: `${e.asistente_nombre ?? 'Asistente'} · ${new Date(e.creado_en).toLocaleTimeString('es-AR')}`,
            });
        }
        // Asistente más caro de hoy
        const top = [...sistema].sort((a, b) => b.costo_usd_total - a.costo_usd_total)[0];
        if (top && top.costo_usd_total > 0) {
            out.push({
                tipo: 'hi',
                titulo: `${top.nombre ?? 'Asistente'} lleva USD ${top.costo_usd_total.toFixed(4)} hoy`,
                fuente: `${top.mensajes} mensajes procesados`,
            });
        }
        return out.slice(0, 3);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [acciones, logs, sistema]);

    // Chart SVG dimensions
    const maxTokens = Math.max(1, ...serie.map((s) => s.tokens));
    const maxCosto = Math.max(0.0001, ...serie.map((s) => s.costo_usd));

    return (
        <section className="ops">
            <div className="ops-top">
                <h2>Panel operativo</h2>
                <div className="filtros-fecha">
                    <span className="on">Hoy</span>
                    <span>7 días</span>
                    <span>30 días</span>
                </div>
            </div>

            {error && <p className="error">Error: {error}</p>}

            {/* KPIs */}
            <div className="ops-kpis">
                <KPI label="Propuestas enviadas" val={negocio?.propuestas_enviadas ?? 0} />
                <KPI label="Ventas cerradas" val={negocio?.ventas_cerradas ?? 0} accent="ok" />
                <KPI label="Prospectos calificados" val={negocio?.prospectos_calificados ?? 0} />
                <KPI label="Costo IA · hoy" val={`$${costoHoy.toFixed(4)}`} sub={`${tokensHoy.toLocaleString('es-AR')} tokens`} />
            </div>

            {/* Kanban */}
            <div className="ops-kanban">
                <div className="k-col alerta">
                    <div className="k-head">
                        <h3>Esperando tu ok</h3>
                        <span className="cnt">{acciones.length}</span>
                    </div>
                    {acciones.length === 0 ? (
                        <p className="vacio-mini">Nada pendiente.</p>
                    ) : (
                        acciones.slice(0, 3).map((a) => (
                            <div key={a.id} className="k-card-a">
                                <div className="tag">{a.asistente_nombre ?? 'asistente'} · {a.accion}</div>
                                <div className="title">{tituloAccion(a)}</div>
                                <div className="snip">{snippetAccion(a)}</div>
                                <div className="meta">Hace {haceCuanto(a.creado_en)}</div>
                                <div className="btns">
                                    <button
                                        className="ok"
                                        disabled={resolviendo === a.id}
                                        onClick={() => resolver(a, 'aprobar')}
                                    >
                                        Aprobar
                                    </button>
                                    <button className="ed" onClick={() => irA('acciones')}>
                                        Editar
                                    </button>
                                    <button
                                        className="no"
                                        disabled={resolviendo === a.id}
                                        onClick={() => resolver(a, 'rechazar')}
                                    >
                                        Rechazar
                                    </button>
                                </div>
                            </div>
                        ))
                    )}
                    {acciones.length > 3 && (
                        <button className="ver-todas" onClick={() => irA('acciones')}>
                            Ver las {acciones.length} →
                        </button>
                    )}
                </div>

                <div className="k-col">
                    <div className="k-head">
                        <h3>En curso</h3>
                        <span className="cnt">{enCurso.length}</span>
                    </div>
                    {enCurso.length === 0 ? (
                        <p className="vacio-mini">Sin actividad ahora.</p>
                    ) : (
                        enCurso.map((l) => (
                            <div key={l.id} className="k-card-b">
                                <div className={`tag ${slugArea(l.asistente_nombre)}`}>{l.asistente_nombre ?? '—'}</div>
                                <div className="title">{textoDeLog(l)}</div>
                                <div className="meta">
                                    {new Date(l.creado_en).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })}
                                </div>
                            </div>
                        ))
                    )}
                </div>

                <div className="k-col">
                    <div className="k-head">
                        <h3>Hecho hoy</h3>
                        <span className="cnt">{hechoHoy.length}</span>
                    </div>
                    {hechoHoy.slice(0, 4).map((l) => (
                        <div key={l.id} className="k-card-b done">
                            <div className={`tag ${slugArea(l.asistente_nombre)}`}>{l.asistente_nombre ?? '—'}</div>
                            <div className="title">{textoDeLog(l)}</div>
                            <div className="meta">
                                {new Date(l.creado_en).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })}
                                {l.costo_usd ? ` · $${l.costo_usd.toFixed(4)}` : ''}
                            </div>
                        </div>
                    ))}
                    {hechoHoy.length > 4 && (
                        <button className="ver-todas" onClick={() => irA('bitacora')}>
                            + {hechoHoy.length - 4} más
                        </button>
                    )}
                </div>

                <div className="k-col m-col">
                    <div className="k-head">
                        <h3>Métricas · hoy</h3>
                        <span className="cnt">live</span>
                    </div>
                    <div className="m-row"><span className="l">Ventas</span><span className="v ok">{negocio?.ventas_cerradas ?? 0}</span></div>
                    <div className="m-row"><span className="l">Propuestas</span><span className="v">{negocio?.propuestas_enviadas ?? 0}</span></div>
                    <div className="m-row"><span className="l">Prospectos</span><span className="v">{negocio?.prospectos_calificados ?? 0}</span></div>
                    <div className="m-row"><span className="l">Tokens</span><span className="v small">{tokensHoy.toLocaleString('es-AR')}</span></div>
                    <div className="m-row"><span className="l">Costo IA</span><span className="v small accent">${costoHoy.toFixed(4)}</span></div>
                    <button className="ver-todas" onClick={() => irA('dashboard')} style={{ marginTop: 8 }}>
                        Editar métricas →
                    </button>
                </div>
            </div>

            {/* Mid: asistentes + chart */}
            <div className="ops-mid">
                <div className="ops-panel">
                    <div className="ph">
                        <h4>Asistentes</h4>
                        <span className="sub">
                            {asistentes.filter((a) => a.activo).length} activos · {asistentes.filter((a) => !a.activo).length} dormidos
                        </span>
                    </div>
                    <div className="a-grid">
                        {asistentesOrdenados.map((a) => {
                            const est = estadoAsistente(a);
                            const c = costoPorAsistente.get(a.id) ?? 0;
                            return (
                                <div key={a.id} className={`a-item ${est}`} onClick={() => irA('asistentes')}>
                                    <span className={`d ${est}`}></span>
                                    <span className="name">
                                        {a.nombre}
                                        {a.activo && <span className="model">{a.modelo}</span>}
                                    </span>
                                    <span className="cost">{c > 0 ? `$${c.toFixed(3)}` : est === 'off' ? '—' : '$0.000'}</span>
                                </div>
                            );
                        })}
                    </div>
                    <div className="a-legend">
                        <span><i className="lg busy"></i>trabajando</span>
                        <span><i className="lg on"></i>activo</span>
                        <span><i className="lg off"></i>dormido</span>
                    </div>
                </div>

                <div className="ops-panel">
                    <div className="ph">
                        <h4>Actividad · últimos 7 días</h4>
                        <span className="sub">Tokens · costo USD</span>
                    </div>
                    <ChartSerie serie={serie} maxTokens={maxTokens} maxCosto={maxCosto} />
                    <div className="chart-leg">
                        <span><i className="l-costo"></i>Costo USD</span>
                        <span><i className="l-tokens"></i>Tokens</span>
                    </div>
                </div>
            </div>

            {/* Alertas */}
            {alertas.length > 0 && (
                <div className="ops-alerts">
                    {alertas.map((a, i) => (
                        <div key={i} className={`ops-alert ${a.tipo}`}>
                            <div className="txt">
                                <strong>{a.titulo}</strong>
                                <div className="who">{a.fuente}</div>
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </section>
    );
}

function KPI({ label, val, sub, accent }: { label: string; val: string | number; sub?: string; accent?: 'ok' | 'warn' }) {
    return (
        <div className="ops-kpi">
            <div className="lbl">{label}</div>
            <div className="row">
                <div className={`val ${accent ?? ''}`}>{val}</div>
                {sub && <div className="sub">{sub}</div>}
            </div>
        </div>
    );
}

function ChartSerie({ serie, maxTokens, maxCosto }: { serie: PuntoSerie[]; maxTokens: number; maxCosto: number }) {
    if (serie.length === 0) {
        return <p className="vacio-mini">Sin datos todavía.</p>;
    }
    const w = 600;
    const h = 180;
    const step = w / Math.max(1, serie.length - 1);
    const pTokens = serie.map((s, i) => `${i * step},${h - (s.tokens / maxTokens) * (h - 20)}`).join(' ');
    const pCosto = serie.map((s, i) => `${i * step},${h - (s.costo_usd / maxCosto) * (h - 20)}`).join(' ');
    const areaCosto = `M0,${h} L${pCosto.split(' ').join(' L')} L${w},${h} Z`;
    const last = serie[serie.length - 1]!;
    return (
        <svg viewBox={`0 0 ${w} ${h + 20}`} preserveAspectRatio="none" className="ops-chart">
            <defs>
                <linearGradient id="ops-grad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#f0ad4e" stopOpacity="0.2" />
                    <stop offset="100%" stopColor="#f0ad4e" stopOpacity="0" />
                </linearGradient>
            </defs>
            {[0.25, 0.5, 0.75].map((f) => (
                <line key={f} x1="0" y1={h * f} x2={w} y2={h * f} stroke="var(--borde)" />
            ))}
            <path d={areaCosto} fill="url(#ops-grad)" />
            <polyline fill="none" stroke="var(--acento)" strokeWidth="2" points={pCosto} />
            <polyline fill="none" stroke="#4caf80" strokeWidth="2" strokeDasharray="3,3" points={pTokens} />
            {serie.map((s, i) => (
                <text
                    key={s.fecha}
                    x={i === serie.length - 1 ? i * step - 20 : i * step}
                    y={h + 15}
                    fontSize="10"
                    fill="var(--sutil)"
                    fontFamily="monospace"
                >
                    {s.fecha.slice(8, 10)}/{s.fecha.slice(5, 7)}
                </text>
            ))}
            {last.costo_usd > 0 && (
                <circle cx={(serie.length - 1) * step} cy={h - (last.costo_usd / maxCosto) * (h - 20)} r="4" fill="var(--acento)" />
            )}
        </svg>
    );
}

// --- Helpers ---
function tituloAccion(a: AccionPendiente): string {
    const p = a.payload as Record<string, unknown>;
    if (typeof p.asunto === 'string') return p.asunto;
    if (typeof p.para === 'string') return `→ ${p.para}`;
    return a.accion;
}
function snippetAccion(a: AccionPendiente): string {
    const p = a.payload as Record<string, unknown>;
    if (typeof p.cuerpo === 'string') return p.cuerpo.slice(0, 100) + (p.cuerpo.length > 100 ? '…' : '');
    return '';
}
function haceCuanto(iso: string): string {
    const ms = Date.now() - new Date(iso).getTime();
    const min = Math.floor(ms / 60000);
    if (min < 1) return 'un momento';
    if (min < 60) return `${min} min`;
    const h = Math.floor(min / 60);
    if (h < 24) return `${h} h`;
    return `${Math.floor(h / 24)} días`;
}
function slugArea(nombre: string | null): string {
    if (!nombre) return '';
    return nombre.toLowerCase().replace(/[^a-z]/g, '').slice(0, 8);
}
function textoDeLog(l: LogEntry): string {
    if (l.error) return `Error: ${l.error.slice(0, 60)}`;
    const s = (l.salida as { respuesta?: string } | null)?.respuesta;
    if (typeof s === 'string' && s.length > 0) return s.slice(0, 80) + (s.length > 80 ? '…' : '');
    const e = (l.entrada as { texto?: string } | null)?.texto;
    if (typeof e === 'string') return e.slice(0, 80);
    return `${(l.tokens_in ?? 0) + (l.tokens_out ?? 0)} tokens procesados`;
}
