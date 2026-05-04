-- ============================================================
-- Smart Traffic System — Fines & Payments Database Schema
-- PostgreSQL 14+
-- Updated: full field descriptions matching ERD
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ─── VEHICLES ────────────────────────────────────────────────
-- Stores every registered vehicle and its owner contact details.
-- plate_number is the primary lookup key used by the ALPR system.
CREATE TABLE vehicles (
  id                  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  plate_number        VARCHAR(20)  NOT NULL UNIQUE,        -- e.g. T123ABC
  owner_name          VARCHAR(120) NOT NULL,               -- Full legal name
  owner_phone         VARCHAR(20)  NOT NULL,               -- Mobile e.g. +255712345678
  owner_email         VARCHAR(120),                        -- Optional contact
  make                VARCHAR(60),                         -- e.g. Toyota
  model               VARCHAR(60),                         -- e.g. Corolla
  color               VARCHAR(40),                         -- e.g. White
  registration_expiry DATE         NOT NULL,               -- Licence expiry date
  status              VARCHAR(20)  NOT NULL DEFAULT 'ACTIVE'
                      CHECK (status IN ('ACTIVE','EXPIRED','SUSPENDED','STOLEN')),
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(), -- Record created
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()  -- Last modified
);

CREATE INDEX idx_vehicles_plate  ON vehicles (plate_number);
CREATE INDEX idx_vehicles_status ON vehicles (status);

-- ─── FINE AMOUNTS LOOKUP ──────────────────────────────────────
-- Standard fine amounts per violation type in Tanzanian Shillings (TZS).
-- This table is the single source of truth for pricing.
-- overdue_multiplier: e.g. 1.5 means 50% surcharge when overdue.
CREATE TABLE fine_amounts (
  violation_type      VARCHAR(60)   PRIMARY KEY,           -- Matches violations.violation_type
  base_amount_tzs     NUMERIC(12,2) NOT NULL,              -- Standard fine in TZS
  overdue_multiplier  NUMERIC(4,2)  NOT NULL DEFAULT 1.5   -- Default 1.5x on overdue
);

INSERT INTO fine_amounts (violation_type, base_amount_tzs, overdue_multiplier) VALUES
  ('RED_LIGHT',        15000, 1.5),
  ('SPEEDING',         20000, 1.5),
  ('ILLEGAL_PARKING',   50000, 1.5),
  ('WRONG_WAY',        30000, 2.0),
  ('NO_SEATBELT',       30000, 1.5),
  ('PHONE_USE',         50000, 1.5),
  ('PEDESTRIAN_ZONE',  15000, 1.5),
  ('EXPIRED_PLATE',     50000, 1.5);

-- ─── VIOLATIONS ──────────────────────────────────────────────
-- Every detected road violation captured by a camera or sensor.
-- confidence_score: AI certainty 0.00–1.00. Below 0.85 goes to human review.
-- evidence_image_url is mandatory; video is optional but recommended.
-- reviewed_by: populated when a human officer verifies the detection.
CREATE TABLE violations (
  id                  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id          UUID         NOT NULL REFERENCES vehicles(id),
  camera_id           VARCHAR(60)  NOT NULL,               -- Camera unit ID
  violation_type      VARCHAR(60)  NOT NULL
                      REFERENCES fine_amounts(violation_type),
  confidence_score    NUMERIC(4,3) NOT NULL
                      CHECK (confidence_score BETWEEN 0 AND 1), -- 0.00–1.00 AI score
  evidence_image_url  TEXT         NOT NULL,               -- S3 snapshot URL (mandatory)
  evidence_video_url  TEXT,                                -- S3 clip URL (optional)
  occurred_at         TIMESTAMPTZ  NOT NULL,               -- When it happened
  gps_lat             NUMERIC(10,7),                       -- Location latitude
  gps_lng             NUMERIC(10,7),                       -- Location longitude
  reviewed_by         VARCHAR(80),                         -- Officer who verified
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()  -- Record created
);

CREATE INDEX idx_violations_vehicle    ON violations (vehicle_id);
CREATE INDEX idx_violations_type       ON violations (violation_type);
CREATE INDEX idx_violations_occurred   ON violations (occurred_at DESC);
CREATE INDEX idx_violations_confidence ON violations (confidence_score);
CREATE INDEX idx_violations_camera     ON violations (camera_id);

