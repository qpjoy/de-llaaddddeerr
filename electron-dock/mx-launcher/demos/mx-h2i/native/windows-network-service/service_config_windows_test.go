//go:build windows

package main

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/sys/windows"
)

// CreateService normalizes a missing service type, while UpdateConfig does
// not. The shared configuration must already satisfy ChangeServiceConfig's
// contract so a full-installer repair works as well as a first installation.
// This regression test does not register, stop or modify a Windows service.
func TestServiceConfigurationSupportsRepair(t *testing.T) {
	config := networkServiceConfig()
	if config.ServiceType != windows.SERVICE_WIN32_OWN_PROCESS {
		t.Fatalf("repair must pass an explicit own-process service type, got %#x", config.ServiceType)
	}
	if config.StartType != windows.SERVICE_AUTO_START || config.ServiceStartName != "LocalSystem" {
		t.Fatalf("repair must preserve automatic LocalSystem operation: %+v", config)
	}
	if config.ServiceType&windows.SERVICE_INTERACTIVE_PROCESS != 0 {
		t.Fatal("network service must not interact with the desktop")
	}
}

func TestPrepareServiceStateRepairsOnlyEmptyUnownedDirectory(t *testing.T) {
	token := windows.GetCurrentProcessToken()
	if !token.IsElevated() {
		t.Skip("creating installer-owned directories requires an elevated Windows token")
	}
	user, err := token.GetTokenUser()
	if err != nil {
		t.Fatal(err)
	}
	owner := user.User.Sid
	if owner.IsWellKnown(windows.WinLocalSystemSid) || owner.IsWellKnown(windows.WinBuiltinAdministratorsSid) {
		t.Skip("test requires an individual Windows account as the legacy directory owner")
	}
	if err := enableInstallPrivilege("SeRestorePrivilege"); err != nil {
		t.Fatal(err)
	}
	service := networkService{stateDir: filepath.Join(t.TempDir(), "MinCave", "network-service")}
	if err := os.MkdirAll(service.stateDir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := windows.SetNamedSecurityInfo(service.stateDir, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION, owner, nil, nil, nil); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(service.stateDir, "previous-state")
	if err := os.WriteFile(marker, []byte("preserve"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := service.prepareServiceState(false); !errors.Is(err, windows.ERROR_DIR_NOT_EMPTY) {
		t.Fatalf("nonempty state should be preserved: %v", err)
	}
	if err := os.Remove(marker); err != nil {
		t.Fatal(err)
	}
	if err := service.prepareServiceState(true); !errors.Is(err, errUntrustedStateOwner) {
		t.Fatalf("registered service state must not be reset: %v", err)
	}
	if err := service.prepareServiceState(false); err != nil {
		t.Fatal(err)
	}
	if err := service.prepareServiceState(true); err != nil {
		t.Fatalf("the repaired state must support a subsequent installation: %v", err)
	}
}
