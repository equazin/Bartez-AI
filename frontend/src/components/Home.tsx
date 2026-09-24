import { useCallback, useEffect, useState } from 'react';
import { AccionPendiente, Pulso, ResumenHoy, listarAcciones, resolverAccion, resumenHoy } from '../api/client.ts';
import { Chat } from './Chat.tsx';
import { BarrasEmbudo, ColumnasApiladas, Sparkline } from './graficos.tsx';

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

const plural = (n: number, uno: string, varios: string) => `${n} ${n === 1 ? uno : varios}`;
const usdCorto = (n: number) => (n >= 10_000 ? `US$ ${(n / 1000).toLocaleString('es-AR', { maximumFractionDigits: 1 })} k` : usd(n));

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

// ---------- Estado en una línea ----------

function estadoDelDia(tuOk: number, waVencen: number, correos: number, tareasVencidas: number): string {
    const partes: string[] = [];
    if (tuOk) partes.push(`${plural(tuOk, 'espera', 'esperan')} tu OK`);
    if (waVencen) partes.push(`${plural(waVencen, 'WhatsApp vence', 'WhatsApp vencen')} hoy`);
    if (correos) partes.push(`${plural(correos, 'correo', 'correos')} sin responder`);
    if (tareasVencidas) partes.push(`${plural(tareasVencidas, 'tarea', 'tareas')} para hoy`);
    return partes.length ? partes.join('\u00a0· ') : 'Todo al día. Buen momento para prospectar.';
}

// ---------- La línea: el recorrido real de cada consulta ----------

function Linea({ r, irA }: { r: ResumenHoy; irA: (t: IrA) => void }) {
    const l = r.linea;
    const estaciones: Array<{ clave: string; etiqueta: string; numero: number; detalle: string; ir: IrA }> = [
        { clave: 'entra', etiqueta: 'Entra', numero: l.entra.total, detalle: `${l.entra.correos} correo · ${l.entra.whatsapp} WA`, ir: 'whatsapp' },
        { clave: 'propone', etiqueta: 'Propone', numero: l.propone, detalle: 'redactadas hoy', ir: 'acciones' },
        { clave: 'tuok', etiqueta: 'Tu OK', numero: l.tu_ok, detalle: l.tu_ok === 0 ? 'nada esperando' : 'revisar →', ir: 'acciones' },
        { clave: 'sale', etiqueta: 'Sale', numero: l.sale.aprobadas, detalle: l.sale.rechazadas ? `${l.sale.rechazadas} rechazada${l.sale.rechazadas === 1 ? '' : 's'}` : 'aprobadas hoy', ir: 'bitacora' },
    ];
    return (
        <section className="linea" aria-label="Recorrido de hoy">
            <div className="linea-riel" aria-hidden="true" />
            {estaciones.map((e) => (
                <button key={e.clave} type="button" className={`estacion est-${e.clave} ${e.clave === 'tuok' && e.numero > 0 ? 'espera' : ''}`} onClick={() => irA(e.ir)}>
                    <span className="est-punto" aria-hidden="true" />
                    <span className="est-etiqueta">{e.etiqueta}</span>
                    <span className="est-numero">{e.numero}</span>
                    <span className="est-detalle">{e.detalle}</span>
                </button>
            ))}
        </section>
    );
}

// ---------- Indicadores ----------

function Delta({ actual, anterior, sufijo }: { actual: number; anterior: number; sufijo: string }) {
    if (!anterior && !actual) return <span className="delta">sin datos previos</span>;
    if (!anterior) return <span className="delta sube">▲ nuevo {sufijo}</span>;
    const pct = Math.round(((actual - anterior) / anterior) * 100);
    if (pct === 0) return <span className="delta">= igual {sufijo}</span>;
    return <span className={`delta ${pct > 0 ? 'sube' : 'baja'}`}>{pct > 0 ? '▲' : '▼'} {Math.abs(pct)}% {sufijo}</span>;
}

