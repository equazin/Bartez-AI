import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Rutas relativas: sirve igual en GitHub Pages (/Bartez-AI/) que en local.
export default defineConfig(() => ({
    plugins: [react()],
    base: './',
    server: { port: 5173 },
}));
