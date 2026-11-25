import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Router } from "express";
import { getConfig } from "./config";
import { log } from "./logger";
import { localDateStamp } from "./naming";
import { sendError, messageOf, codeForError } from "./http-errors";
import type { AndroidDevice, AndroidApp, AndroidRecordStatus, RecordFile } from "./types";

const execFileAsync = promisify(execFile);

function adbBin(): string {
  return getConfig().adbPath;
}
function aaptBin(): string {
  return getConfig().aaptPath;
}

// Android 录制输出目录：默认使用独立的 recording/android，与 iOS 的 recording/ios 分开存放。
function androidOutputDir(): string {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const PROJECT_ROOT = path.resolve(__dirname, "..");
  const raw = getConfig().androidOutputPath?.trim() || path.join(PROJECT_ROOT, "recording/android");
  const dir = path.isAbsolute(raw) ? raw : path.join(PROJECT_ROOT, raw);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // 创建失败时仍返回解析路径，后续读写会给出更明确的错误
  }
  return dir;
}

function mapError(err: unknown): string {
  const code = (err as any)?.code;
  if (code === "ENOENT") return "未找到 adb/aapt/scrcpy，请确认 runtime 依赖完整";
  const message = String((err as any)?.message ?? err ?? "");
  const stderr = String((err as any)?.stderr ?? "");
  const combined = message + "\n" + stderr;
  if (/unauthorized|未授权/i.test(combined)) return "设备未授权，请在手机上允许 USB 调试后重试";
  if (/no devices|no device|device not found|offline|未检测到/i.test(combined)) {
    return "未检测到 Android 设备，请确认已通过 USB 连接并开启 USB 调试";
  }
  if (/INSTALL_FAILED|Failure \[|failed to install/i.test(combined)) {
    const m = stderr.match(/Failure\s*\[([^\]]+)\]/);
    return m ? `安装失败：${m[1]}` : (stderr.trim() || "应用安装失败");
  }
  if (/Failure \[|not installed|未知包|Unknown package/i.test(combined)) {
    const m = stderr.match(/Failure\s*\[([^\]]+)\]/);
    return m ? `卸载失败：${m[1]}` : (stderr.trim() || "操作失败");
  }
  if (message) return message;
  return "操作失败。";
}

async function runAdb(args: string[], timeout = 60000): Promise<{ stdout: string; stderr: string }> {
  return await execFileAsync(adbBin(), args, { encoding: "utf8", timeout, windowsHide: true });
}

async function runAapt(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return await execFileAsync(aaptBin(), args, { encoding: "utf8", timeout: 30000, windowsHide: true });
}

