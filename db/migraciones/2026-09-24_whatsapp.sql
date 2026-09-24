-- WhatsApp vía el bot de bartez.com.ar (aplicada en Supabase).
create table if not exists wa_conversaciones (
  wa_id               text primary key,
  studio_id           text,
  nombre              text,
  estado              text,
  categoria           text,
  cliente_id          uuid references clientes(id) on delete set null,
  actualizado_en      timestamptz,
  ultimo_entrante_en  timestamptz,
  ultimo_mensaje      text,
  ultimo_direccion    text,
  borrador_para_msg   text,
  sincronizado_en     timestamptz default now()
);
create index if not exists wa_conv_act_idx on wa_conversaciones (actualizado_en desc);
create index if not exists wa_conv_cliente_idx on wa_conversaciones (cliente_id);

create table if not exists wa_mensajes (
  id            text primary key,
  wa_id         text not null references wa_conversaciones(wa_id) on delete cascade,
  wa_message_id text,
  direccion     text not null,
  origen        text,
  tipo          text,
  cuerpo        text,
  creado_en     timestamptz not null
);
create index if not exists wa_msg_conv_idx on wa_mensajes (wa_id, creado_en);

insert into asistentes (nombre, area, modelo, prompt, autonomia, activo)
select 'WhatsApp', 'whatsapp', 'sonnet', '', 0, true
where not exists (select 1 from asistentes where area = 'whatsapp');
