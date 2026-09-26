import { useEffect, useRef, useState } from 'react';
import {
    DetalleEmpresa,
    EmpresaSeguimiento,
    EnvioFallido,
    InformeCliente,
    MemoriaCliente as Memoria,
    descartarContactoDetectado,
    detalleEmpresaSeguimiento,
    generarInformeCliente,
    listarEmpresasSeguimiento,
    memoriaCliente,
    promoverContactoDetectado,
    redactarSeguimiento,
    urlSegura,
} from '../api/client.ts';
import { MemoriaCliente, PestanaMemoria, fechaHora, notaResumiendose } from './seguimientos/MemoriaCliente.tsx';
import { EnviosFallidos } from './EnviosFallidos.tsx';
import { ClienteInicial, FormCliente } from './seguimientos/FormCliente.tsx';
import { movimientoReducido } from '../lib/animar.ts';

type EstadoFiltro = 'todos' | 'lead' | 'cliente' | 'inactivo' | 'descartado' | 'proveedor' | 'con_correos' | 'detectado';
const ETIQUETA_FILTRO: Record<EstadoFiltro, string> = {
    todos: 'Todos', lead: 'Leads', cliente: 'Clientes', con_correos: 'Con correos',
    detectado: 'Detectados', inactivo: 'Inactivos', descartado: 'Descartados', proveedor: 'Proveedores',
};

