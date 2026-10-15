CREATE TABLE IF NOT EXISTS exam_qa_turns (
  id TEXT PRIMARY KEY,
  exam_id TEXT NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  question_id TEXT NOT NULL,
  user_text TEXT NOT NULL,
  assistant_text TEXT,
  status TEXT NOT NULL CHECK(status IN ('queued','pending','completed','failed')),
  error TEXT,
  client_request_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(exam_id,client_request_id)
);
CREATE INDEX IF NOT EXISTS idx_exam_qa_question ON exam_qa_turns(exam_id,question_id,created_at,id);
