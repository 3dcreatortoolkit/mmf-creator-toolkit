$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot

Push-Location $projectRoot
try {
    npm run build
    if ($LASTEXITCODE -ne 0) { throw 'The extension build failed.' }

    $version = (Get-Content 'dist/manifest.json' -Raw | ConvertFrom-Json).version
    New-Item -ItemType Directory -Path 'releases' -Force | Out-Null
    $archive = Join-Path $projectRoot "releases/3d-creator-toolkit-$version.zip"
    Compress-Archive -Path 'dist/*' -DestinationPath $archive -Force
    Write-Host "Created $archive"
} finally {
    Pop-Location
}
