// Genera un informe específico para un cliente/prospecto usando Sonnet.
// Agrega toda la info que hay (datos del cliente, correos previos, acciones,
// último contacto) y devuelve diagnóstico + propuesta de próximos pasos.

import { anthropic, calcularCosto, idModelo } from '../connectors/anthropic.js';
import { mensajesWhatsappDeCliente } from './whatsapp.js';
import { supabase } from '../connectors/supabase.js';
import { historicoConCliente } from '../inbound/importar_historico.js';
import { crearNota, documentosDeCliente, notasDeCliente, ultimoInforme } from './memoria.js';

export interface InformeCliente {
    ok: boolean;
    resumen_md: string;
    tokens_in: number;
    tokens_out: number;
    costo_usd: number;
    duracion_ms: number;
    detalle?: string;
    // Informe guardado (memoria del cliente)
    id?: string;
    creado_en?: string;
    origen?: 'manual' | 'automatico';
    // Partió del informe anterior y sumó solo lo nuevo
    incremental?: boolean;
    // No había nada nuevo desde el último: se devuelve ese, sin gastar IA
    sin_novedades?: boolean;
}

const PROMPT_SYSTEM = `Sos el asistente de Seguimientos de Bartez Tecnología. Recibís un
snapshot de un cliente/prospecto (correos, WhatsApp, presupuestos, notas del operador
y resúmenes de documentos que subió) y devolvés un informe corto y accionable.

Estilo: seco, directo, voseo, sin adulación.

Estructura del informe (markdown):

## Estado
Una línea: qué es este cliente hoy (lead frío, lead con conversación,
cliente activo, cliente inactivo, etc). Basado en datos reales del snapshot.

## Historia relevante
2-5 puntos con lo que pasó (cotizaciones, pedidos, quejas, documentos importantes
como órdenes de compra o presupuestos de la competencia). Fechas concretas.

## Estado actual
- Días desde el último contacto de cualquiera de los dos lados
- Compromisos pendientes de Bartez (si alguien dijo "te envío X" y no aparece después)
- Silencios del cliente (sin responder desde hace más de X días)
- Presupuestos abiertos o enviados sin respuesta, con monto

## Próximo paso sugerido
Una acción concreta (no más de 2 opciones). Ejemplos:
- "Reenviar la cotización del 12/8 que quedó sin respuesta"
- "Igualar o mejorar el presupuesto de la competencia que subiste el 3/9"
- "Descartar como lead inactivo — 45 días de silencio, no hubo interés"
- "Mover a cliente activo — cerró la última cotización"

Reglas:
- No inventes datos que no están en el snapshot.
- Las notas del operador son verdad (vienen de llamadas o charlas que el sistema no ve).
- Si el snapshot está vacío (nunca hubo contacto), decilo y proponé primer contacto.
- Sin frases relleno.`;

const PROMPT_ACTUALIZAR = `

MODO ACTUALIZACIÓN: te paso el informe anterior y SOLO las novedades desde esa fecha.
Reescribí el informe completo con la misma estructura, integrando lo nuevo:
conservá la historia que sigue valiendo, corregí lo que las novedades cambian y
dejá claro en "Estado actual" qué cambió desde el informe anterior.`;

const despues = (fecha: string | Date, desde: string | null) => !desde || new Date(fecha).getTime() > new Date(desde).getTime();

