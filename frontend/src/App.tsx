import { useState } from 'react';
import { Home } from './components/Home.tsx';
import { Chat } from './components/Chat.tsx';
import { Dashboard } from './components/Dashboard.tsx';
import { Acciones } from './components/Acciones.tsx';
import { Asistentes } from './components/Asistentes.tsx';
import { Bitacora } from './components/Bitacora.tsx';
import { Prospeccion } from './components/Prospeccion.tsx';
import { Analitica } from './components/Analitica.tsx';

type Tab = 'home' | 'chat' | 'dashboard' | 'acciones' | 'asistentes' | 'bitacora' | 'prospeccion' | 'analitica';

const TABS: { id: Tab; label: string }[] = [
    { id: 'home', label: 'Inicio' },
    { id: 'chat', label: 'Chat' },
    { id: 'acciones', label: 'Acciones' },
    { id: 'prospeccion', label: 'Prospección' },
    { id: 'asistentes', label: 'Asistentes' },
    { id: 'dashboard', label: 'Dashboard' },
    { id: 'analitica', label: 'Analítica' },
    { id: 'bitacora', label: 'Bitácora' },
];

export function App() {
    const [tab, setTab] = useState<Tab>('home');

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
                {tab === 'bitacora' && <Bitacora />}
            </main>
        </div>
    );
}
