import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AsyncLocalStorage } from "node:async_hooks";
import { getConfig } from "./config";
import type { LogLevel } from "./types";

// 请求上下文：在 requestId 中间件里写入，让业务日志能关联到具体请求。
export const requestContext = new AsyncLocalStorage<string>();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const LOG_DIR = path.join(PROJECT_ROOT, "logs");

const LEVELS: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

let currentDate = "";
let logStream: fs.WriteStream | null = null;

// 本地日期（Asia/Shanghai 等本地时区），用于日志文件按天轮转。
function localDate(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function ensureLogStream(): fs.WriteStream | null {
  const date = localDate();
  if (logStream && currentDate === date) return logStream;
  if (logStream) {
    try {
      logStream.end();
    } catch {
      // 忽略关闭旧日志流的错误
    }
    logStream = null;
  }
  currentDate = date;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    logStream = fs.createWriteStream(path.join(LOG_DIR, `iwcs-${date}.log`), { flags: "a" });
    logStream.on("error", () => undefined);
  } catch {
    logStream = null;
  }
  return logStream;
}

function writeFileLine(line: string): void {
  const stream = ensureLogStream();
  if (stream) stream.write(line + "\n");
}

function safeStringify(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export function log(level: LogLevel, module: string, message: string, meta?: unknown): void {
  const cfg = getConfig();
  const threshold = LEVELS[(cfg.logLevel as LogLevel) ?? "info"] ?? LEVELS.info;
  if ((LEVELS[level] ?? LEVELS.info) < threshold) return;

  const ts = new Date().toISOString();
  const requestId = requestContext.getStore();
  const requestIdStr = requestId ? ` [${requestId}]` : "";
  const metaStr = meta === undefined ? "" : " " + safeStringify(meta);
  const line = `${ts} [${level.toUpperCase()}] [${module}]${requestIdStr} ${message}${metaStr}`;

  writeFileLine(line);

  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}
