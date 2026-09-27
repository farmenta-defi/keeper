-- Also created by the backend repository's 0000 migration, with the same definition, so either
-- repository may be migrated first on a fresh database.
create schema if not exists backend;

create table if not exists backend.service_heartbeat (
  service text primary key,
  observed_at timestamptz not null default now(),
  details jsonb not null default '{}'::jsonb
);

create table if not exists backend.keeper_record_batch_run (
  id bigserial primary key,
  ran_at timestamptz not null,
  pool_count integer not null,
  gas_used numeric(78, 0) not null,
  gas_cost_usd numeric(20, 8) not null,
  budget_usd numeric(20, 8) not null,
  transaction_hash text not null unique
);

create index if not exists keeper_record_batch_run_ran_at_idx
  on backend.keeper_record_batch_run (ran_at);

create table if not exists backend.keeper_alert (
  alert_key text primary key,
  sent_at timestamptz not null
);
