// IWCS 前端控制台：配合本地后端 (http://127.0.0.1:8787) 工作。
// 直接复用 iPhoneMirror 采集核心暴露的数据契约：设备 / 模式 / 录制 / 应用 / 环境。

interface Device {
  id: string; name: string; online: boolean; capturing: boolean; control: boolean;
  udid: string; productType: string; osVersion: string; connectionType: string;
  state: number; stateLabel: string; message: string;
}
interface HealthItem { ok: boolean; message: string; }
interface Health { core: HealthItem; ffmpeg: HealthItem; usb: HealthItem; ideviceinstaller: HealthItem; android: HealthItem; }
type Mode = "normal" | "record";
interface ModeStatus { switching: boolean; currentMode: Mode; message: string; }
interface RecordStatus { recording: boolean; filePath?: string; durationSeconds: number; error?: string; captureFps?: number; encodeFps?: number; }
interface RecordFile { path: string; name: string; size: number; modifiedAt: string; }
interface App { bundleId: string; name: string; version: string; }
interface IpaFile { path: string; name: string; size: number; }
interface AndroidDevice { serial: string; model: string; device: string; state: string; }
interface AndroidApp { packageName: string; name: string; }
interface AndroidRecordStatus { recording: boolean; filePath?: string; durationSeconds: number; error?: string; }
interface ApkFile { path: string; name: string; size: number; }

// 缺失元素时返回 null，调用处需判空；不再用共享哑元素兜底（会把值写到孤儿节点导致 UI 不更新）
function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { headers: { "Content-Type": "application/json" }, ...init });
  let data: any = null;
  try { data = await res.json(); } catch { /* non-JSON body */ }
  if (!res.ok) {
    const msg = data?.error?.message || data?.message || (typeof data?.error === "string" ? data.error : null) || res.statusText || `HTTP ${res.status}`;
    const err = new Error(msg) as Error & { code?: string };
    err.code = data?.error?.code;
    throw err;
  }
  return data as T;
}

