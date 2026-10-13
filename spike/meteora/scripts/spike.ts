// Client for the fumpad_dbc_spike program (hand-built instructions; discriminators = sha256("global:<ix>")[..8]).
import crypto from "node:crypto";
import { AccountMeta, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";

export const SPIKE_PROGRAM = new PublicKey("8zt6gZTFwn6Dn5YRhu7jsywR5tQnZZCx1YmrbqLVTbeW");

const disc = (name: string) => crypto.createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
const u8 = (n: number) => Buffer.from([n]);
const vecU8 = (b: Buffer) => { const l = Buffer.alloc(4); l.writeUInt32LE(b.length); return Buffer.concat([l, b]); };
const u64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };

export function pdas() {
  const f = (s: string) => PublicKey.findProgramAddressSync([Buffer.from(s)], SPIKE_PROGRAM)[0];
  return { feeClaimer: f("fee_claimer"), rewardPool: f("reward_pool"), buyback: f("buyback") };
}

/** Convert a venue instruction into remaining accounts for our CPI pass-through (signer flags of PDAs dropped). */
export function passthrough(ix: TransactionInstruction, pdaSigners: PublicKey[] = []): AccountMeta[] {
  return ix.keys.map((k) => ({ ...k, isSigner: k.isSigner && !pdaSigners.some((p) => p.equals(k.pubkey)) }));
}

export function routedSwapIx(user: PublicKey, venueIx: TransactionInstruction, inIdx: number, outIdx: number) {
  return new TransactionInstruction({
    programId: SPIKE_PROGRAM,
    keys: [
      { pubkey: user, isSigner: true, isWritable: false },
      { pubkey: venueIx.programId, isSigner: false, isWritable: false },
      ...passthrough(venueIx),
    ],
    data: Buffer.concat([disc("routed_swap"), vecU8(venueIx.data), u8(inIdx), u8(outIdx)]),
  });
}

export function buybackSwapIx(venueIx: TransactionInstruction, inIdx: number, outIdx: number) {
  const { buyback } = pdas();
  return new TransactionInstruction({
    programId: SPIKE_PROGRAM,
    keys: [
      { pubkey: buyback, isSigner: false, isWritable: false },
      { pubkey: venueIx.programId, isSigner: false, isWritable: false },
      ...passthrough(venueIx, [buyback]),
    ],
    data: Buffer.concat([disc("buyback_swap"), vecU8(venueIx.data), u8(inIdx), u8(outIdx)]),
  });
}

export function claimAndSplitIx(a: {
  venueIx: TransactionInstruction; baseIdx: number; quoteIdx: number;
  feeQuote: PublicKey; buybackQuote: PublicKey; platformQuote: PublicKey; creatorQuote: PublicKey; quoteMint: PublicKey;
}) {
  const { feeClaimer } = pdas();
  return new TransactionInstruction({
    programId: SPIKE_PROGRAM,
    keys: [
      { pubkey: feeClaimer, isSigner: false, isWritable: false },
      { pubkey: a.venueIx.programId, isSigner: false, isWritable: false },
      { pubkey: a.feeQuote, isSigner: false, isWritable: true },
      { pubkey: a.buybackQuote, isSigner: false, isWritable: true },
      { pubkey: a.platformQuote, isSigner: false, isWritable: true },
      { pubkey: a.creatorQuote, isSigner: false, isWritable: true },
      { pubkey: a.quoteMint, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ...passthrough(a.venueIx, [feeClaimer]),
    ],
    data: Buffer.concat([disc("claim_and_split"), vecU8(a.venueIx.data), u8(a.baseIdx), u8(a.quoteIdx)]),
  });
}

export function payRewardIx(a: { rewardVault: PublicKey; mint: PublicKey; destination: PublicKey; tokenProgram: PublicKey; amount: bigint }) {
  const { rewardPool } = pdas();
  return new TransactionInstruction({
    programId: SPIKE_PROGRAM,
    keys: [
      { pubkey: rewardPool, isSigner: false, isWritable: false },
      { pubkey: a.rewardVault, isSigner: false, isWritable: true },
      { pubkey: a.mint, isSigner: false, isWritable: false },
      { pubkey: a.destination, isSigner: false, isWritable: true },
      { pubkey: a.tokenProgram, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([disc("pay_reward"), u64(a.amount)]),
  });
}

export function readPriceIx(pool: PublicKey) {
  return new TransactionInstruction({
    programId: SPIKE_PROGRAM,
    keys: [{ pubkey: pool, isSigner: false, isWritable: false }],
    data: disc("read_price"),
  });
}

/** Parse "Program return: <program> <base64>" from logs. */
export function returnData(logs: string[], program = SPIKE_PROGRAM): Buffer | null {
  const l = [...logs].reverse().find((x) => x.startsWith(`Program return: ${program.toBase58()} `));
  return l ? Buffer.from(l.split(" ").pop()!, "base64") : null;
}
