package platform

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// StorageSafetyReport describes the safety assessment of the data directory.
type StorageSafetyReport struct {
	Path     string `json:"path"`
	IsSafe   bool   `json:"is_safe"`
	Warning  string `json:"warning,omitempty"`
	RiskType string `json:"risk_type,omitempty"` // "cloud_sync", "fuse_network", "unwritable"
}

// CheckStorageSafety inspects the given database or data directory path for
// storage environments known to endanger SQLite WAL and concurrent locking
// (such as FUSE, NFS, network shares, or active cloud sync directories like
// iCloud, OneDrive, Dropbox).
func CheckStorageSafety(targetPath string) StorageSafetyReport {
	if targetPath == "" {
		targetPath = GetDbPath()
	}
	dir := targetPath
	fi, err := os.Stat(targetPath)
	if err == nil && !fi.IsDir() {
		dir = filepath.Dir(targetPath)
	}

	report := StorageSafetyReport{
		Path:   dir,
		IsSafe: true,
	}

	cleanDir := filepath.Clean(dir)
	cleanLower := strings.ToLower(cleanDir)

	// 1. Path-based pattern detection for cloud sync & virtual mounts (fast exit)
	cloudSyncPatterns := []struct {
		substr string
		name   string
	}{
		{"mobile documents/com~apple~clouddocs", "iCloud Drive"},
		{"library/mobile documents", "iCloud"},
		{"dropbox", "Dropbox"},
		{"onedrive", "OneDrive"},
		{"google drive", "Google Drive"},
		{"box sync", "Box"},
		{"nutstore", "Nutstore (坚果云)"},
		{"baidunetdisk", "BaiduNetdisk"},
	}

	for _, p := range cloudSyncPatterns {
		if strings.Contains(cleanLower, p.substr) {
			report.IsSafe = false
			report.RiskType = "cloud_sync"
			report.Warning = fmt.Sprintf("数据目录位于云同步服务 (%s) 同步路径中，多端异步同步易破坏 SQLite WAL 造成数据库损坏，建议迁移到纯本地目录。", p.name)
			return report
		}
	}

	// 2. FUSE / Network mount heuristics
	fusePatterns := []string{
		"/volumes/fuse",
		".fuse_hidden",
		"/gvfs/",
	}
	for _, p := range fusePatterns {
		if strings.Contains(cleanLower, p) {
			report.IsSafe = false
			report.RiskType = "fuse_network"
			report.Warning = "数据目录位于 FUSE 或网络文件系统，可能不支持 POSIX advisory locking，存在数据库页损坏风险。"
			return report
		}
	}

	// 3. Check directory writability / accessibility
	testFile := filepath.Join(dir, fmt.Sprintf(".safety_probe_%d", os.Getpid()))
	if f, err := os.OpenFile(testFile, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0600); err != nil {
		report.IsSafe = false
		report.RiskType = "unwritable"
		report.Warning = fmt.Sprintf("数据目录不可写或无权访问: %v", err)
		return report
	} else {
		_ = f.Close()
		_ = os.Remove(testFile)
	}

	// Look for lingering .fuse_hidden files in the data directory
	if entries, err := os.ReadDir(dir); err == nil {
		for _, e := range entries {
			if strings.HasPrefix(e.Name(), ".fuse_hidden") {
				report.IsSafe = false
				report.RiskType = "fuse_network"
				report.Warning = "数据目录检测到残留的 .fuse_hidden 文件，表明此前曾通过 FUSE 挂载或有未关闭的挂载句柄，存在 WAL 锁异常风险。"
				return report
			}
		}
	}

	return report
}
