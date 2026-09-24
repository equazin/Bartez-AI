import { useEffect, useState } from 'react';
import {
    correrAnaliticaAhora,
    InformeAnalitica,
    listarInformesAnalitica,
    obtenerInformeAnalitica,
} from '../api/client.ts';

// Acepta "2026-09-17" o un ISO completo y lo muestra como "17 sept".
function fechaCorta(s: string): string {
    const d = new Date(s.length === 10 ? `${s}T12:00:00-03:00` : s);
    return Number.isNaN(d.getTime()) ? s : d.toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', day: 'numeric', month: 'short' });
}

export function Analitica() {
    const [informes, setInformes] = useState<InformeAnalitica[]>([]);
    const [seleccionado, setSeleccionado] = useState<InformeAnalitica | null>(null);
    const [error, setError] = useState<string>();
    const [cargando, setCargando] = useState(false);
    const [corriendo, setCorriendo] = useState(false);

    async function cargar() {
        try {
            setError(undefined);
            const { informes } = await listarInformesAnalitica();
            setInformes(informes);
        } catch (e) {
            setError((e as Error).message);
        }
    }

    useEffect(() => { cargar(); }, []);

    async function abrir(id: string) {
        setCargando(true);
        try {
            const { informe } = await obtenerInformeAnalitica(id);
            setSeleccionado(informe);
        } catch (e) { setError((e as Error).message); }
        finally { setCargando(false); }
    }

    async function correrAhora() {
        setCorriendo(true);
        setError(undefined);
        try {
            const { resultado } = await correrAnaliticaAhora(7);
            await cargar();
            if (resultado.id) await abrir(resultado.id);
        } catch (e) { setError((e as Error).message); }
        finally { setCorriendo(false); }
    }

    return (
        <section className="analitica">
            <div className="analitica-top">
                <div>
                    <h2>Analítica</h2>
                    <p className="sub">
                        Informe semanal automático — lunes 08:00 AR. Diagnóstico + hasta 3 propuestas de ajuste.
                    </p>
                </div>
                <button className="primario" onClick={correrAhora} disabled={corriendo}>
                    {corriendo ? 'Generando informe (30-60s)…' : 'Correr ahora'}
                </button>
            </div>

            {error && <p className="error">Error: {error}</p>}

            <div className="analitica-layout">
                <aside className="analitica-lista">
                    <h4>Últimos informes</h4>
                    {informes.length === 0 ? (
                        <p className="vacio-mini">
                            Todavía no hay informes. Correlo a mano o esperá al lunes.
                        </p>
                    ) : (
                        informes.map((i) => (
                            <div
                                key={i.id}
                                className={`analitica-item ${seleccionado?.id === i.id ? 'on' : ''}`}
                                onClick={() => abrir(i.id)}
                            >
                                <div className="rango">{fechaCorta(i.periodo_desde)} → {fechaCorta(i.periodo_hasta)}</div>
                                <div className="chips">
                                    <span className="chip-info">{i.propuestas.length} propuestas</span>
                                    <span className="chip-info">USD {Number(i.costo_usd).toFixed(4)}</span>
                                    {i.email_enviado && <span className="chip-ok">📧 email</span>}
                                    {i.notion_page_id && <span className="chip-ok">📄 notion</span>}
                                </div>
                            </div>
                        ))
                    )}
                </aside>

                <main className="analitica-detalle">
                    {cargando && <p className="vacio">Cargando informe…</p>}
                    {!seleccionado && !cargando && (
                        <p className="vacio">Elegí un informe de la izquierda o correlo ahora.</p>
                    )}
                    {seleccionado && (
                        <>
                            <div className="detalle-head">
                                <h3>Semana del {fechaCorta(seleccionado.periodo_desde)} al {fechaCorta(seleccionado.periodo_hasta)}</h3>
                                <div className="meta">
                                    Costo del informe: USD {Number(seleccionado.costo_usd).toFixed(4)}
                                    {seleccionado.notion_page_id && (
                                        <> · <a
                                            href={`https://www.notion.so/${seleccionado.notion_page_id.replace(/-/g, '')}`}
                                            target="_blank" rel="noreferrer"
                                        >Ver en Notion</a></>
                                    )}
                                </div>
                            </div>

                            <div className="markdown-simple">
                                {formatearMarkdown(seleccionado.resumen_md)}
                            </div>

                            {seleccionado.propuestas.length > 0 && (
                                <div className="propuestas">
                                    <h4>Propuestas de ajuste</h4>
                                    {seleccionado.propuestas.map((p, i) => (
                                        <div key={i} className={`propuesta tipo-${p.tipo}`}>
                                            <div className="ph">
                                                <span className="tipo">{p.tipo.replace('_', ' ')}</span>
                                                {p.asistente && <span className="asist">· {p.asistente}</span>}
                                            </div>
                                            <div className="titulo">{p.titulo}</div>
                                            <div className="razon"><strong>Por qué:</strong> {p.razon}</div>
                                            <div className="accion"><strong>Sugerido:</strong> {p.accion_sugerida}</div>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </>
                    )}
                </main>
            </div>
        </section>
    );
}

// Render mínimo de markdown: headings y bullets. No es completo pero cubre el
// output esperado del asistente (# ## - texto).
function formatearMarkdown(md: string): React.ReactNode {
    const lineas = md.split('\n');
    const out: React.ReactNode[] = [];
    let bullets: string[] = [];
    const flushBullets = (key: string) => {
        if (bullets.length > 0) {
            out.push(<ul key={key}>{bullets.map((b, i) => <li key={i}>{b}</li>)}</ul>);
            bullets = [];
        }
    };
    lineas.forEach((raw, i) => {
        const l = raw.trim();
        if (!l) { flushBullets(`u${i}`); return; }
        if (l.startsWith('# ')) { flushBullets(`u${i}`); out.push(<h2 key={i}>{l.slice(2)}</h2>); return; }
        if (l.startsWith('## ')) { flushBullets(`u${i}`); out.push(<h3 key={i}>{l.slice(3)}</h3>); return; }
        if (l.startsWith('### ')) { flushBullets(`u${i}`); out.push(<h4 key={i}>{l.slice(4)}</h4>); return; }
        if (l.startsWith('- ') || l.startsWith('* ')) { bullets.push(l.slice(2)); return; }
        flushBullets(`u${i}`);
        out.push(<p key={i}>{l}</p>);
    });
    flushBullets('final');
    return <>{out}</>;
}
