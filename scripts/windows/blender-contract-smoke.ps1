param(
  [int]$TimeoutMs = 90000,
  [string]$Python = ""
)

$ErrorActionPreference = "Stop"
# Hangzhou freeze: 0.21.45.0 hangzhou-release 34186013159 measured ~63s
# (WINDOWS_ILLUSTRATOR_JSX_SMOKE 04:10:43Z -> WINDOWS_BLENDER_CONTRACT_SMOKE 04:11:46Z).
# CreateProcessW uses PROC_THREAD_ATTRIBUTE_JOB_LIST and CREATE_SUSPENDED so a
# venvlauncher cannot spawn outside the Job, and a crash before ResumeThread
# cannot orphan an unassigned process. Kill the tree via the Job.
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
using System.Text;
public static class BeianSmokeJob {
  [DllImport("kernel32", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern IntPtr CreateJobObject(IntPtr attr, string name);
  [DllImport("kernel32", SetLastError = true)]
  public static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint size);
  [DllImport("kernel32", SetLastError = true)]
  public static extern bool TerminateJobObject(IntPtr job, uint exitCode);
  [DllImport("kernel32", SetLastError = true)]
  public static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CreateProcess(
    string applicationName,
    StringBuilder commandLine,
    IntPtr processAttributes,
    IntPtr threadAttributes,
    bool inheritHandles,
    uint creationFlags,
    IntPtr environment,
    string currentDirectory,
    ref STARTUPINFOEX startupInfo,
    out PROCESS_INFORMATION processInformation);
  [DllImport("kernel32", SetLastError = true)]
  public static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32", SetLastError = true)]
  public static extern bool TerminateProcess(IntPtr process, uint exitCode);
  [DllImport("kernel32", SetLastError = true)]
  public static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32", SetLastError = true)]
  public static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
  [DllImport("kernel32", SetLastError = true)]
  public static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);
  [DllImport("kernel32", SetLastError = true)]
  public static extern bool InitializeProcThreadAttributeList(IntPtr list, uint count, uint flags, ref IntPtr size);
  [DllImport("kernel32", SetLastError = true)]
  public static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returnSize);
  [DllImport("kernel32", SetLastError = true)]
  public static extern void DeleteProcThreadAttributeList(IntPtr list);
  public const int JobObjectExtendedLimitInformation = 9;
  public const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
  public const uint CREATE_SUSPENDED = 0x00000004;
  public const uint CREATE_NO_WINDOW = 0x08000000;
  public const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
  public const uint PROC_THREAD_ATTRIBUTE_JOB_LIST = 0x0002000D;
  public const uint WAIT_OBJECT_0 = 0;
  public const uint WAIT_TIMEOUT = 258;
  public const uint ResumeFailed = 0xFFFFFFFF;
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
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct STARTUPINFO {
    public int cb;
    public string lpReserved;
    public string lpDesktop;
    public string lpTitle;
    public int dwX;
    public int dwY;
    public int dwXSize;
    public int dwYSize;
    public int dwXCountChars;
    public int dwYCountChars;
    public int dwFillAttribute;
    public int dwFlags;
    public short wShowWindow;
    public short cbReserved2;
    public IntPtr lpReserved2;
    public IntPtr hStdInput;
    public IntPtr hStdOutput;
    public IntPtr hStdError;
  }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct STARTUPINFOEX {
    public STARTUPINFO StartupInfo;
    public IntPtr lpAttributeList;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct PROCESS_INFORMATION {
    public IntPtr hProcess;
    public IntPtr hThread;
    public int dwProcessId;
    public int dwThreadId;
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
  public static uint RequireExitCode(IntPtr process) {
    uint code;
    if (!GetExitCodeProcess(process, out code)) {
      throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    }
    return code;
  }
  public static PROCESS_INFORMATION StartSuspendedInJob(string applicationName, string commandLine, string currentDirectory, IntPtr job) {
    IntPtr attrSize = IntPtr.Zero;
    InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref attrSize);
    if (attrSize == IntPtr.Zero) {
      throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "Job attribute list size unavailable");
    }
    IntPtr attrList = Marshal.AllocHGlobal((int)attrSize);
    IntPtr jobList = Marshal.AllocHGlobal(IntPtr.Size);
    PROCESS_INFORMATION processInformation = new PROCESS_INFORMATION();
    bool created = false;
    bool attrReady = false;
    try {
      if (!InitializeProcThreadAttributeList(attrList, 1, 0, ref attrSize)) {
        throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "Job attribute list init failed");
      }
      attrReady = true;
      Marshal.WriteIntPtr(jobList, job);
      if (!UpdateProcThreadAttribute(attrList, 0, (IntPtr)PROC_THREAD_ATTRIBUTE_JOB_LIST, jobList, (IntPtr)IntPtr.Size, IntPtr.Zero, IntPtr.Zero)) {
        throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "PROC_THREAD_ATTRIBUTE_JOB_LIST failed");
      }
      var startup = new STARTUPINFOEX();
      startup.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
      startup.lpAttributeList = attrList;
      var writableCommandLine = new StringBuilder(commandLine);
      if (!CreateProcess(
          applicationName,
          writableCommandLine,
          IntPtr.Zero,
          IntPtr.Zero,
          true,
          CREATE_SUSPENDED | CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT,
          IntPtr.Zero,
          currentDirectory,
          ref startup,
          out processInformation)) {
        throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "CreateProcess suspended in Job failed");
      }
      created = true;
      bool inJob;
      if (!IsProcessInJob(processInformation.hProcess, job, out inJob)) {
        throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "Blender contract smoke failed to join Job Object");
      }
      if (!inJob) {
        throw new InvalidOperationException("Blender contract smoke failed to join Job Object");
      }
      return processInformation;
    } catch {
      if (created) {
        TerminateProcess(processInformation.hProcess, 1);
        if (processInformation.hThread != IntPtr.Zero) { CloseHandle(processInformation.hThread); }
        if (processInformation.hProcess != IntPtr.Zero) { CloseHandle(processInformation.hProcess); }
      }
      throw;
    } finally {
      if (attrList != IntPtr.Zero) {
        if (attrReady) {
          try { DeleteProcThreadAttributeList(attrList); } catch {}
        }
        Marshal.FreeHGlobal(attrList);
      }
      if (jobList != IntPtr.Zero) { Marshal.FreeHGlobal(jobList); }
    }
  }
}
"@
}

