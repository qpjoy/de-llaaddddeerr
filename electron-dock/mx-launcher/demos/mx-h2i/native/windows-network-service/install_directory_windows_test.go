//go:build windows

package main

import (
	"testing"

	"golang.org/x/sys/windows"
)

func TestInstallationACLs(t *testing.T) {
	for _, test := range []struct {
		name, sddl      string
		parent, allowed bool
	}{
		{"protected installation", "O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;GRGX;;;BU)", false, true},
		{"drive allows new folders", "O:BAG:BAD:(A;;FA;;;BA)(A;;0x4;;;AU)(A;OICIIO;FA;;;CO)", true, true},
		{"creation in installation", "O:BAG:BAD:(A;;FA;;;BA)(A;;0x4;;;AU)", false, false},
		{"parent can delete children", "O:BAG:BAD:(A;;FA;;;BA)(A;;0x40;;;BU)", true, false},
		{"parent can write attributes", "O:BAG:BAD:(A;;FA;;;BA)(A;;0x100;;;BU)", true, false},
		{"ordinary owner", "O:S-1-5-21-1-2-3-1000G:BAD:(A;;FA;;;BA)", false, false},
		{"ordinary modification", "O:BAG:BAD:(A;;FA;;;BA)(A;;GW;;;AU)", false, false},
		{"TrustedInstaller parent", "O:S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464G:BAD:(A;;FA;;;BA)(A;;GRGX;;;BU)", true, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			descriptor, err := windows.SecurityDescriptorFromString(test.sddl)
			if err != nil {
				t.Fatal(err)
			}
			if err = verifyInstallDescriptor(descriptor, test.parent); (err == nil) != test.allowed {
				t.Fatalf("allowed=%t: %v", test.allowed, err)
			}
		})
	}
}
