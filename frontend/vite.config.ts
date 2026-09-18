import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// GitHub Pages sirve el sitio desde /bartez-ai/ cuando se publica desde este repo.
// En dev queda en /.
export default defineConfig(({ command }) => ({
    plugins: [react()],
    base: command === 'build' ? '/bartez-ai/' : '/',
    server: { port: 5173 },
}));