function Stop-SmokeJob([IntPtr]$Job) {
  if ($Job -eq [IntPtr]::Zero) { return }
  try { [void][BeianSmokeJob]::TerminateJobObject($Job, 1) } catch {}
}

$job = [IntPtr]::Zero
$procHandle = [IntPtr]::Zero
$threadHandle = [IntPtr]::Zero
$ok = $false
try {
  $job = [BeianSmokeJob]::CreateKillOnCloseJob()
  $env:PYTHONUTF8 = "1"
  $commandLine = (Quote-ProcessArgument $Python)
  foreach ($arg in $argList) {
    $commandLine += " " + (Quote-ProcessArgument $arg)
  }
  $processInformation = [BeianSmokeJob]::StartSuspendedInJob($Python, $commandLine, $Root, $job)
  $procHandle = $processInformation.hProcess
  $threadHandle = $processInformation.hThread
  if ($procHandle -eq [IntPtr]::Zero) { throw "Blender contract smoke did not start" }
  if ([BeianSmokeJob]::ResumeThread($threadHandle) -eq [BeianSmokeJob]::ResumeFailed) {
    throw "Blender contract smoke failed to resume"
  }
  [void][BeianSmokeJob]::CloseHandle($threadHandle)
  $threadHandle = [IntPtr]::Zero
  $wait = [BeianSmokeJob]::WaitForSingleObject($procHandle, [uint32]$TimeoutMs)
  if ($wait -eq [BeianSmokeJob]::WAIT_TIMEOUT) {
    Stop-SmokeJob $job
    $wait = [BeianSmokeJob]::WaitForSingleObject($procHandle, 5000)
    if ($wait -eq [BeianSmokeJob]::WAIT_TIMEOUT) {
      throw "Blender contract smoke timed out and could not be killed"
    }
    throw "Blender contract smoke timed out (Hangzhou-frozen 90s budget)"
  }
  if ($wait -ne [BeianSmokeJob]::WAIT_OBJECT_0) {
    throw "Blender contract smoke wait failed"
  }
  $code = [int][BeianSmokeJob]::RequireExitCode($procHandle)
  if ($code -ne 0) {
    throw "Blender contract smoke failed exit=$code"
  }
  Write-Output "WINDOWS_BLENDER_CONTRACT_SMOKE ok"
  $ok = $true
} finally {
  if (-not $ok) {
    Stop-SmokeJob $job
    if ($procHandle -ne [IntPtr]::Zero) {
      try { [void][BeianSmokeJob]::TerminateProcess($procHandle, 1) } catch {}
    }
  }
  if ($threadHandle -ne [IntPtr]::Zero) {
    try { [void][BeianSmokeJob]::CloseHandle($threadHandle) } catch {}
  }
  if ($procHandle -ne [IntPtr]::Zero) {
    try { [void][BeianSmokeJob]::CloseHandle($procHandle) } catch {}
  }
  if ($job -ne [IntPtr]::Zero) {
    try { [void][BeianSmokeJob]::CloseHandle($job) } catch {}
  }
}
