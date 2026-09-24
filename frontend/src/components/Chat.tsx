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

export function Chat({ compacto = false, alAbrirChat }: { compacto?: boolean; alAbrirChat?: () => void }) {
    const [historial, setHistorial] = useState<Mensaje[]>([]);
    const [entrada, setEntrada] = useState('');
    const [cargando, setCargando] = useState(false);
    const [conversacionId, setConversacionId] = useState<string | null>(leerConv);
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
    }, [historial, cargando]);

    async function enviar(textoForzado?: string) {
        const texto = (textoForzado ?? entrada).trim();
        if (!texto || cargando) return;
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

    // En el Inicio se muestran los últimos mensajes; el hilo completo, en Chat.
    const visibles = compacto ? historial.slice(-6) : historial;

    return (
        <section className={compacto ? 'chat chat-compacto' : 'chat'}>
            {!compacto && (
                <div className="chat-cabeza">
                    <div>
                        <h2>Chat</h2>
                        <p className="sub">Preguntá por el negocio o pedí algo: cotizar, buscar un cliente, ver pendientes, redactar un correo o prospectar.</p>
                    </div>
                    <button className="secundario" onClick={nuevaConversacion} disabled={cargando}>Nueva conversación</button>
                </div>
            )}

            {(visibles.length > 0 || cargando) && (
                <div className="historial">
                    {compacto && historial.length > visibles.length && (
                        <button className="enlace chat-mas" onClick={alAbrirChat}>Ver los {historial.length - visibles.length} mensajes anteriores en Chat →</button>
                    )}
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
            )}

            {historial.length === 0 && !cargando && (
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
            )}

            <div className="entrada">
                <textarea
                    ref={entradaRef}
                    rows={compacto ? 1 : 3}
                    value={entrada}
                    onChange={(e) => setEntrada(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); enviar(); }
                    }}
                    placeholder={compacto ? 'Pedile algo a Bartez AI…' : 'Escribí tu pedido. Enter envía, Shift+Enter hace un salto de línea.'}
                    aria-label="Mensaje para Bartez AI"
                />
                <button className="btn-primario" onClick={() => enviar()} disabled={cargando || !entrada.trim()}>
                    {cargando ? '…' : 'Enviar'}
                </button>
            </div>

            {compacto && historial.length > 0 && (
                <div className="chat-pie">
                    <button className="enlace" onClick={nuevaConversacion} disabled={cargando}>Nueva conversación</button>
                    {alAbrirChat && <button className="enlace" onClick={alAbrirChat}>Abrir en Chat →</button>}
                </div>
            )}
        </section>
    );
}
