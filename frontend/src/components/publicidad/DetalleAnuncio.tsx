// Detalle de un anuncio: cómo se ve en computadora y en celular, sus números y
// cómo rinde cada título según Google.

import { useEffect, useState } from 'react';
import { AnuncioAds, RendimientoTexto, pausarAnuncioAds } from '../../api/client.ts';
import { AnuncioGoogle } from './AnuncioGoogle.tsx';

export const ESTADO_ANUNCIO: Record<AnuncioAds['estado'], { texto: string; clase: string }> = {
    activo: { texto: 'Activo', clase: 'ok' },
    pausado: { texto: 'Pausado', clase: '' },
    rechazado: { texto: 'Rechazado por Google', clase: 'mal' },
    limitado: { texto: 'Aprobado con límites', clase: 'medio' },
    en_revision: { texto: 'En revisión de Google', clase: '' },
    pendiente_ok: { texto: 'Nuevo · espera tu ok', clase: 'nuevo' },
    sin_cargar: { texto: 'Aprobado · falta cargarlo', clase: 'medio' },
};

const REND: Record<NonNullable<RendimientoTexto>, { texto: string; clase: string }> = {
    muy_bueno: { texto: 'Muy bueno', clase: 'ok' },
    bueno: { texto: 'Bueno', clase: '' },
    bajo: { texto: 'Bajo', clase: 'medio' },
    aprendiendo: { texto: 'Aprendiendo', clase: '' },
};

const ENLACES = ['Pedir cotización', 'Configurador IT', 'Casos de éxito', 'Medios de pago'];

export function DetalleAnuncio({ a, plata, cerrar, generarVariantes, pausaPedida }: {
    a: AnuncioAds;
    plata: (n: number | null | undefined) => string;
    cerrar: () => void;
    generarVariantes: (a: AnuncioAds) => void;
    pausaPedida: () => void;
}) {
    const [ocupado, setOcupado] = useState(false);
    const [error, setError] = useState<string>();
    const titulos = a.titulos.map((t) => t.texto);
    const descripciones = a.descripciones.map((t) => t.texto);
    const est = ESTADO_ANUNCIO[a.estado];
    const m = a.metricas;

    useEffect(() => {
        const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') cerrar(); };
        window.addEventListener('keydown', esc);
        return () => window.removeEventListener('keydown', esc);
    }, [cerrar]);

    async function pausar() {
        setOcupado(true); setError(undefined);
        try { await pausarAnuncioAds({ id: a.id, titulo: titulos[0] ?? 'Anuncio', ruta: a.ruta }); pausaPedida(); }
        catch (e) { setError((e as Error).message); }
        finally { setOcupado(false); }
    }

    return (
        <div className="pub-modal-fondo pub-lado" onMouseDown={(e) => { if (e.target === e.currentTarget) cerrar(); }}>
            <aside className="pub-cajon" role="dialog" aria-modal="true" aria-labelledby="det-anuncio-titulo">
                <header className="det-cab">
                    <div>
                        <div className="det-ruta">{a.campania ? `Campaña ${a.campania} · ` : ''}lleva a {a.ruta ?? a.url ?? '—'}</div>
                        <h2 id="det-anuncio-titulo">{titulos[0] ?? 'Anuncio'}</h2>
                    </div>
                    <span className={`pub-estado ${est.clase}`}>{est.texto}</span>
                    <button className="pub-cerrar" onClick={cerrar} aria-label="Cerrar">✕</button>
                </header>
                {a.problema && <p className="pub-aviso mal">{a.problema}</p>}
                {error && <p className="error" role="alert">{error}</p>}

                {m && (
                    <div className="det-kpis">
                        <div><span>Se mostró</span><strong>{m.impresiones.toLocaleString('es-AR')} veces</strong></div>
                        <div><span>Clics</span><strong>{m.clics.toLocaleString('es-AR')}{m.impresiones ? ` · ${((m.clics / m.impresiones) * 100).toFixed(1).replace('.', ',')}%` : ''}</strong></div>
                        <div><span>Conversiones</span><strong>{m.conversiones}</strong></div>
                        <div><span>Gasto 30 días</span><strong>{plata(m.costo)}</strong></div>
                    </div>
                )}

                <div className="det-previews">
                    <section>
                        <h3>En computadora</h3>
                        <AnuncioGoogle modo="compu" titulos={titulos} descripciones={descripciones} url={a.url} ruta1={a.ruta1} ruta2={a.ruta2} enlaces={ENLACES} />
                        <p className="det-nota">Google arma cada anuncio combinando los títulos y descripciones de abajo; esta es la base.</p>
                    </section>
                    <section>
                        <h3>En celular</h3>
                        <div className="det-celu">
                            <div className="det-celu-busqueda">{a.ruta ? a.ruta.split('/').filter(Boolean).pop()?.replace(/-/g, ' ') : 'bartez'}</div>
                            <AnuncioGoogle modo="celu" titulos={titulos} descripciones={descripciones} url={a.url} enlaces={['Pedir cotización', 'Llamar']} />
                        </div>
                    </section>
                </div>

                <div className="det-textos">
                    <section>
                        <h3>Títulos{a.origen === 'google' ? ' · cómo rinde cada uno' : ''}</h3>
                        <ul>
                            {a.titulos.map((t) => (
                                <li key={t.texto}><span>{t.texto}</span>{t.rendimiento && <span className={`pub-estado ${REND[t.rendimiento].clase}`}>{REND[t.rendimiento].texto}</span>}</li>
                            ))}
                        </ul>
                    </section>
                    <section>
                        <h3>Descripciones</h3>
                        <ul>
                            {a.descripciones.map((t) => (
                                <li key={t.texto}><span>{t.texto}</span>{t.rendimiento && <span className={`pub-estado ${REND[t.rendimiento].clase}`}>{REND[t.rendimiento].texto}</span>}</li>
                            ))}
                        </ul>
                    </section>
                </div>

                <div className="det-acciones">
                    <button className="pub-primario" onClick={() => generarVariantes(a)}>Generar variantes de este anuncio</button>
                    {a.origen === 'google' && a.estado !== 'pausado' && <button className="boton-fantasma" onClick={pausar} disabled={ocupado}>{ocupado ? 'Mandando…' : 'Pausar (va a Para aprobar)'}</button>}
                    {a.url && <a className="boton-fantasma" href={a.url} target="_blank" rel="noreferrer">Abrir la página ↗</a>}
                </div>
            </aside>
        </div>
    );
}
