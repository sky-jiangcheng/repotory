//go:build windows

package platform

import (
	"os"
)

// DeviceID reports "unknown" on Windows.
//
// The Unix build answers with the device id from stat(2). On Windows the
// equivalent is the volume serial number, which os.FileInfo.Sys() does not
// expose (it returns a *syscall.Win32FileAttributeData, which carries the
// serial number of the FILE, not of the volume the path resolves to).
//
// Returning "unknown" is the honest answer, and the caller treats it as
// "cannot tell" rather than "different disk" — a wrong "it is on another
// disk" would silence the very warning this exists to raise. Reaching the
// volume serial number means GetVolumePathName + GetVolumeInformation,
// which is more Windows API than this check is worth.
func DeviceID(path string) (uint64, bool) {
	if _, err := os.Stat(path); err != nil {
		return 0, false
	}
	return 0, false
}
