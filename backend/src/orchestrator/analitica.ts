// Motor de Analítica: colecta datos de los últimos N días desde Supabase,
// invoca al asistente Sonnet con contexto estructurado y devuelve un informe
// con resumen + propuestas de ajuste. Guarda en reportes_analitica, manda
// por email y sincroniza a Notion Notas.

import { anthropic, calcularCosto, idModelo } from '../connectors/anthropic.js';
import { enviarCorreo, ferozoConfigurado } from '../connectors/ferozo.js';
import { chunkText, idsNotion, notion, notionConfigurado } from '../connectors/notion.js';
import { supabase } from '../connectors/supabase.js';

const DESTINATARIO_INFORME = process.env.FEROZO_EMAIL || 'ventas@bartez.com.ar';

export interface Propuesta {
    tipo: 'ajuste_prompt' | 'cambio_modelo' | 'ajuste_autonomia' | 'proceso' | 'otro';
    asistente?: string;
    titulo: string;
    razon: string;
    accion_sugerida: string;
}

export interface ReporteAnalitica {
    id?: string;
    periodo_desde: string;
    periodo_hasta: string;
    resumen_md: string;
    propuestas: Propuesta[];
    stats: Record<string, unknown>;
    tokens_in: number;
    tokens_out: number;
    costo_usd: number;
    duracion_ms: number;
    notion_page_id?: string;
    email_enviado: boolean;
}

const PROMPT_SYSTEM = `Sos el asistente de Analítica de Bartez Tecnología. Recibís un
snapshot de los últimos días del sistema (métricas de asistentes, prospectos,
correos, acciones, ventas) y tu trabajo es devolver un informe ejecutivo
para el operador.

Estilo: seco, directo, voseo rioplatense, sin adulación. Cuentas lo que
pasó, no felicitás.

Estructura del informe (markdown):

# Semana del {desde} al {hasta}

## Números clave
- (bullets con las 4-6 métricas más relevantes: nuevos leads,
  contactos enviados, ventas cerradas, costo IA, prompts que fallaron)

## Qué funcionó
- (2-3 puntos concretos que rindieron: qué canal trajo leads,
  qué prompts convirtieron, dónde el asistente acertó)

## Qué está fallando
- (2-4 puntos con problemas reales: asistente caro sin conversión,
  prospectos sin señal, acciones que se acumulan sin aprobación,
  errores repetidos en bitácora)

## Contexto de negocio
- (si hay métricas de negocio cargadas, comentalas: propuestas vs
  ventas, ratio de conversión, tendencia)

Después de la sección de contexto, devolvé un bloque <propuestas>[...]</propuestas>
con hasta 3 propuestas concretas como JSON. Cada propuesta:

{
  "tipo": "ajuste_prompt" | "cambio_modelo" | "ajuste_autonomia" | "proceso" | "otro",
  "asistente": "correo" | "prospeccion" | "seguimientos" | "notion" | null,
  "titulo": "una línea corta",
  "razon": "por qué (datos concretos del snapshot)",
  "accion_sugerida": "qué hacer (concreto, listo para aplicar)"
}

Reglas:
- Nunca inventes números. Todo lo que digas tiene que estar en el snapshot.
- Si no hay datos suficientes en algún tema, decilo en el informe
  (ej. "Sin métricas de negocio cargadas esta semana").
- Nunca propongas cambios drásticos sin evidencia (no digas
  "cambiá a Opus" salvo que veas un problema claro que Opus resuelva).
- Priorizá propuestas que sumen plata o ahorren tiempo, no cosméticas.
- Podés devolver menos de 3 propuestas si no hay materia.
- Sin frases relleno tipo "esperamos que este informe sea útil".`;

interface Stats {
    periodo_desde: string;
    periodo_hasta: string;
    logs_totales: number;
    logs_por_asistente: Array<{ asistente: string; count: number; tokens_in: number; tokens_out: number; costo_usd: number; errores: number }>;
    prospectos_creados: number;
    prospectos_por_estado: Record<string, number>;
    acciones_pendientes: number;
    acciones_aprobadas: number;
    acciones_rechazadas: number;
    correos_enviados: number;
    seguimientos_generados: number;
    metricas_negocio: Array<{ fecha: string; propuestas_enviadas: number; ventas_cerradas: number; prospectos_calificados: number }>;
    errores_recientes: Array<{ asistente: string; error: string; creado_en: string }>;
}

