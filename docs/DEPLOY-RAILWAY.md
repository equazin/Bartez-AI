# Subir el backend a Railway

Hoy el backend corre en tu PC: si la PC se apaga, el panel en
`equazin.github.io/Bartez-AI` deja de andar, no se leen los correos nuevos y no
corren los automáticos (WhatsApp cada 2 min, Notion, proveedores, seguimientos,
lecciones). En Railway queda prendido todo el día.

El repositorio ya está preparado (`backend/railway.json`): arranca con
`npm start`, Railway revisa `/health` para saber si está vivo y lo reinicia si
se cae. Lo que falta son los pasos de la cuenta, que tenés que hacer vos.

## Costo

Plan **Hobby: USD 5 por mes**, que incluye USD 5 de uso. Este backend es
chico (una sola instancia, poca memoria), así que en general entra en esos
USD 5. Railway muestra el consumo en tiempo real en **Usage**.

## Pasos

### 1. Crear el servicio

1. Entrá a [railway.com](https://railway.com) con tu cuenta de GitHub.
2. **New Project → Deploy from GitHub repo →** elegí `equazin/Bartez-AI`.
   Si no aparece, tocá *Configure GitHub App* y dale acceso a ese repo.
3. Entrá al servicio que se creó → **Settings**:
   - **Root Directory:** `backend`
   - **Branch:** `main`
   - Dejá **1 réplica**. Con más de una, los automáticos correrían dos veces
     (y responderían dos veces el mismo correo).

### 2. Cargar las variables

En el servicio → **Variables → Raw Editor**, pegá el contenido de tu
`backend/.env` **desde tu PC** (no lo mandes por chat ni lo subas al repo).
Después revisá estas tres:

| Variable | Qué poner |
| --- | --- |
| `PANEL_PASSWORD` | Obligatoria. Sin ella el backend no arranca en Railway. |
| `AUTH_SECRET` | Un texto largo al azar (por ejemplo, 40 letras y números). |
| `PORT` | Borrala: Railway la pone solo. |

`FRONTEND_ORIGINS` puede quedar vacía: `https://equazin.github.io` ya está
permitido.

### 3. Darle una dirección

Servicio → **Settings → Networking → Generate Domain**. Te da algo como
`https://bartez-ai-production.up.railway.app`. Abrí
`https://…up.railway.app/health` en el navegador: tiene que decir
`{"ok":true}`.

En **Deploy Logs** tenés que ver que se conectó al correo (IMAP) y que se
programaron los automáticos. Si dice que falta una variable, agregala y se
redespliega solo.

### 4. Apuntar el panel al backend nuevo

1. En GitHub: repo `equazin/Bartez-AI` → **Settings → Secrets and
   variables → Actions → pestaña Variables → New repository variable**:
   - Nombre: `VITE_BACKEND_URL`
   - Valor: la dirección del paso 3, **sin** barra al final.
2. **Actions → "Deploy frontend a GitHub Pages" → Run workflow** (rama `main`).
3. Cuando termine, abrí el panel: te va a pedir la contraseña
   (`PANEL_PASSWORD`).

### 5. Apagar el backend de tu PC

**Importante:** una vez que Railway anda, cerrá el backend local. Si quedan
los dos prendidos, los dos leen la misma casilla y los mismos WhatsApp, y
proponen todo por duplicado. Para probar cambios en tu PC sin molestar a
Railway, abrí el panel local con `?backend=local`.

## Actualizaciones

Cada vez que se sube un cambio a `main`, Railway redespliega solo el backend
(y GitHub Pages el panel). No hay que hacer nada más.

## Si algo falla

- **Crash con "native WebSocket not found":** Railway levantó Node 20. El
  backend necesita Node 22 (lo pide `backend/package.json` y
  `backend/.node-version`); volvé a desplegar el último commit de `main`.
- **"SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY sin definir":** faltan las
  variables del paso 2. Pegá tu `backend/.env` en **Variables → Raw Editor**.

- **El panel dice "Failed to fetch":** revisá que `VITE_BACKEND_URL` no
  tenga barra al final y que `/health` responda. Si cambiaste la dirección de
  Railway, volvé a correr el workflow del paso 4.
- **"No se pudo conectar con el backend" solo en tu navegador:** puede haber
  quedado guardado un túnel viejo; entrá una vez con `?backend=local` para
  borrarlo.
- **El backend se reinicia seguido:** mirá **Deploy Logs**; casi siempre es
  una variable mal copiada (por ejemplo, la clave de Supabase cortada).


## Correos salientes: Resend (Railway Hobby bloquea el SMTP)

Railway solo permite SMTP en el plan Pro. En Hobby, los correos que aprobás
fallan con "No se pudo conectar al servidor de correo" y quedan en *Para aprobar*
para reintentar. Para enviarlos por HTTPS:

1. En [resend.com](https://resend.com) → **Domains**: `bartez.com.ar` tiene que
   figurar como **Verified** (los registros DNS ya están cargados en Hostmar:
   `resend._domainkey`, y `send` con MX y SPF).
2. **API Keys** → *Create API Key* → permiso **Sending access**, dominio
   `bartez.com.ar`. Copiala (se muestra una sola vez).
3. En Railway → servicio → **Variables**: `RESEND_API_KEY` = la clave. Opcional:
   `CORREO_REMITENTE` = `Bartez Tecnología <ventas@bartez.com.ar>`. Aplicá el
   cambio (Deploy).
4. En el panel → *Para aprobar* → **Reintentar** en los envíos que no salieron.

La lectura de correos sigue por IMAP (Ferozo) y cada enviado se guarda también
en la carpeta Enviados de la casilla. Plan gratis de Resend: 3.000 correos por
mes, 100 por día.