// ---------------- PowerShell 子进程辅助 ----------------
function psSingleQuote(s: string): string {
  return "'" + s.replace(/'/g, "''") + "'";
}

function quoteWinArg(s: string): string {
  return /[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s;
}

function runEncodedPs(script: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const b64 = Buffer.from(script, "utf16le").toString("base64");
  return new Promise((resolve) => {
    const ps = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", b64],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    let err = "";
    ps.stdout?.on("data", (d) => { out += d.toString(); });
    ps.stderr?.on("data", (d) => { err += d.toString(); });
    ps.on("error", () => resolve({ code: null, stdout: out, stderr: err }));
    ps.on("exit", (code) => resolve({ code, stdout: out, stderr: err }));
  });
}

// 在独立（隐藏）控制台中启动 scrcpy，返回进程 PID。
// 独立控制台是必需的：停止录制时需要通过 AttachConsole + GenerateConsoleCtrlEvent
// 向其发送 Ctrl+C，让 scrcpy 走正常退出流程并完成 MP4 封装（强制结束会丢失整个文件）。
async function startScrcpy(recordPath: string, serial: string): Promise<number> {
  const exe = getConfig().scrcpyPath;
  const argStr = ["--no-window", "--no-audio", "--no-control", "--record=" + recordPath, "-s", serial]
    .map(quoteWinArg)
    .join(" ");
  const script = [
    `$exe = ${psSingleQuote(exe)}`,
    `$argStr = ${psSingleQuote(argStr)}`,
    `$psi = New-Object System.Diagnostics.ProcessStartInfo`,
    `$psi.FileName = $exe`,
    `$psi.Arguments = $argStr`,
    `$psi.UseShellExecute = $true`,
    `$psi.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden`,
    `$p = [System.Diagnostics.Process]::Start($psi)`,
    `[Console]::Out.Write($p.Id)`,
  ].join("\n");
  const r = await runEncodedPs(script);
  const pid = parseInt(r.stdout.trim(), 10);
  if (r.code !== 0 || !Number.isInteger(pid) || pid <= 0) {
    throw new Error(r.stderr.trim() || "启动 scrcpy 失败");
  }
  return pid;
}

// 向指定 PID 的进程发送 Ctrl+C（通过附加到其控制台并触发 CTRL_C_EVENT）。
async function sendCtrlC(pid: number): Promise<void> {
  const script = [
    `$TargetPid = ${pid}`,
    `Add-Type -Namespace Win -Name Con -MemberDefinition @'`,
    `[DllImport("kernel32.dll")] public static extern bool FreeConsole();`,
    `[DllImport("kernel32.dll")] public static extern bool AttachConsole(uint pid);`,
    `[DllImport("kernel32.dll")] public static extern bool SetConsoleCtrlHandler(IntPtr h, bool add);`,
    `[DllImport("kernel32.dll")] public static extern bool GenerateConsoleCtrlEvent(uint evt, uint group);`,
    `'@`,
    `[void][Win.Con]::FreeConsole()`,
    `if (-not [Win.Con]::AttachConsole([uint32]$TargetPid)) { exit 2 }`,
    `[void][Win.Con]::SetConsoleCtrlHandler([IntPtr]::Zero, $true)`,
    `[void][Win.Con]::GenerateConsoleCtrlEvent(0, 0)`,
  ].join("\n");
  await runEncodedPs(script);
}

function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = (): void => {
      try {
        process.kill(pid, 0);
        if (Date.now() - start > timeoutMs) {
          resolve(false);
          return;
        }
        setTimeout(check, 200);
      } catch {
        resolve(true);
      }
    };
    check();
  });
}

// ---------------- 录制状态 ----------------
interface RecordingState {
  recording: boolean;
  filePath: string;
  startedAt: number;
  serial: string;
  pid: number | null;
}

const state: RecordingState = {
  recording: false,
  filePath: "",
  startedAt: 0,
  serial: "",
  pid: null,
};

export function getAndroidRecordStatus(): AndroidRecordStatus {
  return {
    recording: state.recording,
    filePath: state.filePath,
    durationSeconds: state.recording ? Math.max(0, Math.floor((Date.now() - state.startedAt) / 1000)) : 0,
  };
}

export async function stopAndroidRecording(): Promise<AndroidRecordStatus> {
  if (!state.recording || state.pid === null) return getAndroidRecordStatus();
  const pid = state.pid;
  state.recording = false;
  state.pid = null;
  try {
    await sendCtrlC(pid);
    const exited = await waitForProcessExit(pid, 10000);
    if (!exited) {
      try { process.kill(pid, "SIGKILL"); } catch { /* ignore */ }
      log("error", "android", "scrcpy 未在超时内退出，已强制结束（录制文件可能未封装）");
    } else {
      log("info", "android", "录制停止", { filePath: state.filePath });
    }
  } catch (err) {
    log("error", "android", "停止录制失败", messageOf(err));
  }
  return getAndroidRecordStatus();
}

function parseDevices(stdout: string): AndroidDevice[] {
  const devices: AndroidDevice[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^List of devices/i.test(line)) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 2) continue;
    const serial = parts[0];
    const state = parts[1];
    let model = "";
    let device = "";
    for (let i = 2; i < parts.length; i++) {
      const eq = parts[i].indexOf(":");
      if (eq > 0) {
        const key = parts[i].slice(0, eq);
        const value = parts[i].slice(eq + 1);
        if (key === "model") model = value;
        else if (key === "device") device = value;
      }
    }
    devices.push({ serial, model, device, state });
  }
  return devices;
}

// 第三方应用（含 APK 路径），用于解析应用名称。结果缓存避免重复查询。
let cachedPackagePaths: Array<{ packageName: string; apkPath: string }> | null = null;
let cachedPackagePathsAt = 0;

// 已解析的应用名缓存（packageName -> 中文应用名）
const appNameCache = new Map<string, string>();

