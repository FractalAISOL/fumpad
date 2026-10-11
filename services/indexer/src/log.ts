import { pino, type Logger } from "pino";

/** Structured JSON logs (Railway parses them); `LOG_LEVEL` controls verbosity. */
export function createLogger(name: string, level = process.env.LOG_LEVEL ?? "info"): Logger {
  return pino({
    name,
    level,
    base: { service: name },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
  });
}
export type { Logger };