export function Seguimientos({ irA }: { irA?: (tab: string) => void } = {}) {
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
    // Memoria del cliente: informes guardados, notas y documentos
    const [memoria, setMemoria] = useState<Memoria | null>(null);
    const [errorMemoria, setErrorMemoria] = useState<string | null>(null);
    const [pestana, setPestana] = useState<PestanaMemoria>('informe');
    const [notaBorrador, setNotaBorrador] = useState('');
    const [avisoInforme, setAvisoInforme] = useState<string | null>(null);
    const idActual = useRef<string | null>(null);
    const detalleRef = useRef<HTMLElement>(null);
    // Alta o edición de un cliente a mano (ocupa el lugar de la ficha).
    const [formulario, setFormulario] = useState<'nuevo' | 'editar' | null>(null);

    async function cargar() {
        try {
            setError(undefined);
            const { empresas } = await listarEmpresasSeguimiento();
            setEmpresas(empresas);
        } catch (e) { setError((e as Error).message); }
    }

    useEffect(() => { cargar(); }, []);

    async function recargarMemoria(id = idActual.current) {
        if (!id || id.startsWith('det:')) return;
        try {
            const m = await memoriaCliente(id);
            const lista = <T,>(x: T[] | undefined) => (Array.isArray(x) ? x : []);
            if (idActual.current === id) {
                setMemoria({ informes: lista(m?.informes), notas: lista(m?.notas), documentos: lista(m?.documentos) });
                setErrorMemoria(null);
            }
        } catch (e) {
            if (idActual.current === id) setErrorMemoria((e as Error).message);
        }
    }

    async function abrir(id: string) {
        idActual.current = id;
        setFormulario(null);
        setCargando(true);
        setInforme(null);
        setMensajeAccion(null);
        setMemoria(null);
        setErrorMemoria(null);
        setPestana('informe');
        setNotaBorrador('');
        setAvisoInforme(null);
        setSeleccionadaId(id);
        void recargarMemoria(id);
        // En el celular la ficha queda debajo de la lista: se baja hasta ella.
        if (window.matchMedia?.('(max-width: 900px)').matches) {
            detalleRef.current?.scrollIntoView({ behavior: movimientoReducido() ? 'auto' : 'smooth', block: 'start' });
        }
        try {
            const d = await detalleEmpresaSeguimiento(id);
            if (idActual.current === id) setSeleccionada(d);
        } catch (e) { setError((e as Error).message); }
        finally { if (idActual.current === id) setCargando(false); }
    }

    // Mientras Bartez lee un documento o resume una nota larga, se consulta cada pocos segundos.
    useEffect(() => {
        const leyendo = memoria?.documentos.some((d) => d.estado === 'procesando')
            || memoria?.notas.some(notaResumiendose);
        if (!leyendo) return;
        const t = window.setTimeout(() => { void recargarMemoria(); }, 4000);
        return () => window.clearTimeout(t);
    }, [memoria]);

    async function redactarCorreo() {
        if (!seleccionadaId) return;
        const id = seleccionadaId;
        const nota = notaBorrador.trim();
        setRedactando(true);
        setMensajeAccion(null);
        try {
            // El asistente ya lee la memoria (informe, notas y documentos). Lo que
            // quedó escrito sin guardar se guarda como nota.
            await redactarSeguimiento(id, { contexto_extra: nota || undefined });
            if (idActual.current !== id) return;
            if (nota) setNotaBorrador('');
            setMensajeAccion(`✓ Seguimiento redactado con lo que Bartez sabe de este cliente${nota ? ' (tu nota quedó guardada)' : ''}. Está en Para aprobar.`);
            if (nota) void recargarMemoria(id);
        } catch (e) { setError((e as Error).message); }
        finally { setRedactando(false); }
    }

    async function pedirInforme(desdeCero = false) {
        if (!seleccionadaId) return;
        const id = seleccionadaId;
        const previo = memoria?.informes[0];
        const nota = notaBorrador.trim();
        setGenerandoInforme(true);
        setAvisoInforme(null);
        setPestana('informe');
        try {
            const { informe } = await generarInformeCliente(id, { contexto_extra: nota || undefined, desde_cero: desdeCero });
            if (idActual.current !== id) return;
            if (nota) setNotaBorrador('');
            setInforme(informe);
            const costo = informe.costo_usd > 0 ? ` · USD ${informe.costo_usd.toFixed(3)}` : '';
            setAvisoInforme(
                informe.sin_novedades
                    ? `No hubo novedades desde el último informe (${fechaHora(informe.creado_en ?? previo?.creado_en)}). Es el mismo, sin gastar IA.`
                    : informe.incremental && previo
                        ? `Actualizado: sumó lo nuevo desde ${fechaHora(previo.creado_en)}${costo}.`
                        : `Informe ${desdeCero ? 'rehecho desde cero' : 'generado'} y guardado${costo}.`,
            );
            await recargarMemoria(id);
        } catch (e) { setError((e as Error).message); }
        finally { setGenerandoInforme(false); }
    }

    const hayInforme = (memoria?.informes.length ?? 0) > 0 || !!informe;

    const textoVinculados = (v: { correos: number; whatsapp: number }) => {
        const partes = [v.correos ? `${v.correos} correo${v.correos === 1 ? '' : 's'}` : '', v.whatsapp ? `${v.whatsapp} chat${v.whatsapp === 1 ? '' : 's'} de WhatsApp` : ''].filter(Boolean);
        return partes.length ? ` Se sumaron ${partes.join(' y ')} que ya había.` : '';
    };

    function nuevoCliente() {
        setFormulario('nuevo');
        if (window.matchMedia?.('(max-width: 900px)').matches) {
            requestAnimationFrame(() => detalleRef.current?.scrollIntoView({ behavior: movimientoReducido() ? 'auto' : 'smooth', block: 'start' }));
        }
    }

    async function clienteGuardado(r: { id: string; nombre: string; vinculados: { correos: number; whatsapp: number } }, esNuevo: boolean) {
        if (esNuevo) { setFiltro('todos'); setBusqueda(''); }
        await cargar();
        await abrir(r.id);
        setMensajeAccion(`✓ ${esNuevo ? `${r.nombre} quedó cargado` : 'Datos guardados'}.${textoVinculados(r.vinculados)}`);
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
                    <h2>Clientes y seguimientos</h2>
                    <p className="sub">
                        Empresas, contactos e historia. Elegí una para ver su línea de tiempo y pedir un informe o un seguimiento.
                    </p>
                </div>
                <button type="button" className="btn-primario" onClick={nuevoCliente}>+ Nuevo cliente</button>
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
                            {(['todos', 'lead', 'cliente', 'con_correos', 'detectado', 'proveedor', 'inactivo', 'descartado'] as EstadoFiltro[]).map((f) => (
                                <button key={f} type="button" className={filtro === f ? 'chip on' : 'chip'} aria-pressed={filtro === f} onClick={() => setFiltro(f)}>
                                    {ETIQUETA_FILTRO[f]}
                                </button>
                            ))}
                        </div>
                        <div className="cnt">{filtradas.length} de {empresas.length}</div>
                    </div>
                    <div className="seg-scroll">
                        {filtradas.map((e) => (
                            <button
                                key={e.id}
                                className={`seg-item ${seleccionadaId === e.id ? 'on' : ''}`}
                                aria-current={seleccionadaId === e.id ? 'true' : undefined}
                                onClick={() => abrir(e.id)}
                            >
                                {/* Misma anatomía que las otras listas: título y dato clave arriba,
                                    detalle gris y estado abajo a la derecha. */}
                                <span className="fila-top">
                                    <span className="nombre">{e.nombre}</span>
                                    {e.ultimo_correo_en && <span className="hora" title={formatearFecha(e.ultimo_correo_en)}>{haceCuanto(e.ultimo_correo_en)}</span>}
                                </span>
                                <span className="fila-pie">
                                    <span className="fila-meta">
                                        {typeof e.metadata?.puntaje_icp === 'number' && (
                                            <span className="icp" title={`Encaje con el cliente ideal: ${e.metadata.puntaje_icp}/10`}>
                                                <span className="icp-barra"><span style={{ width: `${e.metadata.puntaje_icp * 10}%` }} /></span>
                                                <span>{e.metadata.puntaje_icp}</span>
                                            </span>
                                        )}
                                        <span title={`${e.correos_entrantes} recibidos · ${e.correos_salientes} enviados`}>
                                            {e.correos_totales} correo{e.correos_totales === 1 ? '' : 's'}
                                        </span>
                                    </span>
                                    <span className={`badge-estado est-${e.estado}`}>{e.estado}</span>
                                </span>
                            </button>
                        ))}
                    </div>
                </aside>

                <main className="seg-detalle" ref={detalleRef}>
                    {formulario === 'nuevo' && (
                        <FormCliente
                            alGuardar={(r) => void clienteGuardado(r, true)}
                            alCancelar={() => setFormulario(null)}
                            alAbrir={(id) => void abrir(id)}
                        />
                    )}
                    {formulario === 'editar' && seleccionada && seleccionadaId && (
                        <FormCliente
                            inicial={{ ...(seleccionada.cliente as unknown as ClienteInicial), id: seleccionadaId }}
                            alGuardar={(r) => void clienteGuardado(r, false)}
                            alCancelar={() => setFormulario(null)}
                            alAbrir={(id) => void abrir(id)}
                        />
                    )}
                    {!formulario && cargando && <p className="vacio">Cargando…</p>}
                    {!formulario && !seleccionada && !cargando && (
                        <p className="vacio">Elegí una empresa de la izquierda para ver su historia, o cargá un cliente nuevo con «+ Nuevo cliente».</p>
                    )}
                    {!formulario && seleccionada && (
                        <>
                            <div className="det-head">
                                <div>
                                    <h3>{seleccionada.cliente.nombre}</h3>
                                    <div className="det-meta">
                                        <span className={`badge-estado est-${seleccionada.cliente.estado}`}>{seleccionada.cliente.estado}</span>
                                        {seleccionada.cliente.email && <span>· {seleccionada.cliente.email}</span>}
                                        {seleccionada.cliente.metadata?.sitio_web && (
                                            <> · <a href={urlSegura(seleccionada.cliente.metadata.sitio_web)} target="_blank" rel="noreferrer">{seleccionada.cliente.metadata.sitio_web}</a></>
                                        )}
                                        {typeof seleccionada.cliente.metadata?.puntaje_icp === 'number' && (
                                            <> · <strong>ICP {seleccionada.cliente.metadata.puntaje_icp}/10</strong></>
                                        )}
                                        {seleccionada.cliente.whatsapp && <span>· {seleccionada.cliente.whatsapp}</span>}
                                        {seleccionada.cliente.metadata?.contacto && <span>· {seleccionada.cliente.metadata.contacto}</span>}
                                        {seleccionada.cliente.metadata?.cuit && <span>· CUIT {seleccionada.cliente.metadata.cuit}</span>}
                                        {seleccionada.cliente.estado !== 'detectado' && (
                                            <button type="button" className="enlace det-editar" onClick={() => setFormulario('editar')}>Editar datos</button>
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
                                            title={!seleccionada.cliente.email ? 'Este cliente no tiene email cargado' : 'Redacta un seguimiento con el historial y lo que Bartez sabe de este cliente (informe, notas y documentos)'}
                                        >
                                            {redactando ? 'Redactando…' : 'Redactar seguimiento'}
                                        </button>
                                        <button
                                            className="secundario"
                                            onClick={() => pedirInforme()}
                                            disabled={generandoInforme}
                                            title={hayInforme ? 'Parte del último informe y suma solo lo nuevo' : 'Lee toda la historia y guarda el informe'}
                                        >
                                            {generandoInforme ? (hayInforme ? 'Actualizando…' : 'Generando…') : (hayInforme ? 'Actualizar informe' : 'Generar informe')}
                                        </button>
                                    </div>
                                )}
                            </div>
                            {mensajeAccion && (
                                <div className="msg-ok">{mensajeAccion}</div>
                            )}

                            {/* Seguimientos aprobados que no salieron: reintentar desde acá. */}
                            <EnviosFallidos
                                acciones={seleccionada.acciones.filter((a) =>
                                    ['aprobada', 'editada'].includes(a.estado)
                                    && ['enviar_correo', 'enviar_whatsapp'].includes(a.accion)
                                    && (a.respuesta as { ejecucion?: { ok?: boolean } } | null)?.ejecucion?.ok === false) as unknown as EnvioFallido[]}
                                alCambiar={() => { if (seleccionadaId) void abrir(seleccionadaId); }}
                                titulo="Un envío a este cliente no salió"
                            />

                            {seleccionada.cliente.metadata?.senial && (
                                <div className="det-signal">
                                    <strong>Señal detectada:</strong> {seleccionada.cliente.metadata.senial}
                                </div>
                            )}

                            <div className="det-stats">
                                <div className="stat"><span className="k">Intentos</span><span className="v">{seleccionada.cliente.intentos_contacto ?? 0}</span></div>
                                <div className="stat"><span className="k">Último contacto</span><span className="v">{seleccionada.cliente.ultimo_contacto_en ? haceCuanto(seleccionada.cliente.ultimo_contacto_en) : 'nunca'}</span></div>
                                <div className="stat"><span className="k">Correos</span><span className="v">{seleccionada.correos.length}</span></div>
                                <div className="stat"><span className="k">WhatsApp</span><span className="v">{seleccionada.whatsapp?.length ?? 0}</span></div>
                                <div className="stat"><span className="k">Propuestas</span><span className="v">{seleccionada.acciones.length}</span></div>
                            </div>

                            {seleccionada.cliente.estado !== 'detectado' && seleccionadaId && (
                                <MemoriaCliente
                                    key={seleccionadaId}
                                    clienteId={seleccionadaId}
                                    memoria={memoria}
                                    error={errorMemoria}
                                    setMemoria={setMemoria}
                                    pestana={pestana}
                                    setPestana={setPestana}
                                    notaBorrador={notaBorrador}
                                    setNotaBorrador={setNotaBorrador}
                                    aviso={avisoInforme}
                                    informeSuelto={informe}
                                    generando={generandoInforme}
                                    onRehacer={() => pedirInforme(true)}
                                    irA={irA}
                                />
                            )}

                            <h4 className="section-h">Timeline de conversaciones</h4>
                            {(seleccionada.whatsapp?.length ?? 0) > 0 && (
                                <details className="timeline-wa" open>
                                    <summary>WhatsApp · {seleccionada.whatsapp!.length} mensajes recientes</summary>
                                    <div className="wa-mini-hilo">
                                        {seleccionada.whatsapp!.slice().reverse().map((m) => (
                                            <div key={m.id} className={`wa-burbuja ${m.origen === 'cliente' ? 'entrante' : 'saliente'} ${m.origen}`}>
                                                <span className="wa-quien">
                                                    {m.origen === 'cliente' ? 'Cliente' : m.origen === 'bot' ? 'Bot web' : 'Bartez'} · {formatearFecha(m.creado_en)}
                                                </span>
                                                {m.cuerpo || <em>(sin texto)</em>}
                                            </div>
                                        ))}
                                    </div>
                                </details>
                            )}
                            {seleccionada.correos.length === 0 && seleccionada.acciones.length === 0 && !(seleccionada.whatsapp?.length) && (
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
    if (dias === 1) return 'ayer';
    if (dias < 30) return `hace ${dias} días`;
    const meses = Math.floor(dias / 30);
    return `hace ${meses} mes${meses > 1 ? 'es' : ''}`;
}

function formatearFecha(iso: string): string {
    return new Date(iso).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}
