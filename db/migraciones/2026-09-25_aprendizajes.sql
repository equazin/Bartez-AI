-- Aprendizaje de correcciones: cada rechazo (con motivo opcional) y cada
-- edición de una propuesta queda registrado; periódicamente se destilan en
-- lecciones por asistente que se suman a su prompt.

create table if not exists aprendizajes (
    id uuid primary key default gen_random_uuid(),
    asistente_id uuid references asistentes(id) on delete cascade,
    accion_id uuid references acciones_pendientes(id) on delete set null,
    tipo text not null check (tipo in ('rechazo', 'edicion')),
    canal text,
    situacion text,
    propuesto text,
    corregido text,
    motivo text,
    destilado boolean not null default false,
    creado_en timestamptz not null default now()
);
create index if not exists aprendizajes_asistente_idx on aprendizajes (asistente_id, creado_en desc);
create index if not exists aprendizajes_pendientes_idx on aprendizajes (asistente_id) where not destilado;

alter table asistentes add column if not exists lecciones text;
alter table asistentes add column if not exists lecciones_en timestamptz;

alter table aprendizajes enable row level security;
