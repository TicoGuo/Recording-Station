export type Mode = "normal" | "record";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Device {
  id: string;
  name: string;
  online: boolean;
  capturing: boolean;
  control: boolean;
  udid: string;
  productType: string;
  osVersion: string;
  connectionType: string;
  state: number;
  stateLabel: string;
  message: string;
}

export interface RecordFile {
  path: string;
  name: string;
  size: number;
  modifiedAt: string;
}

export interface RecordStatus {
  recording: boolean;
  filePath: string;
  durationSeconds: number;
  error?: string;
  captureFps?: number;
  encodeFps?: number;
}

export interface App {
  bundleId: string;
  name: string;
  version: string;
}

export interface AndroidDevice {
  serial: string;
  model: string;
  device: string;
  state: string;
}

export interface AndroidApp {
  packageName: string;
  name: string;
}

export interface AndroidRecordStatus {
  recording: boolean;
  filePath: string;
  durationSeconds: number;
  error?: string;
}

export interface Config {
  corePath: string;
  ffmpegPath: string;
  ffprobePath: string;
  ideviceinstallerPath: string;
  scrcpyPath: string;
  adbPath: string;
  aaptPath: string;
  outputPath: string;
  androidOutputPath: string;
  ipaPath: string;
  apkPath: string;
  lastPlatform: string;
  fps: number;
  listenHost: string;
  gatewayPort: number;
  logLevel: string;
}
