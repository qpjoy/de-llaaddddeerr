//go:build windows

package main

import (
	"errors"
	"fmt"
	"golang.org/x/sys/windows"
	"io/fs"
	"os"
	"path/filepath"
	"unsafe"
)

const protectedStateDACL = "D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)"

var errUntrustedStateOwner = errors.New("untrusted owner of privileged network state")

// The existing core coordinates endpoint routes with other elevated Launcher
// clients in ProgramData/QPJoy/WireGuard. Preserve that shared ownership, while
// refusing ordinary-user-writable state before SYSTEM reads it.
func trustedACL(path string, allowCreateChildren bool) (err error) {
	defer func() {
		if err != nil {
			err = fmt.Errorf("verify-network-state-path %q: %w", path, err)
		}
	}()
	if err := rejectReparse(path); err != nil {
		return err
	}
	descriptor, err := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		return err
	}
	owner, _, err := descriptor.Owner()
	if err != nil {
		return err
	}
	if !owner.IsWellKnown(windows.WinLocalSystemSid) && !owner.IsWellKnown(windows.WinBuiltinAdministratorsSid) {
		return errUntrustedStateOwner
	}
	acl, _, err := descriptor.DACL()
	if err != nil {
		return err
	}
	if acl == nil {
		return errors.New("unrestricted network state ACL")
	}
	forbidden := windows.ACCESS_MASK(windows.GENERIC_ALL | windows.WRITE_DAC | windows.WRITE_OWNER | windows.DELETE | 0x40 /* FILE_DELETE_CHILD */)
	if !allowCreateChildren {
		forbidden |= windows.ACCESS_MASK(windows.GENERIC_WRITE | windows.FILE_WRITE_DATA | windows.FILE_APPEND_DATA)
	}
	for index := uint32(0); index < uint32(acl.AceCount); index++ {
		var ace *windows.ACCESS_ALLOWED_ACE
		if err = windows.GetAce(acl, index, &ace); err != nil {
			return err
		}
		if ace.Header.AceFlags&windows.INHERIT_ONLY_ACE != 0 || ace.Header.AceType == windows.ACCESS_DENIED_ACE_TYPE {
			continue
		}
		if ace.Header.AceType != windows.ACCESS_ALLOWED_ACE_TYPE {
			return errors.New("unsupported privileged state ACL")
		}
		sid := (*windows.SID)(unsafe.Pointer(&ace.SidStart))
		if !sid.IsWellKnown(windows.WinLocalSystemSid) && !sid.IsWellKnown(windows.WinBuiltinAdministratorsSid) && ace.Mask&forbidden != 0 {
			return errors.New("privileged network state is writable by an ordinary user")
		}
	}
	return nil
}

func (s *networkService) prepareServiceState(serviceRegistered bool) error {
	if err := protectDirectory(filepath.Dir(s.stateDir)); err != nil {
		return err
	}
	info, err := os.Lstat(s.stateDir)
	if errors.Is(err, os.ErrNotExist) {
		return createServiceStateDirectory(s.stateDir)
	}
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return fmt.Errorf("network service state path %q must be a directory", s.stateDir)
	}
	if err := trustedACL(s.stateDir, false); err != nil {
		if serviceRegistered || !errors.Is(err, errUntrustedStateOwner) {
			return err
		}
		// A failed first install can leave an empty directory. Remove it only
		// if it is still empty, and never adopt its ACL or contents.
		path, pathErr := windows.UTF16PtrFromString(s.stateDir)
		if pathErr != nil {
			return pathErr
		}
		if removeErr := windows.RemoveDirectory(path); removeErr != nil {
			return fmt.Errorf("replace empty network service state directory %q: %w", s.stateDir, removeErr)
		}
		return createServiceStateDirectory(s.stateDir)
	}
	return verifyStateTree(s.stateDir)
}

func createServiceStateDirectory(path string) error {
	// Give administrators ownership at creation, even when the elevated
	// installer's default owner is its individual Windows account.
	descriptor, err := windows.SecurityDescriptorFromString("O:BA" + protectedStateDACL)
	if err != nil {
		return err
	}
	attributes := windows.SecurityAttributes{SecurityDescriptor: descriptor}
	attributes.Length = uint32(unsafe.Sizeof(attributes))
	directory, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return err
	}
	if err := windows.CreateDirectory(directory, &attributes); err != nil {
		return fmt.Errorf("create protected network service state directory %q: %w", path, err)
	}
	return trustedACL(path, false)
}

func (s *networkService) endpointRegistryRoot() string {
	return filepath.Join(filepath.Dir(filepath.Dir(s.stateDir)), "QPJoy", "WireGuard")
}
func checkEndpointTree(root string, allowDirectoryCreation bool) error {
	return filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		return trustedACL(path, allowDirectoryCreation && entry.IsDir())
	})
}
func (s *networkService) prepareEndpointRegistry() error {
	root := s.endpointRegistryRoot()
	parent := filepath.Dir(root)
	if _, err := os.Stat(parent); errors.Is(err, os.ErrNotExist) {
		if err = protectDirectory(parent); err != nil {
			return err
		}
	} else if err != nil {
		return err
	}
	if err := trustedACL(parent, true); err != nil {
		return err
	}
	if _, err := os.Stat(root); err == nil {
		// Validate existing files before tightening directory inheritance, so a
		// previously world-writable registry cannot silently become trusted.
		if err = checkEndpointTree(root, true); err != nil {
			return err
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := protectDirectory(root); err != nil {
		return err
	}
	return verifyStateTree(root)
}
func (s *networkService) verifyEndpointRegistry() error {
	root := s.endpointRegistryRoot()
	if err := trustedACL(filepath.Dir(root), true); err != nil {
		return err
	}
	return checkEndpointTree(root, false)
}
