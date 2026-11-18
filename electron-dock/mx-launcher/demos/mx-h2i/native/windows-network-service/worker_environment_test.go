package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestWorkerEnvironmentUsesTrustedFolders(t *testing.T) {
	t.Setenv("ProgramData", filepath.Join(t.TempDir(), "untrusted"))
	t.Setenv("ALLUSERSPROFILE", "untrusted-public-profile")
	t.Setenv("SystemDrive", "untrusted-system-drive")
	t.Setenv("NODE_OPTIONS", "--require=untrusted.cjs")
	t.Setenv("NODE_PATH", "untrusted-modules")
	t.Setenv("PATH", "untrusted-executables")
	base := t.TempDir()
	systemRoot := filepath.Join(base, "Windows")
	programData := filepath.Join(base, "ProgramData")
	stateDir := filepath.Join(programData, "MinCave", "network-service")
	env := map[string]string{}
	for _, entry := range workerEnvironment(systemRoot, stateDir) {
		key, value, _ := strings.Cut(entry, "=")
		env[key] = value
	}
	if env["ProgramData"] != programData || env["SystemRoot"] != systemRoot || env["TEMP"] != stateDir || env["TMP"] != stateDir {
		t.Fatal("worker lost its trusted Windows folder paths")
	}
	if env["SystemDrive"] != filepath.VolumeName(systemRoot) || env["ALLUSERSPROFILE"] != programData {
		t.Fatal("worker lost the trusted drive/public-profile context required by CommonApplicationData")
	}
	if env["NODE_OPTIONS"] != "" || env["NODE_PATH"] != "" || strings.Contains(env["PATH"], "untrusted") || env["ELECTRON_RUN_AS_NODE"] != "1" {
		t.Fatal("worker inherited executable injection settings")
	}
}

// Reproduce the endpoint-bypass script's .NET lookup, not just Join-Path on
// ProgramData. GetFolderPath can return an empty string in a restricted
// environment without the SystemDrive used by the registered known folder.
// This test reads paths only; it never installs services or changes routing.
func TestWorkerPowerShellCanResolveCommonApplicationData(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("requires Windows PowerShell")
	}
	systemRoot := os.Getenv("SystemRoot")
	programData := os.Getenv("ProgramData")
	if systemRoot == "" || programData == "" {
		t.Fatal("Windows known folders are missing from the test environment")
	}
	script := "$ErrorActionPreference='Stop'; $common=[Environment]::GetFolderPath([System.Environment+SpecialFolder]::CommonApplicationData); if([string]::IsNullOrWhiteSpace($common)){throw 'CommonApplicationData unavailable'}; [Console]::Out.Write((Join-Path $common 'QPJoy\\WireGuard'))"
	command := exec.Command(filepath.Join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), "-NoProfile", "-NonInteractive", "-Command", script)
	command.Env = workerEnvironment(systemRoot, filepath.Join(programData, "MinCave", "network-service"))
	output, err := command.CombinedOutput()
	if err != nil || !strings.EqualFold(strings.TrimSpace(string(output)), filepath.Join(programData, "QPJoy", "WireGuard")) {
		t.Fatalf("restricted worker could not resolve CommonApplicationData: %v %s", err, output)
	}
}

// Read-only Windows integration check. This exercises the same Join-Path used
// before WireGuard installation, without changing services, routes or DNS.
func TestWorkerPowerShellCanResolveNetworkStatePath(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("requires Windows PowerShell")
	}
	systemRoot := os.Getenv("SystemRoot")
	programData := os.Getenv("ProgramData")
	if systemRoot == "" || programData == "" {
		t.Fatal("Windows known folders are missing from the test environment")
	}
	stateDir := filepath.Join(programData, "MinCave", "network-service")
	run := func(env []string) ([]byte, error) {
		command := exec.Command(filepath.Join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), "-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference='Stop'; [Console]::Out.Write((Join-Path $env:ProgramData 'QPJoy\\WireGuard'))")
		command.Env = env
		return command.CombinedOutput()
	}
	env := workerEnvironment(systemRoot, stateDir)
	output, err := run(env)
	if err != nil || strings.TrimSpace(string(output)) != filepath.Join(programData, "QPJoy", "WireGuard") {
		t.Fatalf("restricted worker could not resolve network state: %v %s", err, output)
	}
	withoutProgramData := []string{}
	for _, entry := range env {
		if !strings.HasPrefix(entry, "ProgramData=") {
			withoutProgramData = append(withoutProgramData, entry)
		}
	}
	if _, err := run(withoutProgramData); err == nil {
		t.Fatal("regression fixture without ProgramData unexpectedly succeeded")
	}
}
