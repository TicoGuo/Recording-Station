import { Router } from "express";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getConfig } from "./config";
import { nativeCore } from "./native-core";

const execFileAsync = promisify(execFile);

interface EnvCheck {
  ok: boolean;
  message: string;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function checkCore(): Promise<EnvCheck> {
  try {
    await nativeCore.initialize();
    return { ok: true, message: "Core 已加载，无需桌面客户端" };
  } catch (error) {
    return { ok: false, message: messageOf(error) };
  }
}

async function checkFfmpeg(): Promise<EnvCheck> {
  try {
    const { stdout } = await execFileAsync(getConfig().ffmpegPath, ["-version"], {
      encoding: "utf8",
      timeout: 3000,
      windowsHide: true,
    });
    return { ok: true, message: String(stdout).split(/\r?\n/, 1)[0] || "可用" };
  } catch (error) {
    return { ok: false, message: messageOf(error) };
  }
}

async function checkUsb(): Promise<EnvCheck> {
  try {
    // 以真实设备枚举为准：能枚举到在线设备即认为屏幕采集可用。
    // getEnvironment() 是静态预探测，未投屏时 UsbDk 等后端为"尚未探测"状态，不能反映真实录制能力。
    const devices = await nativeCore.listDevices();
    const online = devices.filter((d) => d.connected).length;
    if (online > 0) {
      return { ok: true, message: `屏幕采集可用，已连接 ${online} 台设备` };
    }
    const env = await nativeCore.getEnvironment();
    return { ok: false, message: `未检测到可采集设备（${env.diagnostic || "请连接 iPhone"}）` };
  } catch (error) {
    return { ok: false, message: messageOf(error) };
  }
}

async function checkIdeviceinstaller(): Promise<EnvCheck> {
  try {
    await execFileAsync(getConfig().ideviceinstallerPath, ["--help"], {
      encoding: "utf8",
      timeout: 3000,
      windowsHide: true,
    });
    return { ok: true, message: "已安装" };
  } catch (err) {
    if ((err as any)?.code === "ENOENT") {
      return { ok: false, message: "未安装" };
    }
    return { ok: true, message: "已安装" };
  }
}

async function checkAndroid(): Promise<EnvCheck> {
  try {
    const { stdout } = await execFileAsync(getConfig().adbPath, ["devices", "-l"], {
      encoding: "utf8",
      timeout: 15000,
      windowsHide: true,
    });
    const online = String(stdout).split(/\r?\n/).filter((raw) => {
      const line = raw.trim();
      if (!line || /^List of devices/i.test(line)) return false;
      const parts = line.split(/\s+/);
      return parts.length >= 2 && parts[1] === "device";
    }).length;
    if (online > 0) return { ok: true, message: `屏幕采集可用，已连接 ${online} 台设备` };
    return { ok: false, message: "未检测到 Android 设备（请通过 USB 连接并开启 USB 调试）" };
  } catch (error) {
    return { ok: false, message: messageOf(error) };
  }
}

export function createHealthRouter(): Router {
  const router = Router();

  router.get("/", async (_req, res) => {
    const [core, ffmpeg, usb, ideviceinstaller, android] = await Promise.all([
      checkCore(),
      checkFfmpeg(),
      checkUsb(),
      checkIdeviceinstaller(),
      checkAndroid(),
    ]);
    res.json({ core, ffmpeg, usb, ideviceinstaller, android });
  });

  return router;
}
