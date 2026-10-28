ALTER TABLE review_points ADD COLUMN usage_key TEXT NOT NULL DEFAULT '';
ALTER TABLE review_points ADD COLUMN verification_json TEXT;
ALTER TABLE review_points ADD COLUMN merged_into TEXT REFERENCES review_points(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX idx_review_points_merged ON review_points(merged_into);
