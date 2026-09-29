// Pestaña Facturación: facturas, pedidos y cobranzas de Asimov (todas, no solo
// las que prepara Bartez AI), leídas con la consulta de documentos de su API.
//
// Cobranzas: una factura autorizada está cobrada cuando los recibos que la
// nombran suman su total. Vencida: pasó su vencimiento o, si no tiene, pasaron
// DIAS_PLAZO desde la fecha.

import { supabase } from '../connectors/supabase.js';
import { asimovConfigurado, clienteAsimovPorId, documentosAsimov, type DocumentoAsimov } from '../connectors/asimov.js';
import { prepararFactura, type ResultadoPreparar } from './facturador.js';

export const DIAS_PLAZO = 30;
const TZ = 'America/Argentina/Buenos_Aires';
const hoy = () => new Date().toLocaleDateString('en-CA', { timeZone: TZ });
const diasAntes = (n: number) => new Date(Date.now() - n * 86_400_000).toLocaleDateString('en-CA', { timeZone: TZ });
const num = (v: unknown) => Number(v ?? 0) || 0;
const r2 = (n: number) => Math.round(n * 100) / 100;
const str = (v: unknown) => (v == null ? null : String(v));

export interface FacturaFila {
    id: string; numero: string; fecha: string; vence: string | null; cliente: string | null; cliente_id: string | null;
    tipo: string; estado: string; total: number; neto: number; iva: number; moneda: string; dolar: number | null;
    cae: string | null; error_arca: string | null; de_bartez_ai: boolean; cobrado: number; saldo: number;
    acreditado: number;             // notas de crédito aplicadas a esta factura
    notas: string[];                // números de las NC que la cancelan (o, en una NC, la factura que cancela)
    renglones: Array<{ descripcion: string; cantidad: number; precio: number; iva: number; subtotal: number }>;
}
export interface PedidoFila {
    id: string; numero: string; fecha: string; entrega: string | null; cliente: string | null; cliente_id: string | null;
    estado: string; total: number; facturado_por_ai: string | null;
    renglones: Array<{ codigo: string | null; descripcion: string; cantidad: number; precio: number; iva: number; subtotal: number }>;
}
export interface CobranzaFila { factura: FacturaFila; dias: number; vencida: boolean; recordatorio_pendiente: boolean }

export interface ResumenFacturacion {
    configurado: boolean; faltan: string[];
    api_lista: boolean;           // Asimov ya tiene la consulta de documentos
    desde: string; hasta: string;
    facturas: FacturaFila[];
    pedidos: PedidoFila[];
    cobranzas: CobranzaFila[];
    totales: { facturado: number; por_autorizar: number; por_cobrar: number; vencido: number };
}

const esNC = (tipo: string) => /^NC$/i.test(tipo);

function aFactura(d: DocumentoAsimov, deAi: Set<string>, cobros: Map<string, number>, creditos: Map<string, { monto: number; notas: string[] }>, aplicaA: Map<string, string>): FacturaFila {
    const h = d.header;
    const total = num(h.total);
    const nc = esNC(String(h.tipo ?? ''));
    const credito = creditos.get(d.docId);
    const acreditado = nc ? 0 : r2(Math.min(total, credito?.monto ?? 0));
    const cobrado = nc ? 0 : r2(Math.min(total - acreditado, cobros.get(d.docId) ?? cobros.get(`#${String(h.number ?? d.number)}`) ?? 0));
    return {
        acreditado, notas: nc ? (aplicaA.has(d.docId) ? [aplicaA.get(d.docId)!] : []) : credito?.notas ?? [],
        id: d.docId, numero: String(h.number ?? d.number), fecha: String(h.date ?? '').slice(0, 10), vence: str(h.due_date)?.slice(0, 10) ?? null,
        cliente: str(h.client_name), cliente_id: str(h.client_id), tipo: String(h.tipo ?? 'B'),
        estado: String(h.cae ? 'autorizada' : h.status ?? 'borrador'), total, neto: num(h.subtotal), iva: num(h.iva_amount),
        moneda: String(h.source_currency ?? 'ARS'), dolar: h.usd_rate != null ? num(h.usd_rate) : null,
        cae: str(h.cae), error_arca: str(h.afip_error), de_bartez_ai: deAi.has(d.docId), cobrado, saldo: nc ? 0 : r2(total - acreditado - cobrado),
        renglones: (d.items ?? []).map((i) => ({ descripcion: String(i.description ?? ''), cantidad: num(i.qty), precio: num(i.unit_price), iva: num(i.iva_pct), subtotal: num(i.subtotal) })),
    };
}

