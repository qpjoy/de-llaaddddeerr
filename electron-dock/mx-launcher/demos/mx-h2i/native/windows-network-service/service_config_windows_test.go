//go:build windows

package main

import (
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
