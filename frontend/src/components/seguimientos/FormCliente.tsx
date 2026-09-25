// Alta y edición de un cliente a mano. Si ya hay uno parecido (mismo email,
// teléfono o nombre), lo muestra para abrirlo en vez de duplicarlo.

import { FormEvent, useState } from 'react';
import { ClienteParecido, DatosClienteForm, crearClienteManual, editarDatosCliente } from '../../api/client.ts';

type Estado = DatosClienteForm['estado'];
const ESTADOS: Array<[Estado, string]> = [['lead', 'Lead'], ['cliente', 'Cliente'], ['inactivo', 'Inactivo'], ['descartado', 'Descartado']];

export interface ClienteInicial {
    id: string;
    nombre: string;
    email: string | null;
    whatsapp: string | null;
    estado: Estado;
    metadata?: { sitio_web?: string; contacto?: string; cuit?: string } | null;
}

export function FormCliente({ inicial, alGuardar, alCancelar, alAbrir }: {
    inicial?: ClienteInicial;
    alGuardar: (r: { id: string; nombre: string; vinculados: { correos: number; whatsapp: number } }) => void;
    alCancelar: () => void;
    // Abrir un cliente parecido que ya existe.
    alAbrir: (id: string) => void;
}) {
    const editando = !!inicial;
    const [d, setD] = useState<DatosClienteForm>({
        nombre: inicial?.nombre ?? '',
        email: inicial?.email ?? '',
        whatsapp: inicial?.whatsapp ?? '',
        estado: inicial?.estado ?? 'lead',
        contacto: inicial?.metadata?.contacto ?? '',
        sitio_web: inicial?.metadata?.sitio_web ?? '',
        cuit: inicial?.metadata?.cuit ?? '',
    });
    const [nota, setNota] = useState('');
    const [guardando, setGuardando] = useState(false);
    const [error, setError] = useState<string>();
    const [parecidos, setParecidos] = useState<ClienteParecido[]>([]);

    const campo = (k: keyof DatosClienteForm) => ({
        value: (d[k] as string | null) ?? '',
        onChange: (e: { target: { value: string } }) => { setD((x) => ({ ...x, [k]: e.target.value })); setParecidos([]); setError(undefined); },
    });

    async function guardar(crearIgual = false) {
        if (!d.nombre.trim()) { setError('Poné el nombre del cliente o la empresa'); return; }
        setGuardando(true);
        setError(undefined);
        const vacio = (v: string | null) => (v && v.trim() ? v.trim() : null);
        const datos: DatosClienteForm = {
            ...d, nombre: d.nombre.trim(), email: vacio(d.email), whatsapp: vacio(d.whatsapp),
            contacto: vacio(d.contacto), sitio_web: vacio(d.sitio_web), cuit: vacio(d.cuit),
        };
        try {
            const r = editando
                ? await editarDatosCliente(inicial!.id, datos)
                : await crearClienteManual({ ...datos, nota: vacio(nota) }, crearIgual);
            if (r.ok) { alGuardar({ id: r.cliente.id, nombre: r.cliente.nombre, vinculados: r.vinculados }); return; }
            setParecidos(r.parecidos);
            setError(r.parecidos.length ? undefined : r.error);
            if (r.parecidos.length && editando) setError(r.error);
        } catch (e) { setError((e as Error).message); }
        finally { setGuardando(false); }
    }

    function enviar(e: FormEvent) { e.preventDefault(); void guardar(); }

    return (
        <form className="form-cliente" onSubmit={enviar} onKeyDown={(e) => { if (e.key === 'Escape') alCancelar(); }} aria-label={editando ? 'Editar cliente' : 'Nuevo cliente'}>
            <div className="form-cliente-cab">
                <h3>{editando ? `Editar ${inicial!.nombre}` : 'Nuevo cliente'}</h3>
                <p>{editando ? 'Si cambiás el email o el teléfono, se suman los correos y chats de WhatsApp que ya había.' : 'Se suman solos los correos y chats de WhatsApp que ya había de ese email o teléfono.'}</p>
            </div>

            <div className="form-cliente-grid">
                <label className="ancho">
                    <span>Empresa o persona *</span>
                    <input {...campo('nombre')} autoFocus required maxLength={120} placeholder="ej. Instalros SRL" />
                </label>
                <div className="ancho form-cliente-estado" role="radiogroup" aria-label="Estado">
                    <span>Estado</span>
                    <div className="segmentos">
                        {ESTADOS.filter(([v]) => editando || v === 'lead' || v === 'cliente').map(([v, etq]) => (
                            <button key={v} type="button" role="radio" aria-checked={d.estado === v} className={d.estado === v ? 'on' : ''} onClick={() => setD((x) => ({ ...x, estado: v }))}>{etq}</button>
                        ))}
                    </div>
                    <small>{d.estado === 'cliente' ? 'Ya compró.' : d.estado === 'lead' ? 'Todavía no compró.' : ''}</small>
                </div>
                <label>
                    <span>Email</span>
                    <input {...campo('email')} type="email" inputMode="email" autoComplete="off" placeholder="compras@empresa.com.ar" />
                </label>
                <label>
                    <span>WhatsApp o teléfono</span>
                    <input {...campo('whatsapp')} type="tel" inputMode="tel" autoComplete="off" placeholder="341 695-1913 (con característica)" />
                </label>
                <label>
                    <span>Persona de contacto</span>
                    <input {...campo('contacto')} placeholder="ej. Leticia (compras)" />
                </label>
                <label>
                    <span>Sitio web</span>
                    <input {...campo('sitio_web')} inputMode="url" placeholder="empresa.com.ar" />
                </label>
                <label>
                    <span>CUIT</span>
                    <input {...campo('cuit')} inputMode="numeric" placeholder="30-12345678-9" />
                </label>
                {!editando && (
                    <label className="ancho">
                        <span>Lo que sabés de este cliente (opcional)</span>
                        <textarea value={nota} onChange={(e) => setNota(e.target.value)} rows={3} placeholder="ej. Lo conocí en la expo, arma redes para obras. Pidió precio de switches Aruba." />
                        <small>Queda como nota en su memoria: la usan los seguimientos, el correo, WhatsApp y el chat.</small>
                    </label>
                )}
            </div>

            {parecidos.length > 0 && (
                <div className="form-cliente-parecidos" role="alert">
                    <strong>{editando ? error : parecidos.length === 1 ? 'Ya hay un cliente parecido:' : 'Ya hay clientes parecidos:'}</strong>
                    <ul>
                        {parecidos.map((p) => (
                            <li key={p.id}>
                                <span className="fcp-nombre">{p.nombre}</span>
                                <span className="fcp-dato">{p.motivo}{p.email ? ` · ${p.email}` : ''}</span>
                                <button type="button" className="enlace" onClick={() => alAbrir(p.id)}>Abrir</button>
                            </li>
                        ))}
                    </ul>
                    {!editando && (
                        <button type="button" className="secundario" onClick={() => guardar(true)} disabled={guardando}>No es ninguno: crear igual</button>
                    )}
                </div>
            )}
            {error && parecidos.length === 0 && <p className="form-cliente-error" role="alert">{error}</p>}

            <div className="form-cliente-pie">
                <button type="button" className="secundario" onClick={alCancelar}>Cancelar</button>
                <button type="submit" className="btn-primario" disabled={guardando || !d.nombre.trim()}>
                    {guardando ? 'Guardando…' : editando ? 'Guardar cambios' : 'Crear cliente'}
                </button>
            </div>
        </form>
    );
}
