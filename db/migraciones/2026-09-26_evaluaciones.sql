-- Banco de prueba de los asistentes: cada corrida compara dos modelos sobre
-- casos reales (correos aprobados, editados y rechazados) y guarda el resultado.
create table if not exists public.evaluaciones (
    id uuid primary key default gen_random_uuid(),
    creado_en timestamptz not null default now(),
    terminado_en timestamptz,
    estado text not null default 'corriendo' check (estado in ('corriendo','lista','error')),
    modelos jsonb not null default '{}'::jsonb,
    casos int not null default 0,
    hechos int not null default 0,
    resumen jsonb,
    detalle jsonb not null default '[]'::jsonb,
    costo_usd numeric not null default 0,
    error text
);
alter table public.evaluaciones enable row level security;
revoke all on public.evaluaciones from anon, authenticated;
