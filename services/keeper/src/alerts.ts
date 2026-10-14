/** Optional Telegram alert hook (TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID), deduplicated per key. */
import { createHash } from "node:crypto";

import type { Logger } from "pino";

/** A failing coin derivation re-alerts at most once per hour per (coin, error signature). */
export const DERIVE_ALERT_COOLDOWN_MS = 60 * 60_000;

/**
 * Stable signature of an error for alert deduplication: its class + message with base58 keys / signatures and numbers
 * blanked (slots, counts, offsets change from tick to tick without being a new problem). A different error class or
 * wording is a different signature and alerts at once.
 */
export function errorSignature(e: unknown): string {
  const name = e instanceof Error ? e.name : typeof e;
  const msg = (e instanceof Error ? e.message : String(e)).replace(/[1-9A-HJ-NP-Za-km-z]{32,88}/g, "<key>").replace(/\d+/g, "#");
  return createHash("sha256").update(`${name}\n${msg}`).digest("hex").slice(0, 12);
}

/** Alert key + options for a coin's derivation failure (attestor and watcher). */
export function deriveAlert(scope: string, mint: string, e: unknown): { key: string; opts: { cooldownMs: number } } {
  return { key: `${scope}:${mint}:${errorSignature(e)}`, opts: { cooldownMs: DERIVE_ALERT_COOLDOWN_MS } };
}

export class Alerter {
  private last = new Map<string, number>();
  sent = 0;

  constructor(private log: Logger, private opts: { botToken?: string; chatId?: string; cooldownMs?: number; prefix?: string; now?: () => number }) {}

  get enabled() {
    return !!(this.opts.botToken && this.opts.chatId);
  }

  /** Send unless the same key alerted within the cooldown (default 15 min, or `o.cooldownMs`). Never throws. */
  async alert(key: string, text: string, o: { cooldownMs?: number } = {}): Promise<void> {
    const now = this.opts.now?.() ?? Date.now();
    const cooldown = o.cooldownMs ?? this.opts.cooldownMs ?? 15 * 60_000;
    if ((this.last.get(key) ?? Number.NEGATIVE_INFINITY) + cooldown > now) return;
    this.last.set(key, now);
    // keys carry error signatures: forget the ones that have been quiet for a day (bounded memory)
    if (this.last.size > 1_000) for (const [k, t] of this.last) if (now - t > 24 * 3_600_000) this.last.delete(k);
    this.log.warn({ alert: key }, text);
    if (!this.enabled) return;
    try {
      const res = await fetch(`https://api.telegram.org/bot${this.opts.botToken}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: this.opts.chatId, text: `${this.opts.prefix ?? "[fumpad-keeper]"} ${text}`.slice(0, 4000), disable_web_page_preview: true }),
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) this.log.warn({ status: res.status }, "telegram alert failed");
      else this.sent++;
    } catch (e) {
      this.log.warn({ err: String(e) }, "telegram alert failed");
    }
  }

  /** Clear a key so the next failure alerts immediately (call on recovery). */
  resolve(key: string) {
    this.last.delete(key);
  }
}
