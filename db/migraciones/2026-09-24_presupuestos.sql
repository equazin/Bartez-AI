-- Historial y PDF de presupuestos (aplicada en Supabase).
alter table cotizaciones add column if not exists titulo text;
alter table cotizaciones add column if not exists resultado jsonb;
create index if not exists cotizaciones_creado_idx on cotizaciones (creado_en desc);

-- Numeración correlativa (sigue después del N 2026-0214 hecho a mano).
create sequence if not exists presupuesto_numero_seq start 215;
alter table cotizaciones add column if not exists numero integer unique;
alter table cotizaciones add column if not exists datos_cliente jsonb not null default '{}'::jsonb;

create or replace function asignar_numero_presupuesto(p_id uuid) returns integer
language plpgsql as $$
declare n integer;
begin
  update cotizaciones set numero = coalesce(numero, nextval('presupuesto_numero_seq'))
  where id = p_id returning numero into n;
  return n;
end $$;
