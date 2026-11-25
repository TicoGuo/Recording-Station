import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { execFile } from "node:child_process";
import { createServer, type Server, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import type { Writable } from "node:stream";
import { log } from "./logger";
import { nativeCore, type NativeAudioPacket, type NativeVideoPacket } from "./native-core";
import type { RecordStatus } from "./types";

const execFileAsync = promisify(execFile);
const H264_ENCODERS = ["h264_nvenc", "h264_amf", "h264_qsv", "h264_mf", "libx264"] as const;
const MAX_STDERR_LENGTH = 64 * 1024;
const FINALIZE_TIMEOUT_MS = 120_000;
const AUDIO_SILENCE_GRACE_MS = 100;
const MAX_AUDIO_DRAIN_PACKETS = 512;

type VideoProvider = (width: number, height: number) => Promise<{ data: Buffer; timestamp100ns: bigint } | null>;
type AudioProvider = (afterSequence: bigint) => Promise<NativeAudioPacket | null>;

interface AudioPipe {
  path: string;
  server: Server;
  connected: Promise<Socket>;
  socket: Socket | null;
}

interface ProcessExit {
  code: number | null;
  error?: Error;
}

interface ActiveOutput {
  process: ChildProcessWithoutNullStreams | null;
  exited: Promise<ProcessExit> | null;
  stderr: { value: string } | null;
  controller: AbortController;
  destination: string;
  stagingPath: string;
  fps: number;
  width: number;
  height: number;
  encoder: string;
  remux: boolean;
  firstAudio: NativeAudioPacket | null;
  audioPipe: AudioPipe | null;
  ffmpegPath: string;
  videoRawPath: string;
  audioRawPath: string;
  startedAt: number;
  framesWritten: number;
  stopping: boolean;
  runPromise: Promise<void> | null;
}

export interface MediaOutputRequest {
  width: number;
  height: number;
  fps: number;
  destination: string;
  bitrateKbps?: number;
  ffmpegPath?: string;
  remux?: boolean;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function ffmpegError(active: Pick<ActiveOutput, "stderr">, fallback: string): Error {
  const detail = (active.stderr?.value ?? "").trim().split(/\r?\n/).filter(Boolean).slice(-4).join("\n");
  return new Error(detail ? `${fallback}\n${detail}` : fallback);
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

async function writeChunk(stream: Writable, data: Buffer, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw signal.reason;
  if (stream.destroyed || stream.writableEnded) throw new Error("FFmpeg 输入管道已关闭");
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(signal.reason);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      signal.removeEventListener("abort", onAbort);
      stream.off("error", onError);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    stream.once("error", onError);
    stream.write(data, (error) => {
      cleanup();
      if (error) reject(error);
      else resolve();
    });
  });
}

async function closeWritable(stream: Writable): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    stream.once("error", reject);
    stream.end(() => {
      stream.off("error", reject);
      resolve();
    });
  });
}

async function createAudioPipe(): Promise<AudioPipe> {
  const name = `iwcs-audio-${process.pid}-${randomUUID()}`;
  const pipe: AudioPipe = {
    path: `\\\\.\\pipe\\${name}`,
    server: createServer(),
    connected: Promise.resolve(null as unknown as Socket),
    socket: null,
  };
  let resolveConnection: (socket: Socket) => void = () => undefined;
  pipe.connected = new Promise<Socket>((resolve) => {
    resolveConnection = resolve;
  });
  pipe.server.on("connection", (socket) => {
    pipe.socket = socket;
    socket.on("error", () => undefined);
    resolveConnection(socket);
  });
  await new Promise<void>((resolve, reject) => {
    pipe.server.once("error", reject);
    pipe.server.listen(pipe.path, () => {
      pipe.server.off("error", reject);
      resolve();
    });
  });
  return pipe;
}

