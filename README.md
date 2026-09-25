# Bartez AI

Sistema interno multi-agente para gestión del negocio. Panel único con chat + dashboard, conectado a Notion, Gmail y (a futuro) WhatsApp, con un orquestador que reparte tareas entre asistentes especializados.

**Plan completo del sistema**: [Bartez AI — Plan del sistema multi-agente](https://claude.ai/code/artifact/22edc8c7-fec7-4c94-9660-cee55acc111a)

## Estado

**Fase 1 en construcción** — panel base + asistente de Correo + asistente de Notion + orquestador mínimo + bitácora.

Asistentes activos previstos al arranque: Correo, Notion, Seguimientos, WhatsApp, Prospección, Analítica.
Dormidos (framework listo, no encendidos): Facturación, Cobranzas, Compras, Inventario, Contenido, RR.HH., Legal, Calendario, Base de conocimiento, IT interno, Redes.

## Estructura

```
bartez-ai/
├── db/               Esquema Postgres (Supabase)
├── backend/          API + orquestador + asistentes (Node + TypeScript)
│   ├── src/
│   │   ├── orchestrator/    Catálogo de asistentes y router
│   │   ├── assistants/      Implementación de cada asistente
│   │   ├── connectors/      Wrappers de APIs externas (Anthropic, Gmail, Notion, Supabase)
│   │   ├── logging/         Bitácora (observabilidad)
│   │   └── escalation/      Escalamiento a humano por correo
└── frontend/         Panel web (React + Vite) — se publica en GitHub Pages
    └── src/
        ├── components/  Chat, Dashboard, MétricaÉxito
        └── api/         Cliente HTTP al backend
```

## Puesta en marcha (local)

Requiere Node ≥ 20.

```bash
# Backend
cd backend
cp .env.example .env      # llenar keys
npm install
npm run dev

# Frontend (en otra terminal)
cd frontend
npm install
npm run dev
```

## Deploy

- **Panel:** GitHub Pages, automático en cada push a `main` (`.github/workflows/pages.yml`).
- **Backend:** Railway. Guía paso a paso en [`docs/DEPLOY-RAILWAY.md`](docs/DEPLOY-RAILWAY.md).

## Servicios necesarios

Cada uno debe crearse a mano y sus credenciales van en `backend/.env`:

| Servicio | Para qué | Cómo obtener |
| --- | --- | --- |
| Supabase (Pro) | Base de datos + auth | Crear proyecto, copiar URL + service role key |
| Anthropic API | LLM (Claude Sonnet + Haiku) | Console de Anthropic, crear API key |
| Gmail API | Asistente de Correo | Google Cloud Console, OAuth 2.0 |
| Notion API | Asistente de Notion | Notion integration + share databases |

Costo mensual estimado con Fase 1 andando: **~USD 45–65** (ver plan).

## Convenciones de commits

Todo el trabajo va a `claude/bartez-fase-1` hasta que se decida mergear a `main`.
