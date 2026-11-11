import { useEffect, useState } from 'react';
import { Adjuntables, AdjuntoWa, adjuntablesWa } from '../../api/client.ts';

// Lo que se eligió para mandar: sale con el texto de la caja al tocar Enviar.
export interface AdjuntoElegido { origen: AdjuntoWa; etiqueta: string }

type Pestana = 'presupuestos' | 'ficha' | 'compu';

const MAX_MB = 15;
const MAX_MB_FOTO = 5;
const ACEPTA = '.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.jpg,.jpeg,.png';
const usd = (n: number) => `US$ ${n.toLocaleString('es-AR', { maximumFractionDigits: 0 })}`;
const dia = (iso: string) => new Date(iso).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: '2-digit' });
const peso = (b: number) => (b >= 1048576 ? `${(b / 1048576).toFixed(1).replace('.', ',')} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
const ESTADO: Record<string, string> = { abierta: 'sin mandar', enviada: 'enviado', ganada: 'ganado', perdida: 'perdido' };

// El número definitivo se asigna al mandarlo (igual que al descargar el PDF).
const numeroDe = (p: { numero: number | null; numero_externo: string | null; creado_en: string }) =>
    p.numero ? `N° ${new Date(p.creado_en).getFullYear()}-${String(p.numero).padStart(4, '0')}` : p.numero_externo ? `N° ${p.numero_externo}` : null;

export function ElegirAdjunto({ waId, alElegir, alCerrar }: {
    waId: string;
    alElegir: (a: AdjuntoElegido) => void;
    alCerrar: () => void;
}) {
    const [ops, setOps] = useState<Adjuntables | null>(null);
    const [error, setError] = useState<string>();
    const [pestana, setPestana] = useState<Pestana>('presupuestos');
    const [leyendo, setLeyendo] = useState(false);

    useEffect(() => {
        let vivo = true;
        adjuntablesWa(waId)
            .then((r) => { if (vivo) setOps(r); })
            .catch((e) => { if (vivo) setError((e as Error).message); });
        return () => { vivo = false; };
    }, [waId]);

    function desdeLaCompu(f: File | undefined) {
        if (!f) return;
        setError(undefined);
        const esFoto = f.type.startsWith('image/');
        const maxMb = esFoto ? MAX_MB_FOTO : MAX_MB;
        if (f.size > maxMb * 1024 * 1024) { setError(`WhatsApp acepta ${esFoto ? 'fotos' : 'archivos'} de hasta ${maxMb} MB.`); return; }
        setLeyendo(true);
        const lector = new FileReader();
        lector.onload = () => {
            const datos = String(lector.result ?? '');
            setLeyendo(false);
            alElegir({
                origen: { tipo: 'archivo', nombre: f.name, mime: f.type || undefined, base64: datos.slice(datos.indexOf(',') + 1) },
                etiqueta: `${f.name} · ${peso(f.size)}`,
            });
        };
        lector.onerror = () => { setLeyendo(false); setError('No se pudo leer el archivo.'); };
        lector.readAsDataURL(f);
    }

    const propios = ops?.presupuestos.filter((p) => p.del_cliente) ?? [];
    const sueltos = ops?.presupuestos.filter((p) => !p.del_cliente) ?? [];

    const filaPresupuesto = (p: Adjuntables['presupuestos'][number]) => (
        <li key={p.id}>
            <button
                type="button" className="wa-adj-fila"
                onClick={() => alElegir({ origen: { tipo: 'cotizacion', id: p.id }, etiqueta: `Presupuesto ${numeroDe(p) ?? ''}${p.titulo ? ` · ${p.titulo}` : ''}`.replace('  ', ' ') })}
            >
                <span className="wa-adj-principal">
                    <strong>{numeroDe(p) ?? 'Sin N°'}</strong>
                    <span className="wa-adj-titulo">{p.titulo || 'Sin título'}</span>
                </span>
                <span className="wa-adj-meta">
                    {p.total_usd > 0 ? usd(p.total_usd) : ''} · {dia(p.creado_en)} · {ESTADO[p.estado] ?? p.estado}
                    {p.de_documento ? ' · archivo original' : ''}
                </span>
            </button>
        </li>
    );

    return (
        <div className="wa-adjuntar" role="group" aria-label="Adjuntar un archivo">
            <div className="wa-adj-cab">
                <div className="segmentos" role="tablist" aria-label="Qué mandar">
                    <button role="tab" type="button" aria-selected={pestana === 'presupuestos'} className={pestana === 'presupuestos' ? 'on' : ''} onClick={() => setPestana('presupuestos')}>Presupuesto</button>
                    <button role="tab" type="button" aria-selected={pestana === 'ficha'} className={pestana === 'ficha' ? 'on' : ''} onClick={() => setPestana('ficha')}>De la ficha</button>
                    <button role="tab" type="button" aria-selected={pestana === 'compu'} className={pestana === 'compu' ? 'on' : ''} onClick={() => setPestana('compu')}>Desde la compu</button>
                </div>
                <button type="button" className="enlace wa-adj-cerrar" onClick={alCerrar} aria-label="Cerrar">✕</button>
            </div>

            {error && <p className="wa-error" role="alert">{error}</p>}
            {!ops && !error && <p className="tenue wa-adj-vacio">Cargando…</p>}

            {ops && pestana === 'presupuestos' && (
                propios.length + sueltos.length === 0
                    ? <p className="tenue wa-adj-vacio">No hay presupuestos para mandar. Armalo en el Cotizador y volvé acá.</p>
                    : (
                        <div className="wa-adj-lista">
                            {propios.length > 0 && <>
                                <span className="wa-adj-grupo">De {ops.cliente_nombre ?? 'este cliente'}</span>
                                <ul>{propios.map(filaPresupuesto)}</ul>
                            </>}
                            {sueltos.length > 0 && <>
                                <span className="wa-adj-grupo">Recientes sin cliente</span>
                                <ul>{sueltos.map(filaPresupuesto)}</ul>
                            </>}
                        </div>
                    )
            )}

            {ops && pestana === 'ficha' && (
                !ops.cliente_id
                    ? <p className="tenue wa-adj-vacio">La conversación no tiene un cliente vinculado. Vinculalo arriba para ver sus documentos.</p>
                    : ops.documentos.length === 0
                        ? <p className="tenue wa-adj-vacio">{ops.cliente_nombre ?? 'El cliente'} no tiene documentos en la ficha.</p>
                        : (
                            <div className="wa-adj-lista">
                                <ul>
                                    {ops.documentos.map((d) => (
                                        <li key={d.id}>
                                            <button
                                                type="button" className="wa-adj-fila" disabled={!d.se_puede}
                                                title={d.se_puede ? undefined : 'WhatsApp no deja mandar este tipo de archivo'}
                                                onClick={() => alElegir({ origen: { tipo: 'documento', id: d.id }, etiqueta: `${d.nombre} · ${peso(d.tamano_bytes)}` })}
                                            >
                                                <span className="wa-adj-principal"><span className="wa-adj-titulo">{d.nombre}</span></span>
                                                <span className="wa-adj-meta">{peso(d.tamano_bytes)} · {dia(d.creado_en)}{d.se_puede ? '' : ' · no se puede mandar'}</span>
                                            </button>
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        )
            )}

            {pestana === 'compu' && (
                <label className="wa-adj-compu">
                    <input type="file" accept={ACEPTA} onChange={(e) => { desdeLaCompu(e.target.files?.[0]); e.target.value = ''; }} disabled={leyendo} />
                    <span className="secundario wa-adj-elegir">{leyendo ? 'Leyendo…' : 'Elegir archivo'}</span>
                    <span className="tenue">PDF, Word, Excel, PowerPoint o texto (hasta {MAX_MB} MB) y fotos JPG/PNG (hasta {MAX_MB_FOTO} MB).</span>
                </label>
            )}

            {ops?.media_en_la_web === 'no' && (
                <p className="tenue wa-adj-nota">Por ahora sale como un link para abrir el archivo: la web todavía no manda adjuntos.</p>
            )}
        </div>
    );
}
