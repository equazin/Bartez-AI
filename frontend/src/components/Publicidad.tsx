// Publicidad: el asistente de Google Ads. Fase 1 = solo mirar: lee la web
// (todo anuncio sale de bartez.com.ar), baja las métricas de Google Ads y avisa
// si el gasto se dispara. No cambia nada en Google Ads.

import { useEffect, useMemo, useState } from 'react';
import {
    BusquedaAds, PaginaWeb, ResumenPublicidad,
    busquedasPublicidad, desconectarGoogleAds, guardarConfigPublicidad, marcarAnunciable, paginasPublicidad,
    releerWeb, resumenPublicidad, sincronizarPublicidad, urlConectarGoogleAds,
} from '../api/client.ts';

type Seccion = 'paginas' | 'busquedas' | 'campanias' | 'historial' | 'ajustes';
type FiltroPag = 'anunciables' | 'todas' | 'cambios' | 'error';

const TIPO: Record<string, string> = {
    portada: 'Portada', solucion: 'Solución', servicio: 'Servicio', vertical: 'Rubro', canal: 'Revendedores', producto: 'Producto',
    conversion: 'Cotizar / contacto', caso: 'Caso', recurso: 'Guía', descarga: 'Descarga', posventa: 'Posventa', legal: 'Legal', institucional: 'Institucional', otra: 'Otra',
};

function fechaHora(s: string | null) {
    if (!s) return '—';
    return new Date(s).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}
const reciente = (s: string | null, dias = 7) => !!s && Date.now() - new Date(s).getTime() < dias * 86_400_000;

// Lo que dejó Google en la dirección al volver de "Conectar".
function avisoDeVuelta(): { ok: boolean; texto: string } | null {
    const h = window.location.hash;
    if (h === '#ads-conectado') return { ok: true, texto: 'Google Ads quedó conectado. Estoy bajando el último mes de datos: en un minuto aparecen.' };
    if (h === '#ads-error') return { ok: false, texto: 'No se pudo conectar Google Ads. Probá de nuevo; si sigue fallando, revisá que la dirección de retorno esté cargada en Google Cloud.' };
    if (h === '#ads-cancelado') return { ok: false, texto: 'Se canceló la conexión con Google.' };
    return null;
}

