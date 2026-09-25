import { useEffect, useState } from 'react';
import { guardarMetricasNegocio, metricasHoy } from '../api/client.ts';

interface MetricaSistema {
    asistente_id: string;
    nombre?: string;
    conversaciones: number;
    mensajes: number;
    acciones_aprobadas: number;
    acciones_editadas: number;
    acciones_rechazadas: number;
    tokens_totales: number;
    costo_usd_total: number;
}

interface MetricaNegocio {
    propuestas_enviadas: number;
    ventas_cerradas: number;
    prospectos_calificados: number;
    notas?: string;
}

export function Dashboard() {
    const [sistema, setSistema] = useState<MetricaSistema[]>([]);
    const [negocio, setNegocio] = useState<MetricaNegocio | null>(null);
    const [error, setError] = useState<string>();
    const [editando, setEditando] = useState(false);
    const [borrador, setBorrador] = useState<MetricaNegocio>({
        propuestas_enviadas: 0,
        ventas_cerradas: 0,
        prospectos_calificados: 0,
        notas: '',
    });
    const [guardando, setGuardando] = useState(false);

    async function cargar() {
        try {
            setError(undefined);
            const d = await metricasHoy();
            setSistema(d.sistema as MetricaSistema[]);
            setNegocio(d.negocio as MetricaNegocio | null);
        } catch (e) {
            setError((e as Error).message);
        }
    }

    useEffect(() => {
        cargar();
    }, []);

    function abrirEdicion() {
        setBorrador({
            propuestas_enviadas: negocio?.propuestas_enviadas ?? 0,
            ventas_cerradas: negocio?.ventas_cerradas ?? 0,
            prospectos_calificados: negocio?.prospectos_calificados ?? 0,
            notas: negocio?.notas ?? '',
        });
        setEditando(true);
    }

    async function guardar() {
        setGuardando(true);
        try {
            await guardarMetricasNegocio(borrador);
            setEditando(false);
            await cargar();
        } catch (e) {
            setError((e as Error).message);
        } finally {
            setGuardando(false);
        }
    }

    return (
        <section className="dashboard">
            <div className="acciones-header">
                <div>
                    <h2>Métricas</h2>
                    <p className="sub">Resultados comerciales del día (los cargás vos) y la actividad de cada asistente.</p>
                </div>
            </div>
            <div className="metrica-exito panel">
                <div className="panel-cab">
                    <h3>Resultados de hoy</h3>
                    {!editando && (
                        <button className="secundario" onClick={abrirEdicion}>
                            {negocio ? 'Editar' : 'Cargar'}
                        </button>
                    )}
                </div>

                {!editando ? (
                    negocio ? (
                        <>
                            <div className="tiles">
                                <div>
                                    <span className="valor">{negocio.propuestas_enviadas}</span>
                                    <span className="etiqueta">propuestas enviadas</span>
                                </div>
                                <div>
                                    <span className="valor">{negocio.ventas_cerradas}</span>
                                    <span className="etiqueta">ventas cerradas</span>
                                </div>
                                <div>
                                    <span className="valor">{negocio.prospectos_calificados}</span>
                                    <span className="etiqueta">prospectos calificados</span>
                                </div>
                            </div>
                            {negocio.notas && <p className="notas-negocio">📝 {negocio.notas}</p>}
                        </>
                    ) : (
                        <p className="vacio">Sin datos todavía — clic en Cargar para registrar el día.</p>
                    )
                ) : (
                    <div className="edit-metricas">
                        <div className="edit-metricas-grid">
                            <label>
                                Propuestas enviadas
                                <input
                                    type="number"
                                    min={0}
                                    value={borrador.propuestas_enviadas}
                                    onChange={(e) =>
                                        setBorrador({ ...borrador, propuestas_enviadas: Number(e.target.value) })
                                    }
                                />
                            </label>
                            <label>
                                Ventas cerradas
                                <input
                                    type="number"
                                    min={0}
                                    value={borrador.ventas_cerradas}
                                    onChange={(e) =>
                                        setBorrador({ ...borrador, ventas_cerradas: Number(e.target.value) })
                                    }
                                />
                            </label>
                            <label>
                                Prospectos calificados
                                <input
                                    type="number"
                                    min={0}
                                    value={borrador.prospectos_calificados}
                                    onChange={(e) =>
                                        setBorrador({ ...borrador, prospectos_calificados: Number(e.target.value) })
                                    }
                                />
                            </label>
                        </div>
                        <label>
                            Notas (opcional)
                            <textarea
                                value={borrador.notas}
                                onChange={(e) => setBorrador({ ...borrador, notas: e.target.value })}
                                rows={2}
                            />
                        </label>
                        <div className="accion-acciones">
                            <button className="btn-primario" onClick={guardar} disabled={guardando}>
                                {guardando ? 'Guardando…' : 'Guardar'}
                            </button>
                            <button className="secundario" onClick={() => setEditando(false)}>
                                Cancelar
                            </button>
                        </div>
                    </div>
                )}
            </div>

            <div className="metrica-sistema panel">
                <div className="panel-cab"><h3>Actividad de los asistentes hoy</h3></div>
                {error && <p className="error">Error: {error}</p>}
                {sistema.length === 0 ? (
                    <p className="vacio">Sin actividad registrada.</p>
                ) : (
                    <div className="tabla-scroll">
                        <table>
                            <thead>
                                <tr>
                                    <th>Asistente</th>
                                    <th>Conv.</th>
                                    <th>Msgs</th>
                                    <th>Aprob.</th>
                                    <th>Editadas</th>
                                    <th>Rechaz.</th>
                                    <th className="num">Tokens</th>
                                    <th className="num">USD</th>
                                </tr>
                            </thead>
                            <tbody>
                                {sistema.map((m) => (
                                    <tr key={m.asistente_id}>
                                        <td>{m.nombre ?? m.asistente_id.slice(0, 8)}</td>
                                        <td>{m.conversaciones}</td>
                                        <td>{m.mensajes}</td>
                                        <td>{m.acciones_aprobadas}</td>
                                        <td>{m.acciones_editadas}</td>
                                        <td>{m.acciones_rechazadas}</td>
                                        <td className="num">{m.tokens_totales.toLocaleString('es-AR')}</td>
                                        <td className="num">{m.costo_usd_total.toFixed(4)}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>
        </section>
    );
}
