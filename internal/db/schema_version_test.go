package db

import "testing"

// currentSchemaVersion is the version a fresh InitDB lands on — the highest
// migration id. Tests must not hard-code that number: v25 tripped three assertions
// that had pinned v24, and every future migration would trip them again. The
// authoritative constant lives in internal/integrity, which imports this package, so
// importing it back from here would be an import cycle; reading what InitDB actually
// wrote is both cycle-free and self-updating.
func currentSchemaVersion(t *testing.T) int {
	t.Helper()
	fresh := setupTestDB(t)
	var v int
	if err := fresh.QueryRow(
		`SELECT CAST(value AS INTEGER) FROM app_config WHERE key = 'schema_version'`).Scan(&v); err != nil {
		t.Fatalf("read schema_version from a fresh database: %v", err)
	}
	if v <= 0 {
		t.Fatalf("a fresh database reported a nonsensical schema_version %d", v)
	}
	return v
}
