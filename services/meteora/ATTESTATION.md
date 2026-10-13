# Outside-trade attestations (Meteora DBC / DAMM v2)

How keepers turn a Meteora trade made **outside FUMPAD** (Axiom, GMGN, Photon, Jupiter, OKX, DFlow,
Telegram bots, direct) into a fumble-ticket attestation, and what the on-chain program must check.
Record format = `MeteoraTrade` from `parseMeteoraTrades` (src/parse.ts). Programs:
DBC `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN`, DAMM v2 `cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG`.

## 1. Record source of truth

- Only the programs' own `emit_cpi!` events count: DBC `EvtSwap2` (+ the legacy `EvtSwap` it emits in the
  same instruction, which must agree field by field) and `EvtCurveComplete`; DAMM v2 `EvtSwap2`.
  There is **no `EvtSwap3`** in either program today (checked: on-chain IDL accounts — DBC 0.1.10,
  DAMM v2 0.2.0 — and both repos' `main`, DBC 0.2.1 / cp_amm 0.2.4). The transfer-fee fields
  (`included_transfer_fee_amount_in`, `excluded_transfer_fee_amount_out`, …) are in **DAMM v2 `EvtSwap2`**.
  DBC 0.2.0 added `EvtSwap2WithTransferHook` for transfer-hook pools only; FUMPAD uses plain pools and the
  parser rejects `swap2_with_transfer_hook` (`unsupported_instruction`). Re-check on every Meteora upgrade
  (`npm run sync-idl -w @fumpad/meteora`; the strict length check fails closed on any layout change).
- An event is authentic iff: it is an inner instruction **of** DBC/DAMM v2, its account 0 is the program's
  `__event_authority` PDA (only the program can sign it), data starts with Anchor's event tag, and its CPI
  parent (resolved by `stackHeight`) is a `swap`/`swap2` instruction **of the same program**. Logs are
  never used (truncatable, spoofable via `Program data:` from other programs).
- Amounts are then cross-checked against **pool-vault token-balance deltas** (summed over all swaps on that
  vault in the tx, plus every vault movement NOT made by those swaps — token `Transfer`/`TransferChecked`/`MintTo`/
  `Burn` instructions outside the swap's CPI subtree, e.g. a 1-unit donation or a fee claim in the same tx; a
  `SyncNative` on a WSOL vault may only raise it; `src/vaultflow.ts`). Any mismatch, unknown layout, missing
  `stackHeight`, pool/config mismatch between event and instruction, or referral inconsistency → the swap is an
  `issue` (carrying the pool), never a record. The engine scopes an issue to its tx (SPEC-v0.7 Clarification 22).

## 2. What a keeper verifies before signing an outside-SELL attestation

1. **Finality.** `getTransaction(sig, {commitment: "finalized", maxSupportedTransactionVersion: 1})` from the
   keeper's **own** RPC returns the tx (not a webhook body, not another keeper's copy). Sign only at
   `finalized` (~13 s); never at `confirmed`.
