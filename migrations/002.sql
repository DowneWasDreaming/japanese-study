CREATE TABLE IF NOT EXISTS exam_annotations (
  id TEXT PRIMARY KEY,
  exam_id TEXT NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  question_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('prompt','passage','option')),
  option_id TEXT NOT NULL DEFAULT '',
  start_offset INTEGER NOT NULL CHECK(start_offset >= 0),
  end_offset INTEGER NOT NULL CHECK(end_offset > start_offset),
  text TEXT NOT NULL CHECK(length(text) > 0),
  status TEXT NOT NULL CHECK(status IN ('marked','pending','completed','failed')),
  explanation_json TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(exam_id,question_id,source,option_id,start_offset,end_offset)
);
CREATE INDEX IF NOT EXISTS idx_annotations_exam ON exam_annotations(exam_id,question_id,created_at,id);
