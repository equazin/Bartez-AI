-- Memoria por cliente: informes guardados (con historial), notas del operador
-- y documentos (PDF, fotos, Excel, Word) que la IA lee y resume. Todo esto se
-- suma al contexto de los asistentes cuando atienden a ese cliente.

create table if not exists cliente_informes (
    id uuid primary key default gen_random_uuid(),
    cliente_id uuid not null references clientes(id) on delete cascade,
    resumen_md text not null,
    origen text not null default 'manual' check (origen in ('manual', 'automatico')),
    -- Informe del que partió (null = el primero, hecho desde cero)
    base_id uuid references cliente_informes(id) on delete set null,
    tokens_in integer, tokens_out integer, costo_usd numeric(10, 5),
    creado_en timestamptz not null default now()
);
create index if not exists cliente_informes_cliente_idx on cliente_informes (cliente_id, creado_en desc);

create table if not exists cliente_notas (
    id uuid primary key default gen_random_uuid(),
    cliente_id uuid not null references clientes(id) on delete cascade,
    texto text not null,
    creado_en timestamptz not null default now()
);
create index if not exists cliente_notas_cliente_idx on cliente_notas (cliente_id, creado_en desc);

create table if not exists cliente_documentos (
    id uuid primary key default gen_random_uuid(),
    cliente_id uuid not null references clientes(id) on delete cascade,
    nombre text not null,
    tipo_mime text,
    tamano_bytes integer,
    ruta text not null,               -- ruta en el bucket documentos-clientes
    estado text not null default 'procesando' check (estado in ('procesando', 'listo', 'error')),
    tipo_documento text,              -- lo que la IA reconoció: presupuesto, orden de compra, etc.
    resumen text,                     -- resumen en markdown para los asistentes
    error text,
    costo_usd numeric(10, 5),
    creado_en timestamptz not null default now(),
    procesado_en timestamptz
);
create index if not exists cliente_documentos_cliente_idx on cliente_documentos (cliente_id, creado_en desc);

alter table cliente_informes enable row level security;
alter table cliente_notas enable row level security;
alter table cliente_documentos enable row level security;

-- Bucket privado para los archivos (solo el backend, con la service role).
insert into storage.buckets (id, name, public, file_size_limit)
values ('documentos-clientes', 'documentos-clientes', false, 15728640)
on conflict (id) do nothing;
