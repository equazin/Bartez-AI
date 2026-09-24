import { FormEvent, useState } from 'react';
import { BACKEND_ES_DEMO, BACKEND_URL, login } from '../api/client.ts';

export function Login({ onOk }: { onOk: () => void }) {
    const [password, setPassword] = useState('');
    const [error, setError] = useState<string>();
    const [enviando, setEnviando] = useState(false);

    async function entrar(e: FormEvent) {
        e.preventDefault();
        if (!password) return;
        setEnviando(true);
        setError(undefined);
        try {
            await login(password);
            onOk();
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setEnviando(false);
        }
    }

    return (
        <div className="login-wrap">
            <form className="login" onSubmit={entrar}>
                <h1>Bartez AI</h1>
                <p className="sub">Ingresá la contraseña del panel.</p>
                {BACKEND_ES_DEMO && <p className="sub">Conectando a <code>{new URL(BACKEND_URL).host}</code></p>}
                <input
                    type="password"
                    autoFocus
                    autoComplete="current-password"
                    placeholder="Contraseña"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                />
                {error && <p className="error">{error}</p>}
                <button className="primario" type="submit" disabled={enviando || !password}>
                    {enviando ? 'Entrando…' : 'Entrar'}
                </button>
            </form>
        </div>
    );
}