function parsePackagePaths(stdout: string): Array<{ packageName: string; apkPath: string }> {
  const result: Array<{ packageName: string; apkPath: string }> = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith("package:")) continue;
    // 格式：package:<apk路径>=<包名>。路径里可能含 '=='，分隔符是最后一个 '='。
    const rest = line.slice("package:".length);
    const eq = rest.lastIndexOf("=");
    if (eq <= 0) continue;
    const apkPath = rest.slice(0, eq).trim();
    const packageName = rest.slice(eq + 1).trim();
    if (packageName && apkPath) result.push({ packageName, apkPath });
  }
  result.sort((a, b) => a.packageName.localeCompare(b.packageName));
  return result;
}

async function listThirdPartyPackages(): Promise<Array<{ packageName: string; apkPath: string }>> {
  if (cachedPackagePaths && Date.now() - cachedPackagePathsAt < 30000) {
    return cachedPackagePaths;
  }
  const { stdout } = await runAdb(["shell", "pm", "list", "packages", "-3", "-f"], 30000);
  cachedPackagePaths = parsePackagePaths(stdout);
  cachedPackagePathsAt = Date.now();
  return cachedPackagePaths;
}

// ---------------- 最小 APK 重建：避免拉取整个大 APK ----------------

const ZIP_EOCD = 0x06054b50;
const ZIP_CDH = 0x02014b50;
const ZIP_LFH = 0x04034b50;

interface ApkEntry {
  name: string;
  nameLen: number;
  extraLen: number;
  compressedSize: number;
  localHeaderOffset: number;
  centralHeader: Buffer;
}

function shQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

// 执行 adb 并返回二进制 stdout（不按 utf8 解码）
async function runAdbBuffer(args: string[]): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    execFile(adbBin(), args, { windowsHide: true, maxBuffer: 256 * 1024 * 1024, encoding: "buffer" }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout as unknown as Buffer);
    });
  });
}

async function getApkSize(apkPath: string): Promise<number> {
  const { stdout } = await runAdb(["shell", "stat", "-c", "%s", apkPath], 15000);
  const n = parseInt(stdout.trim(), 10);
  return Number.isFinite(n) ? n : 0;
}

// 读取设备文件前 length 字节（head -c）
async function readApkHead(apkPath: string, length: number): Promise<Buffer> {
  return await runAdbBuffer(["exec-out", `head -c ${length} ${shQuote(apkPath)}`]);
}

// 读取设备文件末尾 length 字节（tail -c）
async function readApkTail(apkPath: string, length: number): Promise<Buffer> {
  return await runAdbBuffer(["exec-out", `tail -c ${length} ${shQuote(apkPath)}`]);
}

// 从尾部缓冲里解析 End of Central Directory
function parseEocd(tail: Buffer): { cdSize: number; cdOffset: number; commentLen: number } | null {
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === ZIP_EOCD) {
      const cdSize = tail.readUInt32LE(i + 12);
      const cdOffset = tail.readUInt32LE(i + 16);
      const commentLen = tail.readUInt16LE(i + 20);
      if (i + 22 + commentLen === tail.length) {
        return { cdSize, cdOffset, commentLen };
      }
    }
  }
  return null;
}

// 从中央目录缓冲区解析指定文件名的条目
function findEntries(cd: Buffer, names: string[]): Map<string, ApkEntry> {
  const found = new Map<string, ApkEntry>();
  let p = 0;
  while (p + 46 <= cd.length && cd.readUInt32LE(p) === ZIP_CDH) {
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    const compressedSize = cd.readUInt32LE(p + 20);
    const localHeaderOffset = cd.readUInt32LE(p + 42);
    const name = cd.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    const headerLen = 46 + nameLen + extraLen + commentLen;
    if (names.includes(name) && !found.has(name)) {
      found.set(name, {
        name, nameLen, extraLen, compressedSize, localHeaderOffset,
        centralHeader: Buffer.from(cd.subarray(p, p + headerLen)),
      });
    }
    p += headerLen;
  }
  return found;
}

