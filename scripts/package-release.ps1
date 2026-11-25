[CmdletBinding()]
param(
  # 默认使用 Node.js 22 LTS 当前版本；也可传入固定版本，例如 22.16.0。
  [string]$NodeVersion = "latest-v22.x",
  [string]$OutputDirectory = ""
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if ($env:OS -ne "Windows_NT" -or -not [Environment]::Is64BitProcess) {
  throw "请在 Windows x64 的 64 位 PowerShell 中构建 Windows x64 运行包。"
}

$ScriptRoot = $PSScriptRoot
if ([string]::IsNullOrEmpty($ScriptRoot)) {
  $ScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
}
$ProjectRoot = [IO.Path]::GetFullPath((Join-Path $ScriptRoot ".."))
$OutputDirectory = if ($OutputDirectory) {
  [IO.Path]::GetFullPath($OutputDirectory)
} else {
  Join-Path $ProjectRoot "release"
}
$npm = (Get-Command npm.cmd -ErrorAction Stop).Source
$package = Get-Content -LiteralPath (Join-Path $ProjectRoot "package.json") -Raw | ConvertFrom-Json
$version = [string]$package.version
$work = Join-Path $env:TEMP ("recording-station-release-" + [Guid]::NewGuid().ToString("N"))
$packageRoot = Join-Path $work "Recording-Station"
$archivePath = Join-Path $OutputDirectory "Recording-Station-v$version-win-x64.zip"

function Assert-File {
  param([string]$RelativePath)
  $fullPath = Join-Path $ProjectRoot $RelativePath
  if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
    throw "缺少构建输入：$RelativePath"
  }
}

function Copy-Directory {
  param([string]$Source, [string]$Destination)
  Copy-Item -LiteralPath $Source -Destination $Destination -Recurse -Force
}

$requiredInputs = @(
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "README.md",
  "Start-Recording-Station.cmd",
  "runtime\native\TicoGemini.Core.dll",
  "runtime\native\iPhoneMirror.UsbConfigurationSwitch.exe",
  "runtime\native\libusb-1.0.dll",
  "runtime\native\libusb0.dll",
  "runtime\native\Wireless\avcodec-58.dll",
  "runtime\native\Wireless\avutil-56.dll",
  "runtime\ffmpeg\ffmpeg.exe",
  "runtime\ffmpeg\ffprobe.exe",
  "runtime\scrcpy\scrcpy.exe",
  "runtime\scrcpy\adb.exe",
  "runtime\aapt\aapt.exe",
  "msys64\ucrt64\bin\ideviceinstaller.exe"
)
foreach ($inputFile in $requiredInputs) { Assert-File $inputFile }
foreach ($inputDirectory in @("src", "frontend-src", "public", "runtime")) {
  if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot $inputDirectory) -PathType Container)) {
    throw "缺少构建目录：$inputDirectory"
  }
}

