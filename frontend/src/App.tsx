import { useEffect, useState } from 'react';
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
import { EVENTO_LOGOUT, estadoAuth, logout } from './api/client.ts';

type Tab = 'home' | 'chat' | 'dashboard' | 'acciones' | 'asistentes' | 'bitacora' | 'prospeccion' | 'analitica' | 'seguimientos' | 'cotizador' | 'whatsapp';

const TABS: { id: Tab; label: string }[] = [
    { id: 'home', label: 'Inicio' },
    { id: 'chat', label: 'Chat' },
    { id: 'acciones', label: 'Acciones' },
    { id: 'prospeccion', label: 'Prospección' },
    { id: 'seguimientos', label: 'Seguimientos' },
    { id: 'whatsapp', label: 'WhatsApp' },
    { id: 'cotizador', label: 'Cotizador' },
    { id: 'asistentes', label: 'Asistentes' },
    { id: 'dashboard', label: 'Dashboard' },
    { id: 'analitica', label: 'Analítica' },
    { id: 'bitacora', label: 'Bitácora' },
];

export function App() {
    const [tab, setTab] = useState<Tab>('home');
    // null = verificando; la app no se muestra hasta saber si hace falta login.
    const [auth, setAuth] = useState<{ requerida: boolean; valido: boolean } | null>(null);
    const [errorConexion, setErrorConexion] = useState<string>();

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

    if (errorConexion) {
        return (
            <div className="login-wrap">
                <div className="login">
                    <h1>Bartez AI</h1>
                    <p className="error">No se pudo conectar con el backend ({errorConexion}).</p>
                    <button className="primario" onClick={verificar}>Reintentar</button>
                </div>
            </div>
        );
    }
    if (!auth) return null;
    if (auth.requerida && !auth.valido) return <Login onOk={() => setAuth({ requerida: true, valido: true })} />;

    return (
        <div className="app">
            <header>
                <h1>Bartez AI</h1>
                <nav>
                    {TABS.map((t) => (
                        <button
                            key={t.id}
                            className={tab === t.id ? 'activo' : ''}
                            onClick={() => setTab(t.id)}
                        >
                            {t.label}
                        </button>
                    ))}
                    {auth.requerida && <button className="salir" onClick={logout}>Salir</button>}
                </nav>
            </header>
            <main>
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
                {tab === 'bitacora' && <Bitacora />}
            </main>
        </div>
    );
}
