// Aprender de las correcciones del operador.
//
// Cada vez que se rechaza una propuesta (con o sin motivo) o se la edita antes
// de enviarla, queda una fila en `aprendizajes` con lo que propuso el asistente
// y lo que se corrigió. Cada tanto (al juntar 3 correcciones nuevas y todas
// las noches) esas correcciones se destilan en una lista corta de lecciones
// por asistente, que se suma al final de su prompt. Las lecciones se pueden
// ver, editar o borrar desde la pestaña Asistentes.

import { anthropic, calcularCosto, idModelo } from '../connectors/anthropic.js';
import { supabase } from '../connectors/supabase.js';

type Tipo = 'rechazo' | 'edicion';

interface FilaAccion {
    id: string;
    asistente_id: string | null;
    accion: string;
    payload: Record<string, unknown> | null;
}

const texto = (v: unknown) => (typeof v === 'string' ? v : '').trim();

// Lo que el asistente escribió, en una forma legible y comparable.
function textoPropuesta(accion: string, p: Record<string, unknown>): string {
    if (accion === 'enviar_correo') return `Asunto: ${texto(p.asunto)}\n\n${texto(p.cuerpo)}`;
    return texto(p.cuerpo) || JSON.stringify(p).slice(0, 1500);
}

// A qué estaba respondiendo: el correo o el último mensaje del cliente.
function situacion(accion: string, p: Record<string, unknown>): string {
    if (accion === 'enviar_whatsapp' && Array.isArray(p.conversacion)) {
        const msgs = p.conversacion as Array<{ origen: string; cuerpo: string | null }>;
        return msgs.slice(-6).map((m) => `${m.origen === 'cliente' ? 'Cliente' : m.origen === 'bot' ? 'Bot' : 'Bartez'}: ${m.cuerpo ?? '(sin texto)'}`).join('\n');
    }
    const entrante = texto(p.textoEntrante);
    if (entrante) return entrante.slice(0, 1500);
    return [texto(p.categoria) && `Categoría: ${texto(p.categoria)}`, texto(p.asunto) && `Asunto: ${texto(p.asunto)}`].filter(Boolean).join('\n');
}

export async function registrarCorreccion(
    fila: FilaAccion,
    tipo: Tipo,
    opts: { payloadNuevo?: Record<string, unknown>; motivo?: string | null } = {},
): Promise<void> {
    try {
        if (!fila.asistente_id) return;
        const p = fila.payload ?? {};
        const propuesto = textoPropuesta(fila.accion, p);
        const corregido = opts.payloadNuevo ? textoPropuesta(fila.accion, opts.payloadNuevo) : null;
        // Una "edición" sin cambios reales no enseña nada.
        if (tipo === 'edicion' && corregido === propuesto) return;
        await supabase.from('aprendizajes').insert({
            asistente_id: fila.asistente_id,
            accion_id: fila.id,
            tipo,
            canal: fila.accion === 'enviar_whatsapp' ? 'whatsapp' : fila.accion === 'enviar_correo' ? 'correo' : fila.accion,
            situacion: situacion(fila.accion, p).slice(0, 2000),
            propuesto: propuesto.slice(0, 3000),
            corregido: corregido?.slice(0, 3000) ?? null,
            motivo: opts.motivo?.trim() || null,
        });
        // Con 3 correcciones nuevas ya vale la pena actualizar las lecciones.
        const { count } = await supabase.from('aprendizajes')
            .select('id', { count: 'exact', head: true })
            .eq('asistente_id', fila.asistente_id).eq('destilado', false);
        if ((count ?? 0) >= 3) void destilarLecciones(fila.asistente_id).catch((err) => console.warn('[aprendizaje]', (err as Error).message));
    } catch (err) {
        // Aprender es secundario: nunca debe frenar la aprobación.
        console.warn('[aprendizaje] no se pudo registrar:', (err as Error).message);
    }
}

// ---------- Lecciones en el prompt ----------

const cache = new Map<string, { en: number; texto: string }>();

export async function bloqueLecciones(asistenteId: string | undefined | null): Promise<string> {
    if (!asistenteId) return '';
    const c = cache.get(asistenteId);
    if (c && Date.now() - c.en < 5 * 60_000) return c.texto;
    const { data } = await supabase.from('asistentes').select('lecciones').eq('id', asistenteId).maybeSingle();
    const lecciones = texto(data?.lecciones);
    const bloque = lecciones
        ? `---\nLECCIONES DE LAS CORRECCIONES DE ANDRÉS (tienen prioridad sobre tus reglas generales si chocan):\n${lecciones}`
        : '';
    cache.set(asistenteId, { en: Date.now(), texto: bloque });
    return bloque;
}

// Suma las lecciones al final de un system prompt ya armado.
export async function conLecciones(system: string, asistenteId: string | undefined | null): Promise<string> {
    const b = await bloqueLecciones(asistenteId);
    return b ? `${system}\n\n${b}` : system;
}

export function olvidarCacheLecciones(asistenteId?: string): void {
    if (asistenteId) cache.delete(asistenteId);
    else cache.clear();
}

// ---------- Destilar ----------