// 用 front（前段原始字节）重建仅含给定条目的合法最小 zip；失败返回 null
function buildMinimalApk(entries: ApkEntry[], front: Buffer): Buffer | null {
  const parts: Buffer[] = [];
  const rebuiltCd: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const start = e.localHeaderOffset;
    if (start + 30 > front.length || front.readUInt32LE(start) !== ZIP_LFH) return null;
    const localNameLen = front.readUInt16LE(start + 26);
    const localExtraLen = front.readUInt16LE(start + 28);
    const totalLen = 30 + localNameLen + localExtraLen + e.compressedSize;
    if (start + totalLen > front.length) return null;
    parts.push(front.subarray(start, start + totalLen));
    const ch = Buffer.from(e.centralHeader);
    ch.writeUInt32LE(offset, 42); // 修正 local header offset
    rebuiltCd.push(ch);
    offset += totalLen;
  }
  const cdOffset = offset;
  const cd = Buffer.concat(rebuiltCd);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(ZIP_EOCD, 0);
  eocd.writeUInt16LE(rebuiltCd.length, 8);
  eocd.writeUInt16LE(rebuiltCd.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  return Buffer.concat([...parts, cd, eocd]);
}

// 尝试仅读前段 + 尾部重建最小 APK；失败/小文件返回 null（走整包 pull）
async function buildMinimalApkFromDevice(apkPath: string): Promise<Buffer | null> {
  try {
    const size = await getApkSize(apkPath);
    if (size < 8 * 1024 * 1024) return null; // 小 APK 整包 pull 也很快
    const first = await readApkTail(apkPath, Math.min(size, 262144));
    const eocd = parseEocd(first);
    if (!eocd) return null;
    const need = eocd.cdSize + 22 + eocd.commentLen;
    let tail = first;
    if (need > first.length) tail = await readApkTail(apkPath, Math.min(size, need + 64));
    const cdStart = tail.length - 22 - eocd.commentLen - eocd.cdSize;
    if (cdStart < 0) return null;
    const cd = tail.subarray(cdStart, cdStart + eocd.cdSize);
    const entries = findEntries(cd, ["AndroidManifest.xml", "resources.arsc"]);
    if (!entries.has("AndroidManifest.xml")) return null;
    const list = [...entries.values()];
    let frontEnd = 0;
    for (const e of list) {
      frontEnd = Math.max(frontEnd, e.localHeaderOffset + 30 + e.nameLen + e.extraLen + e.compressedSize);
    }
    if (frontEnd <= 0 || frontEnd > size) return null;
    const front = await readApkHead(apkPath, frontEnd + 64);
    return buildMinimalApk(list, front);
  } catch {
    return null;
  }
}

async function aaptLabel(apk: string): Promise<string> {
  try {
    const { stdout } = await runAapt(["dump", "badging", apk]);
    return (stdout.match(/application-label:'([^']*)'/) || ["", ""])[1]?.trim() || "";
  } catch {
    return "";
  }
}

// 读取 APK 应用显示名称：大 APK 用前段+尾部重建，失败则整包 pull
async function resolveAppName(apkPath: string): Promise<string> {
  const tmp = path.join(os.tmpdir(), `iwcs-apk-${randomUUID().slice(0, 8)}.apk`);
  try {
    let label = "";
    const minimal = await buildMinimalApkFromDevice(apkPath);
    if (minimal) {
      fs.writeFileSync(tmp, minimal);
      label = await aaptLabel(tmp);
    }
    if (!label) {
      await runAdb(["pull", apkPath, tmp], 120000);
      label = await aaptLabel(tmp);
    }
    return label;
  } catch {
    return "";
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch { /* 清理失败忽略 */ }
  }
}

function listAndroidFiles(): RecordFile[] {
  const dir = androidOutputDir();
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
    try {
      const stat = fs.statSync(full);
      files.push({ path: full, name: entry.name, size: stat.size, modifiedAt: stat.mtime.toISOString() });
    } catch {
      // 单个文件读取失败则跳过
    }
  }
  files.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  return files;
}

function allowedAndroidDirs(): string[] {
  const dir = androidOutputDir();
  return [dir.endsWith(path.sep) ? dir : dir + path.sep];
}

