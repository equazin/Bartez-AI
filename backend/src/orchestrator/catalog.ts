// Catálogo de asistentes.
// Se carga desde la base al iniciar el servidor y expone lookup por área o nombre.
// Agregar un asistente nuevo = una fila en la tabla `asistentes` + su implementación en /assistants.

import { supabase } from '../connectors/supabase.js';
import type { Asistente, AsistenteConfig } from './types.js';
import { registrarAsistentes } from '../assistants/registro.js';

class Catalogo {
    private porArea = new Map<string, Asistente>();
    private porId = new Map<string, Asistente>();

    async cargar(): Promise<void> {
        const { data, error } = await supabase
            .from('asistentes')
            .select('*')
            .eq('activo', true);

        if (error) throw error;
        if (!data) return;

        const implementaciones = registrarAsistentes();

        for (const row of data as AsistenteConfig[]) {
            const factory = implementaciones.get(row.area);
            if (!factory) {
                console.warn(`[catalogo] asistente activo "${row.nombre}" (área ${row.area}) sin implementación — se omite`);
                continue;
            }
            const instancia = factory(row);
            this.porArea.set(row.area, instancia);
            this.porId.set(row.id, instancia);
        }

        console.log(`[catalogo] ${this.porArea.size} asistentes activos cargados`);
    }

    obtenerPorArea(area: string): Asistente | undefined {
        return this.porArea.get(area);
    }

    obtenerPorId(id: string): Asistente | undefined {
        return this.porId.get(id);
    }

    listarActivos(): Asistente[] {
        return Array.from(this.porArea.values());
    }
}

export const catalogo = new Catalogo();
