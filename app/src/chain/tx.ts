"use client";

/**
 * Transaction hooks. The UI calls these. Every action is live when NEXT_PUBLIC_FUMPAD_API is
 * set and a wallet is connected: buy / sell / claim / set_auto_claim / creator fees / escrow are
 * built by `./build` (@fumpad/sdk) against the cluster in NEXT_PUBLIC_SOLANA_RPC and sent through
 * `./flow` (the same pipeline the headless scripts drive), launch is prepared by the API (D18). Otherwise (mock, or the demo
 * wallet) they simulate (delay + fake signature) so every flow can be exercised end to end.
 * Amounts arrive in display units and are converted with `@/data/chain` in `./build`.
 *
 * Program instructions (contracts/INTERFACE-v0.7.md §3):
 *   router buy(amount_in, min_out, mode) / sell(amount_in, min_out) over Meteora DBC or DAMM v2
 *   launch: DBC initialize_virtual_pool_with_token2022 → creator's DBC swap2 → register_coin
 *   claim · set_auto_claim · withdraw_creator_fees · withdraw_escrow
 * Sells file no ticket in the transaction: the keepers attest every qualifying sell, from any
 * app, afterwards (D31).
 */

import { PublicKey, type VersionedTransaction } from "@solana/web3.js";
import { useCallback, useMemo, useRef, useState } from "react";
import { DEMO_WALLET } from "@/data";
import { solToLamports } from "@/data/chain";
import { mockRecordTrade, mockSetAutoClaim, mockWithdrawCreatorFees } from "@/data/mock";
import { announceOwnTx, type OwnTxKind } from "@/components/shell/live";
import { addInstantSpent, getInstantSpent, requestConfirm, useInstantSettings, useWallet, walletActions } from "@/components/wallet/store";
import type { SilentPolicy } from "./allowlist";
import { type BuiltTx, type PreparedTrade, buildClaimTx, prepareBuy, prepareSell, buildSetAutoClaimTx, buildWithdrawCreatorFeesTx, buildWithdrawEscrowTx, fumpadClient } from "./build";
import { getConnection } from "./connection";
import { txErrorMessage as programErrorMessage } from "./errors";
import { type LaunchConfigInfo, type PrepareArgs, prepareLaunchSigned, sendBuilt as sendBuiltTx, signAndSendLaunch } from "./flow";
import { instantDecision, lamportsSol, simulateSpend, worstCaseSpend } from "./limits";
import { VANITY_SUFFIX } from "./program";
import type { FumpadSigner } from "./signer";

export interface TxOk {
  signature: string;
  /** True while running against the mock data source. */
  simulated: boolean;
}

export type TxStatus = "idle" | "building" | "signing" | "confirming" | "done" | "error";

/**
 * Where a launch is, for the progress list: prove wallet ownership (M-2 signed message),
 * reserve the `…fmbL` mint (prepare), approve the transaction, confirm on chain.
 */
export type LaunchStep = "auth" | "reserve" | "sign" | "confirm" | "done";

export interface BuyArgs {
  mint: string;
  /** SOL budget, the pool fee included (a buy that completes the curve uses less; the rest comes back). */
  solIn: number;
  /** Minimum tokens after slippage: the quote the user saw × (1 − SLIPPAGE_BPS), see `./build`. */
  minTokensOut: number;
  /** Quoted tokens out (mock mode applies it to the simulated balance). */
  expectedOut?: number;
}
export interface SellArgs {
  mint: string;
  tokensIn: number;
  /** Minimum SOL after slippage, from the quote the user saw. */
  minSolOut: number;
  /** Quoted SOL out (mock mode applies it to the simulated balance). */
  expectedOut?: number;
}
export interface ClaimArgs {
  mint: string;
  ticket: string;
}
export interface LaunchArgs {
  name: string;
  symbol: string;
  /** Metadata JSON URI (image + description), uploaded before the transaction. */
  uri: string;
  initialBuySol: number;
  /** The one-off first-coin launch config (3% fee; contracts INTERFACE §5.9). Only the API decides if it is offered. */
  launchConfig?: "first_coin";
  /** The trading fee (bps) the review step shows; the launch must carry exactly this fee. */
  expectedFeeBps?: number;
}

