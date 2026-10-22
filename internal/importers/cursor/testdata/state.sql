-- Cursor state.vscdb sample (ADR-0011 decision 5).
-- Two tables, the messy rows the importer must survive: a subagent
-- session, an empty-window session, an unknown workspace, bubbles
-- written out of createdAt order, an unknown sender, a malformed
-- value and an empty-text bubble.
CREATE TABLE composerHeaders (
			composerId TEXT PRIMARY KEY, workspaceId TEXT, createdAt INTEGER,
			lastUpdatedAt INTEGER, isArchived INTEGER, isSubagent INTEGER,
			recency INTEGER, checkpointAt INTEGER, value TEXT, subagentTypeName TEXT);
CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value BLOB);
INSERT INTO composerHeaders
	(composerId, workspaceId, createdAt, lastUpdatedAt, isArchived, isSubagent)
	VALUES
	('11111111-1111-1111-1111-111111111111', '87d6b92a30e184ca731bbd6532a00631', 1700000000000, 1700000900000, 0, 0),
	('22222222-2222-2222-2222-222222222222', '87d6b92a30e184ca731bbd6532a00631', 1700001000000, 1700001900000, 0, 1),
	('33333333-3333-3333-3333-333333333333', '0000000000000000000000000000dead', 1700002000000, 1700002900000, 0, 0),
	('44444444-4444-4444-4444-444444444444', 'empty-window', 1700003000000, 1700003900000, 0, 0);
INSERT INTO cursorDiskKV (key, value) VALUES
	('bubbleId:11111111-1111-1111-1111-111111111111:bbbb0002-last-question', '{"_v":1,"createdAt":"2026-07-16T07:55:13.735Z","text":"answer two — the last reply","type":2}'),
	('bubbleId:11111111-1111-1111-1111-111111111111:bbbb0003', '{"_v":1,"createdAt":"2026-07-16T07:55:20.000Z","text":"second user turn","type":1}'),
	('bubbleId:11111111-1111-1111-1111-111111111111:bbbb0001-first-question', '{"_v":1,"createdAt":"2026-07-16T07:55:09.326Z","text":"first prompt of the session","type":1}'),
	('bubbleId:11111111-1111-1111-1111-111111111111:bbbb0004-answer-one', '{"_v":1,"createdAt":"2026-07-16T07:55:12.000Z","text":"answer one","type":2}'),
	('bubbleId:11111111-1111-1111-1111-111111111111:bbbb0005-unknown-sender', '{"_v":1,"createdAt":"2026-07-16T07:56:00.000Z","text":"system-ish noise","type":9}'),
	('bubbleId:11111111-1111-1111-1111-111111111111:bbbb0006-malformed', 'this-is-not-json{{'),
	('bubbleId:11111111-1111-1111-1111-111111111111:bbbb0007-empty', '{"_v":1,"createdAt":"2026-07-16T07:57:00.000Z","text":"   ","type":1}'),
	('bubbleId:22222222-2222-2222-2222-222222222222:cccc0001', '{"_v":1,"createdAt":"2026-07-16T08:00:00.000Z","text":"subagent prompt","type":1}'),
	('bubbleId:33333333-3333-3333-3333-333333333333:dddd0001', '{"_v":1,"createdAt":"2026-07-16T09:00:00.000Z","text":"orphan session","type":1}'),
	('bubbleId:44444444-4444-4444-4444-444444444444:eeee0001', '{"_v":1,"createdAt":"2026-07-16T10:00:00.000Z","text":"no workspace","type":1}'),
	('composerData:11111111-1111-1111-1111-111111111111', '{"composerId":"x"}');
