import { useCallback, useEffect, useState } from 'react';
import { actualizarAsistente, actualizarLecciones, Aprendizaje, AsistenteEditable, listarAprendizajes, listarAsistentes } from '../api/client.ts';
import { hace } from '../lib/acciones.ts';

// Lo que el asistente aprendió de tus rechazos y ediciones: las lecciones se
// suman a su prompt y se pueden corregir a mano.
function LoQueAprendio({ a, lecciones, cambiar, alActualizar }: {
    a: AsistenteEditable; lecciones: string; cambiar: (v: string) => void; alActualizar: () => Promise<void>;
}) {
    const [correcciones, setCorrecciones] = useState<Aprendizaje[] | null>(null);
    const [ocupado, setOcupado] = useState(false);
    const [aviso, setAviso] = useState<string>();

    const cargar = useCallback(() => {
        listarAprendizajes(a.id).then((r) => setCorrecciones(r.aprendizajes)).catch(() => setCorrecciones([]));
    }, [a.id]);
    useEffect(() => { cargar(); }, [cargar]);

    const sinProcesar = (correcciones ?? []).filter((c) => !c.destilado).length;

    async function actualizar() {
        setOcupado(true);
        setAviso(undefined);
        try {
            const r = await actualizarLecciones(a.id);
            setAviso(`Listo: lecciones actualizadas con ${r.usadas ?? 0} correcciones.`);
            await alActualizar();
            cargar();
        } catch (e) {
            setAviso((e as Error).message);
        } finally {
            setOcupado(false);
        }
    }

    return (
        <div className="aprendio">
            <div className="aprendio-cab">
                <div>
                    <strong>Lo que aprendió</strong>
                    <span className="tenue">
                        {correcciones == null ? ' · cargando…' : ` · ${correcciones.length} correcciones${sinProcesar ? `, ${sinProcesar} sin procesar` : ''}`}
                        {a.lecciones_en ? ` · actualizado ${hace(a.lecciones_en)}` : ''}
                    </span>
                </div>
                <button className="secundario" onClick={actualizar} disabled={ocupado || !correcciones?.length}>
                    {ocupado ? 'Aprendiendo…' : 'Aprender de las correcciones ahora'}
                </button>
            </div>
            <textarea
                value={lecciones}
                onChange={(e) => cambiar(e.target.value)}
                rows={Math.min(Math.max(lecciones.split('\n').length + 1, 3), 12)}
                placeholder="Todavía no hay lecciones. Se arman solas cuando rechazás o editás lo que propone este asistente (al juntar 3 correcciones y todas las noches)."
            />
            <p className="tenue aprendio-nota">Se suman al final de su prompt. Podés editarlas o borrar las que no correspondan; se guardan con “Guardar cambios”.</p>
            {aviso && <p className="msg-ok">{aviso}</p>}
            {correcciones && correcciones.length > 0 && (
                <details className="aprendio-lista">
                    <summary>Ver las últimas correcciones</summary>
                    {correcciones.slice(0, 8).map((c) => (
                        <div key={c.id} className="aprendio-item">
                            <span className={`canal ${c.tipo === 'rechazo' ? 'canal-rechazo' : 'canal-edicion'}`}>{c.tipo === 'rechazo' ? 'Rechazada' : 'Editada'}</span>
                            <span className="aprendio-texto">
                                {c.motivo ? <strong>“{c.motivo}”</strong> : c.tipo === 'rechazo' ? <span className="tenue">sin motivo</span> : null}
                                <span className="tenue"> {(c.corregido ?? c.propuesto ?? '').replace(/\s+/g, ' ').slice(0, 140)}</span>
                            </span>
                            <span className="hora">{hace(c.creado_en)}</span>
                        </div>
                    ))}
                </details>
            )}
        </div>
    );
}

