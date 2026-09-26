// Banco de prueba de los asistentes de correo. Toma casos reales (lo que
// aprobaste tal cual, lo que editaste y lo que rechazaste), los repite con dos
// modelos —el de antes y el nuevo— y un juez (Opus) compara cada borrador con lo
// que hiciste vos. Sirve para cambiar de modelo o de prompt sabiendo si mejora.
//
// No manda nada ni crea acciones: solo lee y guarda el resultado en `evaluaciones`.

import { supabase } from '../connectors/supabase.js';
import { anthropic, calcularCosto, textoDe } from '../connectors/anthropic.js';
import { registrarAsistentes } from '../assistants/registro.js';
import { clasificarCorreo } from '../inbound/clasificador.js';
import { esCorreoPropio, esProveedor } from '../inbound/filtros_correo.js';
import { armarTareaSeguimiento } from './seguimientos.js';
import type { AsistenteConfig, ModeloClaude, TareaEntrante } from './types.js';

type Area = 'correo' | 'seguimientos';
type Estado = 'aprobada' | 'editada' | 'rechazada';

export interface CasoEval {
    id: string;
    area: Area;
    estado: Estado;
    fecha: string;
    para: string;
    asunto: string;
    clienteId: string | null;
    entrante: string | null;      // correo que llegó (Correo)
    propuesto: string | null;     // lo que propuso la IA en su momento
    final: string | null;         // lo que salió (aprobado o editado)
    motivo: string | null;        // por qué lo rechazaste, si lo dijiste
}

interface Borrador { modelo: string; filtrado: string | null; asunto: string | null; cuerpo: string | null; costoUsd: number; ms: number; error?: string }
interface Nota { aprobable: boolean; puntaje: number; problema: string }
export interface ResultadoCaso {
    caso: Pick<CasoEval, 'id' | 'area' | 'estado' | 'para' | 'asunto' | 'motivo'>;
    a: Borrador; b: Borrador;
    juez: { a: Nota; b: Nota; mejor: 'a' | 'b' | 'empate'; razon: string } | null;
}

// Lo que el modelo "de antes" usaba en cada área, y el nuevo.
export const MODELOS_ANTES: Record<Area, string> = { correo: 'claude-sonnet-4-5-20250929', seguimientos: 'claude-haiku-4-5-20251001' };
export const MODELO_NUEVO = 'claude-sonnet-5';
const MODELO_JUEZ = 'claude-opus-5';
const MAX_CASOS = 60;
export const COSTO_ESTIMADO_POR_CASO = 0.05;

export async function armarBanco(limite = MAX_CASOS): Promise<CasoEval[]> {
    const { data: asist } = await supabase.from('asistentes').select('id, area').in('area', ['correo', 'seguimientos']);
    const areaDe = new Map((asist ?? []).map((a) => [a.id as string, a.area as Area]));
    if (!areaDe.size) return [];
    const { data: filas } = await supabase
        .from('acciones_pendientes')
        .select('id, asistente_id, estado, payload, respuesta, creado_en')
        .eq('accion', 'enviar_correo')
        .in('estado', ['aprobada', 'editada', 'rechazada'])
        .in('asistente_id', [...areaDe.keys()])
        .order('creado_en', { ascending: false })
        .limit(200);
    const ids = (filas ?? []).map((f) => f.id as string);
    const { data: aps } = ids.length
        ? await supabase.from('aprendizajes').select('accion_id, propuesto, corregido, motivo').in('accion_id', ids)
        : { data: [] };
    const apDe = new Map((aps ?? []).map((a) => [a.accion_id as string, a]));

    const casos: CasoEval[] = [];
    for (const f of filas ?? []) {
        const p = (f.payload ?? {}) as Record<string, unknown>;
        const r = (f.respuesta ?? {}) as Record<string, unknown>;
        const ap = apDe.get(f.id as string);
        const area = areaDe.get(f.asistente_id as string)!;
        const estado = f.estado as Estado;
        const cuerpo = typeof p.cuerpo === 'string' ? p.cuerpo : null;
        const caso: CasoEval = {
            id: f.id as string,
            area,
            estado,
            fecha: f.creado_en as string,
            para: String(p.para ?? ''),
            asunto: String(p.asunto ?? ''),
            clienteId: (p.clienteId as string) ?? (r.cliente_id as string) ?? null,
            entrante: typeof p.textoEntrante === 'string' ? p.textoEntrante : null,
            propuesto: estado === 'editada' ? ((ap?.propuesto as string) ?? null) : cuerpo,
            final: estado === 'rechazada' ? null : cuerpo,
            motivo: (ap?.motivo as string) ?? (typeof r.nota === 'string' ? r.nota : null),
        };
        // Sin el correo que llegó no se puede repetir un caso de Correo.
        if (area === 'correo' && !caso.entrante) continue;
        if (area === 'seguimientos' && !caso.clienteId) continue;
        if (!caso.para) continue;
        casos.push(caso);
    }
    // Todos los editados y rechazados (son los que enseñan) y los aprobados que entren.
    const primero = casos.filter((c) => c.estado !== 'aprobada');
    const aprobados = casos.filter((c) => c.estado === 'aprobada');
    return [...primero, ...aprobados].slice(0, limite);
}

