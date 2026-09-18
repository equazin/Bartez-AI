import { useState } from 'react';
import { Chat } from './components/Chat.tsx';
import { Dashboard } from './components/Dashboard.tsx';

export function App() {
    const [tab, setTab] = useState<'chat' | 'dashboard'>('chat');

    return (
        <div className="app">
            <header>
                <h1>Bartez AI</h1>
                <nav>
                    <button
                        className={tab === 'chat' ? 'activo' : ''}
                        onClick={() => setTab('chat')}
                    >
                        Chat
                    </button>
                    <button
                        className={tab === 'dashboard' ? 'activo' : ''}
                        onClick={() => setTab('dashboard')}
                    >
                        Dashboard
                    </button>
                </nav>
            </header>
            <main>{tab === 'chat' ? <Chat /> : <Dashboard />}</main>
        </div>
    );
}
