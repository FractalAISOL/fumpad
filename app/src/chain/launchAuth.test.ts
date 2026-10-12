/**
 * M-2 launch ownership message: exact format, the message allow-list (what the Trading wallet
 * may sign without a prompt), the per-(creator, symbol) cache and the signer gate.
 *
 *   npm test
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ed25519 } from "@noble/curves/ed25519";
import { Keypair, PublicKey, type VersionedTransaction } from "@solana/web3.js";
import { SilentSignRefused } from "./allowlist";
import {
  cachedLaunchAuth,
  dropLaunchAuth,
  getLaunchAuth,
  LAUNCH_AUTH_MAX_AGE_MS,
  LAUNCH_AUTH_REUSE_MARGIN_MS,
  launchAuthMessage,
  newNonce,
  parseLaunchAuthMessage,
  vetLaunchAuthMessage,
} from "./launchAuth";
import { type FumpadSigner, signLaunchMessage } from "./signer";

const seed = new Uint8Array(32).fill(7);
const kp = Keypair.fromSeed(seed);
const creator = kp.publicKey.toBase58();
const other = Keypair.generate().publicKey.toBase58();
const NOW = 1_791_839_490_559;
const NONCE = "abcDEF0123456789_-xy";
const msg = (o: Partial<{ creator: string; symbol: string; nonce: string; issuedAt: number }> = {}) =>
  launchAuthMessage({ creator, symbol: "PIGN", nonce: NONCE, issuedAt: NOW, ...o });
const sign = (m: Uint8Array) => ed25519.sign(m, seed);

describe("launch auth message format", () => {
  it("is exactly the five lines the API verifies", () => {
    assert.equal(msg(), `FUMPAD launch\ncreator: ${creator}\nsymbol: PIGN\nnonce: ${NONCE}\nissuedAt: ${NOW}`);
  });

  it("nonces are 16-64 chars of [A-Za-z0-9_-] and differ each time", () => {
    const a = newNonce();
    assert.match(a, /^[A-Za-z0-9_-]{16,64}$/);
    assert.notEqual(a, newNonce());
  });

  it("parses only the canonical form", () => {
    assert.deepEqual(parseLaunchAuthMessage(msg()), { creator, symbol: "PIGN", nonce: NONCE, issuedAt: NOW });
    const bad = [
      msg().replace("FUMPAD launch", "FUMPAD Launch"),
      msg() + "\n",
      msg().replace(/\n/g, "\r\n"),
      msg().replace("symbol: PIGN", "symbol:  PIGN"),
      msg().replace("symbol: PIGN", "symbol: PI GN"),
      msg().replace("symbol: PIGN", "symbol: "),
      msg({ symbol: "ABCDEFGHIJK" }), // 11 > 10 bytes
      msg({ symbol: "PІGN" }), // Cyrillic І
      msg({ nonce: "short" }),
      msg({ nonce: "x".repeat(65) }),
      msg({ nonce: "has space in it!!" }),
      msg().replace(`issuedAt: ${NOW}`, `issuedAt: 0${NOW}`),
      msg().replace(`issuedAt: ${NOW}`, `issuedAt: ${NOW}.0`),
      msg().replace(`issuedAt: ${NOW}`, "issuedAt: 1e12"),
      msg().replace(`creator: ${creator}`, "creator: not-a-key"),
      ["FUMPAD launch", `symbol: PIGN`, `creator: ${creator}`, `nonce: ${NONCE}`, `issuedAt: ${NOW}`].join("\n"), // order
      "Sign in to FUMPAD",
    ];
    for (const m of bad) assert.equal(parseLaunchAuthMessage(m), null, JSON.stringify(m));
  });
});

describe("launch auth message allow-list (silent signMessage)", () => {
  const refused = (fn: () => unknown, re: RegExp) => assert.throws(fn, (e: unknown) => e instanceof SilentSignRefused && re.test(e.message));

  it("passes a fresh launch message for this wallet (text or bytes)", () => {
    assert.equal(vetLaunchAuthMessage(msg(), creator, { now: NOW }).symbol, "PIGN");
    assert.equal(vetLaunchAuthMessage(new TextEncoder().encode(msg()), new PublicKey(creator), { symbol: "PIGN", now: NOW + 1000 }).nonce, NONCE);
  });

  it("refuses anything else", () => {
    refused(() => vetLaunchAuthMessage("hello", creator, { now: NOW }), /isn't a FUMPAD launch message/);
    refused(() => vetLaunchAuthMessage(msg() + "\nextra: 1", creator, { now: NOW }), /isn't a FUMPAD launch message/);
    refused(() => vetLaunchAuthMessage(msg(), other, { now: NOW }), /another wallet/);
    refused(() => vetLaunchAuthMessage(msg(), creator, { symbol: "COPE", now: NOW }), /another ticker/);
    refused(() => vetLaunchAuthMessage(msg(), creator, { now: NOW + LAUNCH_AUTH_MAX_AGE_MS + 1 }), /out of date/);
    refused(() => vetLaunchAuthMessage(msg(), creator, { now: NOW - 61_000 }), /out of date/);
    refused(() => vetLaunchAuthMessage(new Uint8Array([0xff, 0xfe, 0x00]), creator, { now: NOW }), /isn't text/);
    refused(() => vetLaunchAuthMessage("x".repeat(600), creator, { now: NOW }), /too long/);
    // A transaction message is not a launch message, whatever its bytes.
    refused(() => vetLaunchAuthMessage(new Uint8Array(200).fill(1), creator, { now: NOW }), /FUMPAD launch message/);
  });
});

describe("launch auth cache and signing", () => {
  it("signs once per (creator, symbol), reuses it, then signs again near expiry", async () => {
    let t = NOW;
    let calls = 0;
    const signer = async (m: Uint8Array) => {
      calls++;
      return sign(m);
    };
    const a = await getLaunchAuth(kp.publicKey, "PIGN", signer, { now: () => t });
    assert.equal(a.fresh, true);
    assert.equal(calls, 1);
    assert.ok(parseLaunchAuthMessage(a.auth.message));
    // base64 of 64 bytes, as the API accepts it, and it verifies against the creator key.
    assert.match(a.auth.signature, /^[A-Za-z0-9+/]{86}==$/);
    assert.ok(ed25519.verify(Buffer.from(a.auth.signature, "base64"), new TextEncoder().encode(a.auth.message), kp.publicKey.toBytes()));

    t += 5 * 60_000;
    const b = await getLaunchAuth(kp.publicKey, "PIGN", signer, { now: () => t });
    assert.equal(b.fresh, false);
    assert.equal(b.auth, a.auth);
    // Another ticker is another message.
    const c = await getLaunchAuth(kp.publicKey, "COPE", signer, { now: () => t });
    assert.equal(c.fresh, true);
    assert.equal(calls, 2);

    t = NOW + LAUNCH_AUTH_MAX_AGE_MS - LAUNCH_AUTH_REUSE_MARGIN_MS + 1;
    assert.equal(cachedLaunchAuth(creator, "PIGN", t), null);
    const d = await getLaunchAuth(kp.publicKey, "PIGN", signer, { now: () => t });
    assert.equal(d.fresh, true);
    assert.equal(calls, 3);

    dropLaunchAuth(creator, "PIGN");
    assert.equal(cachedLaunchAuth(creator, "PIGN", t), null);
    dropLaunchAuth(creator, "COPE");
  });

  it("rejects a wallet signature over anything but the exact message", async () => {
    const prefixed = async (m: Uint8Array) => sign(new Uint8Array([0xff, ...m]));
    await assert.rejects(getLaunchAuth(kp.publicKey, "BAD", prefixed, { now: () => NOW }), /doesn't match the launch message/);
    assert.equal(cachedLaunchAuth(creator, "BAD", NOW), null);
  });

  it("the signer gate vets first and is silent only for the instant Trading wallet", async () => {
    const seen: { silent: boolean }[] = [];
    const mk = (kind: "embedded" | "external"): FumpadSigner => ({
      publicKey: kp.publicKey,
      kind,
      name: kind,
      sign: async (tx: VersionedTransaction) => tx,
      signMessage: async (m, opts) => {
        seen.push(opts);
        return sign(m);
      },
    });
    const fresh = new TextEncoder().encode(msg({ issuedAt: Date.now() }));
    await signLaunchMessage(mk("embedded"), fresh, true);
    await signLaunchMessage(mk("embedded"), fresh, false);
    await signLaunchMessage(mk("external"), fresh, true);
    assert.deepEqual(seen, [{ silent: true }, { silent: false }, { silent: false }]);
    // Never reaches the wallet: not a launch message, or one for another wallet.
    await assert.rejects(signLaunchMessage(mk("embedded"), new TextEncoder().encode("Sign in to FUMPAD"), true), SilentSignRefused);
    await assert.rejects(signLaunchMessage(mk("external"), new TextEncoder().encode(msg({ creator: other, issuedAt: Date.now() })), false), SilentSignRefused);
    assert.equal(seen.length, 3);
  });
});
