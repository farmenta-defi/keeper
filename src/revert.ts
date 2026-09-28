import { BaseError, ContractFunctionRevertedError, decodeErrorResult, parseAbi, type Hex } from 'viem';
import { helperAbi, liquidationErrorsAbi } from './contract-abi.js';

/** `LiquidatorHelper.execute` with every error it can surface: its own and the market's. */
export const executeAbi = [...helperAbi, ...liquidationErrorsAbi] as const;

// UniversalRouter and v4 errors that arrive wrapped in the helper's `SwapFailed(bytes)`.
const swapErrorsAbi = parseAbi([
  'error V4TooLittleReceived(uint256 minAmountOutReceived, uint256 amountReceived)',
  'error CurrencyNotSettled()',
  'error SwapAmountCannotBeZero()',
  'error TransactionDeadlinePassed()',
]);

export interface Revert { errorName: string; args: readonly unknown[] }

function decode(data: Hex): Revert | undefined {
  try {
    const decoded = decodeErrorResult({ abi: executeAbi, data });
    return { errorName: decoded.errorName, args: decoded.args ?? [] };
  } catch { return undefined; }
}

/** A helper call that reverted inside `eth_simulateV1`, which reports it as a result, not an error. */
export class SimulationRevertedError extends Error {
  readonly revert: Revert | undefined;
  constructor(readonly data: Hex) {
    const revert = decode(data);
    super(`liquidation simulation reverted with ${revert?.errorName ?? (data.length >= 10 ? data.slice(0, 10) : 'no data')}`);
    this.revert = revert;
  }
}

/** The contract error behind a failed simulation, from `eth_call` (viem) or `eth_simulateV1`. */
export function revertOf(error: unknown): Revert | undefined {
  if (error instanceof SimulationRevertedError) return error.revert;
  if (!(error instanceof BaseError)) return undefined;
  const reverted = error.walk((cause) => cause instanceof ContractFunctionRevertedError);
  if (!(reverted instanceof ContractFunctionRevertedError)) return undefined;
  if (reverted.data) return { errorName: reverted.data.errorName, args: reverted.data.args ?? [] };
  return reverted.raw ? decode(reverted.raw) : undefined;
}

/** `SwapFailed (V4TooLittleReceived)` for a wrapped router error, the error name otherwise. */
export function describeRevert(revert: Revert): string {
  if (revert.errorName !== 'SwapFailed') return revert.errorName;
  try {
    return `SwapFailed (${decodeErrorResult({ abi: swapErrorsAbi, data: revert.args[0] as Hex }).errorName})`;
  } catch { return 'SwapFailed'; }
}
