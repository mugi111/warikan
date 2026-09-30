const priorities = { debug: 10, info: 20, warn: 30, error: 40 } as const;

type LogLevel = keyof typeof priorities;
type LogFields = Record<string, unknown>;

const configuredLevel = process.env.LOG_LEVEL?.trim().toLowerCase();
const logLevel: LogLevel = configuredLevel === "debug" || configuredLevel === "warn" || configuredLevel === "error"
  ? configuredLevel
  : "info";
const sensitiveKey = /(token|secret|password|authorization|credential|api[_-]?key)/i;
const tokenPattern = /(?:Bot\s+)?[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}/g;

function sanitize(value: unknown, key = ""): unknown {
  if (sensitiveKey.test(key)) return "[REDACTED]";
  if (typeof value === "string") return value.replace(tokenPattern, "[REDACTED]");
  if (Array.isArray(value)) return value.map((item) => sanitize(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [childKey, sanitize(childValue, childKey)]));
  }
  return value;
}

function write(level: LogLevel, message: string, fields: LogFields = {}): void {
  if (priorities[level] < priorities[logLevel]) return;
  const entry = JSON.stringify({ timestamp: new Date().toISOString(), level, message, ...sanitize(fields) as LogFields });
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
