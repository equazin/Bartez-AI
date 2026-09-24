import { useEffect, useState } from 'react';
import { EstadoNotionAutonomo, actualizarTableroNotion, estadoNotionAutonomo, organizarNotion } from '../api/client.ts';

const fecha = (iso: string | null | undefined) =>
    iso ? new Date(iso).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : 'nunca';

const TIPOS: Record<string, string> = {
    crear_tarea: 'Tarea nueva',
    actualizar_tarea: 'Tarea',
    crear_nota: 'Nota',
    archivar: 'Archivado',
    limpiar_pagina: 'Limpieza',
    ordenar_pagina: 'Página',
};

export function NotionPanel() {
    const [estado, setEstado] = useState<EstadoNotionAutonomo | null>(null);
    const [instruccion, setInstruccion] = useState('');
    const [ocupado, setOcupado] = useState<'curar' | 'tablero' | null>(null);
    const [error, setError] = useState<string>();
    const [aviso, setAviso] = useState<string>();

    async function cargar() {
        try { setEstado(await estadoNotionAutonomo()); } catch (e) { setError((e as Error).message); }
    }
    useEffect(() => { cargar(); }, []);

    async function curar() {
        setOcupado('curar');
        setError(undefined);
        setAviso(undefined);
        try {
            const { resultado: r } = await organizarNotion(instruccion.trim() || undefined);
            if (!r.ok) throw new Error(r.detalle ?? 'No se pudo actualizar Notion');
            setAviso(`✓ ${r.resumen} · ${r.cambios} cambios · USD ${r.costo_usd.toFixed(3)} · ${Math.round(r.duracion_ms / 1000)} s`);
            setInstruccion('');
            await cargar();
        } catch (e) { setError((e as Error).message); }
        finally { setOcupado(null); }
    }

    async function tablero() {
        setOcupado('tablero');
        setError(undefined);
        try {
            const { resultado: r } = await actualizarTableroNotion();
            if (!r.ok) throw new Error(r.detalle ?? 'No se pudo actualizar el tablero');
            setAviso('✓ Tablero actualizado con los datos de ahora.');
            await cargar();
        } catch (e) { setError((e as Error).message); }
        finally { setOcupado(null); }
    }

    if (estado && !estado.configurado) {
        return (
            <section className="notion-panel">
                <h2>Notion</h2>
                <div className="det-signal">Notion no está conectado: faltan <code>NOTION_TOKEN</code> y <code>NOTION_PARENT_PAGE_ID</code> en <code>backend/.env</code>.</div>
            </section>
        );
    }

    return (
        <section className="notion-panel">
            <div className="analitica-top">
                <div>
                    <h2>Notion</h2>
                    <p className="sub">
                        El asistente mantiene Notion ordenado solo: con lo que generan los demás asistentes crea, actualiza, completa y
                        archiva tareas y notas y define las prioridades del día. La <strong>página principal de Bartez AI en Notion es el Tablero</strong>:
                        se reescribe cada 30 minutos (7 a 21 h) con datos exactos (las bases de datos y subpáginas no se tocan); el análisis
                        con IA corre a las 8:30, 13 y 18 h.
                    </p>
                </div>
                {estado?.tablero_url && (
                    <a className="primario-link" href={estado.tablero_url} target="_blank" rel="noreferrer">Abrir Tablero en Notion ↗</a>
                )}
            </div>

            {error && <p className="error">Error: {error}</p>}
            {aviso && <div className="msg-ok">{aviso}</div>}

            <div className="notion-grid">
                <div className="notion-card">
                    <h4>Estado</h4>
                    <div className="notion-dato"><span>Tablero actualizado</span><strong>{fecha(estado?.tablero_actualizado)}</strong></div>
                    <div className="notion-dato"><span>Último análisis del asistente</span><strong>{fecha(estado?.curador?.fecha)}</strong></div>
                    {estado?.curador?.resumen && <p className="notion-resumen">{estado.curador.resumen}</p>}
                    <button className="secundario" onClick={tablero} disabled={ocupado !== null}>
                        {ocupado === 'tablero' ? 'Actualizando…' : 'Actualizar solo el tablero'}
                    </button>
                </div>

                <div className="notion-card">
                    <h4>Prioridades {estado?.prioridades ? <span className="mono">· {fecha(estado.prioridades.fecha)}</span> : null}</h4>
                    {!estado?.prioridades?.items?.length && <p className="sub">Todavía no hay prioridades.</p>}
                    <ol className="notion-prioridades">
                        {estado?.prioridades?.items.map((p, i) => (
                            <li key={i}><strong>{p.texto}</strong>{p.por_que && <span className="sub"> — {p.por_que}</span>}</li>
                        ))}
                    </ol>
                </div>
            </div>

            <div className="notion-card">
                <h4>Pedirle algo al asistente</h4>
                <textarea
                    rows={2}
                    value={instruccion}
                    onChange={(e) => setInstruccion(e.target.value)}
                    placeholder="Opcional. Ej: «armá tareas para llamar a todos los leads con ICP 8 o más» o «cerrá las tareas de Acme, ya compró». Si lo dejás vacío, revisa todo y ordena lo que haga falta."
                />
                <button className="primario" onClick={curar} disabled={ocupado !== null}>
                    {ocupado === 'curar' ? 'Trabajando en Notion… (puede tardar 1-2 min)' : 'Revisar y ordenar Notion ahora'}
                </button>
            </div>

            <h4 className="section-h">Registro de cambios del asistente</h4>
            {(estado?.cambios.length ?? 0) === 0 && <p className="sub">Todavía no hizo cambios.</p>}
            <div className="notion-cambios">
                {estado?.cambios.map((c, i) => (
                    <div key={i} className="notion-cambio">
                        <span className="mono">{fecha(c.creado_en)}</span>
                        <span className={`notion-tipo t-${c.tipo}`}>{TIPOS[c.tipo] ?? c.tipo}</span>
                        <span className="notion-detalle">{c.detalle}</span>
                        {c.url && <a href={c.url} target="_blank" rel="noreferrer">ver ↗</a>}
                    </div>
                ))}
            </div>
        </section>
    );
}
