// Prueba de modelos: repite tus correos reales con el modelo de antes y el
// nuevo, y un juez compara cada borrador con lo que hiciste vos.

import { useEffect, useState } from 'react';
import { CasoEvalResultado, Evaluacion, NotaEval, ResumenLado, correrEvaluacion, listarEvaluaciones, obtenerEvaluacion } from '../api/client.ts';

const NOMBRE: Record<string, string> = {
    'claude-sonnet-5': 'Sonnet 5',
    'claude-sonnet-4-5-20250929': 'Sonnet 4.5',
    'claude-haiku-4-5-20251001': 'Haiku 4.5',
    'claude-opus-5': 'Opus 5',
};
const nombre = (m: string) => NOMBRE[m] ?? m;
const AREA: Record<string, string> = { correo: 'Correo (respuestas)', seguimientos: 'Seguimientos y primer contacto' };
const ESTADO: Record<string, string> = { aprobada: 'Aprobaste', editada: 'Editaste', rechazada: 'Rechazaste' };
const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : '—');

function fecha(s: string) {
    return new Date(s).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function Tabla({ titulo, r }: { titulo: string; r: ResumenLado }) {
    const filas = [
        { etq: 'Antes', m: r.a, gana: r.ganaA },
        { etq: 'Nuevo', m: r.b, gana: r.ganaB },
    ];
    return (
        <div className="eval-bloque">
            <h4>{titulo}</h4>
            <div className="tabla-scroll">
                <table className="eval-tabla">
                    <thead>
                        <tr><th></th><th>Modelo</th><th>Lo mandarías tal cual</th><th>Puntaje (1–5)</th><th>Gana</th><th>Costo</th><th>Demora</th></tr>
                    </thead>
                    <tbody>
                        {filas.map((f) => (
                            <tr key={f.etq}>
                                <td>{f.etq}</td>
                                <td>{nombre(f.m.modelo)}</td>
                                <td className="num">{f.m.aprobables}/{f.m.casos} <span className="sutil">({pct(f.m.aprobables, f.m.casos)})</span></td>
                                <td className="num">{f.m.puntaje.toFixed(2)}</td>
                                <td className="num">{f.gana}</td>
                                <td className="num">USD {f.m.costoUsd.toFixed(3)}</td>
                                <td className="num">{(f.m.msPromedio / 1000).toFixed(1)} s</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
            <p className="sutil eval-empates">{r.empates} empates{r.a.errores + r.b.errores ? ` · ${r.a.errores + r.b.errores} con error` : ''}</p>
        </div>
    );
}

function Borrador({ etq, b, nota }: { etq: string; b: CasoEvalResultado['a']; nota?: NotaEval }) {
    return (
        <div className="eval-borrador">
            <div className="eval-borrador-head">
                <strong>{etq} · {nombre(b.modelo)}</strong>
                {nota && <span className={nota.aprobable ? 'chip-ok' : 'chip-info'}>{nota.aprobable ? 'Lo mandarías' : `${nota.puntaje}/5`}</span>}
            </div>
            {b.error ? <p className="error">Falló: {b.error}</p>
                : b.cuerpo ? <pre>{b.asunto ? `Asunto: ${b.asunto}\n\n` : ''}{b.cuerpo}</pre>
                    : <p className="sutil">No redactó nada ({b.filtrado ?? 'sin borrador'}).</p>}
            {nota?.problema && <p className="sutil">Problema: {nota.problema}</p>}
        </div>
    );
}

export function PruebaModelos() {
    const [lista, setLista] = useState<Evaluacion[]>([]);
    const [banco, setBanco] = useState<{ casos: number; costo_estimado_usd: number }>();
    const [actual, setActual] = useState<Evaluacion | null>(null);
    const [error, setError] = useState<string>();
    const [arrancando, setArrancando] = useState(false);
    const [filtro, setFiltro] = useState<'distintos' | 'todos'>('distintos');

    async function cargar(abrirId?: string) {
        try {
            setError(undefined);
            const r = await listarEvaluaciones();
            setLista(r.evaluaciones);
            setBanco(r.banco);
            const id = abrirId ?? actual?.id ?? r.evaluaciones.find((e) => e.estado !== 'error')?.id;
            if (id) setActual((await obtenerEvaluacion(id)).evaluacion);
        } catch (e) { setError((e as Error).message); }
    }

    useEffect(() => { cargar(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

    // Mientras corre, refresca el avance.
    useEffect(() => {
        if (actual?.estado !== 'corriendo') return;
        const t = setInterval(() => { cargar(actual.id); }, 5000);
        return () => clearInterval(t);
    }, [actual?.id, actual?.estado]); // eslint-disable-line react-hooks/exhaustive-deps

    async function correr() {
        if (!banco) return;
        if (!confirm(`Se repiten ${banco.casos} correos reales con los dos modelos y un juez los compara. Cuesta aprox. USD ${banco.costo_estimado_usd.toFixed(2)} de la API de Anthropic y tarda unos minutos. No se manda nada. ¿Correr?`)) return;
        setArrancando(true);
        try {
            const { id } = await correrEvaluacion();
            await cargar(id);
        } catch (e) { setError((e as Error).message); }
        finally { setArrancando(false); }
    }

    const casos = (actual?.detalle ?? []).filter((c) => filtro === 'todos' || (c.juez && (c.juez.mejor !== 'empate' || c.juez.a.aprobable !== c.juez.b.aprobable)));
    const corriendo = actual?.estado === 'corriendo';

    return (
        <section className="analitica eval">
            <div className="analitica-top">
                <div>
                    <h2>Prueba de modelos</h2>
                    <p className="sub">
                        Repite tus correos reales (lo que aprobaste, editaste y rechazaste) con el modelo de antes y el nuevo.
                        Un juez compara cada borrador con lo que hiciste vos. No se manda nada.
                    </p>
                </div>
                <button className="primario" onClick={correr} disabled={arrancando || corriendo || !banco?.casos}>
                    {corriendo ? `Corriendo… ${actual?.hechos ?? 0}/${actual?.casos ?? 0}` : arrancando ? 'Arrancando…' : banco ? `Correr prueba (${banco.casos} casos, ≈ USD ${banco.costo_estimado_usd.toFixed(2)})` : 'Correr prueba'}
                </button>
            </div>

            {error && <p className="error">Error: {error}</p>}

            {lista.length > 1 && (
                <div className="segmentos eval-corridas" role="tablist" aria-label="Corridas">
                    {lista.slice(0, 5).map((e) => (
                        <button key={e.id} className={actual?.id === e.id ? 'on' : ''} onClick={() => cargar(e.id)}>
                            {fecha(e.creado_en)}{e.estado === 'error' ? ' · error' : e.estado === 'corriendo' ? ' · corriendo' : ''}
                        </button>
                    ))}
                </div>
            )}

            {!actual && !error && <p className="vacio">Todavía no corriste ninguna prueba.</p>}

            {actual && (
                <div className="analitica-detalle">
                    <div className="detalle-head">
                        <h3>Prueba del {fecha(actual.creado_en)}</h3>
                        <div className="meta">
                            {actual.casos} casos · USD {Number(actual.costo_usd).toFixed(3)}
                            {actual.modelos.juez ? ` · juez ${nombre(actual.modelos.juez)}` : ''}
                        </div>
                    </div>
                    {corriendo && <p className="vacio">Van {actual.hechos} de {actual.casos} casos…</p>}
                    {actual.estado === 'error' && <p className="error">La prueba falló: {actual.error}</p>}
                    {actual.resumen && (
                        <>
                            {Object.entries(actual.resumen.porArea).map(([area, r]) => <Tabla key={area} titulo={AREA[area] ?? area} r={r} />)}

                            <div className="eval-bloque">
                                <div className="eval-casos-head">
                                    <h4>Caso por caso</h4>
                                    <div className="segmentos" role="tablist" aria-label="Filtro">
                                        <button className={filtro === 'distintos' ? 'on' : ''} onClick={() => setFiltro('distintos')}>Donde difieren</button>
                                        <button className={filtro === 'todos' ? 'on' : ''} onClick={() => setFiltro('todos')}>Todos</button>
                                    </div>
                                </div>
                                {casos.length === 0 && <p className="vacio-mini">No hay casos con diferencias.</p>}
                                {casos.map((c) => (
                                    <details key={c.caso.id} className="eval-caso">
                                        <summary>
                                            <span className={`eval-gana gana-${c.juez?.mejor ?? 'nada'}`}>
                                                {c.juez?.mejor === 'b' ? 'Mejor el nuevo' : c.juez?.mejor === 'a' ? 'Mejor el de antes' : 'Empate'}
                                            </span>
                                            <span className="eval-caso-tit">{c.caso.asunto || '(sin asunto)'}</span>
                                            <span className="sutil">{c.caso.para} · {ESTADO[c.caso.estado]}{c.caso.motivo ? `: ${c.caso.motivo}` : ''}</span>
                                        </summary>
                                        {c.juez?.razon && <p className="eval-razon">{c.juez.razon}</p>}
                                        <div className="eval-par">
                                            <Borrador etq="Antes" b={c.a} nota={c.juez?.a} />
                                            <Borrador etq="Nuevo" b={c.b} nota={c.juez?.b} />
                                        </div>
                                    </details>
                                ))}
                            </div>
                        </>
                    )}
                </div>
            )}
        </section>
    );
}
