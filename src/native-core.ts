import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import koffi, { type LibraryHandle, type TypeObject } from "koffi";
import { getConfig } from "./config";

const API_VERSION = 18;
const RESULT_OK = 0;
const RESULT_BUFFER_TOO_SMALL = -3;
const RESULT_NO_DATA = -7;
const RESULT_RESTORE_WARNING = -12;
const MAX_DEVICE_COUNT = 64;
const MAX_VIDEO_BUFFER = 64 * 1024 * 1024;
const MAX_AUDIO_BUFFER = 16 * 1024 * 1024;

const WideString = (length: number) => koffi.array("char16_t", length, "String");

const DeviceInfo = koffi.struct("IwcsDeviceInfo", {
  struct_size: "uint32_t",
  api_version: "uint32_t",
  device_id: "uint32_t",
  mux_port: "uint32_t",
  state: "int32_t",
  usb_connected: "int32_t",
  pair_record_present: "int32_t",
  lockdown_accessible: "int32_t",
  udid: WideString(128),
  name: WideString(128),
  product_type: WideString(64),
  os_version: WideString(32),
  connection_type: WideString(32),
  status: WideString(192),
});

const EnvironmentInfo = koffi.struct("IwcsEnvironmentInfo", {
  struct_size: "uint32_t",
  api_version: "uint32_t",
  apple_mobile_device_service_installed: "int32_t",
  apple_mobile_device_service_running: "int32_t",
  standard_usbmux_available: "int32_t",
  capture_usbmux_available: "int32_t",
  physical_apple_usb_devices: "uint32_t",
  diagnostic: WideString(512),
  libusb_runtime_available: "int32_t",
  usbdk_backend_available: "int32_t",
  libusb_apple_devices: "uint32_t",
  libusb_version: WideString(32),
  usbdk_backend_known: "int32_t",
  libusb_apple_devices_known: "int32_t",
});

const CaptureOptions = koffi.struct("IwcsCaptureOptions", {
  struct_size: "uint32_t",
  api_version: "uint32_t",
  requested_width: "uint32_t",
  requested_height: "uint32_t",
  target_fps: "uint32_t",
  play_audio: "int32_t",
  audio_volume: "float",
  reserved: koffi.array("uint32_t", 5),
});

const CaptureStatus = koffi.struct("IwcsCaptureStatus", {
  struct_size: "uint32_t",
  api_version: "uint32_t",
  state: "int32_t",
  width: "uint32_t",
  height: "uint32_t",
  fps: "double",
  latency_ms: "double",
  video_frames: "uint64_t",
  audio_packets: "uint64_t",
  audio_sample_rate: "uint32_t",
  audio_channels: "uint32_t",
  failure_kind: "int32_t",
  failure_stage: "int32_t",
  error_code: "int32_t",
  message: WideString(192),
});

const VideoFrameInfo = koffi.struct("IwcsVideoFrameInfo", {
  struct_size: "uint32_t",
  api_version: "uint32_t",
  width: "uint32_t",
  height: "uint32_t",
  stride: "uint32_t",
  pixel_format: "uint32_t",
  timestamp_100ns: "int64_t",
});

const AudioPacketInfo = koffi.struct("IwcsAudioPacketInfo", {
  struct_size: "uint32_t",
  api_version: "uint32_t",
  sequence: "uint64_t",
  sample_rate: "uint32_t",
  channels: "uint16_t",
  bits_per_sample: "uint16_t",
});

const VideoPacketInfo = koffi.struct("IwcsVideoPacketInfo", {
  struct_size: "uint32_t",
  api_version: "uint32_t",
  timestamp_100ns: "int64_t",
  duration_100ns: "int64_t",
  keyframe: "uint32_t",
  data_size: "uint32_t",
});

const VideoOutputStatus = koffi.struct("IwcsVideoOutputStatus", {
  struct_size: "uint32_t",
  api_version: "uint32_t",
  monitor_hdr_capability: "uint32_t",
  source_hdr_known: "int32_t",
  source_hdr: "int32_t",
  actual_hdr_surface: "int32_t",
  hdr_effective: "int32_t",
  requested_color_output_preference: "uint32_t",
  requested_decoder_preference: "uint32_t",
  applied_decoder_preference: "uint32_t",
  decoder_switch_state: "uint32_t",
  decoder_runtime_mode: "uint32_t",
  requested_decoder_generation: "uint64_t",
  applied_decoder_generation: "uint64_t",
});

