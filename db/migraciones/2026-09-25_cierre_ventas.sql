-- Ciclo de venta de cada presupuesto: abierta (recién cotizada) → enviada
-- (se le asignó número / salió el PDF) → ganada o perdida (con motivo).

alter table cotizaciones add column if not exists estado text not null default 'abierta'
    check (estado in ('abierta', 'enviada', 'ganada', 'perdida'));
alter table cotizaciones add column if not exists enviada_en timestamptz;
alter table cotizaciones add column if not exists cerrada_en timestamptz;
alter table cotizaciones add column if not exists motivo_cierre text;

-- Las que ya tienen número se consideran enviadas.
update cotizaciones set estado = 'enviada', enviada_en = coalesce(enviada_en, creado_en)
where numero is not null and estado = 'abierta';

create index if not exists cotizaciones_estado_idx on cotizaciones (estado, enviada_en);

-- Cuándo se propuso el seguimiento automático de un presupuesto enviado
-- (uno por presupuesto, para no insistir de más).
alter table cotizaciones add column if not exists seguimiento_en timestamptz;
