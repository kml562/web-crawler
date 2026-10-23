import winston from "winston";
import "winston-mongodb";

const MONGO_URI = process.env["MONGODB_URI"] ?? "";

// ── transports ──────────────────────────────────────────────────────────────

const consoleTransport = new winston.transports.Console({
  format: winston.format.combine(
    winston.format.colorize({ all: true }),
    winston.format.printf(({ level, message, service, timestamp }) => {
      const ts = new Date(timestamp as string).toLocaleTimeString();
      const svc = service ? ` [${service}]` : "";
      return `[${ts}] ${level}${svc}  ${message}`;
    })
  ),
});

// MongoDB transport — only enabled when MONGODB_URI is set
const mongoTransport = MONGO_URI
  ? new winston.transports.MongoDB({
      db:             MONGO_URI,
      collection:     "systemlogs",
      level:          "debug",
      cappedSize:     10 * 1024 * 1024,
      cappedMax:      5000,
      tryReconnect:   true,
      options:        { useUnifiedTopology: true },
    })
  : null;

const transports: winston.transport[] = [consoleTransport];
if (mongoTransport) transports.push(mongoTransport);

// ── logger instance ─────────────────────────────────────────────────────────

const winstonLogger = winston.createLogger({
  level: process.env["LOG_LEVEL"] ?? "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json(),
  ),
  defaultMeta: { service: "crawler" },
  transports,
});

// ── convenience wrapper (matches old logger API + adds structured meta) ──────

export const logger = {
  info(msg: string, meta?: Record<string, unknown>) {
    winstonLogger.info(msg, meta);
  },
  success(msg: string, meta?: Record<string, unknown>) {
    winstonLogger.info(`✓ ${msg}`, meta);
  },
  warn(msg: string, meta?: Record<string, unknown>) {
    winstonLogger.warn(msg, meta);
  },
  error(msg: string, err?: unknown, meta?: Record<string, unknown>) {
    const extra = err instanceof Error
      ? { error: err.message, stack: err.stack, ...meta }
      : { error: String(err ?? ""), ...meta };
    winstonLogger.error(msg, extra);
  },
  debug(msg: string, meta?: Record<string, unknown>) {
    winstonLogger.debug(msg, meta);
  },
  /** Create a child logger that tags every message with a service name */
  child(service: string) {
    const child = winstonLogger.child({ service });
    return {
      info:    (msg: string, meta?: Record<string, unknown>) => child.info(msg, meta),
      success: (msg: string, meta?: Record<string, unknown>) => child.info(`✓ ${msg}`, meta),
      warn:    (msg: string, meta?: Record<string, unknown>) => child.warn(msg, meta),
      error:   (msg: string, err?: unknown, meta?: Record<string, unknown>) => {
        const extra = err instanceof Error
          ? { error: err.message, stack: err.stack, ...meta }
          : { error: String(err ?? ""), ...meta };
        child.error(msg, extra);
      },
      debug:   (msg: string, meta?: Record<string, unknown>) => child.debug(msg, meta),
    };
  },
};

export { winstonLogger };