const EXPECTED_LAYOUTS: Array<[string, TypeObject, number]> = [
  ["CaptureOptions", CaptureOptions, 48],
  ["VideoFrameInfo", VideoFrameInfo, 32],
  ["AudioPacketInfo", AudioPacketInfo, 24],
  ["VideoPacketInfo", VideoPacketInfo, 32],
  ["DeviceInfo", DeviceInfo, 1184],
  ["CaptureStatus", CaptureStatus, 464],
  ["EnvironmentInfo", EnvironmentInfo, 1136],
  ["VideoOutputStatus", VideoOutputStatus, 64],
];

export function assertNativeLayouts(): void {
  if (process.platform !== "win32" || process.arch !== "x64") {
    throw new Error("采集核心仅支持 Windows x64");
  }
  for (const [name, type, expected] of EXPECTED_LAYOUTS) {
    const actual = koffi.sizeof(type);
    if (actual !== expected) {
      throw new Error(`${name} 结构大小不匹配：期望 ${expected}，实际 ${actual}`);
    }
  }
}

type NativeFunction = ReturnType<LibraryHandle["func"]>;

interface CoreFunctions {
  initialize: NativeFunction;
  shutdown: NativeFunction;
  apiVersion: NativeFunction;
  refreshDevices: NativeFunction;
  getEnvironment: NativeFunction;
  sessionCreate: NativeFunction;
  sessionStop: NativeFunction;
  sessionDestroy: NativeFunction;
  sessionGetStatus: NativeFunction;
  sessionGetVideoOutputStatus: NativeFunction;
  getLatestVideoTimestamp: NativeFunction;
  copyVideoFrame: NativeFunction;
  copyVideoPacket: NativeFunction;
  copyVideoParameterSets: NativeFunction;
  copyAudioPacket: NativeFunction;
}

export interface NativeDevice {
  id: string;
  name: string;
  connected: boolean;
  controlReady: boolean;
  productType: string;
  osVersion: string;
  connectionType: string;
  state: number;
  message: string;
}

export interface NativeEnvironment {
  appleServiceInstalled: boolean;
  appleServiceRunning: boolean;
  standardUsbmuxAvailable: boolean;
  captureUsbmuxAvailable: boolean;
  physicalDeviceCount: number;
  libusbRuntimeAvailable: boolean;
  usbdkBackendAvailable: boolean;
  usbdkBackendKnown: boolean;
  libusbAppleDevices: number;
  libusbAppleDevicesKnown: boolean;
  diagnostic: string;
}

export interface NativeCaptureStatus {
  state: number;
  width: number;
  height: number;
  fps: number;
  latencyMs: number;
  videoFrames: bigint;
  audioPackets: bigint;
  audioSampleRate: number;
  audioChannels: number;
  failureKind: number;
  failureStage: number;
  errorCode: number;
  message: string;
}

export interface NativeVideoFrame {
  width: number;
  height: number;
  timestamp100ns: bigint;
  data: Buffer;
}

export interface NativeAudioPacket {
  sequence: bigint;
  sampleRate: number;
  channels: number;
  data: Buffer;
}

export interface NativeVideoPacket {
  timestamp100ns: bigint;
  duration100ns: bigint;
  keyframe: boolean;
  data: Buffer;
}

function invoke<T>(fn: NativeFunction, ...args: unknown[]): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    fn.async(...args, (err: unknown, result: T) => {
      if (err) reject(err);
      else resolve(result);
    });
  });
}

function coreError(action: string, result: number): Error {
  const messages: Record<number, string> = {
    [-1]: "参数错误",
    [-2]: "核心尚未初始化",
    [-4]: "设备传输不可用",
    [-5]: "设备协议错误",
    [-6]: "设备未找到",
    [-8]: "采集会话已存在",
    [-9]: "USB 驱动安全策略阻止",
    [-10]: "USB 配置尚未就绪",
    [-11]: "采集会话停止失败",
  };
  return new Error(`${action}：${messages[result] ?? `Core 错误 ${result}`}`);
}

function checkResult(action: string, result: number): void {
  if (result !== RESULT_OK) throw coreError(action, result);
}

function createStructBuffer(type: TypeObject): Buffer {
  const buffer = Buffer.alloc(koffi.sizeof(type));
  buffer.writeUInt32LE(buffer.length, 0);
  return buffer;
}