function closeAudioPipe(pipe: AudioPipe | null, destroy = false): void {
  if (!pipe) return;
  if (pipe.socket) {
    if (destroy) pipe.socket.destroy();
    else pipe.socket.end();
  }
  pipe.server.close();
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function encoderPixelFormat(encoder: string): string {
  return encoder === "libx264" ? "yuv420p" : "nv12";
}

function addEncoderOptions(args: string[], encoder: string): void {
  if (encoder === "libx264") args.push("-preset", "veryfast", "-tune", "zerolatency");
  else if (encoder === "h264_nvenc") args.push("-preset", "p4", "-tune", "hq");
  else if (encoder === "h264_amf") args.push("-usage", "high_quality");
  else if (encoder === "h264_qsv") args.push("-preset", "medium");
  else if (encoder === "h264_mf") args.push("-hw_encoding", "1", "-scenario", "archive");
}

export function buildFfmpegArguments(
  request: Required<Pick<MediaOutputRequest, "width" | "height" | "fps" | "destination">> & {
    bitrateKbps: number;
  },
  encoder: string,
  audio: { pipePath: string; sampleRate: number; channels: number } | null,
): string[] {
  const args = ["-hide_banner", "-loglevel", "warning", "-nostdin"];
  if (audio) {
    args.push(
      "-thread_queue_size", "512", "-f", "s16le",
      "-ar", String(audio.sampleRate), "-ac", String(audio.channels),
      "-i", audio.pipePath,
    );
  }
  args.push(
    "-f", "rawvideo", "-pixel_format", "nv12",
    "-video_size", `${request.width}x${request.height}`,
    "-framerate", String(request.fps),
    "-color_range", "pc", "-colorspace", "bt709",
    "-color_primaries", "bt709", "-color_trc", "bt709",
    "-i", "pipe:0",
  );
  if (audio) args.push("-map", "1:v:0", "-map", "0:a:0");
  else args.push("-map", "0:v:0", "-an");
  args.push("-c:v", encoder);
  addEncoderOptions(args, encoder);
  args.push(
    "-color_range", "pc", "-colorspace", "bt709",
    "-color_primaries", "bt709", "-color_trc", "bt709",
    "-pix_fmt", encoderPixelFormat(encoder),
    "-g", String(request.fps * 2),
    "-b:v", `${request.bitrateKbps}k`,
    "-maxrate", `${request.bitrateKbps}k`,
    "-bufsize", `${request.bitrateKbps * 2}k`,
  );
  if (audio) args.push("-c:a", "aac", "-b:a", "192k");
  args.push("-movflags", "+faststart", "-y", request.destination);
  return args;
}

function h264AvccToAnnexB(data: Buffer): Buffer {
  const parts: Buffer[] = [];
  let offset = 0;
  while (offset + 4 <= data.length) {
    const len = data.readUInt32BE(offset);
    offset += 4;
    if (len <= 0 || offset + len > data.length) break;
    parts.push(Buffer.from([0, 0, 0, 1]));
    parts.push(data.subarray(offset, offset + len));
    offset += len;
  }
  return Buffer.concat(parts);
}

function spawnFfmpeg(ffmpegPath: string, args: string[]): {
  process: ChildProcessWithoutNullStreams;
  exited: Promise<ProcessExit>;
  stderr: { value: string };
} {
  const process = spawn(ffmpegPath, args, {
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  process.stdout.resume();
  process.stdin.on("error", () => undefined);
  const stderr = { value: "" };
  process.stderr.setEncoding("utf8");
  process.stderr.on("data", (chunk: string) => {
    stderr.value = (stderr.value + chunk).slice(-MAX_STDERR_LENGTH);
  });
  const exited = new Promise<ProcessExit>((resolve) => {
    process.once("error", (error) => resolve({ code: null, error }));
    process.once("close", (code) => resolve({ code }));
  });
  return { process, exited, stderr };
}

async function canEncodeFrame(ffmpegPath: string, encoder: string, width: number, height: number): Promise<boolean> {
  const args = [
    "-hide_banner", "-loglevel", "error", "-nostdin",
    "-f", "rawvideo", "-pixel_format", "nv12",
    "-video_size", `${width}x${height}`, "-framerate", "30",
    "-color_range", "pc", "-colorspace", "bt709",
    "-color_primaries", "bt709", "-color_trc", "bt709",
    "-i", "pipe:0", "-frames:v", "1", "-an", "-c:v", encoder,
  ];
  addEncoderOptions(args, encoder);
  args.push(
    "-color_range", "pc", "-colorspace", "bt709",
    "-color_primaries", "bt709", "-color_trc", "bt709",
    "-pix_fmt", encoderPixelFormat(encoder), "-f", "null", "-",
  );
  const child = spawnFfmpeg(ffmpegPath, args);
  const frame = Buffer.alloc(width * height * 3 / 2);
  frame.fill(16, 0, width * height);
  frame.fill(128, width * height);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("编码器探测超时")), 10_000);
  try {
    await writeChunk(child.process.stdin, frame, controller.signal);
    child.process.stdin.end();
    const exit = await withTimeout(child.exited, 10_000, "编码器探测超时");
    return exit.code === 0;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    controller.abort();
    child.process.stdin.destroy();
    if (child.process.exitCode === null && !child.process.killed) child.process.kill();
  }
}

export async function selectWorkingEncoder(
  ffmpegPath: string,
  width: number,
  height: number,
): Promise<string> {
  let listing: string;
  try {
    const result = await execFileAsync(ffmpegPath, ["-hide_banner", "-encoders"], {
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    });
    listing = `${result.stdout}\n${result.stderr}`;
  } catch (error) {
    throw new Error(`无法执行 FFmpeg：${errorMessage(error)}`);
  }
  const candidates = H264_ENCODERS.filter((encoder) =>
    new RegExp(`\\b${encoder}\\b`, "i").test(listing));
  for (const encoder of candidates) {
    if (await canEncodeFrame(ffmpegPath, encoder, width, height)) return encoder;
  }
  throw new Error("FFmpeg 没有可用于当前分辨率的 H.264 编码器");
}

async function prepareStagingPath(destination: string): Promise<string> {
  const directory = path.dirname(destination);
  const name = path.basename(destination, path.extname(destination));
  if (!directory || !name || path.extname(destination).toLowerCase() !== ".mp4") {
    throw new Error("录制文件必须是完整的 .mp4 路径");
  }
  await fs.mkdir(directory, { recursive: true });
  const staging = path.join(directory, `${name}.partial.mp4`);
  const marker = `${staging}.finalized`;
  try {
    await fs.access(staging);
    await fs.access(marker);
    throw new Error(`存在尚未发布的完整录制，请先保存：${staging}`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("存在尚未发布")) throw error;
  }
  await fs.rm(marker, { force: true });
  await fs.rm(staging, { force: true });
  return staging;
}

async function publishFinalized(stagingPath: string, destination: string): Promise<void> {
  const marker = `${stagingPath}.finalized`;
  await fs.writeFile(marker, "");
  try {
    // 同一目录内创建硬链接等价于不覆盖的原子发布；目标存在时会直接失败。
    await fs.link(stagingPath, destination);
    await fs.unlink(stagingPath);
    await fs.unlink(marker);
  } catch (error) {
    throw new Error(`完整录制已保留在 ${stagingPath}，但发布失败：${errorMessage(error)}`);
  }
}

class Pcm16Normalizer {
  private sourceRate = 0;
  private sourceChannels = 0;
  private rateRemainder = 0;

  constructor(private readonly targetRate: number, private readonly targetChannels: number) {}

  convert(packet: NativeAudioPacket): Buffer {
    if (packet.sampleRate === this.targetRate && packet.channels === this.targetChannels) {
      return packet.data;
    }
    if (packet.sampleRate < 8000 || packet.sampleRate > 192000 || packet.channels < 1 || packet.channels > 2) {
      throw new Error("不支持的 PCM 音频格式");
    }
    if (this.sourceRate !== packet.sampleRate || this.sourceChannels !== packet.channels) {
      this.sourceRate = packet.sampleRate;
      this.sourceChannels = packet.channels;
      this.rateRemainder = 0;
    }
    const sourceAlign = packet.channels * 2;
    const sourceFrames = packet.data.length / sourceAlign;
    const scaled = sourceFrames * this.targetRate + this.rateRemainder;
    const targetFrames = Math.floor(scaled / packet.sampleRate);
    this.rateRemainder = scaled % packet.sampleRate;
    if (targetFrames === 0) return Buffer.alloc(0);
    const output = Buffer.allocUnsafe(targetFrames * this.targetChannels * 2);
    for (let frame = 0; frame < targetFrames; frame++) {
      const position = targetFrames === 1 || sourceFrames === 1
        ? 0 : frame * (sourceFrames - 1) / (targetFrames - 1);
      const lower = Math.floor(position);
      const upper = Math.min(lower + 1, sourceFrames - 1);
      const fraction = position - lower;
      for (let channel = 0; channel < this.targetChannels; channel++) {
        const sample = this.targetChannels === 1 && packet.channels > 1
          ? (this.interpolate(packet.data, lower, upper, fraction, packet.channels, 0) +
             this.interpolate(packet.data, lower, upper, fraction, packet.channels, 1)) / 2
          : this.interpolate(packet.data, lower, upper, fraction, packet.channels,
              packet.channels === 1 ? 0 : Math.min(channel, packet.channels - 1));
        output.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sample))),
          (frame * this.targetChannels + channel) * 2);
      }
    }
    return output;
  }

  private interpolate(
    data: Buffer,
    lower: number,
    upper: number,
    fraction: number,
    channels: number,
    channel: number,
  ): number {
    const a = data.readInt16LE((lower * channels + channel) * 2);
    const b = data.readInt16LE((upper * channels + channel) * 2);
    return a + (b - a) * fraction;
  }
}

