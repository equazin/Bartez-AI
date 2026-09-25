// Alta y edición manual de clientes (desde el panel o desde el chat de Bartez AI).
// Antes de crear se buscan parecidos (mismo email, teléfono o nombre) para no
// duplicar. Al crear o cambiar el email/teléfono se vinculan los correos y las
// conversaciones de WhatsApp que ya había de ese cliente.

import { supabase } from '../connectors/supabase.js';
import { crearNota } from './memoria.js';
import { crearProspectoEnNotion, actualizarProspectoEnNotion } from './notion_sync.js';

export type EstadoCliente = 'lead' | 'cliente' | 'inactivo' | 'descartado';

export interface DatosCliente {
    nombre: string;
    email?: string | null;
    whatsapp?: string | null;
    estado?: EstadoCliente;
    contacto?: string | null;
    sitio_web?: string | null;
    cuit?: string | null;
}

export interface Parecido { id: string; nombre: string; email: string | null; whatsapp: string | null; estado: string; motivo: string }

export interface Vinculados { correos: number; whatsapp: number }

// Casillas de correo personales: el dominio no identifica a una empresa.
const DOMINIOS_PERSONALES = new Set([
    'gmail.com', 'googlemail.com', 'hotmail.com', 'hotmail.com.ar', 'outlook.com', 'outlook.com.ar', 'live.com', 'live.com.ar',
    'msn.com', 'yahoo.com', 'yahoo.com.ar', 'icloud.com', 'me.com', 'aol.com', 'protonmail.com', 'proton.me',
    'fibertel.com.ar', 'arnet.com.ar', 'speedy.com.ar', 'ciudad.com.ar', 'uolsinectis.com.ar',
]);

const soloDigitos = (s: string) => s.replace(/\D/g, '');

// Teléfono en un solo formato. Los argentinos quedan como en WhatsApp:
// +549 + característica + número (10 dígitos), se hayan escrito con 0, 15,
// +54 o 9. Los de otros países quedan con + y los dígitos.
export function telefonoCanonico(entrada: string): string | null {
    const crudo = entrada.trim();
    let d = soloDigitos(crudo);
    if (d.length < 8) return null;
    if (d.startsWith('00')) d = d.slice(2);
    let esAr = false;
    if (d.startsWith('54')) { d = d.slice(2); esAr = true; if (d.startsWith('9')) d = d.slice(1); }
    else if (crudo.startsWith('+')) return `+${d}`;
    if (d.startsWith('0')) { d = d.slice(1); esAr = true; }
    // "341 15 695-1913": el 15 va después de la característica (2, 3 o 4 dígitos).
    if (d.length === 12) for (const a of [2, 3, 4]) if (d.slice(a, a + 2) === '15') { d = d.slice(0, a) + d.slice(a + 2); break; }
    if (d.length === 10) return `+549${d}`;
    return esAr ? `+54${d}` : d;
}

// Lo que se compara para saber si dos teléfonos son el mismo.
export function claveTelefono(s: string): string {
    const c = telefonoCanonico(s);
    if (c && c.startsWith('+549') && c.length === 14) return c.slice(-10);
    const d = soloDigitos(s);
    return d.length >= 8 ? d.slice(-8) : '';
}
// "Instalros S.R.L." ≈ "instalros srl" ≈ "INSTALROS"
export function nombreComparable(s: string): string {
    return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
        .replace(/\b(s\.?\s?r\.?\s?l\.?|s\.?\s?a\.?\s?s?\.?|s\.?\s?a\.?|s\.?\s?h\.?|sociedad|anonima|limitada|y cia\.?)\s*$/g, '')
        .replace(/[^a-z0-9]+/g, ' ').trim();
}

