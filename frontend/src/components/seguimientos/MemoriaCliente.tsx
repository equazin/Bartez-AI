// Memoria del cliente: lo que Bartez recuerda (último informe e historial),
// las notas de Andrés y los documentos que se le pasaron (presupuestos, etc.).
// Todo esto lo usan los seguimientos, el correo, WhatsApp y el chat.

import { useEffect, useRef, useState } from 'react';
import {
    CambioCotizadoDoc,
    DatosDocumento,
    DocumentoCliente,
    InformeCliente,
    MAX_CHARS_NOTA,
    MAX_MB_DOCUMENTO,
    MemoriaCliente as Memoria,
    NOTA_LARGA,
    NotaCliente,
    borrarDocumentoCliente,
    borrarNotaCliente,
    cotizadoDocumento,
    crearNotaCliente,
    reprocesarDocumentoCliente,
    subirDocumentoCliente,
    urlDocumentoCliente,
} from '../../api/client.ts';
import { abrirEnCotizador } from '../../lib/cotizador.ts';

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
    // Para ir al Cotizador desde un presupuesto de la ficha.
    irA?: (tab: string) => void;
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
                        irA={p.irA}
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
    irA?: (tab: string) => void;
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
        const q = d.cotizacion;
        const cerrado = q?.estado === 'ganada' || q?.estado === 'perdida';
        const extra = q?.origen === 'documento'
            ? (cerrado ? ' Su presupuesto queda en el Cotizador porque ya está marcado como ' + (q.estado === 'ganada' ? 'ganado.' : 'perdido.') : ' Su presupuesto deja de sumar a Cotizado.')
            : '';
        if (!window.confirm(`¿Borrar "${d.nombre}"? Se borra el archivo y Bartez deja de tenerlo en cuenta.${extra}`)) return;
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
                                {(d.estado === 'listo' || d.estado === 'error') && (
                                    <BloquePresupuesto
                                        d={d}
                                        irA={p.irA}
                                        onCambio={(nuevo) => p.actualizar((m) => ({ ...m, documentos: m.documentos.map((x) => (x.id === nuevo.id ? nuevo : x)) }))}
                                        onError={p.onError}
                                    />
                                )}
                                {d.estado === 'listo' && d.resumen && (
                                    <details className="mem-resumen">
                                        <summary>Lo que entendió Bartez</summary>
                                        <div className="markdown-simple">{formatearMarkdown(d.resumen)}</div>
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

// La opción que cuenta en Cotizado: la elegida o, si no, la más baja.
function opcionQueCuenta(datos: DatosDocumento): number {
    const ops = datos.presupuesto?.opciones ?? [];
    if (typeof datos.opcion === 'number' && datos.opcion >= 0 && datos.opcion < ops.length) return datos.opcion;
    let min = 0;
    ops.forEach((o, i) => { if (o.total < ops[min]!.total) min = i; });
    return min;
}

const plata = (n: number, moneda: 'USD' | 'ARS' = 'USD') =>
    `${moneda === 'ARS' ? '$' : 'US$'} ${n.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Lo que escribe Andrés como total: "1.212", "1.212,50", "1212.5", "US$ 74.851,90".
export function numeroEscrito(v: string): number | null {
    let s = v.replace(/[^\d.,]/g, '');
    if (!s) return null;
    const coma = s.lastIndexOf(','), punto = s.lastIndexOf('.');
    if (coma > punto) s = s.replace(/\./g, '').replace(',', '.');          // 74.851,90
    else if (punto > coma && coma >= 0) s = s.replace(/,/g, '');             // 74,851.90
    else if (coma < 0 && /^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, ''); // 1.212
    const n = Number(s);
    return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

type TotalManual = NonNullable<DatosDocumento['total_manual']>;

// Total a mano: para un presupuesto que Bartez no tomó como tal (una foto, una
// lista), uno sin total claro, o para corregir el que leyó.
function FormTotal({ inicial, ocupado, onGuardar, onCancelar }: {
    inicial?: TotalManual;
    ocupado: boolean;
    onGuardar: (t: TotalManual) => void;
    onCancelar: () => void;
}) {
    const [monto, setMonto] = useState(inicial ? inicial.monto.toLocaleString('es-AR', { maximumFractionDigits: 2 }) : '');
    const [moneda, setMoneda] = useState<'USD' | 'ARS'>(inicial?.moneda ?? 'USD');
    const valor = numeroEscrito(monto);
    return (
        <form
            className="mem-total"
            aria-label="Total del presupuesto"
            onSubmit={(e) => { e.preventDefault(); if (valor) onGuardar({ monto: valor, moneda }); }}
            onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onCancelar(); } }}
        >
            <label className="mem-total-campo">
                <span>Total final (lo que paga el cliente)</span>
                <input
                    value={monto}
                    onChange={(e) => setMonto(e.target.value)}
                    inputMode="decimal"
                    autoFocus
                    placeholder="ej. 1.212"
                    aria-invalid={monto.trim() !== '' && !valor}
                />
            </label>
            <div className="segmentos" role="radiogroup" aria-label="Moneda">
                {(['USD', 'ARS'] as const).map((m) => (
                    <button key={m} type="button" role="radio" aria-checked={moneda === m} className={moneda === m ? 'on' : ''} onClick={() => setMoneda(m)}>
                        {m === 'USD' ? 'US$' : '$'}
                    </button>
                ))}
            </div>
            <div className="mem-total-acc">
                <button type="submit" className="btn-primario chico" disabled={!valor || ocupado}>{ocupado ? 'Guardando…' : 'Sumar a Cotizado'}</button>
                <button type="button" className="enlace" onClick={onCancelar} disabled={ocupado}>Cancelar</button>
            </div>
            {valor != null && <span className="mem-total-eco">Queda en el Cotizador por {plata(valor, moneda)}</span>}
        </form>
    );
}

// Si el documento es un presupuesto: si suma a Cotizado, cuánto, qué opción
// cuenta y cómo va (enviado, ganado, perdido). Si Bartez no lo tomó como
// presupuesto de Bartez, se puede corregir: "es nuestro" o el total a mano.
function BloquePresupuesto({ d, irA, onCambio, onError }: {
    d: DocumentoCliente;
    irA?: (tab: string) => void;
    onCambio: (d: DocumentoCliente) => void;
    onError: (e: unknown) => void;
}) {
    const [ocupado, setOcupado] = useState(false);
    const [cargando, setCargando] = useState(false);
    const datos = d.datos ?? null;
    const pres = datos?.presupuesto ?? null;

    async function cambiar(c: CambioCotizadoDoc) {
        setOcupado(true);
        try {
            onCambio((await cotizadoDocumento(d.id, c)).documento);
            setCargando(false);
        } catch (e) { onError(e); } finally { setOcupado(false); }
    }

    const form = (inicial?: TotalManual) => (
        <div className="mem-cot aparte">
            <FormTotal inicial={inicial} ocupado={ocupado} onGuardar={(total) => cambiar({ total })} onCancelar={() => setCargando(false)} />
        </div>
    );
    const cargar = (texto: string) => (
        <button type="button" className="enlace" onClick={() => setCargando(true)} disabled={ocupado}>{texto}</button>
    );

    // Bartez no lo tomó como presupuesto (o no lo pudo leer).
    if (!pres) {
        if (cargando) return form();
        return <div className="mem-cot-registrar">¿Es un presupuesto? {cargar('Registrarlo en el Cotizador')}</div>;
    }
    if (pres.emisor === 'otro' && !datos?.nuestro) {
        return (
            <div className="mem-cot aparte">
                Presupuesto de {pres.emisor_nombre ?? 'otra empresa'}: queda como referencia, no suma a Cotizado.{' '}
                <button type="button" className="enlace" onClick={() => cambiar({ nuestro: true })} disabled={ocupado}>Es nuestro: sumarlo</button>
            </div>
        );
    }
    if (!pres.opciones.length) {
        if (cargando) return form();
        return <div className="mem-cot aparte">Presupuesto sin un total claro: todavía no suma a Cotizado. {cargar('Cargar el total')}</div>;
    }
    if (d.sin_cotizado || !d.cotizacion) {
        return (
            <div className="mem-cot aparte">
                {d.sin_cotizado ? 'No suma a Cotizado.' : 'Todavía no sumó a Cotizado.'}{' '}
                <button type="button" className="enlace" onClick={() => cambiar({ contar: true })} disabled={ocupado}>
                    {d.sin_cotizado ? 'Sumarlo' : 'Reintentar'}
                </button>
            </div>
        );
    }

    const q = d.cotizacion;
    const cerrado = q.estado === 'ganada' || q.estado === 'perdida';
    const delCotizador = q.origen !== 'documento';
    const numero = q.numero_externo ?? pres.numero;
    const elegida = opcionQueCuenta(datos!);
    const fecha = pres.fecha ? new Date(`${pres.fecha}T12:00:00`).toLocaleDateString('es-AR') : null;
    const enPesos = pres.moneda === 'ARS' ? plata(pres.opciones[elegida]!.total, 'ARS') : null;
    if (cargando && !delCotizador && !cerrado) {
        return form(datos?.total_manual ?? { monto: pres.opciones[elegida]!.total, moneda: pres.moneda });
    }
    return (
        <div className={`mem-cot ev-${q.estado}`}>
            <div className="mem-cot-fila">
                <span className="mem-cot-marca">{q.estado === 'ganada' ? '✓ Ganado' : q.estado === 'perdida' ? 'Perdido' : 'Suma a Cotizado'}</span>
                {q.total_usd != null && <strong className="mem-cot-monto">{plata(q.total_usd)}</strong>}
                <span className="mem-cot-dato">{[enPesos, numero && `N° ${numero}`, fecha, datos?.total_manual && 'total cargado a mano'].filter(Boolean).join(' · ')}</span>
            </div>
            {delCotizador && <div className="mem-ayuda">Es el presupuesto N° {q.numero} que armaste en el Cotizador.</div>}
            {!delCotizador && pres.opciones.length > 1 && (
                <label className="mem-cot-opcion">
                    <span>Opción que cuenta</span>
                    <select value={elegida} disabled={ocupado || cerrado} onChange={(e) => cambiar({ opcion: Number(e.target.value) })}>
                        {pres.opciones.map((o, i) => <option key={i} value={i}>{o.nombre} · {plata(o.total, pres.moneda)}</option>)}
                    </select>
                </label>
            )}
            <div className="mem-cot-acc">
                {irA && <button type="button" className="enlace" onClick={() => { abrirEnCotizador(q.id); irA('cotizador'); }}>Ver en el Cotizador</button>}
                {!delCotizador && !cerrado && cargar('Corregir total')}
                {!delCotizador && !cerrado && (
                    <button type="button" className="enlace mem-cot-quitar" onClick={() => cambiar({ contar: false })} disabled={ocupado}>No sumarlo</button>
                )}
            </div>
        </div>
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

// **negrita** dentro de una línea.
function enLinea(texto: string): React.ReactNode {
    const partes = texto.split(/(\*\*[^*]+\*\*)/g);
    if (partes.length === 1) return texto;
    return partes.map((t, i) => (t.startsWith('**') && t.endsWith('**') && t.length > 4 ? <strong key={i}>{t.slice(2, -2)}</strong> : t));
}

export function formatearMarkdown(md: string): React.ReactNode {
    const lineas = md.split('\n');
    const out: React.ReactNode[] = [];
    let bullets: string[] = [];
    const flush = (k: string) => {
        if (bullets.length > 0) { out.push(<ul key={k}>{bullets.map((b, i) => <li key={i}>{enLinea(b)}</li>)}</ul>); bullets = []; }
    };
    lineas.forEach((raw, i) => {
        const l = raw.trim();
        if (!l) { flush(`u${i}`); return; }
        if (l.startsWith('### ')) { flush(`u${i}`); out.push(<h4 key={i}>{enLinea(l.slice(4))}</h4>); return; }
        if (l.startsWith('## ')) { flush(`u${i}`); out.push(<h3 key={i}>{enLinea(l.slice(3))}</h3>); return; }
        if (l.startsWith('# ')) { flush(`u${i}`); out.push(<h2 key={i}>{enLinea(l.slice(2))}</h2>); return; }
        if (l.startsWith('- ') || l.startsWith('* ')) { bullets.push(l.slice(2)); return; }
        flush(`u${i}`);
        out.push(<p key={i}>{enLinea(l)}</p>);
    });
    flush('final');
    return <>{out}</>;
}