/**
 * A launch the API has prepared (D18): a reserved `…fmbL` mint and a transaction already
 * signed by that mint; the wallet signs as creator/fee payer. Mock mode returns a fake
 * `…fmbL` address so the review step looks the same.
 */
export interface PreparedLaunch {
  mint: string;
  suffix: string;
  simulated: boolean;
  args: LaunchArgs;
  preparedAt: number;
  /** base64 v0 transaction (live only). */
  transaction?: string;
  lastValidBlockHeight?: number;
  /** The config (and its real fees) the API prepared the launch on (live only; re-checked on chain before signing). */
  config?: LaunchConfigInfo;
}

export interface AutoClaimArgs {
  mint: string;
  enabled: boolean;
  /** Mock mode: whose tickets to update (the demo wallet when no wallet is connected). */
  owner?: string;
}

/** Blockhashes live ~60–90 s; re-prepare (same mint comes back) before signing an older one. */
const PREPARED_MAX_AGE_MS = 45_000;

export class WalletRequiredError extends Error {
  constructor() {
    super("Log in first.");
  }
}

const fakeSig = () => {
  const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let s = "";
  for (let i = 0; i < 88; i++) s += B58[Math.floor(Math.random() * 58)];
  return s;
};
const fakeMint = () => {
  const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let s = "";
  for (let i = 0; i < 40; i++) s += B58[Math.floor(Math.random() * 58)];
  return s + VANITY_SUFFIX;
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The live API base when configured (same switch as the data layer). */
const API = process.env.NEXT_PUBLIC_FUMPAD_API?.replace(/\/+$/, "");

/** The form's launch arguments in chain units. */
const prepareArgs = (a: LaunchArgs): PrepareArgs => ({
  name: a.name,
  symbol: a.symbol,
  uri: a.uri,
  initialBuyLamports: a.initialBuySol > 0 ? solToLamports(a.initialBuySol) : BigInt(0),
  launchConfig: a.launchConfig,
  expectedFeeBps: a.expectedFeeBps,
});

/** Program errors (preflight / confirmation) → one sentence (FUMPAD's own codes, or Meteora's swap failures). */
function txErrorMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e ?? "");
  const logs = (e as { logs?: unknown } | null)?.logs;
  return programErrorMessage(raw, Array.isArray(logs) ? logs.map(String) : undefined);
}

async function simulate(setStatus: (s: TxStatus) => void, ms = 900): Promise<TxOk> {
  setStatus("building");
  await wait(ms * 0.3);
  setStatus("signing");
  await wait(ms * 0.3);
  setStatus("confirming");
  await wait(ms * 0.4);
  setStatus("done");
  return { signature: fakeSig(), simulated: true };
}

/** The active wallet as a `FumpadSigner` (live mode only; the mock signs nothing). */
function useActiveSigner(): FumpadSigner | null {
  const { mode, active } = useWallet();
  const address = active?.address;
  const kind = active?.kind;
  const name = active?.name;
  return useMemo(() => {
    if (mode !== "privy" || !address || !kind) return null;
    return {
      publicKey: new PublicKey(address),
      kind,
      name: name ?? "Wallet",
      sign: (tx, opts) => walletActions().signTransaction(address, tx, opts),
      signMessage: (message, opts) => walletActions().signMessage(address, message, opts),
    } satisfies FumpadSigner;
  }, [mode, address, kind, name]);
}

const fmtSol = (n: number) => (n >= 100 ? n.toFixed(0) : n >= 1 ? n.toFixed(2) : n.toFixed(3)).replace(/\.?0+$/, "");

/**
 * One hook per screen action. `requireWallet` is false in the mock so the demo wallet
 * can act.
 *
 * Signing: the Trading wallet (Privy embedded) with Instant trading on signs vetted FUMPAD
 * transactions without a prompt (`./signer`, `./allowlist`); above the per-trade limit an
 * on-screen confirm comes first. With Instant off, Privy shows its own approval window.
 * External wallets always prompt.
 */
