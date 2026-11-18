package main

import "path/filepath"

// Both paths come from Windows known folders, never the client's environment.
// PowerShell's NRPT/route scripts use both ProgramData and .NET's
// CommonApplicationData lookup. The latter also expands the registered
// SystemDrive/ALLUSERSPROFILE paths in this deliberately restricted environment.
func workerEnvironment(systemRoot, stateDir string) []string {
	programData := filepath.Dir(filepath.Dir(stateDir))
	return []string{
		"ELECTRON_RUN_AS_NODE=1",
		"SystemRoot=" + systemRoot,
		"SystemDrive=" + filepath.VolumeName(systemRoot),
		"WINDIR=" + systemRoot,
		"ProgramData=" + programData,
		"ALLUSERSPROFILE=" + programData,
		"PATH=" + filepath.Join(systemRoot, "System32") + ";" + filepath.Join(systemRoot, "System32", "WindowsPowerShell", "v1.0"),
		"TEMP=" + stateDir,
		"TMP=" + stateDir,
		"NO_COLOR=1",
	}
}