2. **Success.** `meta.err === null` (`status: "ok"`). Failed txs revert; they never yield records.
3. **Re-derive the record** with `parseMeteoraTrades(tx, {baseMints: FUMPAD mints})`; the trade with the
   claimed `ixKey` must exist, `issues` for that `ixKey` must be empty, and every attested field must be
   byte-equal to the keeper's own derivation: `signature, ixKey, venue, pool, baseMint, quoteMint, side =
   "sell", trader, baseAmount, quoteGross, slot, blockTime`.
4. **Uniqueness key** = `(signature, ixKey)`, `ixKey = (topIx << 16) | (innerIx + 1)` of the swap
   instruction. Deterministic on every node (inner instructions are part of consensus tx status). The
   on-chain program must store a consumed marker per key (e.g. a PDA seeded by `[sig[0..32], sig[32..64],
   ixKey]`, or a per-mint bitmap/merkle of consumed keys) so the same swap can't be attested twice, and a tx
   with two sells yields two independent keys.
5. **Pool belongs to FUMPAD.** DBC: `config` (from the event, cross-checked with the instruction's config
   account) is a FUMPAD config key. DAMM v2: the pool was created by `migration_damm_v2` from a FUMPAD DBC
   pool (`parsePoolFacts`: DBC instruction + DAMM `EvtInitializePool` in the same successful tx agree on
   pool and mints). Keepers keep this pool set from chain data, not from the indexer DB.
   Policy (contract side to confirm): DAMM v2 pools created by third parties for a FUMPAD mint do **not**
   count (they'd let anyone create a thin pool and mint cheap tickets at manipulated prices).
6. **Trader attribution must be strong.** Attest only `traderSource ∈ {base_owner_signer, signer_net_base}`:
   - `base_owner_signer`: owner of the base-side token account (sell = input account) signed the tx.
   - `signer_net_base`: base account is a router intermediate (OKX `ARu4n5…`, Jupiter program authority),
     and exactly one signer's net base-token change across the tx has the swap's sign.
   - **Refuse** `base_owner_unsigned` (PDA/smart-wallet/program-driven sells, e.g. fixture
     `damm_program_seller_v1`: a program PDA signs via CPI, tokens came from a third account) and `unknown`.
   - Fee payer ≠ trader is normal (OKX fixture: payer `6R7C…`, trader `pUmR…` both signed). The fee payer
     is never the trader by default.
7. **Amount cross-checks** (already inside the parser; keeper relies on it running fail-closed): vault
   deltas == event amounts; DBC `EvtSwap` == `EvtSwap2`; input fee == sum of fee parts; DAMM
   `included_transfer_fee_amount_out == output_amount`.
8. **Price for the ticket** = `quoteGross / baseAmount`, where for a sell `quoteGross = quote out BEFORE
   fees` (DBC: `output_amount + trading_fee + protocol_fee + referral_fee`; DAMM v2: `output_amount +
   claiming + protocol + compounding + referral` when the fee is on the output, i.e. every A→B / quote-out
   sell in a migrated pool). Use integer math (Q64 like the curve: `quoteGross << 64 / baseAmount`).
   `quoteMint` must be WSOL (or a quote the program prices) — reject others.
9. **USD ≥ $50 check timing.** Value = `quoteGross` lamports × Pyth SOL/USD at the **trade's slot/blockTime**,
    not at attestation time: keepers read the Pyth price update whose `publish_time` is the latest ≤
    `blockTime` and within a max staleness (e.g. 60 s); confidence interval bounded. If keepers can't agree
    on one Pyth update, the program can take the USD check itself: attestation carries `blockTime`, the
    claimer passes a Pyth `PriceUpdateV2` and the program enforces `|publish_time − blockTime| ≤ X`.
10. **Not wash / rebuy.** Outside sells inherit the on-chain rebuy/hold rules (section 5): the keeper checks
    the hold-time inputs at the trade's slot. A buy+sell of the same wallet in the same tx (fixture
    `damm_two_swaps`: net base delta 0) must never produce a ticket.

## 3. 2-of-3 independent re-derivation

- Each keeper runs its own RPC provider (three different providers), its own copy of this parser (pinned
  version + IDL hash in `src/idl/*.idl.ts`), and builds the pool set itself from finalized chain data.
- Inputs it accepts from outside: only `(signature, ixKey)` candidates (from the indexer, a webhook, or a
  user claim). Everything else is re-fetched and re-derived; nothing from the request is trusted.
- Each keeper signs the canonical message: `"FUMPAD-OUTSIDE-SELL-v1" ‖ program id ‖ mint ‖ pool ‖ venue ‖
  signature ‖ ixKey ‖ trader ‖ baseAmount ‖ quoteGross ‖ slot ‖ blockTime ‖ usdCents ‖ pythPublishTime`
  (fixed-width little-endian, Ed25519). Two matching signatures over identical bytes are required; a keeper
  that derives a different record simply doesn't sign (no tie-break needed with 2-of-3).

## 4. What the on-chain program must check

- 2 distinct signatures from the current 3-keeper set over the canonical message (Ed25519 program
  instruction introspection), domain-separated and bound to this program id + cluster.
- `(signature, ixKey)` not consumed; mark consumed atomically with ticket creation.
- `mint`/`pool` belong to the coin: DBC pool PDA from (config, base, quote) matches the coin's recorded
  pool; DAMM pool equals the coin's recorded graduated pool (record it at graduation from the migration).
- `trader` = ticket owner; the ticket's sell price from `quoteGross/baseAmount`; `usdCents ≥ 5000`.
- `slot`/`blockTime` within the claim window (e.g. attestations older than N hours rejected) and after the
  coin's launch; ticket math identical to in-app sells.
- Program cannot see the trade itself: everything above is only as good as the keepers' re-derivation,
  which is why the 2-of-3 and the strict trader rule matter.

## 5. Hold-time / rebuy-rule inputs (outside buys + transfers)

- **Outside buys**: every `side = "buy"` record (any app) for a FUMPAD pool, attributed to `trader`, with
  `baseAmount` and slot → per-wallet acquisition timeline (`meteora_trades_trader` index). Router buys with
  intermediate accounts resolve via `signer_net_base`; buys credited to a non-signer owner
  (`base_owner_unsigned`, e.g. a buy *for* another wallet) credit the **owner of the receiving account**.
- **Transfers**: wallet-to-wallet moves of a FUMPAD mint don't touch Meteora, so they need their own feed:
  - cheapest exact source: `getSignaturesForAddress(mint)` catches `TransferChecked` / ATA creation /
    burns (they reference the mint account) but **not** plain SPL `Transfer` (no mint account). So also
    index per-holder token accounts: for each wallet with a FUMPAD position, track its ATA
    (`getSignaturesForAddress(ata)`) and diff `pre/postTokenBalances` per owner for the mint.
  - at scale: Helius webhooks / LaserStream (Yellowstone) filtered on the mint's token accounts, still
    re-fetched from our RPC (same H-1 rule); or a token-balance-change stream.
  - rule input = per-wallet `(slot, delta, counterparty)` list; transfers OUT reset/attribute hold time per
    the contract's rule; transfers IN from another wallet don't create "rebuys" unless the contract says so.
- Same wallet in the same tx buying and selling (`damm_two_swaps`) = zero hold time.

## 6. Open items

- GMGN / Photon / Trojan / Padre trades were **not found** in the ~1,100 sampled mainnet txs (they likely
  call DBC directly with a SOL fee transfer to a fee wallet); `FEE_WALLETS` is empty because no wallet could
  be verified as theirs — app labels for those are UNVERIFIED and show as `direct`. Labels never affect
  attestations.
- Unlabelled router programs observed CPI-ing into DAMM v2: `ApexMZD5…`, `cockB8Lq…`, `b1oomGG…`,
  `3s1rAymU…` (reported as `unknown_program` with the program id as evidence).