export function Publicidad() {
    const [r, setR] = useState<ResumenPublicidad | null>(null);
    const [paginas, setPaginas] = useState<PaginaWeb[]>([]);
    const [fuera, setFuera] = useState<Array<{ url: string; metricas: { clics: number; costo: number } }>>([]);
    const [busquedas, setBusquedas] = useState<BusquedaAds[]>([]);
    const [seccion, setSeccion] = useState<Seccion>('paginas');
    const [filtro, setFiltro] = useState<FiltroPag>('anunciables');
    const [abierta, setAbierta] = useState<string | null>(null);
    const [error, setError] = useState<string>();
    const [aviso, setAviso] = useState<{ ok: boolean; texto: string } | null>(() => avisoDeVuelta());
    const [ocupado, setOcupado] = useState<'' | 'web' | 'sync' | 'conectar' | 'guardar'>('');
    const [confirmarDesconexion, setConfirmarDesconexion] = useState(false);
    const [tope, setTope] = useState('');
    const [zona, setZona] = useState('');

    async function cargar() {
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
    }

    useEffect(() => {
        cargar();
        if (window.location.hash.startsWith('#ads-')) history.replaceState(null, '', window.location.pathname + window.location.search);
        // Después de conectar, la primera bajada tarda un poco.
        if (aviso?.ok) { const t = setTimeout(cargar, 20_000); return () => clearTimeout(t); }
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    const moneda = r?.cuenta?.moneda ?? 'ARS';
    const plata = (n: number | null | undefined) => (n == null ? '—' : `${moneda === 'USD' ? 'USD ' : '$'}${Math.round(n).toLocaleString('es-AR')}`);
    const enDolares = (n: number) => (moneda === 'ARS' && r?.tipo_cambio ? `≈ USD ${Math.round(n / r.tipo_cambio).toLocaleString('es-AR')}` : null);

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

    async function conectar() {
        setOcupado('conectar');
        try {
            const { url } = await urlConectarGoogleAds();
            window.location.href = url;
        } catch (e) { setError((e as Error).message); setOcupado(''); }
    }

    async function desconectar() {
        setConfirmarDesconexion(false);
        try { await desconectarGoogleAds(); await cargar(); } catch (e) { setError((e as Error).message); }
    }

    async function leerWebAhora() {
        setOcupado('web');
        setAviso(null);
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
        } catch (e) { setError((e as Error).message); }
        finally { setOcupado(''); }
    }

    async function cambiarAnunciable(p: PaginaWeb) {
        const nuevo = !p.anunciable;
        setPaginas((xs) => xs.map((x) => (x.url === p.url ? { ...x, anunciable: nuevo } : x)));
        try { await marcarAnunciable(p.url, nuevo); }
        catch (e) {
            setPaginas((xs) => xs.map((x) => (x.url === p.url ? { ...x, anunciable: !nuevo } : x)));
            setError((e as Error).message);
        }
    }

    async function guardarAjustes(ev: React.FormEvent) {
        ev.preventDefault();
        const n = tope.trim() === '' ? null : Number(tope.replace(/\./g, '').replace(',', '.'));
        if (n != null && (!Number.isFinite(n) || n < 0)) { setError('El tope tiene que ser un número en pesos, por ejemplo 300000.'); return; }
        setOcupado('guardar');
        try {
            await guardarConfigPublicidad({ tope_mensual_ars: n, zona: zona.trim() || null });
            setAviso({ ok: true, texto: 'Ajustes guardados.' });
            await cargar();
        } catch (e) { setError((e as Error).message); }
        finally { setOcupado(''); }
    }

    const con = r?.conexion;

    return (
        <section className="publicidad">
            <div className="acciones-header">
                <div>
                    <h2>Publicidad</h2>
                    <p className="sub">Google Ads armado desde bartez.com.ar. Fase 1: el asistente mira y avisa, no cambia nada en Google.</p>
                </div>
            </div>

            {error && <p className="error" role="alert">Error: {error}</p>}
            {aviso && <p className={`pub-aviso ${aviso.ok ? 'ok' : 'mal'}`} role="status">{aviso.texto}</p>}

            {/* Conexión con Google Ads */}
            {r && (
                <div className={`pub-conexion ${con?.conectado ? 'ok' : ''}`}>
                    {!con?.configurado && (
                        <>
                            <div>
                                <strong>Google Ads todavía no está configurado</strong>
                                <p>Falta cargar en Railway: {con?.faltan.map((f) => <code key={f}>{f}</code>)}. Mientras tanto el asistente ya lee la web y arma las fichas de cada página.</p>
                            </div>
                        </>
                    )}
                    {con?.configurado && !con.conectado && (
                        <>
                            <div>
                                <strong>Falta conectar la cuenta de Google Ads</strong>
                                <p>Entrás con tu cuenta de Google y el permiso queda guardado en el servidor. Nadie copia ni pega claves.</p>
                            </div>
                            <button className="pub-primario" onClick={conectar} disabled={ocupado === 'conectar'}>{ocupado === 'conectar' ? 'Abriendo Google…' : 'Conectar Google Ads'}</button>
                        </>
                    )}
                    {con?.conectado && (
                        <>
                            <div>
                                <strong>Conectado{r.cuenta?.nombre ? ` a ${r.cuenta.nombre}` : ''}</strong>
                                <p>Datos al {fechaHora(r.sincronizado_en)} · moneda {moneda}{r.cuenta?.autoetiquetado === false ? ' · el etiquetado automático está apagado' : ''}</p>
                                {r.campanias.length === 0 && <p className="pub-quieta">La cuenta no tuvo anuncios activos este mes. Si Google Ads muestra un pago pendiente, los anuncios no salen hasta regularizarlo.</p>}
                            </div>
                            <div className="pub-botones">
                                <button className="boton-fantasma" onClick={sincronizar} disabled={!!ocupado}>{ocupado === 'sync' ? 'Actualizando…' : 'Actualizar ahora'}</button>
                                {confirmarDesconexion ? (
                                    <>
                                        <button className="boton-fantasma peligro" onClick={desconectar}>Sí, desconectar</button>
                                        <button className="boton-fantasma" onClick={() => setConfirmarDesconexion(false)}>Cancelar</button>
                                    </>
                                ) : <button className="boton-fantasma" onClick={() => setConfirmarDesconexion(true)}>Desconectar</button>}
                            </div>
                        </>
                    )}
                </div>
            )}

            {/* Resumen del mes */}
            {r && con?.conectado && (
                <div className="pub-kpis">
                    <div className="pub-kpi grande">
                        <span className="etq">Gasto del mes</span>
                        <span className="val">{plata(r.mes.gasto)}</span>
                        {r.mes.tope ? (
                            <>
                                <div className="pub-barra" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(r.mes.uso_tope ?? 0, 100)} aria-label="Uso del tope mensual">
                                    <span className={(r.mes.uso_tope ?? 0) >= 90 ? 'alto' : ''} style={{ width: `${Math.min(r.mes.uso_tope ?? 0, 100)}%` }} />
                                </div>
                                <span className="det">{r.mes.uso_tope}% del tope de {plata(r.mes.tope)}{r.mes.proyeccion ? ` · al ritmo actual cierra en ${plata(r.mes.proyeccion)}` : ''}</span>
                            </>
                        ) : <span className="det">Sin tope cargado: ponelo en Ajustes.</span>}
                        {enDolares(r.mes.gasto) && <span className="det">{enDolares(r.mes.gasto)}</span>}
                    </div>
                    <div className="pub-kpi"><span className="etq">Hoy</span><span className="val">{plata(r.hoy.gasto)}</span><span className="det">{r.hoy.clics} clics · presupuesto diario {plata(r.mes.presupuesto_diario_activo)}</span></div>
                    <div className="pub-kpi"><span className="etq">Clics del mes</span><span className="val">{r.mes.clics.toLocaleString('es-AR')}</span><span className="det">costo por clic {plata(r.mes.cpc)}</span></div>
                    <div className="pub-kpi"><span className="etq">Conversiones</span><span className="val">{r.mes.conversiones.toLocaleString('es-AR')}</span><span className="det">{r.mes.costo_por_conversion != null ? `${plata(r.mes.costo_por_conversion)} cada una` : 'todavía sin medir'}</span></div>
                </div>
            )}

            {r && r.alertas.length > 0 && (
                <div className="pub-alertas">
                    <h3>Avisos de la semana</h3>
                    {r.alertas.map((a) => (
                        <div key={a.clave} className={`pub-alerta nivel-${a.nivel}`}>
                            <span className="nivel">{a.nivel === 'urgente' ? 'Urgente' : 'Aviso'}</span>
                            <span>{a.texto}</span>
                            <span className="cuando">{fechaHora(a.en)}</span>
                        </div>
                    ))}
                </div>
            )}

            <div className="segmentos pub-secciones" role="tablist" aria-label="Sección">
                {([['paginas', 'Páginas de la web'], ['busquedas', 'Búsquedas'], ['campanias', 'Campañas'], ['historial', 'Historial'], ['ajustes', 'Ajustes']] as Array<[Seccion, string]>).map(([id, etq]) => (
                    <button key={id} role="tab" aria-selected={seccion === id} className={seccion === id ? 'on' : ''} onClick={() => setSeccion(id)}>{etq}</button>
                ))}
            </div>

            {seccion === 'paginas' && (
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
                                        <span className="titulo">{p.titulo?.replace(/\s*[|—-]\s*Bartez Tecnolog[ií]a\s*$/i, '') ?? ''}</span>
                                    </button>
                                    <div className="pub-pagina-meta">
                                        <span className="chip-info">{TIPO[p.tipo] ?? p.tipo}</span>
                                        {!p.en_sitemap ? <span className="pub-estado mal">Ya no está en la web</span>
                                            : p.estado_http !== 200 ? <span className="pub-estado mal">Error {p.estado_http || 'sin respuesta'}</span>
                                                : reciente(p.cambio_en) ? <span className="pub-estado nuevo">Cambió {fechaHora(p.cambio_en)}</span> : null}
                                        {p.metricas && <span className="pub-metrica">{p.metricas.clics} clics · {plata(p.metricas.costo)} · {p.metricas.conversiones} conv.</span>}
                                        <label className="pub-toggle">
                                            <input type="checkbox" checked={p.anunciable} onChange={() => cambiarAnunciable(p)} />
                                            <span>Anunciar</span>
                                        </label>
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
                                        <a href={p.url} target="_blank" rel="noreferrer">Abrir la página ↗</a>
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

            {seccion === 'busquedas' && (
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
                                            <td className="num">{b.clics}</td><td className="num">{plata(b.costo)}</td><td className="num">{b.conversiones}</td>
                                            <td className="sutil">{b.campanias.join(', ')}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </div>
            )}

            {seccion === 'campanias' && (
                <div className="pub-bloque">
                    {!r?.campanias.length ? <p className="vacio">{con?.conectado ? 'Sin campañas con actividad este mes.' : 'Aparecen cuando Google Ads esté conectado.'}</p> : (
                        <div className="tabla-scroll">
                            <table className="pub-tabla">
                                <thead><tr><th>Campaña</th><th>Estado</th><th>Presupuesto diario</th><th>Gasto del mes</th><th>Clics</th><th>Conv.</th></tr></thead>
                                <tbody>
                                    {r.campanias.map((c) => (
                                        <tr key={c.id}>
                                            <td>{c.nombre}</td>
                                            <td><span className={`pub-estado ${c.estado === 'ENABLED' ? 'ok' : ''}`}>{c.estado === 'ENABLED' ? 'Activa' : c.estado === 'PAUSED' ? 'Pausada' : c.estado ?? '—'}</span></td>
                                            <td className="num">{plata(c.presupuesto_diario)}</td><td className="num">{plata(c.gasto)}</td><td className="num">{c.clics}</td><td className="num">{c.conversiones}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </div>
            )}

            {seccion === 'historial' && (
                <div className="pub-bloque">
                    <p className="sutil">Lo que pasó en la cuenta mes a mes (últimos 2 años). Sirve para ver qué campañas funcionaron antes de armar las nuevas.</p>
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
                </div>
            )}

            {seccion === 'ajustes' && r && (
                <form className="pub-bloque pub-ajustes" onSubmit={guardarAjustes}>
                    <label htmlFor="pub-tope">
                        <span>Tope de gasto mensual (pesos)</span>
                        <input id="pub-tope" inputMode="numeric" placeholder="Ej. 300000" value={tope} onChange={(e) => setTope(e.target.value)} />
                        <small>Si el gasto se acerca o lo pasa, te llega un aviso. En la fase 3 el asistente frena las campañas solo.</small>
                    </label>
                    <label htmlFor="pub-zona">
                        <span>Zona donde se muestran los anuncios</span>
                        <input id="pub-zona" placeholder="Ej. Rosario y 100 km, o todo el país" value={zona} onChange={(e) => setZona(e.target.value)} />
                        <small>Por ahora es una nota para el asistente; se aplica cuando arme las campañas.</small>
                    </label>
                    <div className="pub-modo"><span>Modo</span><strong>Solo mirar (fase 1)</strong><small>No propone ni cambia nada en Google Ads todavía.</small></div>
                    <button className="pub-primario" type="submit" disabled={ocupado === 'guardar'}>{ocupado === 'guardar' ? 'Guardando…' : 'Guardar'}</button>
                </form>
            )}
        </section>
    );
}
