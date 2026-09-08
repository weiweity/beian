param(
  [int]$TimeoutMs = 90000,
  [string]$Python = ""
)

$ErrorActionPreference = "Stop"
# Hangzhou freeze: 0.21.45.0 hangzhou-release 34186013159 measured ~63s
# (WINDOWS_ILLUSTRATOR_JSX_SMOKE 04:10:43Z -> WINDOWS_BLENDER_CONTRACT_SMOKE 04:11:46Z).
if (-not $env:RUNNER_TEMP -or -not (Test-Path -LiteralPath $env:RUNNER_TEMP -PathType Container)) {
  throw "RUNNER_TEMP is required; Blender contract smoke must not write customer or repo paths"
}
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
if (-not $Python) { $Python = [string]$env:WB_PYTHON }
if (-not $Python) {
  $Python = Join-Path $Root "apps\web\backend\.venv\Scripts\python.exe"
}
if (-not (Test-Path -LiteralPath $Python -PathType Leaf)) {
  throw "WB_PYTHON is missing; reuse the packaging Python, do not copy generation checks into PowerShell"
}
$Smoke = Join-Path $Root "workers\packaging\tools\blender_contract_smoke.py"
if (-not (Test-Path -LiteralPath $Smoke -PathType Leaf)) {
  throw "blender_contract_smoke.py is missing"
}
$Blender = $env:WB_BLENDER
if (-not $Blender) { $Blender = $env:BLENDER_EXECUTABLE }
$argList = @($Smoke)
if ($Blender) { $argList += @("--blender", $Blender) }

function Quote-ProcessArgument([string]$Value) {
  return '"' + $Value.Replace('"', '\"') + '"'
}

if (-not ("BeianSmokeJob" -as [type])) {
  Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class BeianSmokeJob {
  [DllImport("kernel32", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern IntPtr CreateJobObject(IntPtr attr, string name);
  [DllImport("kernel32", SetLastError = true)]
  public static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint size);
  [DllImport("kernel32", SetLastError = true)]
  public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32", SetLastError = true)]
  public static extern bool TerminateJobObject(IntPtr job, uint exitCode);
  [DllImport("kernel32", SetLastError = true)]
  public static extern bool CloseHandle(IntPtr handle);
  public const int JobObjectExtendedLimitInformation = 9;
  public const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
  [StructLayout(LayoutKind.Sequential)]
  public struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
    public long PerProcessUserTimeLimit;
    public long PerJobUserTimeLimit;
    public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize;
    public UIntPtr MaximumWorkingSetSize;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint PriorityClass;
    public uint SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct IO_COUNTERS {
    public ulong ReadOperationCount;
    public ulong WriteOperationCount;
    public ulong OtherOperationCount;
    public ulong ReadTransferCount;
    public ulong WriteTransferCount;
    public ulong OtherTransferCount;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
    public IO_COUNTERS IoInfo;
    public UIntPtr ProcessMemoryLimit;
    public UIntPtr JobMemoryLimit;
    public UIntPtr PeakProcessMemoryUsed;
    public UIntPtr PeakJobMemoryUsed;
  }
  public static IntPtr CreateKillOnCloseJob() {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) {
      throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    }
    var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
    info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    int size = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
    IntPtr ptr = Marshal.AllocHGlobal(size);
    try {
      Marshal.StructureToPtr(info, ptr, false);
      if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, ptr, (uint)size)) {
        int err = Marshal.GetLastWin32Error();
        CloseHandle(job);
        throw new System.ComponentModel.Win32Exception(err);
      }
    } finally {
      Marshal.FreeHGlobal(ptr);
    }
    return job;
  }
}
"@
}

function Stop-SmokeJob([IntPtr]$Job) {
  if ($Job -eq [IntPtr]::Zero) { return }
  try { [void][BeianSmokeJob]::TerminateJobObject($Job, 1) } catch {}
}

$job = [IntPtr]::Zero
$proc = $null
try {
  $job = [BeianSmokeJob]::CreateKillOnCloseJob()
  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $Python
  $startInfo.Arguments = ($argList | ForEach-Object { Quote-ProcessArgument $_ }) -join " "
  $startInfo.UseShellExecute = $false
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $startInfo.CreateNoWindow = $true
  $startInfo.WorkingDirectory = $Root
  $startInfo.StandardOutputEncoding = [System.Text.Encoding]::UTF8
  $startInfo.StandardErrorEncoding = [System.Text.Encoding]::UTF8
  $startInfo.EnvironmentVariables["RUNNER_TEMP"] = $env:RUNNER_TEMP
  $startInfo.EnvironmentVariables["PYTHONUTF8"] = "1"
  $proc = New-Object System.Diagnostics.Process
  $proc.StartInfo = $startInfo
  if (-not $proc.Start()) { throw "Blender contract smoke did not start" }
  if (-not [BeianSmokeJob]::AssignProcessToJobObject($job, $proc.Handle)) {
    throw "Blender contract smoke failed to join Job Object"
  }
  $stdoutTask = $proc.StandardOutput.ReadToEndAsync()
  $stderrTask = $proc.StandardError.ReadToEndAsync()
  if (-not $proc.WaitForExit($TimeoutMs)) {
    Stop-SmokeJob $job
    if (-not $proc.WaitForExit(5000)) {
      throw "Blender contract smoke timed out and could not be killed"
    }
    throw "Blender contract smoke timed out (Hangzhou-frozen 90s budget)"
  } else {
    $proc.WaitForExit()
  }
  $stdout = [string]$stdoutTask.Result
  $stderr = [string]$stderrTask.Result
  if ($stdout) { Write-Output $stdout.Trim() }
  if ($stderr) { Write-Host $stderr.Trim() }
  $code = [int]$proc.ExitCode
  if ($code -ne 0) {
    throw "Blender contract smoke failed exit=$code"
  }
  Write-Output "WINDOWS_BLENDER_CONTRACT_SMOKE ok"
} finally {
  if ($null -ne $proc) { $proc.Dispose() }
  if ($job -ne [IntPtr]::Zero) {
    try { [void][BeianSmokeJob]::CloseHandle($job) } catch {}
  }
}
