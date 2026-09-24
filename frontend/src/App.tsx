import { useCallback, useEffect, useState } from 'react';
import { Home } from './components/Home.tsx';
import { Chat } from './components/Chat.tsx';
import { Dashboard } from './components/Dashboard.tsx';
import { Acciones } from './components/Acciones.tsx';
import { Asistentes } from './components/Asistentes.tsx';
import { Bitacora } from './components/Bitacora.tsx';
import { Prospeccion } from './components/Prospeccion.tsx';
import { Analitica } from './components/Analitica.tsx';
import { Seguimientos } from './components/Seguimientos.tsx';
import { Cotizador } from './components/Cotizador.tsx';
import { Login } from './components/Login.tsx';
import { WhatsApp } from './components/WhatsApp.tsx';
import { NotionPanel } from './components/NotionPanel.tsx';
import { EVENTO_LOGOUT, estadoAuth, logout, resumenHoy } from './api/client.ts';

export type Tab = 'home' | 'chat' | 'dashboard' | 'acciones' | 'asistentes' | 'bitacora' | 'prospeccion' | 'analitica' | 'seguimientos' | 'cotizador' | 'whatsapp' | 'notion';

type Contador = 'tu_ok' | 'whatsapp';

// Agrupado por lo que hace el operador, no por cómo está armado el sistema.
const GRUPOS: Array<{ titulo: string; items: Array<{ id: Tab; label: string; contador?: Contador }> }> = [
    { titulo: 'Hoy', items: [
        { id: 'home', label: 'Inicio' },
        { id: 'acciones', label: 'Para aprobar', contador: 'tu_ok' },
        { id: 'chat', label: 'Chat' },
    ] },
    { titulo: 'Ventas', items: [
        { id: 'cotizador', label: 'Cotizador' },
        { id: 'prospeccion', label: 'Prospección' },
        { id: 'seguimientos', label: 'Clientes y seguimientos' },
    ] },
    { titulo: 'Canales', items: [
        { id: 'whatsapp', label: 'WhatsApp', contador: 'whatsapp' },
        { id: 'notion', label: 'Notion' },
    ] },
    { titulo: 'Sistema', items: [
        { id: 'analitica', label: 'Analítica' },
        { id: 'asistentes', label: 'Asistentes' },
        { id: 'dashboard', label: 'Métricas' },
        { id: 'bitacora', label: 'Bitácora' },
    ] },
];

const TABS_VALIDAS = new Set<string>(GRUPOS.flatMap((g) => g.items.map((i) => i.id)));
type Tema = 'sistema' | 'claro' | 'oscuro';
const ETIQUETA_TEMA: Record<Tema, string> = { sistema: 'Tema: automático', claro: 'Tema: claro', oscuro: 'Tema: oscuro' };

function leer(clave: string): string | null {
    try { return localStorage.getItem(clave); } catch { return null; }
}
function guardar(clave: string, valor: string): void {
    try { localStorage.setItem(clave, valor); } catch { /* sin storage */ }
}

function aplicarTema(t: Tema) {
    const raiz = document.documentElement;
    if (t === 'sistema') delete raiz.dataset.theme;
    else raiz.dataset.theme = t === 'claro' ? 'light' : 'dark';
}

function Marca() {
    return (
        <span className="marca">
            <span className="marca-punto" aria-hidden="true" />
            <span className="marca-nombre">BARTEZ</span>
            <span className="marca-ai">AI</span>
        </span>
    );
}

