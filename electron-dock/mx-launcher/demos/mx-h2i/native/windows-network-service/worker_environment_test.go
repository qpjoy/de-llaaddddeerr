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
	if env["NODE_OPTIONS"] != "" || env["NODE_PATH"] != "" || strings.Contains(env["PATH"], "untrusted") || env["ELECTRON_RUN_AS_NODE"] != "1" {
		t.Fatal("worker inherited executable injection settings")
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
