import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { cargarMensajes, enviarTarea } from '../api/client.ts';

interface Mensaje {
    rol: 'usuario' | 'sistema';
    texto: string;
}

// La misma conversación se ve en el Inicio y en la pantalla Chat.
const CONV_KEY = 'bartez.panel.conversacionId';
const EVENTO_CHAT = 'bartez:chat';

const SUGERENCIAS = [
    '¿Qué tengo pendiente hoy?',
    'Cotizame 10 notebooks i5 16 GB y 10 monitores de 24"',
    '¿Qué hablamos con…?',
    'Buscá prospectos: estudios contables en Rosario',
];

function leerConv(): string | null {
    try { return localStorage.getItem(CONV_KEY); } catch { return null; }
}
function guardarConv(id: string | null) {
    try {
        if (id) localStorage.setItem(CONV_KEY, id);
        else localStorage.removeItem(CONV_KEY);
    } catch { /* sin storage: seguimos en memoria */ }
}

export function Chat({ modo = 'pagina', alAbrirChat }: { modo?: 'pagina' | 'barra'; alAbrirChat?: () => void }) {
    const barra = modo === 'barra';
    const [historial, setHistorial] = useState<Mensaje[]>([]);
    const [entrada, setEntrada] = useState('');
    const [cargando, setCargando] = useState(false);
    const [conversacionId, setConversacionId] = useState<string | null>(leerConv);
    // En modo barra el panel con el hilo solo se despliega cuando se usa.
    const [abierto, setAbierto] = useState(false);
    const cajaRef = useRef<HTMLElement>(null);
    const finRef = useRef<HTMLDivElement>(null);
    const entradaRef = useRef<HTMLTextAreaElement>(null);

    // Cargar la conversación guardada (y recargarla si cambia en otra pantalla).
    useEffect(() => {
        if (!conversacionId) { setHistorial([]); return; }
        cargarMensajes(conversacionId)
            .then((msgs) => setHistorial(msgs.map((m) => ({ rol: m.remitente === 'asistente' ? 'sistema' : 'usuario', texto: m.texto }))))
            .catch(() => { guardarConv(null); setConversacionId(null); });
    }, [conversacionId]);

    useEffect(() => {
        const alCambiar = () => setConversacionId(leerConv());
        window.addEventListener(EVENTO_CHAT, alCambiar);
        return () => window.removeEventListener(EVENTO_CHAT, alCambiar);
    }, []);

    useEffect(() => {
        const caja = finRef.current?.parentElement;
        if (caja) caja.scrollTop = caja.scrollHeight;
    }, [historial, cargando, abierto]);

    // Al abrir el chat flotante, el cursor queda listo para escribir.
    useEffect(() => { if (barra && abierto) entradaRef.current?.focus(); }, [barra, abierto]);

    // Barra: Ctrl/Cmd+K abre, Esc o un clic afuera la cierran.
    useEffect(() => {
        if (!barra) return;
        const tecla = (e: KeyboardEvent) => {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
                e.preventDefault();
                setAbierto((v) => !v);
            } else if (e.key === 'Escape' && abierto) {
                setAbierto(false);
                entradaRef.current?.blur();
            }
        };
        const fuera = (e: MouseEvent) => {
            if (abierto && cajaRef.current && !cajaRef.current.contains(e.target as Node)) setAbierto(false);
        };
        window.addEventListener('keydown', tecla);
        document.addEventListener('mousedown', fuera);
        return () => { window.removeEventListener('keydown', tecla); document.removeEventListener('mousedown', fuera); };
    }, [barra, abierto]);

    async function enviar(textoForzado?: string) {
        const texto = (textoForzado ?? entrada).trim();
        if (!texto || cargando) return;
        setAbierto(true);
        setHistorial((h) => [...h, { rol: 'usuario', texto }]);
        setEntrada('');
        setCargando(true);
        try {
            const { resultado } = await enviarTarea({ canal: 'panel', texto, conversacionId: conversacionId ?? undefined });
            if (resultado.conversacionId && resultado.conversacionId !== conversacionId) {
                guardarConv(resultado.conversacionId);
                setConversacionId(resultado.conversacionId);
                window.dispatchEvent(new Event(EVENTO_CHAT));
            }
            setHistorial((h) => [...h, { rol: 'sistema', texto: resultado.respuesta ?? '(sin respuesta)' }]);
        } catch (err) {
            setHistorial((h) => [...h, { rol: 'sistema', texto: `No se pudo responder: ${(err as Error).message}` }]);
        } finally {
            setCargando(false);
            entradaRef.current?.focus();
        }
    }

    function nuevaConversacion() {
        if (historial.length > 0 && !confirm('¿Empezar una conversación nueva? La actual queda guardada en la Bitácora.')) return;
        setHistorial([]);
        guardarConv(null);
        setConversacionId(null);
        window.dispatchEvent(new Event(EVENTO_CHAT));
    }

    const sugerencias = (
        <div className="sugerencias">
            {SUGERENCIAS.map((s) => (
                <button
                    key={s}
                    className="sugerencia"
                    onClick={() => {
                        if (s.endsWith('…?')) {
                            setEntrada(s.replace('…?', ' '));
                            entradaRef.current?.focus();
                        } else {
                            enviar(s);
                        }
                    }}
                >
                    {s}
                </button>
            ))}
        </div>
    );

    const hilo = (visibles: Mensaje[]) => (
        <div className="historial">
            {visibles.map((m, i) => (
                <div key={i} className={`mensaje ${m.rol}`}>
                    {m.rol === 'sistema' ? (
                        <div className="cuerpo-md"><ReactMarkdown>{m.texto}</ReactMarkdown></div>
                    ) : (
                        <p>{m.texto}</p>
                    )}
                </div>
            ))}
            {cargando && <div className="mensaje sistema pensando">Buscando en el sistema…</div>}
            <div ref={finRef} />
        </div>
    );

    const campo = (
        <div className="entrada">
            <textarea
                ref={entradaRef}
                rows={barra ? 1 : 3}
                value={entrada}
                onChange={(e) => setEntrada(e.target.value)}
                onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); enviar(); }
                }}
                placeholder={barra ? 'Pedile algo a Bartez AI…' : 'Escribí tu pedido. Enter envía, Shift+Enter hace un salto de línea.'}
                aria-label="Mensaje para Bartez AI"
            />
            <button className="btn-primario" onClick={() => enviar()} disabled={cargando || !entrada.trim()}>
                {cargando ? '…' : 'Enviar'}
            </button>
        </div>
    );

    // Chat flotante: un botón chico abajo a la derecha que abre el chat encima
    // de cualquier pantalla (Ctrl+K), sin ocupar lugar cuando no se usa.
    if (barra) {
        if (!abierto) {
            return (
                <button className="chat-fab" onClick={() => setAbierto(true)} aria-label="Abrir el chat de Bartez AI" title="Preguntale algo a Bartez AI (Ctrl+K)">
                    <span className="chat-fab-icono" aria-hidden="true">✦</span>
                    <span className="chat-fab-texto">Preguntar</span>
                    <kbd className="chat-fab-atajo" aria-hidden="true">Ctrl K</kbd>
                    {cargando && <span className="chat-fab-punto" aria-label="respondiendo" />}
                </button>
            );
        }
        return (
            <section ref={cajaRef} className="chat chat-flotante" role="dialog" aria-label="Chat con Bartez AI">
                <div className="barra-cab">
                    <strong>Bartez AI</strong>
                    <span className="barra-cab-acciones">
                        {historial.length > 0 && <button className="enlace" onClick={nuevaConversacion} disabled={cargando}>Nueva</button>}
                        {alAbrirChat && <button className="enlace" onClick={() => { setAbierto(false); alAbrirChat(); }} title="Abrir en pantalla completa">Ampliar</button>}
                        <button className="barra-cerrar" onClick={() => setAbierto(false)} aria-label="Cerrar el chat">✕</button>
                    </span>
                </div>
                <div className="chat-flotante-cuerpo">
                    {historial.length === 0 && !cargando ? sugerencias : hilo(historial)}
                </div>
                {campo}
            </section>
        );
    }

    return (
        <section className="chat-pagina">
            <div className="acciones-header">
                <div>
                    <h2>Chat</h2>
                    <p className="sub">Preguntá por el negocio o pedí algo: cotizar, buscar un cliente, ver pendientes, redactar un correo o prospectar.</p>
                </div>
                <button className="secundario" onClick={nuevaConversacion} disabled={cargando}>Nueva conversación</button>
            </div>
            <div className="chat panel">
                {(historial.length > 0 || cargando) ? hilo(historial) : (
                    <div className="chat-inicio">
                        <strong>¿En qué te ayudo?</strong>
                        {sugerencias}
                    </div>
                )}
                {campo}
            </div>
        </section>
    );
}
