\set ON_ERROR_STOP on
-- Run as a PostgreSQL superuser on database farmenta, after `bun run db:migrate`, then set the
-- password interactively: psql -U postgres -c '\password farmenta_keeper'
-- The keeper may only write its own tables and heartbeat; it cannot read or change indexer or
-- other backend data.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'farmenta_keeper') then
    create role farmenta_keeper login noinherit;
  end if;
end
$$;
grant connect on database farmenta to farmenta_keeper;
grant usage on schema backend to farmenta_keeper;
grant select, insert on backend.keeper_record_batch_run to farmenta_keeper;
grant usage on sequence backend.keeper_record_batch_run_id_seq to farmenta_keeper;
grant select, insert, update, delete on backend.keeper_alert to farmenta_keeper;
grant select, insert, update on backend.service_heartbeat to farmenta_keeper;
