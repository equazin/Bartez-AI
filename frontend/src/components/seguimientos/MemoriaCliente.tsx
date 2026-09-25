// Memoria del cliente: lo que Bartez recuerda (último informe e historial),
// las notas de Andrés y los documentos que se le pasaron (presupuestos, etc.).
// Todo esto lo usan los seguimientos, el correo, WhatsApp y el chat.

import { useEffect, useRef, useState } from 'react';
import {
    DocumentoCliente,
    InformeCliente,
    MAX_CHARS_NOTA,
    MAX_MB_DOCUMENTO,
    MemoriaCliente as Memoria,
    NOTA_LARGA,
    NotaCliente,
    borrarDocumentoCliente,
    borrarNotaCliente,
    crearNotaCliente,
    reprocesarDocumentoCliente,
    subirDocumentoCliente,
    urlDocumentoCliente,
} from '../../api/client.ts';

export type PestanaMemoria = 'informe' | 'notas' | 'documentos';

const ACEPTA = '.pdf,.jpg,.jpeg,.png,.webp,.gif,.xlsx,.docx,.txt,.csv,.md,application/pdf,image/*';

// Una nota larga recién guardada, que la IA todavía está resumiendo. Si en unos
// minutos no llegó el resumen, se deja de esperar (los asistentes usan el texto).
export function notaResumiendose(n: NotaCliente): boolean {
    return n.texto.length > NOTA_LARGA && !n.resumen && Date.now() - new Date(n.creado_en).getTime() < 3 * 60_000;
}

interface Props {
    clienteId: string;
    memoria: Memoria | null;
    error: string | null;
    setMemoria: (f: (m: Memoria | null) => Memoria | null) => void;
    pestana: PestanaMemoria;
    setPestana: (p: PestanaMemoria) => void;
    notaBorrador: string;
    setNotaBorrador: (t: string) => void;
    aviso: string | null;
    // Si el backend todavía no tiene memoria, se muestra el informe recién pedido.
    informeSuelto: InformeCliente | null;
    generando: boolean;
    onRehacer: () => void;
}

export function MemoriaCliente(p: Props) {
    const { memoria, pestana } = p;
    const [errorLocal, setErrorLocal] = useState<string | null>(null);
    const montado = useRef(true);
    useEffect(() => () => { montado.current = false; }, []);

    const actualizar = (f: (m: Memoria) => Memoria) => {
        if (montado.current) p.setMemoria((m) => (m ? f(m) : m));
    };
    const fallar = (e: unknown) => { if (montado.current) setErrorLocal((e as Error).message); };

    const notas = memoria?.notas ?? [];
    const documentos = memoria?.documentos ?? [];

    return (
        <section className="memoria" aria-label="Memoria del cliente">
            <div className="memoria-cab">
                <div>
                    <h4>Lo que Bartez sabe de este cliente</h4>
                    <p>Queda guardado y lo usan los seguimientos, el correo, WhatsApp y el chat.</p>
                </div>
                <div className="segmentos" role="tablist" aria-label="Memoria">
                    {(['informe', 'notas', 'documentos'] as PestanaMemoria[]).map((t) => (
                        <button
                            key={t}
                            type="button"
                            role="tab"
                            aria-selected={pestana === t}
                            className={pestana === t ? 'on' : ''}
                            onClick={() => { setErrorLocal(null); p.setPestana(t); }}
                        >
                            {t === 'informe' ? 'Informe' : t === 'notas' ? 'Notas' : 'Documentos'}
                            {t === 'notas' && notas.length > 0 && <span className="cuenta">{notas.length}</span>}
                            {t === 'documentos' && documentos.length > 0 && <span className="cuenta">{documentos.length}</span>}
                        </button>
                    ))}
                </div>
            </div>

            {p.error && !memoria && (
                <p className="mem-error">No se pudo leer la memoria: {p.error}. Si el servidor no está actualizado, reinicialo con la última versión.</p>
            )}
            {errorLocal && <p className="mem-error" role="alert">{errorLocal}</p>}

            <div className="memoria-cuerpo" role="tabpanel">
                {pestana === 'informe' && <PestanaInforme {...p} />}
                {pestana === 'notas' && (
                    <PestanaNotas
                        clienteId={p.clienteId}
                        notas={notas}
                        borrador={p.notaBorrador}
                        setBorrador={p.setNotaBorrador}
                        sinMemoria={!memoria}
                        onCreada={(n) => actualizar((m) => ({ ...m, notas: [n, ...m.notas] }))}
                        onBorrada={(id) => actualizar((m) => ({ ...m, notas: m.notas.filter((x) => x.id !== id) }))}
                        onError={fallar}
                        limpiarError={() => setErrorLocal(null)}
                    />
                )}
                {pestana === 'documentos' && (
                    <PestanaDocumentos
                        clienteId={p.clienteId}
                        documentos={documentos}
                        sinMemoria={!memoria}
                        montado={montado}
                        actualizar={actualizar}
                        onError={fallar}
                        limpiarError={() => setErrorLocal(null)}
                    />
                )}
            </div>
        </section>
    );
}

