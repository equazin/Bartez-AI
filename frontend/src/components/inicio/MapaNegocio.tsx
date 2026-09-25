// Mapa del negocio: Bartez al centro, los asistentes alrededor y de cada uno
// cuelgan los clientes o presupuestos que tiene entre manos. Se puede tocar un
// nodo (o un asistente) para ver su detalle, acercar/alejar, arrastrar y
// quedarse solo con lo urgente. En celular se usa la vista Lista.

import { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, useId, useMemo, useRef, useState } from 'react';
import type { AreaMapa, AsistenteMapa, Mapa, NodoMapa } from '../../api/client.ts';

export type Seleccion = { tipo: 'nodo'; area: AreaMapa; id: string } | { tipo: 'asistente'; area: AreaMapa | 'notion' } | null;

const W = 860, H = 600, C = { x: 430, y: 290 }, RX = 245, RY = 180, R_NODO = 70;

// Dónde va cada asistente (grados, 0 = derecha) y hacia dónde abre sus nodos.
const LUGAR: Record<AreaMapa | 'notion', { ang: number; abanico: number }> = {
    prospeccion: { ang: -150, abanico: -160 },
    cotizador: { ang: -90, abanico: -90 },
    seguimientos: { ang: -30, abanico: -20 },
    correo: { ang: 30, abanico: 30 },
    notion: { ang: 90, abanico: 90 },
    whatsapp: { ang: 150, abanico: 160 },
};

const rad = (g: number) => (g * Math.PI) / 180;
const corto = (s: string, n = 16) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

export function metricaAsistente(a: AsistenteMapa): string {
    if (a.area === 'cotizador') return `${a.nodos.length + a.mas} en curso`;
    if (a.aprobacion_pct != null) return `${a.aprobacion_pct}% aprobado`;
    if (a.pendientes) return `${a.pendientes} para aprobar`;
    const n = a.nodos.length + a.mas;
    return n ? `${n} en curso` : 'sin movimiento';
}

interface Colocado { n: NodoMapa; area: AreaMapa; x: number; y: number; der: boolean }

function Etiqueta({ x, y, texto }: { x: number; y: number; texto: string }) {
    const ancho = texto.length * 6.4 + 12;
    return (
        <g className="mapa-etq" transform={`translate(${x},${y})`}>
            <rect width={ancho} height={16} rx={2} transform="skewX(-12)" />
            <text x={6} y={11.5}>{texto}</text>
        </g>
    );
}

