param(
    [string]$ConfigPath,
    [string]$ServerName,
    [switch]$SkipDependencies,
    [switch]$EnableCodeChangeEvents
)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$node = (Get-Command node.exe -ErrorAction Stop).Source
$version = [version]((& $node --version).TrimStart('v'))
if ($version.Major -notin @(22, 24) -or ($version.Major -eq 22 -and $version -lt [version]'22.22.1')) { throw 'Use Node.js 22.22.1+ or Node.js 24 LTS for this build.' }
if (-not $ConfigPath) {
    $classic = Join-Path $env:APPDATA 'Claude\claude_desktop_config.json'
    $store = Join-Path $env:LOCALAPPDATA 'Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\claude_desktop_config.json'
    if (Test-Path -LiteralPath $classic) { $ConfigPath = $classic }
    elseif (Test-Path -LiteralPath $store) { $ConfigPath = $store }
    else { throw 'No existing Claude configuration found. Pass -ConfigPath with its full path.' }
}
$config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
if (-not $config.mcpServers) { throw 'No MCP entries found. Configure your SAP connection first, then rerun this installer.' }
$names = @($config.mcpServers.PSObject.Properties.Name)
if (-not $ServerName) {
    Write-Host ('Existing MCP entries: ' + ($names -join ', '))
    $ServerName = Read-Host 'Name of the existing ARC-1 SAP entry to upgrade'
}
if ($ServerName -notin $names) { throw 'The selected MCP entry does not exist.' }
$entry = $config.mcpServers.$ServerName
if (-not $entry.env.SAP_URL -or -not $entry.env.SAP_CLIENT) {
    throw 'This installer requires SAP_URL and SAP_CLIENT in the entry env. Move existing SAP CLI flags into equivalent env settings first; do not discard them.'
}
# Fail closed if arguments contain connection/policy flags that replacing the launcher would discard.
if (@($entry.args | Where-Object { $_ -match '^--(?!yes$)' }).Count) {
    throw 'The entry uses CLI flags. Move those options into their documented environment equivalents before installing.'
}
if (-not $SkipDependencies) {
    Push-Location $root
    try {
        & npm.cmd ci --omit=dev --ignore-scripts --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed; Claude configuration was not changed.' }
    } finally { Pop-Location }
}
if (-not (Test-Path -LiteralPath (Join-Path $root 'dist\index.js'))) { throw 'Compiled runtime is missing.' }
$backup = "$ConfigPath.arc1-backup-$(Get-Date -Format 'yyyyMMdd-HHmmss-fff')"
Copy-Item -LiteralPath $ConfigPath -Destination $backup
$entry.command = $node
$entry.args = @((Join-Path $root 'bin\arc1.js'))
# This workflow is local. Preserve SAP credentials, client, data restrictions and existing write flags.
$entry.env | Add-Member -NotePropertyName ARC1_CACHE -NotePropertyValue 'memory' -Force
$entry.env | Add-Member -NotePropertyName SAP_TRANSPORT -NotePropertyValue 'stdio' -Force
$entry.env | Add-Member -NotePropertyName ARC1_SERVER_NAME -NotePropertyValue 'arc-1-customizing-1.5.1-customizing.2' -Force
if ($EnableCodeChangeEvents) {
    $entry.env | Add-Member -NotePropertyName ARC1_CODE_CHANGE_EVENTS -NotePropertyValue 'true' -Force
}
$json = $config | ConvertTo-Json -Depth 100
[IO.File]::WriteAllText($ConfigPath, $json, [Text.UTF8Encoding]::new($false))
Write-Host 'Pinned ARC-1 customising build installed. Fully quit and reopen Claude.'
Write-Host "Backup: $backup"
Write-Host 'SAP_ALLOW_DATA_PREVIEW must already be true for SAPCustomizing. No read/write permissions were expanded.'
Write-Host 'Keep this extracted folder in place: Claude now launches its exact build.'