export async function generarInformeCliente(
    clienteId: string,
    opts: { contexto_extra?: string; origen?: 'manual' | 'automatico'; desdeCero?: boolean } = {},
): Promise<InformeCliente> {
    const inicio = Date.now();
    const vacio = (detalle: string): InformeCliente => ({ ok: false, resumen_md: '', tokens_in: 0, tokens_out: 0, costo_usd: 0, duracion_ms: Date.now() - inicio, detalle });

    const { data: cliente } = await supabase.from('clientes').select('*').eq('id', clienteId).maybeSingle();
    if (!cliente) return vacio('Cliente no encontrado');

    // Lo que escribió el operador queda guardado como nota: es memoria, no se pierde.
    if (opts.contexto_extra?.trim()) {
        try { await crearNota(clienteId, opts.contexto_extra); } catch (err) { return vacio((err as Error).message); }
    }

    const previo = opts.desdeCero ? null : await ultimoInforme(clienteId);
    const desde = previo?.creado_en ?? null;

    const [historia, wa, accionesRes, cotsRes, notas, docs] = await Promise.all([
        historicoConCliente(clienteId, 20),
        mensajesWhatsappDeCliente(clienteId, 30),
        supabase.from('acciones_pendientes').select('accion, payload, estado, respuesta, creado_en')
            .contains('respuesta', { cliente_id: clienteId }).order('creado_en', { ascending: false }).limit(20),
        supabase.from('cotizaciones').select('numero, numero_externo, titulo, total_usd, estado, creado_en, enviada_en, cerrada_en, motivo_cierre')
            .eq('cliente_id', clienteId).order('creado_en', { ascending: false }).limit(15),
        notasDeCliente(clienteId, 20),
        documentosDeCliente(clienteId),
    ]);

    const correos = historia.filter((h) => despues(h.fecha, desde)).map((h) => ({
        direccion: h.direccion,
        fecha: new Date(h.fecha).toISOString().slice(0, 10),
        de: h.de_email,
        para: h.para_email,
        asunto: h.asunto,
        categoria: h.categoria,
        cuerpo_recorte: (h.cuerpo ?? '').replace(/\s+/g, ' ').slice(0, 400),
    }));
    const whatsapp = wa.filter((m) => despues(m.creado_en, desde)).reverse().map((m) => ({
        fecha: new Date(m.creado_en).toISOString().slice(0, 16).replace('T', ' '),
        de: m.origen === 'cliente' ? 'cliente' : m.origen === 'bot' ? 'bot web' : 'bartez',
        texto: (m.cuerpo ?? '').replace(/\s+/g, ' ').slice(0, 300),
    }));
    const acciones = (accionesRes.data ?? []).filter((a) => despues(a.creado_en, desde)).map((a) => ({
        fecha: new Date(a.creado_en).toISOString().slice(0, 10),
        accion: a.accion,
        estado: a.estado,
        resumen: typeof (a.payload as { asunto?: string })?.asunto === 'string' ? (a.payload as { asunto: string }).asunto : a.accion,
    }));
    const presupuestos = (cotsRes.data ?? [])
        .filter((q) => [q.creado_en, q.enviada_en, q.cerrada_en].some((f) => f && despues(f as string, desde)))
        .map((q) => ({
            numero: q.numero_externo ?? q.numero, titulo: q.titulo, total_usd: Number(q.total_usd ?? 0), estado: q.estado,
            armado: String(q.creado_en).slice(0, 10), enviado: q.enviada_en ? String(q.enviada_en).slice(0, 10) : null,
            cerrado: q.cerrada_en ? String(q.cerrada_en).slice(0, 10) : null, motivo_cierre: q.motivo_cierre,
        }));
    // Las notas nuevas van completas (una conversación pegada puede ser larga):
    // es la única vez que el informe las lee enteras.
    const notasNuevas = notas.filter((n) => despues(n.creado_en, desde)).map((n) => ({ fecha: n.creado_en.slice(0, 10), texto: n.texto.slice(0, 20_000) }));
    const documentos = docs.filter((d) => d.estado === 'listo' && despues(d.creado_en, desde)).map((d) => ({
        fecha: d.creado_en.slice(0, 10), archivo: d.nombre, tipo: d.tipo_documento, resumen: (d.resumen ?? '').slice(0, 1500),
    }));

    const hayNovedades = correos.length + whatsapp.length + acciones.length + presupuestos.length + notasNuevas.length + documentos.length > 0;
    if (previo && !hayNovedades) {
        return {
            ok: true, resumen_md: previo.resumen_md, tokens_in: 0, tokens_out: 0, costo_usd: 0, duracion_ms: Date.now() - inicio,
            id: previo.id, creado_en: previo.creado_en, origen: previo.origen, sin_novedades: true,
        };
    }

    const ficha = {
        nombre: cliente.nombre,
        email: cliente.email,
        estado: cliente.estado,
        origen: cliente.origen,
        creado_en: cliente.creado_en,
        intentos_contacto: cliente.intentos_contacto ?? 0,
        ultimo_contacto_en: cliente.ultimo_contacto_en,
        metadata: cliente.metadata,
    };
    const snapshot = { cliente: ficha, correos, whatsapp, acciones, presupuestos, notas_del_operador: notasNuevas, documentos };

    const consigna = previo
        ? `INFORME ANTERIOR (${previo.creado_en.slice(0, 10)}):\n\n${previo.resumen_md}\n\n` +
          `NOVEDADES DESDE ESA FECHA:\n\n\`\`\`json\n${JSON.stringify(snapshot, null, 2)}\n\`\`\`\n\nReescribí el informe completo actualizado.`
        : `Snapshot completo del cliente:\n\n\`\`\`json\n${JSON.stringify(snapshot, null, 2)}\n\`\`\`\n\nRedactá el informe siguiendo la estructura del prompt.`;

    try {
        const resp = await anthropic.messages.create({
            model: idModelo('sonnet'),
            max_tokens: 1800,
            system: previo ? PROMPT_SYSTEM + PROMPT_ACTUALIZAR : PROMPT_SYSTEM,
            messages: [{ role: 'user', content: consigna }],
        });
        const texto = resp.content.filter((c): c is { type: 'text'; text: string } => c.type === 'text').map((t) => t.text).join('\n').trim();
        if (!texto) return vacio('La IA no devolvió el informe');
        const tokensIn = resp.usage.input_tokens;
        const tokensOut = resp.usage.output_tokens;
        const costo = calcularCosto('sonnet', tokensIn, tokensOut);
        const origen = opts.origen ?? 'manual';
        const { data: guardado, error } = await supabase.from('cliente_informes').insert({
            cliente_id: clienteId, resumen_md: texto, origen, base_id: previo?.id ?? null,
            tokens_in: tokensIn, tokens_out: tokensOut, costo_usd: costo,
        }).select('id, creado_en').single();
        if (error) console.warn('[informe] no se pudo guardar:', error.message);
        return {
            ok: true,
            resumen_md: texto,
            tokens_in: tokensIn,
            tokens_out: tokensOut,
            costo_usd: costo,
            duracion_ms: Date.now() - inicio,
            id: guardado?.id as string | undefined,
            creado_en: (guardado?.creado_en as string | undefined) ?? new Date().toISOString(),
            origen,
            incremental: !!previo,
        };
    } catch (err) {
        return vacio((err as Error).message);
    }
}