export function MapaNegocio({ mapa, tareasNotion, seleccion, elegir, soloUrgente }: {
    mapa: Mapa;
    tareasNotion: number;
    seleccion: Seleccion;
    elegir: (s: Seleccion) => void;
    soloUrgente: boolean;
}) {
    const uid = useId().replace(/:/g, '');
    const [vista, setVista] = useState({ k: 1, x: 0, y: 0 });
    const arrastre = useRef<{ px: number; py: number; x: number; y: number; movio: boolean } | null>(null);
    const svgRef = useRef<SVGSVGElement>(null);

    const hubs = useMemo(() => {
        const lista: Array<{ area: AreaMapa | 'notion'; nombre: string; metrica: string; x: number; y: number; a?: AsistenteMapa }> = mapa.asistentes.map((a) => {
            const l = LUGAR[a.area];
            return { area: a.area, nombre: a.nombre, metrica: metricaAsistente(a), x: C.x + RX * Math.cos(rad(l.ang)), y: C.y + RY * Math.sin(rad(l.ang)), a };
        });
        const ln = LUGAR.notion;
        lista.push({ area: 'notion', nombre: 'Notion', metrica: tareasNotion ? `${tareasNotion} ${tareasNotion === 1 ? 'tarea' : 'tareas'}` : 'sin tareas', x: C.x + RX * Math.cos(rad(ln.ang)), y: C.y + RY * 0.72 * Math.sin(rad(ln.ang)) });
        return lista;
    }, [mapa, tareasNotion]);

    const nodos = useMemo(() => {
        const out: Colocado[] = [];
        for (const h of hubs) {
            if (!h.a) continue;
            const k = h.a.nodos.length, paso = 38;
            h.a.nodos.forEach((n, j) => {
                const g = LUGAR[h.a!.area].abanico + (j - (k - 1) / 2) * paso;
                const x = h.x + R_NODO * Math.cos(rad(g)), y = h.y + R_NODO * Math.sin(rad(g));
                out.push({ n, area: h.a!.area, x, y, der: Math.cos(rad(g)) >= -0.25 });
            });
        }
        return out;
    }, [hubs]);

    const selNodo = seleccion?.tipo === 'nodo' ? seleccion.id : null;
    const selHub = seleccion?.tipo === 'asistente' ? seleccion.area : null;

    const teclaElegir = (s: Seleccion) => (e: ReactKeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); elegir(s); }
    };

    // Arrastrar el fondo mueve el mapa; un clic sin moverse deselecciona.
    const bajar = (e: ReactPointerEvent<SVGRectElement>) => {
        arrastre.current = { px: e.clientX, py: e.clientY, x: vista.x, y: vista.y, movio: false };
        (e.target as Element).setPointerCapture?.(e.pointerId);
    };
    const mover = (e: ReactPointerEvent<SVGRectElement>) => {
        const d = arrastre.current;
        if (!d || !svgRef.current) return;
        const escala = W / svgRef.current.getBoundingClientRect().width;
        const dx = (e.clientX - d.px) * escala, dy = (e.clientY - d.py) * escala;
        if (Math.abs(dx) + Math.abs(dy) > 3) d.movio = true;
        setVista((v) => ({ ...v, x: d.x + dx, y: d.y + dy }));
    };
    const soltar = () => {
        if (arrastre.current && !arrastre.current.movio) elegir(null);
        arrastre.current = null;
    };
    const zoom = (f: number) => setVista((v) => ({ ...v, k: Math.min(2.2, Math.max(0.7, +(v.k * f).toFixed(2))) }));

    const cierre = mapa.cierre_pct;
    const tenue = (n: NodoMapa) => soloUrgente && !n.urgente;

    return (
        <div className="mapa-lienzo">
            <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} className="mapa-svg" role="group" aria-label="Mapa del negocio">
                <defs>
                    <radialGradient id={`${uid}sol`} cx="40%" cy="35%"><stop offset="0" stopColor="#fbffe8" /><stop offset="0.45" stopColor="#c9ec5c" /><stop offset="1" stopColor="#3f6b12" /></radialGradient>
                    <radialGradient id={`${uid}rosa`} cx="38%" cy="32%"><stop offset="0" stopColor="#ffe0ee" /><stop offset="0.5" stopColor="#e35b97" /><stop offset="1" stopColor="#6b1a42" /></radialGradient>
                    <radialGradient id={`${uid}vio`} cx="38%" cy="30%"><stop offset="0" stopColor="#f1e8ff" /><stop offset="0.5" stopColor="#9f7cf0" /><stop offset="1" stopColor="#3b2378" /></radialGradient>
                    <radialGradient id={`${uid}ver`} cx="38%" cy="30%"><stop offset="0" stopColor="#d8fff0" /><stop offset="0.5" stopColor="#3fbf8c" /><stop offset="1" stopColor="#0f4a33" /></radialGradient>
                    <radialGradient id={`${uid}oro`} cx="40%" cy="35%"><stop offset="0" stopColor="#fff4d6" /><stop offset="0.5" stopColor="#d9b77a" /><stop offset="1" stopColor="#6d5228" /></radialGradient>
                    <radialGradient id={`${uid}halo`}><stop offset="0" stopColor="#d7f77e" stopOpacity="0.5" /><stop offset="1" stopColor="#d7f77e" stopOpacity="0" /></radialGradient>
                    <radialGradient id={`${uid}halorosa`}><stop offset="0" stopColor="#f38bb8" stopOpacity="0.32" /><stop offset="1" stopColor="#f38bb8" stopOpacity="0" /></radialGradient>
                    {hubs.map((h, i) => (
                        <linearGradient key={i} id={`${uid}haz${i}`} gradientUnits="userSpaceOnUse" x1={C.x} y1={C.y} x2={h.x} y2={h.y}>
                            <stop offset="0" stopColor="#e2f7a0" stopOpacity="0.95" /><stop offset="0.6" stopColor="#b8e24a" stopOpacity="0.4" /><stop offset="1" stopColor="#f0a3c7" stopOpacity="0.8" />
                        </linearGradient>
                    ))}
                </defs>
                <rect className="mapa-fondo" width={W} height={H} fill="transparent" onPointerDown={bajar} onPointerMove={mover} onPointerUp={soltar} onPointerCancel={() => { arrastre.current = null; }} />
                <g transform={`translate(${vista.x + C.x * (1 - vista.k)},${vista.y + C.y * (1 - vista.k)}) scale(${vista.k})`}>
                    {/* Haces del centro a cada asistente */}
                    {hubs.map((h, i) => {
                        const dx = h.x - C.x, dy = h.y - C.y, L = Math.hypot(dx, dy), nx = (-dy / L) * 7, ny = (dx / L) * 7;
                        return (
                            <g key={h.area} className={selHub && selHub !== h.area ? 'mapa-apagado' : undefined}>
                                <polygon points={`${C.x + nx},${C.y + ny} ${C.x - nx},${C.y - ny} ${h.x},${h.y}`} fill={`url(#${uid}haz${i})`} opacity={0.5} />
                                <line x1={C.x} y1={C.y} x2={h.x} y2={h.y} stroke={`url(#${uid}haz${i})`} strokeWidth={1.4} />
                            </g>
                        );
                    })}
                    {/* Hilos de cada asistente a sus nodos */}
                    {nodos.map(({ n, area, x, y }) => {
                        const h = hubs.find((z) => z.area === area)!;
                        return <line key={`l${n.id}`} x1={h.x} y1={h.y} x2={x} y2={y} className={`mapa-hilo ${tenue(n) ? 'mapa-apagado' : ''}`} />;
                    })}

                    {/* Nodos: clientes, presupuestos y conversaciones */}
                    {nodos.map(({ n, area, x, y, der }) => {
                        const sel = selNodo === n.id;
                        const s: Seleccion = { tipo: 'nodo', area, id: n.id };
                        const bx = x + (der ? -9 : 9);
                        return (
                            <g
                                key={n.id} className={`mapa-nodo ${sel ? 'sel' : ''} ${n.urgente ? 'urgente' : ''} ${tenue(n) ? 'mapa-apagado' : ''}`}
                                role="button" tabIndex={0} aria-pressed={sel} aria-label={`${n.nombre}: ${n.subtitulo}`}
                                onClick={() => elegir(sel ? null : s)} onKeyDown={teclaElegir(sel ? null : s)}
                            >
                                <title>{`${n.nombre} — ${n.subtitulo}`}</title>
                                <circle cx={x} cy={y} r={24} className="mapa-blanco" />
                                <rect x={der ? x + 14 : x - 14 - corto(n.nombre).length * 6.6} y={y - 10} width={corto(n.nombre).length * 6.6 + 6} height={20} className="mapa-blanco" />
                                {n.urgente && <circle cx={x} cy={y} r={17} className="mapa-pulso" />}
                                {sel && <><circle cx={x} cy={y} r={20} className="mapa-sel" /><circle cx={x} cy={y} r={27} className="mapa-sel suave" /></>}
                                <circle cx={x} cy={y} r={14} className="mapa-orbita" />
                                <circle cx={x} cy={y} r={10.5} fill={`url(#${uid}${n.tipo === 'presupuesto' ? 'oro' : 'vio'})`} />
                                <text x={x + (der ? (sel ? 32 : 19) : -19)} y={y + 4} textAnchor={der ? 'start' : 'end'} className="mapa-nombre">{corto(n.nombre)}</text>
                                {n.consultas > 0 && (
                                    <g>
                                        <line x1={x} y1={y} x2={bx} y2={y - 28} className="mapa-hilo" />
                                        <circle cx={bx} cy={y - 28} r={5.5} fill={`url(#${uid}ver)`} />
                                        <g transform={`translate(${bx + 5},${y - 42})`} className="mapa-num"><rect width={17} height={12} rx={3} /><text x={8.5} y={9}>{n.consultas}</text></g>
                                    </g>
                                )}
                                {n.en_juego_usd != null && n.tipo !== 'presupuesto' && n.presupuestos > 0 && (
                                    <g>
                                        <line x1={x} y1={y} x2={bx} y2={y + 28} className="mapa-hilo" />
                                        <circle cx={bx} cy={y + 28} r={4} fill={`url(#${uid}oro)`} />
                                        <g transform={`translate(${bx + 5},${y + 18})`} className="mapa-num"><rect width={17} height={12} rx={3} /><text x={8.5} y={9}>{n.presupuestos}</text></g>
                                    </g>
                                )}
                                {n.dias_sin_respuesta != null && n.dias_sin_respuesta > 0 && (
                                    <g transform={`translate(${bx + (der ? -4 : -12)},${y + 17})`} className="mapa-num dias"><rect width={24} height={12} rx={3} /><text x={12} y={9}>{n.dias_sin_respuesta}d</text></g>
                                )}
                            </g>
                        );
                    })}

                    {/* Asistentes */}
                    {hubs.map((h) => {
                        const sel = selHub === h.area;
                        const s: Seleccion = { tipo: 'asistente', area: h.area };
                        const vacio = h.a ? h.a.nodos.length === 0 : false;
                        const izq = h.x > C.x + 60;
                        return (
                            <g
                                key={h.area} className={`mapa-hub ${sel ? 'sel' : ''} ${vacio ? 'vacio' : ''}`}
                                role="button" tabIndex={0} aria-pressed={sel} aria-label={`Asistente ${h.nombre}: ${h.metrica}`}
                                onClick={() => elegir(sel ? null : s)} onKeyDown={teclaElegir(sel ? null : s)}
                            >
                                <circle cx={h.x} cy={h.y} r={34} fill={`url(#${uid}halorosa)`} />
                                {sel && <circle cx={h.x} cy={h.y} r={22} className="mapa-sel" />}
                                <circle cx={h.x} cy={h.y} r={18} className="mapa-hub-anillo" />
                                <circle cx={h.x} cy={h.y} r={13.5} fill={`url(#${uid}rosa)`} />
                                <text x={izq ? h.x - 22 : h.x + 22} y={h.y - 3} textAnchor={izq ? 'end' : 'start'} className="mapa-hub-nombre">{h.nombre}</text>
                                <Etiqueta x={izq ? h.x - 22 - (h.metrica.length * 6.4 + 12) : h.x + 22} y={h.y + 4} texto={h.metrica} />
                                {h.a && h.a.mas > 0 && <text x={izq ? h.x - 22 : h.x + 22} y={h.y + 34} textAnchor={izq ? 'end' : 'start'} className="mapa-mas">+{h.a.mas} más</text>}
                            </g>
                        );
                    })}

                    {/* Bartez al centro */}
                    <g className="mapa-centro">
                        <circle cx={C.x} cy={C.y} r={70} fill={`url(#${uid}halo)`} />
                        {Array.from({ length: 60 }, (_, a) => {
                            const t = (a / 60) * Math.PI * 2, r2 = 26 + (a % 3) * 2.5;
                            return <line key={a} x1={C.x + Math.cos(t) * 23} y1={C.y + Math.sin(t) * 23} x2={C.x + Math.cos(t) * r2} y2={C.y + Math.sin(t) * r2} className="mapa-rayo" />;
                        })}
                        <circle cx={C.x} cy={C.y} r={20} fill={`url(#${uid}sol)`} />
                        <text x={C.x + 34} y={C.y + 1} className="mapa-centro-nombre">Bartez</text>
                        <Etiqueta x={C.x + 34} y={C.y + 8} texto={cierre != null ? `${cierre}% cierre` : 'sin cierres aún'} />
                    </g>
                </g>
            </svg>
            <div className="mapa-zoom" role="group" aria-label="Zoom">
                <button onClick={() => zoom(1.2)} aria-label="Acercar">+</button>
                <button onClick={() => zoom(1 / 1.2)} aria-label="Alejar">−</button>
                {(vista.k !== 1 || vista.x !== 0 || vista.y !== 0) && <button onClick={() => setVista({ k: 1, x: 0, y: 0 })} aria-label="Volver a centrar" title="Volver a centrar">⟲</button>}
            </div>
        </div>
    );
}

