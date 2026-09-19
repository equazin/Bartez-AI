import { useState } from 'react';
import { buscarProspectos } from '../../api/client.ts';

interface Prospecto {
    nombre: string;
    sitio_web?: string;
    email?: string | null;
    razon?: string;
    señal?: string;
    puntaje_icp?: number;
    propuesta_contacto?: string;
}

interface Guardado {
    creados?: number;
    existentes?: number;
    saltados?: number;
    total?: number;
}

export function Buscar() {
    const [foco, setFoco] = useState('');
    const [cargando, setCargando] = useState(false);
    const [error, setError] = useState<string>();
    const [prospectos, setProspectos] = useState<Prospecto[]>([]);
    const [guardado, setGuardado] = useState<Guardado | null>(null);
    const [meta, setMeta] = useState<{ costoUsd: number; tokens: number } | null>(null);

    async function buscar() {
        setCargando(true);
        setError(undefined);
        setProspectos([]);
        setMeta(null);
        setGuardado(null);
        try {
            const { resultado, guardado } = await buscarProspectos(foco || undefined);
            const p = (resultado.accionPropuesta?.payload?.prospectos ?? []) as Prospecto[];
            setProspectos(p);
            setGuardado(guardado ?? null);
            setMeta({
                costoUsd: resultado.costoUsd,
                tokens: resultado.tokensIn + resultado.tokensOut,
            });
        } catch (e) {
            setError((e as Error).message);
        } finally {
            setCargando(false);
        }
    }

    return (
        <>
            <div className="prosp-form">
                <input
                    type="text"
                    placeholder="Foco (opcional): 'agencias en Mendoza', 'cerealeras del oeste', etc."
                    value={foco}
                    onChange={(e) => setFoco(e.target.value)}
                    disabled={cargando}
                />
                <button onClick={buscar} disabled={cargando}>
                    {cargando ? 'Buscando…' : 'Buscar prospectos'}
                </button>
            </div>

            {cargando && (
                <p className="vacio">
                    Buscando en la web… puede tardar 30-60 s.
                </p>
            )}
            {error && <p className="error">Error: {error}</p>}
            {meta && (
                <p className="prosp-meta">
                    {prospectos.length} prospectos encontrados
                    {guardado && (
                        <>
                            {' — '}
                            <strong>{guardado.creados ?? 0} nuevos guardados</strong>
                            {typeof guardado.existentes === 'number' && guardado.existentes > 0 && `, ${guardado.existentes} ya estaban en base`}
                            {typeof guardado.saltados === 'number' && guardado.saltados > 0 && `, ${guardado.saltados} descartados`}
                        </>
                    )}
                    {' · '}{meta.tokens.toLocaleString('es-AR')} tokens · USD {meta.costoUsd.toFixed(4)}
                </p>
            )}
            {meta && guardado && (guardado.creados ?? 0) > 0 && (
                <p className="prosp-info">
                    Ya podés verlos y contactarlos desde <strong>Base de prospectos</strong>.
                </p>
            )}

            {prospectos.map((p, i) => (
                <div key={i} className="prosp-card">
                    <div className="prosp-head">
                        <div>
                            <h3>{p.nombre}</h3>
                            {p.sitio_web && (
                                <a href={p.sitio_web} target="_blank" rel="noreferrer" className="prosp-web">
                                    {p.sitio_web}
                                </a>
                            )}
                        </div>
                        {typeof p.puntaje_icp === 'number' && (
                            <span className={`icp icp-${scoreClass(p.puntaje_icp)}`}>ICP {p.puntaje_icp}/10</span>
                        )}
                    </div>
                    {p.señal && <p className="prosp-senial"><strong>Señal:</strong> {p.señal}</p>}
                    {p.razon && <p className="prosp-razon"><strong>Encaje:</strong> {p.razon}</p>}
                    {p.email ? (
                        <p className="prosp-email"><strong>Contacto:</strong> {p.email}</p>
                    ) : (
                        <p className="prosp-email sin"><strong>Contacto:</strong> sin email — se guarda como lead sin primer contacto</p>
                    )}
                    {p.propuesta_contacto && (
                        <details>
                            <summary>Propuesta de primer contacto</summary>
                            <pre className="prosp-propuesta">{p.propuesta_contacto}</pre>
                        </details>
                    )}
                </div>
            ))}
        </>
    );
}

function scoreClass(n: number): 'alta' | 'media' | 'baja' {
    if (n >= 8) return 'alta';
    if (n >= 5) return 'media';
    return 'baja';
}