export class MediaOutput {
  private active: ActiveOutput | null = null;
  private starting = false;
  private lastFilePath = "";
  private lastError = "";
  private readonly videoProvider: VideoProvider;
  private readonly audioProvider: AudioProvider;
  private readonly videoPacketProvider: () => Promise<NativeVideoPacket | null>;

  constructor(
    videoProvider?: VideoProvider,
    audioProvider?: AudioProvider,
    videoPacketProvider?: () => Promise<NativeVideoPacket | null>,
  ) {
    this.videoProvider = videoProvider ?? (async (width, height) => {
      const frame = await nativeCore.readVideoFrame(width, height);
      return frame ? { data: frame.data, timestamp100ns: frame.timestamp100ns } : null;
    });
    this.audioProvider = audioProvider ?? ((afterSequence) => nativeCore.readAudioPacket(afterSequence));
    this.videoPacketProvider = videoPacketProvider ?? (() => nativeCore.readVideoPacket());
  }

  getStatus(): RecordStatus & { error?: string } {
    const active = this.active;
    return {
      recording: active !== null,
      filePath: active?.destination ?? this.lastFilePath,
      durationSeconds: active ? Math.floor((Date.now() - active.startedAt) / 1000) : 0,
      ...(this.lastError ? { error: this.lastError } : {}),
    };
  }

