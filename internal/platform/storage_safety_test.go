package platform

import (
	"os"
	"path/filepath"
	"testing"
)

func TestCheckStorageSafety_Clean(t *testing.T) {
	tmp := t.TempDir()
	rep := CheckStorageSafety(tmp)
	if !rep.IsSafe {
		t.Fatalf("expected clean tempdir to be safe, got warning: %s", rep.Warning)
	}
}

func TestCheckStorageSafety_CloudSync(t *testing.T) {
	fakeICloud := "/Users/test/Library/Mobile Documents/com~apple~CloudDocs/repotory"
	rep := CheckStorageSafety(fakeICloud)
	if rep.IsSafe {
		t.Fatal("expected iCloud path to be detected as unsafe")
	}
	if rep.RiskType != "cloud_sync" {
		t.Fatalf("expected risk_type cloud_sync, got %s", rep.RiskType)
	}
}

func TestCheckStorageSafety_FuseHidden(t *testing.T) {
	tmp := t.TempDir()
	hidden := filepath.Join(tmp, ".fuse_hidden12345")
	if err := os.WriteFile(hidden, []byte("x"), 0600); err != nil {
		t.Fatal(err)
	}
	rep := CheckStorageSafety(tmp)
	if rep.IsSafe {
		t.Fatal("expected directory with .fuse_hidden to be marked unsafe")
	}
	if rep.RiskType != "fuse_network" {
		t.Fatalf("expected risk_type fuse_network, got %s", rep.RiskType)
	}
}
