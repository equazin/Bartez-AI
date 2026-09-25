import { useCallback, useEffect, useRef, useState } from 'react';
import { AccionPendiente, listarAcciones, pdfCotizacion } from '../api/client.ts';
import { AvisosDeshacer, escribiendo, useColaDeshacer } from './Deshacer.tsx';
import { CANAL, hace, resumenAccion } from '../lib/acciones.ts';

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

            {typeof payload.cotizacion_id === 'string' && <AdjuntoPresupuesto id={payload.cotizacion_id} total={(payload.adjunto as { total_usd?: number } | undefined)?.total_usd} />}

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

// El PDF del presupuesto se genera con número recién al enviar; acá se ve la
// vista previa (marcada BORRADOR si todavía no tiene número).
function AdjuntoPresupuesto({ id, total }: { id: string; total?: number }) {
    const [ocupado, setOcupado] = useState(false);
    const [error, setError] = useState<string>();
    async function ver() {
        setOcupado(true);
        setError(undefined);
        try {
            const { blob } = await pdfCotizacion(id, true);
            window.open(URL.createObjectURL(blob), '_blank', 'noopener');
        } catch (e) { setError((e as Error).message); }
        finally { setOcupado(false); }
    }
    return (
        <div className="adjunto">
            <span className="adjunto-icono" aria-hidden="true">PDF</span>
            <span className="adjunto-texto">
                <strong>Presupuesto adjunto</strong>
                <span className="tenue">{total != null ? `Total US$ ${total.toLocaleString('es-AR', { minimumFractionDigits: 2 })} · ` : ''}se numera al enviarlo</span>
            </span>
            <button className="boton-fantasma" onClick={ver} disabled={ocupado}>{ocupado ? 'Abriendo…' : 'Vista previa'}</button>
            {error && <span className="error">{error}</span>}
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
            <div className="wa-propuesta-label">
                {payload.plantilla ? `Plantilla «${(payload.plantilla as { nombre: string }).nombre}» (aprobada en Meta)` : 'Respuesta propuesta'}
            </div>
            <div className="wa-burbuja saliente wa-propuesta">{cuerpo}</div>
        </div>
    );
}

// Edición en formulario: correo (para, asunto, cuerpo), WhatsApp (texto);
// cualquier otra acción, como JSON.
type Edicion =
    | { id: string; tipo: 'correo'; para: string; asunto: string; cuerpo: string }
    | { id: string; tipo: 'whatsapp'; cuerpo: string }
    | { id: string; tipo: 'json'; texto: string };

// Una plantilla de WhatsApp se manda exactamente como la aprobó Meta.
const editable = (a: AccionPendiente) => !(a.accion === 'enviar_whatsapp' && a.payload?.plantilla);

function empezarEdicion(a: AccionPendiente): Edicion {
    const p = a.payload ?? {};
    if (a.accion === 'enviar_correo') return { id: a.id, tipo: 'correo', para: String(p.para ?? ''), asunto: String(p.asunto ?? ''), cuerpo: String(p.cuerpo ?? '') };
    if (a.accion === 'enviar_whatsapp') return { id: a.id, tipo: 'whatsapp', cuerpo: String(p.cuerpo ?? '') };
    return { id: a.id, tipo: 'json', texto: JSON.stringify(p, null, 2) };
}

function payloadEditado(a: AccionPendiente, e: Edicion): Record<string, unknown> {
    if (e.tipo === 'correo') return { ...a.payload, para: e.para.trim(), asunto: e.asunto, cuerpo: e.cuerpo };
    if (e.tipo === 'whatsapp') return { ...a.payload, cuerpo: e.cuerpo };
    return JSON.parse(e.texto) as Record<string, unknown>;
}

