import { useEffect, useState } from 'react';
import {
    Cotizacion,
    CotizacionResumen,
    DatosCliente,
    Proveedor,
    actualizarProveedor,
    borrarCotizacion,
    crearCotizacion,
    listarCotizaciones,
    obtenerCotizacion,
    actualizarCotizacion,
    numeroPresupuesto,
    importarCsvProveedor,
    listarProveedores,
    sincronizarProveedor,
} from '../api/client.ts';

const usd = (n: number) => `USD ${n.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const ars = (n: number) => `$ ${n.toLocaleString('es-AR', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
const fecha = (iso: string) => new Date(iso).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

// La cotización abierta se recuerda en este navegador para reabrirla al volver a la pestaña.
const CLAVE_ABIERTA = 'bartez_cotizacion_abierta';
const recordarAbierta = (id: string | null) => {
    try { if (id) localStorage.setItem(CLAVE_ABIERTA, id); else localStorage.removeItem(CLAVE_ABIERTA); } catch { /* sin storage */ }
};
const leerAbierta = () => { try { return localStorage.getItem(CLAVE_ABIERTA); } catch { return null; } };

export function Cotizador() {
    const [pedido, setPedido] = useState('');
    const [cotizando, setCotizando] = useState(false);
    const [cot, setCot] = useState<Cotizacion | null>(null);
    const [error, setError] = useState<string>();
    const [provs, setProvs] = useState<Proveedor[]>([]);
    const [tc, setTc] = useState<{ valor: number; fuente: string } | null>(null);
    const [ocupado, setOcupado] = useState<string | null>(null);
    const [msgProv, setMsgProv] = useState<string | null>(null);

    const [historial, setHistorial] = useState<CotizacionResumen[]>([]);
    const [titulo, setTitulo] = useState('');
    const [datosCli, setDatosCli] = useState<DatosCliente>({});

    async function cargarHistorial() {
        try { setHistorial((await listarCotizaciones()).cotizaciones); } catch { /* el error principal ya se muestra arriba */ }
    }

    function mostrar(c: Cotizacion | null) {
        setCot(c);
        setTitulo(c?.titulo ?? '');
        setDatosCli(c?.datos_cliente ?? {});
        recordarAbierta(c?.id ?? null);
    }

    async function abrir(id: string) {
        setError(undefined);
        try { mostrar((await obtenerCotizacion(id)).cotizacion); } catch (e) {
            if (id === leerAbierta()) recordarAbierta(null);
            setError((e as Error).message);
        }
    }

    async function guardarTitulo() {
        if (!cot?.id || (cot.titulo ?? '') === titulo.trim()) return;
        try {
            await actualizarCotizacion(cot.id, { titulo: titulo.trim() || null });
            setCot({ ...cot, titulo: titulo.trim() || null });
            await cargarHistorial();
        } catch (e) { setError((e as Error).message); }
    }

    async function guardarDatosCli() {
        if (!cot?.id || JSON.stringify(cot.datos_cliente ?? {}) === JSON.stringify(datosCli)) return;
        try {
            await actualizarCotizacion(cot.id, { datos_cliente: datosCli });
            setCot({ ...cot, datos_cliente: datosCli });
        } catch (e) { setError((e as Error).message); }
    }

    const campoCli = (k: keyof DatosCliente) => ({
        value: datosCli[k] ?? '',
        onChange: (e: { target: { value: string } }) => setDatosCli((d) => ({ ...d, [k]: e.target.value })),
        onBlur: guardarDatosCli,
    });

    async function borrar(id: string) {
        if (!window.confirm('¿Borrar esta cotización? No se puede deshacer.')) return;
        try {
            await borrarCotizacion(id);
            if (cot?.id === id) mostrar(null);
            await cargarHistorial();
        } catch (e) { setError((e as Error).message); }
    }

    function nueva() {
        mostrar(null);
        setPedido('');
    }

    async function cargarProvs() {
        try {
            const r = await listarProveedores();
            setProvs(r.proveedores);
            setTc(r.tipo_cambio);
        } catch (e) { setError((e as Error).message); }
    }
    useEffect(() => {
        cargarProvs();
        cargarHistorial();
        const abierta = leerAbierta();
        if (abierta) abrir(abierta);
    }, []);

    async function cotizar() {
        if (!pedido.trim()) return;
        setCotizando(true);
        setError(undefined);
        setCot(null);
        try {
            const { cotizacion } = await crearCotizacion(pedido.trim());
            mostrar(cotizacion);
            await cargarHistorial();
        } catch (e) { setError((e as Error).message); }
        finally { setCotizando(false); }
    }

    async function sync(codigo: string) {
        setOcupado(codigo);
        setMsgProv(null);
        try {
            const { resultado } = await sincronizarProveedor(codigo);
            setMsgProv(resultado.ok ? `✓ ${codigo}: ${resultado.detalle ?? `${resultado.items} artículos sincronizados`}` : `✗ ${codigo}: ${resultado.detalle}`);
            await cargarProvs();
        } catch (e) { setError((e as Error).message); }
        finally { setOcupado(null); }
    }

    async function subirCsv(codigo: string, file: File) {
        const moneda = window.confirm('¿Los precios de esta lista están en DÓLARES?\n\nAceptar = USD · Cancelar = pesos (ARS)') ? 'USD' : 'ARS';
        setOcupado(codigo);
        setMsgProv(null);
        try {
            const texto = await file.text();
            const { resultado } = await importarCsvProveedor(codigo, texto, moneda);
            setMsgProv(resultado.ok ? `✓ ${codigo}: ${resultado.items} artículos importados del CSV` : `✗ ${codigo}: ${resultado.detalle}`);
            await cargarProvs();
        } catch (e) { setError((e as Error).message); }
        finally { setOcupado(null); }
    }

    async function cambiarMargen(p: Proveedor) {
        const v = window.prompt(`Margen para ${p.nombre} (%)`, String(p.margen_pct));
        if (v === null) return;
        const n = Number(v.replace(',', '.'));
        if (!Number.isFinite(n) || n < 0) { setError('Margen inválido'); return; }
        await actualizarProveedor(p.codigo, { margen_pct: n });
        await cargarProvs();
    }

    const [generandoPdf, setGenerandoPdf] = useState(false);

    async function generarPdf() {
        if (!cot) return;
        await guardarTitulo();
        await guardarDatosCli();
        if (!cot.lineas.some((l) => l.elegido)) { setError('La cotización no tiene artículos para presupuestar'); return; }
        setGenerandoPdf(true);
        try {
            const { descargarPresupuestoPdf } = await import('../lib/presupuestoPdf.ts');
            // El número se asigna la primera vez; después siempre es el mismo.
            const numero = cot.id ? (await numeroPresupuesto(cot.id)).numero : null;
            if (numero && numero !== cot.numero) setCot({ ...cot, numero });
            await descargarPresupuestoPdf({ ...cot, titulo: titulo.trim() || cot.titulo, datos_cliente: datosCli }, numero);
        } catch (e) { setError(`No se pudo generar el PDF: ${(e as Error).message}`); }
        finally { setGenerandoPdf(false); }
    }

    function copiarTexto() {
        if (!cot) return;
        const lineas = cot.lineas.filter((l) => l.elegido).map((l) => {
            const e = l.elegido!;
            return `- ${l.cantidad} x ${e.descripcion}${e.marca ? ` (${e.marca})` : ''} — ${usd(e.precio_unit_usd)} + IVA ${e.iva_pct}% c/u — subtotal ${usd(e.precio_unit_usd * l.cantidad)} + IVA`;
        });
        const txt = [
            'Cotización Bartez Tecnología',
            '',
            ...lineas,
            '',
            `Subtotal: ${usd(cot.subtotal_usd)}`,
            `IVA: ${usd(cot.iva_usd)}`,
            `Total: ${usd(cot.total_usd)} (${ars(cot.total_ars)} al tipo de cambio ${cot.tipo_cambio})`,
            '',
            'Precios sujetos a disponibilidad de stock y variación del tipo de cambio.',
        ].join('\n');
        navigator.clipboard.writeText(txt).then(() => setMsgProv('✓ Cotización copiada al portapapeles'));
    }

    return (
        <section className="cotizador">
            <div className="analitica-top">
                <div>
                    <h2>Cotizador</h2>
                    <p className="sub">
                        Pedí en lenguaje natural. El asistente busca en las listas de Elit, Air e Invid y elige artículos iguales o similares.
                        Precios con tu margen + IVA. {tc && <>Dólar: <strong>{tc.valor}</strong> ({tc.fuente}).</>}
                    </p>
                </div>
            </div>

            {error && <p className="error">Error: {error}</p>}

            <div className="cot-pedido">
                <textarea
                    rows={3}
                    value={pedido}
                    onChange={(e) => setPedido(e.target.value)}
                    placeholder="ej: 10 notebooks i5 con 16GB y SSD 512 para oficina, 2 switches de 24 puertos gigabit y 10 monitores de 24 pulgadas"
                />
                <button className="primario" onClick={cotizar} disabled={cotizando || !pedido.trim()}>
                    {cotizando ? 'Buscando en proveedores…' : 'Cotizar'}
                </button>
            </div>

            {cot && (
                <div className="cot-resultado">
                    <div className="cot-cabecera">
                        <input
                            className="cot-titulo"
                            value={titulo}
                            onChange={(e) => setTitulo(e.target.value)}
                            onBlur={guardarTitulo}
                            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                            placeholder="Nombre de la cotización (ej. cliente)"
                            disabled={!cot.id}
                        />
                        {cot.creado_en && <span className="mono">{fecha(cot.creado_en)}</span>}
                        <button className="secundario" onClick={nueva}>Nueva</button>
                        {cot.id && <button className="secundario peligro" onClick={() => borrar(cot.id!)}>Borrar</button>}
                    </div>
                    <div className="cot-pedido-original"><strong>Pedido:</strong> {cot.pedido}</div>
                    {cot.id && (
                        <details className="cot-datos-cli">
                            <summary>
                                Datos del cliente para el presupuesto
                                {cot.numero ? <span className="mono"> · N {new Date(cot.creado_en ?? Date.now()).getFullYear()}-{String(cot.numero).padStart(4, '0')}</span> : null}
                            </summary>
                            <div className="cot-datos-grid">
                                <label><span>CUIT</span><input {...campoCli('cuit')} placeholder="30-12345678-9" /></label>
                                <label><span>Atención</span><input {...campoCli('atencion')} placeholder="Nombre del contacto" /></label>
                                <label><span>Dirección</span><input {...campoCli('direccion')} placeholder="Calle y número" /></label>
                                <label><span>Localidad</span><input {...campoCli('localidad')} placeholder="Ciudad, provincia (CP)" /></label>
                                <label className="ancho">
                                    <span>Objeto del presupuesto</span>
                                    <textarea rows={2} {...campoCli('objeto')} placeholder="Si lo dejás vacío se arma solo con los artículos (ej. «Provisión de equipamiento IT según detalle…»)" />
                                </label>
                            </div>
                            <p className="sub">El nombre del cliente es el título de arriba. Todo se guarda solo.</p>
                        </details>
                    )}
                    {cot.comentario && <div className="det-signal"><strong>Notas del asistente:</strong> {cot.comentario}</div>}
                    <table className="cot-tabla">
                        <thead>
                            <tr>
                                <th>Pedido</th><th>Cant.</th><th>Artículo elegido</th><th>Proveedor</th>
                                <th className="num">Unit. s/IVA</th><th className="num">IVA</th><th className="num">Subtotal s/IVA</th>
                            </tr>
                        </thead>
                        <tbody>
                            {cot.lineas.map((l, i) => (
                                <tr key={i}>
                                    <td className="ped">{l.pedido}{l.nota && <div className="nota">{l.nota}</div>}</td>
                                    <td>{l.cantidad}</td>
                                    <td>
                                        {l.elegido ? (
                                            <>
                                                <div className="desc">{l.elegido.descripcion}</div>
                                                <div className="meta">{l.elegido.marca ?? ''} · SKU {l.elegido.sku} · stock {l.elegido.stock ?? '?'}</div>
                                                {l.alternativas.length > 0 && (
                                                    <details>
                                                        <summary>{l.alternativas.length} alternativa{l.alternativas.length > 1 ? 's' : ''}</summary>
                                                        {l.alternativas.map((a) => (
                                                            <div key={a.catalogo_id} className="alt">
                                                                {a.descripcion} — {a.proveedor} — {usd(a.precio_unit_usd)} s/IVA · stock {a.stock ?? '?'}
                                                            </div>
                                                        ))}
                                                    </details>
                                                )}
                                            </>
                                        ) : <span className="sin">No encontrado en catálogo</span>}
                                    </td>
                                    <td>{l.elegido?.proveedor ?? '—'}</td>
                                    <td className="num">{l.elegido ? usd(l.elegido.precio_unit_usd) : '—'}</td>
                                    <td className="num">{l.elegido ? `${l.elegido.iva_pct}%` : '—'}</td>
                                    <td className="num">{l.elegido ? usd(l.elegido.precio_unit_usd * l.cantidad) : '—'}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                    <div className="cot-totales">
                        <div><span>Subtotal</span><strong>{usd(cot.subtotal_usd)}</strong></div>
                        <div><span>IVA</span><strong>{usd(cot.iva_usd)}</strong></div>
                        <div className="total"><span>Total</span><strong>{usd(cot.total_usd)}</strong></div>
                        <div className="ars"><span>En pesos (TC {cot.tipo_cambio})</span><strong>{ars(cot.total_ars)}</strong></div>
                    </div>
                    <div className="cot-pie">
                        <span className="mono">{cot.busquedas} búsquedas · USD {cot.costo_ia_usd.toFixed(4)} IA · {Math.round(cot.duracion_ms / 1000)}s</span>
                        <div className="cot-pie-btns">
                            <button className="secundario" onClick={copiarTexto}>Copiar como texto</button>
                            <button className="secundario" onClick={generarPdf} disabled={generandoPdf}>
                                {generandoPdf ? 'Generando…' : 'Descargar PDF'}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            <h4 className="section-h">Cotizaciones guardadas</h4>
            {historial.length === 0 ? (
                <p className="sub">Todavía no hay cotizaciones guardadas.</p>
            ) : (
                <div className="cot-historial">
                    {historial.map((h) => (
                        <div
                            key={h.id}
                            className={`cot-hist-fila ${cot?.id === h.id ? 'activa' : ''}`}
                            onClick={() => abrir(h.id)}
                        >
                            <span className="mono">{fecha(h.creado_en)}</span>
                            <span className="cot-hist-txt">
                                {h.titulo && <strong>{h.titulo} · </strong>}
                                {h.pedido}
                            </span>
                            <span className="mono">{h.renglones} renglón{h.renglones === 1 ? '' : 'es'}</span>
                            <span className="num">{usd(h.total_usd)}</span>
                            <button
                                className="cot-hist-borrar"
                                title="Borrar"
                                onClick={(e) => { e.stopPropagation(); borrar(h.id); }}
                            >×</button>
                        </div>
                    ))}
                </div>
            )}

            <h4 className="section-h">Proveedores</h4>
            {msgProv && <div className={msgProv.startsWith('✗') ? 'msg-error' : 'msg-ok'}>{msgProv}</div>}
            <div className="prov-grid">
                {provs.map((p) => (
                    <div key={p.codigo} className={`prov-card est-${p.ultimo_estado ?? 'nunca'}`}>
                        <div className="prov-head">
                            <strong>{p.nombre}</strong>
                            <span className="prov-estado">{p.ultimo_estado ?? 'sin sincronizar'}</span>
                        </div>
                        <div className="prov-meta">
                            {p.items_sincronizados ?? 0} artículos · margen <a onClick={() => cambiarMargen(p)}>{p.margen_pct}%</a>
                        </div>
                        {p.ultima_sync && <div className="prov-meta">Última: {new Date(p.ultima_sync).toLocaleString('es-AR')}</div>}
                        {p.ultimo_detalle && <div className="prov-detalle">{p.ultimo_detalle}</div>}
                        <div className="prov-btns">
                            <button className="secundario" disabled={ocupado === p.codigo} onClick={() => sync(p.codigo)}>
                                {ocupado === p.codigo ? '…' : 'Sincronizar API'}
                            </button>
                            <label className="secundario file">
                                Importar CSV
                                <input
                                    type="file"
                                    accept=".csv,text/csv"
                                    onChange={(e) => { const f = e.target.files?.[0]; if (f) subirCsv(p.codigo, f); e.target.value = ''; }}
                                />
                            </label>
                        </div>
                    </div>
                ))}
            </div>
        </section>
    );
}
