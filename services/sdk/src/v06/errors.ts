/** Program error codes from the IDLs + extraction from RPC/simulation errors. */
import { FUMPAD_IDL, LP_LOCKER_IDL } from "./coder.js";

type IdlErr = { code: number; name: string; msg?: string };
const fumpadErrors = new Map((FUMPAD_IDL.errors as IdlErr[] | undefined ?? []).map((e) => [e.code, e]));
const lockerErrors = new Map((LP_LOCKER_IDL.errors as IdlErr[] | undefined ?? []).map((e) => [e.code, e]));

export const FUMPAD_ERROR: Record<string, number> = Object.fromEntries([...fumpadErrors.values()].map((e) => [e.name, e.code]));
export const LOCKER_ERROR: Record<string, number> = Object.fromEntries([...lockerErrors.values()].map((e) => [e.name, e.code]));

/** `{"InstructionError":[i,{"Custom":n}]}` (any nesting / string form) → n. */
export function customErrorCode(err: unknown): number | null {
  const s = typeof err === "string" ? err : JSON.stringify(err ?? null);
  const m = /"?Custom"?\s*[:(]\s*(\d+)/.exec(s) ?? /custom program error: 0x([0-9a-f]+)/i.exec(s);
  if (!m) return null;
  return m[0].includes("0x") ? parseInt(m[1], 16) : Number(m[1]);
}

/** Error name for a code, given which program failed (fumpad by default). */
export function errorName(code: number, program: "fumpad" | "locker" = "fumpad"): string | undefined {
  return (program === "fumpad" ? fumpadErrors : lockerErrors).get(code)?.name;
}
