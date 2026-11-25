import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { getConfig } from "./config";
import { log } from "./logger";
import { localDateStamp } from "./naming";
import { mediaOutput } from "./media-output";
import { nativeCore } from "./native-core";
import { sendError, messageOf, codeForError } from "./http-errors";
import type { RecordStatus, RecordFile } from "./types";

let operationTail: Promise<void> = Promise.resolve();

function serialize<T>(operation: () => Promise<T>): Promise<T> {
  const result = operationTail.then(operation, operation);
  operationTail = result.then(() => undefined, () => undefined);
  return result;
}

export function getRecordStatus(): RecordStatus {
  const status = mediaOutput.getStatus();
  const diag = mediaOutput.getDiagnostics();
  return { ...status, encodeFps: diag.encodeFps };
}

// 录制输出目录：优先使用用户在配置中的 outputPath，未设置时回退到项目根下的 recording 文件夹
function outputDir(): string {
  const cfg = getConfig();
  // PROJECT_ROOT 定位：相对于本文件 (src/record.ts) 向上一级
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const PROJECT_ROOT = path.resolve(__dirname, "..");
  const raw = cfg.outputPath?.trim() || path.join(PROJECT_ROOT, "recording");
  // 如果 outputPath 是相对路径，统一基于 PROJECT_ROOT 解析，避免受 cwd 影响
  const resolved = path.isAbsolute(raw) ? raw : path.join(PROJECT_ROOT, raw);
  try {
    fs.mkdirSync(resolved, { recursive: true });
  } catch {
    // 目录创建失败时仍返回已解析路径，后续读写会给出更明确的错误
  }
  return resolved;
}

// 将源 PTS 换算出的帧率就近映射到标准帧率，避免 29.97/59.94 等非整数导致漂移
function roundToStandardFps(fps: number): number {
  const standards = [24, 25, 30, 50, 60, 120];
  let best = 30;
  let bestDiff = Number.POSITIVE_INFINITY;
  for (const s of standards) {
    const diff = Math.abs(fps - s);
    if (diff < bestDiff) { bestDiff = diff; best = s; }
  }
  return best;
}

// 基于源 PTS（时间戳）检测真实帧率：连续采样几帧时间戳，取相邻间隔中位数
async function detectSourceFps(fallback: number): Promise<number> {
  const timestamps: bigint[] = [];
  const deadline = Date.now() + 3000;
  while (timestamps.length < 6 && Date.now() < deadline) {
    // 采样间隔必须快于帧率（120fps 约 8.3ms 一帧），否则会跳过帧导致间隔被高估
    await new Promise<void>((resolve) => setTimeout(resolve, 4));
    try {
      const ts = await nativeCore.getLatestVideoTimestamp();
      if (ts > 0n && (timestamps.length === 0 || ts !== timestamps[timestamps.length - 1])) {
        timestamps.push(ts);
      }
    } catch {
      // 采样失败忽略
    }
  }
  if (timestamps.length < 3) return fallback;
  const deltas: number[] = [];
  for (let i = 1; i < timestamps.length; i++) {
    const d = Number(timestamps[i] - timestamps[i - 1]);
    if (d > 0) deltas.push(d);
  }
  if (deltas.length === 0) return fallback;
  deltas.sort((a, b) => a - b);
  const median = deltas[Math.floor(deltas.length / 2)];
  if (median <= 0) return fallback;
  const fps = roundToStandardFps(10_000_000 / median);
  log("info", "record", "检测到源帧率", { ptsMedian100ns: median, fps });
  return fps;
}

