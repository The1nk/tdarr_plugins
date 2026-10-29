# Copies the plugins to the Tdarr plugins folder named in path.env.
$path = (Get-Content -Raw -Path (Join-Path $PSScriptRoot 'path.env')).Trim().TrimEnd('\', '/') + '\'
Copy-Item -Path (Join-Path $PSScriptRoot 'plugins\*.js') -Destination $path
