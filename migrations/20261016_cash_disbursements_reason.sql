BEGIN;

ALTER TABLE cash_disbursements
    ADD COLUMN IF NOT EXISTS reason TEXT;

COMMIT;
