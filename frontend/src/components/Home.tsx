import { useCallback, useEffect, useState } from 'react';
import { AccionPendiente, ResumenHoy, listarAcciones, resolverAccion, resumenHoy } from '../api/client.ts';
import { Chat } from './Chat.tsx';

type IrA = 'acciones' | 'whatsapp' | 'cotizador' | 'seguimientos' | 'prospeccion' | 'notion' | 'bitacora' | 'dashboard' | 'chat';

const TZ = 'America/Argentina/Buenos_Aires';
const usd = (n: number) => `US$ ${n.toLocaleString('es-AR', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
const hora = (iso: string) => new Date(iso).toLocaleTimeString('es-AR', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
const diaCorto = (iso: string) => new Date(iso).toLocaleDateString('es-AR', { timeZone: TZ, day: '2-digit', month: '2-digit' });

function hace(iso: string): string {
    const min = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
    if (min < 1) return 'recién';
    if (min < 60) return `hace ${min} min`;
    const h = Math.floor(min / 60);
    if (h < 24) return `hace ${h} h`;
    const d = Math.floor(h / 24);
    return `hace ${d} día${d > 1 ? 's' : ''}`;
}

function saludo(): string {
    const h = Number(new Date().toLocaleString('en-US', { timeZone: TZ, hour: 'numeric', hour12: false }));
    return h < 13 ? 'Buen día' : h < 20 ? 'Buenas tardes' : 'Buenas noches';
}

const CANAL: Record<string, string> = { enviar_correo: 'Correo', enviar_whatsapp: 'WhatsApp' };

function resumenAccion(a: AccionPendiente): { destino: string; titulo: string; cuerpo: string } {
    const p = a.payload ?? {};
    if (a.accion === 'enviar_whatsapp') {
        return {
            destino: String(p.nombreCliente || p.nombreContacto || `+${p.waId ?? ''}`),
            titulo: 'Respuesta de WhatsApp',
            cuerpo: String(p.cuerpo ?? ''),
        };
    }
    if (a.accion === 'enviar_correo') {
        return {
            destino: String(p.nombreCliente || p.para || ''),
            titulo: String(p.asunto ?? '(sin asunto)'),
            cuerpo: String(p.cuerpo ?? ''),
        };
    }
    return { destino: a.asistente_nombre ?? '', titulo: a.accion, cuerpo: JSON.stringify(p).slice(0, 200) };
}

// ---------- La línea: el recorrido real de cada consulta ----------

function Linea({ r, irA }: { r: ResumenHoy; irA: (t: IrA) => void }) {
    const l = r.linea;
    const estaciones = [
        {
            clave: 'entra',
            etiqueta: 'Entra',
            numero: l.entra.total,
            detalle: `${l.entra.correos} correo${l.entra.correos === 1 ? '' : 's'} · ${l.entra.whatsapp} WhatsApp`,
            ir: undefined as IrA | undefined,
        },
        {
            clave: 'propone',
            etiqueta: 'El asistente propone',
            numero: l.propone,
            detalle: 'respuestas redactadas hoy',
            ir: undefined,
        },
        {
            clave: 'tuok',
            etiqueta: 'Tu OK',
            numero: l.tu_ok,
            detalle: l.tu_ok === 0 ? 'nada esperando' : l.tu_ok === 1 ? 'espera tu decisión' : 'esperan tu decisión',
            ir: 'acciones' as IrA,
        },
        {
            clave: 'sale',
            etiqueta: 'Sale',
            numero: l.sale.aprobadas,
            detalle: `aprobadas hoy${l.sale.rechazadas ? ` · ${l.sale.rechazadas} rechazada${l.sale.rechazadas === 1 ? '' : 's'}` : ''}`,
            ir: undefined,
        },
    ];
    return (
        <section className="linea" aria-label="Recorrido de hoy">
            <div className="linea-riel" aria-hidden="true" />
            {estaciones.map((e) => {
                const espera = e.clave === 'tuok' && e.numero > 0;
                const contenido = (
                    <>
                        <span className="est-punto" aria-hidden="true" />
                        <span className="est-etiqueta">{e.etiqueta}</span>
                        <span className="est-numero">{e.numero}</span>
                        <span className="est-detalle">{e.detalle}</span>
                        {e.ir && e.numero > 0 && <span className="est-ir">Revisar →</span>}
                    </>
                );
                const clase = `estacion est-${e.clave} ${espera ? 'espera' : ''}`;
                return e.ir
                    ? <button key={e.clave} type="button" className={clase} onClick={() => irA(e.ir!)}>{contenido}</button>
                    : <div key={e.clave} className={clase}>{contenido}</div>;
            })}
        </section>
    );
}

export function Home({ irA }: { irA: (t: IrA) => void }) {
    const [r, setR] = useState<ResumenHoy | null>(null);
    const [acciones, setAcciones] = useState<AccionPendiente[]>([]);
    const [error, setError] = useState<string>();
    const [cargando, setCargando] = useState(false);
    const [resolviendo, setResolviendo] = useState<string | null>(null);

    const cargar = useCallback(async (forzar = false) => {
        setCargando(true);
        try {
            const [res, ac] = await Promise.all([resumenHoy(forzar), listarAcciones('pendiente')]);
            setR(res);
            setAcciones(ac.acciones);
            setError(undefined);
        } catch (e) {
            setError((e as Error).message);
        } finally {
            setCargando(false);
        }
    }, []);

    useEffect(() => {
        cargar();
        const t = setInterval(() => cargar(), 60_000);
        return () => clearInterval(t);
    }, [cargar]);

    async function resolver(a: AccionPendiente, tipo: 'aprobar' | 'rechazar') {
        setResolviendo(a.id);
        try {
            const res = await resolverAccion(a.id, tipo);
            await cargar(true);
            if (tipo === 'aprobar' && res.ejecucion && !res.ejecucion.ok) {
                setError(`Se aprobó pero no se pudo enviar: ${res.ejecucion.detalle ?? 'error desconocido'}`);
            }
        } catch (e) {
            setError((e as Error).message);
        } finally {
            setResolviendo(null);
        }
    }

    const fecha = new Date().toLocaleDateString('es-AR', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' });
    const f = r?.foto;
    const waPendientes = f?.whatsapp.sin_responder_en_ventana ?? [];
    const correosSinResp = (f?.correos_3_dias.relevantes ?? []).filter((c) => !c.respondido);
    const hoyIso = new Date().toLocaleDateString('en-CA', { timeZone: TZ });
    const tareas = (f?.tareas_notion ?? []).filter((t) => t.estado === 'pendiente');
    const tareasUrgentes = tareas.filter((t) => t.fecha_limite && t.fecha_limite <= hoyIso);
    const prioridades = r?.prioridades?.items ?? [];
    const prioridadesDeHoy = r?.prioridades && new Date(r.prioridades.fecha).toLocaleDateString('en-CA', { timeZone: TZ }) === hoyIso;

    return (
        <div className="hoy">
            <header className="hoy-cabecera">
                <div>
                    <div className="eyebrow">{fecha}</div>
                    <h1>{saludo()}.</h1>
                </div>
                <div className="hoy-actualizado">
                    {r && <span className="mono">Actualizado {hora(r.generado_en)}</span>}
                    <button className="boton-fantasma" onClick={() => cargar(true)} disabled={cargando}>
                        {cargando ? 'Actualizando…' : 'Actualizar'}
                    </button>
                </div>
            </header>

            <Chat compacto alAbrirChat={() => irA('chat')} />

            {error && <p className="error">{error}</p>}
            {!r && !error && <p className="sub">Cargando el día…</p>}

            {r && f && (
                <>
                    <Linea r={r} irA={irA} />

                    <div className="hoy-grilla">
                        {/* ---- Esperando tu OK ---- */}
                        <section className="bloque bloque-ok">
                            <div className="bloque-cabeza">
                                <h2>Esperando tu OK</h2>
                                {acciones.length > 0 && <button className="enlace" onClick={() => irA('acciones')}>Ver {acciones.length > 4 ? `las ${acciones.length}` : 'todo'} →</button>}
                            </div>
                            {acciones.length === 0 && (
                                <p className="vacio-guia">No hay respuestas esperando. Cuando un asistente redacte algo, aparece acá para aprobarlo en un clic.</p>
                            )}
                            {acciones.slice(0, 4).map((a) => {
                                const x = resumenAccion(a);
                                return (
                                    <article key={a.id} className="tarjeta-ok">
                                        <div className="tarjeta-ok-top">
                                            <span className={`canal canal-${a.accion}`}>{CANAL[a.accion] ?? a.accion}</span>
                                            <strong>{x.destino || '—'}</strong>
                                            <span className="mono tenue">{hace(a.creado_en)}</span>
                                        </div>
                                        <div className="tarjeta-ok-titulo">{x.titulo}</div>
                                        <p className="tarjeta-ok-cuerpo">{x.cuerpo.replace(/\n{2,}/g, '\n')}</p>
                                        <div className="tarjeta-ok-botones">
                                            <button className="btn-aprobar" disabled={resolviendo === a.id} onClick={() => resolver(a, 'aprobar')}>
                                                {resolviendo === a.id ? 'Enviando…' : 'Aprobar y enviar'}
                                            </button>
                                            <button className="boton-fantasma" onClick={() => irA('acciones')}>Revisar o editar</button>
                                            <button className="boton-fantasma peligro" disabled={resolviendo === a.id} onClick={() => resolver(a, 'rechazar')}>Rechazar</button>
                                        </div>
                                    </article>
                                );
                            })}
                        </section>

                        {/* ---- Columna derecha ---- */}
                        <div className="hoy-columna">
                            <section className="bloque">
                                <div className="bloque-cabeza">
                                    <h2>Prioridades</h2>
                                    <button className="enlace" onClick={() => irA('notion')}>Notion →</button>
                                </div>
                                {prioridades.length === 0 ? (
                                    <p className="vacio-guia">El asistente de Notion arma las prioridades a las 8:30, 13 y 18 h. Podés pedírselas ahora desde Notion.</p>
                                ) : (
                                    <>
                                        {!prioridadesDeHoy && r.prioridades && <p className="nota-tenue">Del {diaCorto(r.prioridades.fecha)} · todavía no hay de hoy</p>}
                                        <ol className="prioridades">
                                            {prioridades.map((p, i) => (
                                                <li key={i}>
                                                    <span className="prio-texto">{p.texto}</span>
                                                    {p.por_que && <span className="prio-porque">{p.por_que}</span>}
                                                </li>
                                            ))}
                                        </ol>
                                    </>
                                )}
                            </section>

                            <section className="bloque">
                                <div className="bloque-cabeza">
                                    <h2>Sin responder</h2>
                                </div>
                                {waPendientes.length === 0 && correosSinResp.length === 0 && tareasUrgentes.length === 0 && (
                                    <p className="vacio-guia">Nadie esperando respuesta. Buen momento para prospectar o hacer seguimientos.</p>
                                )}
                                <ul className="lista-seca">
                                    {waPendientes.map((w, i) => (
                                        <li key={`w${i}`}>
                                            <button className="fila-link" onClick={() => irA('whatsapp')}>
                                                <span className="canal canal-enviar_whatsapp">WhatsApp</span>
                                                <span className="fila-principal"><strong>{w.contacto}</strong> <span className="tenue">“{w.ultimo}”</span></span>
                                                <span className={`mono ${w.hace_horas >= 18 ? 'urgente' : 'tenue'}`}>vence {hora(w.vence)}</span>
                                            </button>
                                        </li>
                                    ))}
                                    {correosSinResp.slice(0, 5).map((c, i) => (
                                        <li key={`c${i}`}>
                                            <div className="fila-link">
                                                <span className="canal canal-enviar_correo">Correo</span>
                                                <span className="fila-principal"><strong>{c.de}</strong> <span className="tenue">{c.asunto}</span></span>
                                                <span className="mono tenue">{hace(c.fecha)}</span>
                                            </div>
                                        </li>
                                    ))}
                                    {tareasUrgentes.slice(0, 4).map((t) => (
                                        <li key={t.id}>
                                            <button className="fila-link" onClick={() => irA('notion')}>
                                                <span className="canal canal-tarea">Tarea</span>
                                                <span className="fila-principal"><strong>{t.titulo}</strong>{t.cliente && <span className="tenue"> · {t.cliente}</span>}</span>
                                                <span className={`mono ${t.fecha_limite! < hoyIso ? 'urgente' : 'tenue'}`}>{t.fecha_limite! < hoyIso ? `venció ${diaCorto(t.fecha_limite!)}` : 'hoy'}</span>
                                            </button>
                                        </li>
                                    ))}
                                </ul>
                            </section>
                        </div>
                    </div>

                    <div className="hoy-trio">
                        <section className="bloque">
                            <div className="bloque-cabeza">
                                <h2>Cotizaciones</h2>
                                <button className="enlace" onClick={() => irA('cotizador')}>Cotizar →</button>
                            </div>
                            {f.cotizaciones_14_dias.length === 0 ? (
                                <p className="vacio-guia">Sin cotizaciones en las últimas 2 semanas.</p>
                            ) : (
                                <ul className="lista-seca">
                                    {f.cotizaciones_14_dias.slice(0, 5).map((c, i) => (
                                        <li key={i} className="fila-dato">
                                            <span className="fila-2l">
                                                <strong>{c.cliente}</strong>
                                                <span className="tenue mono">{c.numero ? `N ${c.numero}` : 'sin PDF'} · {diaCorto(c.fecha)} · {c.renglones} ítem{c.renglones === 1 ? '' : 's'}</span>
                                            </span>
                                            <span className="monto">{usd(c.total_usd)}</span>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </section>

                        <section className="bloque">
                            <div className="bloque-cabeza">
                                <h2>Leads calientes</h2>
                                <button className="enlace" onClick={() => irA('prospeccion')}>Prospección →</button>
                            </div>
                            {f.pipeline.leads_calientes.length === 0 ? (
                                <p className="vacio-guia">Todavía no hay leads. Buscá prospectos desde Prospección.</p>
                            ) : (
                                <ul className="lista-seca">
                                    {f.pipeline.leads_calientes.slice(0, 5).map((l, i) => (
                                        <li key={i} className="fila-dato">
                                            <span className="fila-2l">
                                                <strong>{l.nombre}</strong>
                                                <span className="tenue">{l.ultimo_contacto ? `último contacto ${diaCorto(l.ultimo_contacto)}` : 'sin contactar'}{l.intentos ? ` · ${l.intentos} intento${l.intentos === 1 ? '' : 's'}` : ''}</span>
                                            </span>
                                            {l.icp != null && (
                                                <span className="icp" title={`ICP ${l.icp}/10`}>
                                                    <span className="icp-barra"><span style={{ width: `${l.icp * 10}%` }} /></span>
                                                    <span className="mono">{l.icp}</span>
                                                </span>
                                            )}
                                        </li>
                                    ))}
                                </ul>
                            )}
                            <p className="nota-tenue">
                                {f.pipeline.por_estado.lead ?? 0} leads · {f.pipeline.por_estado.cliente ?? 0} clientes · {f.pipeline.leads_sin_contacto_7d} sin contacto hace más de 7 días
                            </p>
                        </section>

                        <section className="bloque">
                            <div className="bloque-cabeza">
                                <h2>Sistema</h2>
                                <button className="enlace" onClick={() => irA('bitacora')}>Bitácora →</button>
                            </div>
                            <ul className="lista-seca">
                                <li className="fila-dato">
                                    <span className="fila-principal">Costo de IA hoy</span>
                                    <span className="monto">US$ {r.costo_hoy_usd.toFixed(2)}</span>
                                </li>
                                {f.proveedores.map((p) => (
                                    <li key={p.nombre} className="fila-dato">
                                        <span className="fila-principal">
                                            <span className={`semaforo ${p.estado === 'ok' ? 'verde' : p.estado ? 'rojo' : 'gris'}`} aria-hidden="true" />
                                            {p.nombre}
                                        </span>
                                        <span className="tenue mono">
                                            {p.estado === 'ok' ? `${(p.articulos ?? 0).toLocaleString('es-AR')} art.` : p.estado ?? 'sin conectar'}
                                        </span>
                                    </li>
                                ))}
                            </ul>
                        </section>
                    </div>
                </>
            )}
        </div>
    );
}
