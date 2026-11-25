import { Router } from "express";
import { log } from "./logger";
import { nativeCore } from "./native-core";
import { stopRecording } from "./record";
import { sendError, messageOf, codeForError } from "./http-errors";
import type { Mode } from "./types";

let currentMode: Mode = "normal";
let switching = false;
let statusMessage = "";

function getModeStatus(): { switching: boolean; currentMode: Mode; message: string } {
  return { switching, currentMode, message: statusMessage };
}

async function switchMode(mode: Mode) {
  if (switching) throw new Error("模式切换正在进行，请稍后重试");
  switching = true;
  statusMessage = "";
  log("info", "mode", `切换到模式 ${mode}`);
  try {
    await stopRecording();
    await nativeCore.stopSession();

    if (mode === "normal") {
      currentMode = "normal";
      return;
    }

    const devices = await nativeCore.listDevices(true);
    const device = devices.find((item) => item.connected && item.controlReady);
    if (!device) {
      throw new Error("没有可用于录制的设备，请连接 iPhone 并信任此电脑");
    }

    try {
      await nativeCore.startDemoSession(device.id);
      await nativeCore.waitForStreaming();
      currentMode = "record";
      log("info", "mode", `设备 ${device.name} 已进入录制模式`);
      return;
    } catch (error) {
      try {
        await nativeCore.stopSession();
      } catch (cleanupError) {
        log("error", "mode", "清理失败的采集会话时出错", messageOf(cleanupError));
      }
      throw error;
    }
  } catch (error) {
    if (!nativeCore.hasActiveSession) currentMode = "normal";
    statusMessage = messageOf(error);
    log("error", "mode", "模式切换失败", statusMessage);
    throw error;
  } finally {
    switching = false;
  }
}

export function createModeRouter(): Router {
  const router = Router();

  router.post("/", async (req, res) => {
    const mode = req.body?.mode;
    if (mode !== "normal" && mode !== "record") {
      return sendError(res, 400, "INVALID_REQUEST", "非法模式，仅支持 normal/record", getModeStatus());
    }
    try {
      await switchMode(mode);
      res.json(getModeStatus());
    } catch (error) {
      const message = messageOf(error);
      sendError(res, 400, codeForError(message), message, getModeStatus());
    }
  });

  router.get("/status", (_req, res) => {
    res.json(getModeStatus());
  });

  return router;
}
