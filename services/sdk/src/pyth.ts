/** Pyth Solana Receiver `PriceUpdateV2` decoding (layout verified in contracts external/pyth.rs). */
import { PublicKey } from "@solana/web3.js";

/** Mainnet sponsored SOL/USD PriceUpdateV2 account (Pyth push oracle, shard 0). */
export const PYTH_SOL_USD_ACCOUNT = new PublicKey("7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE");
export const PYTH_RECEIVER_PROGRAM_ID = new PublicKey("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ");

export interface PythPriceUpdate {
  feedId: string;
  price: bigint;
  conf: bigint;
  exponent: number;
  publishTime: bigint;
  fullyVerified: boolean;
}

export function decodePythPriceUpdate(data: Uint8Array): PythPriceUpdate {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const level = data[40];
  const m = level === 1 ? 41 : 42;
  return {
    feedId: Array.from(data.subarray(m, m + 32), (x) => x.toString(16).padStart(2, "0")).join(""),
    price: v.getBigInt64(m + 32, true),
    conf: v.getBigUint64(m + 40, true),
    exponent: v.getInt32(m + 48, true),
    publishTime: v.getBigInt64(m + 52, true),
    fullyVerified: level === 1,
  };
}

/** Conservative (price − conf) SOL/USD as a float, for display. */
export const pythUsd = (p: Pick<PythPriceUpdate, "price" | "conf" | "exponent">): number => Number(p.price - p.conf) * 10 ** p.exponent;
