//go:build !windows

package platform

import (
	"os"
	"syscall"
)

// DeviceID returns the id of the filesystem that holds path, and whether the
// platform could determine it at all.
//
// It exists for one question: "is the directory the user picked for their
// off-disk backup actually on another disk?" The 2026-10-14 accident happened
// because the data lived on one disk, and a user cannot answer that question
// by looking at a path — a backup directory one folder away looks exactly
// like one on an external drive.
//
// On Unix the answer is the device id from stat(2), which is exactly the
// granularity that matters: two paths on the same mount share it, two paths
// on two disks do not.
func DeviceID(path string) (uint64, bool) {
	info, err := os.Stat(path)
	if err != nil {
		return 0, false
	}
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return 0, false
	}
	return uint64(st.Dev), true
}
