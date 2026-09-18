-- Bartez AI — Esquema de base de datos (Fase 1)
-- Postgres 15+ / Supabase

-- Extensiones
create extension if not exists "uuid-ossp";
create extension if not exists pgcrypto;

-- ---------- Catálogo de asistentes ----------
create table if not exists asistentes (
    id              uuid primary key default uuid_generate_v4(),
    nombre          text not null unique,
    area            text not null,                    -- correo, notion, seguimientos, whatsapp, prospeccion, ...
    modelo          text not null default 'sonnet',   -- sonnet | haiku
    prompt          text not null,
    autonomia       int not null default 0,           -- 0 = todo requiere aprobación, 100 = full autónomo
    activo          boolean not null default false,
    creado_en       timestamptz not null default now(),
    actualizado_en  timestamptz not null default now()
);

-- ---------- Clientes ----------
create table if not exists clientes (
    id             uuid primary key default uuid_generate_v4(),
    nombre         text not null,
    email          text,
    whatsapp       text,
    origen         text,                              -- manual, prospeccion, entrante
    estado         text not null default 'lead',      -- lead | cliente | inactivo
    metadata       jsonb not null default '{}',
    creado_en      timestamptz not null default now(),
    actualizado_en timestamptz not null default now()
);
create index if not exists clientes_email_idx on clientes(email);
create index if not exists clientes_whatsapp_idx on clientes(whatsapp);

-- ---------- Conversaciones ----------
create table if not exists conversaciones (
    id             uuid primary key default uuid_generate_v4(),
    cliente_id     uuid references clientes(id) on delete cascade,
    asistente_id   uuid references asistentes(id),
    canal          text not null,                     -- correo | whatsapp | panel
    estado         text not null default 'abierta',   -- abierta | cerrada | escalada
    asunto         text,
    creado_en      timestamptz not null default now(),
    actualizado_en timestamptz not null default now()
);
create index if not exists conversaciones_cliente_idx on conversaciones(cliente_id);
create index if not exists conversaciones_estado_idx on conversaciones(estado);

-- ---------- Mensajes ----------
create table if not exists mensajes (
    id                uuid primary key default uuid_generate_v4(),
    conversacion_id   uuid not null references conversaciones(id) on delete cascade,
    remitente         text not null,                  -- cliente | asistente | humano
    texto             text not null,
    metadata          jsonb not null default '{}',    -- id externo del correo, etc.
    creado_en         timestamptz not null default now()
);
create index if not exists mensajes_conv_idx on mensajes(conversacion_id);

-- ---------- Tareas de seguimiento ----------
create table if not exists tareas_seguimiento (
    id              uuid primary key default uuid_generate_v4(),
    cliente_id      uuid references clientes(id) on delete cascade,
    asistente_id    uuid references asistentes(id),
    descripcion     text not null,
    vencimiento     timestamptz,
    estado          text not null default 'pendiente', -- pendiente | hecha | cancelada
    notion_page_id  text,                              -- vínculo opcional a Notion
    creado_en       timestamptz not null default now(),
    actualizado_en  timestamptz not null default now()
);
create index if not exists tareas_estado_idx on tareas_seguimiento(estado, vencimiento);

-- ---------- Acciones pendientes de aprobación (escalamiento humano) ----------
create table if not exists acciones_pendientes (
    id               uuid primary key default uuid_generate_v4(),
    conversacion_id  uuid references conversaciones(id) on delete cascade,
    asistente_id     uuid references asistentes(id),
    accion           text not null,                    -- enviar_correo, mandar_whatsapp, etc.
    payload          jsonb not null,                   -- lo que el asistente propone hacer
    estado           text not null default 'pendiente',-- pendiente | aprobada | rechazada | editada
    respuesta        jsonb,                            -- qué hizo el humano (aprobar, editar, rechazar)
    notificado_en    timestamptz,                      -- cuándo se avisó al humano
    resuelto_en      timestamptz,                      -- cuándo respondió el humano
    creado_en        timestamptz not null default now()
);
create index if not exists acciones_estado_idx on acciones_pendientes(estado);

-- ---------- Bitácora (observabilidad) ----------
create table if not exists logs_asistente (
    id             uuid primary key default uuid_generate_v4(),
    asistente_id   uuid references asistentes(id),
    conversacion_id uuid references conversaciones(id) on delete set null,
    entrada        jsonb,                             -- qué recibió
    salida         jsonb,                             -- qué respondió
    herramienta    text,                              -- si llamó una herramienta, cuál
    tokens_in      int,
    tokens_out     int,
    costo_usd      numeric(10, 6),
    duracion_ms    int,
    error          text,
    creado_en      timestamptz not null default now()
);
create index if not exists logs_asistente_idx on logs_asistente(asistente_id, creado_en desc);
-- Retención: borrar logs > 90 días con cron o política de Supabase

-- ---------- Métricas diarias (snapshot para dashboard) ----------
create table if not exists metricas_diarias (
    fecha           date not null,
    asistente_id    uuid references asistentes(id),
    conversaciones  int not null default 0,
    mensajes        int not null default 0,
    acciones_aprobadas int not null default 0,
    acciones_editadas  int not null default 0,
    acciones_rechazadas int not null default 0,
    tokens_totales  int not null default 0,
    costo_usd_total numeric(10, 4) not null default 0,
    primary key (fecha, asistente_id)
);

-- ---------- Métrica de éxito del negocio (definida por el usuario) ----------
create table if not exists metricas_negocio (
    fecha           date primary key,
    propuestas_enviadas int not null default 0,
    ventas_cerradas int not null default 0,
    prospectos_calificados int not null default 0,
    notas           text
);