function Kpis({ p, irA }: { p: Pulso; irA: (t: IrA) => void }) {
    const k = p.kpis;
    const consultas = p.dias.map((_, i) => (p.consultas_correo[i] ?? 0) + (p.consultas_whatsapp[i] ?? 0));
    const tasa = k.resueltas_30d ? Math.round((k.aprobadas_30d / k.resueltas_30d) * 100) : null;
    return (
        <section className="kpis" aria-label="Indicadores">
            <button className="kpi" onClick={() => irA('cotizador')}>
                <span className="kpi-etq">Cotizado este mes</span>
                <span className="kpi-num">{usdCorto(k.cotizado_mes_usd)}</span>
                <Delta actual={k.cotizado_mes_usd} anterior={k.cotizado_mes_anterior_usd} sufijo="vs mes ant." />
                <Sparkline valores={p.cotizado_usd} titulo="Cotizado por día, últimos 30 días" />
            </button>
            <button className="kpi" onClick={() => irA('cotizador')}>
                <span className="kpi-etq">Presupuestos del mes</span>
                <span className="kpi-num">{k.presupuestos_mes}</span>
                <Delta actual={k.presupuestos_mes} anterior={k.presupuestos_mes_anterior} sufijo="vs mes ant." />
                <span className="kpi-nota">con número, en PDF</span>
            </button>
            <button className="kpi" onClick={() => irA('whatsapp')}>
                <span className="kpi-etq">Consultas · 30 días</span>
                <span className="kpi-num">{k.consultas_30d.toLocaleString('es-AR')}</span>
                <Delta actual={k.consultas_30d} anterior={k.consultas_30d_anterior} sufijo="vs 30 d ant." />
                <Sparkline valores={consultas} titulo="Consultas por día, últimos 30 días" />
            </button>
            <button className="kpi" onClick={() => irA('prospeccion')}>
                <span className="kpi-etq">Leads nuevos · 30 días</span>
                <span className="kpi-num">{k.leads_30d}</span>
                <Delta actual={k.leads_30d} anterior={k.leads_30d_anterior} sufijo="vs 30 d ant." />
                <Sparkline valores={p.leads_nuevos} titulo="Leads nuevos por día, últimos 30 días" />
            </button>
            <button className="kpi" onClick={() => irA('bitacora')}>
                <span className="kpi-etq">Propuestas aprobadas</span>
                <span className="kpi-num">{tasa == null ? '—' : `${tasa}%`}</span>
                <span className="delta">{k.aprobadas_30d} de {k.resueltas_30d} en 30 días</span>
                <span className="kpi-medidor" aria-hidden="true"><span style={{ width: `${tasa ?? 0}%` }} /></span>
            </button>
        </section>
    );
}

// ---------- Para aprobar: filas que se abren ----------

function FilaAprobar({ a, abierta, alternar, resolviendo, resolver, irA }: {
    a: AccionPendiente; abierta: boolean; alternar: () => void; resolviendo: boolean;
    resolver: (a: AccionPendiente, t: 'aprobar' | 'rechazar') => void; irA: (t: IrA) => void;
}) {
    const x = resumenAccion(a);
    return (
        <li className={`fila-ok ${abierta ? 'abierta' : ''}`}>
            <button className="fila-link" onClick={alternar} aria-expanded={abierta}>
                <span className={`canal canal-${a.accion}`}>{CANAL[a.accion] ?? a.accion}</span>
                <span className="fila-principal"><strong>{x.destino || '—'}</strong> <span className="tenue">{x.titulo}</span></span>
                <span className="mono tenue">{hace(a.creado_en)}</span>
            </button>
            {abierta && (
                <div className="fila-ok-detalle">
                    <p className="tarjeta-ok-cuerpo">{x.cuerpo.replace(/\n{2,}/g, '\n')}</p>
                    <div className="tarjeta-ok-botones">
                        <button className="btn-aprobar" disabled={resolviendo} onClick={() => resolver(a, 'aprobar')}>{resolviendo ? 'Enviando…' : 'Aprobar y enviar'}</button>
                        <button className="boton-fantasma" onClick={() => irA('acciones')}>Editar</button>
                        <button className="boton-fantasma peligro" disabled={resolviendo} onClick={() => resolver(a, 'rechazar')}>Rechazar</button>
                    </div>
                </div>
            )}
        </li>
    );
}