function PestanaInforme(p: Props) {
    const informes = p.memoria?.informes ?? [];
    const [actual, ...anteriores] = informes;

    if (!actual) {
        if (p.informeSuelto) {
            return <div className="markdown-simple">{formatearMarkdown(p.informeSuelto.resumen_md)}</div>;
        }
        return (
            <p className="mem-vacio">
                {p.generando
                    ? 'Bartez está leyendo la historia del cliente…'
                    : <>Todavía no hay informe. Tocá <strong>Generar informe</strong>: queda guardado y después se actualiza solo cada noche si hubo movimiento.</>}
            </p>
        );
    }

    return (
        <>
            {p.aviso && <p className="mem-aviso" role="status">{p.aviso}</p>}
            <div className="mem-meta">
                <span className={`mem-origen ${actual.origen}`}>{actual.origen === 'automatico' ? 'Se actualizó solo' : 'Pedido por vos'}</span>
                <span>{fechaHora(actual.creado_en)}</span>
            </div>
            <div className="markdown-simple">{formatearMarkdown(actual.resumen_md)}</div>
            <div className="mem-pie">
                {anteriores.length > 0 ? (
                    <details className="mem-historial">
                        <summary>Informes anteriores ({anteriores.length})</summary>
                        {anteriores.map((i) => (
                            <details key={i.id} className="mem-anterior">
                                <summary>{fechaHora(i.creado_en)} · {i.origen === 'automatico' ? 'automático' : 'a pedido'}</summary>
                                <div className="markdown-simple">{formatearMarkdown(i.resumen_md)}</div>
                            </details>
                        ))}
                    </details>
                ) : <span />}
                <button
                    type="button"
                    className="secundario chico"
                    onClick={p.onRehacer}
                    disabled={p.generando}
                    title="Arma el informe de nuevo leyendo toda la historia, sin partir del anterior"
                >
                    Rehacer desde cero
                </button>
            </div>
        </>
    );
}

