# Copies the plugins to the Tdarr plugins folder named in path.env.
$ErrorActionPreference = 'Stop'
$envFile = Join-Path $PSScriptRoot 'path.env'
if (-not (Test-Path -LiteralPath $envFile -PathType Leaf)) { throw 'path.env not found next to this script' }
$raw = Get-Content -Raw -LiteralPath $envFile
if ([string]::IsNullOrWhiteSpace($raw)) { throw 'path.env is empty' }
$path = $raw.Trim().TrimEnd('\', '/') + '\'
if (-not (Test-Path -LiteralPath $path -PathType Container)) { throw "Tdarr plugins folder not found: $path" }
Copy-Item -Path (Join-Path $PSScriptRoot 'plugins\*.js') -Destination $path
