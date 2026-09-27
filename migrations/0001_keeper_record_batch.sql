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