const limpiar = (v: string | null | undefined, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

// Valida y ordena lo que llega del panel o del chat.
export function normalizarDatos(d: DatosCliente): { ok: true; datos: Required<DatosCliente> } | { ok: false; detalle: string } {
    const nombre = limpiar(d.nombre, 120);
    if (!nombre || nombre.length < 2) return { ok: false, detalle: 'Falta el nombre del cliente o la empresa' };
    const email = limpiar(d.email, 200)?.toLowerCase() ?? null;
    if (email && !/^[a-z0-9._%+'-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(email)) return { ok: false, detalle: `El email "${email}" no parece válido` };
    let whatsapp = limpiar(d.whatsapp, 40);
    if (whatsapp) {
        const canonico = telefonoCanonico(whatsapp);
        // Sin característica no se puede saber de qué ciudad es (ni cruzarlo con WhatsApp).
        if (!canonico || (!canonico.startsWith('+') && canonico.length < 10)) {
            return { ok: false, detalle: `Al teléfono "${whatsapp}" le falta la característica: ponelo completo (ej. 341 695-1913)` };
        }
        whatsapp = canonico;
    }
    let sitio = limpiar(d.sitio_web, 200);
    if (sitio && !/^https?:\/\//i.test(sitio)) sitio = `https://${sitio}`;
    const estado: EstadoCliente = d.estado && ['lead', 'cliente', 'inactivo', 'descartado'].includes(d.estado) ? d.estado : 'lead';
    return { ok: true, datos: { nombre, email, whatsapp, estado, contacto: limpiar(d.contacto, 120), sitio_web: sitio, cuit: limpiar(d.cuit, 20) } };
}

// Clientes que podrían ser el mismo: mismo email, mismo teléfono, mismo nombre
// (sin "S.R.L.", acentos, etc.) o misma empresa por el dominio del email.
export async function buscarParecidos(d: Pick<DatosCliente, 'nombre' | 'email' | 'whatsapp'>, excluirId?: string): Promise<Parecido[]> {
    const { data, error } = await supabase.from('clientes').select('id, nombre, email, whatsapp, estado');
    if (error) throw new Error(error.message);
    const email = d.email?.toLowerCase().trim() || null;
    const dominio = email?.split('@')[1] ?? null;
    const tel = d.whatsapp ? claveTelefono(d.whatsapp) : '';
    const nombre = nombreComparable(d.nombre);
    const res: Parecido[] = [];
    for (const c of (data ?? []) as Array<{ id: string; nombre: string; email: string | null; whatsapp: string | null; estado: string }>) {
        if (c.id === excluirId) continue;
        const cEmail = c.email?.toLowerCase() ?? null;
        let motivo: string | null = null;
        if (email && cEmail === email) motivo = 'mismo email';
        else if (tel && c.whatsapp && claveTelefono(c.whatsapp) === tel) motivo = 'mismo teléfono';
        else if (nombre && nombreComparable(c.nombre) === nombre) motivo = 'mismo nombre';
        else if (dominio && !DOMINIOS_PERSONALES.has(dominio) && cEmail?.endsWith(`@${dominio}`)) motivo = `misma empresa (@${dominio})`;
        if (motivo) res.push({ ...c, motivo });
    }
    return res.slice(0, 5);
}

// Correos y conversaciones de WhatsApp sin cliente que son de este: por email
// exacto, por dominio (si es de empresa) y por teléfono.
export async function vincularHistoria(clienteId: string, email: string | null, whatsapp: string | null): Promise<Vinculados> {
    let correos = 0, wa = 0;
    if (email) {
        const r1 = await supabase.from('correos_historicos').update({ cliente_id: clienteId }, { count: 'exact' })
            .is('cliente_id', null).or(`de_email.eq.${email},para_email.eq.${email}`);
        correos += r1.count ?? 0;
        const dominio = email.split('@')[1];
        if (dominio && !DOMINIOS_PERSONALES.has(dominio)) {
            const r2 = await supabase.from('correos_historicos').update({ cliente_id: clienteId }, { count: 'exact' })
                .is('cliente_id', null).eq('dominio', dominio);
            correos += r2.count ?? 0;
        }
    }
    const tel = whatsapp ? claveTelefono(whatsapp) : '';
    if (tel) {
        const { data } = await supabase.from('wa_conversaciones').select('wa_id').is('cliente_id', null).ilike('wa_id', `%${tel.slice(-7)}`);
        const ids = (data ?? []).map((c) => c.wa_id as string).filter((w) => claveTelefono(w) === tel);
        if (ids.length) {
            const r3 = await supabase.from('wa_conversaciones').update({ cliente_id: clienteId }, { count: 'exact' }).in('wa_id', ids);
            wa += r3.count ?? 0;
        }
    }
    return { correos, whatsapp: wa };
}

export interface ResultadoCliente {
    ok: boolean;
    detalle?: string;
    cliente?: { id: string; nombre: string; email: string | null; whatsapp: string | null; estado: string };
    parecidos?: Parecido[];
    vinculados?: Vinculados;
}

export async function crearCliente(
    d: DatosCliente & { nota?: string | null },
    opts: { origen: 'manual' | 'chat'; crearIgual?: boolean },
): Promise<ResultadoCliente> {
    const n = normalizarDatos(d);
    if (!n.ok) return { ok: false, detalle: n.detalle };
    const datos = n.datos;
    if (!opts.crearIgual) {
        const parecidos = await buscarParecidos(datos);
        if (parecidos.length) return { ok: false, parecidos, detalle: 'Ya hay un cliente parecido' };
    }
    const metadata: Record<string, unknown> = {};
    if (datos.contacto) metadata.contacto = datos.contacto;
    if (datos.sitio_web) metadata.sitio_web = datos.sitio_web;
    if (datos.cuit) metadata.cuit = datos.cuit;
    if (datos.email) { const dom = datos.email.split('@')[1]; if (dom && !DOMINIOS_PERSONALES.has(dom)) metadata.dominio = dom; }
    const { data: nuevo, error } = await supabase.from('clientes').insert({
        nombre: datos.nombre, email: datos.email, whatsapp: datos.whatsapp, estado: datos.estado,
        origen: opts.origen === 'chat' ? 'chat' : 'manual', metadata,
    }).select('id, nombre, email, whatsapp, estado').single();
    if (error || !nuevo) return { ok: false, detalle: error?.message ?? 'No se pudo crear el cliente' };

    const vinculados = await vincularHistoria(nuevo.id as string, datos.email, datos.whatsapp);
    const nota = limpiar(d.nota, 60_000);
    if (nota) await crearNota(nuevo.id as string, nota).catch((err) => console.warn('[clientes] nota inicial:', (err as Error).message));
    void crearProspectoEnNotion(nuevo.id as string).catch(() => {});
    return { ok: true, cliente: nuevo as ResultadoCliente['cliente'], vinculados };
}

export async function editarCliente(id: string, d: DatosCliente): Promise<ResultadoCliente> {
    const n = normalizarDatos(d);
    if (!n.ok) return { ok: false, detalle: n.detalle };
    const datos = n.datos;
    const { data: actual } = await supabase.from('clientes').select('id, email, whatsapp, metadata').eq('id', id).maybeSingle();
    if (!actual) return { ok: false, detalle: 'Cliente no encontrado' };
    // Un email o teléfono que ya tiene otro cliente no se puede repetir.
    const choque = (await buscarParecidos(datos, id)).find((p) => p.motivo === 'mismo email' || p.motivo === 'mismo teléfono');
    if (choque) return { ok: false, parecidos: [choque], detalle: `${choque.nombre} ya tiene ese ${choque.motivo === 'mismo email' ? 'email' : 'teléfono'}` };

    const metadata = { ...((actual.metadata as Record<string, unknown> | null) ?? {}) };
    for (const k of ['contacto', 'sitio_web', 'cuit'] as const) {
        if (datos[k]) metadata[k] = datos[k]; else delete metadata[k];
    }
    const { data: guardado, error } = await supabase.from('clientes').update({
        nombre: datos.nombre, email: datos.email, whatsapp: datos.whatsapp, estado: datos.estado, metadata,
        actualizado_en: new Date().toISOString(),
    }).eq('id', id).select('id, nombre, email, whatsapp, estado').single();
    if (error || !guardado) return { ok: false, detalle: error?.message ?? 'No se pudo guardar' };

    // Si cambió el email o el teléfono, se suma la historia que había con los nuevos.
    const cambioEmail = datos.email && datos.email !== (actual.email as string | null)?.toLowerCase();
    const cambioTel = datos.whatsapp && claveTelefono(datos.whatsapp) !== claveTelefono(String(actual.whatsapp ?? ''));
    const vinculados = cambioEmail || cambioTel
        ? await vincularHistoria(id, cambioEmail ? datos.email : null, cambioTel ? datos.whatsapp : null)
        : { correos: 0, whatsapp: 0 };
    void actualizarProspectoEnNotion(id).catch(() => {});
    return { ok: true, cliente: guardado as ResultadoCliente['cliente'], vinculados };
}
