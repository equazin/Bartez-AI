-- Registro de lo que el asistente de Notion crea, modifica o archiva por su cuenta (aplicada en Supabase).
create table if not exists notion_cambios (
  id          bigint generated always as identity primary key,
  creado_en   timestamptz not null default now(),
  origen      text not null default 'curador',
  tipo        text not null,
  detalle     text not null,
  pagina_id   text,
  corrida_id  text
);
create index if not exists notion_cambios_creado_idx on notion_cambios (creado_en desc);