// Lista todos los clientes con datos agregados de seguimiento (cantidad de
// correos, última fecha, estado, ICP). Un mini índice para la vista.
//
// Además incluye "contactos detectados": dominios/emails que aparecen en
// correos_historicos con cliente_id=null (no matchearon ni por email ni por
// dominio con ningún cliente). Se muestran como items con estado 'detectado'
// para que el operador pueda promoverlos a prospecto.
export async function listarEmpresasParaSeguimiento() {
    const { data: clientes } = await supabase
        .from('clientes')
        .select('id, nombre, email, estado, origen, creado_en, actualizado_en, intentos_contacto, ultimo_contacto_en, metadata')
        .order('actualizado_en', { ascending: false })
        .limit(300);

    // Sumar cantidad de correos históricos por cliente
    const ids = (clientes ?? []).map((c) => c.id);
    const { data: correos } = ids.length > 0
        ? await supabase
            .from('correos_historicos')
            .select('cliente_id, fecha, direccion')
            .in('cliente_id', ids)
        : { data: [] };

    const stats = new Map<string, { correos: number; ultimo_correo: string | null; entrantes: number; salientes: number }>();
    for (const c of correos ?? []) {
        const cid = c.cliente_id as string;
        const acc = stats.get(cid) ?? { correos: 0, ultimo_correo: null, entrantes: 0, salientes: 0 };
        acc.correos++;
        if (c.direccion === 'entrante') acc.entrantes++;
        else acc.salientes++;
        if (!acc.ultimo_correo || c.fecha > acc.ultimo_correo) acc.ultimo_correo = c.fecha as string;
        stats.set(cid, acc);
    }

    // También matchear por dominio para prospectos ya cargados: si tienen
    // dominio, sumar los correos huérfanos que compartan dominio a sus stats.
    const dominioACliente = new Map<string, string>();
    for (const c of clientes ?? []) {
        const email = (c.email as string | null)?.toLowerCase();
        const dom = email && email.includes('@') ? email.split('@')[1] : null;
        if (dom && !dominioACliente.has(dom)) dominioACliente.set(dom, c.id);
    }
    const { data: correosHuerfanos } = await supabase
        .from('correos_historicos')
        .select('de_email, para_email, direccion, dominio, fecha, asunto')
        .is('cliente_id', null);

    const sueltosPorDominio = new Map<string, { correos: number; ultimo: string | null; entrantes: number; salientes: number; ejemplos: Set<string> }>();
    for (const c of correosHuerfanos ?? []) {
        const dom = (c.dominio as string | null) || null;
        if (!dom) continue;
        // Si el dominio corresponde a un cliente existente, sumamos a sus stats
        const cid = dominioACliente.get(dom);
        if (cid) {
            const acc = stats.get(cid) ?? { correos: 0, ultimo_correo: null, entrantes: 0, salientes: 0 };
            acc.correos++;
            if (c.direccion === 'entrante') acc.entrantes++;
            else acc.salientes++;
            const fecha = c.fecha as string;
            if (!acc.ultimo_correo || fecha > acc.ultimo_correo) acc.ultimo_correo = fecha;
            stats.set(cid, acc);
            continue;
        }
        // Dominio sin cliente: agrupamos como "detectado"
        const acc = sueltosPorDominio.get(dom) ?? { correos: 0, ultimo: null, entrantes: 0, salientes: 0, ejemplos: new Set<string>() };
        acc.correos++;
        if (c.direccion === 'entrante') acc.entrantes++;
        else acc.salientes++;
        const fecha = c.fecha as string;
        if (!acc.ultimo || fecha > acc.ultimo) acc.ultimo = fecha;
        const emailContra = c.direccion === 'entrante' ? (c.de_email as string | null) : (c.para_email as string | null);
        if (emailContra && acc.ejemplos.size < 3) acc.ejemplos.add(emailContra);
        sueltosPorDominio.set(dom, acc);
    }

    const empresasClientes = (clientes ?? []).map((c) => ({
        ...c,
        tipo: 'cliente' as const,
        correos_totales: stats.get(c.id)?.correos ?? 0,
        correos_entrantes: stats.get(c.id)?.entrantes ?? 0,
        correos_salientes: stats.get(c.id)?.salientes ?? 0,
        ultimo_correo_en: stats.get(c.id)?.ultimo_correo ?? null,
    }));

    // Contactos detectados: dominios sin cliente. El id es sintético "det:<dominio>".
    const detectados = Array.from(sueltosPorDominio.entries())
        .filter(([, v]) => v.correos > 0)
        .sort((a, b) => b[1].correos - a[1].correos)
        .slice(0, 200)
        .map(([dom, v]) => ({
            id: `det:${dom}`,
            nombre: dom,
            email: Array.from(v.ejemplos)[0] ?? null,
            estado: 'detectado' as const,
            origen: 'correo',
            creado_en: v.ultimo ?? new Date().toISOString(),
            actualizado_en: v.ultimo ?? new Date().toISOString(),
            intentos_contacto: null,
            ultimo_contacto_en: null,
            metadata: { emails_detectados: Array.from(v.ejemplos) },
            tipo: 'detectado' as const,
            correos_totales: v.correos,
            correos_entrantes: v.entrantes,
            correos_salientes: v.salientes,
            ultimo_correo_en: v.ultimo,
            dominio: dom,
        }));

    return [...empresasClientes, ...detectados];
}

