-- Protección (RLS) en todas las tablas. Nadie las usa con la clave pública:
-- solo el backend, con la clave de servicio, que no pasa por RLS. Sin
-- políticas, la clave pública (anon) no puede leer ni escribir nada.
-- Para volver atrás en una tabla: alter table <tabla> disable row level security;
alter table acciones_pendientes enable row level security;
alter table asistentes enable row level security;
alter table catalogo_proveedores enable row level security;
alter table clientes enable row level security;
alter table conversaciones enable row level security;
alter table correos_historicos enable row level security;
alter table cotizaciones enable row level security;
alter table integraciones_config enable row level security;
alter table jobs_import_correos enable row level security;
alter table logs_asistente enable row level security;
alter table mensajes enable row level security;
alter table metricas_diarias enable row level security;
alter table metricas_negocio enable row level security;
alter table notion_cambios enable row level security;
alter table proveedores enable row level security;
alter table reportes_analitica enable row level security;
alter table tareas_seguimiento enable row level security;
alter table wa_conversaciones enable row level security;
alter table wa_mensajes enable row level security;
