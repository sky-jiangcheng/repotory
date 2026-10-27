package service

import (
	"context"
	"path/filepath"
	"regexp"
	"testing"

	"repotory/internal/db"
)

// fakeRemoteStore records what the upload flow asked for, so the tests below
// assert on behaviour (who got dialed, which object key, how many puts)
// without any network.
type fakeRemoteStore struct {
	exists  map[string]bool
	putKeys []string
	failPut error
}

func (f *fakeRemoteStore) Exists(_ context.Context, objectKey string) (bool, error) {
	return f.exists[objectKey], nil
}

func (f *fakeRemoteStore) Put(_ context.Context, objectKey, _ string) error {
	if f.failPut != nil {
		return f.failPut
	}
	f.putKeys = append(f.putKeys, objectKey)
	if f.exists == nil {
		f.exists = map[string]bool{}
	}
	f.exists[objectKey] = true
	return nil
}

// dialRecording counts dialer invocations — the privacy gate's strongest
// guarantee is that the dialer is never even constructed when the opt-in is
// off or half-configured, so "zero egress" is observable, not just asserted.
func setRemoteConfig(t *testing.T, s *Service, kv map[string]string) {
	t.Helper()
	for k, v := range kv {
		if err := db.SetConfig(s.db, k, v); err != nil {
			t.Fatalf("set %s: %v", k, err)
		}
	}
}

func fullRemoteConfig() map[string]string {
	return map[string]string{
		"backup_remote_enabled":    "1",
		"backup_remote_endpoint":   "https://s3.example.com",
		"backup_remote_bucket":     "my-bucket",
		"backup_remote_access_key": "ak",
		"backup_remote_secret_key": "sk",
	}
}

// The switch is off (or untouched) by default: the dialer must never be
// constructed — zero egress by construction, not by politeness.
func TestRemoteBackupOffByDefault(t *testing.T) {
	s := newBackupTestService(t)
	dialed := 0
	s.remoteDialer = func(remoteBackupSettings) (remoteStore, error) {
		dialed++
		return &fakeRemoteStore{}, nil
	}
	if _, err := s.RunBackupNow(); err != nil {
		t.Fatalf("RunBackupNow: %v", err)
	}
	if dialed != 0 {
		t.Fatalf("dialer ran %d times with the opt-in off; want 0", dialed)
	}
}

// A half-configured form (enabled but missing bucket/credentials) is treated
// like an off switch: local snapshot still happens, nothing is dialed.
func TestRemoteBackupMissingCredsStaysLocal(t *testing.T) {
	s := newBackupTestService(t)
	setRemoteConfig(t, s, map[string]string{"backup_remote_enabled": "1"})
	dialed := 0
	s.remoteDialer = func(remoteBackupSettings) (remoteStore, error) {
		dialed++
		return &fakeRemoteStore{}, nil
	}
	path, err := s.RunBackupNow()
	if err != nil {
		t.Fatalf("RunBackupNow: %v", err)
	}
	if _, err := filepath.Glob(path); err != nil || path == "" {
		t.Fatalf("local snapshot missing: %s", path)
	}
	if dialed != 0 {
		t.Fatalf("dialer ran %d times with half-configured settings; want 0", dialed)
	}
}

