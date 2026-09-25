-- Permisos mínimos: el backend usa solo la clave de servicio (service_role), así
-- que la clave pública (anon / authenticated) no necesita ningún permiso. Si algún
-- día se crea una tabla sin RLS, igual queda cerrada.

-- Funciones propias: search_path fijo (aviso del asesor de seguridad) y sin
-- ejecución desde la API pública.
alter function public.norm_cat(text) set search_path = public, pg_temp;
alter function public.buscar_catalogo(text, integer, boolean) set search_path = public, pg_temp;
alter function public.asignar_numero_presupuesto(uuid) set search_path = public, pg_temp;

revoke execute on function public.norm_cat(text) from public, anon, authenticated;
revoke execute on function public.buscar_catalogo(text, integer, boolean) from public, anon, authenticated;
revoke execute on function public.asignar_numero_presupuesto(uuid) from public, anon, authenticated;
grant execute on function public.norm_cat(text) to service_role;
grant execute on function public.buscar_catalogo(text, integer, boolean) to service_role;
grant execute on function public.asignar_numero_presupuesto(uuid) to service_role;

-- Tablas y secuencias actuales y futuras: nada para la clave pública.
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public revoke execute on functions from anon, authenticated;
