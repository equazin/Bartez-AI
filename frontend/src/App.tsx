import { useState } from 'react';
import { Chat } from './components/Chat.tsx';
import { Dashboard } from './components/Dashboard.tsx';
import { Acciones } from './components/Acciones.tsx';
import { Asistentes } from './components/Asistentes.tsx';

type Tab = 'chat' | 'dashboard' | 'acciones' | 'asistentes';

const TABS: { id: Tab; label: string }[] = [
    { id: 'chat', label: 'Chat' },
    { id: 'acciones', label: 'Acciones' },
    { id: 'asistentes', label: 'Asistentes' },
    { id: 'dashboard', label: 'Dashboard' },
];

export function App() {
    const [tab, setTab] = useState<Tab>('chat');

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
                {tab === 'chat' && <Chat />}
                {tab === 'acciones' && <Acciones />}
                {tab === 'asistentes' && <Asistentes />}
                {tab === 'dashboard' && <Dashboard />}
            </main>
        </div>
    );
}
