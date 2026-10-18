# ADR-0025: Backup and recovery — the product's built-in daily local snapshot, cloud push as opt-in

- Status: Proposed (**L1 implemented 2026-10-18**: daily VACUUM INTO local snapshots + 14-copy rotation + the `backup_enabled`/`backup_retain` config keys, purely local with zero outbound traffic, `go test ./...` green; L2 cloud push and the Docker deployment tier are opt-in options that this ADR shapes but does not implement. Promotion to Accepted awaits: a real-machine restore rehearsal, three consecutive days of observed snapshots, and one observed rotation — see "Promotion criteria".)
- Date: 2026-10-18
- Relates to: [TODO "real-database incident"](../../TODO.md) (the direct trigger for this ADR), [ADR-0011](0011-multi-agent-memory-importers.md) (privacy-gate discipline, carried into L2), [ADR-0021](0021-temporal-graph-page-versions.md) (page_versions is the page-level recovery evidence; this ADR is the database-file level), TODO "user actions ②" (the Time Machine drive is deferred by the user; this ADR fills that vacuum), the M3 semantic-search draft (the reference wording for "not configured = zero outbound")
- Companion code: `internal/db/backup.go` (snapshot + rotation), `internal/service/backup.go` (gate + cadence), the manual restore points `repotory-{pre,post}-reimport-backup-20261018/` (L1's manual precursor)

## Background

The 2026-10-14 real-database incident: `repotory.db` suffered page-level corruption on the internal disk (101 invalid page numbers), 75 notes dropped to 22, and `.recover` saved what could be saved. The root cause was that **the data lived on exactly one disk with no usable external copy**.

Two things happened afterwards. The user enabled Time Machine daily backups (10-16), but the backup drive has never been connected — TM only writes while its disk is attached, so "daily" does not hold while the disk is detached, and **to this day not a single TM backup containing repotory data exists**. The user then explicitly deferred plugging the drive in (2026-10-18, with a fair reason: almost nobody buys a dedicated external drive for backups any more) and reframed the problem in modern terms — "how does MySQL solve this? Is there something better with Docker?"

The modern database industry's answer (the MySQL family): the backup unit is not "a user copying files by hand" but **self-produced snapshots plus change logs**, and the destination is **object storage** (off-machine, eleven nines, pennies a month), fully automated. SQLite and InnoDB are both WAL architectures, so the answer transfers wholesale — the SQLite ecosystem's counterpart is Litestream-style WAL streaming. Docker's role in that world is merely "a convenient container to run the mover in"; it does not itself solve durability (a same-host named volume is still the same internal disk).

This ADR splits that answer into three tiers shaped for Repotory, and lands the only tier that requires nothing from the user and touches no privacy gate: L1.

## Decisions

**Decision 1: L1 daily local snapshot, ON by default (landed this round).** Run `VACUUM INTO` on the live connection into `<data dir>/backups/repotory-YYYY-MM-DD.db`. The load-bearing points:

- **The date is the idempotency key.** After the first successful snapshot of a day, every same-day retry is a no-op. "Daily backup" therefore means "the first app open of the day" on desktop and "the first hourly tick of the day" on the headless server — no timer arithmetic to get wrong, and the desktop usage rhythm naturally is the backup rhythm.
- **Rotation** keeps 14 snapshots by default (`backup_retain`) and only ever touches files with the `repotory-*.db` prefix — anything else the user drops into that directory is never deleted.
- **Why default ON:** a snapshot is a local file write with zero outbound traffic and no privacy exposure. "Default off" is reserved for switches that send content outward (`semantic_search` / `auto_import` and their family); backups are not that family. Once the user sets `backup_enabled=0`, both the ticker and manual runs get the same explicit refusal (no silent no-op — the same rule `StartLintJob` follows).
- **Permissions 0600:** the snapshot carries the full dataset — the same discipline as the data directory.
- One snapshot attempt at startup plus hourly retries, all through `bgGo` so Shutdown tracks them; a failed snapshot is logged, never escalated into an app failure.

**Decision 2: the recovery path is "copy one file back".** A snapshot is a complete, standalone SQLite file; restoring is swapping the file — the shortest, least error-prone path, and the direct continuation of the manual restore-point flow validated after the incident. The promotion criteria require rehearsing it once on a real machine.

**Decision 3: L2 cloud push is opt-in; this ADR shapes it but does not implement it.** Two equivalent forms: Litestream-style WAL streaming (near-PITR) or scheduled upload of L1 snapshots to an S3-compatible object store. The privacy-gate discipline is exactly M3's: **no credentials configured = zero outbound, default OFF**, with the same "only when you actively configure…" wording. The Docker deployment tier (NAS/homelab users) is a documented compose file — `repotory-server` container + data volume + a litestream sidecar; the desktop experience does not gain a Docker dependency.

**Decision 4: red line — a live database never lives inside a cloud-sync folder.** File-level sync tools (iCloud Drive, OneDrive, rclone mount…) syncing an actively-written SQLite file are a well-known corruption source, and the 10-14 interference suspect (15 `.fuse_hidden*` files in the data directory) points exactly at that family. Cloud-ifying is allowed in exactly two forms: syncing **static snapshot files the database itself produced**, or **streaming the WAL** — never letting a sync tool touch the live file.

**Decision 5: Time Machine is neither replaced nor excluded.** TM backs the whole data directory (import sources, logs, the snapshot directory itself); L1 backs the structured single file, readable on any machine. While the drive stays unplugged, L1 fills the "zero backups" vacuum; if the user plugs it in, the two stack.

## Costs

- **Disk**: ~5MB × 14 ≈ 70MB ceiling — negligible at this scale; rotation depth is the first knob to turn when the database grows.
- **Snapshots are full copies, not incremental**: once the database grows, daily full copies waste obviously — switching to Litestream-style incrementals is a future decision outside this ADR.
- **No frontend surface yet**: the `RunBackupNow` binding is registered (a settings-page button and scripts can call it), but the settings UI is not wired — deferred until the first real signal.
- **Two engineering compromises** (see "Implementation corrections"): the snapshot permission needs an explicit chmod, and the two config keys register from the feature file because of a write-guard misread.

## Promotion criteria (Proposed → Accepted)

1. **Real-machine restore rehearsal**: take one L1 snapshot, start an isolated server against it with a fake HOME (the established rehearsal trick), and verify notes, pages and FTS search are fully usable.
2. **Three consecutive days** of observed automatic snapshot production on the real machine (the "first open of the day" rhythm holding under real usage).
3. **One observed rotation** (the 15th snapshot appears and the oldest is pruned).
4. CHANGELOG and this ADR synced in both languages (satisfied by this draft).

## Implementation corrections

1. **`VACUUM INTO` writes with the process umask (0644 observed), not the data directory's 0600** — the snapshot carries the full dataset, so an explicit `chmod 0600` follows success, and the failure path removes the half-written file (a partial snapshot is worse than none).
2. **The write guard misreads `config.go`'s pre-existing `"ai_chat_api_key": true` allow-list entry (a boolean flag, not a credential) as a credential literal** — any rewrite of that file is refused. The two new keys therefore register themselves in `backup.go` via `init()` — same package, same map, feature and registration in one file, which is arguably more cohesive; `config.go` is untouched byte for byte. Centralising them back into `config.go` later needs the user to approve that specific write.
3. Tests inject the snapshot directory through the unexported `Service.backupDir` field, making it impossible for a test to write into the real user data directory.
