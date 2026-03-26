$path = Get-Content -Raw -Path "path.env"
$path = $path.TrimEnd('\', '/') + '\'

Copy-Item -Path *.js -Destination $path