const sinRe = (a: string) => a.replace(/^\s*((re|rv|fwd?)\s*:\s*)+/i, '');

// Clasificación y reglas fijas: se hacen una vez por caso (no dependen del modelo).
async function filtroCorreo(c: CasoEval): Promise<{ filtrado: string | null; tarea?: TareaEntrante; costoUsd: number }> {
    const asunto = sinRe(c.asunto);
    if (esCorreoPropio(c.para, asunto)) return { filtrado: 'correo propio: no se responde', costoUsd: 0 };
    if ((await esProveedor(c.para)).proveedor) return { filtrado: 'proveedor: no se le responde solo', costoUsd: 0 };
    const clas = await clasificarCorreo({ asunto, cuerpo: c.entrante ?? '', de: c.para });
    if (clas.ignorable || clas.categoria === 'sin_respuesta' || clas.categoria === 'proveedor') {
        return { filtrado: `clasificado "${clas.categoria}": sin borrador`, costoUsd: 0 };
    }
    return {
        filtrado: null,
        costoUsd: 0,
        tarea: {
            canal: 'correo',
            clienteId: c.clienteId ?? undefined,
            texto: `Asunto: ${asunto}\n\n${(c.entrante ?? '').slice(0, 4000)}`,
            metadata: {
                asuntoOriginal: `Re: ${asunto}`,
                emailDestino: c.para,
                clasificacion: { categoria: clas.categoria, prioridad: clas.prioridad, razon: clas.razon },
            },
        },
    };
}

async function borrador(config: AsistenteConfig, modelo: string, tarea: TareaEntrante): Promise<Borrador> {
    const inicio = Date.now();
    try {
        const factory = registrarAsistentes().get(config.area)!;
        const asistente = factory({ ...config, modelo: modelo as ModeloClaude });
        const r = await asistente.procesar(tarea);
        const p = (r.accionPropuesta?.payload ?? {}) as { asunto?: string; cuerpo?: string };
        return {
            modelo,
            filtrado: r.accionPropuesta ? null : 'el asistente decidió no responder',
            asunto: p.asunto ?? null,
            cuerpo: p.cuerpo ?? null,
            costoUsd: r.costoUsd,
            ms: Date.now() - inicio,
        };
    } catch (err) {
        return { modelo, filtrado: null, asunto: null, cuerpo: null, costoUsd: 0, ms: Date.now() - inicio, error: (err as Error).message.slice(0, 300) };
    }
}

const ESQUEMA_JUEZ = {
    type: 'object',
    additionalProperties: false,
    required: ['a', 'b', 'mejor', 'razon'],
    properties: {
        a: { $ref: '#/$defs/nota' },
        b: { $ref: '#/$defs/nota' },
        mejor: { type: 'string', enum: ['a', 'b', 'empate'] },
        razon: { type: 'string' },
    },
    $defs: {
        nota: {
            type: 'object',
            additionalProperties: false,
            required: ['aprobable', 'puntaje', 'problema'],
            properties: {
                aprobable: { type: 'boolean', description: '¿Andrés lo mandaría tal cual?' },
                puntaje: { type: 'integer', description: '1 (malo) a 5 (excelente)' },
                problema: { type: 'string', description: 'El principal problema en una línea, o "" si no tiene' },
            },
        },
    },
};

const PAUTAS_JUEZ = `Sos el revisor de los borradores que la IA de Bartez Tecnología (mayorista de IT en Rosario, vende a empresas de todo el país) le propone a Andrés, el dueño. Andrés aprueba, edita o rechaza cada borrador antes de que salga.
Lo que Andrés aprueba: correos cortos y concretos, en castellano rioplatense profesional, que responden exactamente lo que se preguntó; en un primer contacto, una línea de qué hace Bartez, como mucho un gancho concreto y un cierre suave ("si en algún momento necesitás…, nos escribís"), firmado "Bartez Tecnología".
Lo que rechaza: responder cuando no había que responder (correos propios, proveedores, acuses, avisos automáticos), confirmar compras o proformas sin su ok, inventar datos (precios, stock, plazos, ciudad, clientes), preguntas abiertas de relleno, mencionar datos investigados del prospecto, correos largos o genéricos.
Si lo correcto era NO responder, un candidato que no redactó nada es la respuesta correcta (aprobable=true, puntaje 5) y uno que redactó algo es un error.
Compará los dos candidatos con lo que hizo Andrés en el caso real. Sé exigente: "aprobable" es solo si Andrés lo mandaría sin tocar.`;

