import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { Router } from "express";
import { log } from "./logger";
import { getConfig } from "./config";
import { sendError, messageOf, codeForError } from "./http-errors";
import type { App } from "./types";

const execFileAsync = promisify(execFile);

function ideviceBin(): string {
  return getConfig().ideviceinstallerPath;
}

function isCommandNotFound(err: unknown): boolean {
  return (err as any)?.code === "ENOENT";
}

// ideviceinstaller 存在两种调用风格：
//   旧/msys 构建：标志式  -l / -U <bundleId> / -i <path>
//   新构建：      子命令式 list / uninstall <bundleId> / install <path>
// 启动后探测一次并缓存。
type IdeviceStyle = "flag" | "sub";
let stylePromise: Promise<IdeviceStyle> | null = null;

function detectStyle(): Promise<IdeviceStyle> {
  if (!stylePromise) {
    stylePromise = (async () => {
      try {
        const r = await execFileAsync(ideviceBin(), ["--help"], { encoding: "utf8" });
        const text = ((r.stdout || "") + (r.stderr || "")).toLowerCase();
        if (text.includes("--list-apps")) return "flag";
        return "sub";
      } catch {
        return "flag";
      }
    })();
  }
  return stylePromise;
}

async function ideviceArgs(op: "list" | "uninstall" | "install", arg?: string): Promise<string[]> {
  const style = await detectStyle();
  if (style === "flag") {
    if (op === "list") return ["-l"];
    if (op === "uninstall") return ["-U", arg!];
    return ["-i", arg!];
  }
  if (op === "list") return ["list"];
  if (op === "uninstall") return ["uninstall", arg!];
  return ["install", arg!];
}

function mapError(err: unknown): string {
  const message = String((err as any)?.message ?? err ?? "");
  const stderr = String((err as any)?.stderr ?? "");
  const combined = message + "\n" + stderr;
  if ((err as any)?.killed === true || /SIGTERM|ETIMEDOUT|timed out/i.test(combined)) {
    return "操作超时，请确认设备已连接并响应正常后重试。";
  }
  if (/Could not connect|lockdownd|No device|Unable to connect|no device/i.test(combined)) {
    return "设备未连接，请确认 iPhone 已通过 USB 连接并已信任此电脑。";
  }
  if (/Untrusted|untrusted|developer|entitlement|证书/i.test(combined)) {
    return "未信任开发者证书，请在 iPhone 设置中信任该证书后重试。";
  }
  if (/protected|受保护|cannot uninstall|rejected/i.test(combined)) {
    return "该应用为受保护应用，无法卸载。";
  }
  if (message) return message;
  return "操作失败。";
}

async function runIdevice(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return await execFileAsync(ideviceBin(), args, { encoding: "utf8", timeout: 60000 });
}

// 从 IPA（zip 格式）中提取 Payload/*.app/Info.plist 内容
function extractInfoPlistFromIpa(ipaPath: string): Buffer | null {
  let buf: Buffer;
  try {
    buf = fs.readFileSync(ipaPath);
  } catch {
    return null;
  }
  // 扫描 zip local file header（signature PK\x03\x04 = 0x04034b50）
  for (let offset = 0; offset + 30 <= buf.length; ) {
    if (buf.readUInt32LE(offset) !== 0x04034b50) { offset++; continue; }
    const method = buf.readUInt16LE(offset + 8);
    const compressedSize = buf.readUInt32LE(offset + 18);
    const nameLen = buf.readUInt16LE(offset + 26);
    const extraLen = buf.readUInt16LE(offset + 28);
    const name = buf.subarray(offset + 30, offset + 30 + nameLen).toString("utf8");
    const dataStart = offset + 30 + nameLen + extraLen;
    if (/^Payload\/[^/]+\.app\/Info\.plist$/i.test(name)) {
      const compressed = buf.subarray(dataStart, dataStart + compressedSize);
      if (method === 0) return compressed; // stored
      if (method === 8) {
        try { return zlib.inflateRawSync(compressed); } catch { return null; }
      }
      return null;
    }
    offset = dataStart + compressedSize;
  }
  return null;
}

// 从 Info.plist 中提取 CFBundleIdentifier（兼容 XML 与二进制 plist）
function extractBundleIdFromPlist(plist: Buffer): string | null {
  // XML plist
  const xmlMatch = plist.toString("utf8").match(/<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/);
  if (xmlMatch) return xmlMatch[1].trim();
  // 二进制 plist：key 与 bundleId 字符串均为明文，向后找最近的 bundleId 形态
  const keyBuf = Buffer.from("CFBundleIdentifier", "ascii");
  const idx = plist.indexOf(keyBuf);
  if (idx >= 0) {
    const tail = plist.subarray(idx + keyBuf.length, idx + keyBuf.length + 256).toString("latin1");
    const m = tail.match(/[A-Za-z0-9][A-Za-z0-9._-]{2,}/);
    if (m) return m[0];
  }
  return null;
}

function extractBundleId(ipaPath: string): string | null {
  const plist = extractInfoPlistFromIpa(ipaPath);
  return plist ? extractBundleIdFromPlist(plist) : null;
}

// 解析带引号的 CSV 行
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      fields.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  fields.push(cur.trim());
  return fields;
}

