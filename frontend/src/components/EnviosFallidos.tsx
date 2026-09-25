// Envíos aprobados que no salieron (correo o WhatsApp). Quedan a la vista con
// "Reintentar" hasta que salgan o se descarten: nada se pierde en silencio.

import { useState } from 'react';
import { EnvioFallido, descartarEnvio, reintentarEnvio } from '../api/client.ts';

// El error técnico, en castellano.
export function motivoEnvio(detalle?: string): string {
    const d = detalle ?? '';
    if (/railway/i.test(d)) return 'Railway (plan Hobby) bloquea el envío de correos por SMTP.';
    if (/timeout|timed out|ETIMEDOUT|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH/i.test(d)) return 'No se pudo conectar al servidor de correo.';
    if (/24 h|plantilla/i.test(d)) return 'Pasaron más de 24 h: WhatsApp solo deja escribir con una plantilla.';
    return d || 'Error desconocido.';
}

function destino(a: EnvioFallido): string {
    const p = a.payload;
    if (a.accion === 'enviar_whatsapp') return String(p.nombreCliente ?? p.nombreContacto ?? `+${p.waId ?? ''}`);
    return String(p.nombreCliente ?? p.para ?? 'sin destinatario');
}

function resumen(a: EnvioFallido): string {
    const p = a.payload;
    if (a.accion === 'enviar_correo' && typeof p.asunto === 'string') return p.asunto;
    return String(p.cuerpo ?? '').replace(/\s+/g, ' ').slice(0, 90);
}

const fecha = (iso: string | null) => (iso ? new Date(iso).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '');

export function EnviosFallidos({ acciones, alCambiar, titulo }: {
    acciones: EnvioFallido[];
    // Se llama cuando uno salió o se descartó, para recargar.
    alCambiar: () => void;
    titulo?: string;
}) {
    const [ocupado, setOcupado] = useState<string | null>(null);
    const [resultado, setResultado] = useState<Record<string, string>>({});
    if (!acciones.length) return null;

    async function reintentar(a: EnvioFallido) {
        setOcupado(a.id);
        try {
            const r = await reintentarEnvio(a.id);
            if (r.ejecucion.ok) { setResultado((x) => ({ ...x, [a.id]: '✓ Enviado' })); alCambiar(); }
            else setResultado((x) => ({ ...x, [a.id]: `Tampoco salió: ${motivoEnvio(r.ejecucion.detalle)}` }));
        } catch (e) { setResultado((x) => ({ ...x, [a.id]: (e as Error).message })); }
        finally { setOcupado(null); }
    }

    async function descartar(a: EnvioFallido) {
        if (!window.confirm(`¿Descartar el envío a ${destino(a)}? No se va a mandar.`)) return;
        setOcupado(a.id);
        try { await descartarEnvio(a.id); alCambiar(); }
        catch (e) { setResultado((x) => ({ ...x, [a.id]: (e as Error).message })); }
        finally { setOcupado(null); }
    }

    return (
        <section className="envios-fallidos" aria-label="Envíos que no salieron" role="alert">
            <div className="ef-cab">
                <strong>⚠ {titulo ?? (acciones.length === 1 ? '1 envío aprobado no salió' : `${acciones.length} envíos aprobados no salieron`)}</strong>
                <span>{motivoEnvio(acciones[0]!.respuesta?.ejecucion?.detalle)} Quedan acá hasta que salgan: tocá Reintentar cuando se resuelva.</span>
            </div>
            <ul>
                {acciones.map((a) => (
                    <li key={a.id}>
                        <span className="ef-canal">{a.accion === 'enviar_whatsapp' ? 'WhatsApp' : 'Correo'}</span>
                        <div className="ef-info">
                            <span className="ef-destino">{destino(a)}</span>
                            <span className="ef-resumen">{resumen(a)}</span>
                            <span className="ef-fecha">Aprobado {fecha(a.resuelto_en)}{a.respuesta?.reintento_en ? ` · último intento ${fecha(a.respuesta.reintento_en)}` : ''}</span>
                            {resultado[a.id] && <span className={`ef-resultado ${resultado[a.id]!.startsWith('✓') ? 'ok' : ''}`}>{resultado[a.id]}</span>}
                        </div>
                        <div className="ef-acc">
                            <button type="button" className="secundario" onClick={() => reintentar(a)} disabled={ocupado === a.id}>{ocupado === a.id ? 'Enviando…' : 'Reintentar'}</button>
                            <button type="button" className="enlace ef-descartar" onClick={() => descartar(a)} disabled={ocupado === a.id}>Descartar</button>
                        </div>
                    </li>
                ))}
            </ul>
        </section>
    );
}
