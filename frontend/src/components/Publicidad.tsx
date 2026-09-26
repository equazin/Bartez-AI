// Publicidad: la "Cabina" del asistente de Google Ads. Todo anuncio sale de
// bartez.com.ar. Resumen en tres columnas (páginas · gasto · para revisar), los
// anuncios con su preview, generar anuncios a pedido, búsquedas, páginas de la
// web, historial y ajustes. Los cambios en Google pasan siempre por Para aprobar.

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
    AnuncioAds, BusquedaAds, PaginaWeb, ResumenPublicidad,
    busquedasPublicidad, desconectarGoogleAds, guardarConfigPublicidad, listarAnunciosAds, marcarAnunciable, paginasPublicidad,
    releerWeb, resumenPublicidad, sincronizarPublicidad, urlConectarGoogleAds,
} from '../api/client.ts';
import { AnuncioGoogle } from './publicidad/AnuncioGoogle.tsx';
import { DetalleAnuncio, ESTADO_ANUNCIO } from './publicidad/DetalleAnuncio.tsx';
import { GenerarAnuncios } from './publicidad/GenerarAnuncios.tsx';

type Vista = 'resumen' | 'anuncios' | 'busquedas' | 'paginas' | 'historial' | 'ajustes';
type FiltroPag = 'anunciables' | 'todas' | 'cambios' | 'error';
type FiltroAd = 'todos' | 'activos' | 'aprobar' | 'problemas';

const VISTAS: Array<[Vista, string]> = [['resumen', 'Resumen'], ['anuncios', 'Anuncios'], ['busquedas', 'Búsquedas'], ['paginas', 'Páginas'], ['historial', 'Historial'], ['ajustes', 'Ajustes']];

const TIPO: Record<string, string> = {
    portada: 'Portada', solucion: 'Solución', servicio: 'Servicio', vertical: 'Rubro', canal: 'Revendedores', producto: 'Producto',
    conversion: 'Cotizar / contacto', caso: 'Caso', recurso: 'Guía', descarga: 'Descarga', posventa: 'Posventa', legal: 'Legal', institucional: 'Institucional', otra: 'Otra',
};

function fechaHora(s: string | null) {
    if (!s) return '—';
    return new Date(s).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}
const reciente = (s: string | null, dias = 7) => !!s && Date.now() - new Date(s).getTime() < dias * 86_400_000;
const limpiarTitulo = (t: string | null) => (t ?? '').replace(/\s*[|—-]\s*Bartez Tecnolog[ií]a\s*$/i, '').trim();

function leerVista(): Vista {
    try { const v = localStorage.getItem('bartez_pub_vista') as Vista | null; return v && VISTAS.some(([id]) => id === v) ? v : 'resumen'; } catch { return 'resumen'; }
}

// Lo que dejó Google en la dirección al volver de "Conectar".
function avisoDeVuelta(): { ok: boolean; texto: string } | null {
    const h = window.location.hash;
    if (h === '#ads-conectado') return { ok: true, texto: 'Google Ads quedó conectado. Estoy bajando los datos de la cuenta: en un minuto aparecen.' };
    if (h === '#ads-error') return { ok: false, texto: 'No se pudo conectar Google Ads. Probá de nuevo; si sigue fallando, revisá que la dirección de retorno esté cargada en Google Cloud.' };
    if (h === '#ads-cancelado') return { ok: false, texto: 'Se canceló la conexión con Google.' };
    return null;
}

// Medio círculo con el uso del tope mensual.
function Medidor({ pct }: { pct: number }) {
    const p = Math.max(0, Math.min(pct, 100)) / 100;
    const ang = Math.PI - p * Math.PI;
    const x = 140 + 110 * Math.cos(ang), y = 140 - 110 * Math.sin(ang);
    return (
        <svg className="cab-medidor" viewBox="0 0 280 160" role="img" aria-label={`Uso del tope mensual: ${Math.round(pct)} por ciento`}>
            <path d="M30 140 A110 110 0 0 1 250 140" className="cab-medidor-fondo" />
            {p > 0 && <path d={`M30 140 A110 110 0 0 1 ${x.toFixed(1)} ${y.toFixed(1)}`} className={`cab-medidor-valor ${pct >= 90 ? 'alto' : ''}`} />}
            <text x="140" y="116" textAnchor="middle" className="cab-medidor-num">{Math.round(pct)}%</text>
            <text x="140" y="140" textAnchor="middle" className="cab-medidor-etq">del tope mensual</text>
        </svg>
    );
}

