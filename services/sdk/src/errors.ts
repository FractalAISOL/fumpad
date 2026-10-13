/** fumpad v0.7 error codes (from the IDL) + extraction from RPC / simulation errors. */
import { FUMPAD_IDL } from "./coder.js";

type IdlErr = { code: number; name: string; msg?: string };
const fumpadErrors = new Map(((FUMPAD_IDL.errors as IdlErr[] | undefined) ?? []).map((e) => [e.code, e]));

export const FUMPAD_ERROR: Record<string, number> = Object.fromEntries([...fumpadErrors.values()].map((e) => [e.name, e.code]));

/** `{"InstructionError":[i,{"Custom":n}]}` (any nesting / string form) → n. */
export function customErrorCode(err: unknown): number | null {
  const s = typeof err === "string" ? err : JSON.stringify(err ?? null);
  const m = /"?Custom"?\s*[:(]\s*(\d+)/.exec(s) ?? /custom program error: 0x([0-9a-f]+)/i.exec(s);
  if (!m) return null;
  return m[0].includes("0x") ? parseInt(m[1], 16) : Number(m[1]);
}

/** fumpad error name for a code. */
export function errorName(code: number): string | undefined {
  return fumpadErrors.get(code)?.name;
}
