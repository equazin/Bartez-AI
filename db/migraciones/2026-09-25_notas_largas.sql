-- Notas largas (p. ej. una conversación de WhatsApp pegada entera): la IA
-- guarda un resumen, que es lo que reciben los asistentes en cada respuesta.
alter table cliente_notas add column if not exists resumen text;
alter table cliente_notas add column if not exists costo_usd numeric(10, 5);