export function startRecording(
  opts: { outputPath?: string; fps?: number } = {},
): Promise<RecordStatus> {
  return serialize(async () => {
    if (getRecordStatus().recording) throw new Error("录制已在运行");
    if (!nativeCore.hasActiveSession) throw new Error("请先在右上角切换到录制模式");
    const capture = await nativeCore.waitForStreaming();
    const width = capture.width & ~1;
    const height = capture.height & ~1;
    const cfg = getConfig();
    const directory = opts.outputPath?.trim() || outputDir();
    const destination = path.resolve(directory,
      `iOS_${localDateStamp()}_${randomUUID().slice(0, 4)}.mp4`);
    const fps = opts.fps ?? await detectSourceFps(cfg.fps);
    await mediaOutput.start({
      width,
      height,
      fps,
      destination,
      ffmpegPath: cfg.ffmpegPath,
      remux: true,
    });
    // 查询解码器运行模式（硬件/软件），用于诊断卡帧
    try {
      const vo = await nativeCore.getVideoOutputStatus();
      const modeNames: Record<number, string> = { 0: "未知", 1: "硬件", 2: "软件", 3: "外部" };
      log("info", "record", "解码器运行模式", {
        decoderRuntimeMode: vo.decoderRuntimeMode,
        mode: modeNames[vo.decoderRuntimeMode] ?? "未知",
        appliedDecoderPreference: vo.appliedDecoderPreference,
      });
    } catch (error) {
      log("warn", "record", "查询解码器运行模式失败", messageOf(error));
    }
    log("info", "record", "录制开始", { destination });
    return getRecordStatus();
  });
}

export function stopRecording(): Promise<RecordStatus> {
  return serialize(async () => {
    // 停止前抓取采集 fps，用于日志里定位卡帧是采集端还是编码端
    let captureFps: number | undefined;
    if (nativeCore.hasActiveSession) {
      try {
        const capture = await nativeCore.getSessionStatus();
        captureFps = Math.round(capture.fps * 10) / 10;
      } catch {
        // 采集核心状态读取失败时忽略
      }
    }
    await mediaOutput.stop();
    const status = getRecordStatus();
    if (captureFps !== undefined) status.captureFps = captureFps;
    log("info", "record", "录制停止", status);
    return status;
  });
}

function listRecordFiles(): RecordFile[] {
  const dir = outputDir();
  const files: RecordFile[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !/\.mp4$/i.test(entry.name)) continue;
    const full = path.join(dir, entry.name);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    files.push({
      path: full,
      name: entry.name,
      size: stat.size,
      modifiedAt: stat.mtime.toISOString(),
    });
  }
  files.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  return files;
}

function allowedRecordDirs(): string[] {
  const dir = outputDir();
  return [dir.endsWith(path.sep) ? dir : dir + path.sep];
}

function findRecordFile(target: string): string | null {
  if (!target) return null;
  const resolved = path.resolve(target);
  if (!/\.mp4$/i.test(path.basename(resolved))) return null;
  for (const dir of allowedRecordDirs()) {
    if (resolved.startsWith(dir)) {
      try {
        if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) return resolved;
      } catch {
        return null;
      }
    }
  }
  return null;
}

