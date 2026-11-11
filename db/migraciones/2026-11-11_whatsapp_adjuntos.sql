-- Archivos que Bartez AI manda por WhatsApp (presupuestos, documentos de la
-- ficha del cliente, archivos subidos desde la compu). Quedan guardados para
-- abrirlos desde el chat y, mientras la web no mande adjuntos, para el link
-- (/d/<token>) que recibe el cliente.
create table if not exists public.wa_adjuntos (
    id uuid primary key default gen_random_uuid(),
    wa_id text not null references public.wa_conversaciones(wa_id) on delete cascade,
    mensaje_id text,                          -- id del mensaje en la web (= wa_mensajes.id)
    token text not null unique,               -- link público
    nombre text not null,
    tipo_mime text not null,
    tamano_bytes integer not null,
    ruta text not null,                       -- en el bucket whatsapp-adjuntos
    origen text not null check (origen in ('cotizacion', 'documento', 'archivo', 'proforma')),
    origen_id text,
    texto text,                               -- lo que acompañó al archivo
    enviado_como text check (enviado_como in ('adjunto', 'link')),
    creado_en timestamptz not null default now(),
    vence_en timestamptz not null default now() + interval '120 days'
);
create index if not exists wa_adjuntos_conv on public.wa_adjuntos (wa_id, creado_en desc);
create index if not exists wa_adjuntos_mensaje on public.wa_adjuntos (mensaje_id) where mensaje_id is not null;
alter table public.wa_adjuntos enable row level security;

-- Bucket privado (solo el backend, con la service role).
insert into storage.buckets (id, name, public, file_size_limit)
values ('whatsapp-adjuntos', 'whatsapp-adjuntos', false, 20971520)
on conflict (id) do nothing;
