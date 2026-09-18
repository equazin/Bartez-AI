// Cliente HTTP mínimo al backend de Bartez AI.
// La URL del backend se toma de VITE_BACKEND_URL en build; por defecto localhost.

const BASE = import.meta.env.VITE_BACKEND_URL ?? 'http://localhost:3000';

export interface TareaEntrada {
    canal: 'correo' | 'whatsapp' | 'panel';
    texto: string;
    metadata?: Record<string, unknown>;
}

export async function enviarTarea(t: TareaEntrada): Promise<{ resultado: unknown }> {
    const res = await fetch(`${BASE}/tareas`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(t),
    });
    if (!res.ok) throw new Error(`Backend respondió ${res.status}`);
    return res.json();
}

export async function metricasHoy(): Promise<{ sistema: unknown[]; negocio: unknown }> {
    const res = await fetch(`${BASE}/metricas/hoy`);
    if (!res.ok) throw new Error(`Backend respondió ${res.status}`);
    return res.json();
}
