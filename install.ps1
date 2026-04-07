# Rollabot — Windows Install Script
# Run from the repo root: .\install.ps1

$ErrorActionPreference = "Stop"

$configDir   = "$env:USERPROFILE\.config\opencode"
$pluginDir   = "$configDir\plugins\rollabot"
$agentsDir   = "$configDir\agents"
$commandsDir = "$configDir\commands"
$configFile  = "$configDir\opencode.json"

Write-Host "[Rollabot] Installing..."

# Create dirs
New-Item -ItemType Directory -Force -Path $pluginDir   | Out-Null
New-Item -ItemType Directory -Force -Path $agentsDir   | Out-Null
New-Item -ItemType Directory -Force -Path $commandsDir | Out-Null

# Copy plugin files
Copy-Item -Path "index.ts"    -Destination "$pluginDir\index.ts"    -Force
Copy-Item -Path "reminder.md" -Destination "$pluginDir\reminder.md" -Force
Write-Host "[Rollabot] Plugin files copied to $pluginDir"

# Copy agents
Copy-Item -Path "agents\*.md" -Destination "$agentsDir\" -Force
Write-Host "[Rollabot] Agent files copied to $agentsDir"

# Copy commands
Copy-Item -Path "commands\*.md" -Destination "$commandsDir\" -Force
Write-Host "[Rollabot] Commands copied to $commandsDir"

# Register plugin in opencode.json
$pluginPath = ($pluginDir + "\index.ts") -replace "\\", "/"

if (Test-Path $configFile) {
    $config = Get-Content $configFile -Raw | ConvertFrom-Json
    if (-not $config.plugin) { $config | Add-Member -MemberType NoteProperty -Name "plugin" -Value @() }
    if ($config.plugin -notcontains $pluginPath) {
        $config.plugin += $pluginPath
        $config | ConvertTo-Json -Depth 10 | Set-Content $configFile
        Write-Host "[Rollabot] Registered in opencode.json"
    } else {
        Write-Host "[Rollabot] Already registered in opencode.json"
    }
} else {
    Write-Warning "opencode.json not found at $configFile — add the plugin manually:"
    Write-Host "  `"plugin`": [`"$pluginPath`"]"
}

Write-Host "[Rollabot] Done. Restart opencode."
