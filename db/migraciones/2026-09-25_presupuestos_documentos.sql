-- Presupuestos que llegan como documento (PDF hecho fuera del Cotizador): la IA
-- los lee y quedan como una cotización más, así suman a "Cotizado" y se pueden
-- marcar ganados o perdidos y seguir.

-- De dónde salió la cotización: el Cotizador o un documento subido a la ficha.
alter table cotizaciones add column if not exists origen text not null default 'cotizador';
-- Número tal como figura en el documento (ej. "2026-0215"); no usa la numeración del Cotizador.
alter table cotizaciones add column if not exists numero_externo text;

-- Lo que la IA sacó del documento (emisor, N°, fecha, opciones con total, moneda).
alter table cliente_documentos add column if not exists datos jsonb;
-- La cotización que representa este documento (varias versiones pueden apuntar a la misma).
alter table cliente_documentos add column if not exists cotizacion_id uuid references cotizaciones(id) on delete set null;
-- Andrés dijo que este documento no cuente en Cotizado.
alter table cliente_documentos add column if not exists sin_cotizado boolean not null default false;
create index if not exists cliente_documentos_cotizacion_idx on cliente_documentos (cotizacion_id);
