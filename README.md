# Farmenta keeper

The keeper keeps meme-pool TWAP observations fresh. It is a separate operational repository so
wallet credentials are not available to API workflows. The source of truth is
[`ARCHITECTURE.md` §5.3 and §13](https://github.com/farmenta-defi/docs/blob/main/ARCHITECTURE.md).

## Schedulers

- The VPS cron runs `scripts/keeper-record-batch-cron.sh` every five minutes. It checks Ponder's
  `/status`, selects active meme pools from `/loans/keeper-candidates` and `/pools`, confirms
  `debtOf` using Multicall3, sends one `recordBatch`, persists cost, and updates the primary
  heartbeat.
- The GitHub Actions backup runs independently every five minutes. It has only paid-RPC and its
  own hot wallet. It rebuilds meme pool keys from `PoolListed` and `Initialize` logs, reads
  `Recorded` logs, and batches every listed meme pool whose latest observation is over 420
  seconds old. It never accesses Ponder or PostgreSQL. A submitted backup transaction sends a
  Telegram alert immediately.

The schedulers intentionally do not coordinate a database slot. `recordBatch` ignores an
observation already made at the same timestamp; the 420-second backup threshold makes duplicate
transactions unlikely while preserving recovery when the VPS is unavailable.

## Setup

Install Bun, copy `.env.example` to `.env`, restrict it to the service account, and populate the
addresses from the deployment configuration. `DATABASE_URL` is required only by the primary VPS
process and must target the shared `farmenta` database. The backup GitHub workflow must receive
only its listed `KEEPER_BACKUP_*` and Telegram secrets; it must not receive `DATABASE_URL` or an
indexer URL.

The backend foundation migration must have created `backend` and `backend.service_heartbeat`
before this service is deployed. Apply keeper migrations through the recorded runner:

```sh
bun install --frozen-lockfile
bun run db:migrate
```

Run a dry run without broadcasting:

```sh
bun run keeper:primary --dry-run
bun run keeper:backup --dry-run
```

## Checks

```sh
bun run lint
bun run test
bun run build
```
