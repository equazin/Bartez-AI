import { useEffect, useState } from 'react';
import {
    DetalleEmpresa,
    EmpresaSeguimiento,
    InformeCliente,
    descartarContactoDetectado,
    detalleEmpresaSeguimiento,
    generarInformeCliente,
    listarEmpresasSeguimiento,
    promoverContactoDetectado,
    redactarSeguimiento,
} from '../api/client.ts';

type EstadoFiltro = 'todos' | 'lead' | 'cliente' | 'inactivo' | 'descartado' | 'con_correos' | 'detectado';

export function Seguimientos() {
    const [empresas, setEmpresas] = useState<EmpresaSeguimiento[]>([]);
    const [seleccionada, setSeleccionada] = useState<DetalleEmpresa | null>(null);
    const [seleccionadaId, setSeleccionadaId] = useState<string | null>(null);
    const [busqueda, setBusqueda] = useState('');
    const [filtro, setFiltro] = useState<EstadoFiltro>('todos');
    const [error, setError] = useState<string>();
    const [cargando, setCargando] = useState(false);
    const [informe, setInforme] = useState<InformeCliente | null>(null);
    const [generandoInforme, setGenerandoInforme] = useState(false);
    const [redactando, setRedactando] = useState(false);
    const [mensajeAccion, setMensajeAccion] = useState<string | null>(null);
    const [contextoExtra, setContextoExtra] = useState('');

    async function cargar() {
        try {
            setError(undefined);
            const { empresas } = await listarEmpresasSeguimiento();
            setEmpresas(empresas);
        } catch (e) { setError((e as Error).message); }
    }

    useEffect(() => { cargar(); }, []);

    async function abrir(id: string) {
        setCargando(true);
        setInforme(null);
        setMensajeAccion(null);
        setContextoExtra('');
        setSeleccionadaId(id);
        try {
            const d = await detalleEmpresaSeguimiento(id);
            setSeleccionada(d);
        } catch (e) { setError((e as Error).message); }
        finally { setCargando(false); }
    }

    async function redactarCorreo() {
        if (!seleccionadaId) return;
        setRedactando(true);
        setMensajeAccion(null);
        try {
            await redactarSeguimiento(seleccionadaId, {
                informe_previo: informe?.resumen_md,
                contexto_extra: contextoExtra.trim() || undefined,
            });
            const partes: string[] = [];
            if (informe) partes.push('informe');
            if (contextoExtra.trim()) partes.push('contexto extra');
            const usa = partes.length > 0 ? ` (usando ${partes.join(' + ')})` : '';
            setMensajeAccion(`✓ Seguimiento redactado${usa} — va a Acciones para tu aprobación.`);
        } catch (e) { setError((e as Error).message); }
        finally { setRedactando(false); }
    }

    async function pedirInforme() {
        if (!seleccionadaId) return;
        setGenerandoInforme(true);
        try {
            const { informe } = await generarInformeCliente(seleccionadaId, contextoExtra.trim() || undefined);
            setInforme(informe);
        } catch (e) { setError((e as Error).message); }
        finally { setGenerandoInforme(false); }
    }

    // Filtros
    const filtradas = empresas.filter((e) => {
        if (filtro === 'con_correos') { if ((e.correos_totales ?? 0) === 0) return false; }
        else if (filtro !== 'todos' && e.estado !== filtro) return false;
        if (busqueda) {
            const q = busqueda.toLowerCase();
            if (!e.nombre.toLowerCase().includes(q) && !(e.email ?? '').toLowerCase().includes(q)) return false;
        }
        return true;
    });

    return (
        <section className="seguimientos">
            <div className="analitica-top">
                <div>
                    <h2>Seguimientos</h2>
                    <p className="sub">
                        Empresas, contactos e historia detallada. Click en una empresa para ver el timeline y pedir un informe.
                    </p>
                </div>
            </div>

            {error && <p className="error">Error: {error}</p>}

            <div className="seg-layout">
                <aside className="seg-lista">
                    <div className="seg-toolbar">
                        <input
                            className="seg-buscar"
                            placeholder="Buscar por nombre o email…"
                            value={busqueda}
                            onChange={(e) => setBusqueda(e.target.value)}
                        />
                        <div className="chips">
                            {(['todos', 'lead', 'cliente', 'con_correos', 'detectado', 'inactivo', 'descartado'] as EstadoFiltro[]).map((f) => (
                                <span key={f} className={filtro === f ? 'chip on' : 'chip'} onClick={() => setFiltro(f)}>
                                    {f === 'con_correos' ? 'Con correos' : f}
                                </span>
                            ))}
                        </div>
                        <div className="cnt">{filtradas.length} de {empresas.length}</div>
                    </div>
                    <div className="seg-scroll">
                        {filtradas.map((e) => (
                            <div
                                key={e.id}
                                className={`seg-item ${seleccionadaId === e.id ? 'on' : ''}`}
                                onClick={() => abrir(e.id)}
                            >
                                <div className="fila-top">
                                    <span className="nombre">{e.nombre}</span>
                                    <span className={`badge-estado est-${e.estado}`}>{e.estado}</span>
                                </div>
                                <div className="fila-meta">
                                    {typeof e.metadata?.puntaje_icp === 'number' && <span className="icp">ICP {e.metadata.puntaje_icp}</span>}
                                    <span>{e.correos_totales} correos ({e.correos_entrantes}↓ {e.correos_salientes}↑)</span>
                                </div>
                                {e.ultimo_correo_en && (
                                    <div className="fila-meta subtle">
                                        Último: {formatearFecha(e.ultimo_correo_en)} · {haceCuanto(e.ultimo_correo_en)}
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>
                </aside>

                <main className="seg-detalle">
                    {cargando && <p className="vacio">Cargando…</p>}
                    {!seleccionada && !cargando && <p className="vacio">Elegí una empresa de la izquierda para ver su historia.</p>}
                    {seleccionada && (
                        <>
                            <div className="det-head">
                                <div>
                                    <h3>{seleccionada.cliente.nombre}</h3>
                                    <div className="det-meta">
                                        <span className={`badge-estado est-${seleccionada.cliente.estado}`}>{seleccionada.cliente.estado}</span>
                                        {seleccionada.cliente.email && <span>· {seleccionada.cliente.email}</span>}
                                        {seleccionada.cliente.metadata?.sitio_web && (
                                            <> · <a href={seleccionada.cliente.metadata.sitio_web} target="_blank" rel="noreferrer">{seleccionada.cliente.metadata.sitio_web}</a></>
                                        )}
                                        {typeof seleccionada.cliente.metadata?.puntaje_icp === 'number' && (
                                            <> · <strong>ICP {seleccionada.cliente.metadata.puntaje_icp}/10</strong></>
                                        )}
                                    </div>
                                </div>
                                {seleccionada.cliente.estado === 'detectado' ? (
                                    <div style={{ display: 'flex', gap: 8 }}>
                                        <button
                                            className="primario"
                                            onClick={async () => {
                                                const dom = (seleccionada.cliente.metadata as { dominio?: string } | null)?.dominio ?? seleccionada.cliente.nombre;
                                                const nombre = window.prompt('Nombre de la empresa para crear el prospecto:', dom);
                                                if (!nombre) return;
                                                const emailsDetectados = (seleccionada.cliente.metadata as { emails_detectados?: string[] } | null)?.emails_detectados ?? [];
                                                const emailDefault = emailsDetectados[0] ?? '';
                                                const email = window.prompt('Email principal (podés dejar vacío):', emailDefault);
                                                try {
                                                    const r = await promoverContactoDetectado(dom, nombre, email || null);
                                                    alert(`✓ Prospecto creado (${r.vinculados} correos re-vinculados). Recargando lista.`);
                                                    await cargar();
                                                    setSeleccionadaId(null);
                                                    setSeleccionada(null);
                                                } catch (e) { setError((e as Error).message); }
                                            }}
                                        >
                                            Convertir en prospecto
                                        </button>
                                        <button
                                            className="peligro"
                                            onClick={async () => {
                                                const dom = (seleccionada.cliente.metadata as { dominio?: string } | null)?.dominio ?? seleccionada.cliente.nombre;
                                                if (!window.confirm(`¿Descartar todos los correos de ${dom}?\n\nEsto BORRA definitivamente los correos huérfanos de ese dominio (los que no están vinculados a un cliente). No se puede deshacer.`)) return;
                                                try {
                                                    const r = await descartarContactoDetectado(dom);
                                                    alert(`✓ Descartado. Se borraron ${r.borrados} correos.`);
                                                    await cargar();
                                                    setSeleccionadaId(null);
                                                    setSeleccionada(null);
                                                } catch (e) { setError((e as Error).message); }
                                            }}
                                        >
                                            Descartar
                                        </button>
                                    </div>
                                ) : (
                                    <div style={{ display: 'flex', gap: 8 }}>
                                        <button
                                            className="primario"
                                            onClick={redactarCorreo}
                                            disabled={redactando || !seleccionada.cliente.email}
                                            title={!seleccionada.cliente.email ? 'Este cliente no tiene email cargado' : (informe ? 'Redacta un seguimiento usando el informe y el historial de correos' : 'Redacta un seguimiento basado en el historial de correos de este cliente')}
                                        >
                                            {redactando ? 'Redactando…' : (informe ? 'Redactar seguimiento (con informe)' : 'Redactar seguimiento')}
                                        </button>
                                        <button className="secundario" onClick={pedirInforme} disabled={generandoInforme}>
                                            {generandoInforme ? 'Generando…' : (informe ? 'Regenerar informe' : 'Generar informe')}
                                        </button>
                                    </div>
                                )}
                            </div>
                            {mensajeAccion && (
                                <div className="msg-ok">{mensajeAccion}</div>
                            )}

                            {seleccionada.cliente.estado !== 'detectado' && (
                                <div className="contexto-extra">
                                    <label>
                                        <span className="lbl">Contexto adicional (opcional)</span>
                                        <span className="sub">Info que el sistema no ve — llamadas, WhatsApp, mensajes verbales, notas propias. Se le pasa tanto al informe como al seguimiento cuando los pidas.</span>
                                        <textarea
                                            value={contextoExtra}
                                            onChange={(e) => setContextoExtra(e.target.value)}
                                            placeholder="ej: me llamó ayer y me pidió 10 notebooks para el 15 de octubre. También le interesa cotizar un switch de 24 puertos."
                                            rows={3}
                                        />
                                    </label>
                                </div>
                            )}

                            {seleccionada.cliente.metadata?.senial && (
                                <div className="det-signal">
                                    <strong>Señal detectada:</strong> {seleccionada.cliente.metadata.senial}
                                </div>
                            )}

                            <div className="det-stats">
                                <div className="stat"><span className="k">Intentos de contacto</span><span className="v">{seleccionada.cliente.intentos_contacto ?? 0}</span></div>
                                <div className="stat"><span className="k">Último contacto Bartez</span><span className="v">{seleccionada.cliente.ultimo_contacto_en ? haceCuanto(seleccionada.cliente.ultimo_contacto_en) : 'nunca'}</span></div>
                                <div className="stat"><span className="k">Correos históricos</span><span className="v">{seleccionada.correos.length}</span></div>
                                <div className="stat"><span className="k">Acciones (aprobadas + pend)</span><span className="v">{seleccionada.acciones.length}</span></div>
                            </div>

                            {informe && (
                                <div className="det-informe">
                                    <div className="informe-head">
                                        <h4>Informe generado por IA</h4>
                                        <span className="mono">USD {informe.costo_usd.toFixed(4)} · {Math.round(informe.duracion_ms / 1000)}s</span>
                                    </div>
                                    <div className="markdown-simple">{formatearMarkdown(informe.resumen_md)}</div>
                                </div>
                            )}

                            <h4 className="section-h">Timeline de conversaciones</h4>
                            {seleccionada.correos.length === 0 && seleccionada.acciones.length === 0 && (
                                <p className="vacio-mini">Todavía no hay conversaciones registradas con esta empresa.</p>
                            )}
                            {seleccionada.correos.map((c, i) => (
                                <div key={`c-${i}`} className={`timeline-item corr-${c.direccion}`}>
                                    <div className="tl-head">
                                        <span className={`tl-badge ${c.direccion}`}>
                                            {c.direccion === 'entrante' ? '↓ Cliente' : '↑ Bartez'}
                                        </span>
                                        <span className="tl-fecha">{formatearFecha(c.fecha)}</span>
                                        {c.categoria && <span className="tl-cat">{c.categoria}</span>}
                                    </div>
                                    <div className="tl-asunto">{c.asunto || '(sin asunto)'}</div>
                                    <details>
                                        <summary>Ver cuerpo</summary>
                                        <pre className="tl-cuerpo">{c.cuerpo?.slice(0, 3000) ?? ''}</pre>
                                    </details>
                                </div>
                            ))}
                        </>
                    )}
                </main>
            </div>
        </section>
    );
}

function haceCuanto(iso: string): string {
    const ms = Date.now() - new Date(iso).getTime();
    const dias = Math.floor(ms / (24 * 3600_000));
    if (dias < 1) return 'hoy';
    if (dias < 30) return `hace ${dias} días`;
    const meses = Math.floor(dias / 30);
    return `hace ${meses} mes${meses > 1 ? 'es' : ''}`;
}

function formatearFecha(iso: string): string {
    return new Date(iso).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function formatearMarkdown(md: string): React.ReactNode {
    const lineas = md.split('\n');
    const out: React.ReactNode[] = [];
    let bullets: string[] = [];
    const flush = (k: string) => {
        if (bullets.length > 0) { out.push(<ul key={k}>{bullets.map((b, i) => <li key={i}>{b}</li>)}</ul>); bullets = []; }
    };
    lineas.forEach((raw, i) => {
        const l = raw.trim();
        if (!l) { flush(`u${i}`); return; }
        if (l.startsWith('## ')) { flush(`u${i}`); out.push(<h3 key={i}>{l.slice(3)}</h3>); return; }
        if (l.startsWith('# ')) { flush(`u${i}`); out.push(<h2 key={i}>{l.slice(2)}</h2>); return; }
        if (l.startsWith('- ') || l.startsWith('* ')) { bullets.push(l.slice(2)); return; }
        flush(`u${i}`);
        out.push(<p key={i}>{l}</p>);
    });
    flush('final');
    return <>{out}</>;
}
