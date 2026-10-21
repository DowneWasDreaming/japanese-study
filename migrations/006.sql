CREATE TABLE IF NOT EXISTS review_points (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('word','grammar','expression')),level TEXT NOT NULL,
  scope TEXT NOT NULL CHECK(scope IN ('broad','context')),focus TEXT NOT NULL,
  reading TEXT NOT NULL DEFAULT '',meaning TEXT NOT NULL DEFAULT '',note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK(status IN ('draft','active','mastered','paused')),
  stage INTEGER NOT NULL DEFAULT 0 CHECK(stage BETWEEN 0 AND 7),due_at TEXT,last_reviewed_at TEXT,
  repetitions INTEGER NOT NULL DEFAULT 0,lapses INTEGER NOT NULL DEFAULT 0,
  normalization_status TEXT NOT NULL CHECK(normalization_status IN ('none','pending','completed','failed')),
  candidate_json TEXT,error TEXT,canonical_key TEXT UNIQUE,
  created_at TEXT NOT NULL,updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_review_points_due ON review_points(status,level,due_at);
CREATE TABLE IF NOT EXISTS review_sources (
  id TEXT PRIMARY KEY,point_id TEXT NOT NULL REFERENCES review_points(id) ON DELETE CASCADE,
  exam_id TEXT REFERENCES exams(id) ON DELETE SET NULL,question_id TEXT,
  source TEXT NOT NULL CHECK(source IN ('prompt','passage','option','manual')),option_id TEXT NOT NULL DEFAULT '',
  start_offset INTEGER NOT NULL,end_offset INTEGER NOT NULL,text TEXT NOT NULL,
  context TEXT NOT NULL,question_prompt TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_review_sources_point ON review_sources(point_id);
CREATE TABLE IF NOT EXISTS review_events (
  id TEXT PRIMARY KEY,point_id TEXT NOT NULL REFERENCES review_points(id) ON DELETE CASCADE,
  exam_id TEXT REFERENCES exams(id) ON DELETE SET NULL,rating TEXT NOT NULL CHECK(rating IN ('again','hard','good','mastered')),
  request_id TEXT NOT NULL,reviewed_at TEXT NOT NULL,previous_stage INTEGER NOT NULL,stage INTEGER NOT NULL,
  previous_status TEXT NOT NULL,status TEXT NOT NULL,due_at TEXT,UNIQUE(point_id,request_id)
);
CREATE INDEX IF NOT EXISTS idx_review_events_point ON review_events(point_id,reviewed_at);

-- Expand the diagnostic operation allowlist without discarding old records.
CREATE TABLE ai_failures_review_upgrade (
  id TEXT PRIMARY KEY,created_at TEXT NOT NULL,
  operation TEXT NOT NULL CHECK(operation IN ('generate','grade','annotation','explain','followup','models','connection','auth','review')),
  category TEXT NOT NULL CHECK(category IN ('network','upstream','validation','permission','quota','interrupted','local')),
  code TEXT NOT NULL,message TEXT NOT NULL,
  http_status INTEGER,upstream_status INTEGER,request_id TEXT,upstream_message TEXT,detail TEXT,
  exam_id TEXT REFERENCES exams(id) ON DELETE CASCADE,question_id TEXT,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
  annotation_ids_json TEXT NOT NULL DEFAULT '[]',model TEXT,
  source TEXT NOT NULL CHECK(source IN ('live','legacy','recovery')),
  stage TEXT,network_code TEXT,response_id TEXT
);
INSERT INTO ai_failures_review_upgrade SELECT * FROM ai_failures;
DROP TABLE ai_failures;
ALTER TABLE ai_failures_review_upgrade RENAME TO ai_failures;
CREATE INDEX idx_ai_failures_created ON ai_failures(created_at DESC,id DESC);
CREATE INDEX idx_ai_failures_exam ON ai_failures(exam_id,created_at DESC);
