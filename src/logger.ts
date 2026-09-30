import { config } from "./config.js";

const priorities = { debug: 10, info: 20, warn: 30, error: 40 } as const;

type LogLevel = keyof typeof priorities;
type LogFields = Record<string, unknown>;

function write(level: LogLevel, message: string, fields: LogFields = {}): void {
  if (priorities[level] < priorities[config.logLevel]) return;

  const entry = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    message,
    ...fields
  });

  if (level === "error") console.error(entry);
  else if (level === "warn") console.warn(entry);
  else console.log(entry);
}

export const logger = {
  debug: (message: string, fields?: LogFields) => write("debug", message, fields),
  info: (message: string, fields?: LogFields) => write("info", message, fields),
  warn: (message: string, fields?: LogFields) => write("warn", message, fields),
  error: (message: string, fields?: LogFields) => write("error", message, fields)
};