function describir(b: Borrador): string {
    if (b.error) return `(falló: ${b.error})`;
    if (!b.cuerpo) return `(no redactó nada — ${b.filtrado ?? 'sin borrador'})`;
    return `Asunto: ${b.asunto ?? ''}\n\n${b.cuerpo}`;
}

async function juzgar(c: CasoEval, a: Borrador, b: Borrador): Promise<{ veredicto: ResultadoCaso['juez']; costoUsd: number }> {
    // Orden al azar para que el juez no favorezca al primero.
    const invertir = Math.random() < 0.5;
    const [x, y] = invertir ? [b, a] : [a, b];
    const real = c.estado === 'aprobada'
        ? `Andrés lo APROBÓ tal cual:\n${c.final ?? ''}`
        : c.estado === 'editada'
            ? `Andrés lo EDITÓ.${c.propuesto ? `\nLo que había propuesto la IA:\n${c.propuesto}\n` : ''}\nLo que finalmente mandó:\n${c.final ?? ''}`
            : `Andrés lo RECHAZÓ${c.motivo ? ` (motivo: ${c.motivo})` : ' (sin decir por qué)'}.\nLo que había propuesto la IA:\n${c.propuesto ?? ''}`;
    const situacion = c.area === 'correo'
        ? `Correo que llegó de ${c.para} (asunto "${sinRe(c.asunto)}"):\n${(c.entrante ?? '').slice(0, 3000)}`
        : `Seguimiento/primer contacto por correo a ${c.para} (asunto propuesto "${c.asunto}").`;
    const consigna = `CASO (${c.area})\n${situacion}\n\nQUÉ HIZO ANDRÉS\n${real.slice(0, 3000)}\n\nCANDIDATO A\n${describir(x)}\n\nCANDIDATO B\n${describir(y)}\n\nEvaluá A y B.`;
    try {
        const r = await anthropic.messages.create({
            model: MODELO_JUEZ,
            max_tokens: 4000,
            system: PAUTAS_JUEZ,
            messages: [{ role: 'user', content: consigna }],
            output_config: { effort: 'medium', format: { type: 'json_schema', schema: ESQUEMA_JUEZ } },
        });
        const costoUsd = calcularCosto(MODELO_JUEZ, r.usage.input_tokens, r.usage.output_tokens);
        const j = JSON.parse(textoDe(r)) as { a: Nota; b: Nota; mejor: 'a' | 'b' | 'empate'; razon: string };
        const mejor = j.mejor === 'empate' ? 'empate' : invertir ? (j.mejor === 'a' ? 'b' : 'a') : j.mejor;
        return { veredicto: { a: invertir ? j.b : j.a, b: invertir ? j.a : j.b, mejor, razon: j.razon }, costoUsd };
    } catch {
        return { veredicto: null, costoUsd: 0 };
    }
}

export interface ResumenModelo { modelo: string; casos: number; aprobables: number; puntaje: number; costoUsd: number; msPromedio: number; errores: number }
export interface ResumenEval {
    porArea: Record<string, { a: ResumenModelo; b: ResumenModelo; ganaA: number; ganaB: number; empates: number }>;
    total: { a: ResumenModelo; b: ResumenModelo; ganaA: number; ganaB: number; empates: number };
}

function resumir(rs: ResultadoCaso[]): ResumenEval['total'] {
    const lado = (k: 'a' | 'b'): ResumenModelo => {
        const juzgados = rs.filter((r) => r.juez);
        return {
            modelo: rs[0]?.[k].modelo ?? '',
            casos: juzgados.length,
            aprobables: juzgados.filter((r) => r.juez![k].aprobable).length,
            puntaje: juzgados.length ? Math.round((juzgados.reduce((s, r) => s + r.juez![k].puntaje, 0) / juzgados.length) * 100) / 100 : 0,
            costoUsd: Math.round(rs.reduce((s, r) => s + r[k].costoUsd, 0) * 10000) / 10000,
            msPromedio: rs.length ? Math.round(rs.reduce((s, r) => s + r[k].ms, 0) / rs.length) : 0,
            errores: rs.filter((r) => r[k].error).length,
        };
    };
    return {
        a: lado('a'), b: lado('b'),
        ganaA: rs.filter((r) => r.juez?.mejor === 'a').length,
        ganaB: rs.filter((r) => r.juez?.mejor === 'b').length,
        empates: rs.filter((r) => r.juez?.mejor === 'empate').length,
    };
}