New-Item -ItemType Directory -Path $work -Force | Out-Null
try {
  New-Item -ItemType Directory -Path $packageRoot -Force | Out-Null
  New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null

  foreach ($directory in @("src", "frontend-src", "public", "runtime")) {
    Copy-Directory -Source (Join-Path $ProjectRoot $directory) -Destination (Join-Path $packageRoot $directory)
  }
  foreach ($file in @("package.json", "package-lock.json", "tsconfig.json", "README.md", "Start-Recording-Station.cmd")) {
    Copy-Item -LiteralPath (Join-Path $ProjectRoot $file) -Destination (Join-Path $packageRoot $file) -Force
  }

  # 可选：把可再分发的系统组件安装器（VC++ 运行库、UsbDk）一并放入 Release，
  # 方便接收方离线自装。Apple 驱动受许可限制，不在此列。
  $redistSource = Join-Path $ProjectRoot "redist"
  $redistIncluded = @()
  if (Test-Path -LiteralPath $redistSource -PathType Container) {
    $redistFiles = Get-ChildItem -LiteralPath $redistSource -File | Where-Object { $_.Extension -in @(".exe", ".msi") }
    if ($redistFiles) {
      Copy-Directory -Source $redistSource -Destination (Join-Path $packageRoot "redist")
      $redistIncluded = @($redistFiles | Select-Object -ExpandProperty Name)
    }
  }

  # 应用管理只需要 ideviceinstaller 及其同目录 DLL，不打包其他 MSYS 工具。
  $msysSource = Join-Path $ProjectRoot "msys64\ucrt64\bin"
  $msysDestination = Join-Path $packageRoot "msys64\ucrt64\bin"
  New-Item -ItemType Directory -Path $msysDestination -Force | Out-Null
  Copy-Item -LiteralPath (Join-Path $msysSource "ideviceinstaller.exe") -Destination $msysDestination -Force
  Get-ChildItem -LiteralPath $msysSource -Filter "*.dll" -File | Copy-Item -Destination $msysDestination -Force

  # 发布包只含默认设置，绝不复制开发机的 config.json、录制文件或日志。
  $defaultConfig = [ordered]@{
    outputPath = "recording"
    ipaPath = ""
    fps = 60
    listenHost = "127.0.0.1"
    gatewayPort = 8787
    logLevel = "info"
  } | ConvertTo-Json
  [IO.File]::WriteAllText(
    (Join-Path $packageRoot "config.json"),
    $defaultConfig,
    [Text.UTF8Encoding]::new($false)
  )

  Push-Location $packageRoot
  try {
    & $npm ci --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw "npm ci 失败，退出代码：$LASTEXITCODE" }
    & $npm run build
    if ($LASTEXITCODE -ne 0) { throw "npm run build 失败，退出代码：$LASTEXITCODE" }
  } finally {
    Pop-Location
  }

  # Node.js 便携版：优先使用工程内缓存，避免每次打包都从官网下载
  $nodeCache = Join-Path $ProjectRoot "cache\node"
  $nodeDestination = Join-Path $packageRoot "runtime\node"
  New-Item -ItemType Directory -Path $nodeDestination -Force | Out-Null

  if (Test-Path -LiteralPath (Join-Path $nodeCache "node.exe") -PathType Leaf) {
    # 缓存命中：直接复用，跳过下载
    Copy-Item -LiteralPath (Join-Path $nodeCache "node.exe") -Destination $nodeDestination -Force
    $cachedLicense = Join-Path $nodeCache "LICENSE"
    if (Test-Path -LiteralPath $cachedLicense -PathType Leaf) {
      Copy-Item -LiteralPath $cachedLicense -Destination $nodeDestination -Force
    }
    $resolvedNodeVersion = "cached"
  } else {
    # 缓存未命中：从官网下载、校验、解压，并写入缓存供下次使用
    $distBase = if ($NodeVersion -ieq "latest-v22.x") {
      "https://nodejs.org/dist/latest-v22.x"
    } else {
      "https://nodejs.org/dist/v$($NodeVersion.TrimStart('v'))"
    }
    $sumsPath = Join-Path $work "node-SHASUMS256.txt"
    Invoke-WebRequest -UseBasicParsing -Uri "$distBase/SHASUMS256.txt" -OutFile $sumsPath
    $sums = Get-Content -LiteralPath $sumsPath -Raw
    $match = [regex]::Match($sums, '(?m)^([0-9a-fA-F]{64})\s+(node-(v[^-\r\n]+)-win-x64\.zip)\r?$')
    if (-not $match.Success) { throw "无法在 $distBase 中找到 Windows x64 Node.js  zip。" }
    $expectedHash = $match.Groups[1].Value.ToUpperInvariant()
    $nodeArchiveName = $match.Groups[2].Value
    $resolvedNodeVersion = $match.Groups[3].Value
    $nodeArchive = Join-Path $work $nodeArchiveName
    Invoke-WebRequest -UseBasicParsing -Uri "$distBase/$nodeArchiveName" -OutFile $nodeArchive
    $actualHash = (Get-FileHash -LiteralPath $nodeArchive -Algorithm SHA256).Hash.ToUpperInvariant()
    if ($actualHash -ne $expectedHash) { throw "Node.js 下载包 SHA256 校验失败。" }

    $nodeExtract = Join-Path $work "node-extract"
    Expand-Archive -LiteralPath $nodeArchive -DestinationPath $nodeExtract
    $nodeHome = Join-Path $nodeExtract ([IO.Path]::GetFileNameWithoutExtension($nodeArchiveName))
    Copy-Item -LiteralPath (Join-Path $nodeHome "node.exe") -Destination $nodeDestination -Force
    $nodeLicense = Join-Path $nodeHome "LICENSE"
    if (Test-Path -LiteralPath $nodeLicense -PathType Leaf) {
      Copy-Item -LiteralPath $nodeLicense -Destination $nodeDestination -Force
    }

    # 写入缓存，供下次打包直接复用
    New-Item -ItemType Directory -Path $nodeCache -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $nodeHome "node.exe") -Destination $nodeCache -Force
    if (Test-Path -LiteralPath $nodeLicense -PathType Leaf) {
      Copy-Item -LiteralPath $nodeLicense -Destination $nodeCache -Force
    }
  }

  $requiredPayload = @(
    "public\app.js",
    "runtime\node\node.exe",
    "runtime\native\TicoGemini.Core.dll",
    "runtime\native\libusb0.dll",
    "runtime\ffmpeg\ffmpeg.exe",
    "runtime\ffmpeg\ffprobe.exe",
    "msys64\ucrt64\bin\ideviceinstaller.exe",
    "msys64\ucrt64\bin\libimobiledevice-1.0.dll",
    "node_modules\express\package.json",
    "node_modules\tsx\dist\cli.mjs",
    "node_modules\@koromix\koffi-win32-x64\win32_x64\koffi.node",
    "node_modules\tsx\node_modules\@esbuild\win32-x64\esbuild.exe"
  )
  foreach ($relativePath in $requiredPayload) {
    if (-not (Test-Path -LiteralPath (Join-Path $packageRoot $relativePath) -PathType Leaf)) {
      throw "发布包缺少：$relativePath"
    }
  }
  $forbidden = Get-ChildItem -LiteralPath $packageRoot -Recurse -File | Where-Object {
    $_.Extension -eq ".log" -or $_.FullName -like "*\recording\*"
  }
  if ($forbidden) { throw "发布包包含不应分发的文件：$($forbidden.FullName -join ', ')" }

  Compress-Archive -LiteralPath $packageRoot -DestinationPath $archivePath -Force
  $archive = Get-Item -LiteralPath $archivePath
  [pscustomobject]@{
    Package = $archive.FullName
    SizeMB = [math]::Round($archive.Length / 1MB, 1)
    NodeVersion = $resolvedNodeVersion
    Redist = if ($redistIncluded.Count -gt 0) { $redistIncluded -join ", " } else { "(未包含)" }
  }
} finally {
  if (Test-Path -LiteralPath $work) {
    Remove-Item -LiteralPath $work -Recurse -Force
  }
}
