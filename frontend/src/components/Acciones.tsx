import { useCallback, useEffect, useState } from 'react';
import { AccionPendiente, listarAcciones, resolverAccion } from '../api/client.ts';

function VistaCorreo({ payload }: { payload: Record<string, unknown> }) {
    const [verCrudo, setVerCrudo] = useState(false);
    const para = String(payload.para ?? '');
    const asunto = String(payload.asunto ?? '(sin asunto)');
    const cuerpo = String(payload.cuerpo ?? '');
    const nombreCliente = payload.nombreCliente as string | undefined;
    const categoria = payload.categoria as string | undefined;
    const motivo = payload.motivoClasif as string | undefined;
    const tareas = Array.isArray(payload.tareas) ? (payload.tareas as Array<{ titulo: string; fecha_limite?: string | null; contexto?: string }>) : [];
    const textoEntrante = payload.textoEntrante as string | undefined;

    return (
        <div className="correo-preview">
            <div className="correo-cabecera">
                <div className="fila"><span className="etiq">Para</span><span className="valor">{para}</span></div>
                <div className="fila"><span className="etiq">Asunto</span><span className="valor bold">{asunto}</span></div>
                {nombreCliente && (
                    <div className="fila"><span className="etiq">Cliente</span><span className="valor">{nombreCliente}</span></div>
                )}
                {categoria && (
                    <div className="fila"><span className="etiq">Categoría</span><span className="valor mono">{categoria}{motivo ? ` — ${motivo}` : ''}</span></div>
                )}
            </div>

            <div className="correo-cuerpo">
                {cuerpo.split('\n').map((linea, i) => (
                    <p key={i}>{linea || ' '}</p>
                ))}
            </div>

            {tareas.length > 0 && (
                <div className="correo-tareas">
                    <div className="titulo">Tareas que se van a crear en Notion ({tareas.length})</div>
                    {tareas.map((t, i) => (
                        <div key={i} className="tarea-linea">
                            <span className="tit">{t.titulo}</span>
                            {t.fecha_limite && <span className="fecha">📅 {t.fecha_limite}</span>}
                            {t.contexto && <div className="ctx">{t.contexto}</div>}
                        </div>
                    ))}
                </div>
            )}

            {textoEntrante && (
                <details className="correo-entrante">
                    <summary>Ver el correo entrante que originó esta respuesta</summary>
                    <pre>{textoEntrante}</pre>
                </details>
            )}

            <details className="correo-crudo" open={verCrudo} onToggle={(e) => setVerCrudo((e.target as HTMLDetailsElement).open)}>
                <summary>Ver payload JSON completo</summary>
                <pre className="payload">{JSON.stringify(payload, null, 2)}</pre>
            </details>
        </div>
    );
}

const QUIEN_WA: Record<string, string> = { cliente: 'Cliente', bot: 'Bot web', humano: 'Bartez' };

function VistaWhatsapp({ payload }: { payload: Record<string, unknown> }) {
    const cuerpo = String(payload.cuerpo ?? '');
    const contacto = (payload.nombreCliente as string | null) || (payload.nombreContacto as string | null) || String(payload.waId ?? '');
    const conversacion = Array.isArray(payload.conversacion)
        ? (payload.conversacion as Array<{ origen: string; cuerpo: string | null; fecha: string }>) : [];
    const ultimo = payload.ultimoEntranteEn as string | null | undefined;
    const vence = ultimo ? new Date(new Date(ultimo).getTime() + 24 * 3600_000) : null;
    const vencida = vence ? vence.getTime() < Date.now() : false;
    return (
        <div className="correo-preview">
            <div className="correo-cabecera">
                <div className="fila"><span className="etiq">WhatsApp</span><span className="valor bold">{contacto}</span></div>
                <div className="fila"><span className="etiq">Número</span><span className="valor mono">+{String(payload.waId ?? '')}</span></div>
                {vence && (
                    <div className="fila">
                        <span className="etiq">Ventana 24 h</span>
                        <span className={`valor ${vencida ? 'wa-vencida' : ''}`}>
                            {vencida ? 'vencida: WhatsApp no deja mandar texto libre' : `hasta ${vence.toLocaleString('es-AR')}`}
                        </span>
                    </div>
                )}
            </div>
            {conversacion.length > 0 && (
                <div className="wa-mini-hilo">
                    {conversacion.map((m, i) => (
                        <div key={i} className={`wa-burbuja ${m.origen === 'cliente' ? 'entrante' : 'saliente'} ${m.origen}`}>
                            <span className="wa-quien">{QUIEN_WA[m.origen] ?? m.origen}</span>
                            {m.cuerpo || <em>(sin texto)</em>}
                        </div>
                    ))}
                </div>
            )}
            <div className="wa-propuesta-label">Respuesta propuesta</div>
            <div className="wa-burbuja saliente propuesta">{cuerpo}</div>
        </div>
    );
}

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
            const r = await resolverAccion(a.id, tipo);
            await cargar(); // limpia el error: el aviso de envío fallido va después
            if (tipo === 'aprobar' && r.ejecucion && !r.ejecucion.ok) {
                setError(`Se aprobó pero no se pudo enviar: ${r.ejecucion.detalle ?? 'error desconocido'}`);
            }
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
            // WhatsApp se edita como texto plano; el resto, como JSON.
            const payload = a.accion === 'enviar_whatsapp'
                ? { ...a.payload, cuerpo: editando.payloadTexto }
                : JSON.parse(editando.payloadTexto);
            const r = await resolverAccion(a.id, 'editar', { payload });
            setEditando(null);
            await cargar();
            if (r.ejecucion && !r.ejecucion.ok) setError(`Se guardó pero no se pudo enviar: ${r.ejecucion.detalle ?? 'error desconocido'}`);
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
                            a.accion === 'enviar_correo'
                                ? <VistaCorreo payload={a.payload} />
                                : a.accion === 'enviar_whatsapp'
                                    ? <VistaWhatsapp payload={a.payload} />
                                    : <pre className="payload">{JSON.stringify(a.payload, null, 2)}</pre>
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
                                                payloadTexto: a.accion === 'enviar_whatsapp'
                                                    ? String(a.payload.cuerpo ?? '')
                                                    : JSON.stringify(a.payload, null, 2),
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
