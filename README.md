# Farmenta keeper

The liquidation process polls every two seconds. It reads candidates from the indexer, but all
debt and liquidation decisions come from the contracts: `debtOf`,
`MarketLens.liquidationHealthFactor`, and `MarketLens.liquidationCloseFactorBps`. It never
reimplements the health-factor formula, including the stale-TWAP liquidation price surface.

For each unhealthy position it obtains a V4Quoter-backed UniversalRouter route, simulates the
exact `LiquidatorHelper.execute` call, and broadcasts only when expected profit exceeds gas.
The helper's own `minOut` stays in the router calldata, so an adverse fill reverts atomically.
The bot waits 60 seconds for a position first made unhealthy during an active LT ramp, then
competes normally. Profits received by the hot wallet are swept to `KEEPER_TREASURY` after a
successful liquidation.

## Setup

```sh
bun install
cp .env.example .env
chmod 600 .env
```

`KEEPER_MARKETS_JSON` contains the deployed market, lens, helper, and policy addresses. The
route endpoint is intentionally a narrow internal service: `POST /v4-quote` must query
`V4Quoter`, construct complete UniversalRouter calldata (including fee-purchase legs), retain
its `minOut`, and return `expectedProfit` and an optional `requiredRepayAmount`. The latter lets
the route service increase the close-factor repayment after a preliminary helper simulation
reports `FeePurchaseUnderfunded`; the same amount is never retried.

## Run

```sh
bun run keeper:liquidate --dry-run
bun run keeper:liquidate
```

Dry-run performs candidate reads, V4 quoting, and the exact `eth_call`, then prints each safe
transaction plan without sending it. Run one process per hot wallet and keep only gas in that
wallet. Telegram notifications are best-effort and never include RPC URLs, private keys, or
other secrets.

## Checks

```sh
bun run lint
bun run test
bun run build
```