  getDiagnostics(): { encodeFps: number; framesWritten: number } {
    const active = this.active;
    if (!active) return { encodeFps: 0, framesWritten: 0 };
    const elapsed = (Date.now() - active.startedAt) / 1000;
    const encodeFps = elapsed > 0 ? Math.round((active.framesWritten / elapsed) * 10) / 10 : 0;
    return { encodeFps, framesWritten: active.framesWritten };
  }

  // 录制中周期性输出采集/编码 fps，用于定位卡帧是采集端还是编码端
  private startFpsMonitor(): NodeJS.Timeout {
    const logFps = async (): Promise<void> => {
      let captureFps = 0;
      try {
        const s = await nativeCore.getSessionStatus();
        captureFps = Math.round(s.fps * 10) / 10;
      } catch { /* 采集核心状态读取失败时忽略 */ }
      const diag = this.getDiagnostics();
      log("info", "record", "录制 fps", {
        captureFps,
        encodeFps: diag.encodeFps,
        framesWritten: diag.framesWritten,
      });
    };
    return setInterval(() => { void logFps(); }, 5000);
  }

  async start(request: MediaOutputRequest): Promise<void> {
    if (this.active || this.starting) throw new Error("录制已在运行或正在启动");
    const bitrateKbps = request.bitrateKbps ?? 12000;
    if (request.width < 160 || request.width > 3840 || request.height < 160 || request.height > 2160 ||
        (request.width & 1) !== 0 || (request.height & 1) !== 0) {
      throw new Error("录制分辨率必须为 160–3840 × 160–2160 范围内的偶数");
    }
    if (request.fps < 10 || request.fps > 60) throw new Error("录制帧率必须为 10–60 FPS");
    if (bitrateKbps < 500 || bitrateKbps > 50000) throw new Error("视频码率必须为 500–50000 kbps");
    this.starting = true;
    this.lastError = "";
    let stagingPath = "";
    let audioPipe: AudioPipe | null = null;
    let child: ReturnType<typeof spawnFfmpeg> | null = null;
    let videoRawPath = "";
    let audioRawPath = "";
    try {
      const __dirname = path.dirname(fileURLToPath(import.meta.url));
      const PROJECT_ROOT = path.resolve(__dirname, "..");
      const ffmpegPath = request.ffmpegPath ?? path.join(PROJECT_ROOT, "runtime/ffmpeg/ffmpeg.exe");
      const remux = request.remux === true;
      const encoder = remux ? "copy" : await selectWorkingEncoder(ffmpegPath, request.width, request.height);
      const firstAudio = await this.waitForAudio();
      const destination = path.resolve(request.destination);
      stagingPath = await prepareStagingPath(destination);
      if (remux) {
        // 直录：录制阶段落原始流（视频 Annex B + 音频 PCM），停止后再用 FFmpeg 封装成 MP4
        videoRawPath = `${stagingPath}.video.h264`;
        audioRawPath = `${stagingPath}.audio.pcm`;
      } else {
        if (firstAudio) audioPipe = await createAudioPipe();
        const audioArg = firstAudio && audioPipe ? {
          pipePath: audioPipe.path,
          sampleRate: firstAudio.sampleRate,
          channels: firstAudio.channels,
        } : null;
        const args = buildFfmpegArguments({ ...request, destination: stagingPath, bitrateKbps }, encoder, audioArg);
        child = spawnFfmpeg(ffmpegPath, args);
        const earlyExit = child.exited.then((exit) => {
          throw new Error(exit.error?.message ?? `FFmpeg 启动时退出（代码 ${exit.code}）\n${child?.stderr.value.trim() ?? ""}`);
        });
        if (audioPipe) {
          await withTimeout(
            Promise.race([audioPipe.connected, earlyExit]),
            5000,
            "FFmpeg 连接音频输入超时",
          );
        }
        await Promise.race([delay(350), earlyExit]);
      }
      const active: ActiveOutput = {
        process: child?.process ?? null,
        exited: child?.exited ?? null,
        stderr: child?.stderr ?? null,
        controller: new AbortController(),
        destination,
        stagingPath,
        fps: request.fps,
        width: request.width,
        height: request.height,
        encoder,
        remux,
        firstAudio,
        audioPipe,
        ffmpegPath,
        videoRawPath,
        audioRawPath,
        startedAt: Date.now(),
        framesWritten: 0,
        stopping: false,
        runPromise: null,
      };
      this.active = active;
      active.runPromise = this.run(active);
      active.runPromise.catch((error) => {
        this.lastError = errorMessage(error);
        log("error", "record", "录制异常结束", this.lastError);
      });
      log("info", "record", "FFmpeg 录制开始", {
        destination,
        width: request.width,
        height: request.height,
        fps: request.fps,
        encoder,
        audio: firstAudio !== null,
      });
      child = null;
      audioPipe = null;
      stagingPath = "";
    } catch (error) {
      if (child) {
        child.process.stdin.destroy();
        if (child.process.exitCode === null && !child.process.killed) child.process.kill();
        await child.exited.catch(() => undefined);
      }
      closeAudioPipe(audioPipe, true);
      if (stagingPath) {
        await fs.rm(stagingPath, { force: true }).catch(() => undefined);
        await fs.rm(`${stagingPath}.finalized`, { force: true }).catch(() => undefined);
      }
      if (videoRawPath) await fs.rm(videoRawPath, { force: true }).catch(() => undefined);
      if (audioRawPath) await fs.rm(audioRawPath, { force: true }).catch(() => undefined);
      this.active = null;
      this.lastError = errorMessage(error);
      throw error;
    } finally {
      this.starting = false;
    }
  }