// Detalle para un contacto detectado (id = 'det:dominio').
export async function detalleContactoDetectado(dominio: string) {
    const { data: correos } = await supabase
        .from('correos_historicos')
        .select('direccion, de_email, para_email, asunto, cuerpo, fecha, categoria')
        .eq('dominio', dominio)
        .is('cliente_id', null)
        .order('fecha', { ascending: false })
        .limit(50);

    const list = correos ?? [];
    const emails = new Set<string>();
    for (const c of list) {
        const contra = c.direccion === 'entrante' ? c.de_email : c.para_email;
        if (contra) emails.add((contra as string).toLowerCase());
    }

    return {
        cliente: {
            id: `det:${dominio}`,
            nombre: dominio,
            email: null,
            estado: 'detectado' as const,
            origen: 'correo',
            creado_en: list[0]?.fecha ?? new Date().toISOString(),
            actualizado_en: list[0]?.fecha ?? new Date().toISOString(),
            intentos_contacto: 0,
            ultimo_contacto_en: null,
            metadata: { emails_detectados: Array.from(emails), dominio },
        },
        correos: list,
        acciones: [],
        es_detectado: true,
        dominio,
    };
}

// Descarta un contacto detectado: borra todos los correos_historicos con ese
// dominio que no estén vinculados a ningún cliente. Los que sí tienen cliente_id
// no se tocan (siguen en el timeline de ese cliente).
export async function descartarContactoDetectado(dominio: string) {
    const { count, error } = await supabase
        .from('correos_historicos')
        .delete({ count: 'exact' })
        .eq('dominio', dominio)
        .is('cliente_id', null);
    if (error) return { ok: false, detalle: error.message };
    return { ok: true, borrados: count ?? 0 };
}

