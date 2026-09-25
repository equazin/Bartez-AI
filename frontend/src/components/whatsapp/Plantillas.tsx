// Plantillas de WhatsApp: la configuración (las que tenés aprobadas en Meta) y
// el formulario para retomar una conversación vencida con una de ellas.

import { useEffect, useState } from 'react';
import { PlantillaWa, guardarPlantillasWa, listarPlantillasWa, proponerPlantillaWa } from '../../api/client.ts';

const cantidadParametros = (texto: string) => Math.max(0, ...[...texto.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1])));
const conParametros = (texto: string, valores: string[]) =>
    texto.replace(/\{\{(\d+)\}\}/g, (_m, n: string) => valores[Number(n) - 1]?.trim() || `{{${n}}}`);

const VACIA: PlantillaWa = { nombre: '', idioma: 'es_AR', texto: '', descripcion: '' };

export function ConfigPlantillas({ alCerrar, alGuardar }: { alCerrar: () => void; alGuardar?: () => void }) {
    const [lista, setLista] = useState<PlantillaWa[] | null>(null);
    const [edicion, setEdicion] = useState<{ i: number | null; p: PlantillaWa } | null>(null);
    const [error, setError] = useState<string>();

    useEffect(() => { listarPlantillasWa().then((r) => setLista(r.plantillas)).catch((e) => setError((e as Error).message)); }, []);

    async function guardarLista(nueva: PlantillaWa[]) {
        setError(undefined);
        try { await guardarPlantillasWa(nueva); setLista(nueva); setEdicion(null); alGuardar?.(); } catch (e) { setError((e as Error).message); }
    }

    function guardar() {
        if (!edicion || !lista) return;
        const p = { ...edicion.p, nombre: edicion.p.nombre.trim(), texto: edicion.p.texto.trim() };
        if (!p.nombre || !p.texto) { setError('Poné el nombre y el texto de la plantilla.'); return; }
        const nueva = edicion.i == null ? [...lista, p] : lista.map((x, i) => (i === edicion.i ? p : x));
        guardarLista(nueva);
    }

    return (
        <div className="panel wa-plantillas">
            <div className="panel-cab">
                <h3>Plantillas de WhatsApp</h3>
                <button className="boton-fantasma" onClick={alCerrar}>Cerrar</button>
            </div>
            <p className="sub">
                Son las únicas que WhatsApp deja mandar cuando pasaron más de 24 h del último mensaje del cliente. Cargalas
                con el <strong>mismo nombre, idioma y texto</strong> con que están aprobadas en Meta (WhatsApp Manager → Plantillas).
                Usá {'{{1}}'}, {'{{2}}'}… donde van los datos de cada envío.
            </p>
            {error && <p className="error">{error}</p>}
            {lista == null ? <p className="tenue">Cargando…</p> : lista.length === 0 && !edicion ? (
                <p className="tenue">Todavía no cargaste ninguna.</p>
            ) : (
                <ul className="lista-seca">
                    {lista.map((p, i) => (
                        <li key={p.nombre + i} className="wa-pl-fila">
                            <span className="wa-pl-nombre"><strong>{p.nombre}</strong> <span className="tenue">{p.idioma}{p.descripcion ? ` · ${p.descripcion}` : ''}</span></span>
                            <span className="wa-pl-texto">{p.texto}</span>
                            <span className="wa-pl-botones">
                                <button className="enlace" onClick={() => setEdicion({ i, p })}>Editar</button>
                                <button className="enlace enlace-peligro" onClick={() => { if (confirm(`¿Quitar la plantilla ${p.nombre}?`)) guardarLista(lista.filter((_, j) => j !== i)); }}>Quitar</button>
                            </span>
                        </li>
                    ))}
                </ul>
            )}
            {edicion ? (
                <div className="wa-pl-form">
                    <label><span>Nombre en Meta</span><input value={edicion.p.nombre} onChange={(e) => setEdicion({ ...edicion, p: { ...edicion.p, nombre: e.target.value } })} placeholder="retomar_consulta" /></label>
                    <label><span>Idioma</span><input value={edicion.p.idioma} onChange={(e) => setEdicion({ ...edicion, p: { ...edicion.p, idioma: e.target.value } })} placeholder="es_AR" /></label>
                    <label className="ancho"><span>Para qué sirve (opcional)</span><input value={edicion.p.descripcion ?? ''} onChange={(e) => setEdicion({ ...edicion, p: { ...edicion.p, descripcion: e.target.value } })} placeholder="Retomar una consulta que quedó sin cerrar" /></label>
                    <label className="ancho"><span>Texto</span><textarea rows={3} value={edicion.p.texto} onChange={(e) => setEdicion({ ...edicion, p: { ...edicion.p, texto: e.target.value } })} placeholder="Hola {{1}}, te escribo de Bartez Tecnología por tu consulta sobre {{2}}. ¿Seguís interesado?" /></label>
                    <div className="wa-pl-acciones">
                        <button className="btn-primario" onClick={guardar}>Guardar plantilla</button>
                        <button className="boton-fantasma" onClick={() => setEdicion(null)}>Cancelar</button>
                    </div>
                </div>
            ) : (
                <button className="secundario" onClick={() => setEdicion({ i: null, p: VACIA })}>Agregar plantilla</button>
            )}
        </div>
    );
}

