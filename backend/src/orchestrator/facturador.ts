// Asistente Facturador. Arma facturas desde el chat ("facturale a X estos
// productos a este precio") o desde una cotización, y las manda a Asimov como
// BORRADOR. El CAE lo pide Asimov, desde la PC, cuando alguien toca
// "Autorizar ARCA": Bartez AI nunca emite nada fiscal por su cuenta.
//
// Dos pasos: preparar (calcula y muestra, no manda nada) y enviar (lo que se
// mostró, tal cual). Los importes se calculan con las mismas reglas que el
// formulario de factura de Asimov (src/documents.ts): precio neto por renglón,
// IVA por alícuota y conversión de dólares con conciliación de centavos.

import { randomUUID } from 'node:crypto';
import { supabase } from '../connectors/supabase.js';
import { buscarClientesAsimov, clienteAsimovPorId, crearClienteAsimov, empujarCambios, traerCambios, type ClienteAsimov } from '../connectors/asimov.js';
import { tipoDeCambio } from './catalogo_proveedores.js';

// ---------------------------------------------------------------- reglas de Asimov

const round2 = (v: number): number => Math.round(Number((v * 100).toFixed(6))) / 100;
const lineSubtotal = (qty: number, price: number) => Math.round(qty * price * 100) / 100;
const lineGrossFromNet = (net: number, iva: number) => round2(net + round2(net * iva / 100));

export type CondicionIva = 'responsable_inscripto' | 'monotributista' | 'exento' | 'consumidor_final' | 'no_responsable';

export function normalizarCondicion(c: string | null | undefined): CondicionIva {
    const s = String(c ?? '').toLowerCase();
    if (s.includes('inscripto') || s.includes('inscripta') || /^ri$/.test(s.trim())) return 'responsable_inscripto';
    if (s.includes('monotribut')) return 'monotributista';
    if (s.includes('exento') || s.includes('exenta')) return 'exento';
    if (s.includes('no responsable')) return 'no_responsable';
    return 'consumidor_final';
}

export const TEXTO_CONDICION: Record<CondicionIva, string> = {
    responsable_inscripto: 'Responsable inscripto', monotributista: 'Monotributista', exento: 'Exento',
    consumidor_final: 'Consumidor final', no_responsable: 'No responsable',
};

export interface RenglonArs { codigo: string | null; descripcion: string; cantidad: number; precio: number; iva: number; subtotal: number; iva_monto: number }

// Precios netos por unidad → renglones en pesos, igual que normalizeSaleItemsToArs + computeSaleTotals.
export function renglonesEnPesos(items: Array<{ codigo: string | null; descripcion: string; cantidad: number; precio: number; iva: number }>, moneda: 'ARS' | 'USD', tc: number | null): { renglones: RenglonArs[]; neto: number; iva: number; total: number } {
    let convertidos: Array<{ codigo: string | null; descripcion: string; cantidad: number; precio: number; iva: number }>;
    if (moneda !== 'USD') {
        convertidos = items.map((it) => {
            const neto = round2(it.cantidad * round2(it.precio));
            return { ...it, precio: it.cantidad > 0 ? neto / it.cantidad : 0 };
        });
    } else {
        if (!tc || !(tc > 0)) throw new Error('Falta la cotización del dólar');
        const lineas = items.map((it) => {
            const netoOrigen = round2(it.cantidad * round2(it.precio));
            const brutoOrigen = round2(netoOrigen + round2(netoOrigen * it.iva / 100));
            const brutoDestino = round2(brutoOrigen * tc);
            const netoDestino = it.iva > 0 ? round2(brutoDestino / (1 + it.iva / 100)) : brutoDestino;
            return { it, brutoOrigen, netoDestino };
        });
        const esperado = Math.round(round2(lineas.reduce((s, l) => s + l.brutoOrigen, 0) * tc) * 100);
        let actual = lineas.reduce((s, l) => s + Math.round(lineGrossFromNet(l.netoDestino, l.it.iva) * 100), 0);
        for (let guarda = 0; actual !== esperado && guarda < 1000; guarda++) {
            const falta = esperado - actual;
            const dir = falta > 0 ? 1 : -1;
            let movido = false;
            for (const l of lineas) {
                if (l.it.cantidad <= 0) continue;
                const antes = Math.round(lineGrossFromNet(l.netoDestino, l.it.iva) * 100);
                const candidato = round2(l.netoDestino + dir * 0.01);
                if (candidato < 0) continue;
                const cambio = Math.round(lineGrossFromNet(candidato, l.it.iva) * 100) - antes;
                if (cambio === 0 || Math.abs(falta - cambio) >= Math.abs(falta)) continue;
                l.netoDestino = candidato; actual += cambio; movido = true;
                break;
            }
            if (!movido) throw new Error('No se pudieron conciliar los centavos de la conversión a pesos');
        }
        convertidos = lineas.map((l) => ({ ...l.it, precio: l.it.cantidad > 0 ? l.netoDestino / l.it.cantidad : 0 }));
    }
    let neto = 0, iva = 0;
    const renglones = convertidos.map((it) => {
        const subtotal = lineSubtotal(it.cantidad, it.precio);
        const iva_monto = Math.round(subtotal * it.iva) / 100;
        neto += subtotal; iva += iva_monto;
        return { ...it, subtotal, iva_monto };
    });
    neto = Math.round(neto * 100) / 100; iva = Math.round(iva * 100) / 100;
    return { renglones, neto, iva, total: Math.round((neto + iva) * 100) / 100 };
}