  async stop(): Promise<void> {
    const active = this.active;
    if (!active) return;
    active.stopping = true;
    active.controller.abort(new Error("用户停止录制"));
    if (active.runPromise) await active.runPromise;
  }

  private async waitForAudio(): Promise<NativeAudioPacket | null> {
    const deadline = performance.now() + 250;
    while (performance.now() < deadline) {
      const packet = await this.readNewestAudio(0n);
      if (packet && packet.data.length > 0) return packet;
      await delay(20);
    }
    return null;
  }

  private async readNewestAudio(afterSequence: bigint): Promise<NativeAudioPacket | null> {
    let newest: NativeAudioPacket | null = null;
    let cursor = afterSequence;
    for (let index = 0; index < MAX_AUDIO_DRAIN_PACKETS; index++) {
      const packet = await this.audioProvider(cursor);
      if (!packet) break;
      if (packet.sequence <= cursor) throw new Error("Core 返回了停滞的音频序列");
      newest = packet;
      cursor = packet.sequence;
    }
    return newest;
  }

  private async pumpVideo(active: ActiveOutput): Promise<void> {
    const signal = active.controller.signal;
    const interval = 1000 / active.fps;
    // 读帧本身有耗时，用比帧率更短的间隔轮询以捕捉到每一帧，又不过度轮询与音频读包争抢。
    const pollMs = Math.max(2, Math.floor(interval / 2));
    let latest: { data: Buffer; timestamp100ns: bigint } | null = null;
    const reader = async () => {
      while (!signal.aborted) {
        const frame = await this.videoProvider(active.width, active.height);
        if (frame) {
          const expected = active.width * active.height * 3 / 2;
          if (frame.data.length !== expected) throw new Error("视频提供器返回了无效的 NV12 帧");
          // 只有时间戳变化（真正的新帧）才更新 latest
          if (!latest || latest.timestamp100ns !== frame.timestamp100ns) {
            latest = frame;
          }
        }
        await delay(pollMs, undefined, { signal });
      }
    };
    const writer = async () => {
      let lastFrame: Buffer | null = null;
      let lastTimestamp = 0n;
      const outputClock = performance.now();
      const maximumCatchUp = active.fps * 2;
      while (!signal.aborted) {
        // 固定时钟驱动写帧，保证输出时长与帧率一致（避免时长漂移）
        await delay(interval, undefined, { signal });
        const elapsed = performance.now() - outputClock;
        let due = Math.max(0, Math.round(elapsed * active.fps / 1000) - active.framesWritten);
        if (due <= 0) continue;
        // 优先写新帧（时间戳变化），源帧迟到时才重复上一帧
        if (latest && latest.timestamp100ns !== lastTimestamp) {
          lastTimestamp = latest.timestamp100ns;
          lastFrame = latest.data;
        }
        if (!lastFrame) {
          if (elapsed > 5000) throw new Error("等待首帧视频超时");
          continue;
        }
        due = Math.min(due, maximumCatchUp);
        for (let index = 0; index < due; index++) {
          await writeChunk(active.process!.stdin, lastFrame, signal);
          active.framesWritten++;
        }
      }
    };
    await Promise.all([reader(), writer()]);
  }