export function RetomarConPlantilla({ waId, nombre, deshabilitado, alProponer, alConfigurar }: {
    waId: string; nombre: string | null; deshabilitado: boolean; alProponer: (msg: string) => void; alConfigurar: () => void;
}) {
    const [lista, setLista] = useState<PlantillaWa[] | null>(null);
    const [elegida, setElegida] = useState('');
    const [valores, setValores] = useState<string[]>([]);
    const [ocupado, setOcupado] = useState(false);
    const [error, setError] = useState<string>();

    useEffect(() => { listarPlantillasWa().then((r) => setLista(r.plantillas)).catch(() => setLista([])); }, []);
    const plantilla = lista?.find((p) => p.nombre === elegida) ?? null;
    const n = plantilla ? cantidadParametros(plantilla.texto) : 0;

    function elegir(nombrePl: string) {
        setElegida(nombrePl);
        const p = lista?.find((x) => x.nombre === nombrePl);
        const cant = p ? cantidadParametros(p.texto) : 0;
        // {{1}} suele ser el nombre: se completa solo con el primer nombre.
        setValores(Array.from({ length: cant }, (_, i) => (i === 0 && nombre ? nombre.split(' ')[0]! : '')));
    }

    async function proponer() {
        if (!plantilla) return;
        setOcupado(true);
        setError(undefined);
        try {
            await proponerPlantillaWa(waId, plantilla.nombre, valores);
            alProponer('✓ Plantilla lista en Para aprobar. Sale cuando la apruebes.');
            setElegida('');
        } catch (e) { setError((e as Error).message); }
        finally { setOcupado(false); }
    }

    if (lista == null) return null;
    if (lista.length === 0) {
        return (
            <div className="wa-retomar">
                <span className="tenue">Para retomar esta conversación necesitás una plantilla aprobada en Meta.</span>
                <button className="secundario" onClick={alConfigurar}>Cargar plantillas</button>
            </div>
        );
    }
    return (
        <div className="wa-retomar">
            <label className="wa-retomar-sel">
                <span>Retomar con plantilla</span>
                <select value={elegida} onChange={(e) => elegir(e.target.value)} disabled={deshabilitado}>
                    <option value="">Elegí una plantilla…</option>
                    {lista.map((p) => <option key={p.nombre} value={p.nombre}>{p.descripcion ? `${p.descripcion} (${p.nombre})` : p.nombre}</option>)}
                </select>
            </label>
            {plantilla && (
                <>
                    {n > 0 && (
                        <div className="wa-retomar-valores">
                            {valores.map((v, i) => (
                                <label key={i}><span>{`{{${i + 1}}}`}</span><input value={v} onChange={(e) => setValores(valores.map((x, j) => (j === i ? e.target.value : x)))} /></label>
                            ))}
                        </div>
                    )}
                    <div className="wa-burbuja saliente wa-propuesta">{conParametros(plantilla.texto, valores)}</div>
                    <button className="btn-primario" onClick={proponer} disabled={ocupado || deshabilitado}>{ocupado ? 'Preparando…' : 'Proponer plantilla'}</button>
                </>
            )}
            {error && <p className="error">{error}</p>}
        </div>
    );
}
