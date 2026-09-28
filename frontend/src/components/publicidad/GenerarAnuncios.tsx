// "Generar anuncios": le pedís algo con tus palabras y el asistente arma
// anuncios con lo que dice la web. Los que elegís van a Para aprobar y se crean
// pausados en Google Ads.

import { useEffect, useRef, useState } from 'react';
import { GeneracionAnuncios, InfoCampania, PaginaWeb, ZonaAds, generarAnunciosAds, infoCampaniaAds, proponerAnunciosAds, proponerCampaniaAds } from '../../api/client.ts';
import { AnuncioGoogle } from './AnuncioGoogle.tsx';

const limpiarTitulo = (t: string | null) => (t ?? '').replace(/\s*[|—-]\s*Bartez Tecnolog[ií]a\s*$/i, '').trim();

export function GenerarAnuncios({ paginas, inicial, cerrar, listo }: {
    paginas: PaginaWeb[];
    inicial?: { url?: string | null; pedido?: string };
    cerrar: () => void;
    listo: (creadas: number, campania?: boolean) => void;
}) {
    const [pedido, setPedido] = useState(inicial?.pedido ?? '');
    const [url, setUrl] = useState<string>(inicial?.url ?? '');
    const [variantes, setVariantes] = useState(3);
    const [g, setG] = useState<GeneracionAnuncios | null>(null);
    const [elegidas, setElegidas] = useState<Set<number>>(new Set());
    const [cambio, setCambio] = useState('');
    const [ocupado, setOcupado] = useState<'' | 'generar' | 'proponer'>('');
    // Campaña nueva (cuando la página todavía no tiene grupo de anuncios en Google).
    const [info, setInfo] = useState<InfoCampania | null>(null);
    const [diario, setDiario] = useState('');
    const [zona, setZona] = useState<ZonaAds>({ tipo: 'radio', km: 80 });
    const [palabras, setPalabras] = useState<string[]>([]);
    const [nuevaPalabra, setNuevaPalabra] = useState('');
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
            setPalabras([...new Set(generacion.variantes.filter((v) => !v.problemas.length).flatMap((v) => v.palabras_clave.map((k) => k.toLowerCase())))].slice(0, 15));
            if (!info || g?.url !== generacion.url) {
                infoCampaniaAds(generacion.url).then(({ info: i }) => {
                    setInfo(i); setZona(i.zona);
                    setDiario(i.sugerido_diario != null ? String(i.sugerido_diario) : '');
                }).catch(() => setInfo(null));
            }
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

    const nuevaCampania = !!info && info.conectado && !info.grupo_existente;
    const moneda = info?.moneda === 'USD' ? 'US$' : '$';
    const cifra = (n: number) => `${moneda} ${Math.round(n).toLocaleString('es-AR')}`;
    const diarioNum = Number(diario.replace(/\./g, '').replace(',', '.'));
    const pasaTope = !!info && info.disponible_diario != null && diarioNum > info.disponible_diario + 0.01;

    async function proponerCampania() {
        if (!g || !elegidas.size) return;
        if (!(diarioNum > 0)) { setError('Poné cuánto se puede gastar por día.'); return; }
        if (palabras.length < 3) { setError('Hacen falta al menos 3 búsquedas.'); return; }
        setOcupado('proponer'); setError(undefined);
        try {
            await proponerCampaniaAds({ url: g.url, ruta: g.ruta, pedido, variantes: g.variantes.filter((_, i) => elegidas.has(i)), palabras_clave: palabras, presupuesto_diario: diarioNum, zona });
            listo(elegidas.size, true);
        } catch (e) { setError((e as Error).message); }
        finally { setOcupado(''); }
    }

    function agregarPalabra() {
        const k = nuevaPalabra.trim().toLowerCase();
        if (k.length >= 3 && !palabras.includes(k)) setPalabras([...palabras, k].slice(0, 20));
        setNuevaPalabra('');
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
                                {!nuevaCampania && (
                                    <button className="pub-primario" onClick={proponer} disabled={!!ocupado || !elegidas.size}>
                                        {ocupado === 'proponer' ? 'Mandando…' : `Mandar ${elegidas.size || ''} a Para aprobar`}
                                    </button>
                                )}
                            </div>
                            {nuevaCampania && info && (
                                <section className="gen-campania" aria-labelledby="gen-camp-titulo">
                                    <div className="gen-campania-cab">
                                        <h3 id="gen-camp-titulo">Campaña nueva para <code>{g.ruta}</code></h3>
                                        <p>Esta página todavía no tiene anuncios en Google Ads. Se arma una campaña con los anuncios elegidos y queda <strong>pausada</strong> hasta que la prendas.</p>
                                    </div>
                                    {info.propuesta_pendiente ? (
                                        <p className="gen-aviso">Ya hay una campaña para esta página esperando tu ok en Para aprobar.</p>
                                    ) : info.tope == null ? (
                                        <p className="gen-aviso">Para proponer campañas primero cargá el tope mensual en Publicidad → Ajustes: con eso se controla el presupuesto.</p>
                                    ) : (
                                        <>
                                            <div className="gen-campania-campos">
                                                <label htmlFor="gen-diario">Presupuesto por día ({moneda})
                                                    <input id="gen-diario" inputMode="numeric" value={diario} onChange={(e) => setDiario(e.target.value)} aria-describedby="gen-diario-ayuda" />
                                                    <small id="gen-diario-ayuda" className={pasaTope ? 'mal' : ''}>
                                                        {diarioNum > 0 ? `Hasta ${cifra(diarioNum * 30.4)} por mes. ` : ''}
                                                        {info.disponible_diario != null ? `Queda lugar para ${cifra(info.disponible_diario)} por día dentro del tope de ${cifra(info.tope)}.` : ''}
                                                    </small>
                                                </label>
                                                <label htmlFor="gen-zona">Dónde se muestra
                                                    <select id="gen-zona" value={zona.tipo === 'pais' ? 'pais' : String(zona.km)} onChange={(e) => setZona(e.target.value === 'pais' ? { tipo: 'pais' } : { tipo: 'radio', km: Number(e.target.value) })}>
                                                        {[30, 50, 80, 150, 300].map((km) => <option key={km} value={km}>Rosario y {km} km alrededor</option>)}
                                                        {zona.tipo === 'radio' && ![30, 50, 80, 150, 300].includes(zona.km) && <option value={zona.km}>Rosario y {zona.km} km alrededor</option>}
                                                        <option value="pais">Todo el país</option>
                                                    </select>
                                                </label>
                                            </div>
                                            <div className="gen-palabras">
                                                <span id="gen-palabras-etq">Búsquedas que la activan</span>
                                                <ul aria-labelledby="gen-palabras-etq">
                                                    {palabras.map((k) => (
                                                        <li key={k}>{k}<button onClick={() => setPalabras(palabras.filter((x) => x !== k))} aria-label={`Sacar ${k}`}>✕</button></li>
                                                    ))}
                                                </ul>
                                                <div className="gen-palabras-sumar">
                                                    <label htmlFor="gen-palabra" className="solo-lector">Sumar una búsqueda</label>
                                                    <input id="gen-palabra" value={nuevaPalabra} onChange={(e) => setNuevaPalabra(e.target.value)} placeholder="Sumar una búsqueda…"
                                                        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); agregarPalabra(); } }} />
                                                    <button className="boton-fantasma" onClick={agregarPalabra} disabled={nuevaPalabra.trim().length < 3}>Sumar</button>
                                                </div>
                                                <small>Solo en la búsqueda de Google, en castellano. No sale si la búsqueda dice “gratis”, “empleo”, “curso”, “usado” y similares.</small>
                                            </div>
                                            <button className="pub-primario" onClick={proponerCampania} disabled={!!ocupado || !elegidas.size || pasaTope || palabras.length < 3 || !(diarioNum > 0)}>
                                                {ocupado === 'proponer' ? 'Mandando…' : `Proponer campaña con ${elegidas.size} ${elegidas.size === 1 ? 'anuncio' : 'anuncios'}`}
                                            </button>
                                        </>
                                    )}
                                </section>
                            )}
                            {info && info.conectado && info.grupo_existente && <p className="gen-nota">Van al grupo “{info.grupo_existente}”, que ya lleva a esta página. Se crean pausados y salen recién con tu ok.</p>}
                            {(!info || !info.conectado) && <p className="gen-nota">Se crean pausados en Google Ads y salen recién con tu ok.</p>}
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}