// Qué factura cancela cada nota de crédito autorizada. Asimov lo guarda como
// vínculo factura → NC (lo exige para pedir el CAE de la NC). Si la API todavía
// no devuelve los vínculos, se usa un respaldo: NC del mismo cliente por el
// mismo importe que una única factura anterior.
export function notasDeCredito(docs: DocumentoAsimov[]): Map<string, { monto: number; notas: string[]; ids: string[] }> {
    const out = new Map<string, { monto: number; notas: string[]; ids: string[] }>();
    const facturas = docs.filter((d) => !esNC(String(d.header.tipo ?? '')) && d.header.cae);
    const usadas = new Set<string>();
    for (const nc of docs.filter((d) => esNC(String(d.header.tipo ?? '')) && d.header.cae)) {
        let destino: string | undefined = nc.sources?.find((x) => x.type === 'invoice')?.id;
        if (!destino && nc.sources === undefined) {
            const cands = facturas.filter((f) => !usadas.has(f.docId) && f.header.client_id === nc.header.client_id
                && Math.abs(num(f.header.total) - num(nc.header.total)) < 0.01 && String(f.header.date ?? '') <= String(nc.header.date ?? ''));
            if (cands.length === 1) destino = cands[0]!.docId;
        }
        if (!destino) continue;
        usadas.add(destino);
        const a = out.get(destino) ?? { monto: 0, notas: [], ids: [] };
        a.monto = r2(a.monto + num(nc.header.total));
        a.notas.push(`NC ${String(nc.header.number ?? nc.number)}`);
        a.ids.push(nc.docId);
        out.set(destino, a);
    }
    return out;
}

