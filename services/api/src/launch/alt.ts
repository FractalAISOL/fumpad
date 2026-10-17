/**
 * The launch address lookup table (LAUNCH_ALT; @fumpad/sdk `launchAltAddresses` / `loadLaunchAlt`). Prepare builds
 * every launch through it, so a max-length name + ticker + the https metadata uri + a first buy + the launch
 * co-signature fit one transaction.
 *
 * Fail closed: on every cluster but localnet, a missing LAUNCH_ALT, a table that isn't on chain, or one whose contents
 * aren't exactly the expected accounts (or that isn't frozen) refuses the launch (503) — never a launch through an
 * unverified table, never a silent fallback to the inline form (which can't carry the https uri the metadata route
 * promised). Only localnet without LAUNCH_ALT builds inline launches (tests, the local stack before its ALT exists).
 *
 * The table is frozen (no authority: immutable), so a verified copy is cached for the life of the process; a failed
 * check is not cached (the next prepare reads the chain again).
 */
import { type AddressLookupTableAccount, PublicKey } from "@solana/web3.js";

import { type AltReader, loadLaunchAlt } from "@fumpad/sdk";

import type { ApiConfig } from "../config.js";
import { LaunchError } from "./pool.js";

/** Whether this server builds launches through the ALT (so its launch transactions have the room the ALT gives). */
export const launchAltInUse = (cfg: Pick<ApiConfig, "launchAlt" | "launchAltRequired">) => !!cfg.launchAlt || cfg.launchAltRequired;

export class LaunchAltCache {
  private table: AddressLookupTableAccount | null = null;
  /** The last verification failure (for the server log; the client only gets a generic 503). */
  lastError: string | undefined;
  private readonly address: PublicKey | null;

  constructor(
    private conn: AltReader,
    private cfg: Pick<ApiConfig, "launchAlt" | "launchAltRequired">,
  ) {
    this.address = cfg.launchAlt ? new PublicKey(cfg.launchAlt) : null;
  }

  /** Why launches can't be built right now from config alone (LAUNCH_ALT missing where it's required), else undefined. */
  get disabledReason(): string | undefined {
    return !this.address && this.cfg.launchAltRequired ? "LAUNCH_ALT is not set (required on this cluster: every launch goes through the FUMPAD launch lookup table)" : undefined;
  }

  /** The verified launch ALT; null = inline launches (localnet without LAUNCH_ALT only). Throws a 503 LaunchError otherwise. */
  async get(): Promise<AddressLookupTableAccount | null> {
    if (this.table) return this.table;
    if (!this.address) {
      if (this.cfg.launchAltRequired) throw new LaunchError(503, "launches are not configured on this server (lookup table)");
      return null;
    }
    try {
      this.table = await loadLaunchAlt(this.conn, this.address);
      this.lastError = undefined;
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : "unreadable";
      throw new LaunchError(503, "launches are unavailable right now (the launch lookup table can't be verified)", 30);
    }
    return this.table;
  }
}
