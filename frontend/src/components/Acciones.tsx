import { useCallback, useEffect, useState } from 'react';
import { AccionPendiente, listarAcciones, resolverAccion } from '../api/client.ts';

type Editando = { id: string; payloadTexto: string } | null;

export function Acciones() {
    const [acciones, setAcciones] = useState<AccionPendiente[]>([]);
    const [editando, setEditando] = useState<Editando>(null);
    const [error, setError] = useState<string>();
    const [cargando, setCargando] = useState(false);

    const cargar = useCallback(async () => {
        try {
            setError(undefined);
            const { acciones } = await listarAcciones('pendiente');
            setAcciones(acciones);
        } catch (e) {
            setError((e as Error).message);
        }
    }, []);

    useEffect(() => {
        cargar();
    }, [cargar]);

    async function ejecutar(a: AccionPendiente, tipo: 'aprobar' | 'rechazar') {
        setCargando(true);
        try {
            await resolverAccion(a.id, tipo);
            await cargar();
        } catch (e) {
            setError((e as Error).message);
        } finally {
            setCargando(false);
        }
    }

    async function guardarEdicion(a: AccionPendiente) {
        if (!editando) return;
        setCargando(true);
        try {
            const payload = JSON.parse(editando.payloadTexto);
            await resolverAccion(a.id, 'editar', { payload });
            setEditando(null);
            await cargar();
        } catch (e) {
            setError((e as Error).message);
        } finally {
            setCargando(false);
        }
    }

    return (
        <section className="acciones">
            <div className="acciones-header">
                <h2>Acciones pendientes de aprobación</h2>
                <button className="secundario" onClick={cargar} disabled={cargando}>
                    Actualizar
                </button>
            </div>

            {error && <p className="error">Error: {error}</p>}

            {acciones.length === 0 && !error && (
                <p className="vacio">No hay nada esperando tu aprobación. Todo bajo control.</p>
            )}

            {acciones.map((a) => {
                const esEditar = editando?.id === a.id;
                return (
                    <div key={a.id} className="accion-card">
                        <div className="accion-head">
                            <div>
                                <span className="tag">{a.asistente_nombre ?? 'asistente'}</span>
                                <span className="tag tipo">{a.accion}</span>
                            </div>
                            <span className="ts">{new Date(a.creado_en).toLocaleString('es-AR')}</span>
                        </div>

                        {!esEditar ? (
                            <pre className="payload">{JSON.stringify(a.payload, null, 2)}</pre>
                        ) : (
                            <textarea
                                className="payload editable"
                                value={editando!.payloadTexto}
                                onChange={(e) =>
                                    setEditando({ id: a.id, payloadTexto: e.target.value })
                                }
                            />
                        )}

                        <div className="accion-acciones">
                            {!esEditar ? (
                                <>
                                    <button onClick={() => ejecutar(a, 'aprobar')} disabled={cargando}>
                                        Aprobar
                                    </button>
                                    <button
                                        className="secundario"
                                        onClick={() =>
                                            setEditando({
                                                id: a.id,
                                                payloadTexto: JSON.stringify(a.payload, null, 2),
                                            })
                                        }
                                        disabled={cargando}
                                    >
                                        Editar
                                    </button>
                                    <button
                                        className="peligro"
                                        onClick={() => ejecutar(a, 'rechazar')}
                                        disabled={cargando}
                                    >
                                        Rechazar
                                    </button>
                                </>
                            ) : (
                                <>
                                    <button onClick={() => guardarEdicion(a)} disabled={cargando}>
                                        Guardar y aprobar
                                    </button>
                                    <button className="secundario" onClick={() => setEditando(null)}>
                                        Cancelar
                                    </button>
                                </>
                            )}
                        </div>
                    </div>
                );
            })}
        </section>
    );
}
