import express from "express";
import path from "node:path";
import fs from "node:fs";
import { exec, execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import type { Server } from "node:http";
import net from "node:net";
import { getConfig, saveConfig, publicConfig } from "./config";
import { log } from "./logger";
import { requestId, sendError, messageOf } from "./http-errors";
import { createDevicesRouter } from "./devices";
import { createRecordRouter, stopRecording } from "./record";
import { createModeRouter } from "./mode";
import { createAppsRouter } from "./apps";
import { createAndroidRouter, stopAndroidRecording } from "./android";
import { createHealthRouter } from "./health";
import { nativeCore } from "./native-core";
import { checkCaptureBackend, checkWindowsDependencies } from "./system-dependencies";
import type { Config } from "./types";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cfg = getConfig();
const execFileAsync = promisify(execFile);

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(requestId);

// 请求日志：记录每个请求的方法、路径、状态码与耗时（requestId 已写入日志上下文）
app.use((req, res, next) => {
  const startedAt = performance.now();
  res.on("finish", () => {
    log("info", "http", `${req.method} ${req.originalUrl} -> ${res.statusCode}`, {
      durationMs: Math.round(performance.now() - startedAt),
    });
  });
  next();
});

app.get("/api/config", (_req, res) => {
  res.json(publicConfig(getConfig()));
});

app.put("/api/config", (req, res) => {
  const body = req.body ?? {};
  const partial: Partial<Config> = {};
  if (typeof body.outputPath === "string") partial.outputPath = body.outputPath;
  if (typeof body.androidOutputPath === "string") partial.androidOutputPath = body.androidOutputPath;
  if (typeof body.ipaPath === "string") partial.ipaPath = body.ipaPath;
  if (typeof body.apkPath === "string") partial.apkPath = body.apkPath;
  if (typeof body.lastPlatform === "string") partial.lastPlatform = body.lastPlatform;
  if (typeof body.fps === "number") partial.fps = body.fps;
  const updated = saveConfig(partial);

  // 保存输出目录时立即创建该目录，保证用户填写的路径马上可用（相对路径统一基于项目根解析）
  const ensureDir = (raw: string): void => {
    const target = path.isAbsolute(raw) ? raw : path.resolve(__dirname, "..", raw);
    fs.mkdirSync(target, { recursive: true });
  };
  if (typeof body.outputPath === "string" || typeof body.androidOutputPath === "string") {
    try {
      if (typeof body.outputPath === "string") ensureDir(updated.outputPath);
      if (typeof body.androidOutputPath === "string") ensureDir(updated.androidOutputPath);
    } catch (error) {
      return sendError(res, 400, "INVALID_OUTPUT_PATH", `无法创建输出目录：${messageOf(error)}`, { ...publicConfig(updated) });
    }
  }

  log("info", "config", "配置已更新", publicConfig(updated));
  res.json(publicConfig(updated));
});

// 打开输出目录文件夹（未传路径时使用当前配置的 outputPath）
app.post("/api/open-dir", (req, res) => {
  const raw = String(req.body?.dir ?? "").trim() || getConfig().outputPath;
  // 相对路径统一基于项目根解析，与录制目录解析逻辑保持一致
  const target = path.isAbsolute(raw) ? raw : path.resolve(__dirname, "..", raw);
  try {
    fs.mkdirSync(target, { recursive: true });
    // 用 Shell.Application.Explore 打开并激活窗口到前台（explorer 直接启动常停留在后台）
    const escaped = target.replace(/'/g, "''");
    execFile("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command",
      `(New-Object -ComObject Shell.Application).Explore('${escaped}')`,
    ], { windowsHide: true }, (error) => {
      if (error) log("error", "server", "打开目录失败", messageOf(error));
    });
    log("info", "server", "已打开目录", { target });
    res.json({ ok: true });
  } catch (error) {
    sendError(res, 500, "INTERNAL_ERROR", `无法打开目录：${messageOf(error)}`, { ok: false });
  }
});

app.use("/api/devices", createDevicesRouter());
app.use("/api/record", createRecordRouter());
app.use("/api/mode", createModeRouter());
app.use("/api/apps", createAppsRouter());
app.use("/api/android", createAndroidRouter());
app.use("/api/health", createHealthRouter());

// 本地控制台：禁止前端资源缓存，避免 HTML/JS 版本不匹配导致空白页或旧界面
const noStoreAssets = new Set(["index.html", "app.js", "style.css"]);
app.use(express.static(path.join(__dirname, "..", "public"), {
  etag: false,
  lastModified: false,
  setHeaders(res, filePath) {
    if (noStoreAssets.has(path.basename(filePath))) {
      res.setHeader("Cache-Control", "no-store, must-revalidate");
      res.setHeader("Pragma", "no-cache");
    }
  },
}));

app.use("/api", (_req, res) => {
  sendError(res, 404, "NOT_FOUND", "接口不存在");
});

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const message = messageOf(error);
  log("error", "server", "未处理异常", message);
  sendError(res, 500, "INTERNAL_ERROR", message);
});

