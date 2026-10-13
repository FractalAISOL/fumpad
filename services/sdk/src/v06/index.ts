/**
 * @fumpad/sdk — typed client for the FUMPAD programs.
 *
 * Built on @solana/web3.js v1 (the app's wallet adapter speaks v1 `Transaction` /
 * `VersionedTransaction`) and @anchor-lang/core's BorshCoder (matches anchor-cli 1.2.1,
 * the IDL generator). Browser-safe: no node: imports.
 */
export * from "./accounts.js";
export * from "./borsh.js";
export * from "./client.js";
export * from "./coder.js";
export * from "./constants.js";
export * from "./errors.js";
export * from "./events.js";
export * from "./instructions/index.js";
export * from "./math/index.js";
export * from "./params.js";
export * from "./pda.js";
export * from "./quote.js";
export * from "./units.js";
export * from "./vanity.js";
