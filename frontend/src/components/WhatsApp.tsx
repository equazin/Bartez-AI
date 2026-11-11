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
    refrescarConversacionWa,
    resolverAccion,
    sincronizarWa,
    urlAdjuntoWa,
    enviarAdjuntoWa,
    vincularClienteWa,
} from '../api/client.ts';
import { ConfigPlantillas, RetomarConPlantilla } from './whatsapp/Plantillas.tsx';
import { AdjuntoElegido, ElegirAdjunto } from './whatsapp/Adjuntar.tsx';

type Filtro = 'todas' | 'escaladas' | 'ventana' | 'pendientes' | 'sin_cliente';

const ESTADOS: Record<string, string> = {
    escalated: 'Derivada a persona',
    active: 'La atiende el bot',
    pending_lead_confirmation: 'Bot esperando confirmación',
};
const QUIEN: Record<string, string> = { cliente: 'Cliente', bot: 'Bot web', humano: 'Bartez' };
// Lo que mandó el cliente sin texto (la web no deja ver el archivo desde acá).
const SIN_TEXTO: Record<string, string> = {
    image: '📷 Foto', document: '📄 Archivo', audio: '🎤 Audio', voice: '🎤 Audio', video: '🎥 Video', sticker: 'Sticker', location: '📍 Ubicación',
};
// Cada cuánto se refresca la pantalla (de la base de Bartez AI, no le pega a la web).
const REFRESCO_MS = 15_000;
// Mientras se chatea (último mensaje hace menos de esto) también se consulta la web.
const CHAT_ACTIVO_MS = 15 * 60_000;
const mismoHilo = (a: MensajeWa[], b: MensajeWa[]) => a.length === b.length && a[a.length - 1]?.id === b[b.length - 1]?.id;

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
    // Cómo salió el último archivo (se muestra debajo de la caja).
    const [avisoEnvio, setAvisoEnvio] = useState<string>();
    const [firma, setFirma] = useState<string | null>(null);
    const cajaRef = useRef<HTMLTextAreaElement>(null);
    const [ocupado, setOcupado] = useState<string | null>(null);
    const [error, setError] = useState<string>();
    const [aviso, setAviso] = useState<string>();
    const [clientes, setClientes] = useState<EmpresaSeguimiento[]>([]);
    const [verPlantillas, setVerPlantillas] = useState(false);
    // Archivo elegido para mandar (sale con el texto de la caja).
    const [adjunto, setAdjunto] = useState<AdjuntoElegido | null>(null);
    const [verAdjuntar, setVerAdjuntar] = useState(false);
    const hiloRef = useRef<HTMLDivElement>(null);
    // Para el refresco automático (corre fuera del render).
    const selRef = useRef<string | null>(null);
    const mensajesRef = useRef<MensajeWa[]>([]);
    const convsRef = useRef<ConversacionWa[]>([]);
    const abajoRef = useRef(true);
    const selVistoRef = useRef<string | null>(null);
    useEffect(() => { selRef.current = sel; }, [sel]);
    useEffect(() => { mensajesRef.current = mensajes; }, [mensajes]);
    useEffect(() => { convsRef.current = convs; }, [convs]);
    // Al abrir una conversación se ve lo último, como en WhatsApp. Si llega un
    // mensaje nuevo baja solo, salvo que estés leyendo más arriba.
    useEffect(() => {
        const h = hiloRef.current;
        if (!h) return;
        if (selVistoRef.current !== sel || abajoRef.current) h.scrollTop = h.scrollHeight;
        selVistoRef.current = sel;
    }, [mensajes, sel]);
    const [versionPl, setVersionPl] = useState(0);

    async function cargar(): Promise<ConversacionWa[] | null> {
        try {
            const lista = (await listarConversacionesWa()).conversaciones;
            setConvs(lista);
            return lista;
        } catch (e) { setError((e as Error).message); return null; }
    }

    // Mensajes y propuesta de la conversación abierta (si sigue abierta y cambió algo).
    function aplicarDetalle(waId: string, d: { mensajes: MensajeWa[]; propuesta?: Propuesta | null }) {
        if (selRef.current !== waId) return;
        if (!mismoHilo(mensajesRef.current, d.mensajes)) setMensajes(d.mensajes);
        setPropuesta(d.propuesta ?? null);
    }

    // Trae lo último de la web para la conversación abierta.
    async function refrescarAbierta(waId: string, motivo: 'abrir' | 'chat') {
        try {
            const d = await refrescarConversacionWa(waId, motivo);
            aplicarDetalle(waId, d);
            if (d.nuevos > 0) await cargar();
        } catch { /* la próxima vuelta lo intenta de nuevo */ }
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
            setAvisoEnvio(undefined);
            setAdjunto(null);
            setVerAdjuntar(false);
            setMensajes([]);
            abajoRef.current = true; // otra conversación: se abre mostrando lo último
        }
        setSel(waId);
        selRef.current = waId;
        setAviso(undefined);
        try {
            // Primero lo que ya está guardado (al instante) y después lo último de la web.
            const d = await detalleConversacionWa(waId);
            if (selRef.current === waId) { setMensajes(d.mensajes); setPropuesta(d.propuesta ?? null); }
            void refrescarAbierta(waId, 'abrir');
        } catch (e) { setError((e as Error).message); }
    }

    useEffect(() => {
        estadoWhatsapp().then((r) => setConfigurado(r.configurado)).catch(() => setConfigurado(false));
        ajustesWhatsapp().then((r) => setFirma(r.ajustes.presentarse_como)).catch(() => setFirma(null));
        cargar();
        listarEmpresasSeguimiento().then((r) => setClientes(r.empresas.filter((e) => !e.id.startsWith('det:')))).catch(() => {});

        // El backend trae lo nuevo de la web solo (cada minuto en horario
        // comercial, o al instante si la web avisa). Acá se refresca la pantalla
        // y, si estás chateando, se pide lo último de la conversación abierta.
        let corriendo = false;
        async function vuelta() {
            if (corriendo || document.visibilityState !== 'visible') return;
            corriendo = true;
            try {
                const antes = convsRef.current;
                const lista = await cargar();
                const waId = selRef.current;
                if (!waId || !lista) return;
                const ultimo = mensajesRef.current[mensajesRef.current.length - 1];
                const activa = !!ultimo && Date.now() - new Date(ultimo.creado_en).getTime() < CHAT_ACTIVO_MS;
                const a = antes.find((c) => c.wa_id === waId);
                const b = lista.find((c) => c.wa_id === waId);
                const cambio = !a || !b || a.actualizado_en !== b.actualizado_en || a.ultimo_mensaje !== b.ultimo_mensaje || a.respuesta_pendiente !== b.respuesta_pendiente;
                if (activa) await refrescarAbierta(waId, 'chat');
                else if (cambio) aplicarDetalle(waId, await detalleConversacionWa(waId));
            } catch { /* la próxima vuelta lo intenta de nuevo */ }
            finally { corriendo = false; }
        }
        const t = setInterval(vuelta, REFRESCO_MS);
        // Al volver a la pestaña, se actualiza enseguida.
        const alVolver = () => { if (document.visibilityState === 'visible') void vuelta(); };
        document.addEventListener('visibilitychange', alVolver);
        return () => { clearInterval(t); document.removeEventListener('visibilitychange', alVolver); };
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

    // Manda lo escrito (y el archivo elegido), sin pasar por Para aprobar.
    async function enviar() {
        const waId = sel;
        const cuerpo = texto.trim();
        if (!waId || (!cuerpo && !adjunto) || ocupado === 'enviar') return;
        setOcupado('enviar');
        setErrorEnvio(undefined);
        setAvisoEnvio(undefined);
        try {
            if (adjunto) {
                const r = await enviarAdjuntoWa(waId, adjunto.origen, cuerpo);
                if (selRef.current === waId) {
                    setMensajes((m) => [...m, ...r.mensajes]);
                    setAdjunto(null);
                    if (cuerpo) { setTexto(''); setDesdePropuesta(null); setPropuesta(null); }
                    setAvisoEnvio(r.detalle
                        ? `⚠ ${r.detalle}`
                        : r.como === 'link'
                            ? '✓ Enviado como link para abrir el archivo (la web todavía no manda adjuntos).'
                            : '✓ Archivo enviado.');
                }
                if (cuerpo) borradores.current.delete(waId);
            } else {
                const { mensaje } = await enviarWhatsappAMano(waId, cuerpo, desdePropuesta);
                borradores.current.delete(waId);
                if (selRef.current === waId) {
                    setMensajes((m) => [...m, mensaje]);
                    setTexto('');
                    setDesdePropuesta(null);
                    setPropuesta(null);
                }
            }
            abajoRef.current = true;
            await cargar();
        } catch (e) { setErrorEnvio((e as Error).message); }
        finally { setOcupado(null); }
    }

    // Abre un archivo que se mandó (pestaña nueva; si el navegador la bloquea, en esta).
    async function abrirAdjunto(id: string) {
        const ventana = window.open('', '_blank');
        try {
            const { url } = await urlAdjuntoWa(id);
            if (ventana) { ventana.opener = null; ventana.location.href = url; } else window.location.assign(url);
        } catch (e) { ventana?.close(); setErrorEnvio((e as Error).message); }
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
                        Conversaciones del bot de bartez.com.ar. Respondé desde acá: lo que escribís sale directo, Bartez te lo
                        redacta si querés y con 📎 mandás presupuestos y archivos. Se actualiza sola.
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

                            <div
                                className="wa-hilo" ref={hiloRef}
                                onScroll={(e) => { const h = e.currentTarget; abajoRef.current = h.scrollHeight - h.scrollTop - h.clientHeight < 120; }}
                            >
                                {mensajes.map((m) => (
                                    <div key={m.id} className={`wa-burbuja ${m.origen === 'cliente' ? 'entrante' : 'saliente'} ${m.origen}`}>
                                        <span className="wa-quien">{QUIEN[m.origen] ?? m.origen} · {hora(m.creado_en)}</span>
                                        {m.adjunto ? (
                                            <>
                                                <button type="button" className="wa-archivo" onClick={() => abrirAdjunto(m.adjunto!.id)} title="Abrir el archivo que se mandó">
                                                    <span aria-hidden="true">{m.adjunto.mime.startsWith('image/') ? '🖼' : '📄'}</span>
                                                    <span className="wa-archivo-nombre">{m.adjunto.nombre}</span>
                                                </button>
                                                {m.adjunto.texto && <span className="wa-archivo-texto">{m.adjunto.texto}</span>}
                                                {m.adjunto.como === 'link' && <span className="wa-archivo-como">Salió como link para abrirlo</span>}
                                            </>
                                        ) : m.cuerpo || <em>{m.tipo && SIN_TEXTO[m.tipo] ? `${SIN_TEXTO[m.tipo]} (no se puede ver acá)` : '(sin texto: audio, imagen o archivo)'}</em>}
                                    </div>
                                ))}
                            </div>

                            <div className={`wa-proponer ${verAdjuntar ? 'con-adjuntar' : ''}`}>
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
                                        {verAdjuntar && (
                                            <ElegirAdjunto
                                                key={actual.wa_id}
                                                waId={actual.wa_id}
                                                alElegir={(a) => { setAdjunto(a); setVerAdjuntar(false); cajaRef.current?.focus(); }}
                                                alCerrar={() => setVerAdjuntar(false)}
                                            />
                                        )}
                                        {adjunto && (
                                            <div className="wa-adjunto-elegido">
                                                <span aria-hidden="true">📎</span>
                                                <span className="wa-adjunto-nombre">{adjunto.etiqueta}</span>
                                                <button type="button" className="enlace" onClick={() => setAdjunto(null)} disabled={ocupado === 'enviar'} aria-label="Quitar el archivo">Quitar</button>
                                            </div>
                                        )}
                                        <textarea
                                            ref={cajaRef}
                                            rows={3}
                                            value={texto}
                                            aria-label="Tu respuesta"
                                            onChange={(e) => setTexto(e.target.value)}
                                            onKeyDown={(e) => {
                                                if (e.key === 'Enter' && !e.shiftKey && !esTactil() && !e.nativeEvent.isComposing) { e.preventDefault(); void enviar(); }
                                            }}
                                            placeholder={adjunto
                                                ? 'Escribí algo para acompañar el archivo (opcional)…'
                                                : 'Escribí tu respuesta… (o escribí la idea y tocá «Mejorar con Bartez»)'}
                                            disabled={ocupado === 'enviar'}
                                        />
                                        {errorEnvio && <p className="wa-error" role="alert">{errorEnvio}</p>}
                                        {avisoEnvio && !errorEnvio && <p className={`wa-aviso-envio ${avisoEnvio.startsWith('⚠') ? 'alerta' : ''}`} role="status">{avisoEnvio}</p>}
                                        <div className="wa-escribir-pie">
                                            <button
                                                type="button" className={`secundario wa-clip ${verAdjuntar ? 'on' : ''}`}
                                                onClick={() => setVerAdjuntar((v) => !v)} disabled={ocupado === 'enviar'}
                                                aria-expanded={verAdjuntar} aria-label="Adjuntar un presupuesto o un archivo" title="Mandar un presupuesto o un archivo"
                                            >
                                                <span aria-hidden="true">📎</span><span className="wa-clip-txt"> Adjuntar</span>
                                            </button>
                                            <button type="button" className="secundario" onClick={redactarConBartez} disabled={ocupado === 'borrador' || ocupado === 'enviar'}>
                                                {ocupado === 'borrador' ? 'Redactando…' : texto.trim() ? '✦ Mejorar con Bartez' : '✦ Redactar con Bartez'}
                                            </button>
                                            <span className="tenue wa-atajo">{esTactil() ? '' : 'Enter envía · Shift + Enter, otra línea'}</span>
                                            <button type="button" className="primario" onClick={enviar} disabled={(!texto.trim() && !adjunto) || ocupado === 'enviar'}>
                                                {ocupado === 'enviar' ? 'Enviando…' : adjunto ? 'Enviar archivo' : 'Enviar'}
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
