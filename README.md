# Recording Station（IWCS）

Recording Station 是一个运行在 Windows x64 上的本地设备录制台，同时支持 **iOS** 和 **Android** 两个平台。后端使用 Node.js、Express 和 koffi 调用 `TicoGemini.Core.dll` 获取 iPhone 画面与系统音频，并通过 scrcpy / adb / aapt 实现 Android 录屏与应用管理；视频统一用 FFmpeg 封装为 MP4。前端是原生 HTML/CSS/JavaScript 单页控制台，默认地址为 `http://127.0.0.1:8787`。

## 主要功能

- 顶部 dock 栏在 **iOS / Android** 两个平台页签间切换，并记住上次打开的平台。
- 查看已连接设备、连接状态与运行环境（iOS 走 Core，Android 走 adb）。
- iOS：在普通模式和录制模式之间切换，录制 H.264 视频与 AAC 音频并封装为 MP4。
- Android：通过 scrcpy 无窗口录制屏幕为 MP4。
- 双平台都内置「冷却倒计时」计时器。
- 管理最近录制文件，包括播放、删除和重命名。
- 应用管理：iOS 列出/卸载应用、扫描并卸载安装 IPA；Android 列出/卸载应用、扫描并卸载安装 APK。
- 启动时检查 Core、FFmpeg、ideviceinstaller，以及 scrcpy / adb / aapt 及其依赖 DLL。

## 当前目录内容

以下是当前工作目录的实际组成。标注“本地文件”的内容不应提交到 Git，也不会被直接复制到 Release；Release 会重新安装所需的 npm 依赖。

```text
Recording-Station/
├── src/                              # TypeScript 后端源码
│   ├── index.ts                      # Express 入口、启动预检、静态站点与关闭流程
│   ├── system-dependencies.ts        # Apple、USB、VC++/UCRT、Media Foundation 检查
│   ├── native-core.ts                # koffi 原生 Core 接口与 DLL 加载
│   ├── config.ts                     # 配置读取、保存及项目内依赖路径解析
│   ├── devices.ts                    # iOS 设备接口
│   ├── record.ts                     # iOS 录制接口与录制会话
│   ├── media-output.ts               # FFmpeg 输出与 MP4 封装（iOS）
│   ├── mode.ts                       # iOS 工作模式切换
│   ├── apps.ts                       # iOS IPA 扫描、安装和应用卸载
│   ├── android.ts                    # Android 设备/录制/应用管理（scrcpy + adb + aapt）
│   ├── naming.ts                     # 录制文件命名（本地日期 + 随机码，双平台共用）
│   ├── health.ts                     # 健康检查接口
│   ├── types.ts                      # 配置及共享类型
│   ├── logger.ts                     # 日志
│   └── http-errors.ts                # HTTP 错误处理
├── frontend-src/
│   └── main.ts                       # 前端源码
├── public/
│   ├── index.html                    # 单页控制台（含 iOS / Android 两个平台面板）
│   ├── style.css                     # 页面样式
│   └── app.js                        # 前端构建产物，由 npm run build 生成
├── runtime/
│   ├── native/                       # iOS 采集核心
│   │   ├── TicoGemini.Core.dll
│   │   ├── iPhoneMirror.UsbConfigurationSwitch.exe
│   │   ├── libusb-1.0.dll
│   │   ├── libusb0.dll
│   │   └── Wireless/                 # 条件加载的解码器、许可证和构建信息
│   ├── ffmpeg/                       # ffmpeg.exe / ffprobe.exe
│   ├── scrcpy/                       # Android 录屏（scrcpy.exe + adb.exe + 依赖 DLL）
│   ├── aapt/                         # Android APK 解析（aapt.exe + libwinpthread-1.dll）
│   └── node/                         # 便携 Node.js（仅 Release 打包时加入）
├── msys64/ucrt64/bin/                # MSYS2 工具集及 DLL
│   └── ideviceinstaller.exe          # iOS 应用管理使用的主程序
├── scripts/
│   └── package-release.ps1           # 完整 Windows x64 Release 打包脚本
├── node_modules/                     # 当前已安装的 npm 依赖，本地文件
├── recording/                        # 默认录制输出目录（iOS→recording/ios，Android→recording/android），本地文件
├── logs/                             # 运行日志，本地文件
├── cache/                            # 便携 Node 缓存（打包复用，不进 Git）
├── redist/                           # VC++/UsbDk 可再分发安装器（可选）
├── release/                          # Release ZIP 输出目录（打包后生成）
├── .screenshots/                     # 开发验证截图，本地文件
├── config.json                       # 当前用户配置，本地文件
├── package.json                      # npm 脚本和依赖声明
├── package-lock.json                 # npm 依赖锁定文件
├── tsconfig.json                     # TypeScript 配置
├── Start-Recording-Station.cmd       # Release 便携启动入口
├── .gitattributes                    # DLL、EXE、ZIP 的 Git LFS 规则
├── .gitignore                        # 本地依赖、配置、录制与发布产物忽略规则
└── README.md
```