export class NativeCore {
  private functions: CoreFunctions | null = null;
  private libusb0Library: LibraryHandle | null = null;
  private initialized = false;
  private activeHandle: bigint | null = null;
  private activeUdid: string | null = null;
  private tail: Promise<void> = Promise.resolve();
  private videoBuffer: Buffer | null = null;
  private audioBuffer = Buffer.allocUnsafe(64 * 1024);

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  private load(corePath: string): CoreFunctions {
    if (this.functions) return this.functions;
    assertNativeLayouts();

    // Core 的 legacy 后端会按 System32 规则查找 libusb0。先以绝对路径加载并持有句柄，
    // 确保后续延迟加载复用项目内的 x64 DLL，而不是系统目录中的同名副本。
    if (!this.libusb0Library) {
      this.libusb0Library = koffi.load(path.join(path.dirname(corePath), "libusb0.dll"));
    }
    const lib = koffi.load(corePath);
    this.functions = {
      initialize: lib.func("int32_t tg_initialize()"),
      shutdown: lib.func("void tg_shutdown()"),
      apiVersion: lib.func("uint32_t tg_api_version()"),
      refreshDevices: lib.func("int32_t tg_refresh_devices_ex(void *devices, _Inout_ uint32_t *count, int32_t refresh_metadata)"),
      getEnvironment: lib.func("int32_t tg_get_environment(void *environment)"),
      sessionCreate: lib.func("int32_t tg_session_create(str16 udid, void *options, _Out_ uint64_t *handle)"),
      sessionStop: lib.func("int32_t tg_session_stop(uint64_t handle)"),
      sessionDestroy: lib.func("void tg_session_destroy(uint64_t handle)"),
      sessionGetStatus: lib.func("int32_t tg_session_get_status(uint64_t handle, void *status)"),
      sessionGetVideoOutputStatus: lib.func("int32_t tg_session_get_video_output_status(uint64_t handle, void *hwnd, void *status)"),
      getLatestVideoTimestamp: lib.func("int32_t tg_session_get_latest_video_timestamp(uint64_t handle, _Out_ int64_t *timestamp_100ns)"),
      copyVideoFrame: lib.func("int32_t tg_session_copy_latest_video_frame_nv12(uint64_t handle, void *info, uint8_t *buffer, _Inout_ uint32_t *buffer_size, uint32_t output_width, uint32_t output_height)"),
      copyVideoPacket: lib.func("int32_t tg_session_copy_next_video_packet(uint64_t handle, void *info, uint8_t *buffer, _Inout_ uint32_t *buffer_size)"),
      copyVideoParameterSets: lib.func("int32_t tg_session_copy_video_parameter_sets(uint64_t handle, uint8_t *buffer, _Inout_ uint32_t *buffer_size)"),
      copyAudioPacket: lib.func("int32_t tg_session_copy_next_audio_packet(uint64_t handle, uint64_t after_sequence, void *info, uint8_t *buffer, _Inout_ uint32_t *buffer_size)"),
    };
    return this.functions;
  }

  private async ensureInitialized(corePath: string): Promise<CoreFunctions> {
    const functions = this.load(corePath);
    if (this.initialized) return functions;
    const version = await invoke<number>(functions.apiVersion);
    if (version !== API_VERSION) {
      throw new Error(`采集核心 API 版本不匹配：期望 ${API_VERSION}，实际 ${version}`);
    }
    checkResult("初始化采集核心失败", await invoke<number>(functions.initialize));
    this.initialized = true;
    return functions;
  }

  initialize(corePath = getConfig().corePath): Promise<void> {
    return this.enqueue(async () => {
      await this.ensureInitialized(corePath);
    });
  }

