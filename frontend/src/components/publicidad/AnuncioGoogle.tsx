// Cómo se ve un anuncio en el buscador de Google. Google no da la imagen del
// anuncio: se dibuja con sus textos. Muestra la combinación de los primeros
// títulos y descripciones (Google rota y combina, esta es la base).

export function dominioYRuta(url: string | null, ruta1?: string | null, ruta2?: string | null): string {
    let dominio = 'bartez.com.ar';
    try { if (url) dominio = new URL(url).hostname.replace(/^www\./, ''); } catch { /* url rara */ }
    const partes = [ruta1, ruta2].filter(Boolean) as string[];
    if (!partes.length && url) {
        try { partes.push(...new URL(url).pathname.split('/').filter(Boolean).slice(-2)); } catch { /* nada */ }
    }
    return [dominio, ...partes].join(' › ');
}

export function AnuncioGoogle({ titulos, descripciones, url, ruta1, ruta2, modo = 'compu', enlaces }: {
    titulos: string[];
    descripciones: string[];
    url: string | null;
    ruta1?: string | null;
    ruta2?: string | null;
    modo?: 'compu' | 'celu' | 'tarjeta';
    enlaces?: string[];
}) {
    const cuantos = modo === 'celu' ? 2 : 3;
    const titulo = titulos.slice(0, cuantos).join(' | ');
    const texto = descripciones.slice(0, modo === 'celu' ? 1 : 2).join(' ');
    return (
        <div className={`anuncio-g anuncio-g-${modo}`}>
            {modo === 'compu' && (
                <div className="anuncio-g-marca">
                    <span className="anuncio-g-favicon" aria-hidden="true">B</span>
                    <span><span className="anuncio-g-nombre">Bartez Tecnología</span><span className="anuncio-g-url">{dominioYRuta(url, ruta1, ruta2)}</span></span>
                </div>
            )}
            <span className="anuncio-g-patro">Patrocinado</span>
            {modo !== 'compu' && <span className="anuncio-g-url">{modo === 'celu' ? dominioYRuta(url).split(' › ')[0] : dominioYRuta(url, ruta1, ruta2)}</span>}
            <span className="anuncio-g-titulo">{titulo || 'Sin títulos'}</span>
            <span className="anuncio-g-texto">{texto}</span>
            {enlaces && enlaces.length > 0 && (
                <span className={modo === 'celu' ? 'anuncio-g-chips' : 'anuncio-g-enlaces'}>
                    {enlaces.map((e) => <span key={e}>{e}</span>)}
                </span>
            )}
        </div>
    );
}
