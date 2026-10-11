import { BorshCoder, type Idl } from "@anchor-lang/core";

import { FUMPAD_IDL } from "./idl/fumpad.idl.js";
import { LP_LOCKER_IDL } from "./idl/fumpad_lp_locker.idl.js";

export { FUMPAD_IDL, LP_LOCKER_IDL };

let fumpad: BorshCoder | undefined;
let locker: BorshCoder | undefined;

/** Borsh coder for the fumpad program (instructions, events, borsh accounts). */
export function fumpadCoder(): BorshCoder {
  return (fumpad ??= new BorshCoder(FUMPAD_IDL));
}
export function lockerCoder(): BorshCoder {
  return (locker ??= new BorshCoder(LP_LOCKER_IDL));
}

export interface IdlAccountItem {
  name: string;
  writable?: boolean;
  signer?: boolean;
  optional?: boolean;
  address?: string;
}
export interface IdlInstructionLite {
  name: string;
  discriminator: number[];
  accounts: IdlAccountItem[];
  args: { name: string; type: unknown }[];
}

export function idlInstruction(idl: Idl, name: string): IdlInstructionLite {
  const ix = (idl.instructions as unknown as IdlInstructionLite[]).find((i) => i.name === name);
  if (!ix) throw new Error(`instruction ${name} not in IDL ${idl.metadata?.name}`);
  return ix;
}