function Editor({ e, cambiar, guardar, cancelar }: { e: Edicion; cambiar: (e: Edicion) => void; guardar: () => void; cancelar: () => void }) {
    const primero = useRef<HTMLTextAreaElement>(null);
    useEffect(() => { primero.current?.focus(); }, []);
    const teclas = (ev: React.KeyboardEvent) => {
        if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') { ev.preventDefault(); guardar(); }
        else if (ev.key === 'Escape') { ev.preventDefault(); cancelar(); }
    };
    return (
        <div className="apr-editor" onKeyDown={teclas}>
            {e.tipo === 'correo' && (
                <>
                    <label><span>Para</span><input value={e.para} onChange={(x) => cambiar({ ...e, para: x.target.value })} /></label>
                    <label><span>Asunto</span><input value={e.asunto} onChange={(x) => cambiar({ ...e, asunto: x.target.value })} /></label>
                </>
            )}
            <label className="apr-editor-cuerpo">
                <span>{e.tipo === 'json' ? 'Datos (JSON)' : 'Mensaje'}</span>
                <textarea
                    ref={primero}
                    className={e.tipo === 'json' ? 'mono' : ''}
                    value={e.tipo === 'json' ? e.texto : e.cuerpo}
                    onChange={(x) => cambiar(e.tipo === 'json' ? { ...e, texto: x.target.value } : { ...e, cuerpo: x.target.value })}
                />
            </label>
        </div>
    );
}

// Motivos rápidos: el asistente aprende de ellos (se destilan en lecciones).
const MOTIVOS = ['El tono no va', 'Datos o precios mal', 'Muy largo', 'No hacía falta responder', 'Lo respondo yo'];

function Rechazo({ confirmar, cancelar }: { confirmar: (motivo: string) => void; cancelar: () => void }) {
    const [motivo, setMotivo] = useState('');
    const campo = useRef<HTMLInputElement>(null);
    useEffect(() => { campo.current?.focus(); }, []);
    return (
        <div className="apr-rechazo" onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); cancelar(); } }}>
            <span className="apr-rechazo-titulo">¿Por qué la rechazás? <span className="tenue">Opcional: el asistente aprende de esto.</span></span>
            <div className="chips">
                {MOTIVOS.map((m) => (
                    <button key={m} type="button" className={motivo === m ? 'chip on' : 'chip'} aria-pressed={motivo === m} onClick={() => { setMotivo((v) => (v === m ? '' : m)); campo.current?.focus(); }}>{m}</button>
                ))}
            </div>
            <div className="apr-rechazo-fila">
                <input
                    ref={campo}
                    value={motivo}
                    onChange={(e) => setMotivo(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); confirmar(motivo); } }}
                    placeholder="O escribilo con tus palabras…"
                    aria-label="Motivo del rechazo"
                />
                <button className="btn-peligro" onClick={() => confirmar(motivo)}>Rechazar</button>
                <button className="boton-fantasma" onClick={cancelar}>Cancelar</button>
            </div>
        </div>
    );
}

