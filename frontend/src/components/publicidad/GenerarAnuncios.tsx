// "Generar anuncios": le pedís algo con tus palabras y el asistente arma
// anuncios con lo que dice la web. Los que elegís van a Para aprobar y se crean
// pausados en Google Ads.

import { useEffect, useRef, useState } from 'react';
import { GeneracionAnuncios, PaginaWeb, generarAnunciosAds, proponerAnunciosAds } from '../../api/client.ts';
import { AnuncioGoogle } from './AnuncioGoogle.tsx';

const limpiarTitulo = (t: string | null) => (t ?? '').replace(/\s*[|—-]\s*Bartez Tecnolog[ií]a\s*$/i, '').trim();

export function GenerarAnuncios({ paginas, inicial, cerrar, listo }: {
    paginas: PaginaWeb[];
    inicial?: { url?: string | null; pedido?: string };
    cerrar: () => void;
    listo: (creadas: number) => void;
}) {
    const [pedido, setPedido] = useState(inicial?.pedido ?? '');
    const [url, setUrl] = useState<string>(inicial?.url ?? '');
    const [variantes, setVariantes] = useState(3);
    const [g, setG] = useState<GeneracionAnuncios | null>(null);
    const [elegidas, setElegidas] = useState<Set<number>>(new Set());
    const [cambio, setCambio] = useState('');
    const [ocupado, setOcupado] = useState<'' | 'generar' | 'proponer'>('');
    const [error, setError] = useState<string>();
    const dialogo = useRef<HTMLDivElement>(null);
    const campo = useRef<HTMLTextAreaElement>(null);

    const anunciables = paginas.filter((p) => p.anunciable && p.en_sitemap).sort((a, b) => a.ruta.localeCompare(b.ruta));
    // Ideas: páginas que se anuncian y todavía no tienen gasto.
    const ideas = anunciables.filter((p) => !p.metricas).slice(0, 3);

    useEffect(() => {
        campo.current?.focus();
        const esc = (e: KeyboardEvent) => { if (e.key === 'Escape' && !ocupado) cerrar(); };
        window.addEventListener('keydown', esc);
        return () => window.removeEventListener('keydown', esc);
    }, [cerrar, ocupado]);

    async function generar(conCambio = false) {
        if (pedido.trim().length < 3) { setError('Contá qué querés anunciar.'); return; }
        setOcupado('generar'); setError(undefined);
        try {
            const { generacion } = await generarAnunciosAds({
                pedido, url: url || (conCambio && g ? g.url : null), variantes,
                cambio: conCambio ? cambio : null, anteriores: conCambio && g ? g.variantes : null,
            });
            setG(generacion);
            if (!url) setUrl(generacion.url);
            setElegidas(new Set(generacion.variantes.map((v, i) => (v.problemas.length ? -1 : i)).filter((i) => i >= 0)));
            if (conCambio) setCambio('');
        } catch (e) { setError((e as Error).message); }
        finally { setOcupado(''); }
    }

    async function proponer() {
        if (!g || !elegidas.size) return;
        setOcupado('proponer'); setError(undefined);
        try {
            const { creadas } = await proponerAnunciosAds({ url: g.url, ruta: g.ruta, pedido, variantes: g.variantes.filter((_, i) => elegidas.has(i)) });
            listo(creadas);
        } catch (e) { setError((e as Error).message); }
        finally { setOcupado(''); }
    }

    const alternar = (i: number) => setElegidas((s) => { const n = new Set(s); if (n.has(i)) n.delete(i); else n.add(i); return n; });

    return (
        <div className="pub-modal-fondo" onMouseDown={(e) => { if (e.target === e.currentTarget && !ocupado) cerrar(); }}>
            <div className="pub-modal gen" role="dialog" aria-modal="true" aria-labelledby="gen-titulo" ref={dialogo}>
                <div className="gen-pedido">
                    <div className="gen-cab">
                        <h2 id="gen-titulo">Generar anuncios</h2>
                        <button className="pub-cerrar" onClick={cerrar} aria-label="Cerrar" disabled={!!ocupado}>✕</button>
                    </div>
                    <label htmlFor="gen-texto">¿Qué querés anunciar?</label>
                    <textarea id="gen-texto" ref={campo} rows={4} value={pedido} onChange={(e) => setPedido(e.target.value)}
                        placeholder="Ej.: notebooks Lenovo para estudios contables, que se note la factura A y la entrega en todo el país. Tono serio."
                        onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) generar(); }} />
                    {ideas.length > 0 && (
                        <div className="gen-ideas">
                            <span>Páginas que todavía no se anuncian</span>
                            {ideas.map((p) => (
                                <button key={p.url} className="chip" onClick={() => { setUrl(p.url); setPedido(`Anuncios para ${limpiarTitulo(p.titulo) || p.ruta}`); }}>{limpiarTitulo(p.titulo) || p.ruta}</button>
                            ))}
                        </div>
                    )}
                    <div className="gen-opciones">
                        <label htmlFor="gen-destino">Página de destino
                            <select id="gen-destino" value={url} onChange={(e) => setUrl(e.target.value)}>
                                <option value="">La elige el asistente</option>
                                {anunciables.map((p) => <option key={p.url} value={p.url}>{limpiarTitulo(p.titulo) || p.ruta}</option>)}
                            </select>
                        </label>
                        <label htmlFor="gen-cuantos">Variantes
                            <select id="gen-cuantos" value={variantes} onChange={(e) => setVariantes(Number(e.target.value))}>
                                {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n} {n === 1 ? 'anuncio' : 'anuncios'}</option>)}
                            </select>
                        </label>
                    </div>
                    <p className="gen-regla">Solo usa lo que dice la web. Si pedís algo que la página no dice, te avisa y no lo pone como promesa.</p>
                    <button className="pub-primario gen-boton" onClick={() => generar()} disabled={!!ocupado}>
                        {ocupado === 'generar' ? 'Escribiendo anuncios…' : g ? 'Generar de nuevo' : `Generar ${variantes} ${variantes === 1 ? 'anuncio' : 'anuncios'}`}
                    </button>
                </div>

                <div className="gen-resultado">
                    {error && <p className="error" role="alert">{error}</p>}
                    {!g && !error && (
                        <div className="gen-vacio">
                            <p>Los anuncios aparecen acá, tal como se verían en Google.</p>
                            <p>Cada línea dice de qué parte de la web salió.</p>
                        </div>
                    )}
                    {g && (
                        <>
                            <div className="gen-res-cab">
                                <h3>Propuestas</h3>
                                <span>Llevan a <code>{g.ruta}</code> · textos de esa página</span>
                            </div>
                            {g.avisos.map((a) => <p key={a} className="gen-aviso">{a}</p>)}
                            <div className="gen-grilla">
                                {g.variantes.map((v, i) => {
                                    const conProblemas = v.problemas.length > 0;
                                    return (
                                        <article key={i} className={`gen-var ${elegidas.has(i) ? 'on' : ''} ${conProblemas ? 'mal' : ''}`}>
                                            <AnuncioGoogle modo="tarjeta" titulos={v.titulos} descripciones={v.descripciones} url={g.url} ruta1={v.ruta1} ruta2={v.ruta2} />
                                            {conProblemas ? (
                                                <ul className="gen-problemas">{v.problemas.slice(0, 3).map((x) => <li key={x}>{x}</li>)}</ul>
                                            ) : (
                                                <details className="gen-fuentes">
                                                    <summary>{v.titulos.length} títulos · {v.descripciones.length} descripciones · de dónde sale</summary>
                                                    <ul>
                                                        {v.fuentes.slice(0, 8).map((f, j) => <li key={j}><strong>{f.texto}</strong> ← “{f.fuente}”</li>)}
                                                    </ul>
                                                    {v.palabras_clave.length > 0 && <p>Búsquedas: {v.palabras_clave.join(' · ')}</p>}
                                                </details>
                                            )}
                                            <label className="gen-incluir">
                                                <input type="checkbox" checked={elegidas.has(i)} disabled={conProblemas} onChange={() => alternar(i)} />
                                                {conProblemas ? 'No se puede proponer' : 'Incluir'}
                                            </label>
                                        </article>
                                    );
                                })}
                            </div>
                            <div className="gen-acciones">
                                <label htmlFor="gen-cambio" className="solo-lector">Pedir un cambio</label>
                                <input id="gen-cambio" value={cambio} onChange={(e) => setCambio(e.target.value)} placeholder="Pedile un cambio: “más corto”, “sin marcas”, “que diga renting”…"
                                    onKeyDown={(e) => { if (e.key === 'Enter' && cambio.trim()) generar(true); }} />
                                <button className="boton-fantasma" onClick={() => generar(true)} disabled={!!ocupado || !cambio.trim()}>Rehacer</button>
                                <button className="pub-primario" onClick={proponer} disabled={!!ocupado || !elegidas.size}>
                                    {ocupado === 'proponer' ? 'Mandando…' : `Mandar ${elegidas.size || ''} a Para aprobar`}
                                </button>
                            </div>
                            <p className="gen-nota">Se crean pausados en Google Ads y salen recién con tu ok.</p>
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}
