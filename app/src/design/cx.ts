/** Joins class names, skipping falsy values. */
export function cx(...xs: (string | false | null | undefined)[]): string {
  return xs.filter(Boolean).join(" ");
}
