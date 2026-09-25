// Asistente Cotizador: recibe un pedido en lenguaje natural ("10 notebooks i5
// 16GB y 2 switches de 24 bocas"), busca en el catálogo de proveedores con la
// herramienta buscar_articulos y elige el artículo más conveniente para cada
// renglón (más alternativas). El LLM SOLO elige artículos: los precios, el
// margen, el IVA y la conversión de moneda los calcula este código, así los
// números nunca son inventados.

import Anthropic from '@anthropic-ai/sdk';
import { anthropic, calcularCosto, idModelo } from '../connectors/anthropic.js';
import { supabase } from '../connectors/supabase.js';
import { tipoDeCambio } from './catalogo_proveedores.js';

const IVA_DEFAULT = 21;

const PROMPT_DEFAULT = `Sos el asistente de Cotizaciones de Bartez Tecnología (equipamiento IT,
Rosario, Argentina). Recibís un pedido de un cliente y armás la selección de
artículos a partir del catálogo de nuestros proveedores (Elit, Air, Invid).

Cómo trabajás:
1. Separá el pedido en renglones (qué producto, cuántas unidades, requisitos).
2. Para cada renglón usá buscar_articulos con términos concretos (marca, modelo,
   specs clave: "notebook i5 16gb", "switch 24 puertos", "monitor 24 ips").
   Probá 2-3 búsquedas distintas si la primera no trae buenos resultados.
   Los proveedores abrevian: "R5"/"R7" = Ryzen, "U5"/"Core 5" = Intel Core
   Ultra/Core de nueva generación, "Ci5" = Core i5, "desktop" o "mini pc" =
   PC de escritorio, "NB" = notebook, "PN" = número de parte. Si el cliente da un número de
   parte o modelo exacto, buscalo tal cual primero.
3. Elegí para cada renglón el artículo que mejor cumpla los requisitos, con
   stock y buen precio. Si no hay uno idéntico, elegí el más similar y aclaralo.
4. Sumá hasta 2 alternativas por renglón (otra marca, otro proveedor, o
   una opción superior/inferior de precio) si existen.
5. Nunca inventes artículos: solo IDs que devolvió buscar_articulos.

Cuando termines, respondé SOLO con este bloque JSON:
<cotizacion>
{
  "items": [
    {
      "pedido": "texto del renglón pedido",
      "cantidad": 10,
      "catalogo_id": 123,
      "alternativas": [456, 789],
      "nota": "equivalente: i5 12va en vez de 13va | sin stock en X | etc (o vacío)"
    }
  ],
  "comentario": "1-3 líneas para el operador: supuestos que hiciste, qué no encontraste, qué conviene confirmar con el cliente"
}
</cotizacion>

Si algún renglón no tiene nada parecido en el catálogo, incluilo con
"catalogo_id": null y explicalo en la nota.`;

const TOOLS: Anthropic.Tool[] = [
    {
        name: 'buscar_articulos',
        description: 'Busca artículos en el catálogo unificado de proveedores (Elit, Air, Invid). Devuelve id, proveedor, sku, descripción, marca, categoría, precio de costo, moneda, IVA y stock. Búsqueda aproximada por texto.',
        input_schema: {
            type: 'object',
            properties: {
                consulta: { type: 'string', description: 'Términos de búsqueda: tipo de producto, marca, modelo, specs.' },
                solo_con_stock: { type: 'boolean', description: 'Si true, solo artículos con stock > 0. Default true.' },
                limite: { type: 'number', description: 'Máximo de resultados (default 15, máx 30).' },
            },
            required: ['consulta'],
        },
    },
];

interface FilaCatalogo {
    id: number;
    proveedor: string;
    sku: string;
    descripcion: string;
    marca: string | null;
    categoria: string | null;
    precio: number | null;
    moneda: string;
    iva_pct: number | null;
    stock: number | null;
}

