-- Asistente de Publicidad, fase 1 (solo mirar): mapa de la web, métricas de
-- Google Ads y búsquedas reales. Sin permisos para la clave pública.

-- Cada página de bartez.com.ar (del sitemap) con lo que se lee de ella.
create table if not exists public.web_paginas (
    url text primary key,
    ruta text not null,
    tipo text not null default 'otra',
    anunciable boolean not null default false,
    estado_http int,
    titulo text,
    descripcion text,
    h1 text,
    subtitulos jsonb not null default '[]'::jsonb,
    items jsonb not null default '[]'::jsonb,
    faq jsonb not null default '[]'::jsonb,
    texto text,
    huella text,
    ficha jsonb,
    ficha_huella text,
    en_sitemap boolean not null default true,
    leida_en timestamptz,
    cambio_en timestamptz,
    creada_en timestamptz not null default now()
);

-- Configuración del asistente (una sola fila).
create table if not exists public.ads_config (
    id int primary key default 1 check (id = 1),
    tope_mensual_ars numeric,
    zona text,
    modo text not null default 'solo_lectura' check (modo in ('solo_lectura', 'propone', 'automatico_limitado')),
    actualizado_en timestamptz not null default now()
);
insert into public.ads_config (id) values (1) on conflict do nothing;

-- Métricas diarias por campaña.
create table if not exists public.ads_metricas_diarias (
    fecha date not null,
    campania_id text not null,
    campania text,
    estado text,
    presupuesto_diario numeric,
    impresiones bigint not null default 0,
    clics bigint not null default 0,
    costo numeric not null default 0,
    conversiones numeric not null default 0,
    valor_conversiones numeric not null default 0,
    actualizado_en timestamptz not null default now(),
    primary key (fecha, campania_id)
);

-- Métricas diarias por página de destino (para cruzar con la web).
create table if not exists public.ads_paginas_diarias (
    fecha date not null,
    url text not null,
    impresiones bigint not null default 0,
    clics bigint not null default 0,
    costo numeric not null default 0,
    conversiones numeric not null default 0,
    actualizado_en timestamptz not null default now(),
    primary key (fecha, url)
);

-- Lo que la gente buscó en Google antes de ver el anuncio.
create table if not exists public.ads_busquedas (
    fecha date not null,
    termino text not null,
    campania text not null default '',
    grupo text not null default '',
    impresiones bigint not null default 0,
    clics bigint not null default 0,
    costo numeric not null default 0,
    conversiones numeric not null default 0,
    decision text,
    motivo text,
    actualizado_en timestamptz not null default now(),
    primary key (fecha, termino, campania, grupo)
);

alter table public.web_paginas enable row level security;
alter table public.ads_config enable row level security;
alter table public.ads_metricas_diarias enable row level security;
alter table public.ads_paginas_diarias enable row level security;
alter table public.ads_busquedas enable row level security;
revoke all on public.web_paginas, public.ads_config, public.ads_metricas_diarias, public.ads_paginas_diarias, public.ads_busquedas from anon, authenticated;