function parseList(stdout: string): App[] {
  const apps: App[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (/^CFBundleIdentifier/i.test(line)) continue; // 表头
    if (line.includes(" - ") && !line.startsWith('"')) {
      // 旧式：bundleId - name version
      const idx = line.indexOf(" - ");
      const bundleId = line.slice(0, idx).trim();
      const rest = line.slice(idx + 3).trim();
      const sp = rest.lastIndexOf(" ");
      apps.push({
        bundleId,
        name: sp > 0 ? rest.slice(0, sp).trim() : rest,
        version: sp > 0 ? rest.slice(sp + 1).trim() : "",
      });
    } else {
      // CSV：bundleId, version, name（可能带引号）
      const f = parseCsvLine(line);
      if (f.length >= 2) {
        apps.push({ bundleId: f[0], version: f[1] || "", name: f[2] || f[0] });
      }
    }
  }
  return apps;
}

export function createAppsRouter(): Router {
  const router = Router();

  router.get("/", async (_req, res) => {
    try {
      const args = await ideviceArgs("list");
      const { stdout } = await runIdevice(args);
      const apps = parseList(stdout);
      log("info", "apps", `列出 ${apps.length} 个应用`);
      res.json({ apps });
    } catch (err) {
      if (isCommandNotFound(err)) {
        log("warn", "apps", "未找到 ideviceinstaller");
        return sendError(res, 503, "DEPENDENCY_MISSING", "未找到 ideviceinstaller，请安装 libimobiledevice", { apps: [] });
      }
      const error = mapError(err);
      log("error", "apps", "获取应用列表失败", error);
      sendError(res, 502, codeForError(error), error, { apps: [] });
    }
  });

  router.post("/uninstall", async (req, res) => {
    const bundleId = String(req.body?.bundleId ?? "");
    if (!bundleId) return sendError(res, 400, "INVALID_REQUEST", "缺少 bundleId", { ok: false });
    try {
      const args = await ideviceArgs("uninstall", bundleId);
      await runIdevice(args);
      log("info", "apps", `卸载 ${bundleId}`);
      res.json({ ok: true });
    } catch (err) {
      if (isCommandNotFound(err)) {
        return sendError(res, 503, "DEPENDENCY_MISSING", "未找到 ideviceinstaller，请安装 libimobiledevice", { ok: false });
      }
      const error = mapError(err);
      log("error", "apps", `卸载失败 ${bundleId}`, error);
      sendError(res, 502, codeForError(error), error, { ok: false });
    }
  });

  router.post("/install", async (req, res) => {
    const ipaPath = String(req.body?.ipaPath ?? "");
    if (!ipaPath) return sendError(res, 400, "INVALID_REQUEST", "缺少 IPA 路径", { ok: false });
    try {
      const args = await ideviceArgs("install", ipaPath);
      await runIdevice(args);
      log("info", "apps", `安装 ${ipaPath}`);
      res.json({ ok: true });
    } catch (err) {
      if (isCommandNotFound(err)) {
        return sendError(res, 503, "DEPENDENCY_MISSING", "未找到 ideviceinstaller，请安装 libimobiledevice", { ok: false });
      }
      const error = mapError(err);
      log("error", "apps", `安装失败 ${ipaPath}`, error);
      sendError(res, 502, codeForError(error), error, { ok: false });
    }
  });

  // 卸载安装：安装前先卸载旧版本（删除所有数据），设备上不存在则直接安装
  router.post("/reinstall", async (req, res) => {
    const ipaPath = String(req.body?.ipaPath ?? "");
    if (!ipaPath) return sendError(res, 400, "INVALID_REQUEST", "缺少 IPA 路径", { ok: false });
    try {
      const bundleId = extractBundleId(ipaPath);
      if (bundleId) {
        try {
          const uninstallArgs = await ideviceArgs("uninstall", bundleId);
          await runIdevice(uninstallArgs);
          log("info", "apps", `卸载旧版本 ${bundleId}`);
        } catch (err) {
          // 设备上没有该应用或卸载失败时忽略，继续安装
          log("warn", "apps", `卸载 ${bundleId} 失败（可能未安装），继续安装`, messageOf(err));
        }
      } else {
        log("warn", "apps", "未能从 IPA 提取 bundleId，跳过卸载，直接安装");
      }
      const installArgs = await ideviceArgs("install", ipaPath);
      await runIdevice(installArgs);
      log("info", "apps", `卸载安装完成 ${ipaPath}`);
      res.json({ ok: true });
    } catch (err) {
      if (isCommandNotFound(err)) {
        return sendError(res, 503, "DEPENDENCY_MISSING", "未找到 ideviceinstaller，请安装 libimobiledevice", { ok: false });
      }
      const error = mapError(err);
      log("error", "apps", `卸载安装失败 ${ipaPath}`, error);
      sendError(res, 502, codeForError(error), error, { ok: false });
    }
  });

  // 扫描 IPA：支持直接传入 .ipa 文件路径，或传入目录后递归查找其中所有 .ipa
  router.get("/scan-ipa", (req, res) => {
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
      if (/\.ipa$/i.test(resolved)) {
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
          else if (entry.isFile() && /\.ipa$/i.test(entry.name)) {
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
    log("info", "apps", `扫描 ${resolved}，找到 ${files.length} 个 IPA`);
    res.json({ files });
  });

  return router;
}