function PestanaNotas(p: {
    clienteId: string;
    notas: NotaCliente[];
    borrador: string;
    setBorrador: (t: string) => void;
    sinMemoria: boolean;
    onCreada: (n: NotaCliente) => void;
    onBorrada: (id: string) => void;
    onError: (e: unknown) => void;
    limpiarError: () => void;
}) {
    const [guardando, setGuardando] = useState(false);

    const largo = p.borrador.trim().length;
    const pasado = largo > MAX_CHARS_NOTA;

    async function guardar() {
        const texto = p.borrador.trim();
        if (!texto || guardando || pasado) return;
        setGuardando(true);
        p.limpiarError();
        try {
            const { nota } = await crearNotaCliente(p.clienteId, texto);
            p.onCreada(nota);
            p.setBorrador('');
        } catch (e) { p.onError(e); }
        finally { setGuardando(false); }
    }

    async function borrar(n: NotaCliente) {
        if (!window.confirm('¿Borrar esta nota? Bartez deja de tenerla en cuenta.')) return;
        p.limpiarError();
        try {
            await borrarNotaCliente(n.id);
            p.onBorrada(n.id);
        } catch (e) { p.onError(e); }
    }

    return (
        <>
            <div className="mem-nota-form">
                <textarea
                    aria-label="Nueva nota"
                    value={p.borrador}
                    onChange={(e) => p.setBorrador(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void guardar(); } }}
                    placeholder="ej: me llamó ayer, quiere 10 notebooks para el 15/10 y paga a 30 días."
                    rows={3}
                />
                <div className="mem-fila">
                    <span className="mem-ayuda">
                        {largo > NOTA_LARGA ? (
                            <span className={pasado ? 'mem-largo pasado' : 'mem-largo'}>
                                {largo.toLocaleString('es-AR')} de {MAX_CHARS_NOTA.toLocaleString('es-AR')} caracteres
                                {pasado ? ' · es demasiado largo: guardalo en un .txt y subilo en Documentos.' : ' · es largo: Bartez lo guarda entero y le hace un resumen.'}
                            </span>
                        ) : 'Lo que Bartez no ve: llamadas, acuerdos, precios pactados o una conversación de WhatsApp pegada entera. Si redactás o pedís el informe con algo escrito acá, también se guarda.'}
                    </span>
                    <button type="button" className="btn-primario chico" onClick={guardar} disabled={!p.borrador.trim() || guardando || pasado}>
                        {guardando ? 'Guardando…' : 'Guardar nota'}
                    </button>
                </div>
            </div>
            {p.notas.length === 0 ? (
                !p.sinMemoria && <p className="mem-vacio">Sin notas todavía.</p>
            ) : (
                <ul className="mem-notas">
                    {p.notas.map((n) => (
                        <li key={n.id}>
                            <div>
                                <TextoNota nota={n} />
                                <span className="mem-fecha">{fechaHora(n.creado_en)}</span>
                            </div>
                            <button type="button" className="mem-x" aria-label="Borrar nota" title="Borrar nota" onClick={() => borrar(n)}>×</button>
                        </li>
                    ))}
                </ul>
            )}
        </>
    );
}

// Las notas largas muestran el resumen de Bartez y el texto completo plegado.
function TextoNota({ nota }: { nota: NotaCliente }) {
    if (nota.texto.length <= 600) return <p>{nota.texto}</p>;
    return (
        <>
            {nota.resumen ? (
                <div className="mem-nota-resumen">
                    <span className="mem-nota-etq">Resumen de Bartez</span>
                    <p>{nota.resumen}</p>
                </div>
            ) : (
                <>
                    <p>{nota.texto.slice(0, 280).trimEnd()}…</p>
                    {notaResumiendose(nota) && <div className="mem-estado leyendo">Bartez la está resumiendo…</div>}
                </>
            )}
            <details className="mem-resumen">
                <summary>Ver texto completo · {nota.texto.length.toLocaleString('es-AR')} caracteres</summary>
                <p>{nota.texto}</p>
            </details>
        </>
    );
}