  private async pumpAudio(active: ActiveOutput): Promise<void> {
    const firstAudio = active.firstAudio;
    const pipe = active.audioPipe;
    if (!firstAudio || !pipe) return;
    const socket = await pipe.connected;
    const signal = active.controller.signal;
    const sampleRate = firstAudio.sampleRate;
    const channels = firstAudio.channels;
    const blockAlign = channels * 2;
    const bytesPerSecond = sampleRate * blockAlign;
    const normalizer = new Pcm16Normalizer(sampleRate, channels);
    const outputClock = performance.now();
    // 启动握手期间 Core 会缓存音频，只保留最新包，避免在视频开头补入旧音频。
    const initialPacket = await this.readNewestAudio(firstAudio.sequence) ?? firstAudio;
    let sequence = initialPacket.sequence;
    let emittedBytes = 0;
    const firstPcm = normalizer.convert(initialPacket);
    if (firstPcm.length > 0) {
      await writeChunk(socket, firstPcm, signal);
      emittedBytes = firstPcm.length;
    }
    let lastRealPacket = performance.now();
    let insertedSilence = false;
    const silence = Buffer.alloc(Math.max(blockAlign,
      Math.floor(bytesPerSecond / 50 / blockAlign) * blockAlign));
    while (!signal.aborted) {
      const packet = insertedSilence
        ? await this.readNewestAudio(sequence)
        : await this.audioProvider(sequence);
      if (!packet) {
        if (performance.now() - lastRealPacket >= AUDIO_SILENCE_GRACE_MS) {
          const targetBytes = Math.floor((performance.now() - outputClock) * bytesPerSecond / 1000);
          let bytesToWrite = Math.min(Math.max(0, targetBytes - emittedBytes), silence.length);
          bytesToWrite -= bytesToWrite % blockAlign;
          if (bytesToWrite > 0) {
            await writeChunk(socket, silence.subarray(0, bytesToWrite), signal);
            emittedBytes += bytesToWrite;
            insertedSilence = true;
            continue;
          }
        }
        await delay(5, undefined, { signal });
        continue;
      }
      if (packet.sequence <= sequence) throw new Error("Core 返回了停滞的音频序列");
      const pcm = normalizer.convert(packet);
      if (pcm.length > 0) {
        await writeChunk(socket, pcm, signal);
        emittedBytes += pcm.length;
      }
      sequence = packet.sequence;
      lastRealPacket = performance.now();
      insertedSilence = false;
    }
  }

