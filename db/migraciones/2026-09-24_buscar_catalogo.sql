-- Búsqueda del Cotizador (aplicada en Supabase). Normaliza cómo escriben los
-- proveedores (16GB/16G, Ryzen 5/R5, Core i5/Ci5, Wi-Fi, NB = notebook),
-- rankea por palabras del pedido que coinciden y excluye artículos sin precio.

create or replace function norm_cat(t text) returns text
language sql immutable parallel safe as $$
  select regexp_replace(
         regexp_replace(
         regexp_replace(
         regexp_replace(
         regexp_replace(
         regexp_replace(
         regexp_replace(
           translate(lower(coalesce(t,'')), 'áéíóúüñ”“''"', 'aeiouun    '),
           '(\d+)\s*(gb|g)\M', '\1g', 'g'),
           '(\d+)\s*(tb|t)\M', '\1t', 'g'),
           'ryzen\s*(\d)', 'r\1', 'g'),
           '\m(core\s*i?|ci)(\d)\M', 'i\2', 'g'),
           'wi-?fi', 'wifi', 'g'),
           '\mnb\M', 'notebook', 'g'),
           '\s+', ' ', 'g');
$$;

alter table proveedores add column if not exists cursor_sync integer not null default 0;

alter table catalogo_proveedores drop column if exists texto_busqueda;
alter table catalogo_proveedores
  add column texto_busqueda text
  generated always as (norm_cat(descripcion || ' ' || coalesce(marca,'') || ' ' || coalesce(categoria,'') || ' ' || sku)) stored;
create index if not exists catalogo_proveedores_texto_trgm
  on catalogo_proveedores using gin (texto_busqueda gin_trgm_ops);

drop function if exists buscar_catalogo(text, integer, boolean);
create function buscar_catalogo(q text, limite integer default 20, solo_stock boolean default false)
returns table(id bigint, proveedor text, sku text, descripcion text, marca text, categoria text,
              precio numeric, moneda text, iva_pct numeric, stock integer, score real)
language sql stable as $$
  with pedido as (
    select norm_cat(q) as nq,
           array(
             select distinct t from unnest(regexp_split_to_array(norm_cat(q), '[^a-z0-9.]+')) t
             where t <> ''
               and t not in ('de','del','con','para','en','y','el','la','los','las','un','una','x',
                             'pulgadas','pulg','pulgada','puertos','puerto','bocas','boca','equipo','equipos')
           ) as toks
  ),
  pedido2 as (
    select p.*, array(select t from unnest(p.toks) t where t !~ '^[0-9.]+$') as palabras from pedido p
  ),
  cand as (
    select c.*, p.nq,
           (select count(*) from unnest(p.toks) t where c.texto_busqueda like '%' || t || '%')::real
             / greatest(cardinality(p.toks), 1) as frac,
           (cardinality(p.palabras) = 0
             or exists (select 1 from unnest(p.palabras) t where c.texto_busqueda like '%' || t || '%')) as alguna_palabra,
           word_similarity(p.nq, c.texto_busqueda) as ws
    from catalogo_proveedores c
    join proveedores pr on pr.codigo = c.proveedor and pr.activo
    cross join pedido2 p
    where (not solo_stock or coalesce(c.stock, 0) > 0)
      and coalesce(c.precio, 0) > 0 -- sin precio no se puede cotizar
  )
  select id, proveedor, sku, descripcion, marca, categoria, precio, moneda, iva_pct, stock,
         (0.7 * frac + 0.3 * ws)::real as score
  from cand
  where alguna_palabra and (frac >= 0.5 or ws >= 0.5)
  order by score desc, (coalesce(stock, 0) > 0) desc, precio asc nulls last
  limit limite;
$$;
