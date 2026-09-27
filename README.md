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
  own hot wallet. It finds meme pools from `PoolListed` logs (from `KEEPER_LOG_START_BLOCK`),
  their keys from `Initialize` logs filtered to those pool ids (from
  `KEEPER_POOL_MANAGER_START_BLOCK`, since a listed pool may predate the policy), and the latest
  observation from `Recorded` logs filtered to those ids over only the last 900 seconds of blocks.
  Reading the whole `Recorded` history would exceed the RPC's per-response log cap within about a
  week. It batches every listed meme pool whose latest observation is over 420 seconds old, or
  absent from that window. It never accesses Ponder or PostgreSQL. A submitted backup transaction
  sends a Telegram alert immediately, and so does a failed backup run.

The backup workflow stays skipped until the repository variable `KEEPER_BACKUP_ENABLED` is set
to `true`; set it only after the contracts are deployed and every `KEEPER_*` and Telegram secret
the workflow reads exists.

The schedulers intentionally do not coordinate a database slot. `recordBatch` ignores an
observation already made at the same timestamp; the 420-second backup threshold makes duplicate
transactions unlikely while preserving recovery when the VPS is unavailable.

## Setup

Run the primary under its own Unix user on the VPS, with its own low-balance hot wallet (spec §13);
the backup's wallet is a different one. Install Bun, copy `.env.example` to `.env`, restrict it to that user, and populate the
addresses from the deployment configuration. `DATABASE_URL` is required only by the primary VPS
process and must target the shared `farmenta` database. The backup GitHub workflow must receive
only its listed `KEEPER_BACKUP_*` and Telegram secrets; it must not receive `DATABASE_URL` or an
indexer URL.

Keeper migrations create the `backend` schema and `backend.service_heartbeat` if the backend
repository has not yet done so (with the same definition), and record their history in
`backend.keeper_migrations`, separate from the backend's. Run them with the schema owner's
connection string, then provision the keeper's own least-privilege role as a superuser:

```sh
bun install --frozen-lockfile
DATABASE_URL=<schema owner URL> bun run db:migrate
psql -U postgres -d farmenta -f scripts/create-db-role.sql
psql -U postgres -c '\password farmenta_keeper'
```

Every indexer, Telegram, and database call has a timeout, so a hung dependency cannot keep the
cron's `flock` held past the next run.

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

CI runs these three on every pull request. The Anvil fork test is manual, because it needs a paid
RPC and a checkout of the pinned smart-contract commit (`contracts/source.json`):

```sh
FORK_RPC_URL=<paid RPC> SMART_CONTRACT_DIR=<smart-contract checkout at the pinned commit> bun run test:fork
```