  listDevices(refreshMetadata = false): Promise<NativeDevice[]> {
    return this.enqueue(async () => {
      const functions = await this.ensureInitialized(getConfig().corePath);
      for (let attempt = 0; attempt < 3; attempt++) {
        const count = [0];
        checkResult("查询设备数量失败", await invoke<number>(functions.refreshDevices, null, count, refreshMetadata ? 1 : 0));
        const required = count[0];
        if (required === 0) return [];
        if (required > MAX_DEVICE_COUNT) throw new Error(`设备数量异常：${required}`);
        const buffer = Buffer.alloc(koffi.sizeof(DeviceInfo) * required);
        count[0] = required;
        const result = await invoke<number>(functions.refreshDevices, buffer, count, refreshMetadata ? 1 : 0);
        if (result === RESULT_BUFFER_TOO_SMALL) continue;
        checkResult("读取设备列表失败", result);
        const devices: NativeDevice[] = [];
        for (let index = 0; index < count[0]; index++) {
          const raw = koffi.decode(buffer, index * koffi.sizeof(DeviceInfo), DeviceInfo);
          devices.push({
            id: raw.udid,
            name: raw.name || raw.udid || "iPhone",
            connected: raw.usb_connected !== 0 && raw.state >= 2,
            controlReady: raw.state >= 3 && raw.lockdown_accessible !== 0,
            productType: raw.product_type,
            osVersion: raw.os_version,
            connectionType: raw.connection_type,
            state: raw.state,
            message: raw.status,
          });
        }
        return devices;
      }
      throw new Error("设备列表在读取过程中持续变化，请稍后重试");
    });
  }

  getEnvironment(): Promise<NativeEnvironment> {
    return this.enqueue(async () => {
      const functions = await this.ensureInitialized(getConfig().corePath);
      const buffer = createStructBuffer(EnvironmentInfo);
      checkResult("读取 USB 环境失败", await invoke<number>(functions.getEnvironment, buffer));
      const raw = koffi.decode(buffer, EnvironmentInfo);
      return {
        appleServiceInstalled: raw.apple_mobile_device_service_installed !== 0,
        appleServiceRunning: raw.apple_mobile_device_service_running !== 0,
        standardUsbmuxAvailable: raw.standard_usbmux_available !== 0,
        captureUsbmuxAvailable: raw.capture_usbmux_available !== 0,
        physicalDeviceCount: raw.physical_apple_usb_devices,
        libusbRuntimeAvailable: raw.libusb_runtime_available !== 0,
        usbdkBackendAvailable: raw.usbdk_backend_available !== 0,
        usbdkBackendKnown: raw.usbdk_backend_known !== 0,
        libusbAppleDevices: raw.libusb_apple_devices,
        libusbAppleDevicesKnown: raw.libusb_apple_devices_known !== 0,
        diagnostic: raw.diagnostic,
      };
    });
  }

  startDemoSession(udid: string): Promise<bigint> {
    return this.enqueue(async () => {
      if (this.activeHandle !== null) throw new Error("采集会话已存在");
      const functions = await this.ensureInitialized(getConfig().corePath);
      const options = createStructBuffer(CaptureOptions);
      koffi.encode(options, CaptureOptions, {
        struct_size: koffi.sizeof(CaptureOptions),
        api_version: API_VERSION,
        requested_width: 0,
        requested_height: 0,
        target_fps: 0,
        play_audio: 0,
        audio_volume: 0,
        // reserved[2] = USB 投影模式：0=demo，1=AirPlay，2=Aisi。
        // 实测 AirPlay 在 USB2.0 下开局短暂 60fps 后仍会限流回 30fps，且解码器状态变"未知"，故保持 demo。
        reserved: [0, 0, 0, 0, 0],
      });
      const handle = [0n];
      checkResult("创建录制模式会话失败", await invoke<number>(functions.sessionCreate, udid, options, handle));
      if (handle[0] === 0n) throw new Error("采集核心未返回有效会话");
      this.activeHandle = handle[0];
      this.activeUdid = udid;
      this.videoBuffer = null;
      this.audioBuffer = Buffer.allocUnsafe(64 * 1024);
      return handle[0];
    });
  }

  getSessionStatus(): Promise<NativeCaptureStatus> {
    return this.enqueue(async () => {
      if (this.activeHandle === null) throw new Error("当前没有采集会话");
      const functions = await this.ensureInitialized(getConfig().corePath);
      const buffer = createStructBuffer(CaptureStatus);
      checkResult("读取采集状态失败", await invoke<number>(functions.sessionGetStatus, this.activeHandle, buffer));
      const raw = koffi.decode(buffer, CaptureStatus);
      return {
        state: raw.state,
        width: raw.width,
        height: raw.height,
        fps: raw.fps,
        latencyMs: raw.latency_ms,
        videoFrames: BigInt(raw.video_frames),
        audioPackets: BigInt(raw.audio_packets),
        audioSampleRate: raw.audio_sample_rate,
        audioChannels: raw.audio_channels,
        failureKind: raw.failure_kind,
        failureStage: raw.failure_stage,
        errorCode: raw.error_code,
        message: raw.message,
      };
    });
  }

