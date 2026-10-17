/**
 * Coin image checks for `POST /v1/launch/metadata`: the bytes must be a PNG / JPEG / GIF / WebP (sniffed, the
 * declared type is ignored), within the size cap, with sane dimensions read from the header, and personal
 * metadata is dropped before the file is pinned to IPFS forever:
 *   - JPEG: every APP1 segment (EXIF incl. GPS, XMP) is removed; a non-default EXIF orientation is kept as a
 *     minimal one-tag EXIF block so phone photos don't turn sideways.
 *   - PNG: `eXIf`, `tEXt`, `zTXt`, `iTXt`, `tIME` chunks are removed (whole chunks, so no CRC is recomputed).
 *   - GIF / WebP: passed through unchanged (no EXIF in GIF; WebP EXIF stripping needs a container rewrite).
 * Pixels are never decoded or re-encoded here.
 */
import { type ImageType, sniffImage } from "../img.js";

export const LAUNCH_IMAGE_MAX_BYTES = 4 * 1024 * 1024;
export const LAUNCH_IMAGE_MIN_SIDE = 16;
export const LAUNCH_IMAGE_MAX_SIDE = 8192;
/** Decompression-bomb guard for everyone who renders the image later (40 MP). */
export const LAUNCH_IMAGE_MAX_PIXELS = 40_000_000;

export class ImageCheckError extends Error {}

const be16 = (b: Uint8Array, o: number) => (b[o] << 8) | b[o + 1];
const be32 = (b: Uint8Array, o: number) => ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
const le16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const le24 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
const tag = (b: Uint8Array, o: number) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);

/** Width × height from the header, or null when the header is truncated / not understood. */
export function imageDimensions(b: Uint8Array, type: ImageType): { width: number; height: number } | null {
  if (type === "image/png") {
    if (b.length < 24 || tag(b, 12) !== "IHDR") return null;
    return { width: be32(b, 16), height: be32(b, 20) };
  }
  if (type === "image/gif") return b.length >= 10 ? { width: le16(b, 6), height: le16(b, 8) } : null;
  if (type === "image/webp") {
    if (b.length < 30) return null;
    const kind = tag(b, 12);
    if (kind === "VP8 ") {
      if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
      return { width: le16(b, 26) & 0x3fff, height: le16(b, 28) & 0x3fff };
    }
    if (kind === "VP8L") {
      if (b[20] !== 0x2f) return null;
      return { width: 1 + (((b[22] & 0x3f) << 8) | b[21]), height: 1 + (((b[24] & 0x0f) << 10) | (b[23] << 2) | ((b[22] & 0xc0) >> 6)) };
    }
    if (kind === "VP8X") return { width: 1 + le24(b, 24), height: 1 + le24(b, 27) };
    return null;
  }
  // JPEG: walk the segments to the first SOFn.
  let o = 2;
  while (o + 4 <= b.length) {
    if (b[o] !== 0xff) return null;
    const m = b[o + 1];
    if (m === 0xff) {
      o++;
      continue;
    }
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
      o += 2;
      continue;
    }
    if (m === 0xd9 || m === 0xda) return null;
    const len = be16(b, o + 2);
    if (len < 2) return null;
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      if (o + 9 > b.length) return null;
      return { width: be16(b, o + 7), height: be16(b, o + 5) };
    }
    o += 2 + len;
  }
  return null;
}

/** EXIF orientation (1-8) from an APP1 "Exif\0\0" payload, or null. */
function exifOrientation(p: Uint8Array): number | null {
  if (p.length < 14 || tag(p, 0) !== "Exif" || p[4] !== 0 || p[5] !== 0) return null;
  const t = 6;
  const le = p[t] === 0x49 && p[t + 1] === 0x49;
  if (!le && !(p[t] === 0x4d && p[t + 1] === 0x4d)) return null;
  const u16 = (o: number) => (le ? le16(p, o) : be16(p, o));
  const u32 = (o: number) => (le ? (p[o] | (p[o + 1] << 8) | (p[o + 2] << 16)) + p[o + 3] * 0x1000000 : be32(p, o));
  if (t + 8 > p.length) return null;
  const ifd = t + u32(t + 4);
  if (ifd + 2 > p.length) return null;
  const n = u16(ifd);
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > p.length) return null;
    if (u16(e) === 0x0112) {
      const v = u16(e + 8);
      return v >= 1 && v <= 8 ? v : null;
    }
  }
  return null;
}

