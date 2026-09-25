import { useEffect, useMemo, useRef, useState } from 'react';
import {
    ConversacionWa,
    EmpresaSeguimiento,
    MensajeWa,
    ajustesWhatsapp,
    borradorWhatsapp,
    crearClienteDesdeWa,
    detalleConversacionWa,
    enviarWhatsappAMano,
    estadoWhatsapp,
    guardarAjustesWhatsapp,
    listarConversacionesWa,
    listarEmpresasSeguimiento,
    resolverAccion,
    sincronizarWa,
    vincularClienteWa,
} from '../api/client.ts';
import { ConfigPlantillas, RetomarConPlantilla } from './whatsapp/Plantillas.tsx';

type Filtro = 'todas' | 'escaladas' | 'ventana' | 'pendientes' | 'sin_cliente';

const ESTADOS: Record<string, string> = {
    escalated: 'Derivada a persona',
    active: 'La atiende el bot',
    pending_lead_confirmation: 'Bot esperando confirmación',
};
const QUIEN: Record<string, string> = { cliente: 'Cliente', bot: 'Bot web', humano: 'Bartez' };

const hora = (iso: string) => new Date(iso).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
// En el celular Enter hace un salto de línea; en la compu, Enter envía (como WhatsApp Web).
const esTactil = () => typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches;
type Propuesta = { accion_id: string; cuerpo: string; creado_en: string };