// Vista Lista: lo mismo que el mapa, agrupado por asistente. Es la vista por
// defecto en el celular y la alternativa accesible al mapa.
export function ListaNegocio({ mapa, seleccion, elegir, soloUrgente }: {
    mapa: Mapa; seleccion: Seleccion; elegir: (s: Seleccion) => void; soloUrgente: boolean;
}) {
    const grupos = mapa.asistentes
        .map((a) => ({ a, nodos: soloUrgente ? a.nodos.filter((n) => n.urgente) : a.nodos }))
        .filter((g) => g.nodos.length > 0);
    if (grupos.length === 0) return <p className="mapa-lista-vacia">{soloUrgente ? 'Nada urgente por ahora.' : 'Todavía no hay movimiento para mostrar.'}</p>;
    return (
        <div className="mapa-lista">
            {grupos.map(({ a, nodos }) => (
                <section key={a.area} className="mapa-lista-grupo">
                    <button className="mapa-lista-cab" onClick={() => elegir({ tipo: 'asistente', area: a.area })}>
                        <span className="mapa-lista-punto" aria-hidden="true" />
                        <strong>{a.nombre}</strong>
                        <span>{metricaAsistente(a)}</span>
                    </button>
                    <ul>
                        {nodos.map((n) => {
                            const sel = seleccion?.tipo === 'nodo' && seleccion.id === n.id;
                            return (
                                <li key={n.id}>
                                    <button className={`mapa-lista-fila ${sel ? 'sel' : ''}`} aria-pressed={sel} onClick={() => elegir(sel ? null : { tipo: 'nodo', area: a.area, id: n.id })}>
                                        <span className={`mapa-lista-orbe ${n.tipo}`} aria-hidden="true" />
                                        <span className="mapa-lista-texto"><strong>{n.nombre}</strong><span>{n.subtitulo}</span></span>
                                        {n.urgente && <span className="mapa-lista-urgente">Urgente</span>}
                                    </button>
                                </li>
                            );
                        })}
                    </ul>
                    {a.mas > 0 && <p className="mapa-lista-mas">+{a.mas} más</p>}
                </section>
            ))}
        </div>
    );
}
