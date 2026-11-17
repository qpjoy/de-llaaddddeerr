//go:build windows

package main

import (
	"errors"
	"io/fs"
	"path/filepath"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

func trustedInstallSID(sid *windows.SID) bool {
	return sid.IsWellKnown(windows.WinLocalSystemSid) || sid.IsWellKnown(windows.WinBuiltinAdministratorsSid) || sid.String() == "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464" // TrustedInstaller
}

func verifyInstallDescriptor(descriptor *windows.SECURITY_DESCRIPTOR, parent bool) error {
	owner, _, err := descriptor.Owner()
	if err != nil || owner == nil || !trustedInstallSID(owner) {
		return errors.New("installation path is not owned by SYSTEM, Administrators or TrustedInstaller")
	}
	acl, _, err := descriptor.DACL()
	if err != nil || acl == nil {
		return errors.New("installation path has an unrestricted ACL")
	}
	// Parents may allow creating children, but not deleting/replacing them or
	// changing security, attributes or extended attributes. The installation
	// itself must also forbid ordinary-user writes and creation of children.
	forbidden := windows.ACCESS_MASK(windows.GENERIC_ALL | windows.GENERIC_WRITE | windows.WRITE_DAC | windows.WRITE_OWNER | windows.DELETE | 0x40 /* FILE_DELETE_CHILD */ | windows.FILE_WRITE_ATTRIBUTES | windows.FILE_WRITE_EA)
	if !parent {
		forbidden |= windows.ACCESS_MASK(windows.FILE_WRITE_DATA | windows.FILE_APPEND_DATA)
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
			return errors.New("unsupported installation ACL")
		}
		if !trustedInstallSID((*windows.SID)(unsafe.Pointer(&ace.SidStart))) && ace.Mask&forbidden != 0 {
			return errors.New("installation path is writable or replaceable by an ordinary user; repair the full installation")
		}
	}
	return nil
}

func verifyInstallationDirectory(root string) error {
	volume := filepath.VolumeName(root)
	if len(volume) != 2 || volume[1] != ':' || !filepath.IsAbs(root) || strings.EqualFold(filepath.Clean(root), volume+`\`) {
		return errors.New("install MinCave into a subdirectory of a fixed local drive")
	}
	volumePath, err := windows.UTF16PtrFromString(volume + `\`)
	if err != nil || windows.GetDriveType(volumePath) != windows.DRIVE_FIXED {
		return errors.New("MinCave network service requires a fixed local drive")
	}
	var flags uint32
	if err = windows.GetVolumeInformation(volumePath, nil, 0, nil, nil, &flags, nil, 0); err != nil {
		return err
	}
	if flags&windows.FILE_PERSISTENT_ACLS == 0 {
		return errors.New("MinCave installation requires a filesystem with persistent ACLs")
	}
	check := func(path string, parent bool) error {
		if err := rejectReparse(path); err != nil {
			return err
		}
		descriptor, err := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
		if err != nil {
			return err
		}
		return verifyInstallDescriptor(descriptor, parent)
	}
	for parent := filepath.Dir(root); ; parent = filepath.Dir(parent) {
		if err := check(parent, true); err != nil {
			return err
		}
		if filepath.Dir(parent) == parent {
			break
		}
	}
	// Validate DLLs and Electron support files too: SYSTEM executes the bundled
	// Electron as Node, so checking only the five hashed entry points is not
	// sufficient for a custom installation outside Program Files.
	return filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		return check(path, false)
	})
}