function toast(message: string, kind: "ok" | "error" | "info" = "info"): void {
  const t = document.getElementById("toast");
  if (!t) return;
  t.textContent = message;
  t.className = `toast ${kind === "info" ? "" : kind}`;
  t.classList.remove("hidden");
  window.clearTimeout((toast as any)._t);
  (toast as any)._t = window.setTimeout(() => t.classList.add("hidden"), 2600);
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function fmtBytes(n: number): string {
  if (!n) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(n) / Math.log(1024));
  return `${(n / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

// ---------------- 状态 ----------------
let devices: Device[] = [];
let mode: ModeStatus = { switching: false, currentMode: "normal", message: "" };
let record: RecordStatus = { recording: false, durationSeconds: 0 };
let recordPhase: "idle" | "recording" = "idle";
let recordBusy = false;
let health: Health | null = null;
let apps: App[] = [];
let ipaFiles: IpaFile[] = [];
let modeSwitching = false;
let renaming = false;
let outputPath = "";

// Android 状态
let androidDevices: AndroidDevice[] = [];
let androidApps: AndroidApp[] = [];
let androidRecord: AndroidRecordStatus = { recording: false, durationSeconds: 0 };
let androidRecordPhase: "idle" | "recording" = "idle";
let apkFiles: ApkFile[] = [];
let androidRenaming = false;
let currentPlatform: "ios" | "android" = "ios";
let _apkInputValue = "";

// 输入框实时值缓存：监听 input 事件捕获，彻底绕开浏览器自动填充/DOM 覆盖
let _outputInputValue = "";
let _androidOutputInputValue = "";
let _ipaInputValue = "";
let _suppressInputCapture = false;

// 确认弹窗回调 & 冷却倒计时状态
let _confirmCallback: (() => void) | null = null;
let _cooldownTimer: number | null = null;
let _cooldownRemaining = 0;
let _cooldownTotal = 0;
let _cooldownMinutes = 0;
let _cooldownSeconds = 10;

// Android 冷却倒计时（独立状态）
let _androidCooldownTimer: number | null = null;
let _androidCooldownRemaining = 0;
let _androidCooldownTotal = 0;
let _androidCooldownMinutes = 0;
let _androidCooldownSeconds = 10;

// ---------------- 渲染：顶栏 ----------------
function renderTopbar(): void {
  const pill = document.getElementById("device-pill");
  if (pill) {
    const dot = pill.querySelector(".dot");
    const name = pill.querySelector(".dp-name");
    let label = "无设备";
    let dotState = "muted";
    if (currentPlatform === "android") {
      const dev = androidDevices.find((d) => d.state === "device") || androidDevices[0];
      if (dev) {
        label = dev.model || dev.serial;
        dotState = dev.state === "device" ? "ok" : "warn";
      }
    } else {
      const dev = devices.find((d) => d.online);
      if (dev) {
        label = `${dev.name} · ${dev.stateLabel}`;
        dotState = dev.control ? "ok" : "warn";
      }
    }
    if (dot) {
      dot.className = `dot ${dotState}`;
    }
    if (name) {
      name.textContent = label;
    }
  }
  const env = document.getElementById("env-dots");
  if (!env) return;
  env.innerHTML = "";
  const labels: [keyof Health, string][] = currentPlatform === "android"
    ? [["ffmpeg", "FFmpeg 编码"], ["android", "屏幕采集"]]
    : [["core", "采集核心"], ["ffmpeg", "FFmpeg 编码"], ["usb", "屏幕采集"], ["ideviceinstaller", "应用安装"]];
  for (const [key, label] of labels) {
    const h = health?.[key];
    const wrap = el("span", "env-item");
    const d = el("span", `dot ${h ? (h.ok ? "ok" : "bad") : "muted"}`);
    const t = el("span", "env-label", label);
    wrap.append(d, t);
    wrap.title = `${label}: ${h ? h.message : "未检测"}`;
    env.appendChild(wrap);
  }
}

// ---------------- 渲染：录制控制 ----------------
function renderRecord(): void {
  const toggle = document.getElementById("record-toggle") as HTMLButtonElement | null;
  if (!toggle) return;
  const busy = mode.switching || modeSwitching || recordBusy;

  // 两态按钮：idle 开始录制 / recording 录制中
  toggle.classList.toggle("recording", recordPhase === "recording");
  toggle.disabled = busy;

  if (recordPhase === "recording") {
    toggle.title = "结束录制";
    toggle.setAttribute("aria-label", "结束录制");
  } else {
    toggle.title = "开始录制";
    toggle.setAttribute("aria-label", "开始录制");
  }

  renderDock();
}

// ---------------- 渲染：最近录制 ----------------
function baseName(name: string): string {
  return name.replace(/\.mp4$/i, "");
}

function renderFiles(): void {
  if (renaming) return;
  // 在异步回调里重新获取 DOM 引用，避免 init() 同步阶段 getElementById 暂时返回 null
  api<{ files: RecordFile[] }>("/api/record/files").then((data) => {
    const box = document.getElementById("record-files");
    if (!box) return;
    if (renaming) return;
    const files = data.files || [];
    if (!files.length) {
      box.innerHTML = `<div class="empty">暂无录制文件</div>`; return;
    }
    box.innerHTML = "";
    for (const f of files) {
      const item = el("div", "file-item");
      const main = el("div", "fi-main");
      const nameEl = el("div", "fi-name", f.name);
      nameEl.title = `${f.name}\n双击重命名（后缀 .mp4 不可修改）`;
      nameEl.addEventListener("dblclick", () => beginRename(nameEl, f));
      const meta = el("div", "fi-meta", `${fmtBytes(f.size)} · ${fmtTime(f.modifiedAt)}`);
      main.append(nameEl, meta);
      const actions = el("div", "fi-actions");
      const play = el("button", "btn primary", "播放") as HTMLButtonElement;
      play.type = "button";
      play.addEventListener("click", () => openPlayer(f));
      const del = el("button", "btn danger", "删除") as HTMLButtonElement;
      del.type = "button";
      del.addEventListener("click", () => deleteFile(f));
      actions.append(play, del);
      item.append(main, actions);
      box.appendChild(item);
    }
  }).catch(() => {
    const box = document.getElementById("record-files");
    if (box) box.innerHTML = `<div class="empty">加载失败</div>`;
  });
}

function openPlayer(f: RecordFile): void {
  const modal = document.getElementById("player-modal");
  const video = document.getElementById("player-video") as HTMLVideoElement | null;
  const title = document.getElementById("player-modal-title");
  if (!modal || !video) return;
  if (title) title.textContent = f.name;
  video.src = `/api/record/stream?path=${encodeURIComponent(f.path)}`;
  modal.classList.remove("hidden");
  video.play().catch(() => { /* 自动播放被拦截时由用户手动点击播放 */ });
}

function closePlayer(): void {
  const modal = document.getElementById("player-modal");
  const video = document.getElementById("player-video") as HTMLVideoElement | null;
  if (modal) modal.classList.add("hidden");
  if (video) {
    video.pause();
    video.removeAttribute("src");
    video.load();
  }
}

// ---------------- 确认弹窗（替代原生 confirm，避免 WebView 静默通过） ----------------
function askConfirm(message: string, okText: string, onOk: () => void): void {
  const modal = document.getElementById("confirm-modal");
  const msgEl = document.getElementById("confirm-message");
  const okBtn = document.getElementById("confirm-ok") as HTMLButtonElement | null;
  if (!modal || !msgEl) { onOk(); return; }
  msgEl.textContent = message;
  if (okBtn) okBtn.textContent = okText;
  _confirmCallback = onOk;
  modal.classList.remove("hidden");
}

function closeConfirm(): void {
  const modal = document.getElementById("confirm-modal");
  if (modal) modal.classList.add("hidden");
  _confirmCallback = null;
}

function confirmOk(): void {
  const cb = _confirmCallback;
  closeConfirm();
  if (cb) cb();
}

function deleteFile(f: RecordFile): void {
  askConfirm(`确定删除「${f.name}」？此操作不可撤销。`, "删除", () => {
    api<{ ok: boolean }>("/api/record/delete", { method: "POST", body: JSON.stringify({ path: f.path }) })
      .then(() => { toast(`视频「${f.name}」已删除`, "ok"); renderFiles(); })
      .catch((e) => toast(errMsg(e), "error"));
  });
}

// ---------------- 冷却倒计时（iOS 秒表风格） ----------------
const TIMER_CIRCUMFERENCE = 2 * Math.PI * 33;

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function buildSelect(selectId: string, max: number, selected: number): void {
  const sel = document.getElementById(selectId) as HTMLSelectElement | null;
  if (!sel) return;
  sel.innerHTML = "";
  for (let i = 0; i <= max; i++) {
    const opt = document.createElement("option");
    opt.value = String(i);
    opt.textContent = pad2(i);
    if (i === selected) opt.selected = true;
    sel.appendChild(opt);
  }
}

function updateTimerDisplay(): void {
  const setup = document.getElementById("timer-setup");
  const running = document.getElementById("timer-running");
  const timeEl = document.getElementById("timer-time");
  const ring = document.getElementById("timer-ring-fg");
  const isRunning = _cooldownTimer !== null;

  if (setup) setup.classList.toggle("hidden", isRunning);
  if (running) running.classList.toggle("hidden", !isRunning);

  if (isRunning) {
    const mm = Math.floor(_cooldownRemaining / 60);
    const ss = _cooldownRemaining % 60;
    if (timeEl) timeEl.textContent = `${pad2(mm)}:${pad2(ss)}`;
    const progress = _cooldownTotal > 0 ? _cooldownRemaining / _cooldownTotal : 0;
    if (ring) ring.style.strokeDashoffset = String(TIMER_CIRCUMFERENCE * (1 - progress));
  } else {
    if (ring) ring.style.strokeDashoffset = String(TIMER_CIRCUMFERENCE);
  }
}

function initTimer(): void {
  buildSelect("timer-min-select", 59, 0);
  buildSelect("timer-sec-select", 59, 10);
  _cooldownMinutes = 0;
  _cooldownSeconds = 10;

  const minSel = document.getElementById("timer-min-select") as HTMLSelectElement | null;
  const secSel = document.getElementById("timer-sec-select") as HTMLSelectElement | null;
  minSel?.addEventListener("change", () => {
    _cooldownMinutes = parseInt(minSel.value, 10) || 0;
  });
  secSel?.addEventListener("change", () => {
    _cooldownSeconds = parseInt(secSel.value, 10) || 0;
  });

  updateTimerDisplay();
}

function startCooldown(): void {
  if (_cooldownTimer !== null) return;
  const minSel = document.getElementById("timer-min-select") as HTMLSelectElement | null;
  const secSel = document.getElementById("timer-sec-select") as HTMLSelectElement | null;
  _cooldownMinutes = parseInt(minSel?.value || "0", 10) || 0;
  _cooldownSeconds = parseInt(secSel?.value || "10", 10) || 0;
  _cooldownTotal = _cooldownMinutes * 60 + _cooldownSeconds;
  if (_cooldownTotal <= 0) { toast("请选择倒计时时长", "error"); return; }
  _cooldownRemaining = _cooldownTotal;
  // 先建立定时器，再刷新显示，确保第一次展示的是设定值（如 00:10），而非立即减到 00:09
  _cooldownTimer = window.setInterval(() => {
    _cooldownRemaining--;
    if (_cooldownRemaining <= 0) {
      window.clearInterval(_cooldownTimer!);
      _cooldownTimer = null;
      _cooldownRemaining = 0;
      updateTimerDisplay();
      const overlay = document.getElementById("cooldown-overlay");
      if (overlay) overlay.classList.remove("hidden");
    } else {
      updateTimerDisplay();
    }
  }, 1000);
  updateTimerDisplay();
}

function cancelCooldown(): void {
  if (_cooldownTimer === null) return;
  window.clearInterval(_cooldownTimer);
  _cooldownTimer = null;
  _cooldownRemaining = 0;
  _cooldownTotal = 0;
  updateTimerDisplay();
  toast("倒计时已取消", "info");
}

function closeCooldownOverlay(): void {
  const overlay = document.getElementById("cooldown-overlay");
  if (overlay) overlay.classList.add("hidden");
}

// ---------------- Android 冷却倒计时 ----------------
function updateAndroidTimerDisplay(): void {
  const setup = document.getElementById("android-timer-setup");
  const running = document.getElementById("android-timer-running");
  const timeEl = document.getElementById("android-timer-time");
  const ring = document.getElementById("android-timer-ring-fg");
  const isRunning = _androidCooldownTimer !== null;

  if (setup) setup.classList.toggle("hidden", isRunning);
  if (running) running.classList.toggle("hidden", !isRunning);

  if (isRunning) {
    const mm = Math.floor(_androidCooldownRemaining / 60);
    const ss = _androidCooldownRemaining % 60;
    if (timeEl) timeEl.textContent = `${pad2(mm)}:${pad2(ss)}`;
    const progress = _androidCooldownTotal > 0 ? _androidCooldownRemaining / _androidCooldownTotal : 0;
    if (ring) ring.style.strokeDashoffset = String(TIMER_CIRCUMFERENCE * (1 - progress));
  } else {
    if (ring) ring.style.strokeDashoffset = String(TIMER_CIRCUMFERENCE);
  }
}

function initAndroidTimer(): void {
  buildSelect("android-timer-min-select", 59, 0);
  buildSelect("android-timer-sec-select", 59, 10);
  _androidCooldownMinutes = 0;
  _androidCooldownSeconds = 10;

  const minSel = document.getElementById("android-timer-min-select") as HTMLSelectElement | null;
  const secSel = document.getElementById("android-timer-sec-select") as HTMLSelectElement | null;
  minSel?.addEventListener("change", () => {
    _androidCooldownMinutes = parseInt(minSel.value, 10) || 0;
  });
  secSel?.addEventListener("change", () => {
    _androidCooldownSeconds = parseInt(secSel.value, 10) || 0;
  });

  updateAndroidTimerDisplay();
}

function startAndroidCooldown(): void {
  if (_androidCooldownTimer !== null) return;
  const minSel = document.getElementById("android-timer-min-select") as HTMLSelectElement | null;
  const secSel = document.getElementById("android-timer-sec-select") as HTMLSelectElement | null;
  _androidCooldownMinutes = parseInt(minSel?.value || "0", 10) || 0;
  _androidCooldownSeconds = parseInt(secSel?.value || "10", 10) || 0;
  _androidCooldownTotal = _androidCooldownMinutes * 60 + _androidCooldownSeconds;
  if (_androidCooldownTotal <= 0) { toast("请选择倒计时时长", "error"); return; }
  _androidCooldownRemaining = _androidCooldownTotal;
  _androidCooldownTimer = window.setInterval(() => {
    _androidCooldownRemaining--;
    if (_androidCooldownRemaining <= 0) {
      window.clearInterval(_androidCooldownTimer!);
      _androidCooldownTimer = null;
      _androidCooldownRemaining = 0;
      updateAndroidTimerDisplay();
      const overlay = document.getElementById("cooldown-overlay");
      if (overlay) overlay.classList.remove("hidden");
    } else {
      updateAndroidTimerDisplay();
    }
  }, 1000);
  updateAndroidTimerDisplay();
}

function cancelAndroidCooldown(): void {
  if (_androidCooldownTimer === null) return;
  window.clearInterval(_androidCooldownTimer);
  _androidCooldownTimer = null;
  _androidCooldownRemaining = 0;
  _androidCooldownTotal = 0;
  updateAndroidTimerDisplay();
  toast("倒计时已取消", "info");
}

function beginRename(nameEl: HTMLElement, f: RecordFile): void {
  renaming = true;
  const input = document.createElement("input");
  input.type = "text";
  input.value = baseName(f.name);
  input.className = "rename-input";
  input.maxLength = 120;
  const suffix = el("span", "fi-ext", ".mp4");
  nameEl.textContent = "";
  nameEl.style.direction = "ltr";
  nameEl.append(input, suffix);
  input.focus();
  input.select();
  let done = false;
  const commit = async () => {
    if (done) return;
    done = true;
    const value = input.value.trim();
    renaming = false;
    if (!value || value === baseName(f.name)) { renderFiles(); return; }
    try {
      await api<{ path: string; name: string }>("/api/record/rename", { method: "POST", body: JSON.stringify({ path: f.path, name: value }) });
      toast("文件已重命名", "ok");
    } catch (e) { toast(errMsg(e), "error"); }
    renderFiles();
  };
  const cancel = () => {
    if (done) return;
    done = true;
    renaming = false;
    renderFiles();
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); commit(); }
    else if (e.key === "Escape") cancel();
  });
  input.addEventListener("blur", commit);
}

// ---------------- 渲染：应用管理 ----------------
function renderAppSelect(): void {
  const sel = document.getElementById("app-select") as HTMLSelectElement | null;
  if (!sel) return;
  const prev = sel.value;
  sel.innerHTML = `<option value="">选择要卸载的应用…</option>`;
  for (const a of apps) {
    const opt = document.createElement("option");
    opt.value = a.bundleId;
    // 同时展示应用名称与包名，方便识别
    opt.textContent = `${a.name || a.bundleId}（${a.bundleId}）${a.version ? ` v${a.version}` : ""}`;
    sel.appendChild(opt);
  }
  if (apps.some((a) => a.bundleId === prev)) sel.value = prev;
  const uninstallBtn = document.getElementById("uninstall-btn") as HTMLButtonElement | null;
  if (uninstallBtn) uninstallBtn.disabled = !sel.value;
}

async function refreshApps(): Promise<void> {
  const msg = document.getElementById("apps-msg");
  if (msg) { msg.textContent = "加载中…"; msg.className = "msg"; }
  try {
    const data = await api<{ apps: App[] }>("/api/apps");
    apps = data.apps || [];
    if (msg) { msg.textContent = `共 ${apps.length} 个应用`; msg.className = "msg ok"; }
    renderAppSelect();
  } catch (e) {
    apps = [];
    renderAppSelect();
    if (msg) { msg.textContent = errMsg(e); msg.className = "msg error"; }
  }
}

async function uninstallApp(): Promise<void> {
  const sel = document.getElementById("app-select") as HTMLSelectElement | null;
  const bundleId = sel?.value || "";
  if (!bundleId) { toast("请先选择要卸载的应用", "error"); return; }
  const a = apps.find((x) => x.bundleId === bundleId);
  askConfirm(`确定卸载「${a?.name || bundleId}」？此操作不可撤销。`, "卸载", () => {
    api("/api/apps/uninstall", { method: "POST", body: JSON.stringify({ bundleId }) })
      .then(() => { toast(`应用「${a?.name || bundleId}」已卸载`, "ok"); refreshApps(); })
      .catch((e) => toast(errMsg(e), "error"));
  });
}

// ---------------- 渲染：安装 IPA ----------------
function renderIpaList(): void {
  const box = document.getElementById("ipa-files");
  if (!box) return;
  if (!ipaFiles.length) {
    box.innerHTML = `<div class="empty">尚未扫描到 IPA 文件</div>`;
    return;
  }
  box.innerHTML = "";
  for (const f of ipaFiles) {
    const item = el("div", "file-item");
    const main = el("div", "fi-main");
    const nameEl = el("div", "fi-name", f.name);
    nameEl.title = f.name;
    const meta = el("div", "fi-meta", fmtBytes(f.size));
    main.append(nameEl, meta);
    const actions = el("div", "fi-actions");
    const install = el("button", "btn primary", "卸载安装") as HTMLButtonElement;
    install.type = "button";
    install.addEventListener("click", () => installIpa(f));
    actions.append(install);
    item.append(main, actions);
    box.appendChild(item);
  }
}

async function scanIpa(): Promise<void> {
  // 读实时缓存值而非 DOM value，避免浏览器自动填充/DOM 覆盖
  const dir = _ipaInputValue.trim();
  const msg = document.getElementById("ipa-msg");
  if (!dir) { toast("请输入 IPA 所在目录", "error"); return; }
  if (msg) { msg.textContent = "扫描中…"; msg.className = "msg"; }
  try {
    const data = await api<{ files: IpaFile[] }>(`/api/apps/scan-ipa?dir=${encodeURIComponent(dir)}`);
    ipaFiles = data.files || [];
    renderIpaList();
    if (msg) {
      msg.textContent = ipaFiles.length ? `找到 ${ipaFiles.length} 个 IPA 文件` : `在「${dir}」下没有找到 .ipa 文件`;
      msg.className = ipaFiles.length ? "msg ok" : "msg";
    }
    // 记住扫描目录，下次打开自动带出
    api("/api/config", { method: "PUT", body: JSON.stringify({ ipaPath: dir }) }).catch(() => {});
  } catch (e) {
    ipaFiles = [];
    renderIpaList();
    if (msg) { msg.textContent = errMsg(e); msg.className = "msg error"; }
  }
}

async function installIpa(f: IpaFile): Promise<void> {
  const msg = document.getElementById("ipa-msg");
  if (msg) { msg.textContent = `卸载安装中：${f.name}…`; msg.className = "msg"; }
  try {
    await api("/api/apps/reinstall", { method: "POST", body: JSON.stringify({ ipaPath: f.path }) });
    toast(`应用「${f.name}」已卸载并重新安装`, "ok");
    if (msg) { msg.textContent = "卸载安装完成"; msg.className = "msg ok"; }
    refreshApps();
  } catch (e) {
    toast(errMsg(e), "error");
    if (msg) { msg.textContent = errMsg(e); msg.className = "msg error"; }
  }
}

// ---------------- 动作 ----------------
async function applyMode(target: Mode): Promise<boolean> {
  if (modeSwitching || mode.switching) return false;
  modeSwitching = true;
  renderRecord();
  toast("正在切换采集模式…请勿断开设备。");
  try {
    mode = await api<ModeStatus>("/api/mode", { method: "POST", body: JSON.stringify({ mode: target }) });
    return mode.currentMode === target;
  } catch (e) {
    mode = { ...mode, message: errMsg(e) };
    return false;
  } finally {
    modeSwitching = false;
    refreshMode();
  }
}

async function toggleRecord(): Promise<void> {
  if (mode.switching || modeSwitching || recordBusy) return;
  recordBusy = true;
  try {
    if (recordPhase === "recording") {
      record = await api<RecordStatus>("/api/record/stop", { method: "POST" });
      recordPhase = "idle";
      if (mode.currentMode === "record") {
        await applyMode("normal");
      }
      toast("录制已停止，视频已保存到输出目录", "ok");
      renderFiles();
    } else {
      if (mode.currentMode !== "record") {
        const entered = await applyMode("record");
        if (!entered) {
          toast(mode.message || "进入录制模式失败", "error");
          return;
        }
      }
      record = await api<RecordStatus>("/api/record/start", { method: "POST" });
      recordPhase = "recording";
      toast("录制已开始", "ok");
    }
  } catch (e) {
    toast(errMsg(e), "error");
    record = { ...record, error: errMsg(e) };
    recordPhase = "idle";
  } finally {
    recordBusy = false;
    renderRecord();
  }
}

// ---------------- 拉取 ----------------
async function refreshDevices(): Promise<void> {
  try { devices = (await api<{ devices: Device[] }>("/api/devices")).devices || []; }
  catch (e) { /* keep previous */ }
  renderTopbar();
}
async function refreshConfig(): Promise<void> {
  try {
    const cfg = await api<{ outputPath: string; androidOutputPath: string; ipaPath: string; apkPath: string; lastPlatform: string }>("/api/config");
    outputPath = cfg.outputPath || "";
    const androidOutputPath = cfg.androidOutputPath || "";
    const ipaPath = cfg.ipaPath || "";
    const apkPath = cfg.apkPath || "";
    _suppressInputCapture = true;
    const opEl = document.getElementById("output-path") as HTMLInputElement | null;
    if (opEl) opEl.value = outputPath;
    _outputInputValue = outputPath;
    const aopEl = document.getElementById("android-output-path") as HTMLInputElement | null;
    if (aopEl) aopEl.value = androidOutputPath;
    _androidOutputInputValue = androidOutputPath;
    const ipEl = document.getElementById("ipa-path") as HTMLInputElement | null;
    if (ipEl) ipEl.value = ipaPath;
    _ipaInputValue = ipaPath;
    const apkEl = document.getElementById("android-apk-path") as HTMLInputElement | null;
    if (apkEl) apkEl.value = apkPath;
    _apkInputValue = apkPath;
    _suppressInputCapture = false;

    // 恢复上次打开的平台（初始默认 iOS）
    if (cfg.lastPlatform === "android" && currentPlatform !== "android") {
      setPlatform("android");
    }
  } catch { /* keep */ }
}
async function saveOutputPath(): Promise<void> {
  // 读实时缓存值而非 DOM value，避免浏览器自动填充/DOM 覆盖
  const value = _outputInputValue.trim();
  try {
    const cfg = await api<{ outputPath: string }>("/api/config", { method: "PUT", body: JSON.stringify({ outputPath: value }) });
    outputPath = cfg.outputPath || "";
    _suppressInputCapture = true;
    const opEl = document.getElementById("output-path") as HTMLInputElement | null;
    if (opEl) opEl.value = outputPath;
    _outputInputValue = outputPath;
    _suppressInputCapture = false;
    toast(`输出目录已应用：${outputPath || "默认目录"}`, "ok");
    renderFiles();
  } catch (e) { toast(errMsg(e), "error"); }
}
async function openOutputDir(): Promise<void> {
  const dir = _outputInputValue.trim() || outputPath;
  try {
    await api("/api/open-dir", { method: "POST", body: JSON.stringify({ dir }) });
  } catch (e) { toast(errMsg(e), "error"); }
}
async function saveAndroidOutputPath(): Promise<void> {
  const value = _androidOutputInputValue.trim();
  try {
    const cfg = await api<{ androidOutputPath: string }>("/api/config", { method: "PUT", body: JSON.stringify({ androidOutputPath: value }) });
    const androidOutputPath = cfg.androidOutputPath || "";
    _suppressInputCapture = true;
    const aopEl = document.getElementById("android-output-path") as HTMLInputElement | null;
    if (aopEl) aopEl.value = androidOutputPath;
    _androidOutputInputValue = androidOutputPath;
    _suppressInputCapture = false;
    toast(`Android 输出目录已应用：${androidOutputPath || "默认目录"}`, "ok");
    renderAndroidFiles();
  } catch (e) { toast(errMsg(e), "error"); }
}
async function refreshMode(): Promise<void> {
  try { mode = await api<ModeStatus>("/api/mode/status"); } catch { /* keep */ }
  renderTopbar();
  renderRecord();
}
async function refreshRecord(): Promise<void> {
  try { record = await api<RecordStatus>("/api/record/status"); } catch { /* keep */ }
  // 根据后端状态同步前端三态；后端意外停止（如异常中断）时回到 idle
  // 开始/停止操作进行中时不覆盖 recordPhase，避免按钮状态来回跳
  if (!recordBusy) {
    if (record.recording) {
      recordPhase = "recording";
    } else if (recordPhase === "recording") {
      recordPhase = "idle";
    }
  }
  renderRecord();
}
async function refreshHealth(): Promise<void> {
  try { health = await api<Health>("/api/health"); } catch { /* keep */ }
  renderTopbar();
}

// ---------------- 平台切换 ----------------
function renderDock(): void {
  const busy = recordPhase === "recording" || androidRecordPhase === "recording" || recordBusy;
  document.querySelectorAll(".dock-tab").forEach((t) => {
    (t as HTMLButtonElement).disabled = busy;
  });
}

function setPlatform(platform: "ios" | "android"): boolean {
  if (platform !== currentPlatform && (recordPhase === "recording" || androidRecordPhase === "recording")) {
    toast("录制中无法切换平台，请先停止录制", "error");
    return false;
  }
  currentPlatform = platform;
  document.querySelectorAll(".platform-panel").forEach((p) => {
    p.classList.toggle("active", p.id === `panel-${platform}`);
  });
  const current = document.getElementById("dock-current");
  if (current) current.textContent = platform === "ios" ? "iOS" : "Android";
  document.querySelectorAll(".dock-tab").forEach((t) => {
    t.classList.toggle("active", (t as HTMLElement).dataset.platform === platform);
  });
  renderTopbar();
  renderQuickControls();
  if (platform === "android") {
    refreshAndroidDevices();
    refreshAndroidApps();
    refreshAndroidRecord();
    renderAndroidFiles();
  }
  return true;
}

// ---------------- 渲染：Android 快捷控制 ----------------
function renderQuickControls(): void {
  const box = document.getElementById("quick-controls");
  if (!box) return;
  const show = currentPlatform === "android";
  box.classList.toggle("hidden", !show);
  if (show) refreshDeviceTime();
}

async function refreshDeviceTime(): Promise<void> {
  const el = document.getElementById("qc-time");
  if (!el) return;
  try {
    const data = await api<{ ok: boolean; date: string }>("/api/android/control/time");
    el.textContent = data.date || "--";
  } catch {
    el.textContent = "--";
  }
}

async function quickControl(path: string, fallback: string): Promise<void> {
  try {
    const data = await api<{ ok: boolean; message?: string }>(path, { method: "POST" });
    toast(data.message || fallback, "ok");
  } catch (e) {
    toast(errMsg(e), "error");
  }
}

function bindQuickControls(): void {
  const bind = (id: string, path: string, fallback: string): void => {
    const btn = document.getElementById(id);
    if (btn) btn.addEventListener("click", () => { void quickControl(path, fallback); });
  };
  bind("qc-reboot", "/api/android/control/reboot", "已发送重启指令");
  bind("qc-screen", "/api/android/control/screen", "已发送电源键");
  bind("qc-devmode", "/api/android/control/devmode", "开发者模式已切换");
  bind("qc-wifi", "/api/android/control/wifi", "WiFi 已切换");
}

// ---------------- 渲染：Android 设备（顶栏设备名 + 录制按钮可用性） ----------------
async function refreshAndroidDevices(): Promise<void> {
  try {
    const data = await api<{ devices: AndroidDevice[] }>("/api/android/devices");
    androidDevices = data.devices || [];
  } catch {
    androidDevices = [];
  }
  renderTopbar();
  renderAndroidRecord();
}

// ---------------- 渲染：Android 录制 ----------------
function renderAndroidRecord(): void {
  const toggle = document.getElementById("android-record-toggle") as HTMLButtonElement | null;
  if (!toggle) return;
  toggle.classList.toggle("recording", androidRecordPhase === "recording");
  toggle.disabled = androidRecordPhase !== "recording" && androidDevices.length === 0;
  if (androidRecordPhase === "recording") {
    toggle.title = "结束录制";
    toggle.setAttribute("aria-label", "结束录制");
  } else {
    toggle.title = "开始录制";
    toggle.setAttribute("aria-label", "开始录制");
  }

  renderDock();
}

async function refreshAndroidRecord(): Promise<void> {
  try { androidRecord = await api<AndroidRecordStatus>("/api/android/record/status"); } catch { /* keep */ }
  if (androidRecord.recording) {
    androidRecordPhase = "recording";
  } else if (androidRecordPhase === "recording") {
    androidRecordPhase = "idle";
  }
  renderAndroidRecord();
}

async function toggleAndroidRecord(): Promise<void> {
  if (androidRecordPhase === "recording") {
    try {
      androidRecord = await api<AndroidRecordStatus>("/api/android/record/stop", { method: "POST" });
      androidRecordPhase = "idle";
      toast("录制已停止，视频已保存到输出目录", "ok");
      renderAndroidFiles();
    } catch (e) {
      toast(errMsg(e), "error");
      androidRecordPhase = "idle";
    }
  } else {
    const dev = androidDevices.find((d) => d.state === "device") || androidDevices[0];
    const serial = dev?.serial || "";
    if (!serial) { toast("未检测到 Android 设备", "error"); return; }
    try {
      androidRecordPhase = "recording";
      androidRecord = await api<AndroidRecordStatus>("/api/android/record/start", { method: "POST", body: JSON.stringify({ serial }) });
      toast("录制已开始", "ok");
    } catch (e) {
      toast(errMsg(e), "error");
      androidRecordPhase = "idle";
    }
  }
  renderAndroidRecord();
}

// ---------------- 渲染：Android 视频文件 ----------------
function renderAndroidFiles(): void {
  if (androidRenaming) return;
  api<{ files: RecordFile[] }>("/api/android/files").then((data) => {
    const box = document.getElementById("android-record-files");
    if (!box || androidRenaming) return;
    const files = data.files || [];
    if (!files.length) {
      box.innerHTML = `<div class="empty">暂无录制文件</div>`;
      return;
    }
    box.innerHTML = "";
    for (const f of files) {
      const item = el("div", "file-item");
      const main = el("div", "fi-main");
      const nameEl = el("div", "fi-name", f.name);
      nameEl.title = `${f.name}\n双击重命名（后缀 .mp4 不可修改）`;
      nameEl.addEventListener("dblclick", () => beginAndroidRename(nameEl, f));
      const meta = el("div", "fi-meta", `${fmtBytes(f.size)} · ${fmtTime(f.modifiedAt)}`);
      main.append(nameEl, meta);
      const actions = el("div", "fi-actions");
      const play = el("button", "btn primary", "播放") as HTMLButtonElement;
      play.type = "button";
      play.addEventListener("click", () => openAndroidPlayer(f));
      const del = el("button", "btn danger", "删除") as HTMLButtonElement;
      del.type = "button";
      del.addEventListener("click", () => deleteAndroidFile(f));
      actions.append(play, del);
      item.append(main, actions);
      box.appendChild(item);
    }
  }).catch(() => {
    const box = document.getElementById("android-record-files");
    if (box) box.innerHTML = `<div class="empty">加载失败</div>`;
  });
}

function openAndroidPlayer(f: RecordFile): void {
  const modal = document.getElementById("player-modal");
  const video = document.getElementById("player-video") as HTMLVideoElement | null;
  const title = document.getElementById("player-modal-title");
  if (!modal || !video) return;
  if (title) title.textContent = f.name;
  video.src = `/api/android/stream?path=${encodeURIComponent(f.path)}`;
  modal.classList.remove("hidden");
  video.play().catch(() => { /* 自动播放被拦截时由用户手动点击播放 */ });
}

function deleteAndroidFile(f: RecordFile): void {
  askConfirm(`确定删除「${f.name}」？此操作不可撤销。`, "删除", () => {
    api<{ ok: boolean }>("/api/android/delete", { method: "POST", body: JSON.stringify({ path: f.path }) })
      .then(() => { toast(`视频「${f.name}」已删除`, "ok"); renderAndroidFiles(); })
      .catch((e) => toast(errMsg(e), "error"));
  });
}

function beginAndroidRename(nameEl: HTMLElement, f: RecordFile): void {
  androidRenaming = true;
  const input = document.createElement("input");
  input.type = "text";
  input.value = baseName(f.name);
  input.className = "rename-input";
  input.maxLength = 120;
  const suffix = el("span", "fi-ext", ".mp4");
  nameEl.textContent = "";
  nameEl.style.direction = "ltr";
  nameEl.append(input, suffix);
  input.focus();
  input.select();
  let done = false;
  const commit = async () => {
    if (done) return;
    done = true;
    const value = input.value.trim();
    androidRenaming = false;
    if (!value || value === baseName(f.name)) { renderAndroidFiles(); return; }
    try {
      await api<{ path: string; name: string }>("/api/android/rename", { method: "POST", body: JSON.stringify({ path: f.path, name: value }) });
      toast("文件已重命名", "ok");
    } catch (e) { toast(errMsg(e), "error"); }
    renderAndroidFiles();
  };
  const cancel = () => {
    if (done) return;
    done = true;
    androidRenaming = false;
    renderAndroidFiles();
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); commit(); }
    else if (e.key === "Escape") cancel();
  });
  input.addEventListener("blur", commit);
}

// ---------------- 渲染：Android 应用管理 ----------------
function renderAndroidAppSelect(): void {
  const sel = document.getElementById("android-app-select") as HTMLSelectElement | null;
  if (!sel) return;
  const prev = sel.value;
  sel.innerHTML = `<option value="">选择要卸载的应用…</option>`;
  for (const a of androidApps) {
    const opt = document.createElement("option");
    opt.value = a.packageName;
    opt.textContent = a.name && a.name !== a.packageName ? `${a.name}（${a.packageName}）` : a.packageName;
    sel.appendChild(opt);
  }
  if (androidApps.some((a) => a.packageName === prev)) sel.value = prev;
  const btn = document.getElementById("android-uninstall-btn") as HTMLButtonElement | null;
  if (btn) btn.disabled = !sel.value;
}

async function refreshAndroidApps(): Promise<void> {
  const msg = document.getElementById("android-apps-msg");
  if (msg) { msg.textContent = "加载中…"; msg.className = "msg"; }
  try {
    const data = await api<{ apps: AndroidApp[]; total: number }>("/api/android/apps");
    androidApps = data.apps || [];
    if (msg) { msg.textContent = `共 ${androidApps.length} 个应用`; msg.className = "msg ok"; }
    renderAndroidAppSelect();
  } catch (e) {
    androidApps = [];
    renderAndroidAppSelect();
    if (msg) { msg.textContent = errMsg(e); msg.className = "msg error"; }
  }
}

async function uninstallAndroidApp(): Promise<void> {
  const sel = document.getElementById("android-app-select") as HTMLSelectElement | null;
  const packageName = sel?.value || "";
  if (!packageName || packageName === "__load_more__") { toast("请先选择要卸载的应用", "error"); return; }
  const a = androidApps.find((x) => x.packageName === packageName);
  const label = a?.name && a.name !== packageName ? `${a.name}（${packageName}）` : packageName;
  askConfirm(`确定卸载「${label}」？此操作不可撤销。`, "卸载", () => {
    api("/api/android/uninstall", { method: "POST", body: JSON.stringify({ packageName }) })
      .then(() => { toast(`应用「${a?.name || packageName}」已卸载`, "ok"); refreshAndroidApps(); })
      .catch((e) => toast(errMsg(e), "error"));
  });
}

// ---------------- 渲染：Android 安装 APK ----------------
function renderApkList(): void {
  const box = document.getElementById("android-apk-files");
  if (!box) return;
  if (!apkFiles.length) {
    box.innerHTML = `<div class="empty">尚未扫描到 APK 文件</div>`;
    return;
  }
  box.innerHTML = "";
  for (const f of apkFiles) {
    const item = el("div", "file-item");
    const main = el("div", "fi-main");
    const nameEl = el("div", "fi-name", f.name);
    nameEl.title = f.name;
    const meta = el("div", "fi-meta", fmtBytes(f.size));
    main.append(nameEl, meta);
    const actions = el("div", "fi-actions");
    const install = el("button", "btn primary", "卸载安装") as HTMLButtonElement;
    install.type = "button";
    install.addEventListener("click", () => installApk(f));
    actions.append(install);
    item.append(main, actions);
    box.appendChild(item);
  }
}

async function scanApk(): Promise<void> {
  const dir = _apkInputValue.trim();
  const msg = document.getElementById("android-apk-msg");
  if (!dir) { toast("请输入 APK 所在目录", "error"); return; }
  if (msg) { msg.textContent = "扫描中…"; msg.className = "msg"; }
  try {
    const data = await api<{ files: ApkFile[] }>(`/api/android/scan-apk?dir=${encodeURIComponent(dir)}`);
    apkFiles = data.files || [];
    renderApkList();
    if (msg) {
      msg.textContent = apkFiles.length ? `找到 ${apkFiles.length} 个 APK 文件` : `在「${dir}」下没有找到 .apk 文件`;
      msg.className = apkFiles.length ? "msg ok" : "msg";
    }
    // 记住扫描目录，下次打开自动带出
    api("/api/config", { method: "PUT", body: JSON.stringify({ apkPath: dir }) }).catch(() => {});
  } catch (e) {
    apkFiles = [];
    renderApkList();
    if (msg) { msg.textContent = errMsg(e); msg.className = "msg error"; }
  }
}

async function installApk(f: ApkFile): Promise<void> {
  const msg = document.getElementById("android-apk-msg");
  if (msg) { msg.textContent = `卸载安装中：${f.name}…`; msg.className = "msg"; }
  try {
    await api("/api/android/install", { method: "POST", body: JSON.stringify({ apkPath: f.path }) });
    toast(`应用「${f.name}」已卸载并重新安装`, "ok");
    if (msg) { msg.textContent = "卸载安装完成"; msg.className = "msg ok"; }
    refreshAndroidApps();
  } catch (e) {
    toast(errMsg(e), "error");
    if (msg) { msg.textContent = errMsg(e); msg.className = "msg error"; }
  }
}

async function openAndroidDir(): Promise<void> {
  try {
    await api("/api/android/open-dir", { method: "POST" });
  } catch (e) { toast(errMsg(e), "error"); }
}

// ---------------- 绑定 ----------------
function on(id: string, type: string, handler: (e: Event) => void): void {
  const el = document.getElementById(id);
  if (el) el.addEventListener(type, handler);
}

function bindEvents(): void {
  on("record-toggle", "click", toggleRecord);
  on("save-path-btn", "click", saveOutputPath);
  on("open-dir-btn", "click", openOutputDir);
  on("refresh-files-btn", "click", renderFiles);
  on("refresh-apps-btn", "click", refreshApps);
  on("app-select", "change", () => {
    const sel = document.getElementById("app-select") as HTMLSelectElement | null;
    const btn = document.getElementById("uninstall-btn") as HTMLButtonElement | null;
    if (btn) btn.disabled = !(sel?.value);
  });
  on("uninstall-btn", "click", uninstallApp);
  on("scan-btn", "click", scanIpa);
  on("player-modal-close", "click", closePlayer);
  on("player-modal-backdrop", "click", closePlayer);
  on("confirm-cancel", "click", closeConfirm);
  on("confirm-backdrop", "click", closeConfirm);
  on("confirm-ok", "click", confirmOk);
  on("cooldown-start", "click", startCooldown);
  on("cooldown-overlay", "click", closeCooldownOverlay);
  on("timer-dial", "click", cancelCooldown);

  // Android 面板
  on("android-record-toggle", "click", toggleAndroidRecord);
  on("android-cooldown-start", "click", startAndroidCooldown);
  on("android-timer-dial", "click", cancelAndroidCooldown);
  on("android-save-path-btn", "click", saveAndroidOutputPath);
  on("android-refresh-files-btn", "click", renderAndroidFiles);
  on("android-open-dir-btn", "click", openAndroidDir);
  on("android-refresh-apps-btn", "click", refreshAndroidApps);
  on("android-app-select", "change", () => {
    const sel = document.getElementById("android-app-select") as HTMLSelectElement | null;
    const btn = document.getElementById("android-uninstall-btn") as HTMLButtonElement | null;
    if (btn) btn.disabled = !(sel?.value);
  });
  on("android-uninstall-btn", "click", uninstallAndroidApp);
  on("android-scan-btn", "click", scanApk);

  // dock 平台切换
  document.querySelectorAll(".dock-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      const platform = (tab as HTMLElement).dataset.platform as "ios" | "android";
      if (setPlatform(platform)) {
        // 记住上次打开的平台
        api("/api/config", { method: "PUT", body: JSON.stringify({ lastPlatform: platform }) }).catch(() => {});
      }
    });
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { closePlayer(); closeConfirm(); }
  });
}

// ---------------- 启动 ----------------
function init(): void {
  bindEvents();
  bindQuickControls();

  // 强制阻止浏览器自动填充覆盖 input 值（某些浏览器无视 autocomplete="off"）
  const op = document.getElementById("output-path") as HTMLInputElement | null;
  if (op) {
    op.setAttribute("autocomplete", "new-password");
    op.setAttribute("readonly", "true"); op.removeAttribute("readonly");
    op.addEventListener("input", () => {
      if (_suppressInputCapture) return;
      _outputInputValue = op.value;
    });
  }
  const ip = document.getElementById("ipa-path") as HTMLInputElement | null;
  if (ip) {
    ip.setAttribute("autocomplete", "new-password");
    ip.addEventListener("input", () => {
      if (_suppressInputCapture) return;
      _ipaInputValue = ip.value;
    });
  }
  const aop = document.getElementById("android-output-path") as HTMLInputElement | null;
  if (aop) {
    aop.setAttribute("autocomplete", "new-password");
    aop.setAttribute("readonly", "true"); aop.removeAttribute("readonly");
    aop.addEventListener("input", () => {
      if (_suppressInputCapture) return;
      _androidOutputInputValue = aop.value;
    });
  }
  const apk = document.getElementById("android-apk-path") as HTMLInputElement | null;
  if (apk) {
    apk.setAttribute("autocomplete", "new-password");
    apk.addEventListener("input", () => {
      if (_suppressInputCapture) return;
      _apkInputValue = apk.value;
    });
  }

  refreshHealth();
  refreshDevices();
  refreshConfig();
  refreshMode();
  refreshRecord();
  refreshApps();
  renderFiles();
  renderQuickControls();
  initTimer();
  initAndroidTimer();
  window.setInterval(refreshDevices, 3000);
  window.setInterval(refreshMode, 2000);
  window.setInterval(refreshRecord, 1000);
  window.setInterval(refreshHealth, 10000);
  window.setInterval(renderFiles, 4000);
  window.setInterval(() => { if (currentPlatform === "android") refreshAndroidDevices(); }, 3000);
  window.setInterval(() => { if (currentPlatform === "android") refreshAndroidRecord(); }, 1000);
  window.setInterval(() => { if (currentPlatform === "android") renderAndroidFiles(); }, 4000);
  window.setInterval(() => { if (currentPlatform === "android") refreshDeviceTime(); }, 60000);
}

// 推迟到 load 之后再启动：避免嵌入式 WebView 首屏主框架尚未提交完成时，
// 同步发出的首个 fetch 被导航中止（net::ERR_ABORTED）。静态资源加载很快，延迟可忽略。
if (document.readyState === "complete") {
  init();
} else {
  window.addEventListener("load", init, { once: true });
}
