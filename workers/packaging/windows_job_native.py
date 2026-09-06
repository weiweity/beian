"""Windows 10+ owned Job Object backend; no PID-based termination fallback.

CreateProcessW uses JOB_LIST atomically AND starts suspended. The non-inherited
job handle has KILL_ON_JOB_CLOSE before creation; even a supervisor crash before
ResumeThread cannot orphan an unassigned process. HANDLE_LIST inherits only the
three pipes, never the job handle. Production remains gated on native evidence.
"""
from __future__ import annotations

import ctypes as c
import os
import subprocess
from contextlib import contextmanager

DWORD = c.c_uint32
WORD = c.c_uint16
HANDLE = c.c_void_p
SIZE_T = c.c_size_t
BOOL = c.c_int32


class WindowsJobError(RuntimeError):
    pass


class BasicLimit(c.Structure):
    _fields_ = [("process_time", c.c_int64), ("job_time", c.c_int64), ("flags", DWORD),
                ("min_working_set", SIZE_T), ("max_working_set", SIZE_T),
                ("active_limit", DWORD), ("affinity", SIZE_T), ("priority", DWORD), ("scheduling", DWORD)]


class IoCounters(c.Structure):
    _fields_ = [(name, c.c_uint64) for name in ("read_ops", "write_ops", "other_ops", "read_bytes", "write_bytes", "other_bytes")]


class ExtendedLimit(c.Structure):
    _fields_ = [("basic", BasicLimit), ("io", IoCounters), ("process_memory", SIZE_T),
                ("job_memory", SIZE_T), ("peak_process_memory", SIZE_T), ("peak_job_memory", SIZE_T)]


class Accounting(c.Structure):
    _fields_ = [("user_time", c.c_int64), ("kernel_time", c.c_int64),
                ("period_user_time", c.c_int64), ("period_kernel_time", c.c_int64),
                ("page_faults", DWORD), ("total", DWORD), ("active", DWORD), ("terminated", DWORD)]


class StartupInfo(c.Structure):
    _fields_ = [("cb", DWORD), ("reserved", c.c_wchar_p), ("desktop", c.c_wchar_p), ("title", c.c_wchar_p),
                *[(name, DWORD) for name in ("x", "y", "xsize", "ysize", "xchars", "ychars", "fill", "flags")],
                ("show", WORD), ("reserved_bytes", WORD), ("reserved_ptr", HANDLE),
                ("stdin", HANDLE), ("stdout", HANDLE), ("stderr", HANDLE)]


class StartupInfoEx(c.Structure):
    _fields_ = [("startup", StartupInfo), ("attributes", HANDLE)]


class ProcessInfo(c.Structure):
    _fields_ = [("process", HANDLE), ("thread", HANDLE), ("pid", DWORD), ("tid", DWORD)]


class CompletionPort(c.Structure):
    _fields_ = [("key", HANDLE), ("port", HANDLE)]