// Promueve un contacto detectado a cliente real. Toma el dominio, crea la fila
// en clientes, y re-vincula todos los correos_historicos huérfanos de ese dominio.
export async function promoverContactoDetectado(params: { dominio: string; nombre: string; email: string | null }) {
    const { data: nuevo, error } = await supabase
        .from('clientes')
        .insert({
            nombre: params.nombre,
            email: params.email?.trim().toLowerCase() || null,
            origen: 'correo_historico',
            estado: 'lead',
            metadata: { dominio: params.dominio },
        })
        .select('id, nombre, email, estado')
        .single();
    if (error || !nuevo) return { ok: false, detalle: error?.message ?? 'no se pudo crear' };

    // Re-vincular todos los correos huérfanos del dominio a este cliente nuevo.
    const { count } = await supabase
        .from('correos_historicos')
        .update({ cliente_id: nuevo.id }, { count: 'exact' })
        .eq('dominio', params.dominio)
        .is('cliente_id', null);

    return { ok: true, cliente: nuevo, vinculados: count ?? 0 };
}

// Detalle completo de una empresa: cliente + timeline unificado (correos + acciones).
export async function detalleEmpresa(clienteId: string) {
    const { data: cliente } = await supabase.from('clientes').select('*').eq('id', clienteId).maybeSingle();
    if (!cliente) return null;

    const historia = await historicoConCliente(clienteId, 50);
    // Por respuesta.cliente_id o payload.clienteId: aprobar pisaba la respuesta y
    // las propuestas aprobadas desaparecían de la ficha.
    const { data: acciones } = await supabase
        .from('acciones_pendientes')
        .select('id, accion, payload, estado, respuesta, creado_en, resuelto_en')
        .or(`respuesta->>cliente_id.eq.${clienteId},payload->>clienteId.eq.${clienteId}`)
        .order('creado_en', { ascending: false })
        .limit(50);

    const whatsapp = await mensajesWhatsappDeCliente(clienteId, 100);

    return {
        cliente,
        correos: historia,
        whatsapp,
        acciones: acciones ?? [],
    };
}