async function buscar(consulta: string, soloStock = true, limite = 15): Promise<FilaCatalogo[]> {
    const { data, error } = await supabase.rpc('buscar_catalogo', {
        q: consulta,
        limite: Math.min(Math.max(limite, 1), 30),
        solo_stock: soloStock,
    });
    if (error) throw new Error(error.message);
    return (data ?? []) as FilaCatalogo[];
}

export interface LineaCotizada {
    pedido: string;
    cantidad: number;
    nota: string;
    elegido: ArticuloPrecio | null;
    alternativas: ArticuloPrecio[];
}

export interface ArticuloPrecio {
    catalogo_id: number;
    proveedor: string;
    sku: string;
    descripcion: string;
    marca: string | null;
    stock: number | null;
    moneda_origen: string;
    costo_usd: number;
    margen_pct: number;
    precio_unit_usd: number;   // neto, sin IVA
    iva_pct: number;
    precio_unit_final_usd: number; // con IVA
}

export interface ResultadoCotizacion {
    ok: boolean;
    id?: string;
    pedido: string;
    lineas: LineaCotizada[];
    comentario: string;
    tipo_cambio: number;
    fuente_tc: string;
    subtotal_usd: number;
    iva_usd: number;
    total_usd: number;
    total_ars: number;
    busquedas: number;
    costo_ia_usd: number;
    duracion_ms: number;
    detalle?: string;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

async function preciar(ids: number[], tc: number): Promise<Map<number, ArticuloPrecio>> {
    const out = new Map<number, ArticuloPrecio>();
    if (ids.length === 0) return out;
    const { data: filas } = await supabase
        .from('catalogo_proveedores')
        .select('id, proveedor, sku, descripcion, marca, precio, moneda, iva_pct, stock')
        .in('id', ids);
    const { data: provs } = await supabase.from('proveedores').select('codigo, margen_pct');
    const margenes = new Map((provs ?? []).map((p) => [p.codigo as string, Number(p.margen_pct)]));

    for (const f of filas ?? []) {
        const precio = Number(f.precio ?? 0);
        if (!(precio > 0)) continue; // sin precio no se cotiza (nunca a USD 0)
        const costoUsd = f.moneda === 'ARS' ? precio / tc : precio;
        const margen = margenes.get(f.proveedor as string) ?? 15;
        const iva = f.iva_pct != null ? Number(f.iva_pct) : IVA_DEFAULT;
        const neto = costoUsd * (1 + margen / 100);
        out.set(f.id as number, {
            catalogo_id: f.id as number,
            proveedor: f.proveedor as string,
            sku: f.sku as string,
            descripcion: f.descripcion as string,
            marca: (f.marca as string | null) ?? null,
            stock: (f.stock as number | null) ?? null,
            moneda_origen: f.moneda as string,
            costo_usd: r2(costoUsd),
            margen_pct: margen,
            precio_unit_usd: r2(neto),
            iva_pct: iva,
            precio_unit_final_usd: r2(neto * (1 + iva / 100)),
        });
    }
    return out;
}

export async function cotizar(pedido: string, opts: { cliente_id?: string } = {}): Promise<ResultadoCotizacion> {
    const inicio = Date.now();
    const vacio = (detalle: string): ResultadoCotizacion => ({
        ok: false, pedido, lineas: [], comentario: '', tipo_cambio: 0, fuente_tc: '',
        subtotal_usd: 0, iva_usd: 0, total_usd: 0, total_ars: 0, busquedas: 0, costo_ia_usd: 0,
        duracion_ms: Date.now() - inicio, detalle,
    });

    const { count } = await supabase.from('catalogo_proveedores').select('id', { count: 'exact', head: true });
    if (!count) return vacio('El catálogo está vacío. Sincronizá algún proveedor o importá una lista CSV primero.');

    let tc: { valor: number; fuente: string };
    try { tc = await tipoDeCambio(); } catch (err) { return vacio((err as Error).message); }

    const { data: filaAsist } = await supabase.from('asistentes').select('prompt, modelo').eq('area', 'cotizador').maybeSingle();
    const modelo = (filaAsist?.modelo as 'sonnet' | 'haiku' | 'opus' | undefined) ?? 'sonnet';
    const system = (filaAsist?.prompt as string | null)?.trim() || PROMPT_DEFAULT;

    const mensajes: Anthropic.MessageParam[] = [{ role: 'user', content: `Pedido del cliente:\n${pedido}` }];
    let tokensIn = 0, tokensOut = 0, busquedas = 0;
    let textoFinal = '';

    for (let i = 0; i < 15; i++) {
        const resp = await anthropic.messages.create({
            model: idModelo(modelo),
            max_tokens: 4096,
            system,
            tools: TOOLS,
            messages: mensajes,
        });
        tokensIn += resp.usage.input_tokens;
        tokensOut += resp.usage.output_tokens;
        mensajes.push({ role: 'assistant', content: resp.content });

        const usos = resp.content.filter((c): c is Anthropic.ToolUseBlock => c.type === 'tool_use');
        if (usos.length === 0) {
            textoFinal = resp.content.filter((c): c is Anthropic.TextBlock => c.type === 'text').map((t) => t.text).join('\n');
            break;
        }
        const resultados: Anthropic.ToolResultBlockParam[] = [];
        for (const u of usos) {
            busquedas++;
            try {
                const inp = u.input as { consulta: string; solo_con_stock?: boolean; limite?: number };
                const filas = await buscar(inp.consulta, inp.solo_con_stock ?? true, inp.limite ?? 15);
                // Al modelo le pasamos el costo tal cual; el precio de venta lo calcula el código.
                resultados.push({
                    type: 'tool_result', tool_use_id: u.id,
                    content: JSON.stringify(filas.map((f) => ({
                        id: f.id, proveedor: f.proveedor, sku: f.sku, descripcion: f.descripcion,
                        marca: f.marca, categoria: f.categoria, costo: f.precio, moneda: f.moneda, stock: f.stock,
                    }))),
                });
            } catch (err) {
                resultados.push({ type: 'tool_result', tool_use_id: u.id, content: `ERROR: ${(err as Error).message}`, is_error: true });
            }
        }
        mensajes.push({ role: 'user', content: resultados });
    }

    const costoIa = calcularCosto(modelo, tokensIn, tokensOut);
    const m = /<cotizacion>([\s\S]*?)<\/cotizacion>/i.exec(textoFinal);
    if (!m) return { ...vacio('El asistente no devolvió una cotización válida'), costo_ia_usd: costoIa, busquedas };

    let parsed: { items?: Array<{ pedido?: string; cantidad?: number; catalogo_id?: number | null; alternativas?: number[]; nota?: string }>; comentario?: string };
    try { parsed = JSON.parse((m[1] ?? '').trim()); } catch { return { ...vacio('JSON de cotización malformado'), costo_ia_usd: costoIa, busquedas }; }

    const items = parsed.items ?? [];
    const ids = new Set<number>();
    for (const it of items) {
        if (typeof it.catalogo_id === 'number') ids.add(it.catalogo_id);
        for (const a of it.alternativas ?? []) if (typeof a === 'number') ids.add(a);
    }
    const precios = await preciar(Array.from(ids), tc.valor);

    const lineas: LineaCotizada[] = items.map((it) => ({
        pedido: it.pedido ?? '',
        cantidad: Math.max(1, Math.round(Number(it.cantidad ?? 1))),
        nota: it.nota ?? '',
        elegido: typeof it.catalogo_id === 'number' ? precios.get(it.catalogo_id) ?? null : null,
        alternativas: (it.alternativas ?? []).map((a) => precios.get(a)).filter((x): x is ArticuloPrecio => !!x),
    }));

    let subtotal = 0, iva = 0;
    for (const l of lineas) {
        if (!l.elegido) continue;
        subtotal += l.elegido.precio_unit_usd * l.cantidad;
        iva += (l.elegido.precio_unit_final_usd - l.elegido.precio_unit_usd) * l.cantidad;
    }
    const totalUsd = r2(subtotal + iva);

    const resultado: ResultadoCotizacion = {
        ok: true,
        pedido,
        lineas,
        comentario: parsed.comentario ?? '',
        tipo_cambio: tc.valor,
        fuente_tc: tc.fuente,
        subtotal_usd: r2(subtotal),
        iva_usd: r2(iva),
        total_usd: totalUsd,
        total_ars: r2(totalUsd * tc.valor),
        busquedas,
        costo_ia_usd: costoIa,
        duracion_ms: Date.now() - inicio,
    };

    const { data: guardada } = await supabase.from('cotizaciones').insert({
        pedido,
        cliente_id: opts.cliente_id ?? null,
        items: lineas as unknown as Record<string, unknown>[],
        resumen_md: resultado.comentario,
        total_usd: resultado.total_usd,
        total_ars: resultado.total_ars,
        tipo_cambio: tc.valor,
        costo_ia_usd: costoIa,
        resultado: resultado as unknown as Record<string, unknown>,
    }).select('id').single();
    resultado.id = guardada?.id as string | undefined;

    return resultado;
}

// ---------- Historial ----------

interface FilaCotizacion {
    id: string;
    titulo: string | null;
    pedido: string;
    cliente_id: string | null;
    items: LineaCotizada[] | null;
    resumen_md: string | null;
    total_usd: number | string | null;
    total_ars: number | string | null;
    tipo_cambio: number | string | null;
    costo_ia_usd: number | string | null;
    resultado: ResultadoCotizacion | null;
    numero: number | null;
    datos_cliente: DatosCliente | null;
    creado_en: string;
    estado: EstadoVenta | null;
    enviada_en: string | null;
    cerrada_en: string | null;
    motivo_cierre: string | null;
}

export type EstadoVenta = 'abierta' | 'enviada' | 'ganada' | 'perdida';

export interface DatosCliente {
    cuit?: string;
    direccion?: string;
    localidad?: string;
    atencion?: string;
    email?: string;
    objeto?: string;
}

export interface CotizacionGuardada extends ResultadoCotizacion {
    titulo: string | null;
    numero: number | null;
    datos_cliente: DatosCliente;
    creado_en: string;
    cliente_id: string | null;
    estado: EstadoVenta;
    enviada_en: string | null;
    cerrada_en: string | null;
    motivo_cierre: string | null;
}

// Las cotizaciones anteriores a la columna `resultado` se rearman desde items + totales.
function rearmar(f: FilaCotizacion): CotizacionGuardada {
    const base: ResultadoCotizacion = f.resultado ?? (() => {
        const lineas = f.items ?? [];
        let subtotal = 0, iva = 0;
        for (const l of lineas) {
            if (!l.elegido) continue;
            subtotal += l.elegido.precio_unit_usd * l.cantidad;
            iva += (l.elegido.precio_unit_final_usd - l.elegido.precio_unit_usd) * l.cantidad;
        }
        return {
            ok: true,
            pedido: f.pedido,
            lineas,
            comentario: f.resumen_md ?? '',
            tipo_cambio: Number(f.tipo_cambio ?? 0),
            fuente_tc: '',
            subtotal_usd: r2(subtotal),
            iva_usd: r2(iva),
            total_usd: Number(f.total_usd ?? 0),
            total_ars: Number(f.total_ars ?? 0),
            busquedas: 0,
            costo_ia_usd: Number(f.costo_ia_usd ?? 0),
            duracion_ms: 0,
        };
    })();
    return {
        ...base, id: f.id, titulo: f.titulo, numero: f.numero, datos_cliente: f.datos_cliente ?? {}, creado_en: f.creado_en,
        cliente_id: f.cliente_id, estado: f.estado ?? 'abierta', enviada_en: f.enviada_en, cerrada_en: f.cerrada_en, motivo_cierre: f.motivo_cierre,
    };
}

export async function listarCotizaciones(limite = 50) {
    const { data, error } = await supabase
        .from('cotizaciones')
        .select('id, titulo, pedido, total_usd, total_ars, creado_en, items, numero, estado, enviada_en, cerrada_en, motivo_cierre, cliente_id')
        .order('creado_en', { ascending: false })
        .limit(limite);
    if (error) throw new Error(error.message);
    return (data ?? []).map((f) => ({
        id: f.id as string,
        titulo: (f.titulo as string | null) ?? null,
        pedido: f.pedido as string,
        total_usd: Number(f.total_usd ?? 0),
        total_ars: Number(f.total_ars ?? 0),
        renglones: Array.isArray(f.items) ? f.items.length : 0,
        creado_en: f.creado_en as string,
        numero: (f.numero as number | null) ?? null,
        estado: ((f.estado as EstadoVenta | null) ?? 'abierta'),
        enviada_en: (f.enviada_en as string | null) ?? null,
        cerrada_en: (f.cerrada_en as string | null) ?? null,
        motivo_cierre: (f.motivo_cierre as string | null) ?? null,
        cliente_id: (f.cliente_id as string | null) ?? null,
    }));
}

export async function obtenerCotizacion(id: string): Promise<CotizacionGuardada | null> {
    const { data, error } = await supabase.from('cotizaciones').select('*').eq('id', id).maybeSingle();
    if (error) throw new Error(error.message);
    return data ? rearmar(data as FilaCotizacion) : null;
}

export async function actualizarCotizacion(
    id: string,
    cambios: { titulo?: string | null; datos_cliente?: DatosCliente },
): Promise<boolean> {
    const { data, error } = await supabase.from('cotizaciones').update(cambios).eq('id', id).select('id');
    if (error) throw new Error(error.message);
    return (data ?? []).length > 0;
}

export async function borrarCotizacion(id: string): Promise<boolean> {
    const { data, error } = await supabase.from('cotizaciones').delete().eq('id', id).select('id');
    if (error) throw new Error(error.message);
    return (data ?? []).length > 0;
}

// Número de presupuesto: se asigna la primera vez que se genera el PDF.
export async function numeroPresupuesto(id: string): Promise<number | null> {
    const { data, error } = await supabase.rpc('asignar_numero_presupuesto', { p_id: id });
    if (error) throw new Error(error.message);
    // Con número (PDF generado) el presupuesto pasa a "enviada".
    if (data != null) {
        await supabase.from('cotizaciones').update({ estado: 'enviada', enviada_en: new Date().toISOString() })
            .eq('id', id).eq('estado', 'abierta');
    }
    return (data as number | null) ?? null;
}

// Cierre del ciclo de venta. Ganar un presupuesto convierte al lead en cliente.
export async function cerrarCotizacion(
    id: string,
    estado: EstadoVenta,
    motivo?: string | null,
): Promise<{ ok: boolean; cliente_actualizado?: boolean }> {
    const cerrada = estado === 'ganada' || estado === 'perdida';
    const cambios: Record<string, unknown> = {
        estado,
        cerrada_en: cerrada ? new Date().toISOString() : null,
        motivo_cierre: cerrada ? (motivo?.trim() || null) : null,
    };
    if (estado === 'enviada') cambios.enviada_en = new Date().toISOString();
    const { data, error } = await supabase.from('cotizaciones').update(cambios).eq('id', id).select('id, cliente_id');
    if (error) throw new Error(error.message);
    const fila = data?.[0];
    if (!fila) return { ok: false };
    let clienteActualizado = false;
    if (estado === 'ganada' && fila.cliente_id) {
        const { data: c } = await supabase.from('clientes').update({ estado: 'cliente' })
            .eq('id', fila.cliente_id).in('estado', ['lead', 'inactivo']).select('id');
        clienteActualizado = (c ?? []).length > 0;
    }
    return { ok: true, cliente_actualizado: clienteActualizado };
}

// Presupuestos enviados que siguen sin respuesta después de `dias`.
export async function presupuestosSinRespuesta(dias = 5, limite = 20) {
    const hasta = new Date(Date.now() - dias * 86_400_000).toISOString();
    const { data, error } = await supabase.from('cotizaciones')
        .select('id, titulo, numero, total_usd, enviada_en, cliente_id, seguimiento_en, pedido')
        .eq('estado', 'enviada').lte('enviada_en', hasta)
        .order('enviada_en', { ascending: true }).limit(limite);
    if (error) throw new Error(error.message);
    return (data ?? []).map((f) => ({
        id: f.id as string,
        titulo: (f.titulo as string | null) ?? null,
        numero: (f.numero as number | null) ?? null,
        total_usd: Number(f.total_usd ?? 0),
        enviada_en: f.enviada_en as string,
        cliente_id: (f.cliente_id as string | null) ?? null,
        seguimiento_en: (f.seguimiento_en as string | null) ?? null,
        pedido: f.pedido as string,
    }));
}

// Propuesta de envío de un presupuesto por correo, con el PDF adjunto al
// aprobar. El texto es una plantilla corta que se puede editar en Para aprobar.
export async function proponerEnvioCotizacion(
    id: string,
    para: string,
    nombre?: string,
): Promise<{ ok: boolean; accion_id?: string; detalle?: string }> {
    const q = await obtenerCotizacion(id);
    if (!q) return { ok: false, detalle: 'Cotización no encontrada' };
    const elegidas = q.lineas.filter((l) => l.elegido);
    if (elegidas.length === 0) return { ok: false, detalle: 'La cotización no tiene artículos para presupuestar' };

    const { data: pend } = await supabase.from('acciones_pendientes').select('id')
        .eq('estado', 'pendiente').eq('accion', 'enviar_correo').contains('payload', { cotizacion_id: id }).limit(1);
    if (pend && pend.length) return { ok: false, detalle: 'Este presupuesto ya está esperando aprobación en Para aprobar' };

    // Cliente: el de la cotización, o el que tenga ese email.
    let clienteId = q.cliente_id;
    let nombreCliente = nombre?.trim() || q.titulo || '';
    if (!clienteId) {
        const { data: c } = await supabase.from('clientes').select('id, nombre').eq('email', para).maybeSingle();
        if (c) { clienteId = c.id as string; nombreCliente ||= c.nombre as string; }
    }
    if (clienteId && !q.cliente_id) await supabase.from('cotizaciones').update({ cliente_id: clienteId }).eq('id', id);

    const { data: asist } = await supabase.from('asistentes').select('id').eq('area', 'correo').maybeSingle();
    const saludo = q.datos_cliente?.atencion?.trim() || nombreCliente;
    const resumen = elegidas.length === 1
        ? `${elegidas[0]!.cantidad} x ${elegidas[0]!.elegido!.descripcion}`
        : `${elegidas.length} ítems (${elegidas.reduce((s, l) => s + l.cantidad, 0)} unidades)`;
    const total = q.total_usd.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const cuerpo = [
        `Hola${saludo ? ` ${saludo.split(' ')[0]}` : ''}, ¿cómo estás?`,
        '',
        `Te adjunto el presupuesto por ${resumen}. El total es US$ ${total} con IVA incluido.`,
        'Los precios están en dólares (billete BNA) y el presupuesto tiene una validez de 7 días, sujeto a stock.',
        '',
        'Cualquier consulta o si querés ajustar algo, me escribís.',
        '',
        'Saludos,',
        'Andrés — Bartez Tecnología',
    ].join('\n');

    const { data, error } = await supabase.from('acciones_pendientes').insert({
        asistente_id: asist?.id ?? null,
        accion: 'enviar_correo',
        estado: 'pendiente',
        payload: {
            para,
            asunto: `Presupuesto Bartez Tecnología${q.titulo ? ` — ${q.titulo}` : ''}`,
            cuerpo,
            clienteId,
            nombreCliente: nombreCliente || null,
            cotizacion_id: id,
            adjunto: { tipo: 'presupuesto', total_usd: q.total_usd },
        },
        respuesta: { por: 'sistema', origen: 'cotizador' },
    }).select('id').single();
    if (error) return { ok: false, detalle: error.message };
    return { ok: true, accion_id: data.id as string };
}
