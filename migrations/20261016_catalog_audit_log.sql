BEGIN;

CREATE TABLE IF NOT EXISTS catalog_audit_log (
    id BIGSERIAL PRIMARY KEY,
    entity VARCHAR(30) NOT NULL CHECK (entity IN ('customers', 'products', 'warehouses')),
    record_id INTEGER NOT NULL,
    action VARCHAR(20) NOT NULL DEFAULT 'UPDATE' CHECK (action = 'UPDATE'),
    old_values JSONB NOT NULL,
    new_values JSONB NOT NULL,
    changed_by VARCHAR(100) NOT NULL DEFAULT 'System',
    changed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_catalog_audit_log_entity_record_changed_at
    ON catalog_audit_log (entity, record_id, changed_at DESC);

COMMIT;