  getVideoOutputStatus(): Promise<{ decoderRuntimeMode: number; decoderSwitchState: number; appliedDecoderPreference: number }> {
    return this.enqueue(async () => {
      if (this.activeHandle === null) throw new Error("当前没有采集会话");
      const functions = await this.ensureInitialized(getConfig().corePath);
      const buffer = createStructBuffer(VideoOutputStatus);
      checkResult("读取视频输出状态失败", await invoke<number>(functions.sessionGetVideoOutputStatus, this.activeHandle, null, buffer));
      const raw = koffi.decode(buffer, VideoOutputStatus);
      return {
        decoderRuntimeMode: raw.decoder_runtime_mode,
        decoderSwitchState: raw.decoder_switch_state,
        appliedDecoderPreference: raw.applied_decoder_preference,
      };
    });
  }

  getLatestVideoTimestamp(): Promise<bigint> {
    return this.enqueue(async () => {
      if (this.activeHandle === null) throw new Error("当前没有采集会话");
      const functions = await this.ensureInitialized(getConfig().corePath);
      const ts = [0n];
      checkResult("读取视频时间戳失败", await invoke<number>(functions.getLatestVideoTimestamp, this.activeHandle, ts));
      return ts[0];
    });
  }

  async waitForStreaming(timeoutMs = 60000): Promise<NativeCaptureStatus> {
    const deadline = Date.now() + timeoutMs;
    let latest: NativeCaptureStatus | null = null;
    while (Date.now() < deadline) {
      latest = await this.getSessionStatus();
      if (latest.state === 4 && latest.width > 0 && latest.height > 0) return latest;
      if (latest.state === 7) throw new Error(latest.message || `采集失败（${latest.errorCode}）`);
      if (latest.state === 6) throw new Error(latest.message || "采集会话已停止");
      await delay(250);
    }
    throw new Error(latest?.message || "等待设备进入录制模式超时");
  }

  readVideoFrame(width: number, height: number): Promise<NativeVideoFrame | null> {
    return this.enqueue(async () => {
      if (this.activeHandle === null) throw new Error("当前没有采集会话");
      if (width <= 0 || height <= 0 || (width & 1) !== 0 || (height & 1) !== 0) {
        throw new Error("NV12 输出尺寸必须为正的偶数");
      }
      const expected = width * height * 3 / 2;
      if (!Number.isSafeInteger(expected) || expected > MAX_VIDEO_BUFFER) {
        throw new Error("NV12 帧尺寸过大");
      }
      if (!this.videoBuffer || this.videoBuffer.length !== expected) {
        this.videoBuffer = Buffer.allocUnsafe(expected);
      }
      const functions = await this.ensureInitialized(getConfig().corePath);
      const info = createStructBuffer(VideoFrameInfo);
      for (let attempt = 0; attempt < 2; attempt++) {
        const size = [this.videoBuffer.length];
        const result = await invoke<number>(functions.copyVideoFrame, this.activeHandle, info, this.videoBuffer, size, width, height);
        if (result === RESULT_NO_DATA) return null;
        if (result === RESULT_BUFFER_TOO_SMALL) {
          if (size[0] > MAX_VIDEO_BUFFER) throw new Error("Core 返回的视频帧过大");
          this.videoBuffer = Buffer.allocUnsafe(size[0]);
          continue;
        }
        checkResult("读取 NV12 视频帧失败", result);
        const raw = koffi.decode(info, VideoFrameInfo);
        if (raw.pixel_format !== 2 || raw.width !== width || raw.height !== height || raw.stride !== width || size[0] !== expected) {
          throw new Error("Core 返回了无效的 NV12 帧布局");
        }
        return {
          width,
          height,
          timestamp100ns: BigInt(raw.timestamp_100ns),
          data: Buffer.from(this.videoBuffer.subarray(0, size[0])),
        };
      }
      throw new Error("视频帧缓冲区重试失败");
    });
  }