export async function correrAnalitica(dias = 7): Promise<ReporteAnalitica> {
    const inicio = Date.now();
    const hasta = new Date();
    const desde = new Date(hasta.getTime() - dias * 24 * 3600_000);
    const desdeISO = desde.toISOString();
    const hastaISO = hasta.toISOString();
    const desdeFecha = desdeISO.slice(0, 10);
    const hastaFecha = hastaISO.slice(0, 10);

    // ---------- Colecta ----------
    const [logsRes, asistRes, clientesRes, accionesRes, metricasRes] = await Promise.all([
        supabase.from('logs_asistente').select('asistente_id, tokens_in, tokens_out, costo_usd, error, creado_en').gte('creado_en', desdeISO),
        supabase.from('asistentes').select('id, nombre, area, modelo, activo'),
        supabase.from('clientes').select('estado, creado_en, actualizado_en, origen').gte('creado_en', desdeISO),
        supabase.from('acciones_pendientes').select('estado, accion, respuesta, creado_en').gte('creado_en', desdeISO),
        supabase.from('metricas_negocio').select('fecha, propuestas_enviadas, ventas_cerradas, prospectos_calificados').gte('fecha', desdeFecha),
    ]);

    const asistentesById = new Map<string, string>();
    for (const a of asistRes.data ?? []) asistentesById.set(a.id, a.nombre ?? a.area);

    const logsPorAsist = new Map<string, { count: number; ti: number; to: number; costo: number; errs: number }>();
    for (const l of logsRes.data ?? []) {
        const nombre = asistentesById.get(l.asistente_id) ?? l.asistente_id.slice(0, 8);
        const acc = logsPorAsist.get(nombre) ?? { count: 0, ti: 0, to: 0, costo: 0, errs: 0 };
        acc.count++;
        acc.ti += l.tokens_in ?? 0;
        acc.to += l.tokens_out ?? 0;
        acc.costo += Number(l.costo_usd ?? 0);
        if (l.error) acc.errs++;
        logsPorAsist.set(nombre, acc);
    }

    const prospectosPorEstado: Record<string, number> = {};
    for (const c of clientesRes.data ?? []) prospectosPorEstado[c.estado] = (prospectosPorEstado[c.estado] ?? 0) + 1;

    let accPend = 0, accAprob = 0, accRech = 0, correosEnv = 0, seguimientos = 0;
    for (const a of accionesRes.data ?? []) {
        if (a.estado === 'pendiente') accPend++;
        if (a.estado === 'ejecutada' || a.estado === 'aprobada') accAprob++;
        if (a.estado === 'rechazada') accRech++;
        if (a.accion === 'enviar_correo' && (a.estado === 'ejecutada' || a.estado === 'aprobada')) correosEnv++;
        const resp = (a.respuesta as { origen?: string } | null)?.origen;
        if (resp === 'barrido_seguimientos') seguimientos++;
    }

    const erroresRecientes = (logsRes.data ?? [])
        .filter((l) => l.error)
        .slice(0, 5)
        .map((l) => ({
            asistente: asistentesById.get(l.asistente_id) ?? l.asistente_id.slice(0, 8),
            error: String(l.error).slice(0, 200),
            creado_en: l.creado_en,
        }));

    const stats: Stats = {
        periodo_desde: desdeFecha,
        periodo_hasta: hastaFecha,
        logs_totales: logsRes.data?.length ?? 0,
        logs_por_asistente: Array.from(logsPorAsist.entries()).map(([asistente, v]) => ({
            asistente, count: v.count, tokens_in: v.ti, tokens_out: v.to, costo_usd: Number(v.costo.toFixed(4)), errores: v.errs,
        })).sort((a, b) => b.costo_usd - a.costo_usd),
        prospectos_creados: clientesRes.data?.length ?? 0,
        prospectos_por_estado: prospectosPorEstado,
        acciones_pendientes: accPend,
        acciones_aprobadas: accAprob,
        acciones_rechazadas: accRech,
        correos_enviados: correosEnv,
        seguimientos_generados: seguimientos,
        metricas_negocio: (metricasRes.data ?? []).map((m) => ({
            fecha: m.fecha,
            propuestas_enviadas: m.propuestas_enviadas ?? 0,
            ventas_cerradas: m.ventas_cerradas ?? 0,
            prospectos_calificados: m.prospectos_calificados ?? 0,
        })),
        errores_recientes: erroresRecientes,
    };

    // ---------- Invocación al modelo ----------
    const snapshotJson = JSON.stringify(stats, null, 2);
    const consigna =
        `Snapshot del sistema de los últimos ${dias} días:\n\n\`\`\`json\n${snapshotJson}\n\`\`\`\n\n` +
        `Redactá el informe completo siguiendo la estructura del prompt. Terminá con el bloque <propuestas>[...]</propuestas>.`;

    const resp = await anthropic.messages.create({
        model: idModelo('sonnet'),
        max_tokens: 4096,
        system: PROMPT_SYSTEM,
        messages: [{ role: 'user', content: consigna }],
    });
    const texto = resp.content.filter((c): c is { type: 'text'; text: string } => c.type === 'text').map((t) => t.text).join('\n');
    const tokensIn = resp.usage.input_tokens;
    const tokensOut = resp.usage.output_tokens;
    const costo = calcularCosto('sonnet', tokensIn, tokensOut);

    // Separar cuerpo (markdown) de propuestas (JSON)
    const propMatch = /<propuestas>([\s\S]*?)<\/propuestas>/i.exec(texto);
    const resumen_md = texto.replace(/<propuestas>[\s\S]*?<\/propuestas>/i, '').trim();
    let propuestas: Propuesta[] = [];
    if (propMatch) {
        try {
            const parsed = JSON.parse(propMatch[1].trim());
            if (Array.isArray(parsed)) {
                propuestas = parsed.filter((p): p is Propuesta => typeof p?.titulo === 'string' && typeof p?.razon === 'string');
            }
        } catch {
            // ignorar bloque malformado
        }
    }

    // ---------- Persistir ----------
    const { data: guardado, error: errGuardar } = await supabase
        .from('reportes_analitica')
        .insert({
            periodo_desde: desdeFecha,
            periodo_hasta: hastaFecha,
            resumen_md,
            propuestas,
            stats: stats as unknown as Record<string, unknown>,
            tokens_in: tokensIn,
            tokens_out: tokensOut,
            costo_usd: costo,
        })
        .select('id')
        .single();
    const reporteId = errGuardar ? undefined : guardado?.id as string | undefined;

    // ---------- Email ----------
    let emailEnviado = false;
    if (ferozoConfigurado) {
        try {
            const cuerpo =
                `${resumen_md}\n\n---\nPropuestas (${propuestas.length}):\n` +
                propuestas.map((p, i) => `\n${i + 1}. [${p.tipo}${p.asistente ? ' · ' + p.asistente : ''}] ${p.titulo}\n   ${p.razon}\n   → ${p.accion_sugerida}`).join('\n') +
                `\n\n---\nSemana ${desdeFecha} → ${hastaFecha} · Costo del informe: USD ${costo.toFixed(4)}\nAbrí el panel para ver el histórico completo.`;
            await enviarCorreo({
                para: DESTINATARIO_INFORME,
                asunto: `Bartez AI — Informe semanal ${desdeFecha} → ${hastaFecha}`,
                cuerpo,
            });
            emailEnviado = true;
        } catch (err) {
            console.warn('[analitica] envío email falló:', (err as Error).message);
        }
    }

    // ---------- Notion ----------
    let notionPageId: string | undefined;
    if (notionConfigurado && notion) {
        const dbId = idsNotion().notas;
        if (dbId) {
            try {
                // Truncar el markdown para caber en un solo párrafo (Notion limita
                // rich_text a 2000 chars por bloque). Para el informe completo hacemos
                // varios párrafos en el cuerpo de la página.
                const parrafos: Array<{ text: { content: string } }[]> = [];
                for (let i = 0; i < resumen_md.length; i += 1800) {
                    parrafos.push(chunkText(resumen_md.slice(i, i + 1800)));
                }
                const page = await notion.pages.create({
                    parent: { database_id: dbId },
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    properties: {
                        'Título': { title: [{ text: { content: `Informe semanal ${desdeFecha} → ${hastaFecha}` } }] },
                        'Fecha': { date: { start: hastaFecha } },
                        'Categoría': { select: { name: 'otro' } },
                        'Contexto': { rich_text: chunkText(`Informe semanal con ${propuestas.length} propuestas. Costo USD ${costo.toFixed(4)}. Contenido completo en el cuerpo de la página.`) },
                    } as any,
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    children: parrafos.map((p) => ({
                        object: 'block' as const, type: 'paragraph', paragraph: { rich_text: p },
                    })) as any,
                });
                notionPageId = page.id;
            } catch (err) {
                console.warn('[analitica] crear página Notion falló:', (err as Error).message);
            }
        }
    }

    // Actualizar reporte con flags de entrega
    if (reporteId) {
        await supabase.from('reportes_analitica')
            .update({ email_enviado: emailEnviado, notion_page_id: notionPageId })
            .eq('id', reporteId);
    }

    return {
        id: reporteId,
        periodo_desde: desdeFecha,
        periodo_hasta: hastaFecha,
        resumen_md,
        propuestas,
        stats: stats as unknown as Record<string, unknown>,
        tokens_in: tokensIn,
        tokens_out: tokensOut,
        costo_usd: costo,
        duracion_ms: Date.now() - inicio,
        notion_page_id: notionPageId,
        email_enviado: emailEnviado,
    };
}

export async function listarReportes(limit = 20) {
    const { data } = await supabase
        .from('reportes_analitica')
        .select('id, periodo_desde, periodo_hasta, propuestas, costo_usd, notion_page_id, email_enviado, creado_en')
        .order('creado_en', { ascending: false })
        .limit(limit);
    return data ?? [];
}

export async function obtenerReporte(id: string) {
    const { data } = await supabase
        .from('reportes_analitica')
        .select('*')
        .eq('id', id)
        .maybeSingle();
    return data;
}
