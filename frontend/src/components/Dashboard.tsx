import { useEffect, useState } from 'react';
import { metricasHoy } from '../api/client.ts';

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
}

export function Dashboard() {
    const [sistema, setSistema] = useState<MetricaSistema[]>([]);
    const [negocio, setNegocio] = useState<MetricaNegocio | null>(null);
    const [error, setError] = useState<string>();

    useEffect(() => {
        metricasHoy()
            .then((d) => {
                setSistema(d.sistema as MetricaSistema[]);
                setNegocio(d.negocio as MetricaNegocio | null);
            })
            .catch((e) => setError((e as Error).message));
    }, []);

    return (
        <section className="dashboard">
            <div className="metrica-exito">
                <h2>Métrica de éxito del negocio (hoy)</h2>
                {negocio ? (
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
                ) : (
                    <p className="vacio">Sin datos todavía.</p>
                )}
            </div>

            <div className="metrica-sistema">
                <h2>Actividad de asistentes (hoy)</h2>
                {error && <p className="error">Error: {error}</p>}
                {sistema.length === 0 ? (
                    <p className="vacio">Sin actividad registrada.</p>
                ) : (
                    <table>
                        <thead>
                            <tr>
                                <th>Asistente</th>
                                <th>Conv.</th>
                                <th>Msgs</th>
                                <th>Aprob.</th>
                                <th>Editadas</th>
                                <th>Rechaz.</th>
                                <th>Tokens</th>
                                <th>USD</th>
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
                                    <td>{m.tokens_totales}</td>
                                    <td>{m.costo_usd_total.toFixed(4)}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </div>
        </section>
    );
}
