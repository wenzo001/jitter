<#
.SYNOPSIS
    启动一个与生产实例完全隔离的 Jitter 开发实例。

.DESCRIPTION
    开发实例和生产实例在四个地方互相隔离，互不影响：

    | 共享状态         | 生产实例                      | 开发实例                     |
    | ---------------- | ----------------------------- | ---------------------------- |
    | 配置 / 运行时文件 | %APPDATA%\Jitter              | %APPDATA%\Jitter-dev         |
    | 开机自启注册项   | Startup\Jitter.cmd            | Startup\Jitter-dev.cmd      |
    | 单实例互斥体     | JitterSingleInstance-prod     | JitterSingleInstance-dev    |
    | 数据库 / 日志     | 安装目录下的 data\            | .tmp\dev\                    |

    所以可以和生产实例同时跑：改代码、试功能、清日志都不会碰到生产数据。

.PARAMETER Port
    开发实例的端口。默认 3111。

.PARAMETER DbPath
    开发实例的数据库路径。默认仓库内的 .tmp\dev\app.db。

.PARAMETER Instance
    实例名。默认 dev。

.EXAMPLE
    .\scripts\dev-instance.ps1
    启动开发实例，浏览器打开 http://127.0.0.1:3111

.EXAMPLE
    .\scripts\dev-instance.ps1 -Instance test -Port 3112
    再开一个名叫 test 的实例
#>
[CmdletBinding()]
param(
    [int]$Port = 3111,
    [string]$DbPath = '',
    [string]$Instance = 'dev',
    [switch]$Foreground
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $DbPath) {
    $DbPath = Join-Path $repoRoot '.tmp\dev\app.db'
}

$exe = Join-Path $repoRoot 'rust\target\release\jitter.exe'
if (-not (Test-Path $exe)) {
    Write-Host "找不到开发版可执行文件：$exe" -ForegroundColor Red
    Write-Host "请先编译：cd rust; cargo build --release -p jitter-app --jobs 1" -ForegroundColor Yellow
    exit 1
}

New-Item -ItemType Directory -Force (Split-Path -Parent $DbPath) | Out-Null

# 实例隔离的关键环境变量：配置目录、自启项、互斥体都按它派生。
$env:JITTER_INSTANCE = $Instance
# 数据库独立于生产实例。
$env:JITTER_DB_PATH = $DbPath
# 端口独立。
$env:PORT = "$Port"
# 不用仓库根的 jitter.config.json（它会指向 .tmp/dev，但端口与路径是给容器用的）。
$env:JITTER_CONFIG = $null

if ($Foreground) {
    & $exe
    exit $LASTEXITCODE
}

$process = Start-Process -FilePath $exe -WorkingDirectory $repoRoot -WindowStyle Hidden -PassThru
Start-Sleep -Seconds 2

try {
    $health = Invoke-RestMethod "http://127.0.0.1:$Port/api/health" -TimeoutSec 5
    Write-Host "开发实例已启动" -ForegroundColor Green
    Write-Host ("  实例名    : {0}" -f $Instance)
    Write-Host ("  地址      : http://127.0.0.1:{0}" -f $Port)
    Write-Host ("  版本      : {0}" -f $health.version)
    Write-Host ("  数据库    : {0}" -f $health.dbPath)
    Write-Host ("  运行日志  : {0}" -f $health.logDir)
    Write-Host ("  进程 ID   : {0}" -f $process.Id)
    Write-Host ""
    Write-Host ("生产实例不受影响：配置目录、自启项、互斥体、数据库都是独立的。")
} catch {
    Write-Host "启动后健康检查失败（端口可能被占用）：$($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