function PestanaDocumentos(p: {
    clienteId: string;
    documentos: DocumentoCliente[];
    sinMemoria: boolean;
    montado: React.MutableRefObject<boolean>;
    actualizar: (f: (m: Memoria) => Memoria) => void;
    onError: (e: unknown) => void;
    limpiarError: () => void;
}) {
    const [subiendo, setSubiendo] = useState<string[]>([]);
    const [arrastrando, setArrastrando] = useState(false);

    async function subir(lista: FileList | null) {
        const archivos = Array.from(lista ?? []);
        if (!archivos.length) return;
        p.limpiarError();
        const problemas: string[] = [];
        // De a uno: cada archivo viaja entero en el pedido.
        for (const a of archivos) {
            if (a.size > MAX_MB_DOCUMENTO * 1024 * 1024) { problemas.push(`${a.name} pesa más de ${MAX_MB_DOCUMENTO} MB`); continue; }
            setSubiendo((s) => [...s, a.name]);
            try {
                const { documento } = await subirDocumentoCliente(p.clienteId, a);
                p.actualizar((m) => ({ ...m, documentos: [documento, ...m.documentos] }));
            } catch (e) {
                problemas.push(`${a.name}: ${(e as Error).message}`);
            } finally {
                if (p.montado.current) setSubiendo((s) => s.filter((x) => x !== a.name));
            }
        }
        if (problemas.length) p.onError(new Error(problemas.join(' · ')));
    }

    async function abrir(d: DocumentoCliente) {
        const mime = d.tipo_mime ?? '';
        const seVe = mime === 'application/pdf' || mime.startsWith('image/') || mime.startsWith('text/');
        // PDF y fotos en otra pestaña, abierta ya con el clic para que el navegador
        // no la bloquee. Excel y Word se descargan sin salir del panel.
        const w = seVe ? window.open('', '_blank') : null;
        try {
            const { url } = await urlDocumentoCliente(d.id);
            if (w) { w.opener = null; w.location.href = url; } else window.location.assign(url);
        } catch (e) { w?.close(); p.onError(e); }
    }

    async function reprocesar(d: DocumentoCliente) {
        p.limpiarError();
        try {
            await reprocesarDocumentoCliente(d.id);
            p.actualizar((m) => ({ ...m, documentos: m.documentos.map((x) => (x.id === d.id ? { ...x, estado: 'procesando', error: null } : x)) }));
        } catch (e) { p.onError(e); }
    }

    async function borrar(d: DocumentoCliente) {
        if (!window.confirm(`¿Borrar "${d.nombre}"? Se borra el archivo y Bartez deja de tenerlo en cuenta.`)) return;
        p.limpiarError();
        try {
            await borrarDocumentoCliente(d.id);
            p.actualizar((m) => ({ ...m, documentos: m.documentos.filter((x) => x.id !== d.id) }));
        } catch (e) { p.onError(e); }
    }

    return (
        <>
            <div
                className={`mem-drop${arrastrando ? ' activo' : ''}`}
                onDragOver={(e) => { e.preventDefault(); setArrastrando(true); }}
                onDragLeave={() => setArrastrando(false)}
                onDrop={(e) => { e.preventDefault(); setArrastrando(false); void subir(e.dataTransfer.files); }}
            >
                <label className="secundario">
                    <input
                        type="file"
                        multiple
                        accept={ACEPTA}
                        className="solo-lector"
                        onChange={(e) => { void subir(e.target.files); e.target.value = ''; }}
                    />
                    Subir documento
                </label>
                <span className="mem-ayuda">o arrastralo acá · PDF, fotos, Excel, Word o texto · hasta {MAX_MB_DOCUMENTO} MB. Bartez lo lee y guarda lo importante.</span>
            </div>

            {p.documentos.length === 0 && subiendo.length === 0 ? (
                !p.sinMemoria && <p className="mem-vacio">Sin documentos. Subí presupuestos, órdenes de compra, listas de precios o pliegos de este cliente.</p>
            ) : (
                <ul className="mem-docs">
                    {subiendo.map((n) => (
                        <li key={`sub-${n}`} className="mem-doc">
                            <span className="mem-ext">{extension(n, null)}</span>
                            <div className="mem-doc-info">
                                <div className="mem-doc-nombre">{n}</div>
                                <div className="mem-estado leyendo">Subiendo…</div>
                            </div>
                        </li>
                    ))}
                    {p.documentos.map((d) => (
                        <li key={d.id} className="mem-doc">
                            <span className="mem-ext">{extension(d.nombre, d.tipo_mime)}</span>
                            <div className="mem-doc-info">
                                <div className="mem-doc-nombre" title={d.nombre}>{d.nombre}</div>
                                <div className="mem-doc-meta">
                                    {d.tipo_documento && <strong>{d.tipo_documento}</strong>}
                                    {d.tamano_bytes != null && <span>{peso(d.tamano_bytes)}</span>}
                                    <span>{fechaHora(d.creado_en)}</span>
                                </div>
                                {d.estado === 'procesando' && <div className="mem-estado leyendo">Bartez lo está leyendo…</div>}
                                {d.estado === 'error' && (
                                    <div className="mem-estado falla">
                                        No se pudo leer{d.error ? `: ${d.error}` : ''}.{' '}
                                        <button type="button" className="enlace" onClick={() => reprocesar(d)}>Reintentar</button>
                                    </div>
                                )}
                                {d.estado === 'listo' && d.resumen && (
                                    <details className="mem-resumen">
                                        <summary>Lo que entendió Bartez</summary>
                                        <p>{d.resumen}</p>
                                    </details>
                                )}
                            </div>
                            <div className="mem-doc-acc">
                                <button type="button" className="secundario chico" onClick={() => abrir(d)}>Abrir</button>
                                <button type="button" className="mem-x" aria-label={`Borrar ${d.nombre}`} title="Borrar" onClick={() => borrar(d)}>×</button>
                            </div>
                        </li>
                    ))}
                </ul>
            )}
        </>
    );
}

