[CmdletBinding()]
param(
    [string]$Repository = "https://github.com/LiTriLaDuaNhanVien/omp-9router-plugin.git",
    [string]$Branch = "main"
)

$ErrorActionPreference = "Stop"

foreach ($command in @("omp", "git")) {
    if (-not (Get-Command $command -ErrorAction SilentlyContinue)) {
        throw "'$command' was not found in PATH. Install it, then run this script again."
    }
}

$agentDir = (& omp config path).Trim()
if ([string]::IsNullOrWhiteSpace($agentDir)) {
    throw "'omp config path' returned an empty agent directory."
}

$extensionsDir = Join-Path $agentDir "extensions"
$pluginDir = Join-Path $extensionsDir "9router"
New-Item -ItemType Directory -Path $extensionsDir -Force | Out-Null

if (Test-Path (Join-Path $pluginDir ".git")) {
    & git -C $pluginDir pull --ff-only origin $Branch
    if ($LASTEXITCODE -ne 0) {
        throw "Could not update the existing 9Router plugin checkout."
    }
} elseif (Test-Path $pluginDir) {
    throw "'$pluginDir' exists but is not a Git checkout. Move or remove it, then rerun this script."
} else {
    & git clone --depth 1 --branch $Branch $Repository $pluginDir
    if ($LASTEXITCODE -ne 0) {
        throw "Could not clone the 9Router plugin. Check the repository URL and your Git/network configuration."
    }
}

$entry = Join-Path $pluginDir "index.ts"
if (-not (Test-Path $entry -PathType Leaf)) {
    throw "Installation completed but '$entry' is missing."
}

Write-Host "9Router plugin installed at $pluginDir"
Write-Host "Fully restart omp, then run: /login 9router"
