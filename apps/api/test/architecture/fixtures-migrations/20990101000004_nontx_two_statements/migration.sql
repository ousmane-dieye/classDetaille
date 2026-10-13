-- classification: expand
-- non-transactional
CREATE INDEX CONCURRENTLY a_idx ON app.ok (id);
CREATE INDEX CONCURRENTLY b_idx ON app.ok (id);
