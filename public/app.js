"use strict";
(() => {
  // frontend-src/main.ts
  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== void 0) node.textContent = text;
    return node;
  }
  async function api(path, init2) {
    const res = await fetch(path, { headers: { "Content-Type": "application/json" }, ...init2 });
    let data = null;
    try {
      data = await res.json();
    } catch {
    }
    if (!res.ok) {
      const msg = data?.error?.message || data?.message || (typeof data?.error === "string" ? data.error : null) || res.statusText || `HTTP ${res.status}`;
      const err = new Error(msg);
      err.code = data?.error?.code;
      throw err;
    }
    return data;
  }
  function toast(message, kind = "info") {
    const t = document.getElementById("toast");
    if (!t) return;
    t.textContent = message;
    t.className = `toast ${kind === "info" ? "" : kind}`;
    t.classList.remove("hidden");
    window.clearTimeout(toast._t);
    toast._t = window.setTimeout(() => t.classList.add("hidden"), 2600);
  }
  function errMsg(e) {
    return e instanceof Error ? e.message : String(e);
  }
  async function runWithBusy(btn, task) {
    if (!btn) {
      await task();
      return;
    }
    const el2 = btn;
    const wasDisabled = el2.disabled;
    el2.disabled = true;
    btn.classList.add("is-busy");
    try {
      await task();
    } finally {
      btn.classList.remove("is-busy");
      el2.disabled = wasDisabled;
    }
  }
  function fmtBytes(n) {
    if (!n) return "0 B";
    const units = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(n) / Math.log(1024));
    return `${(n / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
  }
  function fmtTime(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString();
  }
  var devices = [];
  var mode = { switching: false, currentMode: "normal", message: "" };
  var record = { recording: false, durationSeconds: 0 };
  var recordPhase = "idle";
  var recordBusy = false;
  var health = null;
  var apps = [];
  var ipaFiles = [];
  var modeSwitching = false;
  var renaming = false;
  var outputPath = "";
  var androidDevices = [];
  var androidApps = [];
  var androidRecord = { recording: false, durationSeconds: 0 };
  var androidRecordPhase = "idle";
  var apkFiles = [];
  var androidRenaming = false;
  var currentPlatform = "ios";
  var _apkInputValue = "";
  var _outputInputValue = "";
  var _androidOutputInputValue = "";
  var _ipaInputValue = "";
  var _suppressInputCapture = false;
  var _confirmCallback = null;
  var _cooldownTimer = null;
  var _cooldownRemaining = 0;
  var _cooldownTotal = 0;
  var _cooldownMinutes = 0;
  var _cooldownSeconds = 10;
  var _androidCooldownTimer = null;
  var _androidCooldownRemaining = 0;
  var _androidCooldownTotal = 0;
  var _androidCooldownMinutes = 0;
  var _androidCooldownSeconds = 10;
  function renderTopbar() {
    const pill = document.getElementById("device-pill");
    if (pill) {
      const dot = pill.querySelector(".dot");
      const name = pill.querySelector(".dp-name");
      let label = "\u65E0\u8BBE\u5907";
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
          label = `${dev.name} \xB7 ${dev.stateLabel}`;
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
    const labels = currentPlatform === "android" ? [["ffmpeg", "FFmpeg \u7F16\u7801"], ["android", "\u5C4F\u5E55\u91C7\u96C6"]] : [["core", "\u91C7\u96C6\u6838\u5FC3"], ["ffmpeg", "FFmpeg \u7F16\u7801"], ["usb", "\u5C4F\u5E55\u91C7\u96C6"], ["ideviceinstaller", "\u5E94\u7528\u5B89\u88C5"]];
    for (const [key, label] of labels) {
      const h = health?.[key];
      const wrap = el("span", "env-item");
      const d = el("span", `dot ${h ? h.ok ? "ok" : "bad" : "muted"}`);
      const t = el("span", "env-label", label);
      wrap.append(d, t);
      wrap.title = `${label}: ${h ? h.message : "\u672A\u68C0\u6D4B"}`;
      env.appendChild(wrap);
    }
  }
  function renderRecord() {
    const toggle = document.getElementById("record-toggle");
    if (!toggle) return;
    const busy = mode.switching || modeSwitching || recordBusy;
    toggle.classList.toggle("recording", recordPhase === "recording");
    toggle.disabled = busy;
    if (recordPhase === "recording") {
      toggle.title = "\u7ED3\u675F\u5F55\u5236";
      toggle.setAttribute("aria-label", "\u7ED3\u675F\u5F55\u5236");
    } else {
      toggle.title = "\u5F00\u59CB\u5F55\u5236";
      toggle.setAttribute("aria-label", "\u5F00\u59CB\u5F55\u5236");
    }
    renderDock();
  }
  function baseName(name) {
    return name.replace(/\.mp4$/i, "");
  }
  function renderFiles() {
    if (renaming) return;
    api("/api/record/files").then((data) => {
      const box = document.getElementById("record-files");
      if (!box) return;
      if (renaming) return;
      const files = data.files || [];
      if (!files.length) {
        box.innerHTML = `<div class="empty">\u6682\u65E0\u5F55\u5236\u6587\u4EF6</div>`;
        return;
      }
      box.innerHTML = "";
      for (const f of files) {
        const item = el("div", "file-item");
        const main = el("div", "fi-main");
        const nameEl = el("div", "fi-name", f.name);
        nameEl.title = `${f.name}
