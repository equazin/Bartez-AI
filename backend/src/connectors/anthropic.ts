import Anthropic from '@anthropic-ai/sdk';
import type { ModeloClaude } from '../orchestrator/types.js';

const apiKey = process.env.ANTHROPIC_API_KEY ?? '';

export const anthropic = new Anthropic({ apiKey });

// Mapa de alias a IDs de modelo reales. Se ajusta a medida que Anthropic saca versiones.
const MODELO_IDS: Record<ModeloClaude, string> = {
    sonnet: 'claude-sonnet-4-5-20250929',
    haiku: 'claude-haiku-4-5-20251001',
    opus: 'claude-opus-4-5',
};

// Precios USD por millón de tokens (input / output) — actualizar cuando cambien.
const PRECIOS: Record<ModeloClaude, { in: number; out: number }> = {
    sonnet: { in: 3, out: 15 },
    haiku: { in: 1, out: 5 },
    opus: { in: 15, out: 75 },
};

export function idModelo(modelo: ModeloClaude): string {
    return MODELO_IDS[modelo];
}

export function calcularCosto(modelo: ModeloClaude, tokensIn: number, tokensOut: number): number {
    const p = PRECIOS[modelo];
    return (tokensIn / 1_000_000) * p.in + (tokensOut / 1_000_000) * p.out;
}