// ---------------------------------------------------------------- preparar

// Asimov toma el IVA 0 como 21% (iva || 21): los renglones exentos no se pueden mandar.
const ALICUOTAS = [2.5, 5, 10.5, 21, 27];
const SIN_EXENTOS = 'Asimov no factura renglones con IVA 0% (los toma como 21%): esa factura hay que hacerla a mano en Asimov';
const soloDigitos = (s: string | null | undefined) => String(s ?? '').replace(/\D/g, '');
const plata = (n: number) => `$ ${n.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export interface PedidoFactura {
    cliente: string;                                    // nombre, razón social o CUIT
    cliente_asimov_id?: string | null;                  // si ya se sabe (desde un pedido de Asimov)
    pedido_asimov?: { id: string; numero: string } | null;  // factura de un pedido de Asimov
    renglones_netos_ars?: Array<{ codigo: string | null; descripcion: string; cantidad: number; precio: number; iva: number }> | null;
    cliente_nuevo?: { razon_social: string; cuit?: string | null; condicion_iva: string; email?: string | null } | null;
    renglones?: Array<{ descripcion: string; cantidad: number; precio_unitario: number; codigo?: string | null; iva_pct?: number | null }>;
    cotizacion?: string | null;                         // número de una cotización del Cotizador
    moneda?: 'USD' | 'ARS';
    precios_con_iva?: boolean;
    cotizacion_usd?: number | null;
    observaciones?: string | null;
    pedido?: string | null;
}

export type ResultadoPreparar =
    | { ok: true; factura_id: string; vista: Record<string, unknown> }
    | { ok: false; motivo: string; candidatos?: Array<{ razon_social: string; cuit: string | null; condicion_iva: string }> };

async function ivaDelCatalogo(codigo: string): Promise<number | null> {
    const { data } = await supabase.rpc('buscar_catalogo', { q: codigo, limite: 5, solo_stock: false });
    const a = ((data ?? []) as Array<{ sku?: string; iva_pct?: number | null }>).find((x) => String(x.sku ?? '').toLowerCase() === codigo.toLowerCase());
    return a?.iva_pct != null ? Number(a.iva_pct) : null;
}

export async function prepararFactura(p: PedidoFactura): Promise<ResultadoPreparar> {
    const avisos: string[] = [];

    // 1. Cliente de Asimov.
    let cliente: { asimov_id: string | null; razon_social: string; cuit: string | null; condicion: CondicionIva; email: string | null };
    const cuitPedido = soloDigitos(p.cliente_nuevo?.cuit ?? p.cliente);
    let encontrados: ClienteAsimov[] = [];
    if (p.cliente_asimov_id) {
        const c = await clienteAsimovPorId(p.cliente_asimov_id);
        if (!c) return { ok: false, motivo: 'El cliente del pedido no está en Asimov (¿lo borraron?)' };
        encontrados = [c];
    } else if (cuitPedido.length === 11) encontrados = (await buscarClientesAsimov(cuitPedido)).filter((c) => soloDigitos(c.cuit) === cuitPedido);
    if (!p.cliente_asimov_id && !encontrados.length && p.cliente.trim().length >= 3 && cuitPedido.length !== 11) encontrados = await buscarClientesAsimov(p.cliente.trim());
    if (encontrados.length > 1) {
        const exacto = encontrados.filter((c) => c.businessName.trim().toLowerCase() === p.cliente.trim().toLowerCase());
        if (exacto.length === 1) encontrados = exacto;
    }
    if (encontrados.length === 1) {
        const c = encontrados[0]!;
        cliente = { asimov_id: c.id, razon_social: c.businessName, cuit: c.cuit, condicion: normalizarCondicion(c.fiscalType), email: c.email };
    } else if (encontrados.length > 1) {
        return { ok: false, motivo: 'Hay varios clientes en Asimov que coinciden. Preguntá cuál es.', candidatos: encontrados.slice(0, 6).map((c) => ({ razon_social: c.businessName, cuit: c.cuit, condicion_iva: TEXTO_CONDICION[normalizarCondicion(c.fiscalType)] })) };
    } else if (p.cliente_nuevo?.razon_social) {
        const cuit = soloDigitos(p.cliente_nuevo.cuit);
        if (cuit && cuit.length !== 11) return { ok: false, motivo: `El CUIT ${p.cliente_nuevo.cuit} no tiene 11 dígitos` };
        cliente = { asimov_id: null, razon_social: p.cliente_nuevo.razon_social.trim(), cuit: cuit || null, condicion: normalizarCondicion(p.cliente_nuevo.condicion_iva), email: p.cliente_nuevo.email ?? null };
        avisos.push(`${cliente.razon_social} no está en Asimov: se da de alta al mandar la factura.`);
    } else {
        return { ok: false, motivo: `“${p.cliente}” no está en Asimov. Pedí razón social, CUIT y condición de IVA para darlo de alta (y volvé a llamar con cliente_nuevo).` };
    }
    const tipo = cliente.condicion === 'responsable_inscripto' ? 'A' : 'B';
    if (tipo === 'A' && soloDigitos(cliente.cuit).length !== 11) return { ok: false, motivo: `${cliente.razon_social} es responsable inscripto pero no tiene un CUIT válido cargado en Asimov: sin CUIT no se puede hacer factura A.` };

    // 2. Renglones: de la cotización o los que se dictaron.
    let moneda: 'USD' | 'ARS' = p.moneda === 'USD' ? 'USD' : 'ARS';
    let conIva = p.precios_con_iva === true;
    let cotizacionId: string | null = null;
    let items: Array<{ codigo: string | null; descripcion: string; cantidad: number; precio: number; iva: number }> = [];
    if (p.cotizacion?.trim()) {
        const n = p.cotizacion.trim().replace(/^#/, '');
        const { data: cots } = await supabase.from('cotizaciones').select('id, numero, numero_externo, items').or(`numero.eq.${Number(n) || -1},numero_externo.eq.${n.replace(/[,()]/g, '')}`).limit(2);
        const cot = cots?.[0];
        if (!cot) return { ok: false, motivo: `No encontré la cotización ${p.cotizacion} en el Cotizador` };
        cotizacionId = cot.id as string;
        moneda = 'USD'; conIva = false;
        for (const l of (cot.items ?? []) as Array<{ cantidad?: number; elegido?: { sku?: string; descripcion?: string; precio_unit_usd?: number; iva_pct?: number } | null }>) {
            if (!l.elegido) continue;
            items.push({ codigo: l.elegido.sku ?? null, descripcion: String(l.elegido.descripcion ?? ''), cantidad: Number(l.cantidad ?? 1), precio: Number(l.elegido.precio_unit_usd ?? 0), iva: Number(l.elegido.iva_pct ?? 21) });
        }
        if (!items.length) return { ok: false, motivo: 'La cotización no tiene renglones con artículo elegido' };
        const raro = items.find((i) => !ALICUOTAS.includes(i.iva));
        if (raro) return { ok: false, motivo: `“${raro.descripcion}”: ${raro.iva === 0 ? SIN_EXENTOS : `IVA ${raro.iva}% no válido`}` };
    }
    if (p.pedido_asimov) {
        const { data: ya } = await supabase.from('facturas_asimov').select('id, estado').eq('pedido_asimov_id', p.pedido_asimov.id).in('estado', ['enviada', 'autorizada']).limit(1);
        if (ya?.length) return { ok: false, motivo: `El pedido ${p.pedido_asimov.numero} ya tiene una factura hecha por Bartez AI (${ya[0]!.estado})` };
        moneda = 'ARS'; conIva = false;
        for (const it of p.renglones_netos_ars ?? []) items.push({ ...it, precio: round2(it.precio) });
        const raro = items.find((i) => !ALICUOTAS.includes(i.iva));
        if (raro) return { ok: false, motivo: `“${raro.descripcion}”: ${raro.iva === 0 ? SIN_EXENTOS : `IVA ${raro.iva}% no válido`}` };
        if (!items.length) return { ok: false, motivo: 'El pedido no tiene renglones' };
    }
    for (const r of p.renglones ?? []) {
        const descripcion = String(r.descripcion ?? '').trim();
        const cantidad = Number(r.cantidad);
        const precio = Number(r.precio_unitario);
        if (!descripcion) return { ok: false, motivo: 'Un renglón no tiene descripción' };
        if (!(cantidad > 0) || !(precio > 0)) return { ok: false, motivo: `“${descripcion}”: la cantidad y el precio tienen que ser mayores a cero` };
        let iva = r.iva_pct != null ? Number(r.iva_pct) : null;
        if (iva === 0) return { ok: false, motivo: `“${descripcion}”: ${SIN_EXENTOS}` };
        if (iva != null && !ALICUOTAS.includes(iva)) return { ok: false, motivo: `“${descripcion}”: la alícuota de IVA ${iva}% no existe` };
        if (iva == null && r.codigo) iva = await ivaDelCatalogo(r.codigo);
        if (iva != null && !ALICUOTAS.includes(iva)) return { ok: false, motivo: `“${descripcion}”: ${iva === 0 ? SIN_EXENTOS : `el catálogo tiene IVA ${iva}%, que Asimov no maneja`}` };
        if (iva == null) { iva = 21; avisos.push(`“${descripcion}”: no me dijiste el IVA, puse 21%.`); }
        const neto = conIva ? precio / (1 + iva / 100) : precio;
        items.push({ codigo: r.codigo?.trim() || null, descripcion: descripcion.slice(0, 250), cantidad, precio: round2(neto), iva });
    }
    if (!items.length) return { ok: false, motivo: 'Decime qué productos van en la factura (descripción, cantidad y precio)' };
    if (items.length > 60) return { ok: false, motivo: 'Demasiados renglones para una factura (máximo 60)' };

    // 3. Pesos.
    let tc: number | null = null;
    if (moneda === 'USD') {
        if (p.cotizacion_usd && p.cotizacion_usd > 0) tc = Number(p.cotizacion_usd);
        else { const t = await tipoDeCambio(); tc = t.valor; avisos.push(`Dólar a ${plata(tc)} (${t.fuente}).`); }
    }
    const calc = renglonesEnPesos(items, moneda, tc);
    if (conIva) avisos.push('Los precios que pasaste tenían IVA incluido: se discriminó el IVA de cada renglón.');

    // 4. Se guarda como "preparada": todavía no fue a Asimov.
    const id = randomUUID();
    const { data: cliBartez } = await supabase.from('clientes').select('id').ilike('nombre', cliente.razon_social.replace(/[%_]/g, ' ')).limit(1);
    const fila = {
        id, estado: 'preparada', cliente_id: (cliBartez?.[0]?.id as string | undefined) ?? null,
        cliente_asimov_id: cliente.asimov_id, razon_social: cliente.razon_social, cuit: cliente.cuit, condicion_iva: cliente.condicion,
        tipo, moneda, cotizacion_usd: tc, neto: calc.neto, iva: calc.iva, total: calc.total,
        renglones: { origen: items, pesos: calc.renglones, email: cliente.email }, avisos,
        observaciones: [p.pedido_asimov ? `Pedido ${p.pedido_asimov.numero}` : null, p.observaciones?.trim()].filter(Boolean).join(' · ').slice(0, 500) || null,
        cotizacion_id: cotizacionId, pedido: p.pedido?.slice(0, 1000) ?? null, pedido_asimov_id: p.pedido_asimov?.id ?? null,
    };
    const { error } = await supabase.from('facturas_asimov').insert(fila);
    if (error) throw new Error(error.message);
    return { ok: true, factura_id: id, vista: vistaFactura(fila) };
}

function vistaFactura(f: { tipo: string; razon_social: string; cuit: string | null; condicion_iva: string | null; moneda: string; cotizacion_usd: number | null; neto: number; iva: number; total: number; renglones: { origen: Array<{ descripcion: string; cantidad: number; precio: number; iva: number }>; pesos: RenglonArs[] }; avisos: string[]; observaciones: string | null }) {
    return {
        comprobante: `Factura ${f.tipo}`,
        cliente: `${f.razon_social}${f.cuit ? ` · CUIT ${f.cuit}` : ''} · ${TEXTO_CONDICION[normalizarCondicion(f.condicion_iva)]}`,
        renglones: f.renglones.pesos.map((r, i) => ({
            descripcion: r.descripcion, cantidad: r.cantidad, iva: `${r.iva}%`,
            unitario_sin_iva: f.moneda === 'USD' ? `US$ ${f.renglones.origen[i]!.precio.toFixed(2)} → ${plata(r.precio)}` : plata(r.precio),
            subtotal_sin_iva: plata(r.subtotal),
        })),
        neto: plata(f.neto), iva: plata(f.iva), total: plata(f.total),
        dolar: f.cotizacion_usd ? plata(Number(f.cotizacion_usd)) : null,
        observaciones: f.observaciones, avisos: f.avisos,
        siguiente_paso: 'Mostrale esto al usuario y preguntale si la manda a Asimov. Solo con su sí llamá enviar_factura.',
    };
}

// ---------------------------------------------------------------- enviar

const fechaAR = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });

export function envelopeFactura(f: { id: string; cliente_asimov_id: string; razon_social: string; tipo: string; moneda: string; cotizacion_usd: number | null; neto: number; iva: number; total: number; observaciones: string | null; renglones: { pesos: RenglonArs[] } }, puntoVenta: string, fecha: string) {
    const ahora = new Date().toISOString().replace('T', ' ').slice(0, 19);
    return {
        type: 'invoice',
        header: {
            id: f.id, number: `BORRADOR-AI-${f.id.slice(0, 6).toUpperCase()}`,
            client_id: f.cliente_asimov_id, client_name: f.razon_social, date: fecha, due_date: null,
            tipo: f.tipo, point_of_sale: puntoVenta, status: 'borrador',
            subtotal: Number(f.neto), iva_amount: Number(f.iva), total: Number(f.total),
            cae: null, cae_expiry: null, afip_error: null,
            notes: ['Preparada por Bartez AI', f.observaciones].filter(Boolean).join(' · '),
            usd_rate: f.moneda === 'USD' ? Number(f.cotizacion_usd) : null, source_currency: f.moneda,
            show_kit_components: 1, consolidated_print: 0, consolidated_label: null, created_at: ahora,
        },
        items: f.renglones.pesos.map((r) => ({
            id: randomUUID(), invoice_id: f.id, article_id: null, code: r.codigo, description: r.descripcion,
            qty: r.cantidad, unit_price: r.precio, iva_pct: r.iva, subtotal: r.subtotal, iva_amount: r.iva_monto, cost: 0,
        })),
        stockMovements: [], cashMovements: [],
    };
}

export async function enviarFactura(id: string): Promise<{ ok: boolean; detalle: string }> {
    const { data: f } = await supabase.from('facturas_asimov').select('*').eq('id', id).maybeSingle();
    if (!f) return { ok: false, detalle: 'No encontré esa factura preparada' };
    if (f.estado !== 'preparada') return { ok: false, detalle: `Esa factura ya está ${f.estado}` };
    if (Date.now() - new Date(f.creado_en as string).getTime() > 24 * 3600_000) return { ok: false, detalle: 'La preparé hace más de un día: armala de nuevo para que tome la cotización y los datos de hoy' };
    let asimovId = f.cliente_asimov_id as string | null;
    if (!asimovId) {
        const cli = await crearClienteAsimov({ razon_social: f.razon_social, cuit: f.cuit, condicion_iva: f.condicion_iva, email: (f.renglones as { email?: string | null }).email ?? null });
        asimovId = cli.id;
        await supabase.from('facturas_asimov').update({ cliente_asimov_id: asimovId }).eq('id', id);
    }
    const env = envelopeFactura({ ...(f as Parameters<typeof envelopeFactura>[0]), cliente_asimov_id: asimovId }, (process.env.ASIMOV_PUNTO_VENTA ?? '').trim() || '0001', fechaAR());
    const cambios: Array<{ entity: string; action: string; id: string; data: Record<string, unknown> }> = [{ entity: 'document_snapshot', action: 'update', id, data: env as unknown as Record<string, unknown> }];
    // Factura de un pedido: el vínculo pedido → factura, como lo arma Asimov al facturar desde el pedido.
    if (f.pedido_asimov_id) cambios.push({ entity: 'document_link', action: 'create', id: randomUUID(), data: { sourceType: 'sale_order', sourceId: f.pedido_asimov_id, targetType: 'invoice', targetId: id } });
    await empujarCambios(cambios);
    await supabase.from('facturas_asimov').update({ estado: 'enviada', enviada_en: new Date().toISOString(), actualizado_en: new Date().toISOString() }).eq('id', id);
    return { ok: true, detalle: `Quedó en Asimov como borrador (${env.header.number}). Aparece en Facturas en las PCs conectadas en menos de un minuto; se autoriza desde ahí con “Autorizar ARCA”.` };
}

// ---------------------------------------------------------------- seguimiento

// Lee la sincronización de Asimov y actualiza las facturas enviadas: autorizada
// (con número y CAE), rechazada por ARCA (con el motivo) o borrada en Asimov.
export async function seguirFacturas(): Promise<{ revisadas: number; cambios: number }> {
    const { data: env } = await supabase.from('facturas_asimov').select('id, enviada_en, estado').in('estado', ['enviada', 'rechazada']).order('enviada_en', { ascending: true }).limit(200);
    if (!env?.length) return { revisadas: 0, cambios: 0 };
    const desde = new Date(new Date(env[0]!.enviada_en as string).getTime() - 60_000).toISOString();
    const nuestros = new Map(env.map((f) => [f.id as string, f.estado as string]));
    const cambios = await traerCambios(desde);
    let n = 0;
    for (const c of cambios) {
        if (c.entity !== 'document_snapshot' || !nuestros.has(c.id)) continue;
        const h = ((c.data as { header?: Record<string, unknown> }).header ?? {}) as Record<string, unknown>;
        let upd: Record<string, unknown> | null = null;
        if (c.action === 'delete') upd = { estado: 'descartada' };
        else if (String(h.cae ?? '').trim()) upd = { estado: 'autorizada', numero: h.number ?? null, cae: h.cae, cae_vto: h.cae_expiry ?? null, error_arca: null, total: h.total ?? undefined };
        else if (h.status === 'rechazada') upd = { estado: 'rechazada', error_arca: String(h.afip_error ?? 'sin detalle').slice(0, 1000) };
        if (!upd) continue;
        await supabase.from('facturas_asimov').update({ ...upd, actualizado_en: new Date().toISOString() }).eq('id', c.id);
        n++;
    }
    return { revisadas: env.length, cambios: n };
}

export async function facturasRecientes(limite = 15) {
    const { data } = await supabase.from('facturas_asimov').select('id, estado, razon_social, tipo, total, moneda, numero, cae, error_arca, creado_en, enviada_en')
        .neq('estado', 'preparada').order('creado_en', { ascending: false }).limit(limite);
    return data ?? [];
}
