import { useCallback, useEffect, useState } from 'react';
import { actualizarCliente, contactarProspecto, listarProspectos, Prospecto } from '../../api/client.ts';

type Estado = 'todos' | 'lead' | 'cliente' | 'inactivo' | 'descartado';

const ESTADOS: { id: Estado; label: string }[] = [
    { id: 'todos', label: 'Todos' },
    { id: 'lead', label: 'Leads' },
    { id: 'cliente', label: 'Clientes' },
    { id: 'inactivo', label: 'Inactivos' },
    { id: 'descartado', label: 'Descartados' },
];

export function ListaProspectos() {
    const [prospectos, setProspectos] = useState<Prospecto[]>([]);
    const [filtro, setFiltro] = useState<Estado>('todos');
    const [minIcp, setMinIcp] = useState(0);
    const [expandido, setExpandido] = useState<string | null>(null);
    const [error, setError] = useState<string>();
    const [ocupado, setOcupado] = useState<string | null>(null);
    const [mensaje, setMensaje] = useState<string | null>(null);

    const cargar = useCallback(async () => {
        try {
            setError(undefined);
            const { prospectos } = await listarProspectos(filtro);
            setProspectos(prospectos);
        } catch (e) {
            setError((e as Error).message);
        }
    }, [filtro]);

    useEffect(() => { cargar(); }, [cargar]);

    async function cambiarEstado(p: Prospecto, nuevo: Prospecto['estado']) {
        setOcupado(p.id);
        try {
            await actualizarCliente(p.id, { estado: nuevo });
            await cargar();
        } catch (e) { setError((e as Error).message); }
        finally { setOcupado(null); }
    }

    async function contactar(p: Prospecto) {
        if (!p.email) {
            setError('Este prospecto no tiene email cargado — cargalo primero desde el detalle.');
            return;
        }
        setOcupado(p.id);
        setMensaje(null);
        try {
            const r = await contactarProspecto(p.id, 'correo');
            setMensaje(`✓ ${p.nombre}: ${r.mensaje}`);
        } catch (e) { setError((e as Error).message); }
        finally { setOcupado(null); }
    }

    const filtrados = prospectos.filter((p) => (p.metadata?.puntaje_icp ?? 0) >= minIcp);

    return (
        <>
            <div className="lista-toolbar">
                <div className="chips">
                    {ESTADOS.map((e) => (
                        <span
                            key={e.id}
                            className={filtro === e.id ? 'chip on' : 'chip'}
                            onClick={() => setFiltro(e.id)}
                        >
                            {e.label}
                        </span>
                    ))}
                </div>
                <div className="icp-slider">
                    ICP mín: <strong>{minIcp}</strong>
                    <input
                        type="range"
                        min={0}
                        max={10}
                        value={minIcp}
                        onChange={(e) => setMinIcp(Number(e.target.value))}
                    />
                </div>
                <button className="secundario" onClick={cargar}>Actualizar</button>
            </div>

            {error && <p className="error">{error}</p>}
            {mensaje && <p className="prosp-meta" style={{ background: 'rgba(16,163,127,0.12)', color: 'var(--ok)' }}>{mensaje}</p>}

            {filtrados.length === 0 && !error && (
                <p className="vacio">
                    {prospectos.length === 0
                        ? 'Sin prospectos todavía. Andá a "Buscar nuevos" para arrancar.'
                        : 'Ningún prospecto cumple los filtros actuales.'}
                </p>
            )}

            {filtrados.map((p) => {
                const abierto = expandido === p.id;
                const icp = p.metadata?.puntaje_icp ?? 0;
                return (
                    <div key={p.id} className="prosp-item">
                        <div className="prosp-row" onClick={() => setExpandido(abierto ? null : p.id)}>
                            <div className="prosp-name">
                                <strong>{p.nombre}</strong>
                                <span className={`estado-chip estado-${p.estado}`}>{p.estado}</span>
                            </div>
                            <span className={`icp icp-${scoreClass(icp)}`}>ICP {icp}/10</span>
                            <span className="prosp-mail">{p.email ?? '—'}</span>
                            <span className="ts">{new Date(p.creado_en).toLocaleDateString('es-AR')}</span>
                            <span>{abierto ? '▲' : '▼'}</span>
                        </div>

                        {abierto && (
                            <div className="prosp-detalle">
                                {p.metadata?.sitio_web && (
                                    <p>
                                        <strong>Sitio:</strong>{' '}
                                        <a href={p.metadata.sitio_web} target="_blank" rel="noreferrer" className="prosp-web">
                                            {p.metadata.sitio_web}
                                        </a>
                                    </p>
                                )}
                                {p.metadata?.senial && <p><strong>Señal:</strong> {p.metadata.senial}</p>}
                                {p.metadata?.razon_prospeccion && <p><strong>Encaje ICP:</strong> {p.metadata.razon_prospeccion}</p>}
                                <p><strong>Email:</strong> {p.email ?? <em>sin cargar</em>}</p>
                                {p.whatsapp && <p><strong>WhatsApp:</strong> {p.whatsapp}</p>}

                                <div className="prosp-acciones">
                                    <button
                                        className="accion-primaria"
                                        disabled={!p.email || ocupado === p.id}
                                        onClick={() => contactar(p)}
                                        title={p.email ? 'Genera un primer contacto y lo deja en Acciones para tu aprobación' : 'Falta cargar el email de este prospecto'}
                                    >
                                        {ocupado === p.id ? 'Procesando…' : '✉ Contactar (Correo)'}
                                    </button>
                                    <select
                                        value={p.estado}
                                        disabled={ocupado === p.id}
                                        onChange={(e) => cambiarEstado(p, e.target.value as Prospecto['estado'])}
                                    >
                                        <option value="lead">Lead</option>
                                        <option value="cliente">Cliente</option>
                                        <option value="inactivo">Inactivo</option>
                                        <option value="descartado">Descartar</option>
                                    </select>
                                </div>
                            </div>
                        )}
                    </div>
                );
            })}
        </>
    );
}

function scoreClass(n: number): 'alta' | 'media' | 'baja' {
    if (n >= 8) return 'alta';
    if (n >= 5) return 'media';
    return 'baja';
}
