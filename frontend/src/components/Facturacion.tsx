// Facturación: todas las facturas y pedidos de Asimov, las cobranzas pendientes
// y el armado de facturas nuevas. Lo que se manda llega a Asimov como borrador:
// el CAE se pide desde Asimov con "Autorizar ARCA".

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
    CobranzaAsimov, FacturaAsimov, PedidoAsimov, PedidoNuevaFactura, PreparadaFactura, ResumenFacturacion,
    enviarFacturaAsimov, prepararFacturaDePedido, prepararFacturaPanel, recordatorioCobranza, resumenFacturacion,
} from '../api/client.ts';

type Vista = 'facturas' | 'pedidos' | 'cobranzas';
const VISTAS: Array<[Vista, string]> = [['facturas', 'Facturas'], ['pedidos', 'Pedidos'], ['cobranzas', 'Cobranzas']];
const PERIODOS: Array<[number, string]> = [[30, 'Últimos 30 días'], [90, 'Últimos 90 días'], [180, 'Últimos 6 meses'], [365, 'Último año']];
const ALICUOTAS = [21, 10.5, 27, 5, 2.5];

const plata = (n: number) => `$ ${n.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fecha = (f: string | null) => (f ? f.split('-').reverse().join('/') : '—');
const diasAntes = (n: number) => new Date(Date.now() - n * 86_400_000).toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });
const leer = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const guardar = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* sin storage */ } };

const ESTADO: Record<string, { texto: string; clase: string }> = {
    autorizada: { texto: 'Autorizada', clase: 'ok' },
    borrador: { texto: 'Por autorizar', clase: 'medio' },
    pendiente_cae: { texto: 'Reintentar ARCA', clase: 'medio' },
    rechazada: { texto: 'Rechazada por ARCA', clase: 'mal' },
};
const estadoFactura = (e: string) => ESTADO[e] ?? { texto: e, clase: '' };

export function Facturacion() {
    const [vista, setVistaState] = useState<Vista>(() => (leer('bartez_fac_vista') as Vista) || 'facturas');
    const [dias, setDias] = useState<number>(() => Number(leer('bartez_fac_dias')) || 90);
    const [r, setR] = useState<ResumenFacturacion | null>(null);
    const [error, setError] = useState<string>();
    const [aviso, setAviso] = useState<{ ok: boolean; texto: string } | null>(null);
    const [cargando, setCargando] = useState(false);
    const [filtro, setFiltro] = useState<'todas' | 'autorizar' | 'autorizadas' | 'rechazadas' | 'ai'>('todas');
    const [buscar, setBuscar] = useState('');
    const [detalle, setDetalle] = useState<FacturaAsimov | null>(null);
    const [nueva, setNueva] = useState<{ preparada?: PreparadaFactura & { ok: true } } | null>(null);
    const [ocupado, setOcupado] = useState<string>('');

    const setVista = (v: Vista) => { setVistaState(v); guardar('bartez_fac_vista', v); };

    const cargar = useCallback(async () => {
        setCargando(true); setError(undefined);
        try { setR(await resumenFacturacion(diasAntes(dias))); }
        catch (e) { setError((e as Error).message); }
        finally { setCargando(false); }
    }, [dias]);
    useEffect(() => { void cargar(); }, [cargar]);

    const q = buscar.trim().toLowerCase();
    const coincide = (c: string | null, n: string) => !q || (c ?? '').toLowerCase().includes(q) || n.toLowerCase().includes(q);
    const facturas = useMemo(() => (r?.facturas ?? []).filter((f) => coincide(f.cliente, f.numero) && (
        filtro === 'todas' || (filtro === 'autorizar' && f.estado !== 'autorizada' && f.estado !== 'rechazada') || (filtro === 'autorizadas' && f.estado === 'autorizada')
        || (filtro === 'rechazadas' && f.estado === 'rechazada') || (filtro === 'ai' && f.de_bartez_ai))), [r, filtro, q]); // eslint-disable-line react-hooks/exhaustive-deps
    const pedidos = useMemo(() => (r?.pedidos ?? []).filter((p) => coincide(p.cliente, p.numero)), [r, q]); // eslint-disable-line react-hooks/exhaustive-deps
    const cobranzas = useMemo(() => (r?.cobranzas ?? []).filter((c) => coincide(c.factura.cliente, c.factura.numero)), [r, q]); // eslint-disable-line react-hooks/exhaustive-deps
    const cuenta = {
        autorizar: (r?.facturas ?? []).filter((f) => f.estado !== 'autorizada' && f.estado !== 'rechazada').length,
        rechazadas: (r?.facturas ?? []).filter((f) => f.estado === 'rechazada').length,
        ai: (r?.facturas ?? []).filter((f) => f.de_bartez_ai).length,
        vencidas: (r?.cobranzas ?? []).filter((c) => c.vencida).length,
    };

    async function facturarPedido(p: PedidoAsimov) {
        setOcupado(p.id); setError(undefined);
        try {
            const res = await prepararFacturaDePedido(p.id);
            if (res.ok) setNueva({ preparada: res });
            else setAviso({ ok: false, texto: res.motivo });
        } catch (e) { setError((e as Error).message); }
        finally { setOcupado(''); }
    }

    async function recordar(c: CobranzaAsimov) {
        setOcupado(c.factura.id); setError(undefined);
        try { const res = await recordatorioCobranza(c.factura.id); setAviso({ ok: true, texto: res.detalle }); await cargar(); }
        catch (e) { setAviso({ ok: false, texto: (e as Error).message }); }
        finally { setOcupado(''); }
    }

    return (
        <section className="facturacion">
            <header className="fac-cab">
                <div>
                    <h2>Facturación</h2>
                    <p className="sub">Facturas, pedidos y cobranzas de Asimov. Lo que armás acá llega a Asimov como borrador y se autoriza desde ahí.</p>
                </div>
                <nav className="segmentos" aria-label="Secciones de Facturación">
                    {VISTAS.map(([id, etq]) => (
                        <button key={id} className={vista === id ? 'on' : ''} aria-current={vista === id ? 'page' : undefined} onClick={() => setVista(id)}>
                            {etq}{id === 'cobranzas' && cuenta.vencidas ? <span className="cab-num">{cuenta.vencidas}</span> : null}
                        </button>
                    ))}
                </nav>
                <div className="fac-botones">
                    <button className="boton-fantasma" onClick={() => void cargar()} disabled={cargando}>{cargando ? 'Actualizando…' : 'Actualizar'}</button>
                    <button className="pub-primario" onClick={() => setNueva({})} disabled={r ? !r.configurado : false}>+ Nueva factura</button>
                </div>
            </header>

            {error && <p className="error" role="alert">Error: {error}</p>}
            {aviso && <p className={`pub-aviso ${aviso.ok ? 'ok' : 'mal'}`} role="status">{aviso.texto} <button className="enlace" onClick={() => setAviso(null)}>Cerrar</button></p>}
            {r && !r.configurado && <p className="pub-aviso mal">Falta cargar en Railway: {r.faltan.map((f) => <code key={f}>{f}</code>)}.</p>}
            {r && r.configurado && !r.api_lista && (
                <p className="pub-aviso">Asimov todavía no tiene publicada la consulta de documentos, así que no se pueden listar sus facturas y pedidos. Falta aprobar el cambio en su repo (PR #1 de asimov-app). Mientras tanto podés armar y mandar facturas.</p>
            )}

            {r?.api_lista && (
                <div className="fac-kpis">
                    <div><span>Facturado (autorizado)</span><strong>{plata(r.totales.facturado)}</strong><small>{PERIODOS.find(([d]) => d === dias)?.[1].toLowerCase()}</small></div>
                    <div className={r.totales.por_autorizar ? 'atencion' : ''}><span>Por autorizar en Asimov</span><strong>{r.totales.por_autorizar}</strong><small>{r.totales.por_autorizar === 1 ? 'factura' : 'facturas'}</small></div>
                    <div><span>Por cobrar</span><strong>{plata(r.totales.por_cobrar)}</strong><small>{r.cobranzas.length} {r.cobranzas.length === 1 ? 'factura' : 'facturas'}</small></div>
                    <div className={r.totales.vencido ? 'mal' : ''}><span>Vencido</span><strong>{plata(r.totales.vencido)}</strong><small>{cuenta.vencidas} {cuenta.vencidas === 1 ? 'factura' : 'facturas'}</small></div>
                </div>
            )}

            {r?.api_lista && (
                <div className="fac-filtros">
                    <label className="solo-lector" htmlFor="fac-buscar">Buscar</label>
                    <input id="fac-buscar" type="search" placeholder="Buscar cliente o número…" value={buscar} onChange={(e) => setBuscar(e.target.value)} />
                    {vista === 'facturas' && (
                        <div className="fac-chips">
                            {([['todas', `Todas (${r.facturas.length})`], ['autorizar', `Por autorizar (${cuenta.autorizar})`], ['autorizadas', 'Autorizadas'], ['rechazadas', `Rechazadas (${cuenta.rechazadas})`], ['ai', `De Bartez AI (${cuenta.ai})`]] as const).map(([id, etq]) => (
                                <button key={id} className={`chip ${filtro === id ? 'on' : ''}`} onClick={() => setFiltro(id)}>{etq}</button>
                            ))}
                        </div>
                    )}
                    <label htmlFor="fac-periodo" className="solo-lector">Período</label>
                    <select id="fac-periodo" value={dias} onChange={(e) => { setDias(Number(e.target.value)); guardar('bartez_fac_dias', e.target.value); }}>
                        {PERIODOS.map(([d, etq]) => <option key={d} value={d}>{etq}</option>)}
                    </select>
                </div>
            )}

            {r?.api_lista && vista === 'facturas' && (
                facturas.length === 0 ? <p className="fac-vacio">No hay facturas {filtro !== 'todas' || q ? 'con ese filtro' : 'en el período'}.</p> : (
                    <div className="fac-tabla" role="table" aria-label="Facturas">
                        <div className="fac-fila fac-titulos" role="row"><span role="columnheader">Fecha</span><span role="columnheader">Comprobante</span><span role="columnheader">Cliente</span><span role="columnheader">Estado</span><span role="columnheader" className="num">Total</span><span role="columnheader" className="num">Saldo</span></div>
                        {facturas.map((f) => (
                            <button key={f.id} className="fac-fila" role="row" onClick={() => setDetalle(f)}>
                                <span role="cell">{fecha(f.fecha)}</span>
                                <span role="cell" className="fac-nro">{f.tipo} {f.numero}{f.de_bartez_ai && <span className="fac-ai" title="Preparada por Bartez AI">AI</span>}</span>
                                <span role="cell" className="fac-cliente">{f.cliente ?? '—'}</span>
                                <span role="cell"><span className={`pub-estado ${estadoFactura(f.estado).clase}`}>{estadoFactura(f.estado).texto}</span></span>
                                <span role="cell" className="num">{plata(f.total)}</span>
                                <span role="cell" className="num">{f.estado === 'autorizada' ? (f.saldo > 0.5 ? plata(f.saldo) : <span className="fac-cobrada">Cobrada</span>) : '—'}</span>
                            </button>
                        ))}
                    </div>
                )
            )}

            {r?.api_lista && vista === 'pedidos' && (
                pedidos.length === 0 ? <p className="fac-vacio">No hay pedidos en el período.</p> : (
                    <div className="fac-tabla" role="table" aria-label="Pedidos">
                        <div className="fac-fila fac-titulos fac-pedidos" role="row"><span role="columnheader">Fecha</span><span role="columnheader">Pedido</span><span role="columnheader">Cliente</span><span role="columnheader">Estado</span><span role="columnheader" className="num">Total</span><span role="columnheader" /></div>
                        {pedidos.map((p) => {
                            const facturado = !!p.facturado_por_ai || /factur/i.test(p.estado);
                            return (
                                <div key={p.id} className="fac-fila fac-pedidos" role="row">
                                    <span role="cell">{fecha(p.fecha)}</span>
                                    <span role="cell" className="fac-nro">{p.numero}</span>
                                    <span role="cell" className="fac-cliente">{p.cliente ?? '—'}<small>{p.renglones.length} {p.renglones.length === 1 ? 'renglón' : 'renglones'}{p.entrega ? ` · entrega ${fecha(p.entrega)}` : ''}</small></span>
                                    <span role="cell"><span className={`pub-estado ${facturado ? 'ok' : ''}`}>{p.facturado_por_ai ? 'Facturado (Bartez AI)' : p.estado}</span></span>
                                    <span role="cell" className="num">{plata(p.total)}</span>
                                    <span role="cell" className="fac-accion">
                                        <button className="boton-fantasma" onClick={() => void facturarPedido(p)} disabled={!!ocupado || facturado} title={facturado ? 'Este pedido ya está facturado' : undefined}>
                                            {ocupado === p.id ? 'Armando…' : 'Facturar'}
                                        </button>
                                    </span>
                                </div>
                            );
                        })}
                    </div>
                )
            )}

            {r?.api_lista && vista === 'cobranzas' && (
                cobranzas.length === 0 ? <p className="fac-vacio">No hay facturas con saldo pendiente.</p> : (
                    <div className="fac-tabla" role="table" aria-label="Cobranzas">
                        <div className="fac-fila fac-titulos fac-cobr" role="row"><span role="columnheader">Cliente</span><span role="columnheader">Factura</span><span role="columnheader">Antigüedad</span><span role="columnheader" className="num">Saldo</span><span role="columnheader" /></div>
                        {cobranzas.map((c) => (
                            <div key={c.factura.id} className={`fac-fila fac-cobr ${c.vencida ? 'vencida' : ''}`} role="row">
                                <span role="cell" className="fac-cliente">{c.factura.cliente ?? '—'}</span>
                                <span role="cell"><button className="enlace" onClick={() => setDetalle(c.factura)}>{c.factura.tipo} {c.factura.numero}</button><small> · {fecha(c.factura.fecha)}</small></span>
                                <span role="cell">{c.dias} días {c.vencida && <span className="pub-estado mal">Vencida</span>}</span>
                                <span role="cell" className="num">{plata(c.factura.saldo)}{c.factura.cobrado > 0 && <small> de {plata(c.factura.total)}</small>}</span>
                                <span role="cell" className="fac-accion">
                                    <button className="boton-fantasma" onClick={() => void recordar(c)} disabled={!!ocupado || c.recordatorio_pendiente}>
                                        {c.recordatorio_pendiente ? 'Recordatorio en Para aprobar' : ocupado === c.factura.id ? 'Armando…' : 'Mandar recordatorio'}
                                    </button>
                                </span>
                            </div>
                        ))}
                    </div>
                )
            )}

            {detalle && <DetalleFactura f={detalle} cerrar={() => setDetalle(null)} />}
            {nueva && (
                <NuevaFactura
                    inicial={nueva.preparada}
                    cerrar={() => setNueva(null)}
                    listo={(texto) => { setNueva(null); setAviso({ ok: true, texto }); void cargar(); }}
                />
            )}
        </section>
    );
}

function DetalleFactura({ f, cerrar }: { f: FacturaAsimov; cerrar: () => void }) {
    useEffect(() => {
        const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') cerrar(); };
        window.addEventListener('keydown', esc);
        return () => window.removeEventListener('keydown', esc);
    }, [cerrar]);
    const est = estadoFactura(f.estado);
    return (
        <div className="pub-modal-fondo pub-lado" onMouseDown={(e) => { if (e.target === e.currentTarget) cerrar(); }}>
            <aside className="pub-cajon fac-detalle" role="dialog" aria-modal="true" aria-labelledby="fac-det-titulo">
                <header className="det-cab">
                    <div>
                        <div className="det-ruta">{fecha(f.fecha)}{f.de_bartez_ai ? ' · preparada por Bartez AI' : ''}</div>
                        <h2 id="fac-det-titulo">Factura {f.tipo} {f.numero}</h2>
                        <p className="fac-det-cliente">{f.cliente ?? '—'}</p>
                    </div>
                    <span className={`pub-estado ${est.clase}`}>{est.texto}</span>
                    <button className="pub-cerrar" onClick={cerrar} aria-label="Cerrar">✕</button>
                </header>
                {f.error_arca && <p className="pub-aviso mal">ARCA: {f.error_arca}</p>}
                {f.estado !== 'autorizada' && !f.error_arca && <p className="pub-aviso">Todavía no tiene CAE: se autoriza desde Asimov con “Autorizar ARCA”.</p>}
                <table className="fac-renglones">
                    <thead><tr><th>Descripción</th><th className="num">Cant.</th><th className="num">Unitario s/IVA</th><th className="num">IVA</th><th className="num">Subtotal</th></tr></thead>
                    <tbody>
                        {f.renglones.map((x, i) => <tr key={i}><td>{x.descripcion}</td><td className="num">{x.cantidad}</td><td className="num">{plata(x.precio)}</td><td className="num">{x.iva}%</td><td className="num">{plata(x.subtotal)}</td></tr>)}
                    </tbody>
                </table>
                <dl className="fac-totales">
                    <div><dt>Neto</dt><dd>{plata(f.neto)}</dd></div>
                    <div><dt>IVA</dt><dd>{plata(f.iva)}</dd></div>
                    <div className="total"><dt>Total</dt><dd>{plata(f.total)}</dd></div>
                    {f.estado === 'autorizada' && <div><dt>Cobrado</dt><dd>{plata(f.cobrado)}{f.saldo > 0.5 ? ` · saldo ${plata(f.saldo)}` : ''}</dd></div>}
                </dl>
                <dl className="fac-datos">
                    {f.cae && <div><dt>CAE</dt><dd><code>{f.cae}</code></dd></div>}
                    {f.moneda === 'USD' && f.dolar && <div><dt>Precios en dólares</dt><dd>a {plata(f.dolar)}</dd></div>}
                    {f.vence && <div><dt>Vence</dt><dd>{fecha(f.vence)}</dd></div>}
                </dl>
            </aside>
        </div>
    );
}

type Renglon = { descripcion: string; codigo: string; cantidad: string; precio: string; iva: string };
const renglonVacio = (): Renglon => ({ descripcion: '', codigo: '', cantidad: '1', precio: '', iva: '21' });
const numero = (s: string) => Number(s.replace(/\./g, '').replace(',', '.'));

function NuevaFactura({ inicial, cerrar, listo }: { inicial?: PreparadaFactura & { ok: true }; cerrar: () => void; listo: (texto: string) => void }) {
    const [cliente, setCliente] = useState('');
    const [esNuevo, setEsNuevo] = useState(false);
    const [nuevo, setNuevo] = useState({ razon_social: '', cuit: '', condicion_iva: 'responsable_inscripto', email: '' });
    const [moneda, setMoneda] = useState<'ARS' | 'USD'>('USD');
    const [conIva, setConIva] = useState(false);
    const [dolar, setDolar] = useState('');
    const [renglones, setRenglones] = useState<Renglon[]>([renglonVacio()]);
    const [obs, setObs] = useState('');
    const [prep, setPrep] = useState<PreparadaFactura | null>(inicial ?? null);
    const [ocupado, setOcupado] = useState<'' | 'calcular' | 'enviar'>('');
    const [error, setError] = useState<string>();

    useEffect(() => {
        const esc = (e: KeyboardEvent) => { if (e.key === 'Escape' && !ocupado) cerrar(); };
        window.addEventListener('keydown', esc);
        return () => window.removeEventListener('keydown', esc);
    }, [cerrar, ocupado]);

    const cambiar = (i: number, k: keyof Renglon, v: string) => { setRenglones((rs) => rs.map((r, j) => (j === i ? { ...r, [k]: v } : r))); setPrep(null); };

    async function calcular() {
        setError(undefined);
        const rs = renglones.filter((r) => r.descripcion.trim() || r.precio.trim());
        if (!esNuevo && cliente.trim().length < 2) { setError('Poné el cliente (razón social o CUIT).'); return; }
        if (esNuevo && nuevo.razon_social.trim().length < 2) { setError('Poné la razón social del cliente nuevo.'); return; }
        if (!rs.length) { setError('Agregá al menos un renglón.'); return; }
        for (const r of rs) {
            if (!r.descripcion.trim() || !(numero(r.cantidad) > 0) || !(numero(r.precio) > 0)) { setError('Cada renglón necesita descripción, cantidad y precio.'); return; }
        }
        const d: PedidoNuevaFactura = {
            cliente: esNuevo ? nuevo.razon_social : cliente,
            cliente_nuevo: esNuevo ? { razon_social: nuevo.razon_social.trim(), cuit: nuevo.cuit.trim() || null, condicion_iva: nuevo.condicion_iva, email: nuevo.email.trim() || null } : null,
            renglones: rs.map((r) => ({ descripcion: r.descripcion.trim(), cantidad: numero(r.cantidad), precio_unitario: numero(r.precio), codigo: r.codigo.trim() || null, iva_pct: Number(r.iva) })),
            moneda, precios_con_iva: conIva, cotizacion_usd: moneda === 'USD' && numero(dolar) > 0 ? numero(dolar) : null, observaciones: obs.trim() || null,
        };
        setOcupado('calcular');
        try { setPrep(await prepararFacturaPanel(d)); }
        catch (e) { setError((e as Error).message); }
        finally { setOcupado(''); }
    }

    async function enviar() {
        if (!prep?.ok) return;
        setOcupado('enviar'); setError(undefined);
        try { const r = await enviarFacturaAsimov(prep.factura_id); listo(r.detalle); }
        catch (e) { setError((e as Error).message); }
        finally { setOcupado(''); }
    }

    const soloVista = !!inicial;
    return (
        <div className="pub-modal-fondo" onMouseDown={(e) => { if (e.target === e.currentTarget && !ocupado) cerrar(); }}>
            <div className="pub-modal fac-nueva" role="dialog" aria-modal="true" aria-labelledby="fac-nueva-titulo">
                <div className="gen-cab">
                    <h2 id="fac-nueva-titulo">{soloVista ? 'Factura del pedido' : 'Nueva factura'}</h2>
                    <button className="pub-cerrar" onClick={cerrar} aria-label="Cerrar" disabled={!!ocupado}>✕</button>
                </div>

                {!soloVista && (
                    <div className="fac-form">
                        <div className="fac-form-fila">
                            {!esNuevo ? (
                                <label htmlFor="fac-cliente" className="fac-ancho">Cliente
                                    <input id="fac-cliente" value={cliente} onChange={(e) => { setCliente(e.target.value); setPrep(null); }} placeholder="Razón social o CUIT, como está en Asimov" />
                                </label>
                            ) : (
                                <>
                                    <label htmlFor="fac-rs" className="fac-ancho">Razón social<input id="fac-rs" value={nuevo.razon_social} onChange={(e) => { setNuevo({ ...nuevo, razon_social: e.target.value }); setPrep(null); }} /></label>
                                    <label htmlFor="fac-cuit">CUIT<input id="fac-cuit" inputMode="numeric" value={nuevo.cuit} onChange={(e) => { setNuevo({ ...nuevo, cuit: e.target.value }); setPrep(null); }} placeholder="30-12345678-9" /></label>
                                    <label htmlFor="fac-cond">Condición de IVA
                                        <select id="fac-cond" value={nuevo.condicion_iva} onChange={(e) => { setNuevo({ ...nuevo, condicion_iva: e.target.value }); setPrep(null); }}>
                                            <option value="responsable_inscripto">Responsable inscripto</option>
                                            <option value="monotributista">Monotributista</option>
                                            <option value="exento">Exento</option>
                                            <option value="consumidor_final">Consumidor final</option>
                                        </select>
                                    </label>
                                    <label htmlFor="fac-mail">Email<input id="fac-mail" type="email" value={nuevo.email} onChange={(e) => setNuevo({ ...nuevo, email: e.target.value })} /></label>
                                </>
                            )}
                        </div>
                        <label className="fac-check"><input type="checkbox" checked={esNuevo} onChange={(e) => { setEsNuevo(e.target.checked); setPrep(null); }} /> Es un cliente nuevo (se da de alta en Asimov al mandar la factura)</label>

                        <div className="fac-form-fila">
                            <label htmlFor="fac-moneda">Precios en
                                <select id="fac-moneda" value={moneda} onChange={(e) => { setMoneda(e.target.value as 'ARS' | 'USD'); setPrep(null); }}>
                                    <option value="USD">Dólares</option><option value="ARS">Pesos</option>
                                </select>
                            </label>
                            <label htmlFor="fac-coniva">Los precios son
                                <select id="fac-coniva" value={conIva ? 'con' : 'mas'} onChange={(e) => { setConIva(e.target.value === 'con'); setPrep(null); }}>
                                    <option value="mas">Sin IVA (más IVA)</option><option value="con">Con IVA incluido</option>
                                </select>
                            </label>
                            {moneda === 'USD' && (
                                <label htmlFor="fac-dolar">Dólar<input id="fac-dolar" inputMode="decimal" value={dolar} onChange={(e) => { setDolar(e.target.value); setPrep(null); }} placeholder="Oficial del día" /></label>
                            )}
                        </div>

                        <div className="fac-items" role="group" aria-label="Renglones">
                            <div className="fac-item fac-item-tit" aria-hidden="true"><span>Descripción</span><span>Código</span><span>Cant.</span><span>Precio unitario</span><span>IVA</span><span /></div>
                            {renglones.map((r, i) => (
                                <div key={i} className="fac-item">
                                    <input aria-label={`Descripción del renglón ${i + 1}`} value={r.descripcion} onChange={(e) => cambiar(i, 'descripcion', e.target.value)} placeholder="Notebook Lenovo ThinkPad L14" />
                                    <input aria-label={`Código del renglón ${i + 1}`} value={r.codigo} onChange={(e) => cambiar(i, 'codigo', e.target.value)} placeholder="Opcional" />
                                    <input aria-label={`Cantidad del renglón ${i + 1}`} inputMode="decimal" value={r.cantidad} onChange={(e) => cambiar(i, 'cantidad', e.target.value)} />
                                    <input aria-label={`Precio del renglón ${i + 1}`} inputMode="decimal" value={r.precio} onChange={(e) => cambiar(i, 'precio', e.target.value)} placeholder={moneda === 'USD' ? 'US$' : '$'} />
                                    <select aria-label={`IVA del renglón ${i + 1}`} value={r.iva} onChange={(e) => cambiar(i, 'iva', e.target.value)}>
                                        {ALICUOTAS.map((a) => <option key={a} value={a}>{String(a).replace('.', ',')}%</option>)}
                                    </select>
                                    <button className="fac-quitar" onClick={() => { setRenglones((rs) => (rs.length > 1 ? rs.filter((_, j) => j !== i) : [renglonVacio()])); setPrep(null); }} aria-label={`Quitar renglón ${i + 1}`}>✕</button>
                                </div>
                            ))}
                            <button className="boton-fantasma fac-sumar" onClick={() => setRenglones((rs) => [...rs, renglonVacio()])}>+ Agregar renglón</button>
                        </div>
                        <label htmlFor="fac-obs" className="fac-ancho">Observaciones (salen en la factura)
                            <input id="fac-obs" value={obs} onChange={(e) => { setObs(e.target.value); setPrep(null); }} placeholder="Ej.: OC 4512 · pago a 30 días" />
                        </label>
                        {!prep && <button className="pub-primario" onClick={() => void calcular()} disabled={!!ocupado}>{ocupado === 'calcular' ? 'Calculando…' : 'Calcular factura'}</button>}
                    </div>
                )}

                {error && <p className="error" role="alert">{error}</p>}
                {prep && !prep.ok && (
                    <div className="pub-aviso mal" role="status">
                        <p>{prep.motivo}</p>
                        {prep.candidatos && (
                            <div className="fac-candidatos">
                                {prep.candidatos.map((c) => (
                                    <button key={`${c.razon_social}${c.cuit}`} className="chip" onClick={() => { setCliente(c.cuit || c.razon_social); setPrep(null); }}>{c.razon_social}{c.cuit ? ` · ${c.cuit}` : ''} · {c.condicion_iva}</button>
                                ))}
                            </div>
                        )}
                    </div>
                )}
                {prep?.ok && (
                    <div className="fac-vista">
                        <div className="fac-vista-cab">
                            <strong>{prep.vista.comprobante}</strong>
                            <span>{prep.vista.cliente}</span>
                        </div>
                        <table className="fac-renglones">
                            <thead><tr><th>Descripción</th><th className="num">Cant.</th><th className="num">Unitario s/IVA</th><th className="num">IVA</th><th className="num">Subtotal</th></tr></thead>
                            <tbody>{prep.vista.renglones.map((x, i) => <tr key={i}><td>{x.descripcion}</td><td className="num">{x.cantidad}</td><td className="num">{x.unitario_sin_iva}</td><td className="num">{x.iva}</td><td className="num">{x.subtotal_sin_iva}</td></tr>)}</tbody>
                        </table>
                        <dl className="fac-totales">
                            <div><dt>Neto</dt><dd>{prep.vista.neto}</dd></div>
                            <div><dt>IVA</dt><dd>{prep.vista.iva}</dd></div>
                            <div className="total"><dt>Total</dt><dd>{prep.vista.total}</dd></div>
                            {prep.vista.dolar && <div><dt>Dólar</dt><dd>{prep.vista.dolar}</dd></div>}
                        </dl>
                        {prep.vista.observaciones && <p className="fac-obs">Observaciones: {prep.vista.observaciones}</p>}
                        {prep.vista.avisos.map((a) => <p key={a} className="gen-aviso">{a}</p>)}
                        <div className="fac-vista-acciones">
                            <button className="pub-primario" onClick={() => void enviar()} disabled={!!ocupado}>{ocupado === 'enviar' ? 'Mandando…' : 'Mandar a Asimov como borrador'}</button>
                            {!soloVista && <button className="boton-fantasma" onClick={() => setPrep(null)} disabled={!!ocupado}>Corregir</button>}
                            <span className="gen-nota">Queda como borrador en Asimov. El CAE se pide desde ahí con “Autorizar ARCA”.</span>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
