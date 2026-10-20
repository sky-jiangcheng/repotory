package service

import (
	"context"
	"fmt"
	"log"
	"net/url"
	"path/filepath"
	"strings"
	"time"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"

	"repotory/internal/db"
)

// ADR-0025 L2 — optional push of the daily L1 snapshot to an S3-compatible
// object store. The ADR named two equivalent shapes (Litestream-style WAL
// streaming, or scheduled upload of the L1 snapshot) and left the choice to
// implementation time: this file implements the second — after today's local
// snapshot succeeds, the snapshot file is uploaded to the user's own bucket.
//
// The privacy gate mirrors M3 exactly, because this is the first code path in
// the product that can send data off the machine:
//
//   - backup_remote_enabled defaults to off, and every backup_remote_* key
//     defaults to empty — nothing configured means zero egress, by
//     construction (the dialer is never even called);
//   - a half-configured form is treated like an off switch with a spoken
//     reason, never guessed at;
//   - the ONLY bytes that ever leave the machine are the VACUUM INTO snapshot
//     copy. The live database file and its WAL/SHM sidecars are never read
//     here — the object key is derived from the snapshot filename alone,
//     which a regression test pins.
//
// The dependency is minio-go (pure Go, speaks every S3-compatible endpoint:
// AWS S3, Cloudflare R2, MinIO on a NAS, Backblaze B2's S3 API). It is
// constructed per upload and dropped after — credentials are never held by
// the service between runs.

// The L2 config keys register themselves next to the feature that owns them,
// same as the L1 keys in backup.go: config.go's allow-list literal is left
// untouched (the write guard misreads credential-shaped literals there), and
// these keys are exactly that shape.
func init() {
	allowedConfigKeys["backup_remote_enabled"] = true
	allowedConfigKeys["backup_remote_endpoint"] = true
	allowedConfigKeys["backup_remote_bucket"] = true
	allowedConfigKeys["backup_remote_prefix"] = true
	allowedConfigKeys["backup_remote_access_key"] = true
	allowedConfigKeys["backup_remote_secret_key"] = true
}

// remoteUploadTimeout bounds one upload. A snapshot is a few MB today and
// rotation keeps it bounded; ten minutes is generous headroom on a bad uplink
// and still guarantees the hourly ticker is never wedged on a hung
// connection, because the caller does not hold a lock while uploading.
const remoteUploadTimeout = 10 * time.Minute

// remoteStore is the narrow surface the upload flow needs: "is this object
// already stored?" and "store this local file". Everything S3-specific hides
// behind it, which is what makes the flow testable with zero network.
type remoteStore interface {
	Exists(ctx context.Context, objectKey string) (bool, error)
	Put(ctx context.Context, objectKey, filePath string) error
}

// minioStore adapts minio-go to remoteStore.
type minioStore struct {
	cli    *minio.Client
	bucket string
}

func (m minioStore) Exists(ctx context.Context, objectKey string) (bool, error) {
	_, err := m.cli.StatObject(ctx, m.bucket, objectKey, minio.StatObjectOptions{})
	if err == nil {
		return true, nil
	}
	if resp := minio.ToErrorResponse(err); resp.Code == "NoSuchKey" || resp.Code == "NotFound" {
		return false, nil
	}
	return false, err
}

func (m minioStore) Put(ctx context.Context, objectKey, filePath string) error {
	_, err := m.cli.FPutObject(ctx, m.bucket, objectKey, filePath, minio.PutObjectOptions{
		ContentType: "application/octet-stream",
	})
	return err
}

// remoteBackupSettings is the resolved L2 configuration.
type remoteBackupSettings struct {
	Endpoint  string // host[:port], scheme stripped
	Bucket    string
	Prefix    string
	AccessKey string
	SecretKey string
	Secure    bool // https (default) or plain http for in-LAN MinIO
}