export function Acciones() {
    const [acciones, setAcciones] = useState<AccionPendiente[]>([]);
    const [cargado, setCargado] = useState(false);
    const [selId, setSelId] = useState<string | null>(null);
    const [edicion, setEdicion] = useState<Edicion | null>(null);
    const [rechazando, setRechazando] = useState<string | null>(null);
    // Celular: se revisa de a una (tarjeta con anterior/siguiente); la lista queda a un toque.
    const [verDetalle, setVerDetalle] = useState(() => {
        try { return window.matchMedia('(max-width: 900px)').matches; } catch { return false; }
    });
    const [error, setError] = useState<string>();
    const [cargando, setCargando] = useState(false);

    const cargar = useCallback(async () => {
        setCargando(true);
        try {
            const { acciones } = await listarAcciones('pendiente');
            setAcciones(acciones);
            setError(undefined);
        } catch (e) {
            setError((e as Error).message);
        } finally {
            setCargando(false);
            setCargado(true);
        }
    }, []);

    useEffect(() => { cargar(); }, [cargar]);

    const cola = useColaDeshacer(async (err) => {
        await cargar();
        if (err) setError(err);
    });

    const visibles = acciones.filter((a) => !cola.estaEnCola(a.id));
    const idxSel = Math.max(visibles.findIndex((a) => a.id === selId), 0);
    const sel = visibles[idxSel] ?? null;

    const seleccionar = useCallback((a: AccionPendiente | undefined) => {
        if (!a) return;
        setSelId(a.id);
        setEdicion(null);
        setRechazando(null);
        document.querySelector(`[data-apr-id="${a.id}"]`)?.scrollIntoView({ block: 'nearest' });
    }, []);

    // Al resolver una, queda seleccionada la siguiente.
    const resolver = useCallback((a: AccionPendiente, tipo: 'aprobar' | 'rechazar' | 'editar', payload?: Record<string, unknown>, nota?: string) => {
        const i = visibles.findIndex((x) => x.id === a.id);
        const siguiente = visibles[i + 1] ?? visibles[i - 1];
        cola.encolar(a.id, tipo, resumenAccion(a).destino, payload, nota?.trim() || undefined);
        setEdicion(null);
        setRechazando(null);
        setSelId(siguiente?.id ?? null);
        if (!siguiente) setVerDetalle(false);
    }, [visibles, cola.encolar]);

    function guardarEdicion() {
        if (!sel || !edicion) return;
        try {
            resolver(sel, 'editar', payloadEditado(sel, edicion));
        } catch {
            setError('El JSON no es válido: revisalo antes de enviar.');
        }
    }

    // Teclado: J/K moverse, A aprobar, R rechazar, E editar.
    useEffect(() => {
        const tecla = (e: KeyboardEvent) => {
            if (e.ctrlKey || e.metaKey || e.altKey || escribiendo(e.target) || edicion || rechazando || !sel) return;
            const k = e.key.toLowerCase();
            if (k === 'j') seleccionar(visibles[Math.min(idxSel + 1, visibles.length - 1)]);
            else if (k === 'k') seleccionar(visibles[Math.max(idxSel - 1, 0)]);
            else if (k === 'a') resolver(sel, 'aprobar');
            else if (k === 'r') setRechazando(sel.id);
            else if (k === 'e') { if (editable(sel)) setEdicion(empezarEdicion(sel)); }
            else return;
            e.preventDefault();
        };
        window.addEventListener('keydown', tecla);
        return () => window.removeEventListener('keydown', tecla);
    }, [visibles, idxSel, sel, edicion, rechazando, seleccionar, resolver]);

    return (
        <section className={`apr ${verDetalle ? 'ver-detalle' : ''}`}>
            <header className="apr-cabecera">
                <div>
                    <h2>Para aprobar {cargado && <span className={`cuenta ${visibles.length ? 'cuenta-espera' : ''}`}>{visibles.length}</span>}</h2>
                    <p className="sub">Lo que redactaron los asistentes. Nada sale sin tu OK.</p>
                </div>
                <div className="apr-cabecera-der">
                    <p className="atajos" aria-hidden="true"><kbd>J</kbd> <kbd>K</kbd> moverse · <kbd>A</kbd> aprobar · <kbd>E</kbd> editar · <kbd>R</kbd> rechazar</p>
                    <button className={`icono-btn ${cargando ? 'girando' : ''}`} onClick={cargar} disabled={cargando} aria-label="Actualizar" title="Actualizar">↻</button>
                </div>
            </header>

            {error && <p className="error" role="alert">{error}</p>}

            {!cargado && (
                <div className="apr-cuerpo" aria-busy="true">
                    <div className="apr-lista">{[1, 2, 3, 4].map((i) => <span key={i} className="esq apr-esq-fila" />)}</div>
                    <span className="esq apr-esq-detalle" />
                </div>
            )}

            {cargado && visibles.length === 0 && (
                <div className="apr-vacio">
                    <span className="apr-vacio-icono" aria-hidden="true">✓</span>
                    <strong>Nada esperando tu OK</strong>
                    <p>Cuando un asistente redacte una respuesta, aparece acá para aprobarla, editarla o rechazarla.</p>
                </div>
            )}

            {cargado && sel && (
                <div className="apr-cuerpo">
                    <ul className="apr-lista" aria-label="Propuestas pendientes">
                        {visibles.map((a) => {
                            const x = resumenAccion(a);
                            const activa = a.id === sel.id;
                            return (
                                <li key={a.id}>
                                    <button
                                        className={`apr-item ${activa ? 'activa' : ''}`}
                                        data-apr-id={a.id}
                                        aria-current={activa ? 'true' : undefined}
                                        onClick={() => { seleccionar(a); setVerDetalle(true); }}
                                    >
                                        <span className="apr-item-top">
                                            <span className={`canal canal-${a.accion}`}>{CANAL[a.accion] ?? a.accion}</span>
                                            <strong title={x.destino}>{x.destino || '—'}</strong>
                                            <span className="hora">{hace(a.creado_en)}</span>
                                        </span>
                                        <span className="apr-item-titulo" title={x.titulo}>{x.titulo}</span>
                                        <span className="apr-item-vista">{x.cuerpo.replace(/\s+/g, ' ').trim()}</span>
                                    </button>
                                </li>
                            );
                        })}
                    </ul>

                    <article className="apr-detalle" aria-label="Propuesta seleccionada">
                        <div className="apr-paso">
                            <button className="icono-btn" onClick={() => seleccionar(visibles[idxSel - 1])} disabled={idxSel === 0} aria-label="Anterior">‹</button>
                            <span className="apr-paso-n">{idxSel + 1} de {visibles.length}</span>
                            <button className="icono-btn" onClick={() => seleccionar(visibles[idxSel + 1])} disabled={idxSel >= visibles.length - 1} aria-label="Siguiente">›</button>
                            <button className="enlace apr-volver" onClick={() => setVerDetalle(false)}>Ver la lista</button>
                        </div>
                        <div className="apr-detalle-cab">
                            <span className={`canal canal-${sel.accion}`}>{CANAL[sel.accion] ?? sel.accion}</span>
                            <h3>{resumenAccion(sel).destino || '—'}</h3>
                            <span className="hora">
                                {sel.asistente_nombre ?? 'asistente'} · {new Date(sel.creado_en).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
                            </span>
                        </div>

                        <div className="apr-detalle-contenido">
                            {edicion && edicion.id === sel.id ? (
                                <Editor e={edicion} cambiar={setEdicion} guardar={guardarEdicion} cancelar={() => setEdicion(null)} />
                            ) : sel.accion === 'enviar_correo' ? (
                                <VistaCorreo payload={sel.payload} />
                            ) : sel.accion === 'enviar_whatsapp' ? (
                                <VistaWhatsapp payload={sel.payload} />
                            ) : (
                                <pre className="payload">{JSON.stringify(sel.payload, null, 2)}</pre>
                            )}
                        </div>

                        <div className="apr-barra">
                            {rechazando === sel.id ? (
                                <Rechazo confirmar={(m) => resolver(sel, 'rechazar', undefined, m)} cancelar={() => setRechazando(null)} />
                            ) : edicion && edicion.id === sel.id ? (
                                <>
                                    <button className="btn-aprobar" onClick={guardarEdicion}>Guardar y enviar</button>
                                    <button className="boton-fantasma" onClick={() => setEdicion(null)}>Cancelar</button>
                                    <span className="atajos"><kbd>Ctrl</kbd> <kbd>Enter</kbd> envía · <kbd>Esc</kbd> cancela</span>
                                </>
                            ) : (
                                <>
                                    <button className="btn-aprobar" onClick={() => resolver(sel, 'aprobar')}>Aprobar y enviar</button>
                                    <button
                                        className="boton-fantasma"
                                        onClick={() => setEdicion(empezarEdicion(sel))}
                                        disabled={!editable(sel)}
                                        title={editable(sel) ? undefined : 'Las plantillas se mandan tal cual están aprobadas en Meta: si no va, rechazala y armá otra desde WhatsApp.'}
                                    >Editar</button>
                                    <button className="boton-fantasma peligro" onClick={() => setRechazando(sel.id)}>Rechazar</button>
                                </>
                            )}
                        </div>
                    </article>
                </div>
            )}

            <div className="apr-dock"><AvisosDeshacer enCola={cola.enCola} deshacer={cola.deshacer} /></div>
        </section>
    );
}