let server: Server | null = null;
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log("info", "server", `收到 ${signal}，正在关闭`);
  try {
    await stopRecording();
  } catch (error) {
    log("error", "server", "停止录制失败", messageOf(error));
  }
  try {
    await stopAndroidRecording();
  } catch (error) {
    log("error", "server", "停止 Android 录制失败", messageOf(error));
  }
  try {
    await nativeCore.shutdown();
  } catch (error) {
    log("error", "server", "关闭采集核心失败", messageOf(error));
  }
  if (server) {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  }
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

// 启动前探测端口是否已被占用，避免重复启动导致 native DLL 文件被锁、USB 设备会话串扰
function portInUse(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", (error: NodeJS.ErrnoException) => {
      resolve(error.code === "EADDRINUSE");
    });
    probe.once("listening", () => {
      probe.close(() => resolve(false));
    });
    probe.listen(port, host);
  });
}

function openBrowser(url: string): void {
  const command = process.platform === "win32"
    ? `start "" "${url}"`
    : process.platform === "darwin"
      ? `open "${url}"`
      : `xdg-open "${url}"`;
  exec(command, (error) => {
    if (error) log("warn", "server", "自动打开浏览器失败", messageOf(error));
  });
}

// 检查某个可执行文件是否存在并可运行。
// strict=false 时仅把 ENOENT（文件不存在/无法启动）视为失败，适合 --help 返回非零但实际可用的工具。
async function checkExecutable(filePath: string, args: string[], strict = true): Promise<string | null> {
  if (!fs.existsSync(filePath)) return `文件不存在：${filePath}`;
  try {
    await execFileAsync(filePath, args, { encoding: "utf8", timeout: 3000, windowsHide: true });
    return null;
  } catch (error) {
    if (!strict && (error as any)?.code !== "ENOENT") return null;
    return `无法执行：${messageOf(error)}`;
  }
}

// 检测 Android 录制/应用管理所需的工具及其依赖 DLL（告警级，不阻断 iOS 启动）。
async function checkAndroidDependencies(): Promise<string[]> {
  const warnings: string[] = [];
  const cfg = getConfig();

  if (!fs.existsSync(cfg.scrcpyPath)) {
    warnings.push(`scrcpy.exe 不存在，Android 录制不可用：${cfg.scrcpyPath}`);
  } else {
    const dir = path.dirname(cfg.scrcpyPath);
    const required = ["SDL3.dll", "libusb-1.0.dll", "AdbWinApi.dll", "AdbWinUsbApi.dll"];
    const missing = required.filter((f) => !fs.existsSync(path.join(dir, f)));
    if (missing.length) warnings.push(`scrcpy 缺少依赖 DLL：${missing.join(", ")}`);
    const hasDll = (pattern: RegExp): boolean => {
      try { return fs.readdirSync(dir).some((f) => pattern.test(f)); } catch { return false; }
    };
    if (!hasDll(/^avcodec-\d+\.dll$/i)) warnings.push("scrcpy 缺少 avcodec DLL（FFmpeg 解码）");
    if (!hasDll(/^avformat-\d+\.dll$/i)) warnings.push("scrcpy 缺少 avformat DLL（FFmpeg 封装）");
    if (!hasDll(/^avutil-\d+\.dll$/i)) warnings.push("scrcpy 缺少 avutil DLL（FFmpeg 基础库）");
    if (!hasDll(/^swresample-\d+\.dll$/i)) warnings.push("scrcpy 缺少 swresample DLL");
  }

  if (!fs.existsSync(cfg.adbPath)) {
    warnings.push(`adb.exe 不存在，Android 应用管理不可用：${cfg.adbPath}`);
  } else {
    const err = await checkExecutable(cfg.adbPath, ["version"]);
    if (err) warnings.push(`adb ${err}`);
  }

  if (!fs.existsSync(cfg.aaptPath)) {
    warnings.push(`aapt.exe 不存在，APK 包名解析不可用：${cfg.aaptPath}`);
  } else {
    const aaptDir = path.dirname(cfg.aaptPath);
    if (!fs.existsSync(path.join(aaptDir, "libwinpthread-1.dll"))) {
      warnings.push("aapt 缺少 libwinpthread-1.dll");
    } else {
      const err = await checkExecutable(cfg.aaptPath, ["version"], false);
      if (err) warnings.push(`aapt ${err}`);
    }
  }

  return warnings;
}

