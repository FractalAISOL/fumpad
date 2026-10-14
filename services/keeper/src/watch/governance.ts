/**
 * Governance alerts (SPEC v0.7 C-TL): with the timelocks at 1 h (params, DBC-config allow-list) and 6 h
 * (admin / treasury / guardian), the guardian has to see every queued change at once. The watcher reads `Global`
 * every tick and alerts while a change is pending — i.e. after `ParamsQueued` / `ConfigQueued` / `AdminProposed`
 * until it is executed or cancelled. State-based (not log-based), so a missed log or a watcher restart can't hide
 * a pending change; the Alerter's cooldown re-sends it every WATCH_ALERT_COOLDOWN_MS (30 min) until it's gone.
 */
import { PublicKey } from "@solana/web3.js";

import type { GlobalAccount, Params } from "@fumpad/sdk";

export interface GovernanceAlert {
  key: string;
  text: string;
}

const iso = (t: bigint) => new Date(Number(t) * 1000).toISOString();
const left = (eta: bigint, now: number) => {
  const s = Number(eta) - now;
  if (s <= 0) return "executable NOW";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `executable in ${h}h${String(m).padStart(2, "0")}m`;
};
const str = (v: unknown) => (v instanceof PublicKey ? v.toBase58() : String(v));

/** Fields of `Params` that the pending change modifies, as `name a→b`. */
export function paramsDiff(cur: Params | undefined, next: Params | undefined): string[] {
  if (!cur || !next) return [];
  const out: string[] = [];
  for (const k of Object.keys(next) as (keyof Params)[]) {
    const a = str(cur[k]);
    const b = str(next[k]);
    if (a !== b) out.push(`${k} ${a}→${b}`);
  }
  return out;
}

/** One alert per pending governance change in `g` (none when nothing is pending). Tolerates partial `Global`s. */
export function governanceAlerts(g: Partial<GlobalAccount>, now: number): GovernanceAlert[] {
  const out: GovernanceAlert[] = [];
  const pendingEta = g.pendingEta ?? 0n;
  if (pendingEta > 0n) {
    const diff = paramsDiff(g.params, g.pendingParams);
    out.push({
      key: `gov:params:${pendingEta}`,
      text: `GOVERNANCE: params change queued (ParamsQueued), eta ${iso(pendingEta)} (${left(pendingEta, now)}): ${
        diff.length ? diff.join("; ").slice(0, 1500) : "no field differs"
      }. Not expected → guardian cancel_params before the eta.`,
    });
  }
  const configEta = g.pendingConfigEta ?? 0n;
  if (configEta > 0n && g.pendingConfig && !g.pendingConfig.equals(PublicKey.default)) {
    const add = g.pendingConfigAdd ? "ADD" : "REMOVE";
    out.push({
      key: `gov:config:${g.pendingConfig.toBase58()}:${add}:${configEta}`,
      text: `GOVERNANCE: DBC config allow-list ${add} ${g.pendingConfig.toBase58()} queued (ConfigQueued), eta ${iso(configEta)} (${left(configEta, now)}). Not expected → guardian cancel_config before the eta.`,
    });
  }
  const adminEta = g.pendingAdminEta ?? 0n;
  if (adminEta > 0n) {
    const changes = [
      ["admin", g.admin, g.pendingAdmin],
      ["platform_treasury", g.platformTreasury, g.pendingTreasury],
      ["guardian", g.guardian, g.pendingGuardian],
    ] as const;
    const desc = changes.map(([n, a, b]) => `${n} ${a?.toBase58() ?? "?"}→${b?.toBase58() ?? "?"}${a && b && a.equals(b) ? " (same)" : ""}`).join("; ");
    out.push({
      key: `gov:admin:${g.pendingAdmin?.toBase58() ?? "?"}:${adminEta}`,
      text: `GOVERNANCE: authority change proposed (AdminProposed), eta ${iso(adminEta)} (${left(adminEta, now)}): ${desc}. Not expected → guardian cancel_admin before the eta.`,
    });
  }
  return out;
}