// Full opt-in: exactly one upload of today's snapshot, under the prefix, with
// the daily filename as the object key. The second RunBackupNow the same day
// (the hourly ticker's normal path) must be a single HEAD, not a re-upload.
// The key regexp pins the red line: only the VACUUM INTO snapshot copy has an
// object name — never the live database file, never a WAL/SHM sidecar.
func TestRemoteBackupUploadsSnapshotOncePerDay(t *testing.T) {
	s := newBackupTestService(t)
	setRemoteConfig(t, s, fullRemoteConfig())
	store := &fakeRemoteStore{}
	s.remoteDialer = func(remoteBackupSettings) (remoteStore, error) {
		return store, nil
	}

	path, err := s.RunBackupNow()
	if err != nil {
		t.Fatalf("RunBackupNow: %v", err)
	}
	if len(store.putKeys) != 1 {
		t.Fatalf("first run put %d objects; want 1", len(store.putKeys))
	}
	key := store.putKeys[0]
	if !regexp.MustCompile(`^repotory/repotory-\d{4}-\d{2}-\d{2}\.db$`).MatchString(key) {
		t.Fatalf("object key = %q, want the snapshot filename under the prefix", key)
	}
	if filepath.Base(key) == "repotory.db" {
		t.Fatal("the LIVE database was uploaded; only snapshot copies may leave")
	}

	// Second run the same day (ticker / manual button): no new upload.
	if _, err := s.RunBackupNow(); err != nil {
		t.Fatalf("second RunBackupNow: %v", err)
	}
	if len(store.putKeys) != 1 {
		t.Fatalf("second run re-uploaded; put calls = %v", store.putKeys)
	}

	// The returned path stays the LOCAL snapshot — the caller-facing promise
	// of RunBackupNow is unchanged by the remote push.
	if path == "" {
		t.Fatal("RunBackupNow returned an empty local path")
	}
}

// A failed upload must never fail the backup: the local snapshot is the
// promise, the push is opportunistic. The next hourly tick retries for free.
func TestRemoteBackupPutFailureNotFatal(t *testing.T) {
	s := newBackupTestService(t)
	setRemoteConfig(t, s, fullRemoteConfig())
	store := &fakeRemoteStore{failPut: context.DeadlineExceeded}
	s.remoteDialer = func(remoteBackupSettings) (remoteStore, error) {
		return store, nil
	}
	path, err := s.RunBackupNow()
	if err != nil {
		t.Fatalf("RunBackupNow must succeed even when the upload fails: %v", err)
	}
	if len(store.putKeys) != 0 {
		t.Fatalf("failed puts recorded as uploaded: %v", store.putKeys)
	}
	if path == "" {
		t.Fatal("local snapshot path lost")
	}
}

// Prefix handling: custom prefixes are honoured verbatim (trimmed of
// slashes), and an unset prefix falls back to "repotory".
func TestRemoteBackupObjectKeyPrefix(t *testing.T) {
	base := filepath.Base("/tmp/repotory-2026-10-19.db")
	cases := []struct {
		prefix, want string
	}{
		{"", "repotory/" + base},
		{"backups", "backups/" + base},
		{"backups/x/", "backups/x/" + base},
	}
	st := remoteBackupSettings{}
	for _, c := range cases {
		st.Prefix = c.prefix
		if got := st.objectKey("/tmp/" + base); got != c.want {
			t.Errorf("prefix %q: objectKey = %q, want %q", c.prefix, got, c.want)
		}
	}
}

// The settings form saves through UpdateConfig, not through a direct write to
// the config table — and the write guard demanded a NUMBER from every key
// that was not on the string-key list. The five free-text fields of the
// remote form were therefore unsaveable: the form shipped, and every field
// in it failed with "config value must be a number" the moment a user
// pressed Save.
//
// The other tests in this file write the config table directly, which is
// exactly why they never saw the bug. This one goes through the door the UI
// uses.
func TestRemoteBackupTextFieldsAreSettableThroughUpdateConfig(t *testing.T) {
	s := newBackupTestService(t)
	for k, v := range map[string]string{
		"backup_remote_enabled":    "1",
		"backup_remote_endpoint":   "https://s3.example.com",
		"backup_remote_bucket":     "my-bucket",
		"backup_remote_prefix":     "backups",
		"backup_remote_access_key": "ak",
		"backup_remote_secret_key": "sk",
	} {
		if err := s.UpdateConfig(k, v); err != nil {
			t.Fatalf("%s not settable: %v", k, err)
		}
	}
	st, reason := s.remoteBackupSettings()
	if reason != "" {
		t.Fatalf("settings unreadable after saving them: %s", reason)
	}
	if st.Endpoint != "s3.example.com" || st.Bucket != "my-bucket" || st.Prefix != "backups" {
		t.Fatalf("saved settings = %+v", st)
	}
	if st.AccessKey != "ak" || st.SecretKey != "sk" {
		t.Fatalf("credentials did not round-trip: %+v", st)
	}
}
