-- ============================================================
-- RTMS — Road Traffic Management System
-- Database Schema v2.0
-- © SEUSHI, ANWAR 2025 | Dar es Salaam, Tanzania
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ─── USERS ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  username      VARCHAR(60)  NOT NULL UNIQUE,
  password_hash TEXT         NOT NULL,
  full_name     VARCHAR(120) NOT NULL,
  email         VARCHAR(120) UNIQUE,
  phone         VARCHAR(20),
  national_id   VARCHAR(40),
  role          VARCHAR(20)  NOT NULL DEFAULT 'USER'
                CHECK (role IN ('ADMIN','OFFICER','CASHIER','USER')),
  badge_number  VARCHAR(30),
  is_active     BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  last_login    TIMESTAMPTZ
);

-- ─── VEHICLES ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS vehicles (
  id                  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  plate_number        VARCHAR(20)  NOT NULL UNIQUE,
  owner_name          VARCHAR(120) NOT NULL,
  owner_phone         VARCHAR(20),
  owner_email         VARCHAR(120),
  owner_national_id   VARCHAR(40),
  owner_address       VARCHAR(200),
  make                VARCHAR(60),
  model               VARCHAR(60),
  color               VARCHAR(40),
  year                INTEGER,
  chassis_number      VARCHAR(60),
  engine_number       VARCHAR(60),
  registration_expiry DATE,
  status              VARCHAR(20)  NOT NULL DEFAULT 'ACTIVE'
                      CHECK (status IN ('ACTIVE','EXPIRED','SUSPENDED','STOLEN')),
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vehicles_plate  ON vehicles (plate_number);
CREATE INDEX IF NOT EXISTS idx_vehicles_status ON vehicles (status);

-- ─── FINE AMOUNTS ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS fine_amounts (
  violation_type      VARCHAR(60)   PRIMARY KEY,
  base_amount_tzs     NUMERIC(12,2) NOT NULL,
  overdue_multiplier  NUMERIC(4,2)  NOT NULL DEFAULT 1.5
);

INSERT INTO fine_amounts (violation_type, base_amount_tzs, overdue_multiplier) VALUES
  ('RED_LIGHT',        150000, 1.5),
  ('SPEEDING',         200000, 1.5),
  ('ILLEGAL_PARKING',   50000, 1.5),
  ('WRONG_WAY',        300000, 2.0),
  ('NO_SEATBELT',       30000, 1.5),
  ('PHONE_USE',         50000, 1.5),
  ('PEDESTRIAN_ZONE',  100000, 1.5),
  ('EXPIRED_PLATE',     80000, 1.5)
ON CONFLICT (violation_type) DO NOTHING;

-- ─── VIOLATIONS ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS violations (
  id                  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id          UUID         NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  camera_id           VARCHAR(30)  NOT NULL,
  violation_type      VARCHAR(60)  NOT NULL,
  confidence_score    NUMERIC(5,3) NOT NULL CHECK (confidence_score BETWEEN 0 AND 1),
  evidence_image_url  TEXT,
  occurred_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  gps_lat             NUMERIC(10,7),
  gps_lng             NUMERIC(10,7),
  reviewed_by         UUID         REFERENCES users(id),
  reviewed_at         TIMESTAMPTZ,
  review_notes        TEXT,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_violations_vehicle   ON violations (vehicle_id);
CREATE INDEX IF NOT EXISTS idx_violations_camera    ON violations (camera_id);
CREATE INDEX IF NOT EXISTS idx_violations_occurred  ON violations (occurred_at DESC);

-- ─── FINES ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS fines (
  id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  violation_id    UUID          NOT NULL UNIQUE REFERENCES violations(id) ON DELETE CASCADE,
  fine_number     VARCHAR(30)   NOT NULL UNIQUE,
  amount_tzs      NUMERIC(12,2) NOT NULL,
  penalty_amount  NUMERIC(12,2) NOT NULL DEFAULT 0,
  status          VARCHAR(20)   NOT NULL DEFAULT 'ISSUED'
                  CHECK (status IN ('PENDING','ISSUED','PAID','OVERDUE','APPEALED','CANCELLED','COURT_REFERRED')),
  due_date        DATE,
  issued_at       TIMESTAMPTZ   DEFAULT NOW(),
  paid_at         TIMESTAMPTZ,
  overdue_at      TIMESTAMPTZ,
  cancelled_by    UUID          REFERENCES users(id),
  cancelled_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_fines_status      ON fines (status);
CREATE INDEX IF NOT EXISTS idx_fines_fine_number ON fines (fine_number);
CREATE INDEX IF NOT EXISTS idx_fines_due_date    ON fines (due_date);

-- ─── PAYMENTS ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payments (
  id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  fine_id         UUID          NOT NULL REFERENCES fines(id) ON DELETE CASCADE,
  amount_tzs      NUMERIC(12,2) NOT NULL,
  payment_method  VARCHAR(30)   NOT NULL DEFAULT 'CASH'
                  CHECK (payment_method IN ('CASH','MOBILE_MONEY','BANK_TRANSFER','CARD')),
  provider        VARCHAR(60),
  transaction_ref VARCHAR(100)  UNIQUE,
  status          VARCHAR(20)   NOT NULL DEFAULT 'SUCCESS'
                  CHECK (status IN ('PENDING','SUCCESS','FAILED','REVERSED')),
  received_by     UUID          REFERENCES users(id),
  paid_at         TIMESTAMPTZ   DEFAULT NOW(),
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payments_fine_id ON payments (fine_id);
CREATE INDEX IF NOT EXISTS idx_payments_txn_ref ON payments (transaction_ref);

-- ─── APPEALS ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS appeals (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  fine_id         UUID        NOT NULL REFERENCES fines(id) ON DELETE CASCADE,
  reason          TEXT        NOT NULL,
  supporting_docs JSONB       DEFAULT '[]',
  status          VARCHAR(20) NOT NULL DEFAULT 'PENDING'
                  CHECK (status IN ('PENDING','UPHELD','DISMISSED')),
  decision_notes  TEXT,
  reviewed_by     UUID        REFERENCES users(id),
  decided_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_appeals_fine_id ON appeals (fine_id);
CREATE INDEX IF NOT EXISTS idx_appeals_status  ON appeals (status);

-- ─── NOTIFICATIONS ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notifications (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  fine_id     UUID         NOT NULL REFERENCES fines(id) ON DELETE CASCADE,
  channel     VARCHAR(20)  NOT NULL CHECK (channel IN ('SMS','EMAIL','PUSH')),
  recipient   VARCHAR(120) NOT NULL,
  message     TEXT         NOT NULL,
  status      VARCHAR(20)  NOT NULL DEFAULT 'PENDING'
              CHECK (status IN ('PENDING','SENT','FAILED')),
  sent_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notifications_fine_id ON notifications (fine_id);
CREATE INDEX IF NOT EXISTS idx_notifications_status  ON notifications (status);

-- ─── VIEWS ────────────────────────────────────────────────────
CREATE OR REPLACE VIEW v_fine_detail AS
SELECT
  f.id, f.fine_number, f.amount_tzs, f.penalty_amount,
  f.status, f.due_date, f.issued_at, f.paid_at,
  v.violation_type, v.occurred_at, v.camera_id,
  v.confidence_score, v.evidence_image_url,
  v.gps_lat, v.gps_lng,
  vh.plate_number, vh.owner_name, vh.owner_phone, vh.owner_email,
  vh.make, vh.model, vh.color, vh.year
FROM fines f
JOIN violations v  ON v.id  = f.violation_id
JOIN vehicles   vh ON vh.id = v.vehicle_id;

CREATE OR REPLACE VIEW v_dashboard_stats AS
SELECT
  COUNT(*)                                                        AS total_fines,
  COUNT(*) FILTER (WHERE status = 'PAID')                         AS paid,
  COUNT(*) FILTER (WHERE status = 'OVERDUE')                      AS overdue,
  COUNT(*) FILTER (WHERE status = 'APPEALED')                     AS appealed,
  COUNT(*) FILTER (WHERE status = 'ISSUED')                       AS pending_payment,
  COUNT(*) FILTER (WHERE status = 'COURT_REFERRED')               AS court_referred,
  COALESCE(SUM(amount_tzs + penalty_amount)
    FILTER (WHERE status = 'PAID'), 0)                            AS total_collected_tzs,
  COALESCE(SUM(amount_tzs + penalty_amount)
    FILTER (WHERE status IN ('ISSUED','OVERDUE')), 0)             AS total_outstanding_tzs
FROM fines;

-- ─── ADD MISSING COLUMNS (safe to run on existing DB) ─────────
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS owner_national_id VARCHAR(40);
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS owner_address     VARCHAR(200);
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS year              INTEGER;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS chassis_number    VARCHAR(60);
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS engine_number     VARCHAR(60);
ALTER TABLE vehicles ALTER COLUMN owner_phone        DROP NOT NULL;
ALTER TABLE vehicles ALTER COLUMN registration_expiry DROP NOT NULL;
