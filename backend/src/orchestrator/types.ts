// Tipos compartidos del orquestador y los asistentes.

export type ModeloClaude = 'sonnet' | 'haiku';

export interface AsistenteConfig {
    id: string;
    nombre: string;
    area: string;
    modelo: ModeloClaude;
    prompt: string;
    autonomia: number; // 0 = todo requiere aprobación, 100 = full autónomo
    activo: boolean;
}

export interface TareaEntrante {
    canal: 'correo' | 'whatsapp' | 'panel';
    clienteId?: string;
    conversacionId?: string;
    texto: string;
    metadata?: Record<string, unknown>;
}

export interface ResultadoAsistente {
    respuesta: string;
    requiereAprobacion: boolean;
    accionPropuesta?: {
        tipo: 'enviar_correo' | 'mandar_whatsapp' | 'crear_notion' | 'otra';
        payload: Record<string, unknown>;
    };
    tokensIn: number;
    tokensOut: number;
    costoUsd: number;
    duracionMs: number;
}

export interface Asistente {
    config: AsistenteConfig;
    procesar(tarea: TareaEntrante): Promise<ResultadoAsistente>;
}