\u53CC\u51FB\u91CD\u547D\u540D\uFF08\u540E\u7F00 .mp4 \u4E0D\u53EF\u4FEE\u6539\uFF09`;
        nameEl.addEventListener("dblclick", () => beginRename(nameEl, f));
        const meta = el("div", "fi-meta", `${fmtBytes(f.size)} \xB7 ${fmtTime(f.modifiedAt)}`);
        main.append(nameEl, meta);
        const actions = el("div", "fi-actions");
        const play = el("button", "btn primary", "\u64AD\u653E");
        play.type = "button";
        play.addEventListener("click", () => openPlayer(f));
        const del = el("button", "btn danger", "\u5220\u9664");
        del.type = "button";
        del.addEventListener("click", () => deleteFile(f));
        actions.append(play, del);
        item.append(main, actions);
        box.appendChild(item);
      }
    }).catch(() => {
      const box = document.getElementById("record-files");
      if (box) box.innerHTML = `<div class="empty">\u52A0\u8F7D\u5931\u8D25</div>`;
    });
  }
  function openPlayer(f) {
    const modal = document.getElementById("player-modal");
    const video = document.getElementById("player-video");
    const title = document.getElementById("player-modal-title");
    if (!modal || !video) return;
    if (title) title.textContent = f.name;
    video.src = `/api/record/stream?path=${encodeURIComponent(f.path)}`;
    modal.classList.remove("hidden");
    video.play().catch(() => {
    });
  }
  function closePlayer() {
    const modal = document.getElementById("player-modal");
    const video = document.getElementById("player-video");
    if (modal) modal.classList.add("hidden");
    if (video) {
      video.pause();
      video.removeAttribute("src");
      video.load();
    }
  }
  function askConfirm(message, okText, onOk) {
    const modal = document.getElementById("confirm-modal");
    const msgEl = document.getElementById("confirm-message");
    const okBtn = document.getElementById("confirm-ok");
    if (!modal || !msgEl) {
      onOk();
      return;
    }
    msgEl.textContent = message;
    if (okBtn) okBtn.textContent = okText;
    _confirmCallback = onOk;
    modal.classList.remove("hidden");
  }
  function closeConfirm() {
    const modal = document.getElementById("confirm-modal");
    if (modal) modal.classList.add("hidden");
    _confirmCallback = null;
  }
  function confirmOk() {
    const cb = _confirmCallback;
    closeConfirm();
    if (cb) cb();
  }
  function deleteFile(f) {
    askConfirm(`\u786E\u5B9A\u5220\u9664\u300C${f.name}\u300D\uFF1F\u6B64\u64CD\u4F5C\u4E0D\u53EF\u64A4\u9500\u3002`, "\u5220\u9664", () => {
      api("/api/record/delete", { method: "POST", body: JSON.stringify({ path: f.path }) }).then(() => {
        toast(`\u89C6\u9891\u300C${f.name}\u300D\u5DF2\u5220\u9664`, "ok");
        renderFiles();
      }).catch((e) => toast(errMsg(e), "error"));
    });
  }
  var TIMER_CIRCUMFERENCE = 2 * Math.PI * 33;
  function pad2(n) {
    return n < 10 ? `0${n}` : String(n);
  }
  function buildSelect(selectId, max, selected) {
    const sel = document.getElementById(selectId);
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
  function updateTimerDisplay() {
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
  function initTimer() {
    buildSelect("timer-min-select", 59, 0);
    buildSelect("timer-sec-select", 59, 10);
    _cooldownMinutes = 0;
    _cooldownSeconds = 10;
    const minSel = document.getElementById("timer-min-select");
    const secSel = document.getElementById("timer-sec-select");
    minSel?.addEventListener("change", () => {
      _cooldownMinutes = parseInt(minSel.value, 10) || 0;
    });
    secSel?.addEventListener("change", () => {
      _cooldownSeconds = parseInt(secSel.value, 10) || 0;
    });
    updateTimerDisplay();
  }
  function startCooldown() {
    if (_cooldownTimer !== null) return;
    const minSel = document.getElementById("timer-min-select");
    const secSel = document.getElementById("timer-sec-select");
    _cooldownMinutes = parseInt(minSel?.value || "0", 10) || 0;
    _cooldownSeconds = parseInt(secSel?.value || "10", 10) || 0;
    _cooldownTotal = _cooldownMinutes * 60 + _cooldownSeconds;
    if (_cooldownTotal <= 0) {
      toast("\u8BF7\u9009\u62E9\u5012\u8BA1\u65F6\u65F6\u957F", "error");
      return;
    }
    _cooldownRemaining = _cooldownTotal;
    _cooldownTimer = window.setInterval(() => {
      _cooldownRemaining--;
      if (_cooldownRemaining <= 0) {
        window.clearInterval(_cooldownTimer);
        _cooldownTimer = null;
        _cooldownRemaining = 0;
        updateTimerDisplay();
        const overlay = document.getElementById("cooldown-overlay");
        if (overlay) overlay.classList.remove("hidden");
      } else {
        updateTimerDisplay();
      }
    }, 1e3);
    updateTimerDisplay();
  }
  function cancelCooldown() {
    if (_cooldownTimer === null) return;
    window.clearInterval(_cooldownTimer);
    _cooldownTimer = null;
    _cooldownRemaining = 0;
    _cooldownTotal = 0;
    updateTimerDisplay();
    toast("\u5012\u8BA1\u65F6\u5DF2\u53D6\u6D88", "info");
  }
  function closeCooldownOverlay() {
    const overlay = document.getElementById("cooldown-overlay");
    if (overlay) overlay.classList.add("hidden");
  }
  function updateAndroidTimerDisplay() {
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
  function initAndroidTimer() {
    buildSelect("android-timer-min-select", 59, 0);
    buildSelect("android-timer-sec-select", 59, 10);
    _androidCooldownMinutes = 0;
    _androidCooldownSeconds = 10;
    const minSel = document.getElementById("android-timer-min-select");
    const secSel = document.getElementById("android-timer-sec-select");
    minSel?.addEventListener("change", () => {
      _androidCooldownMinutes = parseInt(minSel.value, 10) || 0;
    });
    secSel?.addEventListener("change", () => {
      _androidCooldownSeconds = parseInt(secSel.value, 10) || 0;
    });
    updateAndroidTimerDisplay();
  }
  function startAndroidCooldown() {
    if (_androidCooldownTimer !== null) return;
    const minSel = document.getElementById("android-timer-min-select");
    const secSel = document.getElementById("android-timer-sec-select");
    _androidCooldownMinutes = parseInt(minSel?.value || "0", 10) || 0;
    _androidCooldownSeconds = parseInt(secSel?.value || "10", 10) || 0;
    _androidCooldownTotal = _androidCooldownMinutes * 60 + _androidCooldownSeconds;
    if (_androidCooldownTotal <= 0) {
      toast("\u8BF7\u9009\u62E9\u5012\u8BA1\u65F6\u65F6\u957F", "error");
      return;
    }
    _androidCooldownRemaining = _androidCooldownTotal;
    _androidCooldownTimer = window.setInterval(() => {
      _androidCooldownRemaining--;
      if (_androidCooldownRemaining <= 0) {
        window.clearInterval(_androidCooldownTimer);
        _androidCooldownTimer = null;
        _androidCooldownRemaining = 0;
        updateAndroidTimerDisplay();
        const overlay = document.getElementById("cooldown-overlay");
        if (overlay) overlay.classList.remove("hidden");
      } else {
        updateAndroidTimerDisplay();
      }
    }, 1e3);
    updateAndroidTimerDisplay();
  }
  function cancelAndroidCooldown() {
    if (_androidCooldownTimer === null) return;
    window.clearInterval(_androidCooldownTimer);
    _androidCooldownTimer = null;
    _androidCooldownRemaining = 0;
    _androidCooldownTotal = 0;
    updateAndroidTimerDisplay();
    toast("\u5012\u8BA1\u65F6\u5DF2\u53D6\u6D88", "info");
  }
  function beginRename(nameEl, f) {
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
      if (!value || value === baseName(f.name)) {
        renderFiles();
        return;
      }
      try {
        await api("/api/record/rename", { method: "POST", body: JSON.stringify({ path: f.path, name: value }) });
        toast("\u6587\u4EF6\u5DF2\u91CD\u547D\u540D", "ok");
      } catch (e) {
        toast(errMsg(e), "error");
      }
      renderFiles();
    };
    const cancel = () => {
      if (done) return;
      done = true;
      renaming = false;
      renderFiles();
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        commit();
      } else if (e.key === "Escape") cancel();
    });
    input.addEventListener("blur", commit);
  }
  function renderAppSelect() {
    const sel = document.getElementById("app-select");
    if (!sel) return;
    const prev = sel.value;
    sel.innerHTML = `<option value="">\u9009\u62E9\u8981\u5378\u8F7D\u7684\u5E94\u7528\u2026</option>`;
    for (const a of apps) {
      const opt = document.createElement("option");
      opt.value = a.bundleId;
      opt.textContent = `${a.name || a.bundleId}\uFF08${a.bundleId}\uFF09${a.version ? ` v${a.version}` : ""}`;
      sel.appendChild(opt);
    }
    if (apps.some((a) => a.bundleId === prev)) sel.value = prev;
    const uninstallBtn = document.getElementById("uninstall-btn");
    if (uninstallBtn) uninstallBtn.disabled = !sel.value;
  }
  async function refreshApps() {
    const msg = document.getElementById("apps-msg");
    if (msg) {
      msg.textContent = "\u52A0\u8F7D\u4E2D\u2026";
      msg.className = "msg";
    }
    try {
      const data = await api("/api/apps");
      apps = data.apps || [];
      if (msg) {
        msg.textContent = `\u5171 ${apps.length} \u4E2A\u5E94\u7528`;
        msg.className = "msg ok";
      }
      renderAppSelect();
    } catch (e) {
      apps = [];
      renderAppSelect();
      if (msg) {
        msg.textContent = errMsg(e);
        msg.className = "msg error";
      }
    }
  }
  async function uninstallApp() {
    const sel = document.getElementById("app-select");
    const bundleId = sel?.value || "";
    if (!bundleId) {
      toast("\u8BF7\u5148\u9009\u62E9\u8981\u5378\u8F7D\u7684\u5E94\u7528", "error");
      return;
    }
    const a = apps.find((x) => x.bundleId === bundleId);
    const btn = document.getElementById("uninstall-btn");
    askConfirm(`\u786E\u5B9A\u5378\u8F7D\u300C${a?.name || bundleId}\u300D\uFF1F\u6B64\u64CD\u4F5C\u4E0D\u53EF\u64A4\u9500\u3002`, "\u5378\u8F7D", () => {
      void runWithBusy(btn, async () => {
        try {
          await api("/api/apps/uninstall", { method: "POST", body: JSON.stringify({ bundleId }) });
          toast(`\u5E94\u7528\u300C${a?.name || bundleId}\u300D\u5DF2\u5378\u8F7D`, "ok");
          await refreshApps();
        } catch (e) {
          toast(errMsg(e), "error");
        }
      });
    });
  }
  function renderIpaList() {
    const box = document.getElementById("ipa-files");
    if (!box) return;
    if (!ipaFiles.length) {
      box.innerHTML = `<div class="empty">\u5C1A\u672A\u626B\u63CF\u5230 IPA \u6587\u4EF6</div>`;
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
      const install = el("button", "btn primary", "\u5378\u8F7D\u5B89\u88C5");
      install.type = "button";
      install.addEventListener("click", () => {
        void installIpa(f, install);
      });
      actions.append(install);
      item.append(main, actions);
      box.appendChild(item);
    }
  }
  async function scanIpa() {
    const dir = _ipaInputValue.trim();
    const msg = document.getElementById("ipa-msg");
    if (!dir) {
      toast("\u8BF7\u8F93\u5165 IPA \u6240\u5728\u76EE\u5F55", "error");
      return;
    }
    if (msg) {
      msg.textContent = "\u626B\u63CF\u4E2D\u2026";
      msg.className = "msg";
    }
    await runWithBusy(document.getElementById("scan-btn"), async () => {
      try {
        const data = await api(`/api/apps/scan-ipa?dir=${encodeURIComponent(dir)}`);
        ipaFiles = data.files || [];
        renderIpaList();
        if (msg) {
          msg.textContent = ipaFiles.length ? `\u627E\u5230 ${ipaFiles.length} \u4E2A IPA \u6587\u4EF6` : `\u5728\u300C${dir}\u300D\u4E0B\u6CA1\u6709\u627E\u5230 .ipa \u6587\u4EF6`;
          msg.className = ipaFiles.length ? "msg ok" : "msg";
        }
        api("/api/config", { method: "PUT", body: JSON.stringify({ ipaPath: dir }) }).catch(() => {
        });
      } catch (e) {
        ipaFiles = [];
        renderIpaList();
        if (msg) {
          msg.textContent = errMsg(e);
          msg.className = "msg error";
        }
      }
    });
  }
  async function installIpa(f, btn) {
    const msg = document.getElementById("ipa-msg");
    if (msg) {
      msg.textContent = `\u5378\u8F7D\u5B89\u88C5\u4E2D\uFF1A${f.name}\u2026`;
      msg.className = "msg";
    }
    await runWithBusy(btn, async () => {
      try {
        await api("/api/apps/reinstall", { method: "POST", body: JSON.stringify({ ipaPath: f.path }) });
        toast(`\u5E94\u7528\u300C${f.name}\u300D\u5DF2\u5378\u8F7D\u5E76\u91CD\u65B0\u5B89\u88C5`, "ok");
        if (msg) {
          msg.textContent = "";
          msg.className = "msg";
        }
        refreshApps();
      } catch (e) {
        toast(errMsg(e), "error");
        if (msg) {
          msg.textContent = errMsg(e);
          msg.className = "msg error";
        }
      }
    });
  }
  async function applyMode(target) {
    if (modeSwitching || mode.switching) return false;
    modeSwitching = true;
    renderRecord();
    toast("\u6B63\u5728\u5207\u6362\u91C7\u96C6\u6A21\u5F0F\u2026\u8BF7\u52FF\u65AD\u5F00\u8BBE\u5907\u3002");
    try {
      mode = await api("/api/mode", { method: "POST", body: JSON.stringify({ mode: target }) });
      return mode.currentMode === target;
    } catch (e) {
      mode = { ...mode, message: errMsg(e) };
      return false;
    } finally {
      modeSwitching = false;
      refreshMode();
    }
  }
  async function toggleRecord() {
    if (mode.switching || modeSwitching || recordBusy) return;
    recordBusy = true;
    try {
      if (recordPhase === "recording") {
        record = await api("/api/record/stop", { method: "POST" });
        recordPhase = "idle";
        if (mode.currentMode === "record") {
          await applyMode("normal");
        }
        toast("\u5F55\u5236\u5DF2\u505C\u6B62\uFF0C\u89C6\u9891\u5DF2\u4FDD\u5B58\u5230\u8F93\u51FA\u76EE\u5F55", "ok");
        renderFiles();
      } else {
        if (mode.currentMode !== "record") {
          const entered = await applyMode("record");
          if (!entered) {
            toast(mode.message || "\u8FDB\u5165\u5F55\u5236\u6A21\u5F0F\u5931\u8D25", "error");
            return;
          }
        }
        record = await api("/api/record/start", { method: "POST" });
        recordPhase = "recording";
        toast("\u5F55\u5236\u5DF2\u5F00\u59CB", "ok");
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
  async function refreshDevices() {
    try {
      devices = (await api("/api/devices")).devices || [];
    } catch (e) {
    }
    renderTopbar();
  }
  async function refreshConfig() {
    try {
      const cfg = await api("/api/config");
      outputPath = cfg.outputPath || "";
      const androidOutputPath = cfg.androidOutputPath || "";
      const ipaPath = cfg.ipaPath || "";
      const apkPath = cfg.apkPath || "";
      _suppressInputCapture = true;
      const opEl = document.getElementById("output-path");
      if (opEl) opEl.value = outputPath;
      _outputInputValue = outputPath;
      const aopEl = document.getElementById("android-output-path");
      if (aopEl) aopEl.value = androidOutputPath;
      _androidOutputInputValue = androidOutputPath;
      const ipEl = document.getElementById("ipa-path");
      if (ipEl) ipEl.value = ipaPath;
      _ipaInputValue = ipaPath;
      const apkEl = document.getElementById("android-apk-path");
      if (apkEl) apkEl.value = apkPath;
      _apkInputValue = apkPath;
      _suppressInputCapture = false;
      if (cfg.lastPlatform === "android" && currentPlatform !== "android") {
        setPlatform("android");
      }
    } catch {
    }
  }
  async function saveOutputPath() {
    const value = _outputInputValue.trim();
    try {
      const cfg = await api("/api/config", { method: "PUT", body: JSON.stringify({ outputPath: value }) });
      outputPath = cfg.outputPath || "";
      _suppressInputCapture = true;
      const opEl = document.getElementById("output-path");
      if (opEl) opEl.value = outputPath;
      _outputInputValue = outputPath;
      _suppressInputCapture = false;
      toast(`\u8F93\u51FA\u76EE\u5F55\u5DF2\u5E94\u7528\uFF1A${outputPath || "\u9ED8\u8BA4\u76EE\u5F55"}`, "ok");
      renderFiles();
    } catch (e) {
      toast(errMsg(e), "error");
    }
  }
  async function openOutputDir() {
    const dir = _outputInputValue.trim() || outputPath;
    try {
      await api("/api/open-dir", { method: "POST", body: JSON.stringify({ dir }) });
    } catch (e) {
      toast(errMsg(e), "error");
    }
  }
  async function saveAndroidOutputPath() {
    const value = _androidOutputInputValue.trim();
    try {
      const cfg = await api("/api/config", { method: "PUT", body: JSON.stringify({ androidOutputPath: value }) });
      const androidOutputPath = cfg.androidOutputPath || "";
      _suppressInputCapture = true;
      const aopEl = document.getElementById("android-output-path");
      if (aopEl) aopEl.value = androidOutputPath;
      _androidOutputInputValue = androidOutputPath;
      _suppressInputCapture = false;
      toast(`Android \u8F93\u51FA\u76EE\u5F55\u5DF2\u5E94\u7528\uFF1A${androidOutputPath || "\u9ED8\u8BA4\u76EE\u5F55"}`, "ok");
      renderAndroidFiles();
    } catch (e) {
      toast(errMsg(e), "error");
    }
  }
  async function refreshMode() {
    try {
      mode = await api("/api/mode/status");
    } catch {
    }
    renderTopbar();
    renderRecord();
  }
  async function refreshRecord() {
    try {
      record = await api("/api/record/status");
    } catch {
    }
    if (!recordBusy) {
      if (record.recording) {
        recordPhase = "recording";
      } else if (recordPhase === "recording") {
        recordPhase = "idle";
      }
    }
    renderRecord();
  }
  async function refreshHealth() {
    try {
      health = await api("/api/health");
    } catch {
    }
    renderTopbar();
  }
  function renderDock() {
    const busy = recordPhase === "recording" || androidRecordPhase === "recording" || recordBusy;
    document.querySelectorAll(".dock-tab").forEach((t) => {
      t.disabled = busy;
    });
  }
  function setPlatform(platform) {
    if (platform !== currentPlatform && (recordPhase === "recording" || androidRecordPhase === "recording")) {
      toast("\u5F55\u5236\u4E2D\u65E0\u6CD5\u5207\u6362\u5E73\u53F0\uFF0C\u8BF7\u5148\u505C\u6B62\u5F55\u5236", "error");
      return false;
    }
    currentPlatform = platform;
    document.querySelectorAll(".platform-panel").forEach((p) => {
      p.classList.toggle("active", p.id === `panel-${platform}`);
    });
    const current = document.getElementById("dock-current");
    if (current) current.textContent = platform === "ios" ? "iOS" : "Android";
    document.querySelectorAll(".dock-tab").forEach((t) => {
      t.classList.toggle("active", t.dataset.platform === platform);
    });
    renderTopbar();
    renderQuickControls();
    if (platform === "android") {
      refreshAndroidDevices();
      refreshAndroidApps();
      startAndroidAppNameStream();
      refreshAndroidRecord();
      renderAndroidFiles();
    } else {
      stopAndroidAppNameStream();
    }
    return true;
  }
  function renderQuickControls() {
    const box = document.getElementById("quick-controls");
    if (!box) return;
    const show = currentPlatform === "android";
    box.classList.toggle("hidden", !show);
    if (show) refreshDeviceTime();
  }
  async function refreshDeviceTime() {
    const el2 = document.getElementById("qc-time");
    if (!el2) return;
    try {
      const data = await api("/api/android/control/time");
      el2.textContent = data.date || "--";
    } catch {
      el2.textContent = "--";
    }
  }
  async function quickControl(btn, path, fallback) {
    await runWithBusy(btn, async () => {
      try {
        const data = await api(path, { method: "POST" });
        toast(data.message || fallback, "ok");
      } catch (e) {
        toast(errMsg(e), "error");
      }
    });
  }
  function bindQuickControls() {
    const bind = (id, path, fallback) => {
      const btn = document.getElementById(id);
      if (btn) btn.addEventListener("click", () => {
        void quickControl(btn, path, fallback);
      });
    };
    bind("qc-reboot", "/api/android/control/reboot", "\u5DF2\u53D1\u9001\u91CD\u542F\u6307\u4EE4");
    bind("qc-screen", "/api/android/control/screen", "\u5DF2\u53D1\u9001\u7535\u6E90\u952E");
    bind("qc-touches", "/api/android/control/touches", "\u663E\u793A\u89E6\u6478\u70B9\u5DF2\u5207\u6362");
    bind("qc-wifi", "/api/android/control/wifi", "WiFi \u5DF2\u5207\u6362");
  }
  async function refreshAndroidDevices() {
    try {
      const data = await api("/api/android/devices");
      androidDevices = data.devices || [];
    } catch {
      androidDevices = [];
    }
    renderTopbar();
    renderAndroidRecord();
  }
  function renderAndroidRecord() {
    const toggle = document.getElementById("android-record-toggle");
    if (!toggle) return;
    toggle.classList.toggle("recording", androidRecordPhase === "recording");
    toggle.disabled = androidRecordPhase !== "recording" && androidDevices.length === 0;
    if (androidRecordPhase === "recording") {
      toggle.title = "\u7ED3\u675F\u5F55\u5236";
      toggle.setAttribute("aria-label", "\u7ED3\u675F\u5F55\u5236");
    } else {
      toggle.title = "\u5F00\u59CB\u5F55\u5236";
      toggle.setAttribute("aria-label", "\u5F00\u59CB\u5F55\u5236");
    }
    renderDock();
  }
  async function refreshAndroidRecord() {
    try {
      androidRecord = await api("/api/android/record/status");
    } catch {
    }
    if (androidRecord.recording) {
      androidRecordPhase = "recording";
    } else if (androidRecordPhase === "recording") {
      androidRecordPhase = "idle";
    }
    renderAndroidRecord();
  }
  async function toggleAndroidRecord() {
    if (androidRecordPhase === "recording") {
      try {
        androidRecord = await api("/api/android/record/stop", { method: "POST" });
        androidRecordPhase = "idle";
        toast("\u5F55\u5236\u5DF2\u505C\u6B62\uFF0C\u89C6\u9891\u5DF2\u4FDD\u5B58\u5230\u8F93\u51FA\u76EE\u5F55", "ok");
        renderAndroidFiles();
      } catch (e) {
        toast(errMsg(e), "error");
        androidRecordPhase = "idle";
      }
    } else {
      const dev = androidDevices.find((d) => d.state === "device") || androidDevices[0];
      const serial = dev?.serial || "";
      if (!serial) {
        toast("\u672A\u68C0\u6D4B\u5230 Android \u8BBE\u5907", "error");
        return;
      }
      try {
        androidRecordPhase = "recording";
        androidRecord = await api("/api/android/record/start", { method: "POST", body: JSON.stringify({ serial }) });
        toast("\u5F55\u5236\u5DF2\u5F00\u59CB", "ok");
      } catch (e) {
        toast(errMsg(e), "error");
        androidRecordPhase = "idle";
      }
    }
    renderAndroidRecord();
  }
  function renderAndroidFiles() {
    if (androidRenaming) return;
    api("/api/android/files").then((data) => {
      const box = document.getElementById("android-record-files");
      if (!box || androidRenaming) return;
      const files = data.files || [];
      if (!files.length) {
        box.innerHTML = `<div class="empty">\u6682\u65E0\u5F55\u5236\u6587\u4EF6</div>`;
        return;
      }
      box.innerHTML = "";
      for (const f of files) {
        const item = el("div", "file-item");
        const main = el("div", "fi-main");
        const nameEl = el("div", "fi-name", f.name);
        nameEl.title = `${f.name}
