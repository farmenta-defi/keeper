import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Client } from 'pg';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
if (new URL(databaseUrl).pathname !== '/farmenta') {
  throw new Error('DATABASE_URL must target the farmenta database');
}

const client = new Client({ connectionString: databaseUrl });
await client.connect();
// Own history table: the backend repository records its migrations in backend_migrations by
// file name, and sharing it would let a same-named file in either repository skip the other.
// Not `create schema if not exists`: that checks CREATE on the database before it looks for the
// schema, and on the VPS the schema owner does not have that privilege.
await client.query("do $$ begin if not exists (select 1 from pg_namespace where nspname = 'backend') then create schema backend; end if; end $$");
await client.query('create table if not exists backend.keeper_migrations (name text primary key, applied_at timestamptz not null default now())');
for (const name of (await readdir('migrations')).filter((file) => file.endsWith('.sql')).sort()) {
  const applied = await client.query('select 1 from backend.keeper_migrations where name = $1', [name]);
  if (applied.rowCount) continue;
  await client.query('begin');
  try {
    await client.query(await readFile(join('migrations', name), 'utf8'));
    await client.query('insert into backend.keeper_migrations (name) values ($1)', [name]);
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  }
}
await client.end();