  private async pumpVideoRaw(active: ActiveOutput, stream: Writable): Promise<void> {
    const signal = active.controller.signal;
    let firstPacket = false;
    while (!signal.aborted) {
      const packet = await this.videoPacketProvider();
      if (packet) {
        if (!firstPacket) {
          // 首个包前先写 SPS/PPS 参数集（extradata），否则 FFmpeg 报 non-existing PPS
          const pps = await nativeCore.getVideoParameterSets();
          const annexPps = h264AvccToAnnexB(pps);
          if (annexPps.length > 0) {
            await writeChunk(stream, annexPps, signal);
          }
          firstPacket = true;
        }
        const annexB = h264AvccToAnnexB(packet.data);
        if (annexB.length > 0) {
          await writeChunk(stream, annexB, signal);
          active.framesWritten++;
        }
        continue;
      }
      if (!firstPacket && Date.now() - active.startedAt > 5000) {
        throw new Error("等待首个原始视频包超时");
      }
      await delay(1, undefined, { signal });
    }
  }

  private async pumpAudioRaw(active: ActiveOutput, stream: Writable): Promise<void> {
    const firstAudio = active.firstAudio;
    if (!firstAudio) return;
    const signal = active.controller.signal;
    const normalizer = new Pcm16Normalizer(firstAudio.sampleRate, firstAudio.channels);
    const initialPacket = await this.readNewestAudio(firstAudio.sequence) ?? firstAudio;
    let sequence = initialPacket.sequence;
    const firstPcm = normalizer.convert(initialPacket);
    if (firstPcm.length > 0) {
      await writeChunk(stream, firstPcm, signal);
    }
    while (!signal.aborted) {
      const packet = await this.audioProvider(sequence);
      if (!packet) {
        await delay(5, undefined, { signal });
        continue;
      }
      if (packet.sequence <= sequence) throw new Error("Core 返回了停滞的音频序列");
      const pcm = normalizer.convert(packet);
      if (pcm.length > 0) {
        await writeChunk(stream, pcm, signal);
      }
      sequence = packet.sequence;
    }
  }

  private async finalizeRemux(active: ActiveOutput): Promise<void> {
    const fps = await this.resolveRemuxFps(active);
    const args = [
      "-hide_banner", "-loglevel", "error", "-nostdin",
      "-f", "h264", "-framerate", String(fps), "-i", active.videoRawPath,
    ];
    if (active.firstAudio) {
      args.push(
        "-f", "s16le", "-ar", String(active.firstAudio.sampleRate),
        "-ac", String(active.firstAudio.channels), "-i", active.audioRawPath,
      );
      args.push("-map", "0:v:0", "-map", "1:a:0");
    } else {
      args.push("-map", "0:v:0", "-an");
    }
    args.push("-c:v", "copy");
    // FFmpeg 8.1.2 的 h264 raw demuxer 对 -framerate 的 pts 生成有 bug（约 51 帧后停滞），
    // 用 setts 按帧序号重写为线性时间戳，确保 MP4 时长正确（time_base 固定 1/1200000）。
    args.push("-bsf:v", `setts=ts=N*${Math.max(1, Math.round(1200000 / fps))}`);
    if (active.firstAudio) args.push("-c:a", "aac", "-b:a", "192k");
    args.push("-movflags", "+faststart", "-y", active.stagingPath);
    const child = spawnFfmpeg(active.ffmpegPath, args);
    child.process.stdin.end();
    const exit = await withTimeout(child.exited, FINALIZE_TIMEOUT_MS, "FFmpeg 封装 MP4 超时");
    if (exit.code !== 0) {
      throw ffmpegError({ stderr: child.stderr }, exit.error?.message ?? `FFmpeg 退出代码 ${exit.code}`);
    }
  }

  // 真实平均帧率 = 帧数 / 真实时长。音频 PCM 时长（数据量 ÷ 采样率）最准确，无音频时退回 wallclock。
  private async resolveRemuxFps(active: ActiveOutput): Promise<number> {
    let durationSeconds = 0;
    if (active.firstAudio) {
      try {
        const stat = await fs.stat(active.audioRawPath);
        durationSeconds = stat.size / (active.firstAudio.sampleRate * active.firstAudio.channels * 2);
      } catch {
        durationSeconds = 0;
      }
    }
    if (durationSeconds <= 0.5) {
      durationSeconds = Math.max(0.001, (Date.now() - active.startedAt) / 1000);
    }
    if (active.framesWritten > 0 && durationSeconds > 0) {
      return active.framesWritten / durationSeconds;
    }
    return active.fps;
  }

