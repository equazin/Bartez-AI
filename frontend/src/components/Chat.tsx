import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { Sugerencia, cargarMensajes, enviarTarea, sugerenciasBartez } from '../api/client.ts';
import { EVENTO_PREGUNTAR, Pregunta } from '../lib/bartez.ts';
import emblema from '../assets/bartez-emblema.webp';

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

// Sugerencias que ya se cerraron en esta sesión (no vuelven a aparecer).
const CERRADAS_KEY = 'bartez.panel.sugerenciasCerradas';
function leerCerradas(): string[] {
    try { return JSON.parse(sessionStorage.getItem(CERRADAS_KEY) ?? '[]') as string[]; } catch { return []; }
}
function guardarCerradas(v: string[]) {
    try { sessionStorage.setItem(CERRADAS_KEY, JSON.stringify(v)); } catch { /* sin storage */ }
}

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
    // Sugerencias del botón flotante (vienen del mapa del negocio).
    const [ideas, setIdeas] = useState<Sugerencia[]>([]);
    const [cerradas, setCerradas] = useState<string[]>(leerCerradas);
    const [idx, setIdx] = useState(0);
    const enviarRef = useRef<(t?: string) => void>(() => {});

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

    // Sugerencias: al entrar y cada 5 minutos. Si falla, el botón queda sin globo.
    useEffect(() => {
        if (!barra) return;
        const traer = () => sugerenciasBartez().then((r) => setIdeas(Array.isArray(r?.sugerencias) ? r.sugerencias : [])).catch(() => {});
        traer();
        const t = setInterval(traer, 5 * 60_000);
        return () => clearInterval(t);
    }, [barra]);
    const vivas = ideas.filter((x) => !cerradas.includes(x.texto));
    // El globo va rotando entre las sugerencias abiertas.
    useEffect(() => {
        if (!barra || abierto || vivas.length < 2) return;
        const t = setInterval(() => setIdx((i) => i + 1), 9000);
        return () => clearInterval(t);
    }, [barra, abierto, vivas.length]);
    const idea = vivas.length ? vivas[idx % vivas.length] : undefined;
    const cerrarIdea = (texto: string) => {
        const v = [...cerradas, texto];
        setCerradas(v);
        guardarCerradas(v);
    };

    // Otras pantallas abren Bartez AI con un pedido (ver lib/bartez.ts).
    useEffect(() => {
        if (!barra) return;
        const alPreguntar = (e: Event) => {
            const { texto, enviar: mandar } = (e as CustomEvent<Pregunta>).detail;
            setAbierto(true);
            if (mandar) enviarRef.current(texto);
            else { setEntrada(texto); setTimeout(() => entradaRef.current?.focus(), 30); }
        };
        window.addEventListener(EVENTO_PREGUNTAR, alPreguntar);
        return () => window.removeEventListener(EVENTO_PREGUNTAR, alPreguntar);
    }, [barra]);

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
            if (abierto && cajaRef.current && !cajaRef.current.contains(e.target as Node) && !(e.target as Element).closest?.('[data-abre-bartez]')) setAbierto(false);
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

    enviarRef.current = enviar;

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
                <div className="bartez-fab-zona">
                    {idea && (
                        <div className="bartez-globo" role="status" key={idea.texto}>
                            <button className="bartez-globo-texto" data-abre-bartez onClick={() => { setAbierto(true); setEntrada(idea.pedido); setTimeout(() => entradaRef.current?.focus(), 30); }}>
                                <span className="bartez-globo-etq">Bartez AI sugiere{vivas.length > 1 ? ` · ${(idx % vivas.length) + 1} de ${vivas.length}` : ''}</span>
                                {idea.texto}
                            </button>
                            <button className="bartez-globo-cerrar" onClick={() => cerrarIdea(idea.texto)} aria-label="Descartar esta sugerencia">×</button>
                        </div>
                    )}
                    <button className={`bartez-fab ${cargando ? 'pensando' : ''}`} data-abre-bartez onClick={() => setAbierto(true)} aria-label="Hablar con Bartez AI" title="Hablar con Bartez AI (Ctrl+K)">
                        <img className="bartez-orbe" src={emblema} alt="" aria-hidden="true" />
                        {cargando && <span className="chat-fab-punto" aria-label="respondiendo" />}
                        {!cargando && vivas.length > 0 && <span className="bartez-fab-cuenta" aria-label={`${vivas.length} sugerencias`}>{vivas.length}</span>}
                    </button>
                </div>
            );
        }
        return (
            <section ref={cajaRef} className="chat chat-flotante" role="dialog" aria-label="Chat con Bartez AI">
                <div className="barra-cab">
                    <strong className="barra-cab-titulo"><img className="bartez-orbe chico" src={emblema} alt="" aria-hidden="true" />Bartez AI</strong>
                    <span className="barra-cab-acciones">
                        {historial.length > 0 && <button className="enlace" onClick={nuevaConversacion} disabled={cargando}>Nueva</button>}
                        {alAbrirChat && <button className="enlace" onClick={() => { setAbierto(false); alAbrirChat(); }} title="Abrir en pantalla completa">Ampliar</button>}
                        <button className="barra-cerrar" onClick={() => setAbierto(false)} aria-label="Cerrar el chat">✕</button>
                    </span>
                </div>
                <div className="chat-flotante-cuerpo">
                    {historial.length === 0 && !cargando ? (
                        <div className="chat-bienvenida">
                            <img className="bartez-orbe grande" src={emblema} alt="" aria-hidden="true" />
                            <strong>¿En qué te ayudo?</strong>
                            {vivas.length > 0 && (
                                <ul className="chat-ideas">
                                    {vivas.map((x) => <li key={x.texto}><button onClick={() => enviar(x.pedido)}>{x.texto}</button></li>)}
                                </ul>
                            )}
                            {sugerencias}
                        </div>
                    ) : hilo(historial)}
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
