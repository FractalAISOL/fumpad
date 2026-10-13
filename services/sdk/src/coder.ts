import { BorshCoder, type Idl } from "@anchor-lang/core";

import { FUMPAD_IDL, FUMPAD_IDL_SHA256 } from "./idl/fumpad.idl.js";

export { FUMPAD_IDL, FUMPAD_IDL_SHA256 };

let fumpad: BorshCoder | undefined;

/** Borsh coder for the fumpad v0.7 program (instructions, events, borsh accounts). */
export function fumpadCoder(): BorshCoder {
  return (fumpad ??= new BorshCoder(FUMPAD_IDL));
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
