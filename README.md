# Farmenta Keeper

This repository contains Farmenta's off-chain keeper processes: a TWAP recorder scheduler, a
backup recorder scheduler, and a liquidation monitor. The processes are separate from the
indexer, so wallet credentials are not available to indexer workflows. This README documents
their setup and operation; it does not indicate that any process is currently deployed or running.

For public protocol information, see the [contract architecture](https://docs.farmenta.fun/docs/reference/architecture),
[TwapRecorder reference](https://docs.farmenta.fun/docs/reference/twap-recorder),
[indexer reference](https://docs.farmenta.fun/docs/reference/indexer), and
[liquidator and keeper guide](https://docs.farmenta.fun/docs/liquidations/liquidator-guide).

## Schedulers

- The primary VPS deployment runs `scripts/keeper-record-batch-cron.sh` every five minutes. It checks Ponder's
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
connection string (on the VPS that is `farmenta_backend`, which has no `CREATE` on the database
and does not need it once the schema exists), then provision the keeper's own least-privilege
role as a superuser:

```sh
bun install --frozen-lockfile
DATABASE_URL=<schema owner URL> bun run db:migrate
psql -U postgres -d farmenta -f scripts/create-db-role.sql
psql -U postgres -c '\password farmenta_keeper'
```

Install the cron entry for the keeper's Unix user. The script changes to the repository and adds
`~/.bun/bin` to `PATH` itself, because cron provides neither:

```
*/5 * * * * /path/to/keeper/scripts/keeper-record-batch-cron.sh
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

## Liquidation monitor

The liquidation process polls every two seconds. It reads candidates from the indexer, but debt and
liquidation decisions come from contracts (`debtOf`, `MarketLens.liquidationHealthFactor`, and
`MarketLens.liquidationCloseFactorBps`): there is no health-factor arithmetic in this repository.

For a loan with a health factor under 1 it:

1. Waits 60 seconds first when the pool's LT ramp is running, or when the loan is a meme loan whose
   pool is stale (`TwapRecorder.consult` reverts). A stale pool is sent one `record` at once.
2. Simulates `LiquidatorHelper.execute` with `eth_simulateV1` and reads what is seized from the
   market's `Liquidate` event. The amount to sell and the profit do not follow from the repayment,
   so neither is derived from it.
3. Quotes the seized token on `V4Quoter` through every pool of `KEEPER_ROUTE_POOLS_JSON` that pairs
   it with USDG, and through the position's own pool. After a full seizure the position's own pool
   is left out: the position can be all of its active liquidity.
4. Builds the UniversalRouter calldata with a floor `KEEPER_SLIPPAGE_BPS` under the best quote,
   simulates it again for the profit, and runs the exact call through `eth_call`.
5. Sends only when that profit, less what the floor still lets the swap lose, is above the gas.
   A swap under the floor reverts in the helper, and the whole liquidation with it.
6. Sweeps the USDG it was paid to `KEEPER_TREASURY`.

`FeePurchaseUnderfunded` raises the budget to the repayment plus what the market asked for, capped
at the debt, and is tried once more in the same cycle. A race lost to another liquidator reverts in
simulation and costs no gas.

The RPC must serve `eth_simulateV1`. A full seizure needs at least one pool in
`KEEPER_ROUTE_POOLS_JSON`; without one the loan is not liquidated and the alert says so.

Run `bun run keeper:liquidate --dry-run` to print the plan of one cycle without broadcasting, or
omit `--dry-run` to run the loop. Run this process under its own Unix user with its own `.env` and
`KEEPER_LIQUIDATOR_PRIVATE_KEY`; the scheduler wallet must never be reused. `KEEPER_MARKETS_JSON`
contains the deployed market, lens, helper, and policy addresses.

### Contract ABIs

`src/contract-abi.ts` is generated from the forge artifacts of the commit in
`contracts/source.json`. After a re-pin, check that commit out, build it, and regenerate:

```sh
SMART_CONTRACT_DIR=<smart-contract checkout at the pinned commit> bun run abi:generate
```

### Fork tests

`bun run test:fork` also runs the liquidation bot against an Anvil fork: `script/Deploy.s.sol` of
the pinned contracts deploys Farmenta onto the fork, a loan is opened on a real position, and the
ETH/USD feed is moved until the loan is unhealthy. `Liquidator` and `ViemChain` are the ones the
process runs; only the indexer's candidate list and Telegram are stubbed. The checkout needs its
submodules (`git clone --recurse-submodules`, or `git submodule update --init --recursive`), and
Anvil must serve `eth_simulateV1`.
