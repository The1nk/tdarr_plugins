$path = Get-Content -Raw -Path "path.env"
$path = $path.TrimEnd('\', '/') + '\*.js'

Copy-Item -Path $path -Destination .
