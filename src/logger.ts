import { pino, stdTimeFunctions, type Logger } from 'pino';

/** Structured JSON logger to stdout. Never use console.log in services. */
export function createLogger(service: string): Logger {
  return pino({
    level: process.env.LOG_LEVEL ?? 'info',
    base: { service },
    timestamp: stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
    },
  });
}
