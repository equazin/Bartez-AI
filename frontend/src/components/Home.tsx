import { useCallback, useEffect, useState } from 'react';
import { AccionPendiente, Pulso, ResumenHoy, listarAcciones, resumenHoy } from '../api/client.ts';
import { AvisosDeshacer, escribiendo, useColaDeshacer } from './Deshacer.tsx';
import { CANAL, hace, resumenAccion } from '../lib/acciones.ts';
import { BarrasEmbudo, ColumnasApiladas, Sparkline } from './graficos.tsx';

type IrA = 'acciones' | 'whatsapp' | 'cotizador' | 'seguimientos' | 'prospeccion' | 'notion' | 'bitacora' | 'dashboard' | 'chat';

const TZ = 'America/Argentina/Buenos_Aires';

const usd = (n: number) => `US$ ${n.toLocaleString('es-AR', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
const plural = (n: number, uno: string, varios: string) => `${n} ${n === 1 ? uno : varios}`;
const usdCorto = (n: number) => (n >= 10_000 ? `US$ ${(n / 1000).toLocaleString('es-AR', { maximumFractionDigits: 1 })} k` : usd(n));
const hora = (iso: string) => new Date(iso).toLocaleTimeString('es-AR', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
const diaCorto = (iso: string) => new Date(iso).toLocaleDateString('es-AR', { timeZone: TZ, day: '2-digit', month: '2-digit' });

// ---------- Indicadores ----------

function Delta({ actual, anterior, sufijo }: { actual: number; anterior: number; sufijo: string }) {
    if (!anterior && !actual) return <span className="delta">sin datos previos</span>;
    if (!anterior) return <span className="delta sube">▲ nuevo</span>;
    const pct = Math.round(((actual - anterior) / anterior) * 100);
    if (pct === 0) return <span className="delta">= {sufijo}</span>;
    return <span className={`delta ${pct > 0 ? 'sube' : 'baja'}`} title={`Antes: ${anterior.toLocaleString('es-AR')}`}>{pct > 0 ? '▲' : '▼'} {Math.abs(pct)}% {sufijo}</span>;
}

function Kpis({ p, irA }: { p: Pulso; irA: (t: IrA) => void }) {
    // Los campos de cierre llegan desde el backend nuevo; con uno viejo valen 0.
    const k = {
        ...p.kpis,
        ganado_mes_usd: p.kpis.ganado_mes_usd ?? 0,
        ganado_mes_anterior_usd: p.kpis.ganado_mes_anterior_usd ?? 0,
        ganadas_90d: p.kpis.ganadas_90d ?? 0,
        perdidas_90d: p.kpis.perdidas_90d ?? 0,
    };
    const consultas = p.dias.map((_, i) => (p.consultas_correo[i] ?? 0) + (p.consultas_whatsapp[i] ?? 0));
    const cerradas = k.ganadas_90d + k.perdidas_90d;
    return (
        <div className="kpis kpis-4">
            <button className="kpi" onClick={() => irA('cotizador')}>
                <span className="kpi-etq">Cotizado este mes</span>
                <span className="kpi-num">{usdCorto(k.cotizado_mes_usd)}</span>
                <Delta actual={k.cotizado_mes_usd} anterior={k.cotizado_mes_anterior_usd} sufijo="vs mes anterior" />
                <Sparkline valores={p.cotizado_usd} titulo="Cotizado por día, últimos 30 días" />
            </button>
            <button className="kpi" onClick={() => irA('cotizador')}>
                <span className="kpi-etq">Ganado este mes</span>
                <span className="kpi-num">{usdCorto(k.ganado_mes_usd)}</span>
                <Delta actual={k.ganado_mes_usd} anterior={k.ganado_mes_anterior_usd} sufijo="vs mes anterior" />
                <span className="kpi-nota">
                    {cerradas > 0
                        ? <>Cierre <strong>{Math.round((k.ganadas_90d / cerradas) * 100)}%</strong> · {k.ganadas_90d} de {cerradas} en 90 días</>
                        : `${k.presupuestos_mes} presupuestos enviados este mes`}
                </span>
            </button>
            <button className="kpi" onClick={() => irA('whatsapp')}>
                <span className="kpi-etq">Consultas · 30 días</span>
                <span className="kpi-num">{k.consultas_30d.toLocaleString('es-AR')}</span>
                <Delta actual={k.consultas_30d} anterior={k.consultas_30d_anterior} sufijo="vs 30 días antes" />
                <Sparkline valores={consultas} titulo="Consultas por día, últimos 30 días" />
            </button>
            <button className="kpi" onClick={() => irA('prospeccion')}>
                <span className="kpi-etq">Leads nuevos · 30 días</span>
                <span className="kpi-num">{k.leads_30d}</span>
                <Delta actual={k.leads_30d} anterior={k.leads_30d_anterior} sufijo="vs 30 días antes" />
                <Sparkline valores={p.leads_nuevos} titulo="Leads nuevos por día, últimos 30 días" />
            </button>
        </div>
    );
}

// ---------- Para aprobar ----------

function FilaAprobar({ a, idx, abierta, seleccionada, alternar, encolar, irA }: {
    a: AccionPendiente; idx: number; abierta: boolean; seleccionada: boolean; alternar: () => void;
    encolar: (a: AccionPendiente, t: 'aprobar' | 'rechazar') => void; irA: (t: IrA) => void;
}) {
    const x = resumenAccion(a);
    const vista = x.cuerpo.replace(/\s+/g, ' ').trim();
    return (
        <li className={`ok-fila ${abierta ? 'abierta' : ''} ${seleccionada ? 'sel' : ''}`} data-ok-idx={idx}>
            <div
                className="ok-cab" role="button" tabIndex={0} aria-expanded={abierta}
                onClick={alternar}
                onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); e.stopPropagation(); alternar(); } }}
            >
                <span className={`canal canal-${a.accion}`}>{CANAL[a.accion] ?? a.accion}</span>
                <span className="ok-texto">
                    <span className="ok-l1" title={`${x.destino} · ${x.titulo}`}><strong>{x.destino || '—'}</strong> <span className="tenue">· {x.titulo}</span></span>
                    <span className="ok-l2" title={vista}>{vista}</span>
                </span>
                <span className="hora">{hace(a.creado_en)}</span>
                <span className="ok-rapidas">
                    <button className="rapida aprobar" onClick={(e) => { e.stopPropagation(); encolar(a, 'aprobar'); }} aria-label={`Aprobar y enviar a ${x.destino}`} title="Aprobar y enviar (A)">✓</button>
                    <button className="rapida rechazar" onClick={(e) => { e.stopPropagation(); encolar(a, 'rechazar'); }} aria-label={`Rechazar la respuesta a ${x.destino}`} title="Rechazar (R)">✕</button>
                </span>
            </div>
            {abierta && (
                <div className="ok-detalle">
                    <p className="ok-cuerpo">{x.cuerpo.replace(/\n{2,}/g, '\n')}</p>
                    <div className="ok-botones">
                        <button className="btn-aprobar" onClick={() => encolar(a, 'aprobar')}>Aprobar y enviar</button>
                        <button className="boton-fantasma" onClick={() => irA('acciones')}>Editar</button>
                        <button className="boton-fantasma peligro" onClick={() => encolar(a, 'rechazar')}>Rechazar</button>
                    </div>
                </div>
            )}
        </li>
    );
}

// ---------- Esqueleto de carga con la forma real del Inicio ----------

function Esqueleto() {
    return (
        <div className="esqueleto" aria-busy="true" aria-label="Cargando el día">
            <span className="esq esq-plan" />
            <div className="esq-trabajo"><span className="esq esq-bloque" /><span className="esq esq-bloque" /></div>
            <div className="esq-kpis">{[1, 2, 3, 4].map((i) => <span key={i} className="esq esq-kpi" />)}</div>
        </div>
    );
}

const semanaCorta = (d: string) => new Date(`${d}T12:00:00-03:00`).toLocaleDateString('es-AR', { day: 'numeric', month: 'numeric' });
const semanaLarga = (d: string) => `Semana del ${new Date(`${d}T12:00:00-03:00`).toLocaleDateString('es-AR', { day: 'numeric', month: 'long' })}`;

export function Home({ irA }: { irA: (t: IrA) => void }) {
    const [r, setR] = useState<ResumenHoy | null>(null);
    const [acciones, setAcciones] = useState<AccionPendiente[]>([]);
    const [error, setError] = useState<string>();
    const [cargando, setCargando] = useState(false);
    const [abierta, setAbierta] = useState<string | null>(null);
    const [sel, setSel] = useState<number | null>(null);
    const [, setTic] = useState(0);

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
        const tic = setInterval(() => setTic((n) => n + 1), 30_000);
        return () => { clearInterval(t); clearInterval(tic); };
    }, [cargar]);

    // Aprobar o rechazar espera unos segundos con opción de deshacer.
    const cola = useColaDeshacer(async (err) => {
        await cargar(true);
        if (err) setError(err);
    });
    const enCola = cola.enCola;
    const encolar = useCallback((a: AccionPendiente, tipo: 'aprobar' | 'rechazar') => {
        cola.encolar(a.id, tipo, resumenAccion(a).destino);
        setAbierta(null);
    }, [cola.encolar]);

    const visibles = acciones.filter((a) => !enCola.some((x) => x.id === a.id));
    const mostradas = visibles.slice(0, 8);

    // Teclado en Para aprobar: J/K moverse, Enter abrir, A aprobar, R rechazar, E editar.
    useEffect(() => {
        const tecla = (e: KeyboardEvent) => {
            if (e.ctrlKey || e.metaKey || e.altKey || escribiendo(e.target) || mostradas.length === 0) return;
            const k = e.key.toLowerCase();
            if (k === 'j' || k === 'k') {
                e.preventDefault();
                const actual = sel ?? -1;
                const n = k === 'j' ? Math.min(actual + 1, mostradas.length - 1) : Math.max(actual - 1, 0);
                setSel(n);
                document.querySelector(`[data-ok-idx="${n}"]`)?.scrollIntoView({ block: 'nearest' });
                return;
            }
            if (sel == null || !mostradas[sel]) return;
            const a = mostradas[sel];
            if (k === 'a') encolar(a, 'aprobar');
            else if (k === 'r') encolar(a, 'rechazar');
            else if (k === 'e') irA('acciones');
            else if (k === 'enter') setAbierta((v) => (v === a.id ? null : a.id));
            else return;
            e.preventDefault();
        };
        window.addEventListener('keydown', tecla);
        return () => window.removeEventListener('keydown', tecla);
    }, [mostradas, sel, encolar, irA]);
    useEffect(() => {
        if (sel != null && sel >= mostradas.length) setSel(mostradas.length ? mostradas.length - 1 : null);
    }, [sel, mostradas.length]);

    const fecha = new Date().toLocaleDateString('es-AR', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' });
    const f = r?.foto;
    const p = r?.pulso;
    const waPendientes = f?.whatsapp.sin_responder_en_ventana ?? [];
    const correosSinResp = (f?.correos_3_dias.relevantes ?? []).filter((c) => !c.respondido);
    const hoyIso = new Date().toLocaleDateString('en-CA', { timeZone: TZ });
    const tareas = (f?.tareas_notion ?? []).filter((t) => t.estado === 'pendiente');
    const tareasUrgentes = tareas.filter((t) => t.fecha_limite && t.fecha_limite <= hoyIso);
    const tareasVencidas = tareasUrgentes.filter((t) => t.fecha_limite! < hoyIso).length;
    const prioridades = r?.prioridades?.items ?? [];
    const prioridadesDeHoy = r?.prioridades && new Date(r.prioridades.fecha).toLocaleDateString('en-CA', { timeZone: TZ }) === hoyIso;
    const paraResponder = waPendientes.length + correosSinResp.length;
    const esperando = p?.esperando_total ?? 0;
    const todoAlDia = visibles.length === 0 && paraResponder === 0;
    const l = r?.linea;
    const aprobacion = p && p.kpis.resueltas_30d ? Math.round((p.kpis.aprobadas_30d / p.kpis.resueltas_30d) * 100) : null;

    return (
        <div className="hoy">
            <header className="hoy-cabecera">
                <div>
                    <div className="eyebrow">{fecha}</div>
                    <h1>Hoy</h1>
                    {l && l.entra.total === 0 && l.sale.aprobadas === 0 && (
                        <p className="hoy-resumen">Todavía no entró ninguna consulta hoy.</p>
                    )}
                    {l && (l.entra.total > 0 || l.sale.aprobadas > 0) && (
                        <p className="hoy-resumen">
                            Entraron <strong>{plural(l.entra.total, 'consulta', 'consultas')}</strong> ({l.entra.correos} por correo, {l.entra.whatsapp} por WhatsApp)
                            {' · '}los asistentes propusieron {l.propone}{' · '}salieron {l.sale.aprobadas}
                        </p>
                    )}
                </div>
                <div className="hoy-actualizado">
                    {r && <span className="hora">Actualizado {hace(r.generado_en)}</span>}
                    <button className={`icono-btn ${cargando ? 'girando' : ''}`} onClick={() => cargar(true)} disabled={cargando} aria-label="Actualizar ahora" title="Actualizar ahora">↻</button>
                </div>
            </header>

            {error && <p className="error" role="alert">{error}</p>}
            {!r && !error && <Esqueleto />}

            {r && f && (
                <>
                    {/* ---- El plan de hoy ---- */}
                    <section className="plan" aria-label="El plan de hoy">
                        <div className="plan-cab">
                            <h2>El plan de hoy</h2>
                            {r.prioridades && !prioridadesDeHoy && <span className="hora">de {diaCorto(r.prioridades.fecha)}</span>}
                            <button className="enlace" onClick={() => irA('notion')}>Notion →</button>
                        </div>
                        {prioridades.length === 0 ? (
                            <p className="plan-vacio">El asistente de Notion arma el plan a las 8:30, 13 y 18 h. <button className="enlace" onClick={() => irA('notion')}>Pedirlo ahora</button></p>
                        ) : (
                            <ol className="plan-items">
                                {prioridades.slice(0, 3).map((x, i) => (
                                    <li key={i}>
                                        <span className="plan-num">{i + 1}</span>
                                        <span className="plan-texto">
                                            <strong>{x.texto}</strong>
                                            {x.por_que && <span>{x.por_que}</span>}
                                        </span>
                                    </li>
                                ))}
                            </ol>
                        )}
                        {(esperando > 0 || tareasUrgentes.length > 0) && (
                            <p className="plan-ademas">
                                Además:
                                {esperando > 0 && <button className="enlace" onClick={() => irA('cotizador')}>{plural(esperando, 'presupuesto sin respuesta', 'presupuestos sin respuesta')}</button>}
                                {tareasUrgentes.length > 0 && (
                                    <button className={`enlace ${tareasVencidas ? 'enlace-peligro' : ''}`} onClick={() => irA('notion')}>
                                        {plural(tareasUrgentes.length, 'tarea para hoy', 'tareas para hoy')}{tareasVencidas ? ` (${tareasVencidas} vencida${tareasVencidas > 1 ? 's' : ''})` : ''}
                                    </button>
                                )}
                            </p>
                        )}
                    </section>

                    {/* ---- Mesa de trabajo ---- */}
                    {todoAlDia ? (
                        <section className="mesa mesa-al-dia" aria-label="Trabajo de hoy">
                            <div className="al-dia">
                                <span className="al-dia-icono" aria-hidden="true">✓</span>
                                <div>
                                    <h2>Todo al día</h2>
                                    <p>No hay nada para aprobar ni nadie esperando respuesta.</p>
                                </div>
                            </div>
                            <div className="al-dia-ideas">
                                <span className="tenue">Buen momento para:</span>
                                {esperando > 0 && <button className="boton-fantasma" onClick={() => irA('cotizador')}>Seguir {plural(esperando, 'presupuesto', 'presupuestos')} sin respuesta</button>}
                                {f.pipeline.leads_sin_contacto_7d > 0 && <button className="boton-fantasma" onClick={() => irA('prospeccion')}>Contactar {plural(f.pipeline.leads_sin_contacto_7d, 'lead quieto', 'leads quietos')}</button>}
                                <button className="boton-fantasma" onClick={() => irA('prospeccion')}>Buscar prospectos nuevos</button>
                            </div>
                        </section>
                    ) : (
                        <section className="mesa" aria-label="Trabajo de hoy">
                            <div className={`mesa-col mesa-ok ${visibles.length ? 'con-espera' : ''}`}>
                                <div className="bloque-cabeza">
                                    <h2>Para aprobar <span className="cuenta">{visibles.length}</span></h2>
                                    {visibles.length > mostradas.length && <button className="enlace" onClick={() => irA('acciones')}>Ver las {visibles.length} →</button>}
                                </div>
                                {visibles.length === 0 ? (
                                    <p className="mesa-vacio">Nada para aprobar.</p>
                                ) : (
                                    <>
                                        <ul className="lista-seca">
                                            {mostradas.map((a, i) => (
                                                <FilaAprobar
                                                    key={a.id} a={a} idx={i} abierta={abierta === a.id} seleccionada={sel === i}
                                                    alternar={() => { setSel(i); setAbierta((v) => (v === a.id ? null : a.id)); }}
                                                    encolar={encolar} irA={irA}
                                                />
                                            ))}
                                        </ul>
                                        <p className="atajos" aria-hidden="true"><kbd>J</kbd> <kbd>K</kbd> moverse · <kbd>A</kbd> aprobar · <kbd>R</kbd> rechazar · <kbd>E</kbd> editar</p>
                                    </>
                                )}
                            </div>

                            <div className="mesa-col mesa-lado" id="para-responder">
                                <div className="bloque-cabeza">
                                    <h2>Para responder <span className="cuenta">{paraResponder}</span></h2>
                                    {waPendientes.length > 0 && <button className="enlace" onClick={() => irA('whatsapp')}>WhatsApp →</button>}
                                </div>
                                {paraResponder === 0 ? (
                                    <p className="mesa-vacio">Nadie esperando respuesta.</p>
                                ) : (
                                    <ul className="lista-seca">
                                        {waPendientes.map((w, i) => (
                                            <li key={`w${i}`}>
                                                <button className="fila-2" onClick={() => irA('whatsapp')} title={`${w.contacto}: “${w.ultimo}”`}>
                                                    <span className="canal canal-enviar_whatsapp">WA</span>
                                                    <span className="fila-2-texto"><strong>{w.contacto}</strong><span className="tenue">“{w.ultimo}”</span></span>
                                                    <span className={`hora ${w.hace_horas >= 18 ? 'urgente' : ''}`}>vence {hora(w.vence)}</span>
                                                </button>
                                            </li>
                                        ))}
                                        {correosSinResp.slice(0, 6).map((c, i) => (
                                            <li key={`c${i}`}>
                                                <div className="fila-2" title={`${c.de}: ${c.asunto}`}>
                                                    <span className="canal canal-enviar_correo">Correo</span>
                                                    <span className="fila-2-texto"><strong>{c.de}</strong><span className="tenue">{c.asunto}</span></span>
                                                    <span className="hora">{hace(c.fecha)}</span>
                                                </div>
                                            </li>
                                        ))}
                                    </ul>
                                )}
                            </div>
                        </section>
                    )}

                    {/* ---- El negocio ---- */}
                    {p && (
                        <section className="pulso" aria-label="El negocio">
                            <h2 className="zona-titulo">El negocio</h2>
                            <Kpis p={p} irA={irA} />
                            <div className="pulso-graficos">
                                <div className="grafico">
                                    <h3>Consultas por semana</h3>
                                    {p.semanas ? (
                                        <ColumnasApiladas
                                            dias={p.semanas.inicio}
                                            unidad="consultas"
                                            titulo={semanaLarga}
                                            eje={semanaCorta}
                                            cadaEje={1}
                                            anchas
                                            series={[
                                                { nombre: 'Correo', valores: p.semanas.correo, clase: 'serie-1' },
                                                { nombre: 'WhatsApp', valores: p.semanas.whatsapp, clase: 'serie-2' },
                                            ]}
                                        />
                                    ) : (
                                        <ColumnasApiladas
                                            dias={p.dias}
                                            unidad="consultas"
                                            series={[
                                                { nombre: 'Correo', valores: p.consultas_correo, clase: 'serie-1' },
                                                { nombre: 'WhatsApp', valores: p.consultas_whatsapp, clase: 'serie-2' },
                                            ]}
                                        />
                                    )}
                                    <p className="nota-tenue">La última columna es la semana en curso.</p>
                                </div>
                                <div className="grafico">
                                    <h3>Embudo de prospectos <button className="enlace" onClick={() => irA('seguimientos')}>Clientes →</button></h3>
                                    <BarrasEmbudo pasos={[
                                        { etiqueta: 'Prospectos', valor: p.embudo.prospectos },
                                        { etiqueta: 'Contactados', valor: p.embudo.contactados },
                                        { etiqueta: 'Respondieron', valor: p.embudo.respondieron },
                                        { etiqueta: 'Clientes', valor: p.embudo.clientes },
                                    ]} />
                                    <p className="nota-tenue">{plural(f.pipeline.leads_sin_contacto_7d, 'lead', 'leads')} sin contacto hace más de 7 días.</p>
                                </div>
                            </div>
                        </section>
                    )}

                    <section className="pulso-listas" aria-label="Actividad comercial">
                        <div className="grafico">
                            <h3>Cotizaciones recientes <button className="enlace" onClick={() => irA('cotizador')}>Cotizar →</button></h3>
                            {f.cotizaciones_14_dias.length === 0 ? (
                                <p className="tenue">Sin cotizaciones en las últimas 2 semanas.</p>
                            ) : (
                                <ul className="lista-seca">
                                    {f.cotizaciones_14_dias.slice(0, 5).map((c, i) => (
                                        <li key={i} className="fila-dato" title={`${c.cliente} · ${c.renglones} ítems`}>
                                            <span className="fila-principal"><strong>{c.cliente}</strong> <span className="tenue">{c.numero ? `N° ${c.numero}` : 'sin PDF'} · {diaCorto(c.fecha)}</span></span>
                                            <span className="monto">{usd(c.total_usd)}</span>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </div>
                        <div className="grafico">
                            <h3>Leads calientes <button className="enlace" onClick={() => irA('prospeccion')}>Prospección →</button></h3>
                            {f.pipeline.leads_calientes.length === 0 ? (
                                <p className="tenue">Todavía no hay leads.</p>
                            ) : (
                                <ul className="lista-seca">
                                    {f.pipeline.leads_calientes.slice(0, 5).map((ld, i) => (
                                        <li key={i} className="fila-dato" title={ld.nombre}>
                                            <span className="fila-principal"><strong>{ld.nombre}</strong> <span className="tenue">{ld.ultimo_contacto ? `contacto ${diaCorto(ld.ultimo_contacto)}` : 'sin contactar'}</span></span>
                                            {ld.icp != null && (
                                                <span className="icp" title={`Encaje con el cliente ideal: ${ld.icp}/10`}>
                                                    <span className="icp-barra"><span style={{ width: `${ld.icp * 10}%` }} /></span>
                                                    <span className="monto">{ld.icp}</span>
                                                </span>
                                            )}
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </div>
                    </section>

                    {/* ---- Los asistentes y el sistema ---- */}
                    <footer className="hoy-sistema">
                        <span className="hoy-sistema-titulo">Asistentes</span>
                        {aprobacion != null && <button className="enlace" onClick={() => irA('dashboard')}>Aprobás el <b>{aprobacion}%</b> de lo que proponen</button>}
                        <button className="enlace" onClick={() => irA('dashboard')}>IA hoy <b>US$ {r.costo_hoy_usd.toFixed(2)}</b></button>
                        {f.proveedores.map((x) => (
                            <span key={x.nombre} title={x.ultima_sync ? `Última sincronización ${diaCorto(x.ultima_sync)} ${hora(x.ultima_sync)}` : 'Sin sincronizar'}>
                                <span className={`semaforo ${x.estado === 'ok' ? 'verde' : x.estado ? 'rojo' : 'gris'}`} aria-hidden="true" />
                                {x.nombre} <span className="tenue">{x.estado === 'ok' ? `${(x.articulos ?? 0).toLocaleString('es-AR')} art.` : x.estado ?? 'sin conectar'}</span>
                            </span>
                        ))}
                        <button className="enlace" onClick={() => irA('notion')}>Notion <span className="tenue">{hora(f.generado_en)}</span></button>
                    </footer>
                </>
            )}

            <div className="dock-avisos"><AvisosDeshacer enCola={enCola} deshacer={cola.deshacer} /></div>
        </div>
    );
}
