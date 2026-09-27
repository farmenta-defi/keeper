import { Pool } from 'pg';
import type { PrimaryStore } from './types.js';

export class PostgresPrimaryStore implements PrimaryStore {
  private readonly pool: Pool;
  constructor(databaseUrl: string) {
    // Bounded so a stuck database cannot hold the cron's flock past the next five-minute run.
    this.pool = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000, query_timeout: 10_000 });
  }

  async close() { await this.pool.end(); }

  async saveRun(run: { ranAt: number; poolCount: number; gasUsed: bigint; gasCostUsd: number; budgetUsd: number; transactionHash: string }) {
    await this.pool.query(
      'insert into backend.keeper_record_batch_run (ran_at, pool_count, gas_used, gas_cost_usd, budget_usd, transaction_hash) values (to_timestamp($1), $2, $3, $4, $5, $6)',
      [run.ranAt, run.poolCount, run.gasUsed.toString(), run.gasCostUsd, run.budgetUsd, run.transactionHash],
    );
  }

  async dailyTotals() {
    const result = await this.pool.query<{ cost: string; budget: string }>(
      "select coalesce(sum(gas_cost_usd), 0) as cost, coalesce(sum(budget_usd), 0) as budget from backend.keeper_record_batch_run where ran_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc'",
    );
    return { costUsd: Number(result.rows[0].cost), budgetUsd: Number(result.rows[0].budget) };
  }

  async claimAlert(key: string, at: number, reminderSeconds: number) {
    const result = await this.pool.query(
      'insert into backend.keeper_alert (alert_key, sent_at) values ($1, to_timestamp($2)) on conflict (alert_key) do update set sent_at = excluded.sent_at where backend.keeper_alert.sent_at < to_timestamp($2 - $3) returning alert_key',
      [key, at, reminderSeconds],
    );
    return result.rowCount === 1;
  }

  async releaseAlert(key: string) { await this.pool.query('delete from backend.keeper_alert where alert_key = $1', [key]); }

  async heartbeat(at: number) {
    await this.pool.query(
      "insert into backend.service_heartbeat (service, observed_at, details) values ('keeper-record-batch', to_timestamp($1), '{}'::jsonb) on conflict (service) do update set observed_at = excluded.observed_at, details = excluded.details",
      [at],
    );
  }
}
