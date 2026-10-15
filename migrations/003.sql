CREATE TABLE IF NOT EXISTS ai_failures (
  id TEXT PRIMARY KEY, created_at TEXT NOT NULL,
  operation TEXT NOT NULL CHECK(operation IN ('generate','grade','annotation','explain','followup','models','connection','auth')),
  category TEXT NOT NULL CHECK(category IN ('network','upstream','validation','permission','quota','interrupted','local')),
  code TEXT NOT NULL, message TEXT NOT NULL,
  http_status INTEGER, upstream_status INTEGER, request_id TEXT, upstream_message TEXT, detail TEXT,
  exam_id TEXT REFERENCES exams(id) ON DELETE CASCADE, question_id TEXT,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
  annotation_ids_json TEXT NOT NULL DEFAULT '[]', model TEXT,
  source TEXT NOT NULL CHECK(source IN ('live','legacy','recovery')),
  stage TEXT, network_code TEXT, response_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_ai_failures_created ON ai_failures(created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS idx_ai_failures_exam ON ai_failures(exam_id,created_at DESC);
