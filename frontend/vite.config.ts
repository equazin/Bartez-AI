import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// Política de seguridad del sitio publicado: solo corre el JavaScript propio del
// panel. Un script inyectado o un link "javascript:" no se ejecutan, así que no
// pueden leer el token de la sesión. Solo en el build: el modo dev de Vite usa
// scripts en línea.
const politicaDeSeguridad: Plugin = {
    name: 'politica-de-seguridad',
    apply: 'build',
    transformIndexHtml: (html) => html.replace(
        '<head>',
        `<head>\n        <meta http-equiv="Content-Security-Policy" content="script-src 'self'; base-uri 'self'; form-action 'self'" />`,
    ),
};

// Rutas relativas: sirve igual en GitHub Pages (/Bartez-AI/) que en local.
export default defineConfig(() => ({
    plugins: [react(), politicaDeSeguridad],
    base: './',
    server: { port: 5173 },
}));
