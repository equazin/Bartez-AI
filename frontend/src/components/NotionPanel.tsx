import { useEffect, useState } from 'react';
import { EstadoNotionAutonomo, actualizarTableroNotion, estadoNotionAutonomo, organizarNotion } from '../api/client.ts';

const fecha = (iso: string | null | undefined) =>
    iso ? new Date(iso).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : 'nunca';

const TIPOS: Record<string, { etq: string; tono: string }> = {
    crear_tarea: { etq: 'Tarea nueva', tono: 'nuevo' },
    actualizar_tarea: { etq: 'Tarea', tono: 'cambio' },
    crear_nota: { etq: 'Nota nueva', tono: 'nuevo' },
    archivar: { etq: 'Archivado', tono: 'fin' },
    limpiar_pagina: { etq: 'Limpieza', tono: 'fin' },
    ordenar_pagina: { etq: 'Página', tono: 'cambio' },
};

const TZ = 'America/Argentina/Buenos_Aires';
const hora = (iso: string) => new Date(iso).toLocaleTimeString('es-AR', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const diaDe = (iso: string) => new Date(iso).toLocaleDateString('en-CA', { timeZone: TZ });

function hace(iso: string | null | undefined): string {
    if (!iso) return 'nunca';
    const min = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
    if (min < 1) return 'recién';
    if (min < 60) return `hace ${min} min`;
    const h = Math.floor(min / 60);
    if (h < 24) return `hace ${h} h`;
    return fecha(iso);
}

// El análisis con IA corre a las 8:30 (lun a sáb), 13 y 18 h (lun a vie).
function proximoAnalisis(): string {
    const ahora = new Date(new Date().toLocaleString('en-US', { timeZone: TZ }));
    for (let d = 0; d < 8; d++) {
        const dia = new Date(ahora); dia.setDate(ahora.getDate() + d);
        const dow = dia.getDay();
        const horarios: Array<[number, number]> = [];
        if (dow >= 1 && dow <= 6) horarios.push([8, 30]);
        if (dow >= 1 && dow <= 5) horarios.push([13, 0], [18, 0]);
        for (const [h, m] of horarios) {
            const t = new Date(dia); t.setHours(h, m, 0, 0);
            if (t > ahora) {
                const cuando = d === 0 ? 'hoy' : d === 1 ? 'mañana' : t.toLocaleDateString('es-AR', { weekday: 'long' });
                return `${cuando} ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
            }
        }
    }
    return '—';
}

const SUGERENCIAS_NOTION = [
    'Armá tareas para llamar a los leads con ICP 8 o más',
    'Cerrá las tareas de clientes que ya compraron',
    'Ordená las tareas vencidas por prioridad',
];

function tituloDia(d: string): string {
    const hoy = diaDe(new Date().toISOString());
    const ayer = diaDe(new Date(Date.now() - 86_400_000).toISOString());
    if (d === hoy) return 'Hoy';
    if (d === ayer) return 'Ayer';
    return new Date(`${d}T12:00:00-03:00`).toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' });
}

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

    const cambios = estado?.cambios ?? [];
    const semana = Date.now() - 7 * 86_400_000;
    const cambios7 = cambios.filter((c) => new Date(c.creado_en).getTime() >= semana).length;
    const porDia: Array<[string, typeof cambios]> = [];
    for (const c of cambios) {
        const d = diaDe(c.creado_en);
        const g = porDia.find(([k]) => k === d);
        if (g) g[1].push(c); else porDia.push([d, [c]]);
    }

    return (
        <section className="notion-panel">
            <div className="acciones-header">
                <div>
                    <h2>Notion</h2>
                    <p className="sub">El asistente mantiene Notion ordenado solo con lo que generan los demás, y la página principal de Bartez AI es el Tablero.</p>
                </div>
                <div className="notion-cab-der">
                    <button className="secundario" onClick={tablero} disabled={ocupado !== null}>
                        {ocupado === 'tablero' ? 'Actualizando…' : 'Actualizar tablero'}
                    </button>
                    {estado?.tablero_url && (
                        <a className="btn-primario notion-abrir" href={estado.tablero_url} target="_blank" rel="noreferrer">Abrir Tablero ↗</a>
                    )}
                </div>
            </div>

            <details className="notion-como">
                <summary>Cómo funciona</summary>
                <p>
                    Con lo que generan los demás asistentes, crea, actualiza, completa y archiva tareas y notas, y define las prioridades del día.
                    El <strong>Tablero</strong> (la página principal de Bartez AI en Notion) se reescribe cada 30 minutos, de 7 a 21 h, con datos exactos;
                    las bases de datos y subpáginas no se tocan. El análisis con IA corre a las 8:30, 13 y 18 h, y puede hacer hasta 20 cambios por vez.
                </p>
            </details>

            {error && <p className="error">Error: {error}</p>}
            {aviso && <div className="msg-ok">{aviso}</div>}

            <div className="notion-estado">
                <div><span className="kpi-etq">Tablero</span><strong>{hace(estado?.tablero_actualizado)}</strong><span className="tenue">se rehace cada 30 min</span></div>
                <div><span className="kpi-etq">Último análisis</span><strong>{hace(estado?.curador?.fecha)}</strong><span className="tenue">{estado?.curador ? `${estado.curador.cambios} cambios` : 'todavía no corrió'}</span></div>
                <div><span className="kpi-etq">Cambios · 7 días</span><strong>{cambios7}</strong><span className="tenue">del asistente</span></div>
                <div><span className="kpi-etq">Próximo análisis</span><strong>{proximoAnalisis()}</strong><span className="tenue">automático</span></div>
            </div>

            <div className="notion-cuerpo">
                <div className="panel notion-pedido">
                    <h3>Pedirle algo al asistente</h3>
                    {estado?.curador?.resumen && <p className="notion-resumen"><span className="kpi-etq">Lo último que hizo</span>{estado.curador.resumen}</p>}
                    <textarea
                        rows={3}
                        value={instruccion}
                        onChange={(e) => setInstruccion(e.target.value)}
                        onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') curar(); }}
                        placeholder="Opcional. Si lo dejás vacío, revisa todo y ordena lo que haga falta."
                        disabled={ocupado !== null}
                    />
                    <div className="notion-sugerencias">
                        {SUGERENCIAS_NOTION.map((x) => <button key={x} type="button" className="sugerencia" onClick={() => setInstruccion(x)} disabled={ocupado !== null}>{x}</button>)}
                    </div>
                    <div className="notion-pedido-pie">
                        <span className="tenue">{ocupado === 'curar' ? 'Trabajando en Notion… puede tardar 1 o 2 minutos.' : 'Ctrl + Enter para mandar.'}</span>
                        <button className="btn-primario" onClick={curar} disabled={ocupado !== null}>
                            {ocupado === 'curar' ? 'Trabajando…' : instruccion.trim() ? 'Pedírselo' : 'Revisar y ordenar ahora'}
                        </button>
                    </div>
                </div>

                <div className="panel">
                    <div className="panel-cab">
                        <h3>Prioridades</h3>
                        {estado?.prioridades && <span className="hora">{hace(estado.prioridades.fecha)}</span>}
                    </div>
                    {!estado?.prioridades?.items?.length ? (
                        <p className="tenue">Todavía no hay prioridades: se arman en cada análisis.</p>
                    ) : (
                        <ol className="prioridades">
                            {estado.prioridades.items.map((p, i) => (
                                <li key={i}>
                                    <span className="prio-texto">{p.texto}</span>
                                    {p.por_que && <span className="prio-porque">{p.por_que}</span>}
                                </li>
                            ))}
                        </ol>
                    )}
                </div>
            </div>

            <div className="panel notion-registro">
                <div className="panel-cab"><h3>Lo que hizo el asistente</h3></div>
                {cambios.length === 0 ? <p className="tenue">Todavía no hizo cambios.</p> : porDia.map(([d, lista]) => (
                    <div key={d} className="notion-dia">
                        <div className="notion-dia-titulo">{tituloDia(d)}</div>
                        {lista.map((c, i) => {
                            const t = TIPOS[c.tipo] ?? { etq: c.tipo, tono: 'cambio' };
                            return (
                                <div key={i} className="notion-cambio2">
                                    <span className="hora">{hora(c.creado_en)}</span>
                                    <span className={`notion-tipo2 nt-${t.tono}`}>{t.etq}</span>
                                    <span className="notion-detalle">{c.detalle}</span>
                                    {c.origen === 'pedido' && <span className="notion-origen">a pedido</span>}
                                    {c.url && <a href={c.url} target="_blank" rel="noreferrer">ver ↗</a>}
                                </div>
                            );
                        })}
                    </div>
                ))}
            </div>
        </section>
    );
}