`msys64/ucrt64/bin/` 还包含 libimobiledevice、GnuTLS、OpenSSL、压缩工具等其他程序和 DLL。当前 iOS 应用管理直接使用 `ideviceinstaller.exe`；Release 打包脚本只复制该程序及同目录 DLL，不复制其余命令行工具。

当前目录是**源码/开发目录**：已经有 `node_modules/` 和 `public/app.js`，但没有便携 Node.js。`runtime/node/` 只在打包暂存目录中加入，`release/` 也只会在执行打包脚本后生成。

## 技术栈

- 后端：TypeScript、Node.js、Express、koffi。
- 前端：原生 HTML/CSS/JavaScript，使用 esbuild 构建。
- iOS 采集：iPhoneMirror Core、libusb。
- Android 采集：scrcpy、adb、aapt。
- 视频处理：FFmpeg、ffprobe。
- iOS 应用管理：libimobiledevice / ideviceinstaller。

## 启动当前源码目录

### 环境要求

- Windows 10/11 x64。
- Node.js 18 或更高版本。
- 下文“系统依赖”中列出的 Apple、USB 和 Windows 组件。
- Android 使用需要设备开启 USB 调试，并已放置 `runtime/scrcpy/` 与 `runtime/aapt/`。

当前目录依赖和前端构建产物已经存在，可以直接运行：

```powershell
npm start
```

首次在其他机器上获取源码时，需要先安装依赖并构建前端：

```powershell
npm ci
npm run build
npm start
```

如果通过 Git 分发源码，DLL 和 EXE 使用 Git LFS 管理。克隆后还需要获取大文件，否则对应文件只是 LFS 指针：

```powershell
git lfs install
git lfs pull
```

### 开发与检查命令

```powershell
npm run dev        # tsx watch，后端修改后自动重启
npm run build      # 构建 public/app.js 并执行 TypeScript 类型检查
npm run typecheck  # 仅执行 TypeScript 类型检查
npm start          # 启动服务并自动打开浏览器
```

## 完整 Release 运行包

完整运行包面向最终用户，不需要单独安装 Node.js、npm、Git 或 Git LFS。

### 构建运行包

在已经安装 Node.js/npm、能够联网的 Windows x64 构建机上运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\package-release.ps1
```

打包脚本会：

1. 在系统临时目录创建干净的构建副本。
2. 执行 `npm ci` 和 `npm run build`。
3. 从 Node.js 官方站点下载 Node.js 22 LTS x64，并验证 SHA256。
4. 收集后端、前端、npm 运行依赖、Core、FFmpeg、ideviceinstaller，以及 scrcpy、adb、aapt 所需文件。
5. 若 `redist/` 目录含可再分发安装器，一并打入 `redist/`（供接收方离线自装）。
6. 写入默认 `config.json`，不复制开发机个人配置、录制文件或日志。
7. 在 `release/` 下生成 `Recording-Station-v<版本>-win-x64.zip`。

也可以固定 Node.js 版本：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\package-release.ps1 -NodeVersion 22.16.0
```

### 使用运行包

1. 完整解压 ZIP，不要在压缩包内直接运行。
2. 双击 `Start-Recording-Station.cmd`。
3. 根据命令行提示安装缺失的系统组件。
4. 检查通过后，浏览器自动打开 `http://127.0.0.1:8787`。

## 系统依赖

以下组件不能仅靠复制项目文件获得，需要由 Windows 或官方安装程序提供：