export function WhatsApp() {
    const [configurado, setConfigurado] = useState<boolean | null>(null);
    const [convs, setConvs] = useState<ConversacionWa[]>([]);
    const [filtro, setFiltro] = useState<Filtro>('escaladas');
    const [busqueda, setBusqueda] = useState('');
    const [sel, setSel] = useState<string | null>(null);
    const [mensajes, setMensajes] = useState<MensajeWa[]>([]);
    // Lo que se está escribiendo para mandar. Se guarda por conversación al cambiar de chat.
    const [texto, setTexto] = useState('');
    const borradores = useRef(new Map<string, { texto: string; desde: string | null }>());
    // Si el texto salió de la propuesta que esperaba en Para aprobar.
    const [desdePropuesta, setDesdePropuesta] = useState<string | null>(null);
    const [propuesta, setPropuesta] = useState<Propuesta | null>(null);
    const [errorEnvio, setErrorEnvio] = useState<string>();
    const [firma, setFirma] = useState<string | null>(null);
    const cajaRef = useRef<HTMLTextAreaElement>(null);
    const [ocupado, setOcupado] = useState<string | null>(null);
    const [error, setError] = useState<string>();
    const [aviso, setAviso] = useState<string>();
    const [clientes, setClientes] = useState<EmpresaSeguimiento[]>([]);
    const [verPlantillas, setVerPlantillas] = useState(false);
    const hiloRef = useRef<HTMLDivElement>(null);
    // Al abrir una conversación se ve lo último, como en WhatsApp.
    useEffect(() => {
        const h = hiloRef.current;
        if (h) h.scrollTop = h.scrollHeight;
    }, [mensajes, sel]);
    const [versionPl, setVersionPl] = useState(0);

    async function cargar() {
        try {
            setConvs((await listarConversacionesWa()).conversaciones);
        } catch (e) { setError((e as Error).message); }
    }

    async function abrir(waId: string) {
        if (sel && sel !== waId) {
            if (texto.trim()) borradores.current.set(sel, { texto, desde: desdePropuesta });
            else borradores.current.delete(sel);
        }
        if (sel !== waId) {
            const b = borradores.current.get(waId);
            setTexto(b?.texto ?? '');
            setDesdePropuesta(b?.desde ?? null);
            setPropuesta(null);
            setErrorEnvio(undefined);
        }
        setSel(waId);
        setAviso(undefined);
        try {
            const d = await detalleConversacionWa(waId);
            setMensajes(d.mensajes);
            setPropuesta(d.propuesta ?? null);
        } catch (e) { setError((e as Error).message); }
    }

    useEffect(() => {
        estadoWhatsapp().then((r) => setConfigurado(r.configurado)).catch(() => setConfigurado(false));
        ajustesWhatsapp().then((r) => setFirma(r.ajustes.presentarse_como)).catch(() => setFirma(null));
        cargar();
        listarEmpresasSeguimiento().then((r) => setClientes(r.empresas.filter((e) => !e.id.startsWith('det:')))).catch(() => {});
        // La sincronización corre sola cada 2 min en el backend: refrescamos la lista.
        const t = setInterval(cargar, 60_000);
        return () => clearInterval(t);
    }, []);

    async function sincronizar() {
        setOcupado('sync');
        setError(undefined);
        try {
            const { resultado: r } = await sincronizarWa();
            if (!r.ok) setError(r.detalle ?? 'No se pudo sincronizar');
            else setAviso(`✓ ${r.conversaciones} conversaciones · ${r.actualizadas} actualizadas · ${r.borradores} respuestas propuestas`);
            await cargar();
            if (sel) await abrir(sel);
        } catch (e) { setError((e as Error).message); }
        finally { setOcupado(null); }
    }

    // Manda lo escrito, sin pasar por Para aprobar.
    async function enviar() {
        const waId = sel;
        const cuerpo = texto.trim();
        if (!waId || !cuerpo || ocupado === 'enviar') return;
        setOcupado('enviar');
        setErrorEnvio(undefined);
        try {
            const { mensaje } = await enviarWhatsappAMano(waId, cuerpo, desdePropuesta);
            borradores.current.delete(waId);
            if (sel === waId) {
                setMensajes((m) => [...m, mensaje]);
                setTexto('');
                setDesdePropuesta(null);
                setPropuesta(null);
            }
            await cargar();
        } catch (e) { setErrorEnvio((e as Error).message); }
        finally { setOcupado(null); }
    }

    // Bartez redacta en la caja: desde cero o a partir de lo que escribiste.
    async function redactarConBartez() {
        if (!sel) return;
        setOcupado('borrador');
        setErrorEnvio(undefined);
        try {
            const r = await borradorWhatsapp(sel, texto.trim() || undefined);
            setTexto(r.texto);
            setDesdePropuesta(null);
            cajaRef.current?.focus();
        } catch (e) { setErrorEnvio((e as Error).message); }
        finally { setOcupado(null); }
    }

    function usarPropuesta() {
        if (!propuesta) return;
        setTexto(propuesta.cuerpo);
        setDesdePropuesta(propuesta.accion_id);
        cajaRef.current?.focus();
    }

    async function descartarPropuesta() {
        if (!propuesta) return;
        setOcupado('descartar');
        try {
            await resolverAccion(propuesta.accion_id, 'rechazar', { nota: 'Descartada desde el chat de WhatsApp' });
            if (desdePropuesta === propuesta.accion_id) setDesdePropuesta(null);
            setPropuesta(null);
            await cargar();
        } catch (e) { setErrorEnvio((e as Error).message); }
        finally { setOcupado(null); }
    }

    async function cambiarFirma() {
        const v = window.prompt('¿Con qué nombre se presenta Bartez cuando redacta por WhatsApp? (vacío = sin nombre, "del equipo comercial")', firma ?? '');
        if (v === null) return;
        try { setFirma((await guardarAjustesWhatsapp({ presentarse_como: v.trim() })).ajustes.presentarse_como); }
        catch (e) { setError((e as Error).message); }
    }

    async function crearCliente(c: ConversacionWa) {
        const nombre = window.prompt('Nombre del cliente o empresa', c.nombre ?? '');
        if (nombre === null) return;
        try {
            await crearClienteDesdeWa(c.wa_id, nombre);
            setAviso('✓ Cliente creado y vinculado. Ya aparece en Seguimientos.');
            await cargar();
            const r = await listarEmpresasSeguimiento().catch(() => null);
            if (r) setClientes(r.empresas.filter((e) => !e.id.startsWith('det:')));
        } catch (e) { setError((e as Error).message); }
    }

    async function vincular(c: ConversacionWa, clienteId: string) {
        try {
            await vincularClienteWa(c.wa_id, clienteId || null);
            await cargar();
        } catch (e) { setError((e as Error).message); }
    }

    const visibles = useMemo(() => {
        const q = busqueda.trim().toLowerCase();
        return convs.filter((c) => {
            if (filtro === 'escaladas' && c.estado !== 'escalated') return false;
            if (filtro === 'ventana' && !c.en_ventana) return false;
            if (filtro === 'pendientes' && !c.respuesta_pendiente) return false;
            if (filtro === 'sin_cliente' && c.cliente_id) return false;
            if (!q) return true;
            return [c.nombre, c.cliente_nombre, c.wa_id, c.ultimo_mensaje].some((v) => v?.toLowerCase().includes(q));
        });
    }, [convs, filtro, busqueda]);

    const actual = convs.find((c) => c.wa_id === sel) ?? null;

    if (configurado === false) {
        return (
            <section className="whatsapp">
                <h2>WhatsApp</h2>
                <div className="det-signal">
                    Falta conectar la web: agregá <code>STUDIO_API_URL</code> y <code>STUDIO_API_TOKEN</code> en <code>backend/.env</code> y reiniciá el backend.
                </div>
            </section>
        );
    }

    return (
        <section className="whatsapp">
            <div className="analitica-top">
                <div>
                    <h2>WhatsApp</h2>
                    <p className="sub">
                        Conversaciones del bot de bartez.com.ar. Respondé desde acá cuando quieras: lo que escribís sale directo.
                        Si querés, Bartez te lo redacta. Se actualiza sola cada 2 minutos.
                    </p>
                </div>
                <div className="wa-cab-acciones">
                    {firma !== null && (
                        <button className="secundario" onClick={cambiarFirma} title="Nombre con el que se presenta Bartez cuando redacta">
                            {firma ? <>Te presentás como <strong>{firma}</strong></> : 'Sin nombre al presentarse'}
                        </button>
                    )}
                    <button className="secundario" onClick={() => setVerPlantillas((v) => !v)}>Plantillas</button>
                    <button className="primario" onClick={sincronizar} disabled={ocupado === 'sync'}>
                        {ocupado === 'sync' ? 'Sincronizando…' : 'Sincronizar ahora'}
                    </button>
                </div>
            </div>

            {verPlantillas && <ConfigPlantillas alCerrar={() => setVerPlantillas(false)} alGuardar={() => setVersionPl((v) => v + 1)} />}

            {error && <p className="error">Error: {error}</p>}
            {aviso && <div className="msg-ok">{aviso}</div>}

            <div className="wa-layout">
                <aside className="wa-lista">
                    <input className="wa-buscar" placeholder="Buscar nombre, número o texto…" value={busqueda} onChange={(e) => setBusqueda(e.target.value)} />
                    <div className="wa-filtros">
                        {([
                            ['escaladas', 'Derivadas'],
                            ['ventana', 'Últimas 24 h'],
                            ['pendientes', 'Con propuesta'],
                            ['sin_cliente', 'Sin cliente'],
                            ['todas', 'Todas'],
                        ] as Array<[Filtro, string]>).map(([f, etq]) => (
                            <button key={f} className={filtro === f ? 'activo' : ''} onClick={() => setFiltro(f)}>{etq}</button>
                        ))}
                    </div>
                    <div className="wa-items">
                    {visibles.length === 0 && <p className="vacio-mini">No hay conversaciones con este filtro.</p>}
                    {visibles.map((c) => (
                        <div
                            key={c.wa_id}
                            className={`wa-item ${sel === c.wa_id ? 'activo' : ''}`}
                            role="button" tabIndex={0} aria-current={sel === c.wa_id ? 'true' : undefined}
                            onClick={() => abrir(c.wa_id)}
                            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); abrir(c.wa_id); } }}
                        >
                            <div className="wa-item-top">
                                <strong>{c.cliente_nombre ?? c.nombre ?? `+${c.wa_id}`}</strong>
                                <span className="hora">{c.actualizado_en ? hora(c.actualizado_en) : ''}</span>
                            </div>
                            <div className="wa-item-txt">
                                {c.ultimo_origen && c.ultimo_origen !== 'cliente' && <span className="wa-de">{QUIEN[c.ultimo_origen]}: </span>}
                                {c.ultimo_mensaje ?? '(sin texto)'}
                            </div>
                            {/* Una sola etiqueta de estado (la más importante), abajo a la derecha. */}
                            <div className="fila-pie">
                                <span className="tenue wa-item-meta">{c.cliente_id ? '' : 'sin cliente'}</span>
                                {c.respuesta_pendiente ? <span className="wa-tag wa-tag-aprobar">en Para aprobar</span>
                                    : c.en_ventana ? <span className="wa-tag ventana">24 h abierta</span>
                                    : c.estado === 'escalated' ? <span className="wa-tag">derivada</span>
                                    : null}
                            </div>
                        </div>
                    ))}
                    </div>
                </aside>

                <main className="wa-chat">
                    {!actual ? (
                        <p className="vacio">Elegí una conversación para ver los mensajes.</p>
                    ) : (
                        <>
                            <div className="wa-chat-head">
                                <div>
                                    <h3>{actual.cliente_nombre ?? actual.nombre ?? 'Sin nombre'}</h3>
                                    <div className="sub">
                                        +{actual.wa_id}
                                        {actual.nombre && actual.cliente_nombre && <> · perfil: {actual.nombre}</>}
                                        {actual.estado && <> · {ESTADOS[actual.estado] ?? actual.estado}</>}
                                        {actual.categoria && <> · {actual.categoria}</>}
                                    </div>
                                </div>
                                <div className="wa-cliente">
                                    <select value={actual.cliente_id ?? ''} onChange={(e) => vincular(actual, e.target.value)}>
                                        <option value="">— Sin cliente vinculado —</option>
                                        {clientes.map((cl) => <option key={cl.id} value={cl.id}>{cl.nombre}</option>)}
                                    </select>
                                    {!actual.cliente_id && <button className="secundario" onClick={() => crearCliente(actual)}>Crear cliente</button>}
                                </div>
                            </div>

                            <div className="wa-hilo" ref={hiloRef}>
                                {mensajes.map((m) => (
                                    <div key={m.id} className={`wa-burbuja ${m.origen === 'cliente' ? 'entrante' : 'saliente'} ${m.origen}`}>
                                        <span className="wa-quien">{QUIEN[m.origen] ?? m.origen} · {hora(m.creado_en)}</span>
                                        {m.cuerpo || <em>(sin texto: audio, imagen o archivo)</em>}
                                    </div>
                                ))}
                            </div>

                            <div className="wa-proponer">
                                <div className={`wa-ventana ${actual.en_ventana ? 'abierta' : 'cerrada'}`}>
                                    {actual.en_ventana
                                        ? `Ventana abierta hasta ${actual.ventana_hasta ? hora(actual.ventana_hasta) : ''}: se puede responder con texto libre.`
                                        : 'Pasaron más de 24 h del último mensaje del cliente: WhatsApp solo permite escribirle con una plantilla aprobada.'}
                                </div>
                                {!actual.en_ventana && (
                                    <RetomarConPlantilla
                                        key={`${actual.wa_id}-${versionPl}`}
                                        waId={actual.wa_id}
                                        nombre={actual.cliente_nombre ?? actual.nombre}
                                        alEnviar={(m) => { setMensajes((prev) => [...prev, m]); setPropuesta(null); setAviso('✓ Plantilla enviada.'); cargar(); }}
                                        alConfigurar={() => setVerPlantillas(true)}
                                    />
                                )}
                                {actual.en_ventana && propuesta && desdePropuesta !== propuesta.accion_id && (
                                    <div className="wa-sugerida">
                                        <span className="wa-sugerida-etq">✦ Bartez propuso esta respuesta (está en Para aprobar)</span>
                                        <p>{propuesta.cuerpo}</p>
                                        <div className="wa-sugerida-acc">
                                            <button type="button" className="enlace" onClick={usarPropuesta}>Usar y editar</button>
                                            <button type="button" className="enlace wa-descartar" onClick={descartarPropuesta} disabled={ocupado === 'descartar'}>Descartar</button>
                                        </div>
                                    </div>
                                )}
                                {actual.en_ventana && (
                                    <div className="wa-escribir">
                                        <textarea
                                            ref={cajaRef}
                                            rows={3}
                                            value={texto}
                                            aria-label="Tu respuesta"
                                            onChange={(e) => setTexto(e.target.value)}
                                            onKeyDown={(e) => {
                                                if (e.key === 'Enter' && !e.shiftKey && !esTactil() && !e.nativeEvent.isComposing) { e.preventDefault(); void enviar(); }
                                            }}
                                            placeholder="Escribí tu respuesta… (o escribí la idea y tocá «Mejorar con Bartez»)"
                                            disabled={ocupado === 'enviar'}
                                        />
                                        {errorEnvio && <p className="wa-error" role="alert">{errorEnvio}</p>}
                                        <div className="wa-escribir-pie">
                                            <button type="button" className="secundario" onClick={redactarConBartez} disabled={ocupado === 'borrador' || ocupado === 'enviar'}>
                                                {ocupado === 'borrador' ? 'Redactando…' : texto.trim() ? '✦ Mejorar con Bartez' : '✦ Redactar con Bartez'}
                                            </button>
                                            <span className="tenue wa-atajo">{esTactil() ? '' : 'Enter envía · Shift + Enter, otra línea'}</span>
                                            <button type="button" className="primario" onClick={enviar} disabled={!texto.trim() || ocupado === 'enviar'}>
                                                {ocupado === 'enviar' ? 'Enviando…' : 'Enviar'}
                                            </button>
                                        </div>
                                    </div>
                                )}
                            </div>
                        </>
                    )}
                </main>
            </div>
        </section>
    );
}
