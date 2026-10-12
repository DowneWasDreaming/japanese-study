PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS content (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('word','grammar','kana')),
  level TEXT NOT NULL, title TEXT NOT NULL, reading TEXT NOT NULL DEFAULT '', summary TEXT NOT NULL,
  body_json TEXT NOT NULL, examples_json TEXT NOT NULL, knowledge_points_json TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'builtin'
);
CREATE TABLE IF NOT EXISTS question_bank (
  id TEXT PRIMARY KEY, level TEXT NOT NULL, category TEXT NOT NULL, type TEXT NOT NULL,
  question_json TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'builtin'
);
CREATE TABLE IF NOT EXISTS saved (
  content_id TEXT NOT NULL REFERENCES content(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK(type IN ('word','grammar','favorite')), created_at TEXT NOT NULL,
  PRIMARY KEY(content_id,type)
);
CREATE TABLE IF NOT EXISTS exams (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, level TEXT NOT NULL, category TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('practice','exam')), source TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft', created_at TEXT NOT NULL, submitted_at TEXT,
  questions_json TEXT NOT NULL, config_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS answers (
  exam_id TEXT NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  question_id TEXT NOT NULL, answer TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY(exam_id, question_id)
);
CREATE TABLE IF NOT EXISTS grades (
  exam_id TEXT NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  question_id TEXT NOT NULL, status TEXT NOT NULL, score REAL, max_score REAL NOT NULL,
  correct INTEGER, feedback TEXT NOT NULL DEFAULT '', suggestion TEXT NOT NULL DEFAULT '',
  reference TEXT NOT NULL DEFAULT '', error TEXT, updated_at TEXT NOT NULL,
  PRIMARY KEY(exam_id, question_id)
);
CREATE TABLE IF NOT EXISTS mistakes (
  question_id TEXT PRIMARY KEY, question_json TEXT NOT NULL, exam_id TEXT NOT NULL,
  level TEXT NOT NULL, type TEXT NOT NULL, errors INTEGER NOT NULL DEFAULT 1,
  last_practiced TEXT NOT NULL, knowledge_points_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS grading_events (
  exam_id TEXT NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  question_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(exam_id,question_id)
);
CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY, exam_id TEXT NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  question_id TEXT NOT NULL, note TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, kind TEXT NOT NULL,
  level TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('user','assistant')), content TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS explanation_cache (
  cache_key TEXT PRIMARY KEY, kind TEXT NOT NULL, level TEXT NOT NULL, input TEXT NOT NULL,
  text TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_content_kind_level ON content(kind,level);
CREATE INDEX IF NOT EXISTS idx_bank_level_type ON question_bank(level,type);
CREATE INDEX IF NOT EXISTS idx_exams_created ON exams(created_at);
CREATE INDEX IF NOT EXISTS idx_mistakes_level ON mistakes(level,type);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id,id);
CREATE TABLE IF NOT EXISTS local_ai_requests (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at INTEGER NOT NULL);
