-- Hermes state.db sample (ADR-0011 decision 5).
-- Layout confirmed against TencentCloud/TencentDB-Agent-Memory's
-- shipped asset importer: a messages table keyed by session_id, plus
-- a sessions table this importer does NOT read (it is here because the
-- real file has it — a sample that omits a table would not catch a
-- schema change in the other direction).
CREATE TABLE messages (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	session_id TEXT, role TEXT, content TEXT,
	tool_call_id TEXT, tool_calls TEXT, tool_name TEXT, timestamp REAL);
CREATE TABLE sessions (session_id TEXT, meta TEXT);
INSERT INTO messages(session_id, role, content, timestamp) VALUES
	('sess-alpha-0001', 'user', '帮我修一下 auth 的 token 刷新', 100),
	('sess-alpha-0001', 'assistant', '', 101),
	('sess-alpha-0001', 'tool', 'tool output noise', 102),
	('sess-alpha-0001', 'assistant', '已修复，记得轮换生产 cookie key', 103),
	('sess-bravo-0002', 'user', '解释一下 grouper 的 monorepo 规则', 200),
	('sess-bravo-0002', 'assistant', '父目录含多个子仓库时归为一个项目', 201),
	('sess-toolonly', 'user', '', 300);