// Actualización nocturna de la memoria: rehace el informe de los clientes que
// tuvieron movimiento (correo, WhatsApp, presupuesto, nota o documento) desde
// su último informe. Solo mira la última semana y tiene un tope por noche para
// que el costo quede acotado; los clientes quietos no gastan nada.
export async function actualizarMemoriasPendientes(limite = 25): Promise<{ candidatos: number; actualizados: number; costo_usd: number }> {
    const hace8 = new Date(Date.now() - 8 * 86_400_000).toISOString();
    const [correos, convs, cots, notas, docs] = await Promise.all([
        supabase.from('correos_historicos').select('cliente_id, fecha').not('cliente_id', 'is', null).eq('ignorable', false).gte('fecha', hace8).limit(3000),
        supabase.from('wa_conversaciones').select('cliente_id, actualizado_en').not('cliente_id', 'is', null).gte('actualizado_en', hace8),
        supabase.from('cotizaciones').select('cliente_id, creado_en, enviada_en, cerrada_en').not('cliente_id', 'is', null)
            .or(`creado_en.gte.${hace8},enviada_en.gte.${hace8},cerrada_en.gte.${hace8}`),
        supabase.from('cliente_notas').select('cliente_id, creado_en').gte('creado_en', hace8),
        supabase.from('cliente_documentos').select('cliente_id, creado_en').eq('estado', 'listo').gte('creado_en', hace8),
    ]);

    const ultimo = new Map<string, number>();
    const marcar = (id: unknown, ...fechas: unknown[]) => {
        if (typeof id !== 'string') return;
        for (const f of fechas) {
            if (!f) continue;
            const t = new Date(f as string).getTime();
            if (t > (ultimo.get(id) ?? 0)) ultimo.set(id, t);
        }
    };
    for (const c of correos.data ?? []) marcar(c.cliente_id, c.fecha);
    for (const c of convs.data ?? []) marcar(c.cliente_id, c.actualizado_en);
    for (const q of cots.data ?? []) marcar(q.cliente_id, q.creado_en, q.enviada_en, q.cerrada_en);
    for (const n of notas.data ?? []) marcar(n.cliente_id, n.creado_en);
    for (const d of docs.data ?? []) marcar(d.cliente_id, d.creado_en);
    if (!ultimo.size) return { candidatos: 0, actualizados: 0, costo_usd: 0 };

    const ids = [...ultimo.keys()];
    const { data: informes } = await supabase.from('cliente_informes').select('cliente_id, creado_en')
        .in('cliente_id', ids).order('creado_en', { ascending: false });
    const ultimoInformeDe = new Map<string, number>();
    for (const i of informes ?? []) if (!ultimoInformeDe.has(i.cliente_id as string)) ultimoInformeDe.set(i.cliente_id as string, new Date(i.creado_en as string).getTime());

    const candidatos = ids
        .filter((id) => !ultimoInformeDe.has(id) || ultimo.get(id)! > ultimoInformeDe.get(id)!)
        .sort((a, b) => ultimo.get(b)! - ultimo.get(a)!)
        .slice(0, limite);

    let actualizados = 0, costo = 0;
    for (const id of candidatos) {
        const r = await generarInformeCliente(id, { origen: 'automatico' });
        if (r.ok && !r.sin_novedades) { actualizados++; costo += r.costo_usd; }
        else if (!r.ok) console.warn('[memoria] informe nocturno', id, r.detalle);
    }
    return { candidatos: candidatos.length, actualizados, costo_usd: Math.round(costo * 1000) / 1000 };
}