class NativeWindowsJobs:
    def __init__(self):
        if os.name != "nt":
            raise WindowsJobError("process_containment_unavailable")
        self.api = c.WinDLL("kernel32", use_last_error=True)
        signatures = {
            "CreateJobObjectW": (HANDLE, [HANDLE, c.c_wchar_p]),
            "OpenJobObjectW": (HANDLE, [DWORD, BOOL, c.c_wchar_p]),
            "SetInformationJobObject": (BOOL, [HANDLE, c.c_int, HANDLE, DWORD]),
            "QueryInformationJobObject": (BOOL, [HANDLE, c.c_int, HANDLE, DWORD, HANDLE]),
            "TerminateJobObject": (BOOL, [HANDLE, c.c_uint]),
            "CloseHandle": (BOOL, [HANDLE]),
            "InitializeProcThreadAttributeList": (BOOL, [HANDLE, DWORD, DWORD, c.POINTER(SIZE_T)]),
            "UpdateProcThreadAttribute": (BOOL, [HANDLE, DWORD, SIZE_T, HANDLE, SIZE_T, HANDLE, HANDLE]),
            "DeleteProcThreadAttributeList": (None, [HANDLE]),
            "CreateProcessW": (BOOL, [c.c_wchar_p, c.c_wchar_p, HANDLE, HANDLE, BOOL, DWORD,
                                     HANDLE, c.c_wchar_p, HANDLE, c.POINTER(ProcessInfo)]),
            "IsProcessInJob": (BOOL, [HANDLE, HANDLE, c.POINTER(BOOL)]),
            "ResumeThread": (DWORD, [HANDLE]),
            "TerminateProcess": (BOOL, [HANDLE, c.c_uint]),
            "WaitForSingleObject": (DWORD, [HANDLE, DWORD]),
            "GetExitCodeProcess": (BOOL, [HANDLE, c.POINTER(DWORD)]),
            "GetCurrentProcess": (HANDLE, []),
            "CreateIoCompletionPort": (HANDLE, [HANDLE, HANDLE, SIZE_T, DWORD]),
            "GetQueuedCompletionStatus": (BOOL, [HANDLE, c.POINTER(DWORD), c.POINTER(SIZE_T), c.POINTER(HANDLE), DWORD]),
        }
        for name, (result, args) in signatures.items():
            function = getattr(self.api, name)
            function.restype, function.argtypes = result, args

    @staticmethod
    def require(value, cause):
        if not value:
            raise WindowsJobError(cause)
        return value

    def create(self, name: str, memory_bytes: int):
        c.set_last_error(0)
        handle = self.require(self.api.CreateJobObjectW(None, name), "job_create_failed")
        if c.get_last_error() == 183:  # ERROR_ALREADY_EXISTS: never adopt somebody else's container.
            self.api.CloseHandle(handle)
            raise WindowsJobError("job_name_collision")
        port = None
        try:
            limits = ExtendedLimit()
            limits.basic.flags = 0x2000 | 0x200  # KILL_ON_JOB_CLOSE | JOB_MEMORY; no breakaway flags.
            limits.job_memory = memory_bytes
            self.require(self.api.SetInformationJobObject(handle, 9, c.byref(limits), c.sizeof(limits)), "job_limits_failed")
            port = self.require(self.api.CreateIoCompletionPort(HANDLE(-1), None, 0, 1), "job_completion_failed")
            association = CompletionPort(1, port)
            self.require(self.api.SetInformationJobObject(handle, 7, c.byref(association), c.sizeof(association)), "job_completion_failed")
            return {"handle": handle, "port": port}
        except BaseException:
            if port:
                self.api.CloseHandle(port)
            self.api.CloseHandle(handle)
            raise

    def open(self, name: str):
        handle = self.api.OpenJobObjectW(0x0004 | 0x0008, False, name)  # QUERY | TERMINATE
        if not handle:
            if c.get_last_error() == 2:
                return None
            raise WindowsJobError("job_recovery_unknown")
        return {"handle": handle, "port": None}

    @contextmanager
    def attributes(self, job, pipes):
        size = SIZE_T()
        self.api.InitializeProcThreadAttributeList(None, 2, 0, c.byref(size))
        if not 0 < size.value <= 65536:
            raise WindowsJobError("job_attributes_unavailable")
        storage = c.create_string_buffer(size.value)
        self.require(self.api.InitializeProcThreadAttributeList(storage, 2, 0, c.byref(size)), "job_attributes_unavailable")
        try:
            jobs = (HANDLE * 1)(job["handle"])
            inherited = (HANDLE * len(pipes))(*pipes)
            # PROC_THREAD_ATTRIBUTE_JOB_LIST = INPUT | 13; HANDLE_LIST = INPUT | 2.
            self.require(self.api.UpdateProcThreadAttribute(storage, 0, 0x2000D, jobs, c.sizeof(jobs), None, None), "job_atomic_assignment_unavailable")
            self.require(self.api.UpdateProcThreadAttribute(storage, 0, 0x20002, inherited, c.sizeof(inherited), None, None), "job_handle_list_failed")
            yield c.cast(storage, HANDLE)
        finally:
            self.api.DeleteProcThreadAttributeList(storage)

    def launch_in_job(self, job, command: list[str], cwd: str):
        import msvcrt
        descriptors = []
        streams = []
        process = ProcessInfo()
        try:
            for _ in range(3):
                descriptors.extend(os.pipe())
            child_fds = [descriptors[0], descriptors[3], descriptors[5]]
            for fd in child_fds:
                os.set_inheritable(fd, True)
            handles = [msvcrt.get_osfhandle(fd) for fd in child_fds]
            with self.attributes(job, handles) as attributes:
                startup = StartupInfoEx()
                startup.startup.cb = c.sizeof(startup)
                startup.startup.flags = 0x100  # STARTF_USESTDHANDLES
                startup.startup.stdin, startup.startup.stdout, startup.startup.stderr = handles
                startup.attributes = attributes
                text = c.create_unicode_buffer(subprocess.list2cmdline(command))
                self.require(self.api.CreateProcessW(command[0], text, None, None, True,
                    0x80000 | 0x8000000 | 0x4, None, cwd, c.byref(startup), c.byref(process)), "job_create_process_failed")
            contained = BOOL()
            self.require(self.api.IsProcessInJob(process.process, job["handle"], c.byref(contained)), "job_membership_unknown")
            self.require(contained.value, "job_membership_failed")
            if self.api.ResumeThread(process.thread) == 0xFFFFFFFF:
                raise WindowsJobError("job_resume_failed")
            self.api.CloseHandle(process.thread)
            process.thread = None
            for fd in child_fds:
                os.close(fd)
                descriptors.remove(fd)
            for fd, mode in zip(list(descriptors), ["wb", "rb", "rb"]):
                streams.append(os.fdopen(fd, mode, buffering=0))
                descriptors.remove(fd)
            return {"handle": process.process, "pid": int(process.pid),
                    "stdin": streams[0], "stdout": streams[1], "stderr": streams[2]}
        except BaseException:
            for stream in streams:
                stream.close()
            if process.process:
                # Exact retained process handle, not PID. Atomic assignment
                # already protects this child even if membership probing fails.
                self.api.TerminateProcess(process.process, 1)
                self.api.CloseHandle(process.process)
            if process.thread:
                self.api.CloseHandle(process.thread)
            raise
        finally:
            for fd in descriptors:
                os.close(fd)

    def state(self, job, process=None):
        accounting = Accounting()
        self.require(self.api.QueryInformationJobObject(job["handle"], 1, c.byref(accounting), c.sizeof(accounting), None), "job_accounting_unknown")
        code = None
        if process is not None:
            wait = self.api.WaitForSingleObject(process["handle"], 0)
            if wait == 0:
                exit_code = DWORD()
                self.require(self.api.GetExitCodeProcess(process["handle"], c.byref(exit_code)), "job_exit_unknown")
                code = int(exit_code.value)
            elif wait != 258:
                raise WindowsJobError("job_exit_unknown")
        return code, int(accounting.active)

    def memory_exceeded(self, job):
        if not job["port"]:
            return False
        for _ in range(64):
            message, key, overlapped = DWORD(), SIZE_T(), HANDLE()
            if not self.api.GetQueuedCompletionStatus(job["port"], c.byref(message), c.byref(key), c.byref(overlapped), 0):
                if c.get_last_error() == 258:
                    return False
                raise WindowsJobError("job_completion_unknown")
            if message.value in {9, 10}:  # PROCESS_MEMORY_LIMIT / JOB_MEMORY_LIMIT
                return True
        return False

    def terminate(self, job):
        self.require(self.api.TerminateJobObject(job["handle"], 1), "job_terminate_failed")

    def assert_current_member(self, name):
        job = self.open(name)
        if job is None:
            raise WindowsJobError("job_membership_missing")
        try:
            contained = BOOL()
            self.require(self.api.IsProcessInJob(self.api.GetCurrentProcess(), job["handle"], c.byref(contained)), "job_membership_unknown")
            self.require(contained.value, "job_membership_failed")
        finally:
            self.close(job)

    def close(self, job, process=None):
        # Closing the last non-inherited handle is the crash safety net, not an
        # assertion that exit has already been observed.
        self.api.CloseHandle(job["handle"])
        if job["port"]:
            self.api.CloseHandle(job["port"])
        if process:
            self.api.CloseHandle(process["handle"])
