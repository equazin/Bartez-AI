// Mapa del negocio para el Inicio: Bartez al centro, los asistentes alrededor y
// de cada asistente cuelgan los clientes (o presupuestos) que tiene entre manos.
// Cada nodo trae su detalle ya armado (historia corta, lo que está en juego y
// una sugerencia con la acción) para que el panel no tenga que pedir más.
// También arma las sugerencias del botón flotante de Bartez AI.
// Se cachea 60 s, igual que el resumen del día.

import { supabase } from '../connectors/supabase.js';
import { presupuestosSinRespuesta } from './cotizador.js';

const TZ = 'America/Argentina/Buenos_Aires';
const DIA_MS = 86_400_000;
const POR_ASISTENTE = 4;

export type AreaMapa = 'seguimientos' | 'cotizador' | 'correo' | 'whatsapp' | 'prospeccion';

export interface EventoNodo { fecha: string; texto: string; tipo: 'consulta' | 'presupuesto' | 'venta' | 'contacto' }

export interface AccionNodo {
    etiqueta: string;
    // 'chat': abre Bartez AI con el pedido escrito; 'ir': cambia de pantalla.
    tipo: 'chat' | 'ir';
    texto?: string;
    destino?: 'acciones' | 'cotizador' | 'seguimientos' | 'whatsapp' | 'prospeccion';
    // Con destino 'cotizador': abre esa cotización.
    cotizacion_id?: string;
}

export interface NodoMapa {
    id: string;
    tipo: 'cliente' | 'presupuesto' | 'conversacion';
    nombre: string;
    subtitulo: string;
    urgente: boolean;
    consultas: number;
    presupuestos: number;
    en_juego_usd: number | null;
    dias_sin_respuesta: number | null;
    compras: number | null;
    historia: EventoNodo[];
    sugerencia: string;
    acciones: AccionNodo[];
}

export interface AsistenteMapa {
    area: AreaMapa;
    nombre: string;
    aprobacion_pct: number | null;
    resueltas_30d: number;
    pendientes: number;
    nodos: NodoMapa[];
    mas: number;
}

export interface Sugerencia { texto: string; pedido: string }

export interface Mapa {
    cierre_pct: number | null;
    asistentes: AsistenteMapa[];
    meses: Array<{ mes: string; ganado_usd: number; perdido_usd: number }>;
    sugerencias: Sugerencia[];
    generado_en: string;
}

const NOMBRES: Record<AreaMapa, string> = {
    seguimientos: 'Seguimientos', cotizador: 'Cotizador', correo: 'Correo', whatsapp: 'WhatsApp', prospeccion: 'Prospección',
};

const dias = (iso: string | null | undefined) => (iso ? Math.floor((Date.now() - new Date(iso).getTime()) / DIA_MS) : null);
const usd = (n: number) => `US$ ${n.toLocaleString('es-AR', { maximumFractionDigits: 0 })}`;
const presupuestoN = (numero: number | string | null) => (numero ? `presupuesto ${numero}` : 'el presupuesto');
// Número para mostrar: el del documento si vino de uno, si no el del Cotizador.
const nro = (q: { numero: number | null; numero_externo?: string | null }) => q.numero_externo ?? q.numero;

interface FilaCot {
    id: string; titulo: string | null; numero: number | null; numero_externo?: string | null; total_usd: number | string | null; estado: string | null;
    creado_en: string; enviada_en: string | null; cerrada_en: string | null; cliente_id: string | null;
    datos_cliente: { atencion?: string; email?: string } | null; pedido: string | null;
}

// Nombre para mostrar de un presupuesto: el cliente vinculado, a quién va
// dirigido o, si no hay nada, el título.
function nombreCot(c: FilaCot, clientes: Map<string, { nombre: string }>): string {
    const cl = c.cliente_id ? clientes.get(c.cliente_id) : undefined;
    return cl?.nombre || c.datos_cliente?.atencion?.trim() || c.titulo?.trim() || (nro(c) ? `Presupuesto ${nro(c)}` : 'Presupuesto sin nombre');
}

let cache: { en: number; datos: Mapa } | null = null;

export function invalidarMapa(): void { cache = null; }