function findAndroidFile(target: string): string | null {
  if (!target) return null;
  const resolved = path.resolve(target);
  if (!/\.mp4$/i.test(path.basename(resolved))) return null;
  for (const dir of allowedAndroidDirs()) {
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

export function createAndroidRouter(): Router {
  const router = Router();

  router.get("/devices", async (_req, res) => {
    try {
      const { stdout } = await runAdb(["devices", "-l"], 15000);
      const devices = parseDevices(stdout);
      log("info", "android", `列出 ${devices.length} 台 Android 设备`);
      res.json({ devices });
    } catch (err) {
      const error = mapError(err);
      log("error", "android", "获取设备列表失败", error);
      sendError(res, 502, codeForError(error), error, { devices: [] });
    }
  });

  router.get("/apps", async (_req, res) => {
    try {
      const packages = await listThirdPartyPackages();
      const apps: AndroidApp[] = [];
      for (const pkg of packages) {
        let name = appNameCache.get(pkg.packageName);
        if (name === undefined) {
          name = (await resolveAppName(pkg.apkPath)) || pkg.packageName;
          appNameCache.set(pkg.packageName, name);
        }
        apps.push({ packageName: pkg.packageName, name });
      }
      log("info", "android", `列出 ${apps.length} 个第三方应用`);
      res.json({ apps, total: apps.length });
    } catch (err) {
      const error = mapError(err);
      log("error", "android", "获取应用列表失败", error);
      sendError(res, 502, codeForError(error), error, { apps: [], total: 0 });
    }
  });

  router.post("/install", async (req, res) => {
    const apkPath = String(req.body?.apkPath ?? "").trim();
    if (!apkPath) return sendError(res, 400, "INVALID_REQUEST", "缺少 APK 路径", { ok: false });
    try {
      let packageName = "";
      try {
        const { stdout } = await runAapt(["dump", "badging", apkPath]);
        const m = stdout.match(/^package:\s*name='([^']+)'/m);
        packageName = m ? m[1] : "";
      } catch {
        // 解析包名失败不阻断卸载安装
      }
      // 卸载旧版本（设备上不存在则忽略），实现卸载安装
      if (packageName) {
        try {
          await runAdb(["uninstall", packageName], 60000);
          log("info", "android", `卸载旧版本 ${packageName}`);
        } catch (err) {
          log("warn", "android", `卸载 ${packageName} 失败（可能未安装），继续安装`, messageOf(err));
        }
      }
      await runAdb(["install", "-r", apkPath], 300000);
      log("info", "android", `卸载安装完成 ${apkPath}`, { packageName });
      res.json({ ok: true, packageName });
    } catch (err) {
      const error = mapError(err);
      log("error", "android", `安装失败 ${apkPath}`, error);
      sendError(res, 502, codeForError(error), error, { ok: false });
    }
  });

  router.post("/uninstall", async (req, res) => {
    const packageName = String(req.body?.packageName ?? "").trim();
    if (!packageName) return sendError(res, 400, "INVALID_REQUEST", "缺少包名", { ok: false });
    try {
      await runAdb(["uninstall", packageName], 60000);
      log("info", "android", `卸载 ${packageName}`);
      res.json({ ok: true });
    } catch (err) {
      const error = mapError(err);
      log("error", "android", `卸载失败 ${packageName}`, error);
      sendError(res, 502, codeForError(error), error, { ok: false });
    }
  });

  router.post("/force-stop", async (req, res) => {
    const packageName = String(req.body?.packageName ?? "").trim();
    if (!packageName) return sendError(res, 400, "INVALID_REQUEST", "缺少包名", { ok: false });
    try {
      await runAdb(["shell", "am", "force-stop", packageName], 15000);
      log("info", "android", `已关闭应用 ${packageName}`);
      res.json({ ok: true });
    } catch (err) {
      const error = mapError(err);
      log("error", "android", `关闭应用失败 ${packageName}`, error);
      sendError(res, 502, codeForError(error), error, { ok: false });
    }
  });

  router.post("/clear-data", async (req, res) => {
    const packageName = String(req.body?.packageName ?? "").trim();
    if (!packageName) return sendError(res, 400, "INVALID_REQUEST", "缺少包名", { ok: false });
    try {
      await runAdb(["shell", "pm", "clear", packageName], 15000);
      log("info", "android", `已清除数据 ${packageName}`);
      res.json({ ok: true });
    } catch (err) {
      const error = mapError(err);
      log("error", "android", `清除数据失败 ${packageName}`, error);
      sendError(res, 502, codeForError(error), error, { ok: false });
    }
  });

  router.get("/status", (_req, res) => {
    res.json(getAndroidRecordStatus());
  });

  // ---------------- 快捷控制 ----------------
  // 重启设备：adb reboot 会让设备立即离线，命令可能返回非零/超时，这是预期行为，不要记成错误
  router.post("/control/reboot", async (_req, res) => {
    try {
      await execFileAsync(adbBin(), ["reboot"], {
        encoding: "utf8", timeout: 15000, windowsHide: true,
      }).catch(() => undefined);
      log("info", "android", "已发送重启指令");
      res.json({ ok: true, message: "已发送重启指令" });
    } catch {
      log("info", "android", "已发送重启指令（设备开始重启）");
      res.json({ ok: true, message: "已发送重启指令" });
    }
  });

  // 锁屏/唤醒：电源键 toggle（亮屏锁屏、息屏唤醒）
  router.post("/control/screen", async (_req, res) => {
    try {
      await runAdb(["shell", "input", "keyevent", "26"], 15000);
      log("info", "android", "已发送电源键");
      res.json({ ok: true, message: "已发送电源键" });
    } catch (err) {
      const error = mapError(err);
      log("error", "android", "锁屏/唤醒失败", error);
      sendError(res, 502, codeForError(error), error, { ok: false });
    }
  });

  // 切换开发者模式
  router.post("/control/devmode", async (_req, res) => {
    try {
      const { stdout } = await runAdb(["shell", "settings", "get", "global", "development_settings_enabled"], 15000);
      const enabled = String(stdout).trim() === "1";
      const next = enabled ? "0" : "1";
      await runAdb(["shell", "settings", "put", "global", "development_settings_enabled", next], 15000);
      const label = next === "1" ? "开启" : "关闭";
      log("info", "android", `开发者模式已${label}`);
      res.json({ ok: true, enabled: next === "1", message: `开发者模式已${label}` });
    } catch (err) {
      const error = mapError(err);
      log("error", "android", "切换开发者模式失败", error);
      sendError(res, 502, codeForError(error), error, { ok: false });
    }
  });

  // 切换 WiFi
  router.post("/control/wifi", async (_req, res) => {
    try {
      const { stdout } = await runAdb(["shell", "settings", "get", "global", "wifi_on"], 15000);
      const enabled = String(stdout).trim() === "1";
      const next = enabled ? "0" : "1";
      await runAdb(["shell", "svc", "wifi", next === "1" ? "enable" : "disable"], 15000);
      const label = next === "1" ? "开启" : "关闭";
      log("info", "android", `WiFi 已${label}`);
      res.json({ ok: true, enabled: next === "1", message: `WiFi 已${label}` });
    } catch (err) {
      const error = mapError(err);
      log("error", "android", "切换 WiFi 失败", error);
      sendError(res, 502, codeForError(error), error, { ok: false });
    }
  });

  // 获取手机时间（年月日）
  router.get("/control/time", async (_req, res) => {
    try {
      const { stdout } = await runAdb(["shell", "date", "+%Y-%m-%d"], 15000);
      const date = String(stdout).trim();
      log("info", "android", `手机日期 ${date}`);
      res.json({ ok: true, date });
    } catch (err) {
      const error = mapError(err);
      log("error", "android", "获取时间失败", error);
      sendError(res, 502, codeForError(error), error, { ok: false, date: "" });
    }
  });

  router.post("/record/start", async (req, res) => {
    const serial = String(req.body?.serial ?? "").trim();
    if (!serial) return sendError(res, 400, "INVALID_REQUEST", "缺少设备序列号", { ...getAndroidRecordStatus() });
    if (state.recording) return sendError(res, 409, "CONTROL_LOCKED", "录制已在运行", { ...getAndroidRecordStatus() });
    try {
      const dir = androidOutputDir();
      const base = `Android_${localDateStamp()}_${randomUUID().slice(0, 4)}`;
      const filePath = path.join(dir, `${base}.mp4`);
      const pid = await startScrcpy(filePath, serial);
      state.recording = true;
      state.filePath = filePath;
      state.startedAt = Date.now();
      state.serial = serial;
      state.pid = pid;
      log("info", "android", "录制开始", { serial, filePath, pid });
      res.json(getAndroidRecordStatus());
    } catch (err) {
      const error = messageOf(err);
      log("error", "android", "开始录制失败", error);
      sendError(res, 500, "INTERNAL_ERROR", error, { ...getAndroidRecordStatus() });
    }
  });

  router.post("/record/stop", async (_req, res) => {
    if (!state.recording || state.pid === null) {
      return sendError(res, 409, "CONTROL_LOCKED", "当前没有进行中的录制", { ...getAndroidRecordStatus() });
    }
    try {
      res.json(await stopAndroidRecording());
    } catch (err) {
      const error = messageOf(err);
      log("error", "android", "停止录制失败", error);
      sendError(res, 500, "INTERNAL_ERROR", error, { ...getAndroidRecordStatus() });
    }
  });

  router.get("/files", (_req, res) => {
    res.json({ files: listAndroidFiles() });
  });

  router.post("/open-dir", (_req, res) => {
    const dir = androidOutputDir();
    try {
      fs.mkdirSync(dir, { recursive: true });
      const escaped = dir.replace(/'/g, "''");
      execFile(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", `(New-Object -ComObject Shell.Application).Explore('${escaped}')`],
        { windowsHide: true },
        (error) => {
          if (error) log("error", "android", "打开目录失败", messageOf(error));
        },
      );
      log("info", "android", "已打开目录", { dir });
      res.json({ ok: true });
    } catch (error) {
      sendError(res, 500, "INTERNAL_ERROR", messageOf(error), { ok: false });
    }
  });

  router.get("/stream", (req, res) => {
    const file = findAndroidFile(String(req.query.path ?? ""));
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
      res.writeHead(206, {
        "Content-Range": `bytes ${start}-${end}/${fileSize}`,
        "Accept-Ranges": "bytes",
        "Content-Length": (end - start) + 1,
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
    const file = findAndroidFile(String(req.body?.path ?? ""));
    if (!file) return sendError(res, 404, "NOT_FOUND", "录制文件不存在或不在允许的目录内");
    try {
      fs.unlinkSync(file);
      log("info", "android", "录制文件已删除", { file });
      res.json({ ok: true });
    } catch (error) {
      sendError(res, 500, "INTERNAL_ERROR", messageOf(error), { ok: false });
    }
  });

  router.post("/rename", (req, res) => {
    const file = findAndroidFile(String(req.body?.path ?? ""));
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
    if (!allowedAndroidDirs().some((dir) => resolved.startsWith(dir))) {
      return sendError(res, 400, "INVALID_NAME", "新文件名必须保持在录制目录内");
    }
    try {
      if (fs.existsSync(resolved)) {
        return sendError(res, 409, "ALREADY_EXISTS", "同名文件已存在");
      }
      fs.renameSync(file, resolved);
      log("info", "android", "录制文件已重命名", { from: file, to: resolved });
      res.json({ path: resolved, name: path.basename(resolved) });
    } catch (error) {
      sendError(res, 500, "INTERNAL_ERROR", messageOf(error));
    }
  });

  router.get("/scan-apk", (req, res) => {
    const raw = String(req.query.dir ?? "").trim();
    if (!raw) return sendError(res, 400, "INVALID_REQUEST", "缺少路径", { files: [] });
    const resolved = path.resolve(raw);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(resolved);
    } catch (error) {
      return sendError(res, 400, "INVALID_REQUEST", `无法访问路径：${messageOf(error)}`, { files: [] });
    }

    const files: { path: string; name: string; size: number }[] = [];
    if (stat.isFile()) {
      if (/\.apk$/i.test(resolved)) {
        files.push({ path: resolved, name: path.basename(resolved), size: stat.size });
      }
    } else if (stat.isDirectory()) {
      const walk = (dir: string): void => {
        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else if (entry.isFile() && /\.apk$/i.test(entry.name)) {
            try {
              files.push({ path: full, name: entry.name, size: fs.statSync(full).size });
            } catch {
              // 单个文件读取失败则跳过
            }
          }
        }
      };
      walk(resolved);
    }

    files.sort((a, b) => a.name.localeCompare(b.name));
    log("info", "android", `扫描 ${resolved}，找到 ${files.length} 个 APK`);
    res.json({ files });
  });

  return router;
}
