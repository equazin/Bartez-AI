// Mapa del negocio: Bartez al centro, los asistentes alrededor y de cada uno
// cuelgan los clientes o presupuestos que tiene entre manos.
//
// Animaciones (inspiradas en tableros de grafos como Control AI de Fuselab,
// react-force-graph, la vista de grafo de Obsidian y Neo4j Bloom):
// - Entrada: estallido en el centro, los haces se dibujan hacia afuera, los
//   asistentes aparecen y sus nodos se despliegan desde el asistente.
// - Vida: destellos y partículas que viajan por los haces hacia Bartez (el
//   trabajo que entra), polvo que titila, nodos que flotan apenas.
// - Foco: al pasar el mouse se resalta el camino (nodo → asistente → Bartez)
//   y se apaga el resto.
// - Selección: la cámara viaja al nodo, un anillo de onda lo rodea y un
//   chorro de partículas recorre su camino hasta el centro.
// Con "reducir movimiento" activado queda todo quieto.
//
// Capas de cada nodo, para que las animaciones no se pisen:
//   .mapa-entra (entrada) > .mapa-nodo (foco/atenuado) > .mapa-flota (flotar).

import { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { AreaMapa, AsistenteMapa, Mapa, NodoMapa } from '../../api/client.ts';
import { movimientoReducido, suave } from '../../lib/animar.ts';
import emblema from '../../assets/bartez-emblema.webp';

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
const v = (o: Record<string, string | number>) => o as CSSProperties;

export function metricaAsistente(a: AsistenteMapa): string {
    if (a.area === 'cotizador') return `${a.nodos.length + a.mas} en curso`;
    if (a.aprobacion_pct != null) return `${a.aprobacion_pct}% aprobado`;
    if (a.pendientes) return `${a.pendientes} para aprobar`;
    const n = a.nodos.length + a.mas;
    return n ? `${n} en curso` : 'sin movimiento';
}

// Anillo "de onda" (como una forma de audio) alrededor de lo elegido.
function onda(r: number, amp: number, semilla: number): string {
    const pts: string[] = [];
    for (let i = 0; i < 72; i++) {
        const t = (i / 72) * Math.PI * 2;
        const rr = r + amp * (Math.sin(t * 9 + semilla) * 0.6 + Math.sin(t * 23 + semilla * 2) * 0.4);
        pts.push(`${(Math.cos(t) * rr).toFixed(1)},${(Math.sin(t) * rr).toFixed(1)}`);
    }
    return `M${pts.join('L')}Z`;
}
const ONDA_NODO = [onda(21, 2.4, 1), onda(25, 1.8, 4)];
const ONDA_HUB = [onda(25, 2.6, 2), onda(30, 2, 5)];

// Polvo de fondo: fijo (semilla), para que no salte entre renders.
const POLVO = Array.from({ length: 46 }, (_, i) => {
    const a = Math.sin(i * 12.9898) * 43758.5453, b = Math.sin(i * 78.233) * 12345.6789;
    const fx = a - Math.floor(a), fy = b - Math.floor(b);
    return { x: fx * W, y: fy * H, r: 0.6 + ((i * 7) % 10) / 10, d: 3 + (i % 5), del: -(i % 9) * 0.7 };
});

interface Colocado { n: NodoMapa; area: AreaMapa; x: number; y: number; der: boolean; hx: number; hy: number; orden: number }

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
    const quieto = useMemo(movimientoReducido, []);
    const [vista, setVista] = useState({ k: 1, x: 0, y: 0 });
    const vistaRef = useRef(vista);
    vistaRef.current = vista;
    const viaje = useRef(0);
    const [hover, setHover] = useState<{ area: AreaMapa | 'notion'; id?: string } | null>(null);
    const arrastre = useRef<{ px: number; py: number; x: number; y: number; movio: boolean } | null>(null);
    const svgRef = useRef<SVGSVGElement>(null);

    const hubs = useMemo(() => {
        const lista: Array<{ area: AreaMapa | 'notion'; nombre: string; metrica: string; x: number; y: number; a?: AsistenteMapa; i: number }> = mapa.asistentes.map((a, i) => {
            const l = LUGAR[a.area];
            return { area: a.area, nombre: a.nombre, metrica: metricaAsistente(a), x: C.x + RX * Math.cos(rad(l.ang)), y: C.y + RY * Math.sin(rad(l.ang)), a, i };
        });
        const ln = LUGAR.notion;
        lista.push({ area: 'notion', nombre: 'Notion', metrica: tareasNotion ? `${tareasNotion} ${tareasNotion === 1 ? 'tarea' : 'tareas'}` : 'sin tareas', x: C.x + RX * Math.cos(rad(ln.ang)), y: C.y + RY * 0.72 * Math.sin(rad(ln.ang)), i: lista.length });
        return lista;
    }, [mapa, tareasNotion]);

    const nodos = useMemo(() => {
        const out: Colocado[] = [];
        let orden = 0;
        for (const h of hubs) {
            if (!h.a) continue;
            const k = h.a.nodos.length, paso = 38;
            h.a.nodos.forEach((n, j) => {
                const g = LUGAR[h.a!.area].abanico + (j - (k - 1) / 2) * paso;
                const x = h.x + R_NODO * Math.cos(rad(g)), y = h.y + R_NODO * Math.sin(rad(g));
                out.push({ n, area: h.a!.area, x, y, der: Math.cos(rad(g)) >= -0.25, hx: h.x, hy: h.y, orden: orden++ });
            });
        }
        return out;
    }, [hubs]);

    const selNodo = seleccion?.tipo === 'nodo' ? nodos.find((z) => z.n.id === seleccion.id) ?? null : null;
    const selHub = seleccion?.tipo === 'asistente' ? hubs.find((h) => h.area === seleccion.area) ?? null : null;

    // Cámara: viaja suave hasta lo elegido; al soltar vuelve a la vista general.
    const irA = (destino: { k: number; x: number; y: number }) => {
        cancelAnimationFrame(viaje.current);
        if (quieto) { setVista(destino); return; }
        const origen = vistaRef.current, t0 = performance.now(), ms = 700;
        const paso = (t: number) => {
            const p = suave(Math.min(1, (t - t0) / ms));
            setVista({ k: origen.k + (destino.k - origen.k) * p, x: origen.x + (destino.x - origen.x) * p, y: origen.y + (destino.y - origen.y) * p });
            if (p < 1) viaje.current = requestAnimationFrame(paso);
        };
        viaje.current = requestAnimationFrame(paso);
    };
    const centrar = (px: number, py: number, k: number) => ({ k, x: W / 2 - C.x - (px - C.x) * k, y: H / 2 - C.y - (py - C.y) * k });
    const claveSel = selNodo ? `n:${selNodo.n.id}` : selHub ? `h:${selHub.area}` : '';
    useEffect(() => {
        if (selNodo) irA(centrar(selNodo.x, selNodo.y, 1.3));
        else if (selHub) irA(centrar(selHub.x, selHub.y, 1.15));
        else irA({ k: 1, x: 0, y: 0 });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [claveSel]);
    useEffect(() => () => cancelAnimationFrame(viaje.current), []);

    // Foco: lo que está bajo el mouse; si no hay, lo elegido.
    const foco = hover ?? (selNodo ? { area: selNodo.area, id: selNodo.n.id } : selHub ? { area: selHub.area } : null);
    const activo = (area: AreaMapa | 'notion', id?: string) => {
        if (!foco) return true;
        if (foco.id) return id ? id === foco.id : area === foco.area;
        return area === foco.area;
    };

    const teclaElegir = (s: Seleccion) => (e: ReactKeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); elegir(s); }
    };

    // Arrastrar el fondo mueve el mapa; un clic sin moverse deselecciona.
    const bajar = (e: ReactPointerEvent<SVGRectElement>) => {
        cancelAnimationFrame(viaje.current);
        arrastre.current = { px: e.clientX, py: e.clientY, x: vista.x, y: vista.y, movio: false };
        (e.target as Element).setPointerCapture?.(e.pointerId);
    };
    const mover = (e: ReactPointerEvent<SVGRectElement>) => {
        const d = arrastre.current;
        if (!d || !svgRef.current) return;
        const escala = W / svgRef.current.getBoundingClientRect().width;
        const dx = (e.clientX - d.px) * escala, dy = (e.clientY - d.py) * escala;
        if (Math.abs(dx) + Math.abs(dy) > 3) d.movio = true;
        setVista((w) => ({ ...w, x: d.x + dx, y: d.y + dy }));
    };
    const soltar = () => {
        if (arrastre.current && !arrastre.current.movio) elegir(null);
        arrastre.current = null;
    };
    const zoom = (f: number) => {
        cancelAnimationFrame(viaje.current);
        setVista((w) => ({ ...w, k: Math.min(2.2, Math.max(0.7, +(w.k * f).toFixed(2))) }));
    };

    const cierre = mapa.cierre_pct;
    const tenue = (n: NodoMapa) => soloUrgente && !n.urgente;
    const actividad = (h: (typeof hubs)[number]) => (h.a ? Math.min(3, h.a.nodos.length + h.a.pendientes) : tareasNotion ? 1 : 0);

    return (
        <div className="mapa-lienzo">
            <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} className={`mapa-svg ${foco ? 'con-foco' : ''}`} role="group" aria-label="Mapa del negocio">
                <defs>
                    <radialGradient id={`${uid}rosa`} cx="38%" cy="32%"><stop offset="0" stopColor="#ffe0ee" /><stop offset="0.5" stopColor="#e35b97" /><stop offset="1" stopColor="#6b1a42" /></radialGradient>
                    <radialGradient id={`${uid}vio`} cx="38%" cy="30%"><stop offset="0" stopColor="#f1e8ff" /><stop offset="0.5" stopColor="#9f7cf0" /><stop offset="1" stopColor="#3b2378" /></radialGradient>
                    <radialGradient id={`${uid}ver`} cx="38%" cy="30%"><stop offset="0" stopColor="#d8fff0" /><stop offset="0.5" stopColor="#3fbf8c" /><stop offset="1" stopColor="#0f4a33" /></radialGradient>
                    <radialGradient id={`${uid}oro`} cx="40%" cy="35%"><stop offset="0" stopColor="#fff4d6" /><stop offset="0.5" stopColor="#d9b77a" /><stop offset="1" stopColor="#6d5228" /></radialGradient>
                    <radialGradient id={`${uid}halo`}><stop offset="0" stopColor="#5cc8ff" stopOpacity="0.55" /><stop offset="1" stopColor="#5cc8ff" stopOpacity="0" /></radialGradient>
                    <radialGradient id={`${uid}halorosa`}><stop offset="0" stopColor="#f38bb8" stopOpacity="0.32" /><stop offset="1" stopColor="#f38bb8" stopOpacity="0" /></radialGradient>
                    <filter id={`${uid}brillo`} x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="2.2" result="b" /><feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
                    {hubs.map((h, i) => (
                        <linearGradient key={i} id={`${uid}haz${i}`} gradientUnits="userSpaceOnUse" x1={C.x} y1={C.y} x2={h.x} y2={h.y}>
                            <stop offset="0" stopColor="#d6efff" stopOpacity="0.95" /><stop offset="0.6" stopColor="#37b1ff" stopOpacity="0.45" /><stop offset="1" stopColor="#f0a3c7" stopOpacity="0.8" />
                        </linearGradient>
                    ))}
                </defs>

                {/* Polvo de fondo, con un poco de paralaje al mover la cámara */}
                <g className="mapa-polvo" transform={`translate(${vista.x * 0.25},${vista.y * 0.25})`} aria-hidden="true">
                    {POLVO.map((p, i) => <circle key={i} cx={p.x} cy={p.y} r={p.r} style={v({ '--d': `${p.d}s`, '--del': `${p.del}s` })} />)}
                </g>

                <rect className="mapa-fondo" width={W} height={H} fill="transparent" onPointerDown={bajar} onPointerMove={mover} onPointerUp={soltar} onPointerCancel={() => { arrastre.current = null; }} />

                <g transform={`translate(${vista.x + C.x * (1 - vista.k)},${vista.y + C.y * (1 - vista.k)}) scale(${vista.k})`}>
                    {/* Estallido de entrada */}
                    <circle cx={C.x} cy={C.y} r={250} className="mapa-estallido" aria-hidden="true" />

                    {/* Haces del centro a cada asistente, con destellos y partículas que entran */}
                    {hubs.map((h, i) => {
                        const dx = h.x - C.x, dy = h.y - C.y, L = Math.hypot(dx, dy), nx = (-dy / L) * 7, ny = (dx / L) * 7;
                        const n = actividad(h), dur = 3.4 - n * 0.4;
                        return (
                            <g key={h.area} className={`mapa-haz ${activo(h.area) ? 'foco' : ''}`} style={v({ '--i': i })}>
                                <polygon className="mapa-haz-luz" points={`${C.x + nx},${C.y + ny} ${C.x - nx},${C.y - ny} ${h.x},${h.y}`} fill={`url(#${uid}haz${i})`} />
                                <path className="mapa-haz-linea" d={`M${C.x} ${C.y}L${h.x} ${h.y}`} pathLength={100} stroke={`url(#${uid}haz${i})`} />
                                {!quieto && <path className="mapa-destello" d={`M${h.x} ${h.y}L${C.x} ${C.y}`} pathLength={100} filter={`url(#${uid}brillo)`} style={v({ '--del': `${-i * 0.9}s` })} />}
                                {!quieto && Array.from({ length: n }, (_, j) => (
                                    <circle key={j} r={2.1} className="mapa-particula">
                                        <animateMotion dur={`${dur}s`} begin={`${-(j * dur) / n}s`} repeatCount="indefinite" path={`M${h.x},${h.y}L${C.x},${C.y}`} />
                                    </circle>
                                ))}
                            </g>
                        );
                    })}

                    {/* Hilos de cada asistente a sus nodos */}
                    {nodos.map(({ n, area, x, y, hx, hy }) => (
                        <line key={`l${n.id}`} x1={hx} y1={hy} x2={x} y2={y} className={`mapa-hilo ${tenue(n) ? 'mapa-apagado' : ''} ${activo(area, n.id) ? 'foco' : ''}`} />
                    ))}

                    {/* Camino del nodo elegido: partículas del cliente hasta Bartez */}
                    {selNodo && !quieto && Array.from({ length: 3 }, (_, j) => (
                        <circle key={`${selNodo.n.id}${j}`} r={2.6} className="mapa-particula viva" filter={`url(#${uid}brillo)`}>
                            <animateMotion dur="2.2s" begin={`${-j * 0.73}s`} repeatCount="indefinite" path={`M${selNodo.x},${selNodo.y}L${selNodo.hx},${selNodo.hy}L${C.x},${C.y}`} />
                        </circle>
                    ))}

                    {/* Nodos: clientes, presupuestos y conversaciones */}
                    {nodos.map(({ n, area, x, y, der, hx, hy, orden }) => {
                        const sel = selNodo?.n.id === n.id;
                        const s: Seleccion = { tipo: 'nodo', area, id: n.id };
                        const bx = x + (der ? -9 : 9);
                        const hubSel = selHub?.area === area;
                        return (
                            <g key={n.id} className="mapa-entra" style={v({ '--dx': `${hx - x}px`, '--dy': `${hy - y}px`, '--d': `${480 + orden * 35}ms` })}>
                                <g
                                    className={`mapa-nodo ${sel ? 'sel' : ''} ${n.urgente ? 'urgente' : ''} ${tenue(n) ? 'mapa-apagado' : ''} ${activo(area, n.id) ? 'foco' : ''} ${hubSel ? 'latido' : ''}`}
                                    style={v({ '--lat': `${(orden % 4) * 70}ms` })}
                                    role="button" tabIndex={0} aria-pressed={sel} aria-label={`${n.nombre}: ${n.subtitulo}`}
                                    onClick={() => elegir(sel ? null : s)} onKeyDown={teclaElegir(sel ? null : s)}
                                    onMouseEnter={() => setHover({ area, id: n.id })} onMouseLeave={() => setHover(null)}
                                    onFocus={() => setHover({ area, id: n.id })} onBlur={() => setHover(null)}
                                >
                                    <title>{`${n.nombre} — ${n.subtitulo}`}</title>
                                    <g className="mapa-flota" style={v({ '--fd': `${5 + (orden % 4)}s`, '--fdel': `${-orden * 0.7}s`, '--fx': `${orden % 2 ? 1.6 : -1.6}px`, '--fy': `${orden % 3 ? -2 : 2}px` })}>
                                        <circle cx={x} cy={y} r={24} className="mapa-blanco" />
                                        <rect x={der ? x + 14 : x - 14 - corto(n.nombre).length * 6.6} y={y - 10} width={corto(n.nombre).length * 6.6 + 6} height={20} className="mapa-blanco" />
                                        {n.urgente && <circle cx={x} cy={y} r={17} className="mapa-pulso" />}
                                        {sel && (
                                            <g transform={`translate(${x},${y})`} aria-hidden="true">
                                                <circle r={20} className="mapa-onda-expande" />
                                                <path d={ONDA_NODO[0]} className="mapa-onda" />
                                                <path d={ONDA_NODO[1]} className="mapa-onda contra" />
                                            </g>
                                        )}
                                        <circle cx={x} cy={y} r={14} className="mapa-orbita" />
                                        <circle cx={x} cy={y} r={10.5} className="mapa-orbe" fill={`url(#${uid}${n.tipo === 'presupuesto' ? 'oro' : n.tipo === 'conversacion' ? 'ver' : 'vio'})`} />
                                        <text x={x + (der ? (sel ? 32 : 19) : -19)} y={y + 4} textAnchor={der ? 'start' : 'end'} className="mapa-nombre">{corto(n.nombre)}</text>
                                        {n.consultas > 0 && (
                                            <g>
                                                <line x1={x} y1={y} x2={bx} y2={y - 28} className="mapa-hilo" />
                                                <circle cx={bx} cy={y - 28} r={5.5} fill={`url(#${uid}ver)`} />
                                                <g transform={`translate(${bx + 5},${y - 42})`} className="mapa-num"><rect width={17} height={12} rx={3} /><text x={8.5} y={9}>{n.consultas}</text></g>
                                            </g>
                                        )}
                                        {n.tipo !== 'presupuesto' && n.presupuestos > 0 && (
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
                                </g>
                            </g>
                        );
                    })}

                    {/* Asistentes */}
                    {hubs.map((h) => {
                        const sel = selHub?.area === h.area;
                        const s: Seleccion = { tipo: 'asistente', area: h.area };
                        const vacio = h.a ? h.a.nodos.length === 0 : false;
                        const izq = h.x > C.x + 60;
                        const anchoEtq = Math.max(h.nombre.length * 8.5, h.metrica.length * 6.4 + 12);
                        return (
                            <g key={h.area} className="mapa-entra-hub" style={v({ '--d': `${300 + h.i * 60}ms` })}>
                                <g
                                    className={`mapa-hub ${sel ? 'sel' : ''} ${vacio ? 'vacio' : ''} ${activo(h.area) ? 'foco' : ''}`}
                                    role="button" tabIndex={0} aria-pressed={sel} aria-label={`Asistente ${h.nombre}: ${h.metrica}`}
                                    onClick={() => elegir(sel ? null : s)} onKeyDown={teclaElegir(sel ? null : s)}
                                    onMouseEnter={() => setHover({ area: h.area })} onMouseLeave={() => setHover(null)}
                                    onFocus={() => setHover({ area: h.area })} onBlur={() => setHover(null)}
                                >
                                    <circle cx={h.x} cy={h.y} r={34} className="mapa-hub-halo" fill={`url(#${uid}halorosa)`} />
                                    {/* Zona de clic que cubre también el nombre y la etiqueta */}
                                    <rect x={izq ? h.x - 22 - anchoEtq : h.x} y={h.y - 20} width={anchoEtq + 22} height={42} className="mapa-blanco" />
                                    {sel && (
                                        <g transform={`translate(${h.x},${h.y})`} aria-hidden="true">
                                            <circle r={22} className="mapa-onda-expande" />
                                            <path d={ONDA_HUB[0]} className="mapa-onda" />
                                            <path d={ONDA_HUB[1]} className="mapa-onda contra" />
                                        </g>
                                    )}
                                    <circle cx={h.x} cy={h.y} r={18} className="mapa-hub-anillo" />
                                    <circle cx={h.x} cy={h.y} r={13.5} className="mapa-orbe" fill={`url(#${uid}rosa)`} />
                                    <text x={izq ? h.x - 22 : h.x + 22} y={h.y - 3} textAnchor={izq ? 'end' : 'start'} className="mapa-hub-nombre">{h.nombre}</text>
                                    <Etiqueta x={izq ? h.x - 22 - (h.metrica.length * 6.4 + 12) : h.x + 22} y={h.y + 4} texto={h.metrica} />
                                    {h.a && h.a.mas > 0 && <text x={izq ? h.x - 22 : h.x + 22} y={h.y + 34} textAnchor={izq ? 'end' : 'start'} className="mapa-mas">+{h.a.mas} más</text>}
                                </g>
                            </g>
                        );
                    })}

                    {/* Bartez al centro: el emblema con su halo */}
                    <g className="mapa-centro">
                        <circle cx={C.x} cy={C.y} r={72} className="mapa-halo" fill={`url(#${uid}halo)`} />
                        <g className="mapa-rayos">
                            {Array.from({ length: 60 }, (_, a) => {
                                const t = (a / 60) * Math.PI * 2, r2 = 30 + (a % 3) * 2.5;
                                return <line key={a} x1={C.x + Math.cos(t) * 27} y1={C.y + Math.sin(t) * 27} x2={C.x + Math.cos(t) * r2} y2={C.y + Math.sin(t) * r2} className="mapa-rayo" />;
                            })}
                        </g>
                        <circle cx={C.x} cy={C.y} r={25} className="mapa-anillo-centro" />
                        <image href={emblema} x={C.x - 22} y={C.y - 22} width={44} height={44} className="mapa-emblema" />
                        <text x={C.x + 36} y={C.y + 1} className="mapa-centro-nombre">Bartez</text>
                        <Etiqueta x={C.x + 36} y={C.y + 8} texto={cierre != null ? `${cierre}% cierre` : 'sin cierres aún'} />
                    </g>
                </g>
            </svg>
            <div className="mapa-zoom" role="group" aria-label="Zoom">
                <button className="g-b" onClick={() => zoom(1.2)} aria-label="Acercar">+</button>
                <button className="g-b" onClick={() => zoom(1 / 1.2)} aria-label="Alejar">−</button>
                {(vista.k !== 1 || vista.x !== 0 || vista.y !== 0) && <button className="g-b" onClick={() => { elegir(null); irA({ k: 1, x: 0, y: 0 }); }} aria-label="Volver a la vista general" title="Volver a la vista general">⟲</button>}
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
    let orden = 0;
    return (
        <div className="mapa-lista">
            {grupos.map(({ a, nodos }, gi) => (
                <section key={a.area} className="mapa-lista-grupo" style={v({ '--d': `${gi * 70}ms` })}>
                    <button className="mapa-lista-cab" onClick={() => elegir({ tipo: 'asistente', area: a.area })}>
                        <span className="mapa-lista-punto" aria-hidden="true" />
                        <strong>{a.nombre}</strong>
                        <span>{metricaAsistente(a)}</span>
                    </button>
                    <ul>
                        {nodos.map((n) => {
                            const sel = seleccion?.tipo === 'nodo' && seleccion.id === n.id;
                            return (
                                <li key={n.id} style={v({ '--d': `${120 + orden++ * 40}ms` })}>
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
