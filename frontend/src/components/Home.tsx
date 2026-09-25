import { CSSProperties, useCallback, useEffect, useState } from 'react';
import { AccionPendiente, SIN_MAPA, AreaMapa, AsistenteMapa, Mapa, NodoMapa, Pulso, ResumenHoy, listarAcciones, listarEnviosFallidos, mapaNegocio, resumenHoy } from '../api/client.ts';
import { AvisosDeshacer, escribiendo, useColaDeshacer } from './Deshacer.tsx';
import { CANAL, hace, resumenAccion } from '../lib/acciones.ts';
import { preguntarABartez } from '../lib/bartez.ts';
import { abrirEnCotizador } from '../lib/cotizador.ts';
import { useContar } from '../lib/animar.ts';
import { ListaNegocio, MapaNegocio, Seleccion, metricaAsistente } from './inicio/MapaNegocio.tsx';

type IrA = 'acciones' | 'whatsapp' | 'cotizador' | 'seguimientos' | 'prospeccion' | 'notion' | 'bitacora' | 'dashboard' | 'chat';

const TZ = 'America/Argentina/Buenos_Aires';

const usd = (n: number) => `US$ ${n.toLocaleString('es-AR', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
const plural = (n: number, uno: string, varios: string) => `${n} ${n === 1 ? uno : varios}`;
const usdCorto = (n: number) => (n >= 10_000 ? `US$ ${(n / 1000).toLocaleString('es-AR', { maximumFractionDigits: 1 })} k` : usd(n));
const hora = (iso: string) => new Date(iso).toLocaleTimeString('es-AR', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
const diaCorto = (iso: string) => new Date(iso).toLocaleDateString('es-AR', { timeZone: TZ, day: 'numeric', month: 'numeric' });
const MESES = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
const MESES_LARGOS = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

// A qué pantalla lleva cada asistente del mapa.
const PANTALLA: Record<AreaMapa | 'notion', IrA> = {
    seguimientos: 'seguimientos', cotizador: 'cotizador', correo: 'acciones', whatsapp: 'whatsapp', prospeccion: 'prospeccion', notion: 'notion',
};
const QUE_ES: Record<NodoMapa['tipo'], string> = { cliente: 'Cliente', presupuesto: 'Presupuesto', conversacion: 'Conversación de WhatsApp' };

function Delta({ actual, anterior }: { actual: number; anterior: number }) {
    if (!anterior) return null;
    const pct = Math.round(((actual - anterior) / anterior) * 100);
    if (!pct) return <span className="g-delta">= mes pasado</span>;
    return <span className="g-delta" title={`El mes pasado a esta altura: ${usd(anterior)}`}>{pct > 0 ? '+' : '−'}{Math.abs(pct)}%</span>;
}

// ---------- Tarjeta del mes: Ganado o Cotizado como número principal ----------

type Principal = 'ganado' | 'cotizado';
const CLAVE_PRINCIPAL = 'bartez_mes_principal';
function leerPrincipal(): Principal {
    try { return localStorage.getItem(CLAVE_PRINCIPAL) === 'cotizado' ? 'cotizado' : 'ganado'; } catch { return 'ganado'; }
}

function TarjetaMes({ p, cierre, irA }: { p: Pulso; cierre: number | null; irA: (t: IrA) => void }) {
    const k = p.kpis;
    const [principal, setPrincipal] = useState<Principal>(leerPrincipal);
    const elegirPrincipal = (x: Principal) => {
        setPrincipal(x);
        try { localStorage.setItem(CLAVE_PRINCIPAL, x); } catch { /* sin storage: solo esta vez */ }
    };
    const ganado = k.ganado_mes_usd ?? 0, cotizado = k.cotizado_mes_usd;
    const valor = principal === 'ganado' ? ganado : cotizado;
    const anterior = principal === 'ganado' ? k.ganado_mes_anterior_usd ?? 0 : k.cotizado_mes_anterior_usd;
    const animado = useContar(valor);
    return (
        <section className="g-ganado" aria-label={principal === 'ganado' ? 'Ganado este mes' : 'Cotizado este mes'}>
            <div className="g-ganado-cab">
                <div className="g-mes-elegir" role="group" aria-label="Número principal">
                    <button className="g-b" aria-pressed={principal === 'ganado'} onClick={() => elegirPrincipal('ganado')}>Ganado</button>
                    <button className="g-b" aria-pressed={principal === 'cotizado'} onClick={() => elegirPrincipal('cotizado')}>Cotizado</button>
                </div>
                <Delta actual={valor} anterior={anterior} />
            </div>
            <span className="g-ganado-etq">{principal === 'ganado' ? 'Ganado este mes' : `Cotizado este mes · ${plural(k.presupuestos_mes, 'presupuesto', 'presupuestos')}`}</span>
            <strong className="g-ganado-num" key={principal}>{usd(Math.round(animado))}</strong>
            <div className="g-ganado-mini">
                {principal === 'ganado'
                    ? <button className="g-b" onClick={() => elegirPrincipal('cotizado')} title="Ver lo cotizado como número principal"><span>Cotizado</span><strong>{usdCorto(cotizado)}</strong></button>
                    : <button className="g-b" onClick={() => elegirPrincipal('ganado')} title="Ver lo ganado como número principal"><span>Ganado</span><strong>{usdCorto(ganado)}</strong></button>}
                <button className="g-b" onClick={() => irA('cotizador')}><span>Cierre · 90 d</span><strong>{cierre != null ? `${cierre}%` : '—'}</strong></button>
                <button className="g-b" onClick={() => irA('whatsapp')}><span>Consultas · 30 d</span><strong>{k.consultas_30d.toLocaleString('es-AR')}</strong></button>
            </div>
        </section>
    );
}

// ---------- Panel derecho: detalle del nodo elegido o el día ----------

function Acciones({ acciones, irA }: { acciones: NodoMapa['acciones']; irA: (t: IrA) => void }) {
    return (
        <div className="g-det-botones">
            {acciones.map((a, i) => (
                <button
                    key={a.etiqueta}
                    className={i === 0 ? 'g-btn' : 'g-btn-sec'}
                    onClick={() => {
                        if (a.tipo === 'chat' && a.texto) { preguntarABartez(a.texto); return; }
                        if (a.cotizacion_id) abrirEnCotizador(a.cotizacion_id);
                        if (a.destino) irA(a.destino);
                    }}
                >
                    {a.etiqueta}{a.tipo === 'chat' && i === 0 ? ' ✦' : ''}
                </button>
            ))}
        </div>
    );
}

function DetalleNodo({ n, area, irA, cerrar }: { n: NodoMapa; area: AsistenteMapa; irA: (t: IrA) => void; cerrar: () => void }) {
    const datos: Array<{ etq: string; valor: string; alerta?: boolean }> = [];
    if (n.en_juego_usd != null) datos.push({ etq: 'En juego', valor: usd(n.en_juego_usd) });
    if (n.dias_sin_respuesta != null) datos.push({ etq: 'Sin respuesta', valor: plural(n.dias_sin_respuesta, 'día', 'días'), alerta: n.dias_sin_respuesta >= 5 });
    if (n.compras != null) datos.push({ etq: 'Compró', valor: n.compras ? plural(n.compras, 'vez', 'veces') : 'todavía no' });
    if (n.consultas > 0 && datos.length < 3) datos.push({ etq: 'Consultas · 30 d', valor: String(n.consultas) });
    return (
        <section className="g-detalle" aria-label={`Detalle de ${n.nombre}`}>
            <div className="g-det-cab">
                <span className={`g-orbe ${n.tipo}`} aria-hidden="true" />
                <div className="g-det-titulo">
                    <h2>{n.nombre}</h2>
                    <span>{QUE_ES[n.tipo]} · lo sigue el asistente {area.nombre}</span>
                </div>
                <button className="g-cerrar" onClick={cerrar} aria-label="Cerrar el detalle">×</button>
            </div>
            {datos.length > 0 && (
                <div className="g-det-datos">
                    {datos.slice(0, 3).map((d) => (
                        <div key={d.etq} className={d.alerta ? 'alerta' : undefined}><span>{d.etq}</span><strong>{d.valor}</strong></div>
                    ))}
                </div>
            )}
            {n.historia.length > 0 && (
                <>
                    <h3 className="g-det-sub">Historia</h3>
                    <ol className="g-historia">
                        {n.historia.map((h, i) => (
                            <li key={i}><span className={`g-hito ${h.tipo}`} aria-hidden="true" /><span className="g-historia-texto">{h.texto}</span><span className="g-historia-fecha">{diaCorto(h.fecha)}</span></li>
                        ))}
                    </ol>
                </>
            )}
            <div className="g-sugiere"><strong>Bartez AI sugiere</strong><p>{n.sugerencia}</p></div>
            <Acciones acciones={n.acciones} irA={irA} />
        </section>
    );
}

function DetalleAsistente({ a, tareas, elegir, irA, cerrar }: {
    a: AsistenteMapa | null; tareas: ResumenHoy['foto']['tareas_notion']; elegir: (s: Seleccion) => void; irA: (t: IrA) => void; cerrar: () => void;
}) {
    const area: AreaMapa | 'notion' = a?.area ?? 'notion';
    const nombre = a?.nombre ?? 'Notion';
    return (
        <section className="g-detalle" aria-label={`Asistente ${nombre}`}>
            <div className="g-det-cab">
                <span className="g-orbe asistente" aria-hidden="true" />
                <div className="g-det-titulo">
                    <h2>{nombre}</h2>
                    <span>{a ? metricaAsistente(a) : plural(tareas.length, 'tarea pendiente', 'tareas pendientes')}{a && a.resueltas_30d > 0 ? ` · ${plural(a.resueltas_30d, 'decisión', 'decisiones')} tuyas en 30 días` : ''}</span>
                </div>
                <button className="g-cerrar" onClick={cerrar} aria-label="Cerrar el detalle">×</button>
            </div>
            {a ? (
                a.nodos.length === 0 ? <p className="g-det-vacio">Nada en curso por ahora.</p> : (
                    <ul className="g-det-lista">
                        {a.nodos.map((n) => (
                            <li key={n.id}>
                                <button className="g-b" onClick={() => elegir({ tipo: 'nodo', area: a.area, id: n.id })}>
                                    <span className={`g-orbe chico ${n.tipo}`} aria-hidden="true" />
                                    <span><strong>{n.nombre}</strong><span>{n.subtitulo}</span></span>
                                </button>
                            </li>
                        ))}
                    </ul>
                )
            ) : (
                tareas.length === 0 ? <p className="g-det-vacio">Sin tareas pendientes en Notion.</p> : (
                    <ul className="g-det-lista">
                        {tareas.slice(0, 5).map((t) => (
                            <li key={t.id}><button className="g-b" onClick={() => irA('notion')}><span className="g-orbe chico tarea" aria-hidden="true" /><span><strong>{t.titulo}</strong><span>{t.cliente}{t.fecha_limite ? ` · vence ${diaCorto(t.fecha_limite)}` : ''}</span></span></button></li>
                        ))}
                    </ul>
                )
            )}
            <div className="g-det-botones">
                <button className="g-btn" onClick={() => irA(PANTALLA[area])}>Abrir {nombre}</button>
                <button className="g-btn-sec" onClick={() => preguntarABartez(`¿Qué tiene pendiente el asistente de ${nombre} y qué es lo más importante?`)}>Preguntar ✦</button>
            </div>
        </section>
    );
}

function PanelHoy({ r, irA }: { r: ResumenHoy; irA: (t: IrA) => void }) {
    const f = r.foto;
    const hoyIso = new Date().toLocaleDateString('en-CA', { timeZone: TZ });
    const prioridades = r.prioridades?.items ?? [];
    const wa = f.whatsapp.sin_responder_en_ventana;
    const correos = f.correos_3_dias.relevantes.filter((c) => !c.respondido);
    const tareasHoy = f.tareas_notion.filter((t) => t.estado === 'pendiente' && t.fecha_limite && t.fecha_limite <= hoyIso);
    return (
        <section className="g-detalle g-hoy" aria-label="El plan de hoy">
            <div className="g-det-cab">
                <div className="g-det-titulo"><h2>El plan de hoy</h2><span>{r.prioridades ? `Armado ${diaCorto(r.prioridades.fecha)} a las ${hora(r.prioridades.fecha)}` : 'Lo arma el asistente de Notion a las 8:30, 13 y 18 h'}</span></div>
            </div>
            {prioridades.length === 0 ? (
                <p className="g-det-vacio">Todavía no hay plan. <button className="enlace" onClick={() => irA('notion')}>Pedirlo ahora</button></p>
            ) : (
                <ol className="g-plan">
                    {prioridades.slice(0, 3).map((x, i) => (
                        <li key={i}><span className="g-plan-num">{i + 1}</span><span><strong>{x.texto}</strong>{x.por_que && <span>{x.por_que}</span>}</span></li>
                    ))}
                </ol>
            )}
            <div className="g-hoy-chips">
                <button className="g-b" onClick={() => irA('whatsapp')} disabled={!wa.length}><strong>{wa.length}</strong> WhatsApp sin responder</button>
                <button className="g-b" onClick={() => irA('acciones')} disabled={!correos.length}><strong>{correos.length}</strong> {correos.length === 1 ? 'correo' : 'correos'} sin respuesta</button>
                {tareasHoy.length > 0 && <button className="g-b" onClick={() => irA('notion')}><strong>{tareasHoy.length}</strong> {tareasHoy.length === 1 ? 'tarea' : 'tareas'} para hoy</button>}
            </div>
            <p className="g-pista">Tocá un cliente o un asistente del mapa para ver su detalle.</p>
        </section>
    );
}

// ---------- Ganado y perdido por mes ----------

function Flujo({ meses }: { meses: Mapa['meses'] }) {
    const [foco, setFoco] = useState<number | null>(null);
    const total = meses.reduce((s, m) => s + m.ganado_usd, 0);
    const max = Math.max(1, ...meses.map((m) => Math.max(m.ganado_usd, m.perdido_usd)));
    const vacio = meses.every((m) => !m.ganado_usd && !m.perdido_usd);
    const ancho = 540, alto = 150, medio = 72, col = ancho / Math.max(meses.length, 1), barra = Math.min(26, col * 0.5);
    const m = foco != null ? meses[foco] : null;
    const totalAnimado = useContar(total);
    return (
        <section className="g-flujo" aria-label="Ganado y perdido por mes">
            <div className="g-flujo-resumen">
                <h2>Flujo de presupuestos</h2>
                <span className="g-flujo-etq">Ganado en el año</span>
                <strong className="g-flujo-num">{usd(Math.round(totalAnimado))}</strong>
                <span className="g-leyenda"><span><i className="gan" />Ganado</span><span><i className="per" />Perdido</span></span>
                <p className="g-flujo-foco" aria-live="polite">
                    {m ? <>{MESES_LARGOS[Number(m.mes.slice(5)) - 1]}: ganado <b>{usd(m.ganado_usd)}</b> · perdido <b>{usd(m.perdido_usd)}</b></> : vacio ? 'Se completa cuando marcás presupuestos como ganados o perdidos en el Cotizador.' : 'Pasá por un mes para ver el detalle.'}
                </p>
            </div>
            <svg viewBox={`0 0 ${ancho} ${alto}`} className="g-flujo-svg" role="img" aria-label={meses.map((x) => `${MESES_LARGOS[Number(x.mes.slice(5)) - 1]}: ganado ${usd(x.ganado_usd)}, perdido ${usd(x.perdido_usd)}`).join('. ')}>
                <line x1={0} y1={medio} x2={ancho} y2={medio} className="g-flujo-eje" />
                {meses.map((x, i) => {
                    const cx = col * i + col / 2;
                    const hg = (x.ganado_usd / max) * (medio - 8), hp = (x.perdido_usd / max) * (medio - 22);
                    return (
                        <g key={x.mes} onMouseEnter={() => setFoco(i)} onMouseLeave={() => setFoco(null)} className={foco === i ? 'foco' : undefined} style={{ '--i': i } as CSSProperties}>
                            <rect x={cx - col / 2} y={0} width={col} height={alto} fill="transparent" />
                            {hg > 0 && <rect x={cx - barra / 2} y={medio - 2 - hg} width={barra} height={hg} rx={5} className="gan" />}
                            {hp > 0 && <rect x={cx - barra / 2} y={medio + 2} width={barra} height={hp} rx={5} className="per" />}
                            <text x={cx} y={alto - 4} textAnchor="middle" className="g-flujo-mes">{MESES[Number(x.mes.slice(5)) - 1]}</text>
                        </g>
                    );
                })}
            </svg>
        </section>
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

function Esqueleto() {
    return (
        <div className="esqueleto g-esqueleto" aria-busy="true" aria-label="Cargando el día">
            <span className="esq esq-mapa" />
            <div className="esq-lado"><span className="esq esq-bloque" /><span className="esq esq-bloque alto" /></div>
        </div>
    );
}

const esCelular = () => typeof window !== 'undefined' && window.matchMedia?.('(max-width: 700px)').matches;

export function Home({ irA }: { irA: (t: IrA) => void }) {
    const [r, setR] = useState<ResumenHoy | null>(null);
    const [mapa, setMapa] = useState<Mapa | null>(null);
    const [errorMapa, setErrorMapa] = useState<string>();
    const [acciones, setAcciones] = useState<AccionPendiente[]>([]);
    const [error, setError] = useState<string>();
    const [cargando, setCargando] = useState(false);
    const [abierta, setAbierta] = useState<string | null>(null);
    const [sel, setSel] = useState<number | null>(null);
    const [seleccion, setSeleccion] = useState<Seleccion>(null);
    const [modo, setModo] = useState<'mapa' | 'lista'>(() => (esCelular() ? 'lista' : 'mapa'));
    const [soloUrgente, setSoloUrgente] = useState(false);
    const [pregunta, setPregunta] = useState('');

    // Envíos aprobados que no salieron: se avisa arriba de Para aprobar.
    const [fallidos, setFallidos] = useState(0);

    const cargar = useCallback(async (forzar = false) => {
        setCargando(true);
        listarEnviosFallidos().then((r) => setFallidos(r.acciones.length)).catch(() => setFallidos(0));
        try {
            const [res, ac, mp] = await Promise.all([
                resumenHoy(forzar),
                listarAcciones('pendiente'),
                mapaNegocio(forzar).then((m) => { setErrorMapa(undefined); return m; }).catch((e: Error) => { setErrorMapa(e.message); return null; }),
            ]);
            setR(res);
            setAcciones(ac.acciones);
            // Un backend viejo o una respuesta rara no rompen el Inicio: el mapa muestra el aviso.
            if (mp && Array.isArray(mp.asistentes) && Array.isArray(mp.meses)) setMapa(mp);
            else if (mp) setErrorMapa('el servidor todavía no tiene el mapa (reiniciá el backend)');
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
    const mostradas = visibles.slice(0, 6);

    // Teclado: J/K moverse en Para aprobar, Enter abrir, A aprobar, R rechazar, E editar; Esc cierra el detalle.
    useEffect(() => {
        const tecla = (e: KeyboardEvent) => {
            if (e.ctrlKey || e.metaKey || e.altKey || escribiendo(e.target)) return;
            if (e.key === 'Escape' && seleccion) { setSeleccion(null); return; }
            if (mostradas.length === 0) return;
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
    }, [mostradas, sel, encolar, irA, seleccion]);
    useEffect(() => {
        if (sel != null && sel >= mostradas.length) setSel(mostradas.length ? mostradas.length - 1 : null);
    }, [sel, mostradas.length]);

    // Si el nodo elegido desaparece al refrescar, se vuelve al plan del día.
    const asistenteSel = seleccion && seleccion.area !== 'notion' ? mapa?.asistentes.find((a) => a.area === seleccion.area) ?? null : null;
    const nodoSel = seleccion?.tipo === 'nodo' ? asistenteSel?.nodos.find((n) => n.id === seleccion.id) ?? null : null;
    useEffect(() => {
        if (seleccion?.tipo === 'nodo' && mapa && !nodoSel) setSeleccion(null);
    }, [seleccion, mapa, nodoSel]);

    // En el celular, al elegir algo se baja al detalle.
    const elegir = useCallback((s: Seleccion) => {
        setSeleccion(s);
        if (s && esCelular()) setTimeout(() => document.querySelector('.g-lado .g-detalle')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
    }, []);

    const fecha = new Date().toLocaleDateString('es-AR', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' });
    const f = r?.foto;
    const p = r?.pulso;
    const l = r?.linea;
    const tareasNotion = (f?.tareas_notion ?? []).filter((t) => t.estado === 'pendiente');
    const hayUrgente = mapa?.asistentes.some((a) => a.nodos.some((n) => n.urgente)) ?? false;
    const aprobacion = p && p.kpis.resueltas_30d ? Math.round((p.kpis.aprobadas_30d / p.kpis.resueltas_30d) * 100) : null;

    const enviarPregunta = () => {
        const t = pregunta.trim();
        if (!t) return;
        preguntarABartez(t);
        setPregunta('');
    };

    return (
        <div className="hoy hoy-g">
            <header className="hoy-cabecera">
                <div>
                    <div className="eyebrow">{fecha}</div>
                    <h1>Inicio</h1>
                    {l && (
                        <p className="hoy-resumen">
                            {l.entra.total === 0 ? 'Todavía no entró ninguna consulta hoy' : <>Entraron <strong>{plural(l.entra.total, 'consulta', 'consultas')}</strong> hoy</>}
                            {visibles.length > 0 && <> · <button className="enlace" onClick={() => document.getElementById('para-aprobar')?.scrollIntoView({ behavior: 'smooth' })}>{visibles.length} {visibles.length === 1 ? 'espera' : 'esperan'} tu OK</button></>}
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
                    <div className="g-arriba">
                        <section className={`g-mapa ${modo === 'lista' ? 'en-lista' : ''}`} aria-label="Mapa del negocio">
                            <div className="g-mapa-cab">
                                <div>
                                    <h2>Mapa del negocio</h2>
                                    <span>{modo === 'mapa' ? 'Tocá un nodo para ver el detalle' : 'Agrupado por asistente'}</span>
                                </div>
                                <div className="g-mapa-herr">
                                    <div className="g-seg" role="group" aria-label="Vista">
                                        <button className="g-b" aria-pressed={modo === 'mapa'} onClick={() => setModo('mapa')}>Mapa</button>
                                        <button className="g-b" aria-pressed={modo === 'lista'} onClick={() => setModo('lista')}>Lista</button>
                                    </div>
                                    <button className="g-urgente" aria-pressed={soloUrgente} onClick={() => setSoloUrgente((v) => !v)} disabled={!hayUrgente && !soloUrgente} title={hayUrgente ? 'Resaltar solo lo urgente' : 'No hay nada urgente'}>
                                        Solo lo urgente
                                    </button>
                                </div>
                            </div>
                            {!mapa ? (
                                errorMapa === SIN_MAPA || errorMapa?.startsWith('el servidor') ? (
                                    <div className="g-mapa-error">
                                        <strong>El servidor todavía no tiene el mapa</strong>
                                        <p>El panel ya está actualizado, pero el backend que está corriendo es anterior. En la PC donde corre:</p>
                                        <code>git pull</code><code>cd backend</code><code>npm install</code><code>npm start</code>
                                        <button className="g-btn-sec" onClick={() => cargar(true)}>Probar de nuevo</button>
                                    </div>
                                ) : (
                                    <p className="g-mapa-error">{errorMapa ? `No se pudo armar el mapa: ${errorMapa}` : 'Armando el mapa…'}</p>
                                )
                            ) : modo === 'mapa' ? (
                                <MapaNegocio mapa={mapa} tareasNotion={tareasNotion.length} seleccion={seleccion} elegir={elegir} soloUrgente={soloUrgente} />
                            ) : (
                                <ListaNegocio mapa={mapa} seleccion={seleccion} elegir={elegir} soloUrgente={soloUrgente} />
                            )}
                            <div className="g-mapa-pie">
                                {modo === 'mapa' && (
                                    <span className="g-mapa-leyenda" aria-label="Referencias">
                                        <span><i className="asist" />Asistentes</span><span><i className="cli" />Clientes</span><span><i className="pres" />Presupuestos</span><span><i className="cons" />Consultas</span>
                                    </span>
                                )}
                                <form className="g-preguntar" onSubmit={(e) => { e.preventDefault(); enviarPregunta(); }}>
                                    <input value={pregunta} onChange={(e) => setPregunta(e.target.value)} placeholder="Preguntale al mapa… ¿quién me debe respuesta?" aria-label="Preguntale a Bartez AI" />
                                    <button className="g-b" type="submit" disabled={!pregunta.trim()}>↑ Enviar</button>
                                </form>
                            </div>
                        </section>

                        <div className="g-lado">
                            {p && <TarjetaMes p={p} cierre={mapa?.cierre_pct ?? null} irA={irA} />}
                            {nodoSel && asistenteSel ? (
                                <DetalleNodo key={nodoSel.id} n={nodoSel} area={asistenteSel} irA={irA} cerrar={() => setSeleccion(null)} />
                            ) : seleccion?.tipo === 'asistente' ? (
                                <DetalleAsistente key={seleccion.area} a={asistenteSel} tareas={tareasNotion} elegir={elegir} irA={irA} cerrar={() => setSeleccion(null)} />
                            ) : (
                                <PanelHoy r={r} irA={irA} />
                            )}
                        </div>
                    </div>

                    <div className="g-abajo">
                        {mapa ? <Flujo meses={mapa.meses} /> : (
                            <section className="g-flujo g-flujo-vacio" aria-label="Ganado y perdido por mes">
                                <p>El flujo de presupuestos aparece junto con el mapa.</p>
                            </section>
                        )}
                        <section className="g-aprobar" id="para-aprobar" aria-label="Para aprobar">
                            <div className="bloque-cabeza">
                                <h2>Para aprobar <span className="g-cuenta">{visibles.length}</span></h2>
                                {visibles.length > mostradas.length && <button className="enlace" onClick={() => irA('acciones')}>Ver las {visibles.length} →</button>}
                            </div>
                            {fallidos > 0 && (
                                <button type="button" className="g-fallidos" onClick={() => irA('acciones')}>
                                    ⚠ {fallidos === 1 ? '1 envío aprobado no salió' : `${fallidos} envíos aprobados no salieron`} · Revisar
                                </button>
                            )}
                            {visibles.length === 0 ? (
                                <p className="mesa-vacio">Nada para aprobar. Tus asistentes están al día.</p>
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
                        </section>
                    </div>

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
                    </footer>
                </>
            )}

            <div className="dock-avisos"><AvisosDeshacer enCola={enCola} deshacer={cola.deshacer} /></div>
        </div>
    );
}
