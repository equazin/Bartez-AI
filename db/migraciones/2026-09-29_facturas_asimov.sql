-- Asistente Facturador: facturas que Bartez AI prepara y manda a Asimov como
-- borrador. El CAE lo pide Asimov (con el certificado de la PC); acá se sigue
-- el estado leyendo la sincronización de Asimov.
create table if not exists public.facturas_asimov (
    id uuid primary key,                      -- es también el id del documento en Asimov
    estado text not null default 'preparada'
        check (estado in ('preparada', 'enviada', 'autorizada', 'rechazada', 'descartada')),
    cliente_id uuid references public.clientes(id) on delete set null,
    cliente_asimov_id text,
    razon_social text not null,
    cuit text,
    condicion_iva text,
    tipo text not null,                       -- A o B
    moneda text not null default 'ARS',       -- moneda en la que se pidieron los precios
    cotizacion_usd numeric,
    neto numeric not null,                    -- siempre en pesos, como Asimov
    iva numeric not null,
    total numeric not null,
    renglones jsonb not null,
    avisos jsonb not null default '[]'::jsonb,
    observaciones text,
    cotizacion_id uuid references public.cotizaciones(id) on delete set null,
    pedido text,                              -- lo que se pidió en el chat
    numero text,                              -- el definitivo, cuando Asimov la autoriza
    cae text,
    cae_vto text,
    error_arca text,
    enviada_en timestamptz,
    creado_en timestamptz not null default now(),
    actualizado_en timestamptz not null default now()
);
create index if not exists facturas_asimov_estado on public.facturas_asimov (estado, creado_en desc);
alter table public.facturas_asimov enable row level security;
