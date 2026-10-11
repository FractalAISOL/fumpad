/** Optional Telegram alert hook (TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID), deduplicated per key. */
import type { Logger } from "pino";

export class Alerter {
  private last = new Map<string, number>();
  sent = 0;

  constructor(private log: Logger, private opts: { botToken?: string; chatId?: string; cooldownMs?: number; prefix?: string }) {}

  get enabled() {
    return !!(this.opts.botToken && this.opts.chatId);
  }

  /** Send unless the same key alerted within the cooldown (default 15 min). Never throws. */
  async alert(key: string, text: string): Promise<void> {
    const now = Date.now();
    const cooldown = this.opts.cooldownMs ?? 15 * 60_000;
    if ((this.last.get(key) ?? 0) + cooldown > now) return;
    this.last.set(key, now);
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