const PROMPT_DESTILAR = `Sos el encargado de mejorar a un asistente de IA de Bartez Tecnología (mayorista de informática en Rosario).
Andrés, el dueño, revisa cada respuesta que el asistente propone antes de enviarla. A veces la rechaza (a veces dice por qué) y a veces la edita.
Tu trabajo: a partir de esas correcciones, escribir LECCIONES concretas para que el asistente no repita los errores.

Reglas:
- Máximo 10 lecciones, una por línea, empezando con "- ".
- Cada lección tiene que ser accionable y específica ("No ofrecer descuentos sin que Andrés lo indique", "Firmar como 'Andrés — Bartez Tecnología'"), nunca genérica ("ser más claro").
- Deducí el patrón comparando lo propuesto con lo corregido: tono, largo, datos que se agregan o sacan, fórmulas de saludo o firma, cuándo no hay que responder.
- Si una corrección es un caso aislado sin patrón, no inventes una regla general.
- Conservá las lecciones anteriores que siguen valiendo; reescribí o sacá las que las correcciones nuevas contradicen.
- Respondé SOLO con la lista, sin introducción.`;

const destilando = new Set<string>();

export async function destilarLecciones(asistenteId: string, forzar = false): Promise<{ ok: boolean; lecciones?: string; usadas?: number; detalle?: string }> {
    if (destilando.has(asistenteId)) return { ok: false, detalle: 'Ya se están actualizando las lecciones de este asistente' };
    destilando.add(asistenteId);
    const inicio = Date.now();
    try {
        const [{ data: asist }, { data: nuevas }] = await Promise.all([
            supabase.from('asistentes').select('id, nombre, area, lecciones').eq('id', asistenteId).maybeSingle(),
            supabase.from('aprendizajes').select('id, tipo, canal, situacion, propuesto, corregido, motivo, creado_en, destilado')
                .eq('asistente_id', asistenteId).order('creado_en', { ascending: false }).limit(40),
        ]);
        if (!asist) return { ok: false, detalle: 'Asistente no encontrado' };
        const filas = (nuevas ?? []) as Array<{ id: string; tipo: Tipo; canal: string | null; situacion: string | null; propuesto: string | null; corregido: string | null; motivo: string | null; creado_en: string; destilado: boolean }>;
        const pendientes = filas.filter((f) => !f.destilado);
        if (pendientes.length === 0 && !forzar) return { ok: true, lecciones: texto(asist.lecciones), usadas: 0 };
        if (filas.length === 0) return { ok: false, detalle: 'Todavía no hay correcciones para aprender' };

        const casos = filas.slice(0, 25).reverse().map((f, i) => {
            const partes = [`### Caso ${i + 1} — ${f.tipo === 'rechazo' ? 'RECHAZADA' : 'EDITADA'} (${f.canal ?? ''}, ${f.creado_en.slice(0, 10)})`];
            if (f.situacion) partes.push(`Situación:\n${f.situacion.slice(0, 800)}`);
            partes.push(`Lo que propuso el asistente:\n${(f.propuesto ?? '').slice(0, 1200)}`);
            if (f.corregido) partes.push(`Cómo lo dejó Andrés:\n${f.corregido.slice(0, 1200)}`);
            if (f.motivo) partes.push(`Motivo que dio Andrés: ${f.motivo}`);
            return partes.join('\n');
        }).join('\n\n');

        const pedido = `Asistente: ${asist.nombre} (área ${asist.area}).\n\nLECCIONES ACTUALES:\n${texto(asist.lecciones) || '(ninguna todavía)'}\n\nCORRECCIONES (de la más vieja a la más nueva):\n\n${casos}\n\nDevolvé la lista actualizada de lecciones.`;
        const modelo = 'sonnet' as const;
        const r = await anthropic.messages.create({
            model: idModelo(modelo),
            max_tokens: 900,
            system: PROMPT_DESTILAR,
            messages: [{ role: 'user', content: pedido }],
        });
        const salida = r.content.map((c) => (c.type === 'text' ? c.text : '')).join('').trim();
        const lecciones = salida.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('- ')).slice(0, 10).join('\n');
        if (!lecciones) return { ok: false, detalle: 'El modelo no devolvió lecciones' };

        await supabase.from('asistentes').update({ lecciones, lecciones_en: new Date().toISOString() }).eq('id', asistenteId);
        if (pendientes.length) await supabase.from('aprendizajes').update({ destilado: true }).in('id', pendientes.map((f) => f.id));
        olvidarCacheLecciones(asistenteId);

        const costo = calcularCosto(modelo, r.usage.input_tokens, r.usage.output_tokens);
        await supabase.from('logs_asistente').insert({
            asistente_id: asistenteId,
            herramienta: 'destilar_lecciones',
            entrada: { correcciones: filas.length, nuevas: pendientes.length },
            salida: { lecciones },
            tokens_in: r.usage.input_tokens, tokens_out: r.usage.output_tokens, costo_usd: costo, duracion_ms: Date.now() - inicio,
        });
        return { ok: true, lecciones, usadas: filas.length };
    } finally {
        destilando.delete(asistenteId);
    }
}

// Corrida nocturna: todos los asistentes con correcciones sin procesar.
export async function destilarPendientes(): Promise<number> {
    const { data } = await supabase.from('aprendizajes').select('asistente_id').eq('destilado', false);
    const ids = [...new Set((data ?? []).map((d) => d.asistente_id as string).filter(Boolean))];
    for (const id of ids) {
        try { await destilarLecciones(id); } catch (err) { console.warn('[aprendizaje] destilar', id, (err as Error).message); }
    }
    return ids.length;
}

export async function listarAprendizajes(asistenteId: string, limite = 20) {
    const { data, error } = await supabase.from('aprendizajes')
        .select('id, tipo, canal, situacion, propuesto, corregido, motivo, destilado, creado_en')
        .eq('asistente_id', asistenteId).order('creado_en', { ascending: false }).limit(limite);
    if (error) throw new Error(error.message);
    return data ?? [];
}