-- ─── FINES ───────────────────────────────────────────────────
-- One fine is generated per violation. Tracks the full payment lifecycle.
-- fine_number: human-readable reference shown to owner e.g. TRF-0012345.
-- amount_tzs: base fine copied from fine_amounts at issue time (immutable).
-- penalty_amount: surcharge added when overdue (50% by default).
-- Status lifecycle:
--   PENDING → ISSUED → PAID
--                    → APPEALED → CANCELLED (upheld) | ISSUED (dismissed)
--                    → OVERDUE → COURT_REFERRED
CREATE TABLE fines (
  id                  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  violation_id        UUID         NOT NULL UNIQUE REFERENCES violations(id),
  fine_number         VARCHAR(20)  NOT NULL UNIQUE
                      DEFAULT 'TRF-' || LPAD(FLOOR(RANDOM()*9999999)::TEXT, 7, '0'),
  amount_tzs          NUMERIC(12,2) NOT NULL,              -- Base fine in TZS (immutable after issue)
  penalty_amount      NUMERIC(12,2) NOT NULL DEFAULT 0,    -- Overdue surcharge in TZS
  status              VARCHAR(20)  NOT NULL DEFAULT 'PENDING'
                      CHECK (status IN (
                        'PENDING',         -- Created, not yet sent to owner
                        'ISSUED',          -- Owner notified, awaiting payment
                        'PAID',            -- Payment confirmed
                        'APPEALED',        -- Owner has filed an appeal
                        'OVERDUE',         -- Past due_date, penalty applied
                        'CANCELLED',       -- Appeal upheld or admin cancellation
                        'COURT_REFERRED'   -- Escalated after 60+ days overdue
                      )),
  due_date            DATE         NOT NULL,               -- Payment deadline (issued + 30 days)
  issued_at           TIMESTAMPTZ,                         -- When fine was issued to owner
  paid_at             TIMESTAMPTZ,                         -- When payment was confirmed
  overdue_at          TIMESTAMPTZ,                         -- When fine became overdue
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(), -- Record created
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()  -- Last modified
);

CREATE INDEX idx_fines_status      ON fines (status);
CREATE INDEX idx_fines_due_date    ON fines (due_date);
CREATE INDEX idx_fines_violation   ON fines (violation_id);
CREATE INDEX idx_fines_fine_number ON fines (fine_number);

-- ─── PAYMENTS ────────────────────────────────────────────────
-- Records every payment attempt against a fine.
-- transaction_ref is unique — prevents duplicate payments from providers.
-- Multiple rows can exist per fine (e.g. FAILED attempt, then SUCCESS).
-- REVERSED allows refunds when appeals are upheld after payment.
CREATE TABLE payments (
  id                  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  fine_id             UUID         NOT NULL REFERENCES fines(id),
  amount_tzs          NUMERIC(12,2) NOT NULL,              -- Amount paid in TZS
  payment_method      VARCHAR(30)  NOT NULL
                      CHECK (payment_method IN (
                        'MOBILE_MONEY',   -- M-Pesa, Tigo Pesa, Airtel Money, HaloPesa
                        'BANK_TRANSFER',  -- Direct bank transfer
                        'CASH',           -- Over-the-counter at traffic office
                        'CARD'            -- Debit / credit card
                      )),
  provider            VARCHAR(60),                         -- e.g. M-Pesa, Tigo Pesa, Airtel Money, HaloPesa
  transaction_ref     VARCHAR(120) NOT NULL UNIQUE,        -- Provider txn ID (must be unique)
  status              VARCHAR(20)  NOT NULL DEFAULT 'SUCCESS'
                      CHECK (status IN (
                        'SUCCESS',        -- Payment confirmed
                        'FAILED',         -- Payment attempt failed
                        'REVERSED'        -- Refunded e.g. after upheld appeal
                      )),
  paid_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW(), -- Transaction timestamp
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()  -- Record created
);

CREATE INDEX idx_payments_fine   ON payments (fine_id);
CREATE INDEX idx_payments_ref    ON payments (transaction_ref);
CREATE INDEX idx_payments_status ON payments (status);

