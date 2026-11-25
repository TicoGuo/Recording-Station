import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { NativeEnvironment } from "./native-core";

const execFileAsync = promisify(execFile);

const APPLE_DEVICES_URL = "https://apps.microsoft.com/detail/9np83lwlpz9k";
const ITUNES_URL = "https://support.apple.com/downloads/itunes";
const USBDK_URL = "https://github.com/daynix/UsbDk/releases";
const VCREDIST_URL = "https://aka.ms/vs/17/release/vc_redist.x64.exe";
const MEDIA_FEATURE_URL = "https://support.microsoft.com/en-us/topic/media-feature-pack-list-for-windows-n-editions-c1c6fffa-d052-8338-7a79-a4bb980a700a";

export interface DependencyCheck {
  errors: string[];
  warnings: string[];
}

function system32Path(...parts: string[]): string {
  return path.join(process.env.SystemRoot || "C:\\Windows", "System32", ...parts);
}

function fileExists(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function missingSystemDlls(names: string[]): string[] {
  return names.filter((name) => !fileExists(system32Path(name)));
}

// 在运行包 redist/ 目录中查找已附带的可再分发安装器；源码环境或未附带的包返回 null。
function redistInstaller(pattern: RegExp): string | null {
  try {
    const dir = path.join(process.cwd(), "redist");
    if (!fs.statSync(dir).isDirectory()) return null;
    const name = fs.readdirSync(dir).find((f) => pattern.test(f));
    return name ? path.join(dir, name) : null;
  } catch {
    return null;
  }
}

function appleInstallGuidance(): string {
  return `请安装 Microsoft Store“Apple 设备”（${APPLE_DEVICES_URL}）或 Apple 官方 iTunes（${ITUNES_URL}），确保包含 Apple Mobile Device Support`;
}

async function checkAppleService(): Promise<string | null> {
  let output = "";
  try {
    const result = await execFileAsync("sc.exe", ["query", "Apple Mobile Device Service"], {
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
    });
    output = result.stdout;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if ((error as any)?.code === 1060 || /1060|does not exist|不存在/.test(detail)) {
      return `未安装 Apple Mobile Device Service。${appleInstallGuidance()}`;
    }
    return `无法查询 Apple Mobile Device Service：${detail}。${appleInstallGuidance()}`;
  }

  if (!/\bSTATE\s*:\s*4\s+RUNNING\b/i.test(output)) {
    return `Apple Mobile Device Service 已安装但未运行。请启动该服务后重试；若服务不存在或无法启动，${appleInstallGuidance()}`;
  }
  return null;
}

export async function checkWindowsDependencies(): Promise<DependencyCheck> {
  const errors: string[] = [];
  const warnings: string[] = [];

  const vcRuntimeMissing = missingSystemDlls([
    "msvcp140.dll",
    "vcruntime140.dll",
    "vcruntime140_1.dll",
    "ucrtbase.dll",
  ]);
  if (vcRuntimeMissing.length > 0) {
    const local = redistInstaller(/^vc_redist.*\.exe$/i);
    const hint = local
      ? `运行包已附带安装器，请运行 ${local}`
      : `请安装 Microsoft 官方 Visual C++ 2015-2022 x64 运行库：${VCREDIST_URL}`;
    errors.push(`缺少 Visual C++/UCRT 运行库（${vcRuntimeMissing.join("、")}）。${hint}`);
  }

  const mediaFoundationMissing = missingSystemDlls(["mfplat.dll", "mf.dll"]);
  if (mediaFoundationMissing.length > 0) {
    errors.push(`缺少 Media Foundation（${mediaFoundationMissing.join("、")}）。Windows N 版请安装 Microsoft 官方 Media Feature Pack：${MEDIA_FEATURE_URL}`);
  }

  const appleError = await checkAppleService();
  if (appleError) errors.push(appleError);
  return { errors, warnings };
}

export function checkCaptureBackend(environment: NativeEnvironment): DependencyCheck {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (environment.usbdkBackendKnown && environment.usbdkBackendAvailable) {
    return { errors, warnings };
  }
  if (environment.libusbRuntimeAvailable && environment.libusbAppleDevicesKnown && environment.libusbAppleDevices > 0) {
    return { errors, warnings };
  }

  const localUsbDk = redistInstaller(/^UsbDk.*\.msi$/i);
  const usbdkHint = localUsbDk
    ? `运行包已附带安装器 ${localUsbDk}，可直接运行安装；或从官方下载：${USBDK_URL}`
    : `请从官方下载安装 UsbDk：${USBDK_URL}`;
  const usbdkHelperExists = fileExists(system32Path("UsbDkHelper.dll")) ||
    fileExists(path.join(process.env.ProgramFiles || "C:\\Program Files", "UsbDk Runtime Library", "UsbDkHelper.dll"));
  const usbdkDriverExists = fileExists(system32Path("drivers", "UsbDk.sys"));
  const libusb0DriverExists = fileExists(system32Path("drivers", "libusb0.sys"));
  const installGuidance = `未检测到可用的 USB 采集后端。${usbdkHint}；或使用与当前 Core 同版本的原版 TicoGemini 驱动管理器配置 libusb0 过滤驱动。不要用 Zadig 替换 Apple 父设备驱动`;

  // libusb0 的设备级 UpperFilter 绑定只能在真实采集时确认，不能仅凭 sys 文件宣称可用。
  if (libusb0DriverExists) {
    warnings.push("已检测到 libusb0 驱动；设备级过滤绑定和采集能力将在开始录制时进一步验证");
    return { errors, warnings };
  }

  if (usbdkHelperExists && !usbdkDriverExists) {
    errors.push(`检测到 UsbDkHelper.dll，但缺少 UsbDk.sys。请重新安装或修复 UsbDk。${usbdkHint}`);
  } else if (!usbdkHelperExists && usbdkDriverExists) {
    errors.push(`检测到 UsbDk.sys，但缺少 UsbDkHelper.dll。请重新安装或修复 UsbDk。${usbdkHint}`);
  } else if (!usbdkHelperExists) {
    errors.push(installGuidance);
  } else if (environment.usbdkBackendKnown && !environment.usbdkBackendAvailable) {
    errors.push(`UsbDk 已安装但后端不可用。请重新安装或修复 UsbDk。${usbdkHint}；也可由原版 TicoGemini 驱动管理器配置 libusb0`);
  } else {
    warnings.push("UsbDk 已安装，但 Core 尚未探测后端状态；将在开始录制时确认，未将其误判为故障");
  }

  return { errors, warnings };
}
