import { Router } from "express";
import { log } from "./logger";
import { nativeCore, type NativeDevice } from "./native-core";
import { sendError, messageOf, codeForError } from "./http-errors";
import type { Device } from "./types";

const CONNECTION_STATE_LABELS: Record<number, string> = {
  0: "未连接",
  1: "USB 已接入",
  2: "已连接",
  3: "已配对",
  4: "就绪",
  5: "错误",
};

function toDevice(device: NativeDevice): Device {
  return {
    id: device.id,
    name: device.name,
    online: device.connected,
    capturing: nativeCore.hasActiveSession && nativeCore.activeDeviceId === device.id,
    control: device.controlReady,
    udid: device.id,
    productType: device.productType,
    osVersion: device.osVersion,
    connectionType: device.connectionType,
    state: device.state,
    stateLabel: CONNECTION_STATE_LABELS[device.state] ?? `状态 ${device.state}`,
    message: device.message,
  };
}

export function createDevicesRouter(): Router {
  const router = Router();

  router.get("/", async (_req, res) => {
    try {
      const devices = await nativeCore.listDevices();
      res.json({ devices: devices.map(toDevice) });
    } catch (error) {
      const message = messageOf(error);
      log("error", "devices", "读取设备列表失败", message);
      sendError(res, 503, codeForError(message), message, { devices: [] });
    }
  });

  return router;
}
