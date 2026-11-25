import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "./types";

// 项目根目录：相对于本文件 (src/config.ts) 向上一级。
// 用 __dirname 而非 process.cwd()，确保从任何目录启动都读写同一份 config.json / DLL / FFmpeg。
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");

const CONFIG_FILE = path.join(PROJECT_ROOT, "config.json");

// 内部依赖路径：始终按项目根目录动态解析，不写入配置文件。
const internalPaths = {
  corePath: path.join(PROJECT_ROOT, "runtime/native/TicoGemini.Core.dll"),
  ffmpegPath: path.join(PROJECT_ROOT, "runtime/ffmpeg/ffmpeg.exe"),
  ffprobePath: path.join(PROJECT_ROOT, "runtime/ffmpeg/ffprobe.exe"),
  ideviceinstallerPath: path.join(PROJECT_ROOT, "msys64/ucrt64/bin/ideviceinstaller.exe"),
  scrcpyPath: path.join(PROJECT_ROOT, "runtime/scrcpy/scrcpy.exe"),
  adbPath: path.join(PROJECT_ROOT, "runtime/scrcpy/adb.exe"),
  aaptPath: path.join(PROJECT_ROOT, "runtime/aapt/aapt.exe"),
};

// 用户可配置项：只把需要在网页里改的设置写进 config.json
type UserConfig = Pick<Config, "outputPath" | "androidOutputPath" | "ipaPath" | "apkPath" | "lastPlatform" | "fps" | "listenHost" | "gatewayPort" | "logLevel">;

const defaultUserConfig: UserConfig = {
  outputPath: "recording/ios",
  androidOutputPath: "recording/android",
  ipaPath: "",
  apkPath: "",
  lastPlatform: "ios",
  fps: 60,
  listenHost: "127.0.0.1",
  gatewayPort: 8787,
  logLevel: "info",
};

function normalizeUserConfig(cfg: UserConfig): UserConfig {
  return {
    ...cfg,
    outputPath: (cfg.outputPath ?? "").trim() || "recording/ios",
    androidOutputPath: (cfg.androidOutputPath ?? "").trim() || "recording/android",
    ipaPath: (cfg.ipaPath ?? "").trim(),
    apkPath: (cfg.apkPath ?? "").trim(),
    lastPlatform: cfg.lastPlatform === "android" ? "android" : "ios",
  };
}

function pickUserConfig(cfg: Partial<Config>): UserConfig {
  return {
    outputPath: cfg.outputPath ?? defaultUserConfig.outputPath,
    androidOutputPath: cfg.androidOutputPath ?? defaultUserConfig.androidOutputPath,
    ipaPath: cfg.ipaPath ?? defaultUserConfig.ipaPath,
    apkPath: cfg.apkPath ?? defaultUserConfig.apkPath,
    lastPlatform: cfg.lastPlatform ?? defaultUserConfig.lastPlatform,
    fps: cfg.fps ?? defaultUserConfig.fps,
    listenHost: cfg.listenHost ?? defaultUserConfig.listenHost,
    gatewayPort: cfg.gatewayPort ?? defaultUserConfig.gatewayPort,
    logLevel: cfg.logLevel ?? defaultUserConfig.logLevel,
  };
}

let cached: Config | null = null;

export function getConfig(): Config {
  if (cached) return cached;

  let user: UserConfig = { ...defaultUserConfig };
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const raw = fs.readFileSync(CONFIG_FILE, "utf-8");
      const parsed = JSON.parse(raw);
      user = normalizeUserConfig({ ...defaultUserConfig, ...pickUserConfig(parsed) });
    } else {
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(user, null, 2), "utf-8");
    }
  } catch {
    // 配置文件损坏或不可写时回退到默认值
  }

  cached = { ...internalPaths, ...user };
  return cached;
}

export function saveConfig(partial: Partial<Config>): Config {
  const merged = { ...getConfig(), ...partial };
  const user = normalizeUserConfig(pickUserConfig(merged));
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(user, null, 2), "utf-8");
  cached = { ...internalPaths, ...user };
  return cached;
}

export interface PublicConfig {
  outputPath: string;
  androidOutputPath: string;
  ipaPath: string;
  apkPath: string;
  lastPlatform: string;
  fps: number;
}

export function publicConfig(cfg: Config): PublicConfig {
  return {
    outputPath: cfg.outputPath,
    androidOutputPath: cfg.androidOutputPath,
    ipaPath: cfg.ipaPath,
    apkPath: cfg.apkPath,
    lastPlatform: cfg.lastPlatform,
    fps: cfg.fps,
  };
}