export async function resumenFacturacion(opts: { desde?: string; hasta?: string } = {}): Promise<ResumenFacturacion> {
    const cfg = asimovConfigurado();
    const desde = /^\d{4}-\d{2}-\d{2}$/.test(opts.desde ?? '') ? opts.desde! : diasAntes(90);
    const hasta = /^\d{4}-\d{2}-\d{2}$/.test(opts.hasta ?? '') ? opts.hasta! : hoy();
    const vacio: ResumenFacturacion = { configurado: cfg.ok, faltan: cfg.faltan, api_lista: false, desde, hasta, facturas: [], pedidos: [], cobranzas: [], totales: { facturado: 0, por_autorizar: 0, por_cobrar: 0, vencido: 0 } };
    if (!cfg.ok) return vacio;

    // Para cobranzas hace falta mirar más atrás que el período elegido: una
    // factura vieja puede seguir impaga, y el recibo puede ser posterior.
    const desdeCobranza = diasAntes(365);
    const [docs, recibos] = await Promise.all([
        documentosAsimov({ tipos: ['invoice', 'sale_order'], desde: desde < desdeCobranza ? desde : desdeCobranza, hasta, items: true, limite: 2000 }),
        documentosAsimov({ tipos: ['receipt'], desde: desdeCobranza, items: true, limite: 2000 }),
    ]);
    if (!docs || !recibos) return vacio;

    const { data: nuestras } = await supabase.from('facturas_asimov').select('id, pedido_asimov_id, estado').in('estado', ['enviada', 'autorizada', 'rechazada']);
    const deAi = new Set((nuestras ?? []).map((f) => f.id as string));
    const pedidoFacturado = new Map((nuestras ?? []).filter((f) => f.pedido_asimov_id).map((f) => [f.pedido_asimov_id as string, f.estado as string]));

    // Lo cobrado por factura (por id, o por número si el recibo no guardó el id).
    const cobros = new Map<string, number>();
    for (const r of recibos) {
        if (/anulad/i.test(String(r.header.status ?? ''))) continue;
        for (const it of r.items ?? []) {
            const k = it.invoice_id ? String(it.invoice_id) : it.invoice_number ? `#${String(it.invoice_number)}` : null;
            if (k) cobros.set(k, r2((cobros.get(k) ?? 0) + num(it.paid_amount)));
        }
    }

    const vigentes = docs.filter((d) => d.type === 'invoice' && !/anulad/i.test(String(d.header.status ?? '')));
    const creditos = notasDeCredito(vigentes);
    const aplicaA = new Map<string, string>();
    const numeroDe = new Map(vigentes.map((d) => [d.docId, `${String(d.header.tipo ?? '')} ${String(d.header.number ?? d.number)}`]));
    for (const [facturaId, c] of creditos) for (const ncId of c.ids) aplicaA.set(ncId, numeroDe.get(facturaId) ?? '');
    const todas = vigentes.map((d) => aFactura(d, deAi, cobros, creditos, aplicaA));
    const facturas = todas.filter((f) => f.fecha >= desde);
    const pedidos: PedidoFila[] = docs.filter((d) => d.type === 'sale_order' && String(d.header.date ?? '').slice(0, 10) >= desde).map((d) => {
        const h = d.header;
        return {
            id: d.docId, numero: String(h.number ?? d.number), fecha: String(h.date ?? '').slice(0, 10), entrega: str(h.delivery_date)?.slice(0, 10) ?? null,
            cliente: str(h.client_name), cliente_id: str(h.client_id), estado: String(h.status ?? 'borrador'), total: num(h.total),
            facturado_por_ai: pedidoFacturado.get(d.docId) ?? null,
            renglones: (d.items ?? []).map((i) => ({ codigo: str(i.code), descripcion: String(i.description ?? ''), cantidad: num(i.qty), precio: num(i.unit_price), iva: num(i.iva_pct), subtotal: num(i.subtotal) })),
        };
    });

    const { data: recs } = await supabase.from('acciones_pendientes').select('payload').eq('accion', 'enviar_correo').eq('estado', 'pendiente');
    const conRecordatorio = new Set((recs ?? []).map((a) => (a.payload as { factura_asimov_id?: string }).factura_asimov_id).filter(Boolean) as string[]);
    const h = hoy();
    const cobranzas: CobranzaFila[] = todas
        .filter((f) => f.estado === 'autorizada' && !esNC(f.tipo) && f.saldo > 0.5)
        .map((f) => {
            const vence = f.vence ?? new Date(new Date(`${f.fecha}T12:00:00`).getTime() + DIAS_PLAZO * 86_400_000).toISOString().slice(0, 10);
            const dias = Math.floor((new Date(`${h}T12:00:00`).getTime() - new Date(`${f.fecha}T12:00:00`).getTime()) / 86_400_000);
            return { factura: f, dias, vencida: vence < h, recordatorio_pendiente: conRecordatorio.has(f.id) };
        })
        .sort((a, b) => Number(b.vencida) - Number(a.vencida) || b.dias - a.dias);

    const suma = (xs: number[]) => r2(xs.reduce((s, x) => s + x, 0));
    return {
        configurado: true, faltan: [], api_lista: true, desde, hasta, facturas, pedidos, cobranzas,
        totales: {
            // Facturas y notas de débito, menos notas de crédito.
            facturado: suma(facturas.filter((f) => f.estado === 'autorizada').map((f) => (esNC(f.tipo) ? -f.total : f.total))),
            por_autorizar: facturas.filter((f) => f.estado !== 'autorizada').length,
            por_cobrar: suma(cobranzas.map((c) => c.factura.saldo)),
            vencido: suma(cobranzas.filter((c) => c.vencida).map((c) => c.factura.saldo)),
        },
    };
}