let corriendo = false;
export const evaluacionEnCurso = () => corriendo;

// Arranca una corrida y devuelve su id; el trabajo sigue en segundo plano.
export async function iniciarEvaluacion(opts: { limite?: number; modeloNuevo?: string } = {}): Promise<{ id: string; casos: number }> {
    if (corriendo) throw new Error('Ya hay una evaluación corriendo');
    const casos = await armarBanco(Math.min(opts.limite ?? MAX_CASOS, MAX_CASOS));
    if (!casos.length) throw new Error('No hay casos para evaluar todavía');
    const modeloNuevo = opts.modeloNuevo ?? MODELO_NUEVO;
    const { data, error } = await supabase.from('evaluaciones').insert({
        estado: 'corriendo',
        modelos: { antes: MODELOS_ANTES, nuevo: modeloNuevo, juez: MODELO_JUEZ },
        casos: casos.length,
    }).select('id').single();
    if (error || !data) throw new Error(error?.message ?? 'No se pudo crear la evaluación');
    const id = data.id as string;
    corriendo = true;
    correr(id, casos, modeloNuevo)
        .catch(async (err) => {
            await supabase.from('evaluaciones').update({ estado: 'error', error: (err as Error).message, terminado_en: new Date().toISOString() }).eq('id', id);
        })
        .finally(() => { corriendo = false; });
    return { id, casos: casos.length };
}

async function correr(id: string, casos: CasoEval[], modeloNuevo: string): Promise<void> {
    const { data: filas } = await supabase.from('asistentes').select('*').in('area', ['correo', 'seguimientos']);
    const configDe = new Map((filas ?? []).map((f) => [f.area as Area, f as AsistenteConfig]));
    const resultados: ResultadoCaso[] = [];
    let costo = 0;

    const uno = async (c: CasoEval): Promise<void> => {
        const config = configDe.get(c.area);
        if (!config) return;
        let tarea: TareaEntrante | undefined;
        let filtrado: string | null = null;
        if (c.area === 'correo') {
            const f = await filtroCorreo(c);
            filtrado = f.filtrado; tarea = f.tarea;
        } else {
            const t = await armarTareaSeguimiento(c.clienteId!, { hasta: c.fecha });
            if (t.ok) tarea = t.tarea; else filtrado = t.detalle;
        }
        const vacio = (modelo: string): Borrador => ({ modelo, filtrado, asunto: null, cuerpo: null, costoUsd: 0, ms: 0 });
        const [a, b] = tarea
            ? await Promise.all([borrador(config, MODELOS_ANTES[c.area], tarea), borrador(config, modeloNuevo, tarea)])
            : [vacio(MODELOS_ANTES[c.area]), vacio(modeloNuevo)];
        // Si los dos quedaron afuera por las reglas o el clasificador (no depende
        // del modelo), no hace falta juez: acertó si lo rechazaste.
        const j = !tarea
            ? (() => {
                const bien = c.estado === 'rechazada';
                const nota: Nota = { aprobable: bien, puntaje: bien ? 5 : 1, problema: bien ? '' : `No redactó: ${filtrado ?? ''}` };
                return { veredicto: { a: nota, b: nota, mejor: 'empate' as const, razon: bien ? 'No había que responder y ninguno respondió.' : 'Se filtró un correo que había que responder.' }, costoUsd: 0 };
            })()
            : await juzgar(c, a, b);
        costo += a.costoUsd + b.costoUsd + j.costoUsd;
        resultados.push({ caso: { id: c.id, area: c.area, estado: c.estado, para: c.para, asunto: c.asunto, motivo: c.motivo }, a, b, juez: j.veredicto });
    };

    // De a 3 casos a la vez, guardando el avance.
    for (let i = 0; i < casos.length; i += 3) {
        await Promise.all(casos.slice(i, i + 3).map(uno));
        await supabase.from('evaluaciones').update({ hechos: resultados.length, costo_usd: Math.round(costo * 10000) / 10000 }).eq('id', id);
    }

    const porArea: ResumenEval['porArea'] = {};
    for (const area of ['correo', 'seguimientos'] as Area[]) {
        const rs = resultados.filter((r) => r.caso.area === area);
        if (rs.length) porArea[area] = resumir(rs);
    }
    const resumen: ResumenEval = { porArea, total: resumir(resultados) };
    await supabase.from('evaluaciones').update({
        estado: 'lista',
        hechos: resultados.length,
        resumen,
        detalle: resultados,
        costo_usd: Math.round(costo * 10000) / 10000,
        terminado_en: new Date().toISOString(),
    }).eq('id', id);
}

