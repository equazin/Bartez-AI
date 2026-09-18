import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { enviarTarea } from '../api/client.ts';

interface Mensaje {
    rol: 'usuario' | 'sistema';
    texto: string;
}

export function Chat() {
    const [historial, setHistorial] = useState<Mensaje[]>([]);
    const [entrada, setEntrada] = useState('');
    const [cargando, setCargando] = useState(false);

    async function enviar() {
        if (!entrada.trim() || cargando) return;
        const texto = entrada;
        setHistorial((h) => [...h, { rol: 'usuario', texto }]);
        setEntrada('');
        setCargando(true);
        try {
            const { resultado } = await enviarTarea({ canal: 'panel', texto });
            const respuesta =
                (resultado as { respuesta?: string })?.respuesta ?? '(sin respuesta)';
            setHistorial((h) => [...h, { rol: 'sistema', texto: respuesta }]);
        } catch (err) {
            setHistorial((h) => [
                ...h,
                { rol: 'sistema', texto: `Error: ${(err as Error).message}` },
            ]);
        } finally {
            setCargando(false);
        }
    }

    return (
        <section className="chat">
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
                <button onClick={enviar} disabled={cargando}>
                    Enviar
                </button>
            </div>
        </section>
    );
}