// Facturar un pedido de Asimov: mismos renglones y cliente; queda preparada
// para revisar antes de mandarla.
export async function prepararDesdePedido(pedidoId: string): Promise<ResultadoPreparar> {
    const docs = await documentosAsimov({ tipos: ['sale_order'], items: true, limite: 2000 });
    if (!docs) return { ok: false, motivo: 'Asimov todavía no tiene la consulta de documentos (falta publicar el cambio en su API)' };
    const q = pedidoId.trim().toLowerCase();
    // Por id, por número completo ("PED-00000012") o solo por el número (12).
    const nro = (x: DocumentoAsimov) => String(x.header.number ?? x.number).toLowerCase();
    const soloNumero = (v: string) => Number(v.split('-').pop()?.replace(/\D/g, '') || NaN);
    const d = docs.find((x) => x.docId === pedidoId) ?? docs.find((x) => nro(x) === q)
        ?? (/^\d+$/.test(q) ? docs.find((x) => soloNumero(nro(x)) === Number(q)) : undefined);
    if (!d) return { ok: false, motivo: 'No encontré ese pedido en Asimov' };
    const h = d.header;
    if (!h.client_id) return { ok: false, motivo: 'El pedido no tiene cliente cargado en Asimov' };
    return prepararFactura({
        cliente: String(h.client_name ?? ''), cliente_asimov_id: String(h.client_id),
        pedido_asimov: { id: d.docId, numero: String(h.number ?? d.number) },
        renglones_netos_ars: (d.items ?? []).map((i) => ({ codigo: str(i.code), descripcion: String(i.description ?? ''), cantidad: num(i.qty), precio: num(i.unit_price), iva: num(i.iva_pct) || 21 })),
        pedido: `Facturar pedido ${String(h.number ?? d.number)}`,
    });
}

const plata = (n: number) => `$ ${n.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Recordatorio de pago: un correo que va a Para aprobar.
export async function proponerRecordatorio(facturaId: string): Promise<{ ok: boolean; detalle: string }> {
    const r = await resumenFacturacion({ desde: diasAntes(365) });
    const c = r.cobranzas.find((x) => x.factura.id === facturaId);
    if (!c) return { ok: false, detalle: 'Esa factura no figura con saldo pendiente' };
    if (c.recordatorio_pendiente) return { ok: false, detalle: 'Ya hay un recordatorio de esa factura esperando en Para aprobar' };
    const cli = c.factura.cliente_id ? await clienteAsimovPorId(c.factura.cliente_id) : null;
    const para = cli?.email?.trim();
    if (!para) return { ok: false, detalle: `${c.factura.cliente ?? 'El cliente'} no tiene email cargado en Asimov` };
    const f = c.factura;
    const cuerpo = [
        'Hola, ¿cómo están?',
        '',
        `Les escribo por la factura ${f.tipo} ${f.numero} del ${f.fecha.split('-').reverse().join('/')}, por ${plata(f.total)}.`,
        f.cobrado > 0 ? `Según nuestros registros queda un saldo pendiente de ${plata(f.saldo)}.` : `Según nuestros registros todavía figura pendiente de pago.`,
        '',
        '¿Nos confirman cuándo tienen previsto el pago? Si ya lo hicieron, les pido que nos manden el comprobante así lo imputamos.',
        '',
        'Muchas gracias.',
        '',
        'Saludos,',
        'Andrés — Bartez Tecnología',
    ].join('\n');
    const { data: asis } = await supabase.from('asistentes').select('id').eq('area', 'cobranzas').maybeSingle();
    const { error } = await supabase.from('acciones_pendientes').insert({
        asistente_id: (asis?.id as string | undefined) ?? null,
        accion: 'enviar_correo',
        estado: 'pendiente',
        payload: { para, asunto: `Factura ${f.tipo} ${f.numero} — Bartez Tecnología`, cuerpo, clienteId: null, nombreCliente: f.cliente, factura_asimov_id: f.id },
        respuesta: { por: 'sistema', origen: 'cobranzas' },
    });
    if (error) return { ok: false, detalle: error.message };
    return { ok: true, detalle: 'El recordatorio quedó en Para aprobar' };
}
