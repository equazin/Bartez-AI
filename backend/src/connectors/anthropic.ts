import Anthropic from '@anthropic-ai/sdk';
import type { ModeloClaude } from '../orchestrator/types.js';

const apiKey = process.env.ANTHROPIC_API_KEY ?? '';

export const anthropic = new Anthropic({ apiKey });

// Alias → modelo real. MODELO_SONNET / MODELO_OPUS / MODELO_HAIKU en Railway
// permiten volver atrás sin tocar código (ej. MODELO_SONNET=claude-sonnet-4-5-20250929).
const MODELO_IDS: Record<ModeloClaude, string> = {
    sonnet: process.env.MODELO_SONNET || 'claude-sonnet-5',
    haiku: process.env.MODELO_HAIKU || 'claude-haiku-4-5-20251001',
    opus: process.env.MODELO_OPUS || 'claude-opus-5',
};

// Precios USD por millón de tokens (entrada / salida), por modelo real.
const PRECIOS: Record<string, { in: number; out: number }> = {
    'claude-sonnet-5': { in: 2, out: 10 },
    'claude-sonnet-4-6': { in: 3, out: 15 },
    'claude-sonnet-4-5-20250929': { in: 3, out: 15 },
    'claude-haiku-4-5-20251001': { in: 1, out: 5 },
    'claude-opus-5': { in: 5, out: 25 },
    'claude-opus-4-5': { in: 5, out: 25 },
};
const PRECIO_ALIAS: Record<ModeloClaude, { in: number; out: number }> = {
    sonnet: { in: 3, out: 15 },
    haiku: { in: 1, out: 5 },
    opus: { in: 5, out: 25 },
};

export function idModelo(modelo: ModeloClaude): string {
    return MODELO_IDS[modelo];
}

// Cuánto piensa el modelo antes de escribir. Sonnet 5 y Opus 5 piensan solos
// (thinking adaptativo); "medium" rinde como el Sonnet anterior en su máximo y
// cuida el gasto. Haiku 4.5 y Sonnet 4.5 no usan este parámetro.
export type Esfuerzo = 'low' | 'medium' | 'high';

export const piensa = (id: string) => /^claude-(sonnet-5|opus-5|sonnet-4-6|opus-4-[678])/.test(id);

export function opcionesModelo(modelo: ModeloClaude | string, esfuerzo: Esfuerzo = 'medium'): { model: string; output_config?: { effort: Esfuerzo } } {
    const id = modelo in MODELO_IDS ? idModelo(modelo as ModeloClaude) : modelo;
    return piensa(id) ? { model: id, output_config: { effort: esfuerzo } } : { model: id };
}

// max_tokens incluye lo que el modelo piensa: a los modelos que piensan les
// damos margen para que la respuesta no salga cortada (solo se paga lo usado).
export function maxTokens(modelo: ModeloClaude | string, base: number): number {
    const id = modelo in MODELO_IDS ? idModelo(modelo as ModeloClaude) : modelo;
    return piensa(id) ? Math.max(base * 3, 4000) : base;
}

export function calcularCosto(modelo: ModeloClaude | string, tokensIn: number, tokensOut: number): number {
    const id = modelo in MODELO_IDS ? idModelo(modelo as ModeloClaude) : modelo;
    const p = PRECIOS[id] ?? PRECIO_ALIAS[modelo as ModeloClaude] ?? PRECIO_ALIAS.sonnet;
    return (tokensIn / 1_000_000) * p.in + (tokensOut / 1_000_000) * p.out;
}

// Solo el texto de la respuesta (sin bloques de pensamiento ni de herramientas).
export function textoDe(resp: { content: Array<{ type: string }> }): string {
    return resp.content.map((b) => (b.type === 'text' ? (b as unknown as { text: string }).text : '')).join('\n').trim();
}
