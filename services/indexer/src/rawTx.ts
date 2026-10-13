/**
 * getTransaction with `maxSupportedTransactionVersion: 1` everywhere (web3.js v1's Connection can't decode
 * version-1 transactions, which apps already send): raw JSON through @fumpad/meteora's MeteoraRpc, one
 * client per RPC endpoint. Test doubles without an `rpcEndpoint` keep their own `getTransaction`.
 */
import type { Connection } from "@solana/web3.js";

import { MeteoraRpc } from "@fumpad/meteora";
import type { TxLike } from "@fumpad/sdk";

const clients = new Map<string, MeteoraRpc>();

type ConnLike = Pick<Connection, "rpcEndpoint"> | { getTransaction: (sig: string, opts: unknown) => Promise<unknown> };

export function rawRpc(endpoint: string): MeteoraRpc {
  let c = clients.get(endpoint);
  if (!c) {
    c = new MeteoraRpc(endpoint, { attempts: 3 });
    clients.set(endpoint, c);
  }
  return c;
}

/** The transaction as raw JSON (any version ≤ 1), or null if the node doesn't know it. */
export async function getTx(conn: ConnLike, signature: string, commitment: "confirmed" | "finalized" = "confirmed"): Promise<TxLike | null> {
  const endpoint = (conn as { rpcEndpoint?: unknown }).rpcEndpoint;
  if (typeof endpoint === "string") return (await rawRpc(endpoint).getTransaction(signature, commitment)) as unknown as TxLike | null;
  return ((await (conn as { getTransaction: (s: string, o: unknown) => Promise<unknown> }).getTransaction(signature, { maxSupportedTransactionVersion: 1, commitment })) ?? null) as TxLike | null;
}