function extension(nombre: string, mime: string | null): string {
    const ext = nombre.includes('.') ? nombre.split('.').pop()!.toLowerCase() : '';
    if (ext === 'jpeg') return 'JPG';
    if (ext && ext.length <= 4) return ext.toUpperCase();
    if (mime?.startsWith('image/')) return 'IMG';
    if (mime === 'application/pdf') return 'PDF';
    return 'DOC';
}

function peso(bytes: number): string {
    if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
    return `${(bytes / 1024 / 1024).toLocaleString('es-AR', { maximumFractionDigits: 1 })} MB`;
}

export function fechaHora(iso: string | undefined): string {
    if (!iso) return '';
    const d = new Date(iso);
    const hoy = new Date();
    const hora = d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false });
    if (d.toDateString() === hoy.toDateString()) return `hoy ${hora}`;
    const ayer = new Date(hoy.getTime() - 24 * 3600_000);
    if (d.toDateString() === ayer.toDateString()) return `ayer ${hora}`;
    const mismoAnio = d.getFullYear() === hoy.getFullYear();
    return `${d.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', ...(mismoAnio ? {} : { year: 'numeric' }) })} ${hora}`;
}

export function formatearMarkdown(md: string): React.ReactNode {
    const lineas = md.split('\n');
    const out: React.ReactNode[] = [];
    let bullets: string[] = [];
    const flush = (k: string) => {
        if (bullets.length > 0) { out.push(<ul key={k}>{bullets.map((b, i) => <li key={i}>{b}</li>)}</ul>); bullets = []; }
    };
    lineas.forEach((raw, i) => {
        const l = raw.trim();
        if (!l) { flush(`u${i}`); return; }
        if (l.startsWith('## ')) { flush(`u${i}`); out.push(<h3 key={i}>{l.slice(3)}</h3>); return; }
        if (l.startsWith('# ')) { flush(`u${i}`); out.push(<h2 key={i}>{l.slice(2)}</h2>); return; }
        if (l.startsWith('- ') || l.startsWith('* ')) { bullets.push(l.slice(2)); return; }
        flush(`u${i}`);
        out.push(<p key={i}>{l}</p>);
    });
    flush('final');
    return <>{out}</>;
}
