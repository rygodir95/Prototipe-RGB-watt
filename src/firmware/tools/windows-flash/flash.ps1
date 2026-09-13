param([string]$Port, [switch]$DryRun)
$ErrorActionPreference = 'Stop'
try {
    $manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'manifest.json') -Raw | ConvertFrom-Json
    # This updater is only for the existing classic ESP32 min_spiffs layout.
    if ($manifest.chip -ne 'esp32' -or $manifest.appOffset -ne '0x10000' -or $manifest.otaOffset -ne '0xe000') {
        throw 'Nem tamogatott firmware-csomag / particios kiosztas.'
    }
    foreach ($name in @('firmware.bin', 'boot_app0.bin', 'esptool.exe')) {
        $path = Join-Path $PSScriptRoot $name
        $expected = $manifest.hashes.$name
        if (-not $expected -or (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -ne $expected) {
            throw "Hianyzo vagy serult fajl: $name. Csomagold ki ujra a teljes ZIP-et."
        }
    }
    if (-not $DryRun -or -not $Port) {
        $ports = @([System.IO.Ports.SerialPort]::GetPortNames() | Sort-Object)
        if ($ports.Count -eq 0) { throw 'Nincs soros port. Ellenorizd az USB adatkabelt es az USB-soros drivert.' }
        if (-not $Port) {
            if ($ports.Count -eq 1) { $Port = $ports[0] }
            else {
                Write-Host 'Tobb soros eszkoz talalhato:'
                Get-CimInstance Win32_PnPEntity | Where-Object { $_.Name -match '\(COM\d+\)' } | ForEach-Object { Write-Host $_.Name }
                Write-Host ($ports -join ', ')
                $Port = (Read-Host 'Az ESP32 portja (pl. COM3)').Trim()
            }
        }
        if ($Port -notin $ports) { throw 'A megadott soros port nem talalhato.' }
    }
    if ($Port -notmatch '^COM[1-9][0-9]*$') { throw 'Hibas COM port.' }
    $tool = Join-Path $PSScriptRoot 'esptool.exe'
    $arguments = @('--chip', 'esp32', '--port', $Port, '--baud', '115200',
        '--before', 'default_reset', '--after', 'hard_reset', 'write_flash',
        '0xe000', (Join-Path $PSScriptRoot 'boot_app0.bin'),
        '0x10000', (Join-Path $PSScriptRoot 'firmware.bin'))
    Write-Host "ZoneGlow frissites - $Port - commit $($manifest.commit)"
    Write-Host 'A mentett beallitasok (NVS) megmaradnak.'
    if ($DryRun) {
        Write-Host ('DRY RUN: ' + ($arguments -join ' '))
        exit 0
    }
    Write-Host 'Ha Connecting... utan elakad: tartsd nyomva a BOOT gombot a kapcsolodasig.'
    & $tool @arguments
    if ($LASTEXITCODE -ne 0) {
        throw 'A frissites nem sikerult. Zard be a soros monitort; ellenorizd a kabelt/portot, majd inditsd ujra a flash.bat-ot.'
    }
    Write-Host 'SIKERES FRISSITES. Az ESP32 ujraindult.' -ForegroundColor Green
    exit 0
} catch {
    Write-Host "HIBA: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
