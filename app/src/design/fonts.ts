import { Archivo, Martian_Mono } from "next/font/google";

/** Archivo with its width axis: 62 (tiles) to 125 (wordmark). */
export const archivo = Archivo({
  subsets: ["latin"],
  axes: ["wdth"],
  variable: "--font-archivo",
  display: "swap",
});

/** Martian Mono for every number, width axis 75–112.5. */
export const martian = Martian_Mono({
  subsets: ["latin"],
  axes: ["wdth"],
  variable: "--font-martian",
  display: "swap",
});