// 启动前检测：环境、采集核心 DLL、FFmpeg、ideviceinstaller、Android 工具。
// 全部通过才允许启动并打开浏览器，否则给出明确提示并取消启动。
async function preflight(): Promise<{ ok: boolean; errors: string[]; warnings: string[] }> {
  const errors: string[] = [];
  const warnings: string[] = [];

  // 1. 运行环境与必须先于 Core 加载确认的系统组件
  if (process.platform !== "win32" || process.arch !== "x64") {
    errors.push(`当前环境 ${process.platform}/${process.arch} 不受支持，采集核心仅支持 Windows x64`);
    return { ok: false, errors, warnings };
  }
  const systemCheck = await checkWindowsDependencies();
  errors.push(...systemCheck.errors);
  warnings.push(...systemCheck.warnings);

  // 2. 采集核心 DLL 与 USB 后端
  const corePath = getConfig().corePath;
  if (!fs.existsSync(corePath)) {
    errors.push(`采集核心 DLL 不存在：${corePath}`);
  } else {
    try {
      await nativeCore.initialize(corePath);
      const environment = await nativeCore.getEnvironment();
      if (!environment.standardUsbmuxAvailable) {
        errors.push("Apple usbmux 服务端口不可用。请重新启动 Apple Mobile Device Service、重新连接设备后再试");
      }
      const usbCheck = checkCaptureBackend(environment);
      errors.push(...usbCheck.errors);
      warnings.push(...usbCheck.warnings);
    } catch (error) {
      errors.push(`采集核心初始化失败：${messageOf(error)}`);
    }
  }

  // 3. FFmpeg
  const ffmpegError = await checkExecutable(getConfig().ffmpegPath, ["-version"]);
  if (ffmpegError) errors.push(`FFmpeg ${ffmpegError}`);

  // 4. ideviceinstaller
  const ideviceError = await checkExecutable(getConfig().ideviceinstallerPath, ["--help"], false);
  if (ideviceError) errors.push(`ideviceinstaller ${ideviceError}`);

  // 5. Android 工具（scrcpy / adb / aapt 及依赖 DLL，告警级不阻断启动）
  warnings.push(...await checkAndroidDependencies());

  return { ok: errors.length === 0, errors, warnings };
}

async function start(): Promise<void> {
  if (await portInUse(cfg.listenHost, cfg.gatewayPort)) {
    log("error", "server", `端口 ${cfg.gatewayPort} 已被占用，请先关闭已运行的 IWCS 实例后重试`);
    process.exitCode = 1;
    return;
  }
  const check = await preflight();
  for (const warning of check.warnings) {
    log("warn", "server", `  - ${warning}`);
  }
  if (!check.ok) {
    log("error", "server", "启动前依赖检测未通过，已取消启动并跳过打开浏览器");
    for (const error of check.errors) {
      log("error", "server", `  - ${error}`);
    }
    log("error", "server", "请修复上述问题后重新启动");
    await nativeCore.shutdown().catch(() => {});
    process.exitCode = 1;
    return;
  }

  log("info", "server", "依赖检测通过，采集核心已初始化");
  if (shuttingDown) return;
  server = app.listen(cfg.gatewayPort, cfg.listenHost, () => {
    const url = `http://${cfg.listenHost}:${cfg.gatewayPort}`;
    log("info", "server", `IWCS 已启动: ${url}`);
    openBrowser(url);
  });
  server.on("error", (error) => {
    const msg = messageOf(error);
    log("error", "server", "启动服务器失败", msg);
    if (/EADDRINUSE/i.test(msg)) {
      log("error", "server", `端口 ${cfg.gatewayPort} 已被占用，请先关闭占用该端口的进程后重试`);
    }
    process.exitCode = 1;
  });
}

void start();
