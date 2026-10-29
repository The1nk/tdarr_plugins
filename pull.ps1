# Copies the plugins from the Tdarr plugins folder named in path.env into plugins/.
$ErrorActionPreference = 'Stop'
$envFile = Join-Path $PSScriptRoot 'path.env'
if (-not (Test-Path -LiteralPath $envFile -PathType Leaf)) { throw 'path.env not found next to this script' }
$raw = Get-Content -Raw -LiteralPath $envFile
if ([string]::IsNullOrWhiteSpace($raw)) { throw 'path.env is empty' }
$dir = $raw.Trim().TrimEnd('\', '/') + '\'
if (-not (Test-Path -LiteralPath $dir -PathType Container)) { throw "Tdarr plugins folder not found: $dir" }
Copy-Item -Path ($dir + '*.js') -Destination (Join-Path $PSScriptRoot 'plugins')