export function Asistentes() {
    const [asistentes, setAsistentes] = useState<AsistenteEditable[]>([]);
    const [expandido, setExpandido] = useState<string | null>(null);
    const [borrador, setBorrador] = useState<Record<string, Partial<AsistenteEditable>>>({});
    const [error, setError] = useState<string>();
    const [guardando, setGuardando] = useState<string | null>(null);

    const cargar = useCallback(async () => {
        try {
            setError(undefined);
            const { asistentes } = await listarAsistentes();
            setAsistentes(asistentes);
        } catch (e) {
            setError((e as Error).message);
        }
    }, []);

    useEffect(() => {
        cargar();
    }, [cargar]);

    function cambio(id: string, campo: keyof AsistenteEditable, valor: unknown) {
        setBorrador((b) => ({ ...b, [id]: { ...(b[id] ?? {}), [campo]: valor } }));
    }

    async function guardar(a: AsistenteEditable) {
        const cambios = borrador[a.id];
        if (!cambios || Object.keys(cambios).length === 0) return;
        setGuardando(a.id);
        try {
            await actualizarAsistente(a.id, cambios);
            setBorrador((b) => {
                const c = { ...b };
                delete c[a.id];
                return c;
            });
            await cargar();
        } catch (e) {
            setError((e as Error).message);
        } finally {
            setGuardando(null);
        }
    }

    async function toggleActivo(a: AsistenteEditable) {
        setGuardando(a.id);
        try {
            await actualizarAsistente(a.id, { activo: !a.activo });
            await cargar();
        } catch (e) {
            setError((e as Error).message);
        } finally {
            setGuardando(null);
        }
    }

    const valor = (a: AsistenteEditable, campo: keyof AsistenteEditable) =>
        (borrador[a.id]?.[campo] as never) ?? (a[campo] as never);

    return (
        <section className="asistentes">
            <div className="acciones-header">
                <div>
                    <h2>Asistentes</h2>
                    <p className="sub">Cómo trabaja cada asistente: modelo, instrucciones y cuánta autonomía tiene.</p>
                </div>
                <button className="secundario" onClick={cargar}>
                    Actualizar
                </button>
            </div>

            {error && <p className="error">Error: {error}</p>}

            {asistentes.map((a) => {
                const abierto = expandido === a.id;
                const modificado = Boolean(borrador[a.id] && Object.keys(borrador[a.id]!).length);
                return (
                    <div key={a.id} className={`asistente-card ${a.activo ? '' : 'dormido'}`}>
                        <div className="asistente-head" onClick={() => setExpandido(abierto ? null : a.id)}>
                            <div>
                                <span className={`estado ${a.activo ? 'on' : 'off'}`}>
                                    {a.activo ? '●' : '○'}
                                </span>
                                <strong>{a.nombre}</strong>
                                <span className="tag">{a.area}</span>
                                <span className="tag tipo">{valor(a, 'modelo')}</span>
                                <span className="tag">autonomía {valor(a, 'autonomia')}</span>
                            </div>
                            <span className="ts">{abierto ? '▲' : '▼'}</span>
                        </div>

                        {abierto && (
                            <div className="asistente-body">
                                <label>
                                    Prompt
                                    <textarea
                                        value={valor(a, 'prompt') as string}
                                        onChange={(e) => cambio(a.id, 'prompt', e.target.value)}
                                        rows={14}
                                    />
                                </label>

                                <div className="asistente-controles">
                                    <label>
                                        Modelo
                                        <select
                                            value={valor(a, 'modelo') as string}
                                            onChange={(e) => cambio(a.id, 'modelo', e.target.value)}
                                        >
                                            <option value="sonnet">sonnet</option>
                                            <option value="haiku">haiku</option>
                                            <option value="opus">opus (5x más caro)</option>
                                        </select>
                                    </label>
                                    <label>
                                        Autonomía (0–100)
                                        <input
                                            type="number"
                                            min={0}
                                            max={100}
                                            value={valor(a, 'autonomia') as number}
                                            onChange={(e) =>
                                                cambio(a.id, 'autonomia', Number(e.target.value))
                                            }
                                        />
                                    </label>
                                </div>

                                <LoQueAprendio
                                    a={a}
                                    lecciones={(valor(a, 'lecciones') as string | null) ?? ''}
                                    cambiar={(v) => cambio(a.id, 'lecciones', v)}
                                    alActualizar={cargar}
                                />

                                <div className="accion-acciones">
                                    <button
                                        className="btn-primario"
                                        onClick={() => guardar(a)}
                                        disabled={!modificado || guardando === a.id}
                                    >
                                        {guardando === a.id ? 'Guardando…' : 'Guardar cambios'}
                                    </button>
                                    <button
                                        className={a.activo ? 'peligro' : 'secundario'}
                                        onClick={() => toggleActivo(a)}
                                        disabled={guardando === a.id}
                                    >
                                        {a.activo ? 'Dormir' : 'Activar'}
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>
                );
            })}
        </section>
    );
}