export function App() {
    const [tab, setTabState] = useState<Tab>(() => {
        const t = leer('bartez_tab');
        return t && TABS_VALIDAS.has(t) ? (t as Tab) : 'home';
    });
    const [tema, setTema] = useState<Tema>(() => (leer('bartez_tema') as Tema) || 'sistema');
    const [menuAbierto, setMenuAbierto] = useState(false);
    const [contadores, setContadores] = useState<Record<Contador, number>>({ tu_ok: 0, whatsapp: 0 });
    // null = verificando; la app no se muestra hasta saber si hace falta login.
    const [auth, setAuth] = useState<{ requerida: boolean; valido: boolean } | null>(null);
    const [errorConexion, setErrorConexion] = useState<string>();

    const setTab = useCallback((t: Tab) => {
        setTabState(t);
        guardar('bartez_tab', t);
        setMenuAbierto(false);
        window.scrollTo(0, 0);
    }, []);

    async function verificar() {
        setErrorConexion(undefined);
        try {
            setAuth(await estadoAuth());
        } catch (e) {
            setErrorConexion((e as Error).message);
        }
    }

    useEffect(() => {
        verificar();
        const alSalir = () => setAuth((a) => (a ? { ...a, valido: false } : a));
        window.addEventListener(EVENTO_LOGOUT, alSalir);
        return () => window.removeEventListener(EVENTO_LOGOUT, alSalir);
    }, []);

    useEffect(() => { aplicarTema(tema); guardar('bartez_tema', tema); }, [tema]);

    const listo = !!auth && (!auth.requerida || auth.valido);
    const cargarContadores = useCallback(async () => {
        try {
            const r = await resumenHoy();
            setContadores({ tu_ok: r.linea.tu_ok, whatsapp: r.foto.whatsapp.sin_responder_en_ventana.length });
        } catch { /* los contadores no son críticos */ }
    }, []);
    useEffect(() => {
        if (!listo) return;
        cargarContadores();
        const t = setInterval(cargarContadores, 60_000);
        return () => clearInterval(t);
    }, [listo, cargarContadores]);
    // Al cambiar de pantalla (por ejemplo, después de aprobar algo) se refrescan.
    useEffect(() => { if (listo) cargarContadores(); }, [tab, listo, cargarContadores]);

    if (errorConexion) {
        return (
            <div className="login-wrap">
                <div className="login">
                    <h1>Bartez AI</h1>
                    <p className="error">No se pudo conectar con el backend ({errorConexion}). Revisá que esté prendido.</p>
                    <button className="primario" onClick={verificar}>Reintentar</button>
                </div>
            </div>
        );
    }
    if (!auth) return null;
    if (auth.requerida && !auth.valido) return <Login onOk={() => setAuth({ requerida: true, valido: true })} />;

    const siguienteTema: Record<Tema, Tema> = { sistema: 'claro', claro: 'oscuro', oscuro: 'sistema' };

    return (
        <div className="shell">
            <div className="barra-movil">
                <Marca />
                <button onClick={() => setMenuAbierto((v) => !v)} aria-expanded={menuAbierto}>
                    Menú{contadores.tu_ok > 0 ? ` · ${contadores.tu_ok}` : ''}
                </button>
            </div>

            <aside className={`lateral ${menuAbierto ? 'abierto' : ''}`} aria-label="Menú principal">
                <Marca />
                <nav>
                    {GRUPOS.map((g) => (
                        <div key={g.titulo} className="nav-grupo">
                            <div className="nav-grupo-titulo">{g.titulo}</div>
                            {g.items.map((it) => {
                                const n = it.contador ? contadores[it.contador] : 0;
                                return (
                                    <button
                                        key={it.id}
                                        className={`nav-item ${tab === it.id ? 'activo' : ''}`}
                                        aria-current={tab === it.id ? 'page' : undefined}
                                        onClick={() => setTab(it.id)}
                                    >
                                        <span>{it.label}</span>
                                        {n > 0 && <span className={`nav-contador ${it.contador === 'tu_ok' ? 'urgente' : ''}`}>{n}</span>}
                                    </button>
                                );
                            })}
                        </div>
                    ))}
                </nav>
                <div className="lateral-pie">
                    <button className="nav-item" onClick={() => setTema(siguienteTema[tema])}>{ETIQUETA_TEMA[tema]}</button>
                    {auth.requerida && <button className="nav-item" onClick={logout}>Salir</button>}
                </div>
            </aside>

            <main className="contenido">
                {tab === 'home' && <Home irA={(t) => setTab(t as Tab)} />}
                {tab === 'chat' && <Chat />}
                {tab === 'acciones' && <Acciones />}
                {tab === 'prospeccion' && <Prospeccion />}
                {tab === 'asistentes' && <Asistentes />}
                {tab === 'dashboard' && <Dashboard />}
                {tab === 'analitica' && <Analitica />}
                {tab === 'seguimientos' && <Seguimientos />}
                {tab === 'cotizador' && <Cotizador />}
                {tab === 'whatsapp' && <WhatsApp />}
                {tab === 'notion' && <NotionPanel />}
                {tab === 'bitacora' && <Bitacora />}
            </main>
        </div>
    );
}
