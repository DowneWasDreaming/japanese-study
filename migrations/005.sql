CREATE TABLE IF NOT EXISTS ai_token_usage (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  model TEXT NOT NULL,
  response_id TEXT,
  status TEXT NOT NULL CHECK(status IN ('completed','failed')),
  usage_state TEXT NOT NULL CHECK(usage_state IN ('reported','unavailable')),
  input_tokens INTEGER CHECK(input_tokens >= 0),
  output_tokens INTEGER CHECK(output_tokens >= 0),
  total_tokens INTEGER CHECK(total_tokens >= 0),
  cached_tokens INTEGER CHECK(cached_tokens >= 0),
  reasoning_tokens INTEGER CHECK(reasoning_tokens >= 0)
);
CREATE INDEX IF NOT EXISTS idx_ai_token_usage_created ON ai_token_usage(created_at);
CREATE TABLE IF NOT EXISTS ai_token_usage_metadata (key TEXT PRIMARY KEY,value TEXT NOT NULL);
INSERT OR IGNORE INTO ai_token_usage_metadata(key,value) VALUES ('collection_started_at',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