-- ─── APPEALS ─────────────────────────────────────────────────
-- An owner can file one appeal per fine while status is ISSUED or PENDING.
-- supporting_docs: array of S3 URLs (photos, dashcam footage, documents).
-- On UPHELD:   fine → CANCELLED.
-- On DISMISSED: fine → ISSUED + TZS 10,000 admin fee added to penalty_amount.
CREATE TABLE appeals (
  id                  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  fine_id             UUID         NOT NULL REFERENCES fines(id),
  reason              TEXT         NOT NULL,               -- Owner's appeal reason
  supporting_docs     TEXT[]       DEFAULT '{}',           -- Array of doc/image S3 URLs
  status              VARCHAR(20)  NOT NULL DEFAULT 'PENDING'
                      CHECK (status IN (
                        'PENDING',        -- Filed, not yet reviewed
                        'UNDER_REVIEW',   -- Assigned to an officer
                        'UPHELD',         -- Decided in owner's favour → fine CANCELLED
                        'DISMISSED'       -- Decided against owner → fine reinstated + fee
                      )),
  decision_notes      TEXT,                                -- Officer's ruling notes
  reviewed_by         VARCHAR(80),                         -- Deciding officer username/ID
  filed_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(), -- When appeal was filed
  decided_at          TIMESTAMPTZ,                         -- When ruling was made
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()  -- Record created
);

CREATE INDEX idx_appeals_fine   ON appeals (fine_id);
CREATE INDEX idx_appeals_status ON appeals (status);

-- ─── NOTIFICATIONS ────────────────────────────────────────────
-- Tracks every automated message sent to an owner about their fine.
-- recipient holds phone number (SMS) or email address (EMAIL).
-- A fine triggers at minimum: issue notice + 7-day reminder + overdue alert.
CREATE TABLE notifications (
  id                  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  fine_id             UUID         NOT NULL REFERENCES fines(id),
  channel             VARCHAR(10)  NOT NULL
                      CHECK (channel IN ('SMS','EMAIL','PUSH')),
  recipient           VARCHAR(120) NOT NULL,               -- Phone number or email address
  message             TEXT         NOT NULL,               -- Full message body
  status              VARCHAR(20)  NOT NULL DEFAULT 'PENDING'
                      CHECK (status IN (
                        'PENDING',        -- Queued, not yet sent
                        'SENT',           -- Successfully delivered
                        'FAILED'          -- Delivery failed (retry logic applies)
                      )),
  sent_at             TIMESTAMPTZ,                         -- Delivery timestamp
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()  -- Record created
);

CREATE INDEX idx_notifications_fine    ON notifications (fine_id);
CREATE INDEX idx_notifications_status  ON notifications (status);
CREATE INDEX idx_notifications_channel ON notifications (channel);

-- ─── AUTO-UPDATE updated_at TRIGGER ──────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_vehicles_updated
  BEFORE UPDATE ON vehicles
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_fines_updated
  BEFORE UPDATE ON fines
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ─── USEFUL VIEWS ─────────────────────────────────────────────

-- Full fine detail — joins everything needed for the citizen portal
CREATE VIEW v_fine_detail AS
SELECT
  f.id                              AS fine_id,
  f.fine_number,
  f.status                          AS fine_status,
  f.amount_tzs,
  f.penalty_amount,
  f.amount_tzs + f.penalty_amount   AS total_due_tzs,
  f.due_date,
  f.issued_at,
  f.paid_at,
  vh.plate_number,
  vh.owner_name,
  vh.owner_phone,
  vh.owner_email,
  vh.make                           AS vehicle_make,
  vh.model                          AS vehicle_model,
  vh.color                          AS vehicle_color,
  v.violation_type,
  v.occurred_at,
  v.evidence_image_url,
  v.evidence_video_url,
  v.camera_id,
  v.gps_lat,
  v.gps_lng,
  v.confidence_score
FROM fines f
JOIN violations v  ON v.id  = f.violation_id
JOIN vehicles   vh ON vh.id = v.vehicle_id;

-- Dashboard summary — used by the admin / police dashboard
CREATE VIEW v_dashboard_stats AS
SELECT
  COUNT(*)                                              AS total_fines,
  COUNT(*) FILTER (WHERE status = 'PAID')               AS paid,
  COUNT(*) FILTER (WHERE status = 'ISSUED')             AS pending_payment,
  COUNT(*) FILTER (WHERE status = 'OVERDUE')            AS overdue,
  COUNT(*) FILTER (WHERE status = 'APPEALED')           AS under_appeal,
  COUNT(*) FILTER (WHERE status = 'COURT_REFERRED')     AS court_referred,
  COUNT(*) FILTER (WHERE status = 'CANCELLED')          AS cancelled,
  COALESCE(SUM(amount_tzs + penalty_amount)
    FILTER (WHERE status = 'PAID'), 0)                  AS total_collected_tzs,
  COALESCE(SUM(amount_tzs + penalty_amount)
    FILTER (WHERE status IN ('ISSUED','OVERDUE')), 0)   AS total_outstanding_tzs
FROM fines;