/** A minimal big-endian EXIF APP1 segment carrying only the orientation tag. */
function orientationApp1(v: number): Uint8Array {
  const payload = [
    ...[0x45, 0x78, 0x69, 0x66, 0, 0], // "Exif\0\0"
    ...[0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 8], // MM, 42, IFD0 at 8
    ...[0, 1], // one entry
    ...[0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, v, 0, 0], // Orientation, SHORT, count 1, value
    ...[0, 0, 0, 0], // no next IFD
  ];
  const len = payload.length + 2;
  return Uint8Array.from([0xff, 0xe1, len >> 8, len & 0xff, ...payload]);
}

function stripJpeg(b: Uint8Array): Uint8Array {
  const out: Uint8Array[] = [b.subarray(0, 2)];
  let orientation: number | null = null;
  let o = 2;
  for (;;) {
    if (o + 4 > b.length || b[o] !== 0xff) throw new ImageCheckError("the JPEG is damaged");
    const m = b[o + 1];
    if (m === 0xda) {
      // after a JFIF APP0 if there is one (it must come first), else right after SOI
      if (orientation && orientation !== 1) out.splice(out[1]?.[1] === 0xe0 ? 2 : 1, 0, orientationApp1(orientation));
      out.push(b.subarray(o)); // SOS and the entropy-coded data, verbatim
      break;
    }
    if (m === 0xff) {
      o++;
      continue;
    }
    const len = be16(b, o + 2);
    if (len < 2 || o + 2 + len > b.length) throw new ImageCheckError("the JPEG is damaged");
    const seg = b.subarray(o, o + 2 + len);
    if (m === 0xe1) orientation ??= exifOrientation(seg.subarray(4));
    else out.push(seg);
    o += 2 + len;
  }
  return Buffer.concat(out);
}

const PNG_DROP = new Set(["eXIf", "tEXt", "zTXt", "iTXt", "tIME"]);

function stripPng(b: Uint8Array): Uint8Array {
  const out: Uint8Array[] = [b.subarray(0, 8)];
  let o = 8;
  for (;;) {
    if (o + 12 > b.length) throw new ImageCheckError("the PNG is damaged");
    const len = be32(b, o);
    const type = tag(b, o + 4);
    const end = o + 12 + len;
    if (end > b.length) throw new ImageCheckError("the PNG is damaged");
    if (!PNG_DROP.has(type)) out.push(b.subarray(o, end));
    o = end;
    if (type === "IEND") break;
  }
  return Buffer.concat(out);
}

export interface CheckedImage {
  bytes: Buffer;
  type: ImageType;
  width: number;
  height: number;
}

/** Sniff, size-check, dimension-check and strip a creator's image. Throws `ImageCheckError` (a 400 message). */
export function checkLaunchImage(raw: Uint8Array, maxBytes = LAUNCH_IMAGE_MAX_BYTES): CheckedImage {
  if (raw.length > maxBytes) throw new ImageCheckError(`image is larger than ${Math.round(maxBytes / 1024 / 1024)} MB`);
  if (raw.length === 0) throw new ImageCheckError("image is empty");
  const type = sniffImage(raw);
  if (!type) throw new ImageCheckError("image must be a PNG, JPG, GIF or WebP");
  const dims = imageDimensions(raw, type);
  if (!dims) throw new ImageCheckError("the image header can't be read");
  const { width, height } = dims;
  if (width < LAUNCH_IMAGE_MIN_SIDE || height < LAUNCH_IMAGE_MIN_SIDE) throw new ImageCheckError(`image is too small (at least ${LAUNCH_IMAGE_MIN_SIDE}×${LAUNCH_IMAGE_MIN_SIDE} px)`);
  if (width > LAUNCH_IMAGE_MAX_SIDE || height > LAUNCH_IMAGE_MAX_SIDE || width * height > LAUNCH_IMAGE_MAX_PIXELS)
    throw new ImageCheckError(`image is too large (at most ${LAUNCH_IMAGE_MAX_SIDE} px a side)`);
  const bytes = type === "image/jpeg" ? stripJpeg(raw) : type === "image/png" ? stripPng(raw) : raw;
  return { bytes: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), type, width, height };
}
