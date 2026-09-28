import { createServer } from 'node:http';
import type { Hex } from 'viem';

/** Thrown by a handler to answer `execution reverted` with revert data, as a node does. */
export class RpcRevert extends Error {
  constructor(readonly data: Hex) { super('execution reverted'); }
}

export interface RpcRequest { method: string; params: unknown[] }
export interface JsonRpcEndpoint { url: string; requests: RpcRequest[]; close(): Promise<void> }

/**
 * A JSON-RPC endpoint on localhost, so that `ViemChain` is tested through viem's own transport,
 * encoding and error handling instead of through a mock of its methods.
 */
export async function startJsonRpc(handler: (request: RpcRequest) => unknown): Promise<JsonRpcEndpoint> {
  const requests: RpcRequest[] = [];
  const server = createServer((incoming, response) => {
    let body = '';
    incoming.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    incoming.on('end', () => {
      const { id, method, params } = JSON.parse(body) as { id: number; method: string; params?: unknown[] };
      const request = { method, params: params ?? [] };
      requests.push(request);
      const reply = (payload: object) => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ jsonrpc: '2.0', id, ...payload })); };
      try {
        reply({ result: handler(request) });
      } catch (error) {
        if (error instanceof RpcRevert) reply({ error: { code: 3, message: 'execution reverted', data: error.data } });
        else reply({ error: { code: -32601, message: error instanceof Error ? error.message : 'unsupported' } });
      }
    });
  });
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the endpoint has no port');
  return { url: `http://127.0.0.1:${address.port}`, requests, close: () => new Promise((resolve) => { server.close(() => resolve()); }) };
}
