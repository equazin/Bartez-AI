// Reglas fijas antes de que el asistente de Correo redacte nada. No dependen de
// la IA: son las cosas que nunca tienen que pasar.
// - Correos propios (bartez.com.ar, avisos "[Bartez AI]"): no se responden. Los
//   avisos de acción pendiente que llegan a ventas@ volvían a entrar a la casilla
//   y el asistente les contestaba.
// - "Nuevo lead web" (formulario / bot de WhatsApp): no se contesta el aviso; se
//   carga el lead con su teléfono y lo que necesita.
// - Proveedores: nunca se les responde solo ni se les confirma una compra. Si
//   mandan una cotización, queda una tarea para armar el presupuesto al cliente.

import { supabase } from '../connectors/supabase.js';
import { anthropic, calcularCosto, idModelo, maxTokens, opcionesModelo } from '../connectors/anthropic.js';

export const DOMINIO_PROPIO = 'bartez.com.ar';

// Mayoristas, distribuidores y fabricantes conocidos. Otros se marcan desde la
// ficha (estado "Proveedor").
export const DOMINIOS_PROVEEDORES = [
    'grupoair.com.ar', 'air-intra.com', 'tanyx.com.ar', 'elit.com.ar', 'invid.com.ar', 'invidcomputers.com',
    'netpointar.com', 'lenovo.com', 'dell.com', 'hp.com', 'hpe.com', 'synology.com', 'ingrammicro.com',
    'gruponucleo.com.ar', 'stylus.com.ar', 'solutionbox.com.ar', 'microglobal.com.ar', 'pcarts.com.ar',
];

const dominio = (email: string) => email.trim().toLowerCase().split('@')[1] ?? '';
const coincide = (d: string, lista: string[]) => lista.some((x) => d === x || d.endsWith(`.${x}`));

export function esCorreoPropio(de: string, asunto: string): boolean {
    return coincide(dominio(de), [DOMINIO_PROPIO]) || /^\s*(re:\s*)*\[bartez ai\]/i.test(asunto);
}

export function esLeadWeb(asunto: string): boolean {
    return /^\s*nuevo lead web/i.test(asunto);
}

// ¿Es de un proveedor? Por dominio conocido o porque el contacto está marcado
// como proveedor en la ficha.
export async function esProveedor(de: string): Promise<{ proveedor: boolean; clienteId: string | null }> {
    const email = de.trim().toLowerCase();
    const d = dominio(email);
    const { data } = await supabase.from('clientes').select('id, estado').eq('email', email).limit(1);
    const c = data?.[0];
    if (c?.estado === 'proveedor') return { proveedor: true, clienteId: c.id as string };
    if (coincide(d, DOMINIOS_PROVEEDORES)) return { proveedor: true, clienteId: (c?.id as string) ?? null };
    if (d) {
        // Otro contacto del mismo dominio ya marcado como proveedor.
        const { data: mismo } = await supabase.from('clientes').select('id').eq('estado', 'proveedor').like('email', `%@${d}`).limit(1);
        if (mismo?.[0]) return { proveedor: true, clienteId: (c?.id as string) ?? null };
    }
    return { proveedor: false, clienteId: null };
}

export interface LeadWeb { nombre: string | null; empresa: string | null; email: string | null; telefono: string | null; necesidad: string | null }

// "Empresa… Contacto… Email… Teléfono… Tipo… Agendar reunión… Mensaje… Necesidad: …"
// (el aviso llega con los rótulos pegados a los valores).
export function parsearLeadWeb(cuerpo: string): LeadWeb {
    const t = cuerpo.replace(/\s+/g, ' ');
    const campo = (rotulo: string, hasta: string) => {
        const m = t.match(new RegExp(`${rotulo}\\s*:?\\s*(.*?)\\s*(?:${hasta})`, 'i'));
        const v = m?.[1]?.trim();
        return v && !/^(no especificad[ao]|sin especificar|-)$/i.test(v) ? v : null;
    };
    const email = campo('Email', 'Tel[eé]fono|Tipo|$');
    const tel = campo('Tel[eé]fono', 'Tipo|Agendar|Mensaje|$')?.replace(/[^\d+]/g, '') || null;
    const necesidad = t.match(/Necesidad\s*:\s*(.+)$/i)?.[1]?.trim() ?? campo('Mensaje', '$');
    return {
        empresa: campo('Empresa', 'Contacto'),
        nombre: campo('Contacto', 'Email|Tel[eé]fono'),
        email: email && !/placeholder/i.test(email) ? email.toLowerCase() : null,
        telefono: tel && tel.replace(/\D/g, '').length >= 10 ? (tel.startsWith('+') ? tel : `+${tel}`) : null,
        necesidad: necesidad ? necesidad.slice(0, 500) : null,
    };
}

// Lo que mandó un proveedor, en una línea: ¿trae una cotización o proforma? Si
// sí, qué hay que hacer. Haiku, barato.
export async function leerCorreoDeProveedor(c: { de: string; asunto: string; cuerpo: string }): Promise<{ cotizacion: boolean; tarea: string | null; costoUsd: number }> {
    try {
        const r = await anthropic.messages.create({
            ...opcionesModelo('haiku'),
            max_tokens: maxTokens('haiku', 200),
            system: `Sos el asistente de Bartez Tecnología (mayorista de IT en Rosario). Te llega un correo de un PROVEEDOR (mayorista, distribuidor o fabricante que le vende a Bartez). Nunca se le responde solo.
Decidí si trae una cotización, proforma, precios, disponibilidad o plazo de entrega que Andrés tenga que usar para armarle el presupuesto a un cliente.
Respondé SOLO JSON: {"cotizacion": true|false, "tarea": "Acción en una línea para Andrés, ej: \\"Armar presupuesto al cliente con la cotización de Grupo Air (Server Dell R760 con GPU)\\"" o null}.
Si es un acuse ("enviado a cotizar, te aviso"), una promoción o algo informativo, cotizacion=false y tarea=null.`,
            messages: [{ role: 'user', content: `De: ${c.de}\nAsunto: ${c.asunto}\n\n${c.cuerpo.slice(0, 3000)}` }],
        });
        const texto = r.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
        const j = JSON.parse(texto.match(/\{[\s\S]*\}/)?.[0] ?? '{}') as { cotizacion?: boolean; tarea?: string | null };
        return { cotizacion: j.cotizacion === true, tarea: j.cotizacion && j.tarea ? String(j.tarea).slice(0, 200) : null, costoUsd: calcularCosto('haiku', r.usage.input_tokens, r.usage.output_tokens) };
    } catch {
        return { cotizacion: false, tarea: null, costoUsd: 0 };
    }
}