  private async runRaw(active: ActiveOutput): Promise<void> {
    let failure: unknown = null;
    let retainStaging = false;
    const videoStream = createWriteStream(active.videoRawPath);
    const audioStream = active.firstAudio ? createWriteStream(active.audioRawPath) : null;
    const pumps = [
      this.pumpVideoRaw(active, videoStream),
      ...(audioStream ? [this.pumpAudioRaw(active, audioStream)] : []),
    ];
    const fpsTimer = this.startFpsMonitor();
    try {
      await Promise.all(pumps);
    } catch (error) {
      if (!active.stopping) failure = error;
    } finally {
      clearInterval(fpsTimer);
      active.controller.abort(new Error("录制泵已停止"));
      const settled = await Promise.allSettled(pumps);
      await closeWritable(videoStream);
      if (audioStream) await closeWritable(audioStream);
      if (!failure && !active.stopping) {
        const rejected = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
        if (rejected && !isAbort(rejected.reason)) failure = rejected.reason;
      }
      if (!failure) {
        try {
          await this.finalizeRemux(active);
          await publishFinalized(active.stagingPath, active.destination);
          this.lastFilePath = active.destination;
          log("info", "record", "录制已发布", { filePath: active.destination, encoder: active.encoder });
        } catch (error) {
          retainStaging = true;
          failure = error;
        }
      }
      if (failure && !retainStaging) {
        await fs.rm(active.stagingPath, { force: true }).catch(() => undefined);
        await fs.rm(`${active.stagingPath}.finalized`, { force: true }).catch(() => undefined);
      }
      await fs.rm(active.videoRawPath, { force: true }).catch(() => undefined);
      await fs.rm(active.audioRawPath, { force: true }).catch(() => undefined);
      if (this.active === active) this.active = null;
    }
    if (failure) {
      this.lastError = errorMessage(failure);
      throw failure;
    }
    this.lastError = "";
  }

  private async run(active: ActiveOutput): Promise<void> {
    if (active.remux) return this.runRaw(active);
    let failure: unknown = null;
    let retainStaging = false;
    const pumps = [
      this.pumpVideo(active),
      ...(active.firstAudio ? [this.pumpAudio(active)] : []),
    ];
    const fpsTimer = this.startFpsMonitor();
    try {
      const allPumps = Promise.all(pumps);
      const earlyExit = active.exited!.then((exit) => {
        if (!active.stopping) {
          throw ffmpegError(active, exit.error?.message ?? `FFmpeg 在停止前退出（代码 ${exit.code}）`);
        }
      });
      await Promise.race([allPumps, earlyExit]);
      await allPumps;
    } catch (error) {
      if (!active.stopping) failure = error;
    } finally {
      clearInterval(fpsTimer);
      active.controller.abort(new Error("录制泵已停止"));
      active.process!.stdin.end();
      closeAudioPipe(active.audioPipe);
      const settled = await Promise.allSettled(pumps);
      if (!failure && !active.stopping) {
        const rejected = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
        if (rejected && !isAbort(rejected.reason)) failure = rejected.reason;
      }
      try {
        const exit = await withTimeout(active.exited!, FINALIZE_TIMEOUT_MS, "FFmpeg 封装 MP4 超时");
        if (exit.code !== 0) {
          failure ??= ffmpegError(active, exit.error?.message ?? `FFmpeg 退出代码 ${exit.code}`);
        }
      } catch (error) {
        failure ??= error;
        if (active.process!.exitCode === null && !active.process!.killed) active.process!.kill();
        await active.exited!.catch(() => undefined);
      }
      if (!failure) {
        try {
          await publishFinalized(active.stagingPath, active.destination);
          this.lastFilePath = active.destination;
          log("info", "record", "录制已发布", { filePath: active.destination, encoder: active.encoder });
        } catch (error) {
          retainStaging = true;
          failure = error;
        }
      }
      if (failure && !retainStaging) {
        await fs.rm(active.stagingPath, { force: true }).catch(() => undefined);
        await fs.rm(`${active.stagingPath}.finalized`, { force: true }).catch(() => undefined);
      }
      closeAudioPipe(active.audioPipe, true);
      if (this.active === active) this.active = null;
    }
    if (failure) {
      this.lastError = errorMessage(failure);
      throw failure;
    }
    this.lastError = "";
  }
}

export const mediaOutput = new MediaOutput();
