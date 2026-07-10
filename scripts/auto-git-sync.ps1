[CmdletBinding()]
param(
    [ValidateSet("start", "stop", "status", "run-once", "worker", "validate")]
    [string]$Action = "status",

    [ValidateRange(1, 1440)]
    [int]$IntervalMinutes = 10
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$GitDirectory = Join-Path $RepoRoot ".git"
$RuntimeDirectory = Join-Path $GitDirectory "auto-git-sync"
$PidFile = Join-Path $RuntimeDirectory "process.json"
$LogFile = Join-Path $RuntimeDirectory "auto-git-sync.log"
$CommitMessagePrefix = "chore: automatic snapshot"

function Initialize-RuntimeDirectory {
    if (-not (Test-Path -LiteralPath $RuntimeDirectory)) {
        New-Item -ItemType Directory -Path $RuntimeDirectory -Force | Out-Null
    }
}

function Write-Log {
    param([Parameter(Mandatory = $true)][string]$Message)

    Initialize-RuntimeDirectory
    $timestamp = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss zzz")
    Add-Content -LiteralPath $LogFile -Value "[$timestamp] $Message" -Encoding UTF8
}

function Invoke-Git {
    param([Parameter(Mandatory = $true)][string[]]$Arguments)

    $output = & git -C $RepoRoot @Arguments 2>&1 | Out-String
    [pscustomobject]@{
        ExitCode = $LASTEXITCODE
        Output = $output.Trim()
    }
}

function Get-WorkerRecord {
    if (-not (Test-Path -LiteralPath $PidFile)) {
        return $null
    }

    try {
        return Get-Content -LiteralPath $PidFile -Raw | ConvertFrom-Json
    }
    catch {
        return $null
    }
}

function Get-LiveWorkerProcess {
    $record = Get-WorkerRecord
    if ($null -eq $record) {
        return $null
    }

    $process = Get-Process -Id ([int]$record.pid) -ErrorAction SilentlyContinue
    if ($null -eq $process) {
        return $null
    }

    try {
        if ($process.StartTime.ToUniversalTime().Ticks -ne [long]$record.startTimeUtcTicks) {
            return $null
        }
    }
    catch {
        return $null
    }

    return $process
}

function Write-CommitSummary {
    param(
        [Parameter(Mandatory = $true)][string]$CommitId,
        [Parameter(Mandatory = $true)][string]$CommitMessage
    )

    $changelogDirectory = Join-Path $RepoRoot "changelog"
    New-Item -ItemType Directory -Path $changelogDirectory -Force | Out-Null
    $summaryPath = Join-Path $changelogDirectory "$CommitId.en.md"
    $summary = ConvertTo-Json -InputObject @($CommitMessage) -Compress
    [System.IO.File]::WriteAllText($summaryPath, $summary + [Environment]::NewLine)
}

function Invoke-SyncCycle {
    $branchResult = Invoke-Git -Arguments @("branch", "--show-current")
    if ($branchResult.ExitCode -ne 0) {
        Write-Log "Cannot determine the current branch: $($branchResult.Output)"
        return
    }

    if ($branchResult.Output -ne "main") {
        Write-Log "Skipped: current branch is '$($branchResult.Output)', expected 'main'."
        return
    }

    $addResult = Invoke-Git -Arguments @("add", "-A")
    if ($addResult.ExitCode -ne 0) {
        Write-Log "git add failed: $($addResult.Output)"
        return
    }

    $diffResult = Invoke-Git -Arguments @("diff", "--cached", "--quiet")
    if ($diffResult.ExitCode -eq 1) {
        $commitMessage = "$CommitMessagePrefix $((Get-Date).ToString('yyyy-MM-dd HH:mm:ss'))"
        $commitResult = Invoke-Git -Arguments @("commit", "-m", $commitMessage)
        if ($commitResult.ExitCode -ne 0) {
            Write-Log "git commit failed: $($commitResult.Output)"
            return
        }

        $commitIdResult = Invoke-Git -Arguments @("rev-parse", "HEAD")
        if ($commitIdResult.ExitCode -eq 0) {
            Write-CommitSummary -CommitId $commitIdResult.Output -CommitMessage $commitMessage
        }
        Write-Log "Created commit: $commitMessage"
    }
    elseif ($diffResult.ExitCode -eq 0) {
        Write-Log "No changes to commit; checking for commits that still need pushing."
    }
    else {
        Write-Log "git diff failed: $($diffResult.Output)"
        return
    }

    $pushResult = Invoke-Git -Arguments @("push", "origin", "main")
    if ($pushResult.ExitCode -ne 0) {
        Write-Log "git push failed; it will be retried next cycle: $($pushResult.Output)"
        return
    }

    Write-Log "origin/main is up to date."
}

function Start-Worker {
    Initialize-RuntimeDirectory
    $existingProcess = Get-LiveWorkerProcess
    if ($null -ne $existingProcess) {
        Write-Output "Auto git sync is already running (PID $($existingProcess.Id))."
        return
    }

    Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
    $quotedScriptPath = '"' + $PSCommandPath.Replace('"', '\"') + '"'
    $argumentList = "-NoProfile -ExecutionPolicy Bypass -File $quotedScriptPath -Action worker -IntervalMinutes $IntervalMinutes"
    $process = Start-Process -FilePath "powershell.exe" -ArgumentList $argumentList -WindowStyle Hidden -PassThru
    $record = [ordered]@{
        pid = $process.Id
        startTimeUtcTicks = $process.StartTime.ToUniversalTime().Ticks
        intervalMinutes = $IntervalMinutes
        startedAt = (Get-Date).ToString("o")
    }
    $record | ConvertTo-Json -Compress | Set-Content -LiteralPath $PidFile -Encoding UTF8
    Write-Output "Auto git sync started (PID $($process.Id), every $IntervalMinutes minutes)."
    Write-Output "Log: $LogFile"
}

function Stop-Worker {
    $process = Get-LiveWorkerProcess
    if ($null -eq $process) {
        Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
        Write-Output "Auto git sync is not running."
        return
    }

    Stop-Process -Id $process.Id
    Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
    Write-Output "Auto git sync stopped (PID $($process.Id))."
}

function Show-Status {
    $process = Get-LiveWorkerProcess
    if ($null -eq $process) {
        Write-Output "Auto git sync is not running."
    }
    else {
        $record = Get-WorkerRecord
        Write-Output "Auto git sync is running (PID $($process.Id), every $($record.intervalMinutes) minutes)."
    }
    Write-Output "Log: $LogFile"
}

function Test-Configuration {
    $gitCommand = Get-Command git -ErrorAction SilentlyContinue
    if ($null -eq $gitCommand) {
        throw "git is not available on PATH."
    }
    if (-not (Test-Path -LiteralPath $GitDirectory)) {
        throw "Not a Git worktree: $RepoRoot"
    }

    $branchResult = Invoke-Git -Arguments @("branch", "--show-current")
    if ($branchResult.ExitCode -ne 0) {
        throw "Cannot read the current Git branch: $($branchResult.Output)"
    }
    if ($branchResult.Output -ne "main") {
        throw "Current branch is '$($branchResult.Output)'; switch to main before starting."
    }

    Write-Output "Configuration is valid for $RepoRoot on branch main."
}

switch ($Action) {
    "start" {
        Test-Configuration
        Start-Worker
    }
    "stop" {
        Stop-Worker
    }
    "status" {
        Show-Status
    }
    "run-once" {
        Test-Configuration
        Invoke-SyncCycle
    }
    "validate" {
        Test-Configuration
    }
    "worker" {
        try {
            Write-Log "Worker started; the first sync will run in $IntervalMinutes minutes."
            while ($true) {
                Start-Sleep -Seconds ($IntervalMinutes * 60)
                Invoke-SyncCycle
            }
        }
        catch {
            Write-Log "Worker stopped after an unexpected error: $($_.Exception.Message)"
            throw
        }
        finally {
            $record = Get-WorkerRecord
            if ($null -ne $record -and [int]$record.pid -eq $PID) {
                Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
            }
        }
    }
}