export function createRecordRouter(): Router {
  const router = Router();

  router.get("/status", async (_req, res) => {
    const status = getRecordStatus();
    if (status.recording && nativeCore.hasActiveSession) {
      try {
        const capture = await nativeCore.getSessionStatus();
        status.captureFps = Math.round(capture.fps * 10) / 10;
      } catch {
        // 采集核心状态读取失败时忽略，仍返回编码 fps
      }
    }
    res.json(status);
  });

  router.get("/files", (_req, res) => {
    res.json({ files: listRecordFiles() });
  });

  router.get("/download", (req, res) => {
    const file = findRecordFile(String(req.query.path ?? ""));
    if (!file) return sendError(res, 404, "NOT_FOUND", "录制文件不存在或不在允许的目录内");
    res.download(file, path.basename(file));
  });

  // 视频流式播放：支持 HTTP Range，浏览器 <video> 直接播放并可拖动进度
  router.get("/stream", (req, res) => {
    const file = findRecordFile(String(req.query.path ?? ""));
    if (!file) return sendError(res, 404, "NOT_FOUND", "录制文件不存在或不在允许的目录内");
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch (error) {
      return sendError(res, 404, "NOT_FOUND", messageOf(error));
    }
    const fileSize = stat.size;
    const range = req.headers.range;
    if (range) {
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      if (Number.isNaN(start) || Number.isNaN(end) || start >= fileSize || end >= fileSize || start > end) {
        res.writeHead(416, { "Content-Range": `bytes */${fileSize}` });
        return res.end();
      }
      const chunkSize = (end - start) + 1;
      res.writeHead(206, {
        "Content-Range": `bytes ${start}-${end}/${fileSize}`,
        "Accept-Ranges": "bytes",
        "Content-Length": chunkSize,
        "Content-Type": "video/mp4",
      });
      fs.createReadStream(file, { start, end }).pipe(res);
    } else {
      res.writeHead(200, {
        "Content-Length": fileSize,
        "Content-Type": "video/mp4",
        "Accept-Ranges": "bytes",
      });
      fs.createReadStream(file).pipe(res);
    }
  });

  router.post("/delete", (req, res) => {
    const file = findRecordFile(String(req.body?.path ?? ""));
    if (!file) return sendError(res, 404, "NOT_FOUND", "录制文件不存在或不在允许的目录内");
    try {
      fs.unlinkSync(file);
      log("info", "record", "录制文件已删除", { file });
      res.json({ ok: true });
    } catch (error) {
      sendError(res, 500, "INTERNAL_ERROR", messageOf(error), { ok: false });
    }
  });

  router.post("/reveal", (req, res) => {
    const file = findRecordFile(String(req.body?.path ?? ""));
    if (!file) return sendError(res, 404, "NOT_FOUND", "录制文件不存在或不在允许的目录内");
    try {
      execFile("explorer.exe", ["/select,", file], { windowsHide: true });
      res.json({ ok: true });
    } catch (error) {
      sendError(res, 500, "INTERNAL_ERROR", messageOf(error), { ok: false });
    }
  });

  router.post("/rename", (req, res) => {
    const file = findRecordFile(String(req.body?.path ?? ""));
    if (!file) return sendError(res, 404, "NOT_FOUND", "录制文件不存在或不在允许的目录内");
    const base = String(req.body?.name ?? "").trim();
    if (!base || base === "." || base === ".." || /[/\\:*?"<>|]/.test(base) || /[\x00-\x1f]/.test(base)) {
      return sendError(res, 400, "INVALID_NAME", "文件名不合法（不能包含 \\ / : * ? \" < > | 等字符）");
    }
    const dest = path.join(path.dirname(file), `${base}.mp4`);
    const resolved = path.resolve(dest);
    if (resolved === path.resolve(file)) {
      return res.json({ path: file, name: path.basename(file) });
    }
    if (!allowedRecordDirs().some((dir) => resolved.startsWith(dir))) {
      return sendError(res, 400, "INVALID_NAME", "新文件名必须保持在录制目录内");
    }
    try {
      if (fs.existsSync(resolved)) {
        return sendError(res, 409, "ALREADY_EXISTS", "同名文件已存在");
      }
      fs.renameSync(file, resolved);
      log("info", "record", "录制文件已重命名", { from: file, to: resolved });
      res.json({ path: resolved, name: path.basename(resolved) });
    } catch (error) {
      sendError(res, 500, "INTERNAL_ERROR", messageOf(error));
    }
  });

  router.post("/start", async (req, res) => {
    try {
      const status = await startRecording({
        outputPath: req.body?.outputPath,
        fps: req.body?.fps,
      });
      res.json(status);
    } catch (error) {
      const message = messageOf(error);
      log("error", "record", message);
      sendError(res, 400, codeForError(message), message, { ...getRecordStatus() });
    }
  });

  router.post("/stop", async (_req, res) => {
    try {
      res.json(await stopRecording());
    } catch (error) {
      const message = messageOf(error);
      log("error", "record", message);
      sendError(res, 400, codeForError(message), message, { ...getRecordStatus() });
    }
  });

  return router;
}
