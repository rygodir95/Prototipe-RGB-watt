param([Parameter(Mandatory=$true)][string]$Package)
$ErrorActionPreference = 'Stop'
$Package = (Resolve-Path -LiteralPath $Package).Path
$script = Join-Path $Package 'flash.ps1'

function Check-Run([string]$Port, [bool]$Success, [string]$Message) {
    $output = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $script -DryRun -Port $Port 2>&1
    if (($LASTEXITCODE -eq 0) -ne $Success) { throw "Unexpected exit: $output" }
    if (($output -join "`n") -notmatch $Message) { throw "Missing expected message: $output" }
}

Check-Run 'COM99' $true 'DRY RUN:.*write_flash 0xe000.*boot_app0.bin 0x10000.*firmware.bin'
Check-Run 'invalid-port' $false 'Hibas COM port'
$image = Join-Path $Package 'firmware.bin'
$original = [IO.File]::ReadAllBytes($image)
try {
    [IO.File]::WriteAllBytes($image, [byte[]]@(0, 1, 2))
    Check-Run 'COM99' $false 'Hianyzo vagy serult fajl'
} finally { [IO.File]::WriteAllBytes($image, $original) }
$manifestPath = Join-Path $Package 'manifest.json'
$originalManifest = [IO.File]::ReadAllBytes($manifestPath)
try {
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    $manifest.appOffset = '0x0'
    $manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $manifestPath
    Check-Run 'COM99' $false 'Nem tamogatott'
} finally { [IO.File]::WriteAllBytes($manifestPath, $originalManifest) }
& (Join-Path $Package 'esptool.exe') version
if ($LASTEXITCODE -ne 0) { throw 'Bundled esptool cannot start' }
Write-Host 'Windows flash smoke tests passed; no device was written.'
