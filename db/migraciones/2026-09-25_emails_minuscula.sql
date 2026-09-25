-- Los emails de clientes se buscan exacto y en minúscula (sin LIKE, para que un
-- "%" o "_" de una dirección de afuera no funcione como comodín). Este trigger
-- garantiza el formato venga de donde venga el alta o la edición.
create or replace function public.normalizar_email_cliente() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
    if new.email is not null then
        new.email := nullif(lower(trim(new.email)), '');
    end if;
    return new;
end $$;

revoke execute on function public.normalizar_email_cliente() from public, anon, authenticated;

drop trigger if exists clientes_email_minuscula on public.clientes;
create trigger clientes_email_minuscula before insert or update of email on public.clientes
    for each row execute function public.normalizar_email_cliente();