\u53CC\u51FB\u91CD\u547D\u540D\uFF08\u540E\u7F00 .mp4 \u4E0D\u53EF\u4FEE\u6539\uFF09`;
        nameEl.addEventListener("dblclick", () => beginAndroidRename(nameEl, f));
        const meta = el("div", "fi-meta", `${fmtBytes(f.size)} \xB7 ${fmtTime(f.modifiedAt)}`);
        main.append(nameEl, meta);
        const actions = el("div", "fi-actions");
        const play = el("button", "btn primary", "\u64AD\u653E");
        play.type = "button";
        play.addEventListener("click", () => openAndroidPlayer(f));
        const del = el("button", "btn danger", "\u5220\u9664");
        del.type = "button";
        del.addEventListener("click", () => deleteAndroidFile(f));
        actions.append(play, del);
        item.append(main, actions);
        box.appendChild(item);
      }
    }).catch(() => {
      const box = document.getElementById("android-record-files");
      if (box) box.innerHTML = `<div class="empty">\u52A0\u8F7D\u5931\u8D25</div>`;
    });
  }
  function openAndroidPlayer(f) {
    const modal = document.getElementById("player-modal");
    const video = document.getElementById("player-video");
    const title = document.getElementById("player-modal-title");
    if (!modal || !video) return;
    if (title) title.textContent = f.name;
    video.src = `/api/android/stream?path=${encodeURIComponent(f.path)}`;
    modal.classList.remove("hidden");
    video.play().catch(() => {
    });
  }
  function deleteAndroidFile(f) {
    askConfirm(`\u786E\u5B9A\u5220\u9664\u300C${f.name}\u300D\uFF1F\u6B64\u64CD\u4F5C\u4E0D\u53EF\u64A4\u9500\u3002`, "\u5220\u9664", () => {
      api("/api/android/delete", { method: "POST", body: JSON.stringify({ path: f.path }) }).then(() => {
        toast(`\u89C6\u9891\u300C${f.name}\u300D\u5DF2\u5220\u9664`, "ok");
        renderAndroidFiles();
      }).catch((e) => toast(errMsg(e), "error"));
    });
  }
  function beginAndroidRename(nameEl, f) {
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
      if (!value || value === baseName(f.name)) {
        renderAndroidFiles();
        return;
      }
      try {
        await api("/api/android/rename", { method: "POST", body: JSON.stringify({ path: f.path, name: value }) });
        toast("\u6587\u4EF6\u5DF2\u91CD\u547D\u540D", "ok");
      } catch (e) {
        toast(errMsg(e), "error");
      }
      renderAndroidFiles();
    };
    const cancel = () => {
      if (done) return;
      done = true;
      androidRenaming = false;
      renderAndroidFiles();
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        commit();
      } else if (e.key === "Escape") cancel();
    });
    input.addEventListener("blur", commit);
  }
  function renderAndroidAppSelect() {
    const sel = document.getElementById("android-app-select");
    if (!sel) return;
    const prev = sel.value;
    sel.innerHTML = `<option value="">\u9009\u62E9\u5E94\u7528\u2026</option>`;
    for (const a of androidApps) {
      const opt = document.createElement("option");
      opt.value = a.packageName;
      opt.textContent = a.name && a.name !== a.packageName ? `${a.name}\uFF08${a.packageName}\uFF09` : a.packageName;
      sel.appendChild(opt);
    }
    if (androidApps.some((a) => a.packageName === prev)) sel.value = prev;
    const disabled = !sel.value;
    for (const id of ["android-force-stop-btn", "android-clear-data-btn", "android-uninstall-btn"]) {
      const btn = document.getElementById(id);
      if (btn) btn.disabled = disabled;
    }
  }
  async function refreshAndroidApps() {
    const msg = document.getElementById("android-apps-msg");
    if (msg) {
      msg.textContent = "\u52A0\u8F7D\u4E2D\u2026";
      msg.className = "msg";
    }
    try {
      const data = await api("/api/android/apps");
      androidApps = data.apps || [];
      if (msg) {
        msg.textContent = `\u5171 ${androidApps.length} \u4E2A\u5E94\u7528`;
        msg.className = "msg ok";
      }
      renderAndroidAppSelect();
    } catch (e) {
      androidApps = [];
      renderAndroidAppSelect();
      if (msg) {
        msg.textContent = errMsg(e);
        msg.className = "msg error";
      }
    }
  }
  var _appNameStream = null;
  var _appNameRenderTimer = null;
  function scheduleAndroidAppSelectRender() {
    if (_appNameRenderTimer !== null) return;
    _appNameRenderTimer = window.setTimeout(() => {
      _appNameRenderTimer = null;
      renderAndroidAppSelect();
    }, 120);
  }
  function startAndroidAppNameStream() {
    if (_appNameStream) return;
    const es = new EventSource("/api/android/apps/stream");
    es.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data);
        if (data.done) {
          stopAndroidAppNameStream();
          return;
        }
        if (data.packageName && data.name) {
          const app = androidApps.find((a) => a.packageName === data.packageName);
          if (app && app.name !== data.name) {
            app.name = data.name;
            scheduleAndroidAppSelectRender();
          }
        }
      } catch {
      }
    };
    es.onerror = () => {
    };
    _appNameStream = es;
  }
  function stopAndroidAppNameStream() {
    if (_appNameStream) {
      _appNameStream.close();
      _appNameStream = null;
    }
  }
  async function uninstallAndroidApp() {
    const sel = document.getElementById("android-app-select");
    const packageName = sel?.value || "";
    if (!packageName || packageName === "__load_more__") {
      toast("\u8BF7\u5148\u9009\u62E9\u8981\u5378\u8F7D\u7684\u5E94\u7528", "error");
      return;
    }
    const a = androidApps.find((x) => x.packageName === packageName);
    const label = a?.name && a.name !== packageName ? `${a.name}\uFF08${packageName}\uFF09` : packageName;
    const btn = document.getElementById("android-uninstall-btn");
    askConfirm(`\u786E\u5B9A\u5378\u8F7D\u300C${label}\u300D\uFF1F\u6B64\u64CD\u4F5C\u4E0D\u53EF\u64A4\u9500\u3002`, "\u5378\u8F7D", () => {
      void runWithBusy(btn, async () => {
        try {
          await api("/api/android/uninstall", { method: "POST", body: JSON.stringify({ packageName }) });
          toast(`\u5E94\u7528\u300C${a?.name || packageName}\u300D\u5DF2\u5378\u8F7D`, "ok");
          await refreshAndroidApps();
        } catch (e) {
          toast(errMsg(e), "error");
        }
      });
    });
  }
  async function forceStopAndroidApp() {
    const sel = document.getElementById("android-app-select");
    const packageName = sel?.value || "";
    if (!packageName) {
      toast("\u8BF7\u5148\u9009\u62E9\u5E94\u7528", "error");
      return;
    }
    const a = androidApps.find((x) => x.packageName === packageName);
    const btn = document.getElementById("android-force-stop-btn");
    await runWithBusy(btn, async () => {
      try {
        await api("/api/android/force-stop", { method: "POST", body: JSON.stringify({ packageName }) });
        toast(`\u5E94\u7528\u300C${a?.name || packageName}\u300D\u5DF2\u5173\u95ED`, "ok");
      } catch (e) {
        toast(errMsg(e), "error");
      }
    });
  }
  async function clearAndroidAppData() {
    const sel = document.getElementById("android-app-select");
    const packageName = sel?.value || "";
    if (!packageName) {
      toast("\u8BF7\u5148\u9009\u62E9\u5E94\u7528", "error");
      return;
    }
    const a = androidApps.find((x) => x.packageName === packageName);
    const label = a?.name && a.name !== packageName ? `${a.name}\uFF08${packageName}\uFF09` : packageName;
    const btn = document.getElementById("android-clear-data-btn");
    askConfirm(`\u786E\u5B9A\u6E05\u9664\u300C${label}\u300D\u7684\u5168\u90E8\u6570\u636E\u4E0E\u7F13\u5B58\uFF1F\u6B64\u64CD\u4F5C\u4E0D\u53EF\u64A4\u9500\u3002`, "\u6E05\u9664\u6570\u636E", () => {
      void runWithBusy(btn, async () => {
        try {
          await api("/api/android/clear-data", { method: "POST", body: JSON.stringify({ packageName }) });
          toast(`\u5DF2\u6E05\u9664\u300C${a?.name || packageName}\u300D\u7684\u6570\u636E`, "ok");
        } catch (e) {
          toast(errMsg(e), "error");
        }
      });
    });
  }
  function renderApkList() {
    const box = document.getElementById("android-apk-files");
    if (!box) return;
    if (!apkFiles.length) {
      box.innerHTML = `<div class="empty">\u5C1A\u672A\u626B\u63CF\u5230 APK \u6587\u4EF6</div>`;
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
      const install = el("button", "btn primary", "\u5378\u8F7D\u5B89\u88C5");
      install.type = "button";
      install.addEventListener("click", () => {
        void installApk(f, install);
      });
      actions.append(install);
      item.append(main, actions);
      box.appendChild(item);
    }
  }
  async function scanApk() {
    const dir = _apkInputValue.trim();
    const msg = document.getElementById("android-apk-msg");
    if (!dir) {
      toast("\u8BF7\u8F93\u5165 APK \u6240\u5728\u76EE\u5F55", "error");
      return;
    }
    if (msg) {
      msg.textContent = "\u626B\u63CF\u4E2D\u2026";
      msg.className = "msg";
    }
    await runWithBusy(document.getElementById("android-scan-btn"), async () => {
      try {
        const data = await api(`/api/android/scan-apk?dir=${encodeURIComponent(dir)}`);
        apkFiles = data.files || [];
        renderApkList();
        if (msg) {
          msg.textContent = apkFiles.length ? `\u627E\u5230 ${apkFiles.length} \u4E2A APK \u6587\u4EF6` : `\u5728\u300C${dir}\u300D\u4E0B\u6CA1\u6709\u627E\u5230 .apk \u6587\u4EF6`;
          msg.className = apkFiles.length ? "msg ok" : "msg";
        }
        api("/api/config", { method: "PUT", body: JSON.stringify({ apkPath: dir }) }).catch(() => {
        });
      } catch (e) {
        apkFiles = [];
        renderApkList();
        if (msg) {
          msg.textContent = errMsg(e);
          msg.className = "msg error";
        }
      }
    });
  }
  async function installApk(f, btn) {
    const msg = document.getElementById("android-apk-msg");
    if (msg) {
      msg.textContent = `\u5378\u8F7D\u5B89\u88C5\u4E2D\uFF1A${f.name}\u2026`;
      msg.className = "msg";
    }
    await runWithBusy(btn, async () => {
      try {
        await api("/api/android/install", { method: "POST", body: JSON.stringify({ apkPath: f.path }) });
        toast(`\u5E94\u7528\u300C${f.name}\u300D\u5DF2\u5378\u8F7D\u5E76\u91CD\u65B0\u5B89\u88C5`, "ok");
        if (msg) {
          msg.textContent = "";
          msg.className = "msg";
        }
        refreshAndroidApps();
      } catch (e) {
        toast(errMsg(e), "error");
        if (msg) {
          msg.textContent = errMsg(e);
          msg.className = "msg error";
        }
      }
    });
  }
  async function openAndroidDir() {
    try {
      await api("/api/android/open-dir", { method: "POST" });
    } catch (e) {
      toast(errMsg(e), "error");
    }
  }
  function on(id, type, handler) {
    const el2 = document.getElementById(id);
    if (el2) el2.addEventListener(type, handler);
  }
  function bindEvents() {
    on("record-toggle", "click", toggleRecord);
    on("save-path-btn", "click", saveOutputPath);
    on("open-dir-btn", "click", openOutputDir);
    on("refresh-files-btn", "click", renderFiles);
    on("refresh-apps-btn", "click", refreshApps);
    on("app-select", "change", () => {
      const sel = document.getElementById("app-select");
      const btn = document.getElementById("uninstall-btn");
      if (btn) btn.disabled = !sel?.value;
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
    on("android-record-toggle", "click", toggleAndroidRecord);
    on("android-cooldown-start", "click", startAndroidCooldown);
    on("android-timer-dial", "click", cancelAndroidCooldown);
    on("android-save-path-btn", "click", saveAndroidOutputPath);
    on("android-refresh-files-btn", "click", renderAndroidFiles);
    on("android-open-dir-btn", "click", openAndroidDir);
    on("android-refresh-apps-btn", "click", refreshAndroidApps);
    on("android-app-select", "change", () => {
      const sel = document.getElementById("android-app-select");
      const disabled = !sel?.value;
      for (const id of ["android-force-stop-btn", "android-clear-data-btn", "android-uninstall-btn"]) {
        const btn = document.getElementById(id);
        if (btn) btn.disabled = disabled;
      }
    });
    on("android-force-stop-btn", "click", forceStopAndroidApp);
    on("android-clear-data-btn", "click", clearAndroidAppData);
    on("android-uninstall-btn", "click", uninstallAndroidApp);
    on("android-scan-btn", "click", scanApk);
    document.querySelectorAll(".dock-tab").forEach((tab) => {
      tab.addEventListener("click", () => {
        const platform = tab.dataset.platform;
        if (setPlatform(platform)) {
          api("/api/config", { method: "PUT", body: JSON.stringify({ lastPlatform: platform }) }).catch(() => {
          });
        }
      });
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        closePlayer();
        closeConfirm();
      }
    });
  }
  function init() {
    bindEvents();
    bindQuickControls();
    const op = document.getElementById("output-path");
    if (op) {
      op.setAttribute("autocomplete", "new-password");
      op.setAttribute("readonly", "true");
      op.removeAttribute("readonly");
      op.addEventListener("input", () => {
        if (_suppressInputCapture) return;
        _outputInputValue = op.value;
      });
    }
    const ip = document.getElementById("ipa-path");
    if (ip) {
      ip.setAttribute("autocomplete", "new-password");
      ip.addEventListener("input", () => {
        if (_suppressInputCapture) return;
        _ipaInputValue = ip.value;
      });
    }
    const aop = document.getElementById("android-output-path");
    if (aop) {
      aop.setAttribute("autocomplete", "new-password");
      aop.setAttribute("readonly", "true");
      aop.removeAttribute("readonly");
      aop.addEventListener("input", () => {
        if (_suppressInputCapture) return;
        _androidOutputInputValue = aop.value;
      });
    }
    const apk = document.getElementById("android-apk-path");
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
    window.setInterval(refreshDevices, 3e3);
    window.setInterval(refreshMode, 2e3);
    window.setInterval(refreshRecord, 1e3);
    window.setInterval(refreshHealth, 1e4);
    window.setInterval(renderFiles, 4e3);
    window.setInterval(() => {
      if (currentPlatform === "android") refreshAndroidDevices();
    }, 3e3);
    window.setInterval(() => {
      if (currentPlatform === "android") refreshAndroidRecord();
    }, 1e3);
    window.setInterval(() => {
      if (currentPlatform === "android") renderAndroidFiles();
    }, 4e3);
    window.setInterval(() => {
      if (currentPlatform === "android") refreshDeviceTime();
    }, 6e4);
  }
  if (document.readyState === "complete") {
    init();
  } else {
    window.addEventListener("load", init, { once: true });
  }
})();