// Barras del gasto de cada día del mes (celestes: días con conversiones).
function BarrasDiarias({ diario, diasMes, desde }: { diario: Array<{ fecha: string; gasto: number; conversiones: number }>; diasMes: number; desde: string }) {
    const porDia = new Map(diario.map((d) => [Number(d.fecha.slice(8)), d]));
    const max = Math.max(1, ...diario.map((d) => d.gasto));
    const ancho = 700 / diasMes;
    return (
        <svg className="cab-barras" viewBox="0 0 700 150" preserveAspectRatio="none" role="img" aria-label={`Gasto por día desde ${desde}`}>
            <line x1="0" y1="140" x2="700" y2="140" className="cab-barras-eje" />
            {Array.from({ length: diasMes }, (_, i) => {
                const d = porDia.get(i + 1);
                const h = d ? Math.max(3, (d.gasto / max) * 128) : 0;
                return d ? <rect key={i} x={i * ancho + ancho * 0.18} y={140 - h} width={ancho * 0.64} height={h} rx="3" className={d.conversiones > 0 ? 'con' : ''}><title>{`Día ${i + 1}: $${d.gasto.toLocaleString('es-AR')}${d.conversiones ? ` · ${d.conversiones} conv.` : ''}`}</title></rect> : null;
            })}
        </svg>
    );
}