  readVideoPacket(): Promise<NativeVideoPacket | null> {
    return this.enqueue(async () => {
      if (this.activeHandle === null) throw new Error("当前没有采集会话");
      const functions = await this.ensureInitialized(getConfig().corePath);
      const info = createStructBuffer(VideoPacketInfo);
      // copy_next_video_packet 是破坏性出队，必须单次调用，不能两段式先查大小
      const buffer = Buffer.allocUnsafe(16 * 1024 * 1024);
      const size = [buffer.length];
      const result = await invoke<number>(functions.copyVideoPacket, this.activeHandle, info, buffer, size);
      if (result === RESULT_NO_DATA) return null;
      if (result === RESULT_BUFFER_TOO_SMALL) return null; // 包过大，极少见，丢弃
      checkResult("读取原始视频包失败", result);
      const raw = koffi.decode(info, VideoPacketInfo);
      return {
        timestamp100ns: BigInt(raw.timestamp_100ns),
        duration100ns: BigInt(raw.duration_100ns),
        keyframe: raw.keyframe !== 0,
        data: Buffer.from(buffer.subarray(0, size[0])),
      };
    });
  }

  getVideoParameterSets(): Promise<Buffer> {
    return this.enqueue(async () => {
      if (this.activeHandle === null) throw new Error("当前没有采集会话");
      const functions = await this.ensureInitialized(getConfig().corePath);
      const buffer = Buffer.allocUnsafe(1024 * 1024);
      const size = [buffer.length];
      const result = await invoke<number>(functions.copyVideoParameterSets, this.activeHandle, buffer, size);
      if (result === RESULT_NO_DATA || result === RESULT_BUFFER_TOO_SMALL) return Buffer.alloc(0);
      checkResult("读取视频参数集失败", result);
      return Buffer.from(buffer.subarray(0, size[0]));
    });
  }

  readAudioPacket(afterSequence: bigint): Promise<NativeAudioPacket | null> {
    return this.enqueue(async () => {
      if (this.activeHandle === null) throw new Error("当前没有采集会话");
      const functions = await this.ensureInitialized(getConfig().corePath);
      const info = createStructBuffer(AudioPacketInfo);
      for (let attempt = 0; attempt < 2; attempt++) {
        const size = [this.audioBuffer.length];
        const result = await invoke<number>(functions.copyAudioPacket, this.activeHandle, afterSequence, info, this.audioBuffer, size);
        if (result === RESULT_NO_DATA) return null;
        if (result === RESULT_BUFFER_TOO_SMALL) {
          if (size[0] > MAX_AUDIO_BUFFER) throw new Error("Core 返回的音频包过大");
          this.audioBuffer = Buffer.allocUnsafe(size[0]);
          continue;
        }
        checkResult("读取 PCM 音频失败", result);
        const raw = koffi.decode(info, AudioPacketInfo);
        if (raw.bits_per_sample !== 16 || raw.sample_rate <= 0 || raw.channels <= 0 || raw.channels > 2 || size[0] % (raw.channels * 2) !== 0) {
          throw new Error("Core 返回了无效的 PCM16 音频包");
        }
        return {
          sequence: BigInt(raw.sequence),
          sampleRate: raw.sample_rate,
          channels: raw.channels,
          data: Buffer.from(this.audioBuffer.subarray(0, size[0])),
        };
      }
      throw new Error("音频包缓冲区重试失败");
    });
  }

  stopSession(): Promise<void> {
    return this.enqueue(async () => {
      if (this.activeHandle === null || !this.functions) {
        this.activeHandle = null;
        this.activeUdid = null;
        return;
      }
      const handle = this.activeHandle;
      try {
        const result = await invoke<number>(this.functions.sessionStop, handle);
        if (result !== RESULT_OK && result !== RESULT_RESTORE_WARNING) {
          throw coreError("停止采集会话失败", result);
        }
      } finally {
        try {
          await invoke<void>(this.functions.sessionDestroy, handle);
        } finally {
          this.activeHandle = null;
          this.activeUdid = null;
          this.videoBuffer = null;
          this.audioBuffer = Buffer.allocUnsafe(64 * 1024);
        }
      }
    });
  }

  shutdown(): Promise<void> {
    return this.enqueue(async () => {
      if (this.activeHandle !== null && this.functions) {
        const handle = this.activeHandle;
        try {
          await invoke<number>(this.functions.sessionStop, handle);
        } finally {
          try {
            await invoke<void>(this.functions.sessionDestroy, handle);
          } finally {
            this.activeHandle = null;
            this.activeUdid = null;
            this.videoBuffer = null;
          }
        }
      }
      if (this.initialized && this.functions) {
        await invoke<void>(this.functions.shutdown);
        this.initialized = false;
      }
    });
  }

  get hasActiveSession(): boolean {
    return this.activeHandle !== null;
  }

  get activeDeviceId(): string | null {
    return this.activeUdid;
  }
}

export const nativeCore = new NativeCore();
