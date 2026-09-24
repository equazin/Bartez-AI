import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { cargarMensajes, enviarTarea } from '../api/client.ts';

interface Mensaje {
    rol: 'usuario' | 'sistema';
    texto: string;
}

const CONV_KEY = 'bartez.panel.conversacionId';

export function Chat() {
    const [historial, setHistorial] = useState<Mensaje[]>([]);
    const [entrada, setEntrada] = useState('');
    const [cargando, setCargando] = useState(false);
    const [conversacionId, setConversacionId] = useState<string | null>(() => {
        try {
            return localStorage.getItem(CONV_KEY);
        } catch {
            return null;
        }
    });

    // Al montar, si hay conversación previa, cargar sus mensajes desde la DB.
    useEffect(() => {
        if (!conversacionId) return;
        cargarMensajes(conversacionId)
            .then((msgs) => {
                setHistorial(
                    msgs.map((m) => ({
                        rol: m.remitente === 'asistente' ? 'sistema' : 'usuario',
                        texto: m.texto,
                    })),
                );
            })
            .catch(() => {
                // Si la conversación no existe más, empezar limpio.
                localStorage.removeItem(CONV_KEY);
                setConversacionId(null);
            });
    }, [conversacionId]);

    async function enviar() {
        if (!entrada.trim() || cargando) return;
        const texto = entrada;
        setHistorial((h) => [...h, { rol: 'usuario', texto }]);
        setEntrada('');
        setCargando(true);
        try {
            const { resultado } = await enviarTarea({
                canal: 'panel',
                texto,
                conversacionId: conversacionId ?? undefined,
            });
            if (resultado.conversacionId && resultado.conversacionId !== conversacionId) {
                setConversacionId(resultado.conversacionId);
                try {
                    localStorage.setItem(CONV_KEY, resultado.conversacionId);
                } catch {
                    /* localStorage no disponible: seguimos en memoria */
                }
            }
            setHistorial((h) => [
                ...h,
                { rol: 'sistema', texto: resultado.respuesta ?? '(sin respuesta)' },
            ]);
        } catch (err) {
            setHistorial((h) => [
                ...h,
                { rol: 'sistema', texto: `Error: ${(err as Error).message}` },
            ]);
        } finally {
            setCargando(false);
        }
    }

    function nuevaConversacion() {
        if (!confirm('¿Empezar una conversación nueva? La actual se conserva en el historial.')) return;
        setHistorial([]);
        setConversacionId(null);
        try {
            localStorage.removeItem(CONV_KEY);
        } catch {
            /* ignore */
        }
    }

    return (
        <section className="chat">
            <div className="chat-toolbar">
                <button className="secundario" onClick={nuevaConversacion} disabled={cargando}>
                    Nueva conversación
                </button>
            </div>
            <div className="historial">
                {historial.length === 0 && (
                    <p className="vacio">Escribí un pedido y el orquestador lo deriva al asistente correspondiente.</p>
                )}
                {historial.map((m, i) => (
                    <div key={i} className={`mensaje ${m.rol}`}>
                        <span className="rol">{m.rol === 'usuario' ? 'Vos' : 'Bartez AI'}:</span>
                        {m.rol === 'sistema' ? (
                            <div className="cuerpo-md">
                                <ReactMarkdown>{m.texto}</ReactMarkdown>
                            </div>
                        ) : (
                            <p>{m.texto}</p>
                        )}
                    </div>
                ))}
                {cargando && <div className="mensaje sistema">…procesando</div>}
            </div>
            <div className="entrada">
                <textarea
                    value={entrada}
                    onChange={(e) => setEntrada(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) enviar();
                    }}
                    placeholder="Escribí lo que necesitás. Cmd/Ctrl+Enter para enviar."
                />
                <button className="btn-primario" onClick={enviar} disabled={cargando}>
                    Enviar
                </button>
            </div>
        </section>
    );
}
