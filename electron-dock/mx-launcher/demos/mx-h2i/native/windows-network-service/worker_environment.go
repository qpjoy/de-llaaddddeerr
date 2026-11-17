package main

import "path/filepath"

// Both paths come from Windows known folders, never the client's environment.
// PowerShell's NRPT/route scripts require ProgramData even when the worker is
// launched with a deliberately restricted environment.
func workerEnvironment(systemRoot, stateDir string) []string {
	return []string{
		"ELECTRON_RUN_AS_NODE=1",
		"SystemRoot=" + systemRoot,
		"WINDIR=" + systemRoot,
		"ProgramData=" + filepath.Dir(filepath.Dir(stateDir)),
		"PATH=" + filepath.Join(systemRoot, "System32") + ";" + filepath.Join(systemRoot, "System32", "WindowsPowerShell", "v1.0"),
		"TEMP=" + stateDir,
		"TMP=" + stateDir,
		"NO_COLOR=1",
	}
}
