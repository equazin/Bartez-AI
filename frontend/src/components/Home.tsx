import { useCallback, useEffect, useState } from 'react';
import { AccionPendiente, Pulso, ResumenHoy, listarAcciones, resumenHoy } from '../api/client.ts';
import { Chat } from './Chat.tsx';
import { AvisosDeshacer, escribiendo, useColaDeshacer } from './Deshacer.tsx';
import { CANAL, hace, resumenAccion } from '../lib/acciones.ts';
import { BarrasEmbudo, ColumnasApiladas, Sparkline } from './graficos.tsx';

type IrA = 'acciones' | 'whatsapp' | 'cotizador' | 'seguimientos' | 'prospeccion' | 'notion' | 'bitacora' | 'dashboard' | 'chat';

const TZ = 'America/Argentina/Buenos_Aires';

const usd = (n: number) => `US$ ${n.toLocaleString('es-AR', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
const usdCorto = (n: number) => (n >= 10_000 ? `US$ ${(n / 1000).toLocaleString('es-AR', { maximumFractionDigits: 1 })} k` : usd(n));
const hora = (iso: string) => new Date(iso).toLocaleTimeString('es-AR', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
const diaCorto = (iso: string) => new Date(iso).toLocaleDateString('es-AR', { timeZone: TZ, day: '2-digit', month: '2-digit' });

// ---------- Chips: lo que pide atención, cada uno lleva a resolverlo ----------

interface Chip { clave: string; texto: string; n: number; tono: 'espera' | 'urgente' | 'normal'; ir: () => void }

function Chips({ chips }: { chips: Chip[] }) {
    return (
        <nav className="hoy-chips" aria-label="Qué pide atención hoy">
            {chips.length === 0 && <span className="hc hc-ok"><span aria-hidden="true">✓</span> Todo al día</span>}
            {chips.map((c) => (
                <button key={c.clave} className={`hc hc-${c.tono}`} onClick={c.ir}>
                    <b>{c.n}</b> {c.texto}
                </button>
            ))}
        </nav>
    );
}

// ---------- La línea: franja fina con el recorrido de hoy ----------

function Linea({ r, tuOk, irA }: { r: ResumenHoy; tuOk: number; irA: (t: IrA) => void }) {
    const l = r.linea;
    const estaciones: Array<{ clave: string; etiqueta: string; numero: number; detalle: string; ir: IrA }> = [
        { clave: 'entra', etiqueta: 'Entra', numero: l.entra.total, detalle: `${l.entra.correos} correo · ${l.entra.whatsapp} WA`, ir: 'whatsapp' },
        { clave: 'propone', etiqueta: 'Propone', numero: l.propone, detalle: 'redactadas', ir: 'acciones' },
        { clave: 'tuok', etiqueta: 'Tu OK', numero: tuOk, detalle: 'esperando', ir: 'acciones' },
        { clave: 'sale', etiqueta: 'Sale', numero: l.sale.aprobadas, detalle: l.sale.rechazadas ? `${l.sale.rechazadas} rechazada${l.sale.rechazadas === 1 ? '' : 's'}` : 'aprobadas', ir: 'bitacora' },
    ];
    return (
        <section className="franja" aria-label="Recorrido de hoy">
            {estaciones.map((e, i) => (
                <button key={e.clave} type="button" className={`franja-paso paso-${e.clave}`} onClick={() => irA(e.ir)}>
                    {i > 0 && <span className="franja-flecha" aria-hidden="true">→</span>}
                    <span className="franja-etq">{e.etiqueta}</span>
                    <span className="franja-num">{e.numero}</span>
                    <span className="franja-det">{e.detalle}</span>
                </button>
            ))}
        </section>
    );
}

// ---------- Indicadores ----------

function Delta({ actual, anterior, sufijo }: { actual: number; anterior: number; sufijo: string }) {
    if (!anterior && !actual) return <span className="delta">sin datos previos</span>;
    if (!anterior) return <span className="delta sube">▲ nuevo</span>;
    const pct = Math.round(((actual - anterior) / anterior) * 100);
    if (pct === 0) return <span className="delta">= {sufijo}</span>;
    return <span className={`delta ${pct > 0 ? 'sube' : 'baja'}`} title={`Antes: ${anterior.toLocaleString('es-AR')}`}>{pct > 0 ? '▲' : '▼'} {Math.abs(pct)}% {sufijo}</span>;
}

function Kpis({ p, irA }: { p: Pulso; irA: (t: IrA) => void }) {
    const k = p.kpis;
    const consultas = p.dias.map((_, i) => (p.consultas_correo[i] ?? 0) + (p.consultas_whatsapp[i] ?? 0));
    const tasa = k.resueltas_30d ? Math.round((k.aprobadas_30d / k.resueltas_30d) * 100) : null;
    const hoy = (v: number[]) => v[v.length - 1] ?? 0;
    return (
        <div className="kpis">
            <button className="kpi" onClick={() => irA('cotizador')}>
                <span className="kpi-etq">Cotizado este mes</span>
                <span className="kpi-num">{usdCorto(k.cotizado_mes_usd)}</span>
                <span className="kpi-pie"><Delta actual={k.cotizado_mes_usd} anterior={k.cotizado_mes_anterior_usd} sufijo="vs mes ant." /><span className="kpi-hoy">hoy {usdCorto(hoy(p.cotizado_usd))}</span></span>
                <Sparkline valores={p.cotizado_usd} titulo="Cotizado por día, últimos 30 días" />
            </button>
            <button className="kpi" onClick={() => irA('cotizador')}>
                <span className="kpi-etq">Presupuestos del mes</span>
                <span className="kpi-num">{k.presupuestos_mes}</span>
                <span className="kpi-pie"><Delta actual={k.presupuestos_mes} anterior={k.presupuestos_mes_anterior} sufijo="vs mes ant." /></span>
                <span className="kpi-nota">con número, en PDF</span>
            </button>
            <button className="kpi" onClick={() => irA('whatsapp')}>
                <span className="kpi-etq">Consultas · 30 días</span>
                <span className="kpi-num">{k.consultas_30d.toLocaleString('es-AR')}</span>
                <span className="kpi-pie"><Delta actual={k.consultas_30d} anterior={k.consultas_30d_anterior} sufijo="vs 30 d ant." /><span className="kpi-hoy">hoy {hoy(consultas)}</span></span>
                <Sparkline valores={consultas} titulo="Consultas por día, últimos 30 días" />
            </button>
            <button className="kpi" onClick={() => irA('prospeccion')}>
                <span className="kpi-etq">Leads nuevos · 30 días</span>
                <span className="kpi-num">{k.leads_30d}</span>
                <span className="kpi-pie"><Delta actual={k.leads_30d} anterior={k.leads_30d_anterior} sufijo="vs 30 d ant." /><span className="kpi-hoy">hoy {hoy(p.leads_nuevos)}</span></span>
                <Sparkline valores={p.leads_nuevos} titulo="Leads nuevos por día, últimos 30 días" />
            </button>
            <button className="kpi" onClick={() => irA('bitacora')}>
                <span className="kpi-etq">Propuestas aprobadas</span>
                <span className="kpi-num">{tasa == null ? '—' : `${tasa}%`}</span>
                <span className="kpi-pie"><span className="delta">{k.aprobadas_30d} de {k.resueltas_30d} en 30 días</span></span>
                <span className="kpi-medidor" aria-hidden="true"><span style={{ width: `${tasa ?? 0}%` }} /></span>
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
            <div className="esq-fila">{[90, 130, 110].map((w) => <span key={w} className="esq esq-chip" style={{ width: w }} />)}</div>
            <span className="esq esq-franja" />
            <div className="esq-trabajo"><span className="esq esq-bloque" /><span className="esq esq-bloque" /></div>
            <div className="esq-kpis">{[1, 2, 3, 4, 5].map((i) => <span key={i} className="esq esq-kpi" />)}</div>
        </div>
    );
}

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
    const prioridades = r?.prioridades?.items ?? [];
    const prioridadesDeHoy = r?.prioridades && new Date(r.prioridades.fecha).toLocaleDateString('en-CA', { timeZone: TZ }) === hoyIso;
    const sinResponder = waPendientes.length + correosSinResp.length + tareasUrgentes.length;
    const tuOk = Math.max((r?.linea.tu_ok ?? 0) - enCola.length, 0);

    const irASinResponder = () => document.getElementById('sin-responder')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const chips: Chip[] = [];
    if (tuOk) chips.push({ clave: 'ok', n: tuOk, texto: tuOk === 1 ? 'espera tu OK' : 'esperan tu OK', tono: 'espera', ir: () => irA('acciones') });
    if (waPendientes.length) chips.push({ clave: 'wa', n: waPendientes.length, texto: waPendientes.length === 1 ? 'WhatsApp vence hoy' : 'WhatsApp vencen hoy', tono: waPendientes.some((w) => w.hace_horas >= 18) ? 'urgente' : 'normal', ir: () => irA('whatsapp') });
    if (correosSinResp.length) chips.push({ clave: 'correo', n: correosSinResp.length, texto: correosSinResp.length === 1 ? 'correo sin responder' : 'correos sin responder', tono: 'normal', ir: irASinResponder });
    if (tareasUrgentes.length) chips.push({ clave: 'tareas', n: tareasUrgentes.length, texto: tareasUrgentes.length === 1 ? 'tarea para hoy' : 'tareas para hoy', tono: tareasUrgentes.some((t) => t.fecha_limite! < hoyIso) ? 'urgente' : 'normal', ir: () => irA('notion') });

    return (
        <div className="hoy">
            <header className="hoy-cabecera">
                <div>
                    <div className="eyebrow">{fecha}</div>
                    <h1>Hoy</h1>
                </div>
                <div className="hoy-actualizado">
                    {r && <span className="hora">Actualizado {hace(r.generado_en)}</span>}
                    <button className={`icono-btn ${cargando ? 'girando' : ''}`} onClick={() => cargar(true)} disabled={cargando} aria-label="Actualizar ahora" title="Actualizar ahora">↻</button>
                </div>
            </header>

            {r && <Chips chips={chips} />}
            {error && <p className="error" role="alert">{error}</p>}
            {!r && !error && <Esqueleto />}

            {r && f && (
                <>
                    <Linea r={r} tuOk={tuOk} irA={irA} />

                    {/* ---- Mesa de trabajo: lo que requiere una acción tuya ---- */}
                    <section className="mesa" aria-label="Trabajo de hoy">
                        <div className={`mesa-col mesa-ok ${visibles.length ? 'con-espera' : ''}`}>
                            <div className="bloque-cabeza">
                                <h2>Para aprobar <span className="cuenta">{visibles.length}</span></h2>
                                {visibles.length > mostradas.length && <button className="enlace" onClick={() => irA('acciones')}>Ver las {visibles.length} →</button>}
                            </div>
                            {visibles.length === 0 ? (
                                <div className="hoy-vacio">
                                    <p>Nada para aprobar. Lo que redacten los asistentes aparece acá.</p>
                                    <button className="boton-fantasma" onClick={() => irA('prospeccion')}>Buscar prospectos →</button>
                                </div>
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

                        <div className="mesa-col mesa-lado">
                            <div id="sin-responder">
                                <div className="bloque-cabeza">
                                    <h2>Sin responder <span className="cuenta">{sinResponder}</span></h2>
                                </div>
                                {sinResponder === 0 ? (
                                    <div className="hoy-vacio">
                                        <p>Nadie esperando respuesta.</p>
                                        <button className="boton-fantasma" onClick={() => irA('seguimientos')}>Hacer seguimientos →</button>
                                    </div>
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
                                        {correosSinResp.slice(0, 5).map((c, i) => (
                                            <li key={`c${i}`}>
                                                <div className="fila-2" title={`${c.de}: ${c.asunto}`}>
                                                    <span className="canal canal-enviar_correo">Correo</span>
                                                    <span className="fila-2-texto"><strong>{c.de}</strong><span className="tenue">{c.asunto}</span></span>
                                                    <span className="hora">{hace(c.fecha)}</span>
                                                </div>
                                            </li>
                                        ))}
                                        {tareasUrgentes.slice(0, 4).map((t) => (
                                            <li key={t.id}>
                                                <button className="fila-2" onClick={() => irA('notion')} title={t.titulo}>
                                                    <span className="canal canal-tarea">Tarea</span>
                                                    <span className="fila-2-texto"><strong>{t.titulo}</strong>{t.cliente && <span className="tenue">{t.cliente}</span>}</span>
                                                    <span className={`hora ${t.fecha_limite! < hoyIso ? 'urgente' : ''}`}>{t.fecha_limite! < hoyIso ? `venció ${diaCorto(t.fecha_limite!)}` : 'hoy'}</span>
                                                </button>
                                            </li>
                                        ))}
                                    </ul>
                                )}
                            </div>

                            <div className="mesa-sep">
                                <div className="bloque-cabeza">
                                    <h2>Prioridades</h2>
                                    <button className="enlace" onClick={() => irA('notion')}>Notion →</button>
                                </div>
                                {prioridades.length === 0 ? (
                                    <div className="hoy-vacio">
                                        <p>El asistente de Notion las arma a las 8:30, 13 y 18 h.</p>
                                        <button className="boton-fantasma" onClick={() => irA('notion')}>Pedirlas ahora →</button>
                                    </div>
                                ) : (
                                    <>
                                        {!prioridadesDeHoy && r.prioridades && <p className="nota-tenue">Del {diaCorto(r.prioridades.fecha)} · todavía no hay de hoy</p>}
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
                            </div>
                        </div>
                    </section>

                    {/* ---- Pulso: para mirar, sin tarjetas ---- */}
                    {p && (
                        <section className="pulso" aria-label="Pulso de los últimos 30 días">
                            <h2 className="zona-titulo">Pulso · últimos 30 días</h2>
                            <Kpis p={p} irA={irA} />
                            <div className="pulso-graficos">
                                <div className="grafico">
                                    <h3>Consultas por día</h3>
                                    <ColumnasApiladas
                                        dias={p.dias}
                                        unidad="consultas"
                                        series={[
                                            { nombre: 'Correo', valores: p.consultas_correo, clase: 'serie-1' },
                                            { nombre: 'WhatsApp', valores: p.consultas_whatsapp, clase: 'serie-2' },
                                        ]}
                                    />
                                </div>
                                <div className="grafico">
                                    <h3>Embudo de prospectos <button className="enlace" onClick={() => irA('seguimientos')}>Clientes →</button></h3>
                                    <BarrasEmbudo pasos={[
                                        { etiqueta: 'Prospectos', valor: p.embudo.prospectos },
                                        { etiqueta: 'Contactados', valor: p.embudo.contactados },
                                        { etiqueta: 'Respondieron', valor: p.embudo.respondieron },
                                        { etiqueta: 'Clientes', valor: p.embudo.clientes },
                                    ]} />
                                    <p className="nota-tenue">{f.pipeline.leads_sin_contacto_7d} leads sin contacto hace más de 7 días.</p>
                                </div>
                            </div>
                        </section>
                    )}

                    <section className="pulso-listas" aria-label="Actividad comercial">
                        <div className="grafico">
                            <h3>Cotizaciones recientes <button className="enlace" onClick={() => irA('cotizador')}>Cotizar →</button></h3>
                            {f.cotizaciones_14_dias.length === 0 ? (
                                <div className="hoy-vacio">
                                    <p>Sin cotizaciones en las últimas 2 semanas.</p>
                                    <button className="boton-fantasma" onClick={() => irA('cotizador')}>Armar una cotización →</button>
                                </div>
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
                                <div className="hoy-vacio">
                                    <p>Todavía no hay leads.</p>
                                    <button className="boton-fantasma" onClick={() => irA('prospeccion')}>Buscar prospectos →</button>
                                </div>
                            ) : (
                                <ul className="lista-seca">
                                    {f.pipeline.leads_calientes.slice(0, 5).map((l, i) => (
                                        <li key={i} className="fila-dato" title={l.nombre}>
                                            <span className="fila-principal"><strong>{l.nombre}</strong> <span className="tenue">{l.ultimo_contacto ? `contacto ${diaCorto(l.ultimo_contacto)}` : 'sin contactar'}</span></span>
                                            {l.icp != null && (
                                                <span className="icp" title={`ICP ${l.icp}/10`}>
                                                    <span className="icp-barra"><span style={{ width: `${l.icp * 10}%` }} /></span>
                                                    <span className="monto">{l.icp}</span>
                                                </span>
                                            )}
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </div>
                    </section>

                    <footer className="hoy-sistema">
                        <button className="enlace" onClick={() => irA('bitacora')}>IA hoy <b>US$ {r.costo_hoy_usd.toFixed(2)}</b></button>
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

            <div className="hoy-dock">
                <AvisosDeshacer enCola={enCola} deshacer={cola.deshacer} />
                <Chat modo="barra" alAbrirChat={() => irA('chat')} />
            </div>
        </div>
    );
}
