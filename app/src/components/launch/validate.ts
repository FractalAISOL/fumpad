/**
 * The launch form's checks. Only the name and the ticker are required; the image, description, links and first buy
 * are optional (a coin without an image shows its monogram everywhere: `CoinTile`). Pure, tested by `validate.test.ts`.
 */
export interface LaunchFormErrors {
  name?: string;
  symbol?: string;
  description?: string;
  image?: string;
  x?: string;
  telegram?: string;
  website?: string;
}

export interface LaunchFormValues {
  name: string;
  symbol: string;
  description: string;
  x: string;
  telegram: string;
  website: string;
}

export const MAX_IMG = 4 * 1024 * 1024;
export const IMG_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

export function validateLaunch(v: LaunchFormValues): LaunchFormErrors {
  const e: LaunchFormErrors = {};
  if (!v.name.trim()) e.name = "Give the coin a name.";
  else if (v.name.length > 32) e.name = "Keep the name to 32 characters.";
  if (!v.symbol) e.symbol = "Pick a ticker.";
  else if (!/^[A-Z0-9]{2,10}$/.test(v.symbol)) e.symbol = "Use 2 to 10 letters or digits.";
  if (v.description.length > 280) e.description = "Keep it to 280 characters.";
  if (v.x && !/^@?[A-Za-z0-9_]{1,15}$/.test(v.x)) e.x = "Use an X handle, like @fumpad.";
  if (v.telegram && !/^(https:\/\/t\.me\/)?[A-Za-z0-9_]{4,32}$/.test(v.telegram)) e.telegram = "Use a t.me link or group name.";
  if (v.website && !/^https:\/\/\S+\.\S+/.test(v.website)) e.website = "Use a full https:// address.";
  return e;
}

/** A picked file's problem (type or size), or null. No file at all is fine: the image is optional. */
export function imageFileError(fl: { type: string; size: number }): string | null {
  if (!IMG_TYPES.includes(fl.type)) return "Use a PNG, JPG, GIF or WebP.";
  if (fl.size > MAX_IMG) return `That's ${(fl.size / 1024 / 1024).toFixed(1)} MB. The limit is 4 MB.`;
  return null;
}