export function Home({ irA }: { irA: (t: IrA) => void }) {
    const [r, setR] = useState<ResumenHoy | null>(null);
    const [acciones, setAcciones] = useState<AccionPendiente[]>([]);
    const [error, setError] = useState<string>();
    const [cargando, setCargando] = useState(false);
    const [resolviendo, setResolviendo] = useState<string | null>(null);
    const [abierta, setAbierta] = useState<string | null>(null);

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
    const p = r?.pulso;
    const waPendientes = f?.whatsapp.sin_responder_en_ventana ?? [];
    const correosSinResp = (f?.correos_3_dias.relevantes ?? []).filter((c) => !c.respondido);
    const hoyIso = new Date().toLocaleDateString('en-CA', { timeZone: TZ });
    const tareas = (f?.tareas_notion ?? []).filter((t) => t.estado === 'pendiente');
    const tareasUrgentes = tareas.filter((t) => t.fecha_limite && t.fecha_limite <= hoyIso);
    const prioridades = r?.prioridades?.items ?? [];
    const prioridadesDeHoy = r?.prioridades && new Date(r.prioridades.fecha).toLocaleDateString('en-CA', { timeZone: TZ }) === hoyIso;
    const sinResponder = waPendientes.length + correosSinResp.length + tareasUrgentes.length;

    return (
        <div className="hoy">
            <header className="hoy-cabecera">
                <div>
                    <div className="eyebrow">{fecha}</div>
                    <h1>{r ? estadoDelDia(r.linea.tu_ok, waPendientes.length, correosSinResp.length, tareasUrgentes.length) : 'Cargando el día…'}</h1>
                </div>
                <div className="hoy-actualizado">
                    {r && <span className="mono">{hora(r.generado_en)}</span>}
                    <button className="boton-fantasma" onClick={() => cargar(true)} disabled={cargando}>
                        {cargando ? 'Actualizando…' : 'Actualizar'}
                    </button>
                </div>
            </header>

            {error && <p className="error">{error}</p>}

            {r && f && (
                <>
                    <Linea r={r} irA={irA} />

                    {p && <Kpis p={p} irA={irA} />}

                    {p && (
                        <div className="hoy-graficos">
                            <section className="bloque">
                                <div className="bloque-cabeza">
                                    <h2>Consultas por día</h2>
                                    <span className="tenue mono">últimos 30 días</span>
                                </div>
                                <ColumnasApiladas
                                    dias={p.dias}
                                    unidad="consultas"
                                    series={[
                                        { nombre: 'Correo', valores: p.consultas_correo, clase: 'serie-1' },
                                        { nombre: 'WhatsApp', valores: p.consultas_whatsapp, clase: 'serie-2' },
                                    ]}
                                />
                            </section>
                            <section className="bloque">
                                <div className="bloque-cabeza">
                                    <h2>Embudo de prospectos</h2>
                                    <button className="enlace" onClick={() => irA('seguimientos')}>Clientes →</button>
                                </div>
                                <BarrasEmbudo pasos={[
                                    { etiqueta: 'Prospectos', valor: p.embudo.prospectos },
                                    { etiqueta: 'Contactados', valor: p.embudo.contactados },
                                    { etiqueta: 'Respondieron', valor: p.embudo.respondieron },
                                    { etiqueta: 'Clientes', valor: p.embudo.clientes },
                                ]} />
                                <p className="nota-tenue">El % es la conversión desde el paso anterior. {f.pipeline.leads_sin_contacto_7d} leads sin contacto hace más de 7 días.</p>
                            </section>
                        </div>
                    )}

                    <div className="hoy-trabajo">
                        <section className={`bloque ${acciones.length ? 'bloque-espera' : ''}`}>
                            <div className="bloque-cabeza">
                                <h2>Para aprobar <span className="cuenta">{acciones.length}</span></h2>
                                {acciones.length > 0 && <button className="enlace" onClick={() => irA('acciones')}>Todo →</button>}
                            </div>
                            {acciones.length === 0 ? (
                                <p className="vacio-guia">Nada esperando. Lo que redacten los asistentes aparece acá.</p>
                            ) : (
                                <ul className="lista-seca">
                                    {acciones.slice(0, 6).map((a) => (
                                        <FilaAprobar
                                            key={a.id} a={a} abierta={abierta === a.id}
                                            alternar={() => setAbierta((v) => (v === a.id ? null : a.id))}
                                            resolviendo={resolviendo === a.id} resolver={resolver} irA={irA}
                                        />
                                    ))}
                                </ul>
                            )}
                        </section>

                        <section className="bloque">
                            <div className="bloque-cabeza">
                                <h2>Sin responder <span className="cuenta">{sinResponder}</span></h2>
                            </div>
                            {sinResponder === 0 && <p className="vacio-guia">Nadie esperando respuesta.</p>}
                            <ul className="lista-seca">
                                {waPendientes.map((w, i) => (
                                    <li key={`w${i}`}>
                                        <button className="fila-link" onClick={() => irA('whatsapp')}>
                                            <span className="canal canal-enviar_whatsapp">WA</span>
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

                        <section className="bloque">
                            <div className="bloque-cabeza">
                                <h2>Prioridades</h2>
                                <button className="enlace" onClick={() => irA('notion')}>Notion →</button>
                            </div>
                            {prioridades.length === 0 ? (
                                <p className="vacio-guia">Se arman a las 8:30, 13 y 18 h.</p>
                            ) : (
                                <>
                                    {!prioridadesDeHoy && r.prioridades && <p className="nota-tenue">Del {diaCorto(r.prioridades.fecha)}</p>}
                                    <ol className="prioridades">
                                        {prioridades.map((x, i) => (
                                            <li key={i}>
                                                <span className="prio-texto">{x.texto}</span>
                                                {x.por_que && <span className="prio-porque">{x.por_que}</span>}
                                            </li>
                                        ))}
                                    </ol>
                                </>
                            )}
                        </section>
                    </div>

                    <div className="hoy-dos">
                        <section className="bloque">
                            <div className="bloque-cabeza">
                                <h2>Cotizaciones recientes</h2>
                                <button className="enlace" onClick={() => irA('cotizador')}>Cotizar →</button>
                            </div>
                            {f.cotizaciones_14_dias.length === 0 ? (
                                <p className="vacio-guia">Sin cotizaciones en las últimas 2 semanas.</p>
                            ) : (
                                <ul className="lista-seca">
                                    {f.cotizaciones_14_dias.slice(0, 5).map((c, i) => (
                                        <li key={i} className="fila-dato">
                                            <span className="fila-principal"><strong>{c.cliente}</strong> <span className="tenue mono">{c.numero ? `N ${c.numero}` : 'sin PDF'} · {diaCorto(c.fecha)}</span></span>
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
                                <p className="vacio-guia">Todavía no hay leads.</p>
                            ) : (
                                <ul className="lista-seca">
                                    {f.pipeline.leads_calientes.slice(0, 5).map((l, i) => (
                                        <li key={i} className="fila-dato">
                                            <span className="fila-principal"><strong>{l.nombre}</strong> <span className="tenue">{l.ultimo_contacto ? `contacto ${diaCorto(l.ultimo_contacto)}` : 'sin contactar'}</span></span>
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
                        </section>
                    </div>

                    <footer className="hoy-sistema">
                        <button className="enlace" onClick={() => irA('bitacora')}>IA hoy <b className="mono">US$ {r.costo_hoy_usd.toFixed(2)}</b></button>
                        {f.proveedores.map((x) => (
                            <span key={x.nombre} title={x.ultima_sync ? `Última sync ${diaCorto(x.ultima_sync)} ${hora(x.ultima_sync)}` : undefined}>
                                <span className={`semaforo ${x.estado === 'ok' ? 'verde' : x.estado ? 'rojo' : 'gris'}`} aria-hidden="true" />
                                {x.nombre} <span className="mono tenue">{x.estado === 'ok' ? `${(x.articulos ?? 0).toLocaleString('es-AR')} art.` : x.estado ?? 'sin conectar'}</span>
                            </span>
                        ))}
                        <button className="enlace" onClick={() => irA('notion')}>Notion <span className="mono tenue">{hora(f.generado_en)}</span></button>
                    </footer>
                </>
            )}

            <div className="hoy-chat">
                <Chat compacto alAbrirChat={() => irA('chat')} />
            </div>
        </div>
    );
}