export async function calcularMapa(forzar = false): Promise<Mapa> {
    if (!forzar && cache && Date.now() - cache.en < 60_000) return cache.datos;
    const ahora = Date.now();
    const hace30 = new Date(ahora - 30 * DIA_MS).toISOString();
    const anio = new Date(ahora).toLocaleDateString('en-CA', { timeZone: TZ }).slice(0, 4);

    const [asist, acciones, cotsRes, clientesRes, correosRes, waRes, sinRespuesta] = await Promise.all([
        supabase.from('asistentes').select('id, area').in('area', Object.keys(NOMBRES)),
        supabase.from('acciones_pendientes').select('asistente_id, estado, resuelto_en, creado_en').or(`estado.eq.pendiente,resuelto_en.gte.${hace30}`),
        supabase.from('cotizaciones')
            .select('id, titulo, numero, numero_externo, total_usd, estado, creado_en, enviada_en, cerrada_en, cliente_id, datos_cliente, pedido')
            .or(`creado_en.gte.${new Date(ahora - 60 * DIA_MS).toISOString()},cerrada_en.gte.${anio}-01-01`)
            .order('creado_en', { ascending: false }).limit(400),
        supabase.from('clientes').select('id, nombre, email, estado, metadata, creado_en, ultimo_contacto_en, intentos_contacto'),
        supabase.from('correos_historicos').select('cliente_id, asunto, fecha').eq('direccion', 'entrante').eq('ignorable', false)
            .not('cliente_id', 'is', null).gte('fecha', hace30).order('fecha', { ascending: false }).limit(500),
        supabase.from('wa_conversaciones').select('wa_id, nombre, cliente_id, ultimo_entrante_en, ultimo_mensaje, ultimo_direccion, actualizado_en')
            .gte('actualizado_en', new Date(ahora - 14 * DIA_MS).toISOString()).order('actualizado_en', { ascending: false }).limit(40),
        presupuestosSinRespuesta(5, 50),
    ]);
    for (const r of [asist, acciones, cotsRes, clientesRes, correosRes, waRes]) if (r.error) throw new Error(r.error.message);

    const cots = (cotsRes.data ?? []) as FilaCot[];
    type FilaCliente = { id: string; nombre: string; email: string | null; estado: string | null; metadata: Record<string, unknown> | null; creado_en: string; ultimo_contacto_en: string | null; intentos_contacto: number | null };
    const clientes = new Map(((clientesRes.data ?? []) as FilaCliente[]).map((c) => [c.id, c]));
    const correos = (correosRes.data ?? []) as Array<{ cliente_id: string; asunto: string | null; fecha: string }>;

    // Historia y compras por cliente, para los nodos que son clientes.
    const correosDe = new Map<string, typeof correos>();
    for (const c of correos) { const l = correosDe.get(c.cliente_id) ?? []; l.push(c); correosDe.set(c.cliente_id, l); }
    const cotsDe = new Map<string, FilaCot[]>();
    for (const c of cots) if (c.cliente_id) { const l = cotsDe.get(c.cliente_id) ?? []; l.push(c); cotsDe.set(c.cliente_id, l); }
    const historiaCliente = (id: string): EventoNodo[] => {
        const ev: EventoNodo[] = [];
        for (const c of (correosDe.get(id) ?? []).slice(0, 3)) ev.push({ fecha: c.fecha, texto: c.asunto?.trim() || 'Consulta por correo', tipo: 'consulta' });
        for (const q of (cotsDe.get(id) ?? []).slice(0, 3)) {
            if (q.estado === 'ganada') ev.push({ fecha: q.cerrada_en ?? q.creado_en, texto: `Compra ganada · ${usd(Number(q.total_usd ?? 0))}`, tipo: 'venta' });
            else ev.push({ fecha: q.enviada_en ?? q.creado_en, texto: `${nro(q) ? `Presupuesto ${nro(q)}` : 'Presupuesto'} ${q.estado === 'enviada' ? 'enviado' : 'armado'} · ${usd(Number(q.total_usd ?? 0))}`, tipo: 'presupuesto' });
        }
        return ev.sort((a, b) => b.fecha.localeCompare(a.fecha)).slice(0, 4);
    };
    const comprasDe = (id: string | null) => (id ? (cotsDe.get(id) ?? []).filter((q) => q.estado === 'ganada').length : null);
    const historiaCot = (q: FilaCot): EventoNodo[] => {
        const ev: EventoNodo[] = [{ fecha: q.creado_en, texto: `Armado: ${(q.titulo || q.pedido || '').slice(0, 60)}`, tipo: 'presupuesto' }];
        if (q.enviada_en) ev.unshift({ fecha: q.enviada_en, texto: `Enviado · ${usd(Number(q.total_usd ?? 0))}`, tipo: 'presupuesto' });
        if (q.cliente_id) ev.push(...historiaCliente(q.cliente_id).filter((e) => e.tipo === 'consulta').slice(0, 2));
        return ev.slice(0, 4);
    };

    const usados = new Set<string>();   // un cliente aparece en un solo asistente
    const cotsUsadas = new Set<string>();
    const clave = (q: FilaCot) => q.cliente_id ?? `cot:${q.id}`;

    // Seguimientos: presupuestos enviados hace 5+ días sin respuesta.
    const porId = new Map(cots.map((c) => [c.id, c]));
    const nodosSeg: NodoMapa[] = [];
    for (const s of sinRespuesta) {
        const q = porId.get(s.id) ?? ({ ...s, estado: 'enviada', creado_en: s.enviada_en, cerrada_en: null, datos_cliente: null } as unknown as FilaCot);
        if (usados.has(clave(q))) continue;
        usados.add(clave(q)); cotsUsadas.add(q.id);
        const d = dias(q.enviada_en) ?? 0;
        const nombre = nombreCot(q, clientes);
        nodosSeg.push({
            id: `cot:${q.id}`, tipo: 'presupuesto', nombre, subtitulo: `${nro(q) ? `Presupuesto ${nro(q)}` : 'Presupuesto'} · ${d} días sin respuesta`,
            urgente: d >= 5, consultas: q.cliente_id ? (correosDe.get(q.cliente_id)?.length ?? 0) : 0, presupuestos: 1,
            en_juego_usd: Number(q.total_usd ?? 0), dias_sin_respuesta: d, compras: comprasDe(q.cliente_id), historia: historiaCot(q),
            sugerencia: `Un seguimiento hoy. Los presupuestos que se siguen antes del día 7 tienen más chance de cerrarse.`,
            acciones: [
                { etiqueta: 'Preparar seguimiento', tipo: 'chat', texto: `Hacé un seguimiento a ${nombre} por el ${presupuestoN(nro(q))} de ${usd(Number(q.total_usd ?? 0))}, enviado hace ${d} días.` },
                { etiqueta: 'Ver presupuesto', tipo: 'ir', destino: 'cotizador', cotizacion_id: q.id },
            ],
        });
    }

    // Cotizador: presupuestos abiertos o recién enviados de los últimos 30 días.
    const nodosCot: NodoMapa[] = [];
    for (const q of cots) {
        if (cotsUsadas.has(q.id) || !['abierta', 'enviada'].includes(q.estado ?? 'abierta')) continue;
        if (q.creado_en < hace30 || usados.has(clave(q))) continue;
        usados.add(clave(q)); cotsUsadas.add(q.id);
        const nombre = nombreCot(q, clientes);
        const enviada = q.estado === 'enviada';
        nodosCot.push({
            id: `cot:${q.id}`, tipo: 'presupuesto', nombre,
            subtitulo: enviada ? `${nro(q) ? `Presupuesto ${nro(q)}` : 'Presupuesto'} enviado hace ${dias(q.enviada_en) ?? 0} días` : 'Armado, falta enviarlo',
            urgente: false, consultas: q.cliente_id ? (correosDe.get(q.cliente_id)?.length ?? 0) : 0, presupuestos: 1,
            en_juego_usd: Number(q.total_usd ?? 0), dias_sin_respuesta: enviada ? dias(q.enviada_en) : null, compras: comprasDe(q.cliente_id),
            historia: historiaCot(q),
            sugerencia: enviada ? 'Todavía está en plazo. Si no responde en unos días, Seguimientos te propone escribirle.' : 'Revisalo y mandalo por correo con el PDF desde el Cotizador.',
            acciones: enviada
                ? [{ etiqueta: 'Ver presupuesto', tipo: 'ir', destino: 'cotizador', cotizacion_id: q.id }]
                : [{ etiqueta: 'Revisar y enviar', tipo: 'ir', destino: 'cotizador', cotizacion_id: q.id }, { etiqueta: 'Preguntar', tipo: 'chat', texto: `¿Qué le falta al presupuesto de ${nombre} para enviarlo?` }],
        });
    }

    // Correo: clientes que escribieron en los últimos 30 días.
    const nodosCorreo: NodoMapa[] = [];
    for (const [id, lista] of correosDe) {
        if (usados.has(id)) continue;
        const cl = clientes.get(id);
        if (!cl) continue;
        usados.add(id);
        const ultimo = lista[0]!;
        nodosCorreo.push({
            id: `cli:${id}`, tipo: 'cliente', nombre: cl.nombre, subtitulo: `${lista.length} ${lista.length === 1 ? 'correo' : 'correos'} este mes · último: ${ultimo.asunto?.trim() || 'sin asunto'}`,
            urgente: false, consultas: lista.length, presupuestos: cotsDe.get(id)?.length ?? 0,
            en_juego_usd: null, dias_sin_respuesta: null, compras: comprasDe(id), historia: historiaCliente(id),
            sugerencia: 'El asistente de Correo responde lo que entra y te deja la respuesta en Para aprobar.',
            acciones: [{ etiqueta: 'Resumir la relación', tipo: 'chat', texto: `Resumime la relación con ${cl.nombre}: qué pidió, qué le mandamos y qué quedó pendiente.` }, { etiqueta: 'Ver cliente', tipo: 'ir', destino: 'seguimientos' }],
        });
    }
    nodosCorreo.sort((a, b) => b.consultas - a.consultas);

    // WhatsApp: conversaciones activas en las últimas 2 semanas.
    const nodosWa: NodoMapa[] = [];
    for (const w of (waRes.data ?? []) as Array<{ wa_id: string; nombre: string | null; cliente_id: string | null; ultimo_entrante_en: string | null; ultimo_mensaje: string | null; ultimo_direccion: string | null; actualizado_en: string }>) {
        const k = w.cliente_id ?? `wa:${w.wa_id}`;
        if (usados.has(k)) continue;
        usados.add(k);
        const nombre = (w.cliente_id && clientes.get(w.cliente_id)?.nombre) || w.nombre || `+${w.wa_id}`;
        const horas = w.ultimo_entrante_en ? (ahora - new Date(w.ultimo_entrante_en).getTime()) / 3600_000 : null;
        const esperando = w.ultimo_direccion === 'entrante' && horas != null && horas < 24;
        nodosWa.push({
            id: `wa:${w.wa_id}`, tipo: 'conversacion', nombre,
            subtitulo: esperando ? `Espera respuesta · la ventana cierra en ${Math.max(1, Math.round(24 - horas!))} h` : (w.ultimo_mensaje?.slice(0, 60) || 'Conversación reciente'),
            urgente: esperando && horas! > 18, consultas: 1, presupuestos: w.cliente_id ? (cotsDe.get(w.cliente_id)?.length ?? 0) : 0,
            en_juego_usd: null, dias_sin_respuesta: null, compras: comprasDe(w.cliente_id),
            historia: [{ fecha: w.actualizado_en, texto: w.ultimo_mensaje?.slice(0, 70) || 'Mensaje de WhatsApp', tipo: 'consulta' }],
            sugerencia: esperando ? 'Respondé antes de que cierre la ventana de 24 h; después solo se puede escribir con plantilla.' : 'Si pasa más de un día sin respuesta, podés retomarla con una plantilla.',
            acciones: [{ etiqueta: 'Abrir conversación', tipo: 'ir', destino: 'whatsapp' }],
        });
    }

    // Prospección: leads con mejor puntaje de ICP que todavía no se contactaron.
    const icp = (c: FilaCliente) => Number((c.metadata as { puntaje_icp?: number } | null)?.puntaje_icp ?? 0) || 0;
    const nodosPros: NodoMapa[] = [...clientes.values()]
        .filter((c) => c.estado === 'lead' && !usados.has(c.id))
        .sort((a, b) => icp(b) - icp(a) || b.creado_en.localeCompare(a.creado_en))
        .map((c) => {
            const p = icp(c), intentos = c.intentos_contacto ?? 0;
            return {
                id: `cli:${c.id}`, tipo: 'cliente' as const, nombre: c.nombre,
                subtitulo: `${p ? `ICP ${p}/10 · ` : ''}${intentos ? `${intentos} ${intentos === 1 ? 'contacto' : 'contactos'}` : 'sin contactar'}`,
                urgente: false, consultas: 0, presupuestos: 0, en_juego_usd: null, dias_sin_respuesta: null, compras: null,
                historia: [{ fecha: c.creado_en, texto: 'Encontrado por Prospección', tipo: 'contacto' as const }, ...(c.ultimo_contacto_en ? [{ fecha: c.ultimo_contacto_en, texto: 'Último contacto', tipo: 'contacto' as const }] : [])],
                sugerencia: intentos ? 'Ya hubo contacto. Seguimientos lo retoma si no responde.' : 'Todavía no le escribimos. Un primer correo corto presentando Bartez.',
                acciones: intentos
                    ? [{ etiqueta: 'Ver prospecto', tipo: 'ir' as const, destino: 'prospeccion' as const }]
                    : [{ etiqueta: 'Escribirle', tipo: 'chat' as const, texto: `Redactá un primer correo para ${c.nombre} presentando Bartez Tecnología.` }, { etiqueta: 'Ver prospecto', tipo: 'ir' as const, destino: 'prospeccion' as const }],
            };
        });

    // Aprobación y pendientes por asistente.
    const areaDe = new Map(((asist.data ?? []) as Array<{ id: string; area: AreaMapa }>).map((a) => [a.id, a.area]));
    const stats = new Map<AreaMapa, { res: number; ok: number; pend: number }>();
    for (const a of (acciones.data ?? []) as Array<{ asistente_id: string | null; estado: string }>) {
        const area = a.asistente_id ? areaDe.get(a.asistente_id) : undefined;
        if (!area) continue;
        const s = stats.get(area) ?? { res: 0, ok: 0, pend: 0 };
        if (a.estado === 'pendiente') s.pend++;
        else { s.res++; if (['aprobada', 'editada', 'ejecutada'].includes(a.estado)) s.ok++; }
        stats.set(area, s);
    }
    const armar = (area: AreaMapa, nodos: NodoMapa[]): AsistenteMapa => {
        const s = stats.get(area) ?? { res: 0, ok: 0, pend: 0 };
        return {
            area, nombre: NOMBRES[area], resueltas_30d: s.res, pendientes: s.pend,
            // Con menos de 3 decisiones el porcentaje no dice nada.
            aprobacion_pct: s.res >= 3 ? Math.round((s.ok / s.res) * 100) : null,
            nodos: nodos.slice(0, POR_ASISTENTE), mas: Math.max(0, nodos.length - POR_ASISTENTE),
        };
    };

    // Cierre de los últimos 90 días y ganado/perdido por mes del año.
    const desde90 = new Date(ahora - 90 * DIA_MS).toISOString();
    let gan = 0, per = 0;
    const meses = Array.from({ length: Number(new Date(ahora).toLocaleDateString('en-CA', { timeZone: TZ }).slice(5, 7)) }, (_, i) => ({ mes: `${anio}-${String(i + 1).padStart(2, '0')}`, ganado_usd: 0, perdido_usd: 0 }));
    for (const q of cots) {
        if (!q.cerrada_en || !['ganada', 'perdida'].includes(q.estado ?? '')) continue;
        if (q.cerrada_en >= desde90) { if (q.estado === 'ganada') gan++; else per++; }
        const m = meses.find((x) => x.mes === new Date(q.cerrada_en!).toLocaleDateString('en-CA', { timeZone: TZ }).slice(0, 7));
        if (m) { if (q.estado === 'ganada') m.ganado_usd += Number(q.total_usd ?? 0); else m.perdido_usd += Number(q.total_usd ?? 0); }
    }

    const asistentes = [
        armar('seguimientos', nodosSeg), armar('cotizador', nodosCot), armar('correo', nodosCorreo),
        armar('whatsapp', nodosWa), armar('prospeccion', nodosPros),
    ];

    // Sugerencias del botón flotante: lo más urgente primero, después preguntas útiles.
    const sugerencias: Sugerencia[] = [];
    for (const n of nodosSeg.slice(0, 2)) sugerencias.push({ texto: `${n.nombre} no responde hace ${n.dias_sin_respuesta} días. ¿Preparo un seguimiento?`, pedido: n.acciones[0]!.texto! });
    for (const n of nodosWa.filter((w) => w.urgente).slice(0, 1)) sugerencias.push({ texto: `${n.nombre} espera respuesta por WhatsApp y la ventana está por cerrar.`, pedido: `¿Qué me escribió ${n.nombre} por WhatsApp y qué le respondo?` });
    const sinEnviar = nodosCot.filter((n) => n.dias_sin_respuesta == null);
    if (sinEnviar.length) sugerencias.push({ texto: `Tenés ${sinEnviar.length} ${sinEnviar.length === 1 ? 'presupuesto armado' : 'presupuestos armados'} sin enviar.`, pedido: '¿Qué presupuestos están armados y todavía no se enviaron?' });
    const pendTotal = [...stats.values()].reduce((s, x) => s + x.pend, 0);
    if (pendTotal) sugerencias.push({ texto: `${pendTotal} ${pendTotal === 1 ? 'respuesta espera' : 'respuestas esperan'} tu OK.`, pedido: '¿Qué tengo para aprobar y qué es lo más urgente?' });
    sugerencias.push({ texto: '¿Querés que te cuente cómo viene el mes?', pedido: '¿Cómo viene el mes? Cotizado, ganado y consultas comparado con el mes pasado.' });

    const datos: Mapa = {
        cierre_pct: gan + per > 0 ? Math.round((gan / (gan + per)) * 100) : null,
        asistentes,
        meses: meses.map((m) => ({ ...m, ganado_usd: Math.round(m.ganado_usd), perdido_usd: Math.round(m.perdido_usd) })),
        sugerencias: sugerencias.slice(0, 5),
        generado_en: new Date().toISOString(),
    };
    cache = { en: Date.now(), datos };
    return datos;
}
