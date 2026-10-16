/**
 * Login failure messages (Phantom Testnet Mode vs. any wallet that didn't sign) and the
 * stale-session recovery (clean logout, cleared storage, no loops).
 *
 *   npm test
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classifyLoginError,
  clearStalePrivyStorage,
  createSessionRecovery,
  isStaleSession,
  type KeyStorage,
  type LoginNotice,
  NOTICES,
  RECOVERY_COOLDOWN_MS,
} from "./loginErrors";

describe("classifyLoginError", () => {
  const base = { walletNames: [] as string[], cluster: "devnet" as const };

  it("Phantom signature failure on a devnet build: Testnet Mode, with the settings path", () => {
    const n = classifyLoginError({ ...base, code: "generic_connect_wallet_error", walletNames: ["Phantom"] });
    assert.equal(n?.kind, "phantom-testnet");
    assert.match(n!.body, /Phantom is in Testnet Mode\. Turn it off \(Phantom → Settings → Developer Settings → Testnet Mode\) and try again\./);
  });

  it("every wallet-signature code maps the same way", () => {
    for (const code of ["generic_connect_wallet_error", "unknown_connect_wallet_error", "unable_to_sign", "invalid_message"]) {
      assert.equal(classifyLoginError({ ...base, code, walletNames: ["Phantom"] })?.kind, "phantom-testnet", code);
      assert.equal(classifyLoginError({ ...base, code, walletNames: ["Solflare"] })?.kind, "wallet-signature", code);
    }
  });

  it("other wallets get the generic message", () => {
    const n = classifyLoginError({ ...base, code: "generic_connect_wallet_error", walletNames: ["Backpack"] });
    assert.deepEqual(n, NOTICES["wallet-signature"]);
    assert.equal(n?.body, "Your wallet didn't sign the login message. Try again, or use email login.");
  });

  it("no wallet reported: falls back to whether Phantom is installed", () => {
    assert.equal(classifyLoginError({ ...base, code: "unable_to_sign", phantomInstalled: true })?.kind, "phantom-testnet");
    assert.equal(classifyLoginError({ ...base, code: "unable_to_sign", phantomInstalled: false })?.kind, "wallet-signature");
    // A connected Solflare wins over an installed Phantom.
    assert.equal(classifyLoginError({ ...base, code: "unable_to_sign", walletNames: ["Solflare"], phantomInstalled: true })?.kind, "wallet-signature");
  });

  it("mainnet build: Phantom gets the generic message plus the Testnet Mode hint", () => {
    const n = classifyLoginError({ code: "generic_connect_wallet_error", walletNames: ["Phantom"], cluster: "mainnet" });
    assert.equal(n?.kind, "wallet-signature");
    assert.match(n!.body, /didn't sign the login message.*If Phantom is in Testnet Mode, turn it off first/);
  });

  it("an error text naming the network is Testnet Mode even on mainnet", () => {
    const n = classifyLoginError({ code: "generic_connect_wallet_error", walletNames: ["Phantom"], cluster: "mainnet", message: "Network mismatch: wallet is on testnet" });
    assert.equal(n?.kind, "phantom-testnet");
  });

  it("ambiguous auth codes only count as a wallet failure when a wallet was involved", () => {
    assert.equal(classifyLoginError({ ...base, code: "unknown_auth_error" }), null);
    assert.equal(classifyLoginError({ ...base, code: "unknown_auth_error", walletNames: ["Phantom"] })?.kind, "phantom-testnet");
    assert.equal(classifyLoginError({ ...base, code: "invalid_credentials", walletNames: ["Solflare"] })?.kind, "wallet-signature");
  });

  it("closing the window, OAuth cancel and errors Privy explains itself stay silent", () => {
    for (const code of ["exited_auth_flow", "oauth_user_denied", "allowlist_rejected", "max_accounts_reached", "user_does_not_exist"]) {
      assert.equal(classifyLoginError({ ...base, code, walletNames: ["Phantom"] }), null, code);
    }
  });

  it("invalid/missing token is a session problem", () => {
    assert.equal(classifyLoginError({ ...base, code: "missing_or_invalid_token" })?.kind, "session-expired");
    assert.equal(classifyLoginError({ ...base, code: "must_be_authenticated" })?.body, "Your session expired. Log in again.");
  });

  it("unrelated codes stay silent", () => {
    assert.equal(classifyLoginError({ ...base, code: "too_many_requests" }), null);
    assert.equal(classifyLoginError({ ...base, code: "something_new" }), null);
  });
});

class MemStorage implements KeyStorage {
  m = new Map<string, string>();
  constructor(init: Record<string, string> = {}) {
    for (const [k, v] of Object.entries(init)) this.m.set(k, v);
  }
  get length() {
    return this.m.size;
  }
  key(i: number) {
    return [...this.m.keys()][i] ?? null;
  }
  getItem(k: string) {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, v);
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
}

describe("clearStalePrivyStorage", () => {
  it("removes Privy's session keys only, across stores", () => {
    const local = new MemStorage({
      "privy:token": "a",
      "privy:refresh_token": "b",
      "privy:id_token": "c",
      "privy:connections": "[]",
      "privy:token:app": "d",
      "privy:caid": "keep",
      "privy:tokenizer": "keep",
      "fumpad.wallet.signer.v1": "external",
    });
    const session = new MemStorage({ "privy:pat": "x", "fumpad.instant.spent.v1": "5" });
    const removed = clearStalePrivyStorage([local, null, session]);
    assert.deepEqual(removed.sort(), ["privy:connections", "privy:id_token", "privy:pat", "privy:refresh_token", "privy:token", "privy:token:app"]);
    assert.deepEqual([...local.m.keys()].sort(), ["fumpad.wallet.signer.v1", "privy:caid", "privy:tokenizer"]);
    assert.deepEqual([...session.m.keys()], ["fumpad.instant.spent.v1"]);
  });

  it("a blocked storage doesn't throw", () => {
    const blocked = {
      get length(): number {
        throw new Error("SecurityError");
      },
    } as unknown as KeyStorage;
    assert.deepEqual(clearStalePrivyStorage([blocked]), []);
  });
});

describe("isStaleSession", () => {
  it("no token or an error means stale; a token means fine", () => {
    assert.equal(isStaleSession({ token: null }), true);
    assert.equal(isStaleSession({ token: "" }), true);
    assert.equal(isStaleSession({ error: new Error("Error authenticating session") }), true);
    assert.equal(isStaleSession({ token: "eyJ..." }), false);
  });
});

describe("createSessionRecovery", () => {
  function setup(opts: { logoutFails?: boolean; memory?: MemStorage } = {}) {
    let t = 1_000_000;
    const calls: string[] = [];
    const notices: LoginNotice[] = [];
    const rec = createSessionRecovery({
      logout: async () => {
        calls.push("logout");
        if (opts.logoutFails) throw new Error("Error authenticating session");
      },
      clearStale: () => calls.push("clear"),
      notify: (n) => notices.push(n),
      reload: () => calls.push("reload"),
      now: () => t,
      memory: opts.memory ?? new MemStorage(),
    });
    return { rec, calls, notices, advance: (ms: number) => (t += ms) };
  }

  it("logs out, clears the stale state, then says the session expired", async () => {
    const { rec, calls, notices } = setup();
    assert.equal(await rec.recover(), true);
    assert.deepEqual(calls, ["logout", "clear"]);
    assert.deepEqual(notices, [NOTICES["session-expired"]]);
  });

  it("a logout that throws still clears and reloads (once)", async () => {
    const { rec, calls, notices } = setup({ logoutFails: true });
    assert.equal(await rec.recover(), true);
    assert.deepEqual(calls, ["logout", "clear", "reload"]);
    assert.equal(notices.length, 1);
  });

  it("concurrent triggers recover once", async () => {
    const { rec, calls } = setup();
    const results = await Promise.all([rec.recover(), rec.recover(), rec.recover()]);
    assert.deepEqual(results, [true, false, false]);
    assert.equal(calls.filter((c) => c === "logout").length, 1);
  });

  it("no loop: a second failure inside the cooldown is ignored, after it recovers again", async () => {
    const { rec, calls, advance } = setup();
    await rec.recover();
    advance(RECOVERY_COOLDOWN_MS - 1);
    assert.equal(await rec.recover(), false);
    advance(1);
    assert.equal(await rec.recover(), true);
    assert.equal(calls.filter((c) => c === "logout").length, 2);
  });

  it("the cooldown survives a reload (shared sessionStorage)", async () => {
    const memory = new MemStorage();
    const first = setup({ memory, logoutFails: true });
    await first.rec.recover();
    // The page reloads: a fresh recovery object, same clock, same sessionStorage.
    const second = setup({ memory });
    assert.equal(await second.rec.recover(), false);
    assert.deepEqual(second.calls, []);
  });
});