export function Publicidad() {
    const [r, setR] = useState<ResumenPublicidad | null>(null);
    const [paginas, setPaginas] = useState<PaginaWeb[]>([]);
    const [fuera, setFuera] = useState<Array<{ url: string; metricas: { clics: number; costo: number } }>>([]);
    const [busquedas, setBusquedas] = useState<BusquedaAds[]>([]);
    const [anuncios, setAnuncios] = useState<AnuncioAds[] | null>(null);
    const [errorAnuncios, setErrorAnuncios] = useState<string>();
    const [vista, setVistaState] = useState<Vista>(leerVista);
    const [filtro, setFiltro] = useState<FiltroPag>('anunciables');
    const [filtroAd, setFiltroAd] = useState<FiltroAd>('todos');
    const [abierta, setAbierta] = useState<string | null>(null);
    const [detalle, setDetalle] = useState<AnuncioAds | null>(null);
    const [generar, setGenerar] = useState<{ url?: string | null; pedido?: string } | null>(null);
    const [error, setError] = useState<string>();
    const [aviso, setAviso] = useState<{ ok: boolean; texto: string } | null>(() => avisoDeVuelta());
    const [ocupado, setOcupado] = useState<'' | 'web' | 'sync' | 'conectar' | 'guardar'>('');
    const [confirmarDesconexion, setConfirmarDesconexion] = useState(false);
    const [tope, setTope] = useState('');
    const [zona, setZona] = useState('');

    const setVista = (v: Vista) => { setVistaState(v); try { localStorage.setItem('bartez_pub_vista', v); } catch { /* sin storage */ } };

    const cargarAnuncios = useCallback(async (refrescar = false) => {
        try { setErrorAnuncios(undefined); setAnuncios((await listarAnunciosAds(refrescar)).anuncios); }
        catch (e) { setErrorAnuncios((e as Error).message); setAnuncios([]); }
    }, []);

    const cargar = useCallback(async () => {
        try {
            setError(undefined);
            const [res, pags, bus] = await Promise.all([resumenPublicidad(), paginasPublicidad(30), busquedasPublicidad(30)]);
            setR(res);
            setPaginas(pags.paginas);
            setFuera(pags.destinos_fuera_de_la_web);
            setBusquedas(bus.busquedas);
            setTope(res.config.tope_mensual_ars != null ? String(res.config.tope_mensual_ars) : '');
            setZona(res.config.zona ?? '');
        } catch (e) { setError((e as Error).message); }
        cargarAnuncios();
    }, [cargarAnuncios]);

    useEffect(() => {
        cargar();
        if (window.location.hash.startsWith('#ads-')) history.replaceState(null, '', window.location.pathname + window.location.search);
        if (aviso?.ok) { const t = setTimeout(cargar, 20_000); return () => clearTimeout(t); }
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    const moneda = r?.cuenta?.moneda ?? 'ARS';
    const plata = useCallback((n: number | null | undefined) => (n == null ? '—' : `${moneda === 'USD' ? 'USD ' : '$'}${Math.round(n).toLocaleString('es-AR')}`), [moneda]);
    const enDolares = (n: number) => (moneda === 'ARS' && r?.tipo_cambio && n ? `≈ USD ${Math.round(n / r.tipo_cambio).toLocaleString('es-AR')}` : null);
    const con = r?.conexion;

    const visibles = useMemo(() => paginas.filter((p) => {
        if (filtro === 'anunciables') return p.anunciable && p.en_sitemap;
        if (filtro === 'cambios') return reciente(p.cambio_en);
        if (filtro === 'error') return p.estado_http !== 200 || !p.en_sitemap;
        return true;
    }), [paginas, filtro]);
    const cuenta = {
        anunciables: paginas.filter((p) => p.anunciable && p.en_sitemap).length,
        todas: paginas.length,
        cambios: paginas.filter((p) => reciente(p.cambio_en)).length,
        error: paginas.filter((p) => p.estado_http !== 200 || !p.en_sitemap).length,
    };
    // Columna izquierda del resumen: las páginas que más gastan; sin gasto, las que se anuncian.
    const paginasResumen = useMemo(() => {
        const an = paginas.filter((p) => p.anunciable && p.en_sitemap);
        return [...an].sort((a, b) => (b.estado_http !== 200 ? 1 : 0) - (a.estado_http !== 200 ? 1 : 0) || (b.metricas?.costo ?? 0) - (a.metricas?.costo ?? 0) || a.ruta.localeCompare(b.ruta)).slice(0, 7);
    }, [paginas]);

    const adsVisibles = (anuncios ?? []).filter((a) => filtroAd === 'todos' || (filtroAd === 'activos' && a.estado === 'activo') || (filtroAd === 'aprobar' && a.estado === 'pendiente_ok') || (filtroAd === 'problemas' && !!a.problema));
    const cuentaAd = {
        todos: anuncios?.length ?? 0,
        activos: (anuncios ?? []).filter((a) => a.estado === 'activo').length,
        aprobar: (anuncios ?? []).filter((a) => a.estado === 'pendiente_ok').length,
        problemas: (anuncios ?? []).filter((a) => a.problema).length,
    };

    async function conectar() {
        setOcupado('conectar');
        try { window.location.href = (await urlConectarGoogleAds()).url; }
        catch (e) { setError((e as Error).message); setOcupado(''); }
    }
    async function desconectar() {
        setConfirmarDesconexion(false);
        try { await desconectarGoogleAds(); await cargar(); } catch (e) { setError((e as Error).message); }
    }
    async function leerWebAhora() {
        setOcupado('web'); setAviso(null);
        try {
            const { resultado: x } = await releerWeb();
            const partes = [`${x.paginas} páginas leídas`];
            if (x.nuevas.length) partes.push(`${x.nuevas.length} nuevas`);
            if (x.cambiadas.length) partes.push(`${x.cambiadas.length} con cambios`);
            if (x.con_error.length) partes.push(`${x.con_error.length} con error`);
            if (x.quitadas.length) partes.push(`${x.quitadas.length} ya no están en la web`);
            setAviso({ ok: x.con_error.length === 0, texto: `${partes.join(' · ')}.` });
            await cargar();
        } catch (e) { setError((e as Error).message); }
        finally { setOcupado(''); }
    }
    async function sincronizar() {
        setOcupado('sync');
        try {
            const { resultado: x } = await sincronizarPublicidad(30);
            setAviso({ ok: true, texto: `Datos de Google Ads al día (${x.campanias} campañas, ${x.busquedas} búsquedas).` });
            await cargar();
            await cargarAnuncios(true);
        } catch (e) { setError((e as Error).message); }
        finally { setOcupado(''); }
    }
    async function cambiarAnunciable(p: PaginaWeb) {
        const nuevo = !p.anunciable;
        setPaginas((xs) => xs.map((x) => (x.url === p.url ? { ...x, anunciable: nuevo } : x)));
        try { await marcarAnunciable(p.url, nuevo); }
        catch (e) { setPaginas((xs) => xs.map((x) => (x.url === p.url ? { ...x, anunciable: !nuevo } : x))); setError((e as Error).message); }
    }
    async function guardarAjustes(ev: React.FormEvent) {
        ev.preventDefault();
        const n = tope.trim() === '' ? null : Number(tope.replace(/\./g, '').replace(',', '.'));
        if (n != null && (!Number.isFinite(n) || n < 0)) { setError('El tope tiene que ser un número en pesos, por ejemplo 300000.'); return; }
        setOcupado('guardar');
        try { await guardarConfigPublicidad({ tope_mensual_ars: n, zona: zona.trim() || null }); setAviso({ ok: true, texto: 'Ajustes guardados.' }); await cargar(); }
        catch (e) { setError((e as Error).message); }
        finally { setOcupado(''); }
    }

    const titulosDe = (a: AnuncioAds) => a.titulos.map((t) => t.texto);
    const descDe = (a: AnuncioAds) => a.descripciones.map((t) => t.texto);

    return (
        <section className="publicidad cabina">
            <header className="cab-cab">
                <div className="cab-titulo">
                    <h2>Publicidad</h2>
                    <p className="sub">
                        {con?.conectado
                            ? <>Google Ads{r?.cuenta?.nombre ? ` · ${r.cuenta.nombre}` : ''} · datos al {fechaHora(r?.sincronizado_en ?? null)} · {moneda}</>
                            : 'Google Ads armado desde bartez.com.ar'}
                    </p>
                </div>
                <nav className="segmentos cab-vistas" aria-label="Secciones de Publicidad">
                    {VISTAS.map(([id, etq]) => (
                        <button key={id} className={vista === id ? 'on' : ''} aria-current={vista === id ? 'page' : undefined} onClick={() => setVista(id)}>
                            {etq}{id === 'anuncios' && cuentaAd.aprobar ? <span className="cab-num">{cuentaAd.aprobar}</span> : null}
                        </button>
                    ))}
                </nav>
                <div className="pub-botones">
                    {con?.conectado && <button className="boton-fantasma" onClick={sincronizar} disabled={!!ocupado}>{ocupado === 'sync' ? 'Actualizando…' : 'Actualizar'}</button>}
                    <button className="pub-primario cab-generar" onClick={() => setGenerar({})}>✦ Generar anuncios</button>
                </div>
            </header>

            {error && <p className="error" role="alert">Error: {error}</p>}
            {aviso && <p className={`pub-aviso ${aviso.ok ? 'ok' : 'mal'}`} role="status">{aviso.texto}</p>}

            {r && !con?.conectado && (
                <div className="pub-conexion">
                    {!con?.configurado ? (
                        <div><strong>Google Ads todavía no está configurado</strong><p>Falta cargar en Railway: {con?.faltan.map((f) => <code key={f}>{f}</code>)}. Mientras tanto ya podés generar anuncios con lo que dice la web.</p></div>
                    ) : (
                        <>
                            <div><strong>Falta conectar la cuenta de Google Ads</strong><p>Entrás con tu cuenta de Google y el permiso queda guardado en el servidor.</p></div>
                            <button className="pub-primario" onClick={conectar} disabled={ocupado === 'conectar'}>{ocupado === 'conectar' ? 'Abriendo Google…' : 'Conectar Google Ads'}</button>
                        </>
                    )}
                </div>
            )}

            {vista === 'resumen' && r && (
                <div className="cab-grilla">
                    <section className="cab-col cab-paginas">
                        <div className="cab-col-cab"><h3>Páginas que se anuncian</h3><span className="cab-mono">{cuenta.anunciables}</span></div>
                        <ul>
                            {paginasResumen.map((p) => (
                                <li key={p.url}>
                                    <button onClick={() => { setVista('paginas'); setFiltro('anunciables'); setAbierta(p.url); }}>
                                        <span className={`cab-punto ${p.estado_http !== 200 ? 'mal' : ''}`} aria-hidden="true" />
                                        <span className="cab-pag-txt"><strong>{limpiarTitulo(p.titulo) || p.ruta}</strong><span className={p.estado_http !== 200 ? 'mal' : ''}>{p.estado_http !== 200 ? `da error ${p.estado_http || ''}` : p.ruta}</span></span>
                                        <span className="cab-pag-num">{p.metricas ? <><strong>{plata(p.metricas.costo)}</strong><span>{Math.round(p.metricas.conversiones)} conv.</span></> : <span>sin gasto</span>}</span>
                                    </button>
                                </li>
                            ))}
                        </ul>
                        <button className="enlace cab-ver" onClick={() => setVista('paginas')}>Ver las {cuenta.anunciables} páginas →</button>
                    </section>

                    <section className="cab-centro">
                        <div className="cab-col cab-gasto">
                            {r.mes.tope ? <Medidor pct={r.mes.uso_tope ?? 0} /> : <div className="cab-sin-tope"><span>Sin tope mensual</span><button className="enlace" onClick={() => setVista('ajustes')}>Ponerlo en Ajustes</button></div>}
                            <div className="cab-gasto-txt">
                                <span className="cab-etq">Gasto de este mes</span>
                                <span className="cab-grande">{plata(r.mes.gasto)}</span>
                                <span className="cab-det">
                                    {r.mes.tope ? `de ${plata(r.mes.tope)}` : 'sin tope cargado'}
                                    {r.mes.proyeccion ? ` · al ritmo actual cierra en ${plata(r.mes.proyeccion)}` : ''}
                                    {enDolares(r.mes.gasto) ? ` · ${enDolares(r.mes.gasto)}` : ''}
                                </span>
                                <span className="cab-chips">
                                    {r.mes.tope && <span className={`pub-estado ${(r.mes.uso_tope ?? 0) >= 90 ? 'mal' : 'ok'}`}>{(r.mes.uso_tope ?? 0) >= 100 ? 'Tope superado' : (r.mes.uso_tope ?? 0) >= 90 ? 'Cerca del tope' : 'Dentro del tope'}</span>}
                                    <span className="pub-estado">Presupuesto diario {plata(r.mes.presupuesto_diario_activo)}</span>
                                </span>
                            </div>
                        </div>
                        <div className="cab-col">
                            <div className="cab-col-cab"><h3>Gasto por día</h3><span className="cab-leyenda"><i /> días con conversiones</span></div>
                            {r.diario?.length
                                ? <BarrasDiarias diario={r.diario} diasMes={r.dias_mes ?? 30} desde={r.mes.desde} />
                                : <p className="cab-vacio">{con?.conectado ? 'Este mes todavía no hubo gasto en Google Ads.' : 'Aparece cuando Google Ads esté conectado.'}</p>}
                        </div>
                        <div className="cab-kpis">
                            <div className="cab-col"><span className="cab-etq">Clics</span><span className="cab-medio">{r.mes.clics.toLocaleString('es-AR')}</span><span className="cab-det">{r.mes.cpc != null ? `${plata(r.mes.cpc)} cada uno` : '—'}</span></div>
                            <div className="cab-col"><span className="cab-etq">Conversiones</span><span className="cab-medio">{r.mes.conversiones.toLocaleString('es-AR')}</span><span className="cab-det">las que registra Google</span></div>
                            <div className="cab-col"><span className="cab-etq">Costo por conversión</span><span className="cab-medio">{plata(r.mes.costo_por_conversion)}</span><span className="cab-det">{r.mes.costo_por_conversion && enDolares(r.mes.costo_por_conversion) ? enDolares(r.mes.costo_por_conversion) : '—'}</span></div>
                        </div>
                    </section>

                    <aside className="cab-derecha">
                        <section className="cab-col">
                            <h3>Para revisar</h3>
                            {r.alertas.slice(0, 3).map((a) => (
                                <div key={a.clave} className={`cab-alerta ${a.nivel === 'urgente' ? 'cab-urgente' : ''}`}>
                                    {a.nivel === 'urgente' && <span className="cab-alerta-nivel">Urgente</span>}
                                    <span>{a.texto}</span>
                                </div>
                            ))}
                            {cuentaAd.aprobar > 0 && (
                                <div className="cab-alerta">
                                    <span>{cuentaAd.aprobar} {cuentaAd.aprobar === 1 ? 'anuncio nuevo espera' : 'anuncios nuevos esperan'} tu ok en Para aprobar.</span>
                                    <button className="enlace" onClick={() => { setVista('anuncios'); setFiltroAd('aprobar'); }}>Verlos</button>
                                </div>
                            )}
                            {cuentaAd.problemas > 0 && (
                                <div className="cab-alerta">
                                    <span>{cuentaAd.problemas} {cuentaAd.problemas === 1 ? 'anuncio tiene' : 'anuncios tienen'} un problema.</span>
                                    <button className="enlace" onClick={() => { setVista('anuncios'); setFiltroAd('problemas'); }}>Revisar</button>
                                </div>
                            )}
                            {!r.alertas.length && !cuentaAd.aprobar && !cuentaAd.problemas && <p className="cab-vacio">Nada para revisar.</p>}
                        </section>
                        <section className="cab-col cab-busquedas">
                            <h3>Lo que buscaron</h3>
                            {busquedas.length ? (
                                <ul>
                                    {busquedas.slice(0, 6).map((b) => (
                                        <li key={b.termino}><span className={b.decision === 'negativa' ? 'mal' : ''}>{b.termino}</span><span className="cab-det">{b.clics} clics</span><span className={b.conversiones ? 'cab-ok' : 'cab-det'}>{Math.round(b.conversiones)}</span></li>
                                    ))}
                                </ul>
                            ) : <p className="cab-vacio">{con?.conectado ? 'Todavía no hay búsquedas este mes.' : 'Aparecen cuando Google Ads esté conectado.'}</p>}
                            {busquedas.length > 0 && <span className="cab-det cab-pie">Número a la derecha: conversiones de esa búsqueda</span>}
                        </section>
                    </aside>
                </div>
            )}

            {vista === 'anuncios' && (
                <div className="pub-bloque">
                    <div className="cab-filtros">
                        {([['todos', 'Todos'], ['activos', 'Activos'], ['aprobar', 'Para aprobar'], ['problemas', 'Con problemas']] as Array<[FiltroAd, string]>).map(([id, etq]) => (
                            <button key={id} className={`chip ${filtroAd === id ? 'on' : ''}`} onClick={() => setFiltroAd(id)}>{etq} ({cuentaAd[id]})</button>
                        ))}
                        <span className="cab-det cab-filtros-nota">Así se ven en Google. Tocá uno para ver el detalle.</span>
                    </div>
                    {errorAnuncios && <p className="error">No se pudieron leer los anuncios: {errorAnuncios}</p>}
                    {anuncios === null && <p className="vacio">Cargando anuncios…</p>}
                    {anuncios !== null && adsVisibles.length === 0 && !errorAnuncios && (
                        <div className="cab-sin-anuncios">
                            <p>{cuentaAd.todos ? 'No hay anuncios con ese filtro.' : con?.conectado ? 'La cuenta no tiene anuncios de búsqueda todavía.' : 'Cuando Google Ads esté conectado, acá aparecen sus anuncios.'}</p>
                            <button className="pub-primario" onClick={() => setGenerar({})}>✦ Generar anuncios con la web</button>
                        </div>
                    )}
                    <div className="cab-anuncios">
                        {adsVisibles.map((a) => {
                            const est = ESTADO_ANUNCIO[a.estado];
                            return (
                                <button key={a.id} className={`cab-ad ${a.problema ? 'mal' : ''} ${a.estado === 'pendiente_ok' ? 'nuevo' : ''}`} onClick={() => setDetalle(a)}>
                                    <AnuncioGoogle modo="tarjeta" titulos={titulosDe(a)} descripciones={descDe(a)} url={a.url} ruta1={a.ruta1} ruta2={a.ruta2} />
                                    <span className="cab-ad-pie">
                                        <span className={`pub-estado ${a.problema ? 'mal' : est.clase}`}>{a.problema && a.estado !== 'sin_cargar' ? a.problema : est.texto}</span>
                                        <span className="cab-det">{a.metricas ? `${a.metricas.clics} clics · ${Math.round(a.metricas.conversiones)} conv. · ${plata(a.metricas.costo)}` : a.ruta ?? ''}</span>
                                    </span>
                                </button>
                            );
                        })}
                    </div>
                </div>
            )}

            {vista === 'paginas' && (
                <div className="pub-bloque">
                    <div className="pub-bloque-head">
                        <p className="sutil">Todo anuncio sale de estas páginas. Leída el {fechaHora(r?.web_leida_en ?? null)}; se relee sola los lunes.</p>
                        <button className="boton-fantasma" onClick={leerWebAhora} disabled={!!ocupado}>{ocupado === 'web' ? 'Leyendo la web (hasta un minuto)…' : 'Releer la web'}</button>
                    </div>
                    <div className="chips" role="tablist" aria-label="Filtro de páginas">
                        {([['anunciables', 'Se anuncian'], ['todas', 'Todas'], ['cambios', 'Cambiaron esta semana'], ['error', 'Con error']] as Array<[FiltroPag, string]>).map(([id, etq]) => (
                            <button key={id} className={`chip ${filtro === id ? 'on' : ''}`} onClick={() => setFiltro(id)}>{etq} ({cuenta[id]})</button>
                        ))}
                    </div>
                    {paginas.length === 0 && <p className="vacio">Todavía no se leyó la web. Tocá “Releer la web”.</p>}
                    <div className="pub-paginas">
                        {visibles.map((p) => (
                            <div key={p.url} className={`pub-pagina ${abierta === p.url ? 'abierta' : ''}`}>
                                <div className="pub-pagina-fila">
                                    <button className="pub-pagina-tit" onClick={() => setAbierta(abierta === p.url ? null : p.url)} aria-expanded={abierta === p.url}>
                                        <span className="ruta">{p.ruta}</span>
                                        <span className="titulo">{limpiarTitulo(p.titulo)}</span>
                                    </button>
                                    <div className="pub-pagina-meta">
                                        <span className="chip-info">{TIPO[p.tipo] ?? p.tipo}</span>
                                        {!p.en_sitemap ? <span className="pub-estado mal">Ya no está en la web</span>
                                            : p.estado_http !== 200 ? <span className="pub-estado mal">Error {p.estado_http || 'sin respuesta'}</span>
                                                : reciente(p.cambio_en) ? <span className="pub-estado nuevo">Cambió {fechaHora(p.cambio_en)}</span> : null}
                                        {p.metricas && <span className="pub-metrica">{p.metricas.clics} clics · {plata(p.metricas.costo)} · {Math.round(p.metricas.conversiones)} conv.</span>}
                                        <label className="pub-toggle"><input type="checkbox" checked={p.anunciable} onChange={() => cambiarAnunciable(p)} /><span>Anunciar</span></label>
                                    </div>
                                </div>
                                {abierta === p.url && (
                                    <div className="pub-ficha">
                                        {p.descripcion && <p><span className="etq">Descripción de la página</span>{p.descripcion}</p>}
                                        {p.ficha ? (
                                            <>
                                                {p.ficha.tema && <p><span className="etq">De qué trata</span>{p.ficha.tema}{p.ficha.publico ? ` · para ${p.ficha.publico}` : ''}</p>}
                                                {p.ficha.frases.length > 0 && (
                                                    <div>
                                                        <span className="etq">Frases de la página para usar en anuncios (verificadas: están escritas tal cual)</span>
                                                        <ul className="pub-frases">{p.ficha.frases.map((f) => <li key={f}>“{f}” <span className="largo">{f.length}</span></li>)}</ul>
                                                    </div>
                                                )}
                                                {p.ficha.palabras_clave.length > 0 && <p><span className="etq">Cómo lo buscaría una empresa</span>{p.ficha.palabras_clave.join(' · ')}</p>}
                                                {p.ficha.marcas.length > 0 && <p><span className="etq">Marcas</span>{p.ficha.marcas.join(', ')}</p>}
                                            </>
                                        ) : <p className="sutil">{p.anunciable ? 'La ficha se arma en la próxima lectura de la web.' : 'Las páginas que no se anuncian no tienen ficha.'}</p>}
                                        <div className="pub-botones">
                                            {p.anunciable && <button className="pub-primario" onClick={() => setGenerar({ url: p.url, pedido: `Anuncios para ${limpiarTitulo(p.titulo) || p.ruta}` })}>✦ Generar anuncios para esta página</button>}
                                            <a className="boton-fantasma" href={p.url} target="_blank" rel="noreferrer">Abrir la página ↗</a>
                                        </div>
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>
                    {fuera.length > 0 && (
                        <div className="pub-fuera">
                            <h3>Anuncios que llevan a páginas que no están en la web</h3>
                            {fuera.map((f) => <p key={f.url}><code>{f.url}</code> · {f.metricas.clics} clics · {plata(f.metricas.costo)}</p>)}
                        </div>
                    )}
                </div>
            )}

            {vista === 'busquedas' && (
                <div className="pub-bloque">
                    <p className="sutil">Lo que la gente escribió en Google antes de ver un anuncio de Bartez (últimos 30 días).</p>
                    {busquedas.length === 0 ? <p className="vacio">{con?.conectado ? 'Todavía no hay búsquedas.' : 'Aparecen cuando Google Ads esté conectado.'}</p> : (
                        <div className="tabla-scroll">
                            <table className="pub-tabla">
                                <thead><tr><th>Búsqueda</th><th>Clics</th><th>Gasto</th><th>Conv.</th><th>Campaña</th></tr></thead>
                                <tbody>
                                    {busquedas.map((b) => (
                                        <tr key={b.termino}>
                                            <td>{b.termino}{b.decision && <span className="chip-info pub-decision">{b.decision}</span>}</td>
                                            <td className="num">{b.clics}</td><td className="num">{plata(b.costo)}</td><td className="num">{Math.round(b.conversiones)}</td>
                                            <td className="sutil">{b.campanias.join(', ')}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </div>
            )}

            {vista === 'historial' && (
                <div className="pub-bloque">
                    <p className="sutil">Lo que pasó en la cuenta mes a mes (últimos 2 años), con las campañas que tuvieron gasto.</p>
                    {!r?.historial?.length ? <p className="vacio">{con?.conectado ? 'Bajando el historial de la cuenta… aparece en unos minutos.' : 'Aparece cuando Google Ads esté conectado.'}</p> : (
                        <div className="tabla-scroll">
                            <table className="pub-tabla">
                                <thead><tr><th>Mes</th><th>Gasto</th><th>Clics</th><th>Costo por clic</th><th>Conv.</th><th>Campañas con gasto</th></tr></thead>
                                <tbody>
                                    {r.historial.map((h) => (
                                        <tr key={h.mes}>
                                            <td>{new Date(`${h.mes}-15T12:00:00`).toLocaleDateString('es-AR', { month: 'long', year: 'numeric' })}</td>
                                            <td className="num">{plata(h.gasto)}</td><td className="num">{h.clics.toLocaleString('es-AR')}</td>
                                            <td className="num">{h.clics ? plata(h.gasto / h.clics) : '—'}</td><td className="num">{h.conversiones}</td>
                                            <td className="sutil">{h.campanias.join(', ') || '—'}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                    {r && r.campanias.length > 0 && (
                        <>
                            <h3 className="cab-sub">Campañas este mes</h3>
                            <div className="tabla-scroll">
                                <table className="pub-tabla">
                                    <thead><tr><th>Campaña</th><th>Estado</th><th>Presupuesto diario</th><th>Gasto del mes</th><th>Clics</th><th>Conv.</th></tr></thead>
                                    <tbody>
                                        {r.campanias.map((c) => (
                                            <tr key={c.id}>
                                                <td>{c.nombre}</td>
                                                <td><span className={`pub-estado ${c.estado === 'ENABLED' ? 'ok' : ''}`}>{c.estado === 'ENABLED' ? 'Activa' : c.estado === 'PAUSED' ? 'Pausada' : c.estado ?? '—'}</span></td>
                                                <td className="num">{plata(c.presupuesto_diario)}</td><td className="num">{plata(c.gasto)}</td><td className="num">{c.clics}</td><td className="num">{Math.round(c.conversiones)}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        </>
                    )}
                </div>
            )}

            {vista === 'ajustes' && r && (
                <div className="cab-ajustes">
                    <form className="pub-bloque pub-ajustes" onSubmit={guardarAjustes}>
                        <label htmlFor="pub-tope">
                            <span>Tope de gasto mensual (pesos)</span>
                            <input id="pub-tope" inputMode="numeric" placeholder="Ej. 300000" value={tope} onChange={(e) => setTope(e.target.value)} />
                            <small>Si el gasto se acerca o lo pasa, te llega un aviso.</small>
                        </label>
                        <label htmlFor="pub-zona">
                            <span>Zona donde se muestran los anuncios</span>
                            <input id="pub-zona" placeholder="Ej. Rosario y 100 km, o todo el país" value={zona} onChange={(e) => setZona(e.target.value)} />
                            <small>El asistente la usa al proponer campañas.</small>
                        </label>
                        <button className="pub-primario" type="submit" disabled={ocupado === 'guardar'}>{ocupado === 'guardar' ? 'Guardando…' : 'Guardar'}</button>
                    </form>
                    {con?.conectado && (
                        <div className="pub-conexion ok">
                            <div><strong>Conectado{r.cuenta?.nombre ? ` a ${r.cuenta.nombre}` : ''}</strong><p>Datos al {fechaHora(r.sincronizado_en)} · moneda {moneda}{r.cuenta?.autoetiquetado === false ? ' · el etiquetado automático está apagado' : ''}</p></div>
                            <div className="pub-botones">
                                {confirmarDesconexion ? (
                                    <>
                                        <button className="boton-fantasma peligro" onClick={desconectar}>Sí, desconectar</button>
                                        <button className="boton-fantasma" onClick={() => setConfirmarDesconexion(false)}>Cancelar</button>
                                    </>
                                ) : <button className="boton-fantasma" onClick={() => setConfirmarDesconexion(true)}>Desconectar Google Ads</button>}
                            </div>
                        </div>
                    )}
                </div>
            )}

            {detalle && (
                <DetalleAnuncio
                    a={detalle}
                    plata={plata}
                    cerrar={() => setDetalle(null)}
                    generarVariantes={(a) => { setDetalle(null); setGenerar({ url: a.url, pedido: `Variantes del anuncio “${a.titulos[0]?.texto ?? ''}”` }); }}
                    pausaPedida={() => { setDetalle(null); setAviso({ ok: true, texto: 'La pausa quedó en Para aprobar: se aplica cuando la aprobás.' }); }}
                />
            )}
            {generar && (
                <GenerarAnuncios
                    paginas={paginas}
                    inicial={generar}
                    cerrar={() => setGenerar(null)}
                    listo={(n) => { setGenerar(null); setAviso({ ok: true, texto: `${n} ${n === 1 ? 'anuncio quedó' : 'anuncios quedaron'} en Para aprobar. Al aprobarlos se crean pausados en Google Ads.` }); setVista('anuncios'); setFiltroAd('aprobar'); cargarAnuncios(true); }}
                />
            )}
        </section>
    );
}
