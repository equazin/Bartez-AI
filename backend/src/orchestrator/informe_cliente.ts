// Genera un informe específico para un cliente/prospecto usando Sonnet.
// Agrega toda la info que hay (datos del cliente, correos previos, acciones,
// último contacto) y devuelve diagnóstico + propuesta de próximos pasos.

import { anthropic, calcularCosto, idModelo } from '../connectors/anthropic.js';
import { supabase } from '../connectors/supabase.js';
import { historicoConCliente } from '../inbound/importar_historico.js';

export interface InformeCliente {
    ok: boolean;
    resumen_md: string;
    tokens_in: number;
    tokens_out: number;
    costo_usd: number;
    duracion_ms: number;
    detalle?: string;
}

const PROMPT_SYSTEM = `Sos el asistente de Seguimientos de Bartez Tecnología. Recibís un
snapshot completo de un cliente/prospecto y devolvés un informe corto y accionable
para el operador.

Estilo: seco, directo, voseo, sin adulación.

Estructura del informe (markdown):

## Estado
Una línea: qué es este cliente hoy (lead frío, lead con conversación,
cliente activo, cliente inactivo, etc). Basado en datos reales del snapshot.

## Historia relevante
2-4 puntos con lo que pasó (cotizaciones, pedidos, quejas). No listar
todos los correos — solo los eventos que importan. Fechas concretas.

## Estado actual
- Días desde el último contacto de cualquiera de los dos lados
- Compromisos pendientes de Bartez (si alguno del historial dijo
  "te envío X" y no aparece en correos posteriores)
- Silencios del cliente (si están sin responder desde hace más de X días)

## Próximo paso sugerido
Una acción concreta (no más de 2 opciones). Ejemplos:
- "Reenviar la cotización del 12/8 que quedó sin respuesta"
- "Descartar como lead inactivo — 45 días de silencio, no hubo interés"
- "Escribir para retomar el proyecto de red que se conversó en marzo"
- "Mover a cliente activo — cerró la última cotización"

Reglas:
- No inventes datos que no están en el snapshot.
- Si el snapshot está vacío (nunca hubo contacto), decilo y proponé
  primer contacto.
- Sin frases relleno.`;

export async function generarInformeCliente(clienteId: string): Promise<InformeCliente> {
    const inicio = Date.now();

    const { data: cliente } = await supabase.from('clientes').select('*').eq('id', clienteId).maybeSingle();
    if (!cliente) {
        return { ok: false, resumen_md: '', tokens_in: 0, tokens_out: 0, costo_usd: 0, duracion_ms: 0, detalle: 'Cliente no encontrado' };
    }

    // Traer hasta 20 correos, sin filtro de ignorables (queremos todo el contexto real)
    const historia = await historicoConCliente(clienteId, 20);

    // Traer acciones asociadas (aprobadas + pendientes + rechazadas de este cliente)
    const { data: acciones } = await supabase
        .from('acciones_pendientes')
        .select('accion, payload, estado, respuesta, creado_en')
        .contains('respuesta', { cliente_id: clienteId })
        .order('creado_en', { ascending: false })
        .limit(20);

    const snapshot = {
        cliente: {
            nombre: cliente.nombre,
            email: cliente.email,
            estado: cliente.estado,
            origen: cliente.origen,
            creado_en: cliente.creado_en,
            actualizado_en: cliente.actualizado_en,
            intentos_contacto: cliente.intentos_contacto ?? 0,
            ultimo_contacto_en: cliente.ultimo_contacto_en,
            metadata: cliente.metadata,
        },
        correos: historia.map((h) => ({
            direccion: h.direccion,
            fecha: new Date(h.fecha).toISOString().slice(0, 10),
            de: h.de_email,
            para: h.para_email,
            asunto: h.asunto,
            categoria: h.categoria,
            cuerpo_recorte: (h.cuerpo ?? '').replace(/\s+/g, ' ').slice(0, 400),
        })),
        acciones: (acciones ?? []).map((a) => ({
            fecha: new Date(a.creado_en).toISOString().slice(0, 10),
            accion: a.accion,
            estado: a.estado,
            resumen: typeof (a.payload as { asunto?: string })?.asunto === 'string' ? (a.payload as { asunto: string }).asunto : a.accion,
        })),
    };

    const consigna =
        `Snapshot completo del cliente:\n\n\`\`\`json\n${JSON.stringify(snapshot, null, 2)}\n\`\`\`\n\n` +
        `Redactá el informe siguiendo la estructura del prompt.`;

    try {
        const resp = await anthropic.messages.create({
            model: idModelo('sonnet'),
            max_tokens: 1500,
            system: PROMPT_SYSTEM,
            messages: [{ role: 'user', content: consigna }],
        });
        const texto = resp.content.filter((c): c is { type: 'text'; text: string } => c.type === 'text').map((t) => t.text).join('\n').trim();
        const tokensIn = resp.usage.input_tokens;
        const tokensOut = resp.usage.output_tokens;
        return {
            ok: true,
            resumen_md: texto,
            tokens_in: tokensIn,
            tokens_out: tokensOut,
            costo_usd: calcularCosto('sonnet', tokensIn, tokensOut),
            duracion_ms: Date.now() - inicio,
        };
    } catch (err) {
        return { ok: false, resumen_md: '', tokens_in: 0, tokens_out: 0, costo_usd: 0, duracion_ms: Date.now() - inicio, detalle: (err as Error).message };
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

// Promueve un contacto detectado a cliente real. Toma el dominio, crea la fila
// en clientes, y re-vincula todos los correos_historicos huérfanos de ese dominio.
export async function promoverContactoDetectado(params: { dominio: string; nombre: string; email: string | null }) {
    const { data: nuevo, error } = await supabase
        .from('clientes')
        .insert({
            nombre: params.nombre,
            email: params.email,
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
        .update({ cliente_id: nuevo.id })
        .eq('dominio', params.dominio)
        .is('cliente_id', null)
        .select('*', { count: 'exact', head: true });

    return { ok: true, cliente: nuevo, vinculados: count ?? 0 };
}

// Detalle completo de una empresa: cliente + timeline unificado (correos + acciones).
export async function detalleEmpresa(clienteId: string) {
    const { data: cliente } = await supabase.from('clientes').select('*').eq('id', clienteId).maybeSingle();
    if (!cliente) return null;

    const historia = await historicoConCliente(clienteId, 50);
    const { data: acciones } = await supabase
        .from('acciones_pendientes')
        .select('id, accion, payload, estado, respuesta, creado_en')
        .contains('respuesta', { cliente_id: clienteId })
        .order('creado_en', { ascending: false })
        .limit(50);

    return {
        cliente,
        correos: historia,
        acciones: acciones ?? [],
    };
}