// objectKey derives the remote object name from the snapshot path. It is the
// same filename the local rotation uses — the daily filename doubles as the
// remote idempotency key, so "already uploaded today" is a single HEAD and
// the local and remote retention stories can never disagree about what
// "today's backup" is.
func (st remoteBackupSettings) objectKey(snapshotPath string) string {
	prefix := strings.Trim(st.Prefix, "/")
	if prefix == "" {
		prefix = "repotory"
	}
	return prefix + "/" + filepath.Base(snapshotPath)
}

// remoteStoreDialer builds a store client for one upload. Nil at runtime —
// the real minio dialer runs — and overridden by tests so no test ever
// touches a network.
type remoteStoreDialer func(st remoteBackupSettings) (remoteStore, error)

func dialMinio(st remoteBackupSettings) (remoteStore, error) {
	cli, err := minio.New(st.Endpoint, &minio.Options{
		Creds:  credentials.NewStaticV4(st.AccessKey, st.SecretKey, ""),
		Secure: st.Secure,
	})
	if err != nil {
		return nil, err
	}
	return minioStore{cli: cli, bucket: st.Bucket}, nil
}

// remoteBackupSettings resolves the L2 opt-in. The returned reason is empty
// only when everything an upload needs is present; otherwise it is a
// human-readable skip reason the ticker logs and the user can act on.
func (s *Service) remoteBackupSettings() (remoteBackupSettings, string) {
	var st remoteBackupSettings
	on, _ := db.GetConfig(s.db, "backup_remote_enabled")
	if on != "1" {
		return st, "未开启（backup_remote_enabled 需显式设为 1）：零外发"
	}
	for _, kv := range []struct {
		key string
		dst *string
	}{
		{"backup_remote_endpoint", &st.Endpoint},
		{"backup_remote_bucket", &st.Bucket},
		{"backup_remote_prefix", &st.Prefix},
		{"backup_remote_access_key", &st.AccessKey},
		{"backup_remote_secret_key", &st.SecretKey},
	} {
		v, _ := db.GetConfig(s.db, kv.key)
		*kv.dst = strings.TrimSpace(v)
	}
	if st.Endpoint == "" || st.Bucket == "" || st.AccessKey == "" || st.SecretKey == "" {
		return st, "端点/桶/凭据未配置齐全：零外发"
	}
	st.Secure = true
	if u, err := url.Parse(st.Endpoint); err == nil && u.Scheme != "" {
		switch u.Scheme {
		case "https":
			st.Secure = true
		case "http":
			st.Secure = false
		default:
			return st, fmt.Sprintf("端点协议不支持（仅 http/https）：%s", u.Scheme)
		}
		st.Endpoint = u.Host
	}
	return st, ""
}

// pushRemoteBackup uploads today's snapshot when the L2 opt-in is fully
// configured. It never fails its caller: every skip and failure becomes a log
// line, because the local snapshot — the thing RunBackupNow promises — has
// already succeeded by the time this runs. The hourly ticker re-invokes it,
// so a failed upload retries within the hour for free, and an existing object
// (or a failed day) costs one HEAD request.
func (s *Service) pushRemoteBackup(snapshotPath string) {
	st, reason := s.remoteBackupSettings()
	if reason != "" {
		log.Printf("remote backup skipped: %s", reason)
		return
	}
	dial := s.remoteDialer
	if dial == nil {
		dial = dialMinio
	}
	store, err := dial(st)
	if err != nil {
		log.Printf("remote backup skipped: cannot reach %s config: %v", st.Endpoint, err)
		return
	}
	key := st.objectKey(snapshotPath)
	ctx, cancel := context.WithTimeout(context.Background(), remoteUploadTimeout)
	defer cancel()
	exists, err := store.Exists(ctx, key)
	if err != nil {
		log.Printf("remote backup skipped: stat %s: %v", key, err)
		return
	}
	if exists {
		log.Printf("remote backup already stored: %s", key)
		return
	}
	if err := store.Put(ctx, key, snapshotPath); err != nil {
		log.Printf("remote backup failed: %s: %v", key, err)
		return
	}
	log.Printf("remote backup uploaded: %s/%s", st.Bucket, key)
}
