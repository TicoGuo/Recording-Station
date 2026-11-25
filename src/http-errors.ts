import type { Request, Response, NextFunction } from "express";
import { randomUUID } from "node:crypto";
import { requestContext } from "./logger";

declare module "express-serve-static-core" {
  interface Locals {
    requestId: string;
  }
}

export function requestId(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header("X-Request-Id");
  const id = (incoming && incoming.length <= 64 ? incoming : null) || randomUUID().slice(0, 8);
  res.locals.requestId = id;
  res.setHeader("X-Request-Id", id);
  requestContext.run(id, () => next());
}

/** TicoGemini-compatible error envelope: { error: { code, message }, requestId }. */
export function sendError(
  res: Response,
  status: number,
  code: string,
  message: string,
  extra?: Record<string, unknown>,
): void {
  res.status(status).json({
    error: { code, message },
    requestId: res.locals.requestId,
    ...(extra ?? {}),
  });
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function codeForError(message: string): string {
  if (/未连接|not connected|no device/i.test(message)) return "DEVICE_NOT_CONNECTED";
  if (/未就绪|not ready|未信任/i.test(message)) return "DEVICE_NOT_READY";
  if (/未找到|not found/i.test(message)) return "DEVICE_NOT_FOUND";
  if (/冲突|busy|locked|已在运行|正在进行/i.test(message)) return "CONTROL_LOCKED";
  if (/参数|非法|缺少/i.test(message)) return "INVALID_REQUEST";
  return "INTERNAL_ERROR";
}
