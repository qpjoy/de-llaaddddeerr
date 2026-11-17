//go:build windows

package main

import (
	"errors"
	"golang.org/x/sys/windows"
	"time"
	"unsafe"
)

func newWorkerJob() (windows.Handle, error) {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return 0, err
	}
	limits := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	limits.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	_, err = windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation, uintptr(unsafe.Pointer(&limits)), uint32(unsafe.Sizeof(limits)))
	if err != nil {
		windows.CloseHandle(job)
		return 0, err
	}
	return job, nil
}

func releaseWorkerJob(job windows.Handle) error {
	limits := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	_, err := windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation, uintptr(unsafe.Pointer(&limits)), uint32(unsafe.Sizeof(limits)))
	return err
}

func attachAndResume(job windows.Handle, pid uint32) error {
	process, err := windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE, false, pid)
	if err != nil {
		return err
	}
	defer windows.CloseHandle(process)
	if err = windows.AssignProcessToJobObject(job, process); err != nil {
		return err
	}
	snapshot, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPTHREAD, 0)
	if err != nil {
		return err
	}
	defer windows.CloseHandle(snapshot)
	entry := windows.ThreadEntry32{Size: uint32(unsafe.Sizeof(windows.ThreadEntry32{}))}
	for err = windows.Thread32First(snapshot, &entry); err == nil; err = windows.Thread32Next(snapshot, &entry) {
		if entry.OwnerProcessID != pid {
			continue
		}
		thread, threadErr := windows.OpenThread(windows.THREAD_SUSPEND_RESUME, false, entry.ThreadID)
		if threadErr != nil {
			return threadErr
		}
		_, threadErr = windows.ResumeThread(thread)
		windows.CloseHandle(thread)
		return threadErr
	}
	return errors.New("worker primary thread is unavailable")
}

func terminateWorkerJob(job windows.Handle) bool {
	if windows.TerminateJobObject(job, 1) != nil {
		return false
	}
	// JOBOBJECT_BASIC_ACCOUNTING_INFORMATION (four LARGE_INTEGER, four DWORD).
	var accounting struct {
		UserTime, KernelTime, PeriodUserTime, PeriodKernelTime           int64
		PageFaults, TotalProcesses, ActiveProcesses, TerminatedProcesses uint32
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		err := windows.QueryInformationJobObject(job, windows.JobObjectBasicAccountingInformation, uintptr(unsafe.Pointer(&accounting)), uint32(unsafe.Sizeof(accounting)), nil)
		if err != nil {
			return false
		}
		if accounting.ActiveProcesses == 0 {
			return true
		}
		time.Sleep(20 * time.Millisecond)
	}
	return false
}
