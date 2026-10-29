# Copies the plugins from the Tdarr plugins folder named in path.env into plugins/.
$path = (Get-Content -Raw -Path (Join-Path $PSScriptRoot 'path.env')).Trim().TrimEnd('\', '/') + '\*.js'
Copy-Item -Path $path -Destination (Join-Path $PSScriptRoot 'plugins')