- **Apple Mobile Device Service 与 Apple USB 驱动**：安装 Microsoft Store [Apple 设备](https://apps.microsoft.com/detail/9np83lwlpz9k)，或 Apple 官方 [iTunes](https://support.apple.com/downloads/itunes)，并确保 Apple Mobile Device Service 正在运行。
- **至少一种 USB 采集后端**：安装 [UsbDk](https://github.com/daynix/UsbDk/releases)，或使用与当前 Core 同版本的原版 iPhoneMirror 驱动管理器配置 libusb0 过滤驱动。
- **Visual C++/UCRT x64**：安装 Microsoft 官方 [Visual C++ 2015-2022 x64 运行库](https://aka.ms/vs/17/release/vc_redist.x64.exe)。
- **Media Foundation**：普通 Windows 10/11 已内置；Windows N 版需要安装 Microsoft 官方 [Media Feature Pack](https://support.microsoft.com/en-us/topic/media-feature-pack-list-for-windows-n-editions-c1c6fffa-d052-8338-7a79-a4bb980a700a)。

完整 Release 包的 `redist/` 目录会附带两个**允许再分发**的安装器，供接收方离线自装（缺什么装什么）：

- `vc_redist.x64.exe`：Visual C++/UCRT x64 运行库。
- `UsbDk_<版本>_x64.msi`：USB 采集后端。

Apple 驱动受许可限制，无法打包进 `redist/`，接收方仍需从 Microsoft Store 或 Apple 官网安装。

项目已经包含用户态 `libusb0.dll`，并会在 Core 加载前从项目目录预加载它；但 libusb0 内核过滤驱动和设备级绑定仍属于系统配置。不要使用 Zadig 替换 Apple 父设备驱动。

未连接设备时，部分 USB 状态只能在开始录制后确认，因此启动检查会显示警告，而不会把“尚未探测”直接判定为故障。

## Core 与条件组件

- `runtime/native/TicoGemini.Core.dll` 来自 iPhoneMirror-1.8.5-pre6。
- `runtime/native/Wireless/avcodec-58.dll` 和 `avutil-56.dll` 来自同一原版 Core 构建，供特定 iPad 原生 AirPlay 解码路径按需加载。许可证、构建参数和哈希信息位于 `runtime/native/Wireless/`。
- `iUsbBridge.exe` 只用于上述特定路径的方向监测，当前基础 USB 录制不需要。本项目未包含该桥接器；如需相关原版功能，必须使用与 Core 同版本的原版发行组件，不要混用其他版本。

## 配置

`config.json` 保存用户设置。该文件被 `.gitignore` 忽略，Release 中则由打包脚本生成默认版本。

| 字段 | 说明 | 默认值 |
| --- | --- | --- |
| `outputPath` | iOS 录制输出目录，可填相对或绝对路径 | `recording/ios` |
| `androidOutputPath` | Android 录制输出目录，可填相对或绝对路径 | `recording/android` |
| `ipaPath` | iOS 最近使用的 IPA 扫描目录，可为空 | 空字符串 |
| `apkPath` | Android 最近使用的 APK 扫描目录，可为空 | 空字符串 |
| `lastPlatform` | 上次打开的平台（`ios` / `android`） | `ios` |
| `fps` | iOS 录制帧率 | `60` |
| `listenHost` | 本地服务监听地址 | `127.0.0.1` |
| `gatewayPort` | 本地服务端口 | `8787` |
| `logLevel` | 日志级别 | `info` |

Core、FFmpeg、ideviceinstaller，以及 scrcpy、adb、aapt 的路径由程序根据项目目录自动解析，不依赖开发机的绝对路径，也不写入用户配置。

## 基本使用

### iOS

1. 使用 USB 连接 iPhone，并在设备上信任本机。
2. 启动 Recording Station，确认设备状态正常。
3. 在页面中设置输出目录和录制帧率。
4. 点击录制按钮开始，再次点击结束并生成 MP4。
5. 在最近录制列表中播放、重命名文件或打开所在目录。
6. 如需管理应用，在应用管理区域列出、卸载应用，或扫描并卸载安装 IPA。

### Android

1. 使用 USB 连接 Android 设备，并开启 USB 调试。
2. 切换到 Android 页签，确认设备被识别。
3. 在页面中设置 Android 输出目录。
4. 点击录制按钮开始，再次点击结束并生成 MP4。
5. 在最近录制列表中播放、重命名文件或打开所在目录。
6. 如需管理应用，在应用管理区域列出、卸载应用，或扫描并卸载安装 APK。

## 本地文件与发布注意事项

- `config.json`、`recording/`、`logs/`、截图、`node_modules/`、`cache/` 和 `redist/` 不应提交到 Git。
- `redist/` 中的安装器体积较大，且可随时从官方站点重新下载；如需再次打包，先按需放置安装器到 `redist/`。
- `public/app.js` 是构建产物，源码开发时通过 `npm run build` 重新生成。
- `release/` 是打包输出目录，不应作为源码提交。
- 给他人直接使用时应提供完整 Release ZIP，而不是只发送源码目录或 GitHub 的源码压缩包。