export function useFumpadTx({ requireWallet = false }: { requireWallet?: boolean } = {}) {
  const wallet = useWallet();
  const settings = useInstantSettings();
  const signer = useActiveSigner();
  const [status, setStatus] = useState<TxStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [launchStep, setLaunchStep] = useState<LaunchStep | null>(null);
  /** The latest error without waiting for a re-render (callers read it right after `await`). */
  const errorRef = useRef<string | null>(null);
  const connection = getConnection();
  const owner = wallet.active?.address ?? DEMO_WALLET;
  /** The active wallet signs without a popup (Trading wallet + Instant trading on; also the demo wallet). */
  const instant = wallet.active?.kind === "embedded" && settings.enabled;

  /**
   * Instant signing asks on screen first when the transaction's real outflow (`spend`: amount,
   * 1% fee, account rent, network fees; see `./limits`) is above the per-trade limit, when a
   * sell's proceeds are, or once this session's instant spending reached the session cap (L-8).
   * Prompting wallets (external, or Instant off) already ask, so they skip this.
   */
  const guardInstant = useCallback(
    async (spend: bigint, verb: string, sellValueSol?: number) => {
      if (!instant) return;
      const spentSoFar = getInstantSpent();
      let d = instantDecision(spend, spentSoFar, { maxSol: settings.maxSol, sessionCapSol: settings.sessionCapSol });
      if (!d.ask && sellValueSol !== undefined && sellValueSol > settings.maxSol) d = { ask: true, reason: "trade-limit" };
      if (!d.ask) return;
      const out = lamportsSol(spend > BigInt(0) ? spend : BigInt(0));
      const ok = await requestConfirm(
        d.reason === "session-cap"
          ? {
              title: "Confirm this transaction",
              body: `Instant trades have spent ${fmtSol(lamportsSol(spentSoFar))} SOL this session and your session cap is ${fmtSol(settings.sessionCapSol)} SOL, so every transaction asks first now${out > 0 ? ` (this one: up to ${fmtSol(out)} SOL)` : ""}. Change the cap in the wallet menu.`,
              confirmLabel: "Confirm",
            }
          : sellValueSol !== undefined
            ? {
                title: `${verb} ${fmtSol(sellValueSol)} SOL?`,
                body: `That's above your instant limit of ${fmtSol(settings.maxSol)} SOL, so FUMPAD asks first. Change the limit in the wallet menu.`,
                confirmLabel: `${verb} ${fmtSol(sellValueSol)} SOL`,
              }
            : {
                title: `${verb} up to ${fmtSol(out)} SOL?`,
                body: `With the pool fee, network fees and first-time account rent, that's above your instant limit of ${fmtSol(settings.maxSol)} SOL, so FUMPAD asks first. Change the limit in the wallet menu.`,
                confirmLabel: `${verb} ${fmtSol(out)} SOL`,
              },
      );
      if (!ok) throw new Error("Cancelled. Nothing was sent.");
    },
    [instant, settings.maxSol, settings.sessionCapSol],
  );

  /** Instant outflow of a built transaction: simulated, else the worst case for the action. */
  const instantSpend = useCallback(
    async (tx: VersionedTransaction | null, wallet: PublicKey | null, kind: "buy" | "launch" | "other", amountSol: number): Promise<bigint> => {
      const sim = tx && wallet ? await simulateSpend(connection, tx, wallet) : null;
      return sim ?? worstCaseSpend(kind, amountSol > 0 ? solToLamports(amountSol) : BigInt(0));
    },
    [connection],
  );

  const run = useCallback(
    async (fn: () => Promise<TxOk>, kind: OwnTxKind, mint?: string): Promise<TxOk | null> => {
      setError(null);
      errorRef.current = null;
      try {
        if (requireWallet && !wallet.active) throw new WalletRequiredError();
        const ok = await fn();
        // Confirmed: every mounted view that shows this wallet or coin refetches (components/shell/live.ts).
        announceOwnTx({ kind, mint, wallet: owner, signature: ok.signature });
        return ok;
      } catch (e) {
        setStatus("error");
        errorRef.current = txErrorMessage(e);
        setError(errorRef.current);
        return null;
      }
    },
    [owner, requireWallet, wallet.active],
  );

  /** Live = the API is configured and a real wallet is logged in; otherwise simulate. */
  const live = !!API && !!signer;
  const client = useMemo(() => fumpadClient(connection), [connection]);

  /** Build → vet + sign (silently when allowed) → send → confirm (`./flow`). */
  const sendBuilt = useCallback(
    async (
      build: () => Promise<BuiltTx | PreparedTrade> | BuiltTx,
      failed: string,
      policy: SilentPolicy,
      guard: { verb: string; kind: "buy" | "other"; amountSol?: number; sellValueSol?: number },
    ): Promise<TxOk> => {
      const s = signer!;
      let spend = BigInt(0);
      const { signature } = await sendBuiltTx(build, policy, {
        connection,
        client,
        signer: s,
        instant,
        failed,
        onStage: setStatus,
        // M-9 / L-8: what this exact transaction costs the wallet, before anything is signed.
        beforeSign: async (tx) => {
          spend = instant ? await instantSpend(tx, s.publicKey, guard.kind, guard.amountSol ?? 0) : BigInt(0);
          await guardInstant(spend, guard.verb, guard.sellValueSol);
        },
        onSent: () => {
          if (instant) addInstantSpent(spend);
        },
      });
      return { signature, simulated: false };
    },
    [client, signer, connection, instant, instantSpend, guardInstant],
  );

  /** Mock / demo wallet: same on-screen rules, against the worst case (nothing to simulate). */
  const guardSimulated = useCallback(
    async (kind: "buy" | "launch" | "other", amountSol: number, verb: string, sellValueSol?: number) => {
      const spend = instant ? worstCaseSpend(kind, kind === "other" ? BigInt(0) : solToLamports(amountSol)) : BigInt(0);
      await guardInstant(spend, verb, sellValueSol);
      return () => instant && addInstantSpent(spend);
    },
    [instant, guardInstant],
  );

  const buy = useCallback(
    (args: BuyArgs) =>
      run(
        async () => {
          if (!live) {
            const counted = await guardSimulated("buy", args.solIn, "Buy");
            const ok = await simulate(setStatus);
            counted();
            mockRecordTrade(owner, args.mint, "buy", args.solIn, args.expectedOut ?? args.minTokensOut);
            return ok;
          }
          // Router buy: DBC on the curve (PartialFill), DAMM v2 after graduation; SOL wrapped into
          // WSOL around it. The signed amount may not exceed what the user entered; min_out is the
          // shown quote's (M-9).
          return sendBuilt(
            () => prepareBuy(client, signer!.publicKey, args),
            "The buy failed on chain. Nothing but the network fee was spent.",
            { action: "buy", mint: args.mint, maxSolInLamports: solToLamports(args.solIn) },
            { verb: "Buy for", kind: "buy", amountSol: args.solIn },
          );
        },
        "buy",
        args.mint,
      ),
    [run, guardSimulated, live, sendBuilt, client, signer, owner],
  );

  const sell = useCallback(
    (args: SellArgs) =>
      run(
        async () => {
          const value = args.expectedOut ?? args.minSolOut;
          if (!live) {
            const counted = await guardSimulated("other", 0, "Sell for", value);
            const ok = await simulate(setStatus);
            counted();
            mockRecordTrade(owner, args.mint, "sell", args.tokensIn, args.expectedOut ?? args.minSolOut);
            return ok;
          }
          // Router sell. The keepers attest a qualifying sell afterwards (D31), like one on any app.
          return sendBuilt(
            () => prepareSell(client, signer!.publicKey, args),
            "The sell failed on chain. Nothing but the network fee was spent.",
            { action: "sell", mint: args.mint },
            { verb: "Sell for", kind: "other", sellValueSol: value },
          );
        },
        "sell",
        args.mint,
      ),
    [run, guardSimulated, live, sendBuilt, client, signer, owner],
  );

  const claim = useCallback(
    (args: ClaimArgs) =>
      run(
        async () => {
          if (!live) return simulate(setStatus, 650);
          // Pays in the same tx (ClaimPaid) or joins the queue (ClaimQueued); the UI re-reads.
          return sendBuilt(
            () => buildClaimTx(client, signer!.publicKey, args),
            "The claim failed on chain. Nothing but the network fee was spent.",
            { action: "claim", mint: args.mint, ticket: args.ticket },
            { verb: "Claim", kind: "other" },
          );
        },
        "claim",
        args.mint,
      ),
    [run, live, sendBuilt, client, signer],
  );

  /**
   * D18 step 1 (review): reserve a `…fmbL` mint. Live: `POST /v1/launch/prepare` returns the
   * mint and a create_coin(+first buy) transaction the server already signed AS THE MINT
   * (the mint's secret never leaves the server). Mock: a fake `…fmbL` address.
   */
  /** M-2: the prepare call with the creator's signed ownership message (`./flow`). */
  const prepareSigned = useCallback(
    (s: FumpadSigner, args: LaunchArgs) => prepareLaunchSigned(API!, s, prepareArgs(args), instant, setLaunchStep),
    [instant],
  );

  const prepareLaunch = useCallback(
    async (args: LaunchArgs): Promise<PreparedLaunch | null> => {
      setError(null);
      setStatus("building");
      try {
        if (!live) {
          // Mock: the same steps, simulated (the demo wallet signs nothing).
          setLaunchStep("auth");
          await wait(450);
          setLaunchStep("reserve");
          await wait(350);
          setLaunchStep(null);
          setStatus("idle");
          return { mint: fakeMint(), suffix: VANITY_SUFFIX, simulated: true, args, preparedAt: Date.now() };
        }
        const r = await prepareSigned(signer!, args);
        setLaunchStep(null);
        setStatus("idle");
        return { mint: r.mint, suffix: r.suffix, simulated: false, args, preparedAt: Date.now(), transaction: r.transaction, lastValidBlockHeight: r.lastValidBlockHeight, config: r.config };
      } catch (e) {
        setLaunchStep(null);
        setStatus("error");
        setError(e instanceof Error ? e.message : "Couldn't prepare the launch.");
        return null;
      }
    },
    [live, signer, prepareSigned],
  );

  /**
   * D18 step 2 (confirm): the wallet signs as creator/fee payer and the launch is sent. The
   * API's transaction is checked twice before signing: `checkLaunchBinding` (M-1: the reserved
   * mint, the form's name/symbol/uri, the first buy on that mint for exactly the amount typed
   * with a real slippage bound, the mint's signature) and the silent-signing allow-list
   * (programs, signers, first-buy amount).
   */
  const launch = useCallback(
    (prepared: PreparedLaunch) =>
      run(async () => {
        if (prepared.simulated || !live) {
          const counted = await guardSimulated("launch", prepared.args.initialBuySol, "Launch for");
          setLaunchStep("sign");
          const ok = await simulate((st) => {
            setStatus(st);
            if (st === "confirming") setLaunchStep("confirm");
          }, 1400);
          counted();
          setLaunchStep("done");
          return ok;
        }
        const s = signer!;
        setStatus("building");
        let p = prepared;
        if (Date.now() - p.preparedAt > PREPARED_MAX_AGE_MS) {
          // Blockhash about to expire: the API returns the same reserved mint with a fresh tx
          // (the signed ownership message is reused while it is fresh, else signed again).
          const r = await prepareSigned(s, p.args);
          if (r.mint !== p.mint) throw new Error("The launch address changed. Review it again before launching.");
          if ((r.config?.dbcConfig ?? "") !== (p.config?.dbcConfig ?? "")) throw new Error("The launch config changed. Review it again before launching.");
          p = { ...p, transaction: r.transaction, lastValidBlockHeight: r.lastValidBlockHeight, preparedAt: Date.now(), config: r.config };
        }
        let spend = BigInt(0);
        const { signature } = await signAndSendLaunch(
          { mint: p.mint, suffix: p.suffix, transaction: p.transaction!, lastValidBlockHeight: p.lastValidBlockHeight!, config: p.config },
          prepareArgs(p.args),
          {
            connection,
            client,
            signer: s,
            instant,
            beforeSign: async (tx) => {
              spend = instant ? await instantSpend(tx, s.publicKey, "launch", p.args.initialBuySol) : BigInt(0);
              await guardInstant(spend, "Launch for");
            },
            onSigning: () => {
              setLaunchStep("sign");
              setStatus("signing");
            },
            onConfirming: () => {
              setLaunchStep("confirm");
              setStatus("confirming");
            },
            onSent: () => {
              if (instant) addInstantSpent(spend);
            },
          },
        );
        setLaunchStep("done");
        setStatus("done");
        return { signature, simulated: false };
      }, "launch", prepared.mint).then((ok) => {
        if (!ok) setLaunchStep(null);
        return ok;
      }),
    [run, guardSimulated, guardInstant, instantSpend, live, signer, instant, connection, client, prepareSigned],
  );

  /** D17: let (or stop) the keeper claim this coin's tickets for you. */
  const setAutoClaim = useCallback(
    (args: AutoClaimArgs) =>
      run(
        async () => {
          if (!live) {
            const o = args.owner ?? wallet.active?.address;
            if (o) mockSetAutoClaim(o, args.mint, args.enabled);
            return simulate(setStatus, 600);
          }
          return sendBuilt(
            () => buildSetAutoClaimTx(client, signer!.publicKey, args),
            "The change didn't go through.",
            { action: "auto-claim", mint: args.mint },
            { verb: "Change", kind: "other" },
          );
        },
        "auto-claim",
        args.mint,
      ),
    [run, live, wallet.active, sendBuilt, client, signer],
  );

  /** Creator: move the coin's unclaimed creator fees to the wallet. */
  const withdrawCreatorFees = useCallback(
    (args: { mint: string }) =>
      run(
        async () => {
          if (!live) {
            mockWithdrawCreatorFees(args.mint);
            return simulate(setStatus, 700);
          }
          return sendBuilt(
            () => buildWithdrawCreatorFeesTx(client, signer!.publicKey, args),
            "The withdrawal failed on chain. Nothing but the network fee was spent.",
            { action: "withdraw", mint: args.mint },
            { verb: "Withdraw", kind: "other" },
          );
        },
        "withdraw",
        args.mint,
      ),
    [run, live, sendBuilt, client, signer],
  );

  /** D16: move a payout that went to the ticket's escrow (the owner's account refused it) into the owner's own account. */
  const withdrawEscrow = useCallback(
    (args: { mint: string; ticket: string }) =>
      run(
        async () => {
          if (!live) return simulate(setStatus, 650);
          return sendBuilt(
            () => buildWithdrawEscrowTx(client, signer!.publicKey, args),
            "The withdrawal failed on chain. Nothing but the network fee was spent.",
            { action: "escrow", mint: args.mint, ticket: args.ticket },
            { verb: "Withdraw", kind: "other" },
          );
        },
        "claim",
        args.mint,
      ),
    [run, live, sendBuilt, client, signer],
  );

  const reset = useCallback(() => {
    setStatus("idle");
    setLaunchStep(null);
    setError(null);
    errorRef.current = null;
  }, []);
  const lastError = useCallback(() => errorRef.current, []);

  return {
    status,
    error,
    lastError,
    buy,
    sell,
    claim,
    prepareLaunch,
    launch,
    /** The launch's current step (null when no launch is in flight). */
    launchStep,
    setAutoClaim,
    withdrawCreatorFees,
    withdrawEscrow,
    reset,
    live,
    /** True when the active wallet signs without a popup (copy: "Signing…" instead of "Approve it in your wallet."). */
    instant,
    wallet: wallet.active?.address ?? null,
  };
}
