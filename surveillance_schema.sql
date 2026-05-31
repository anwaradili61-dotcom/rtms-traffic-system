-- ═══════════════════════════════════════════════════════════════
-- RTMS SURVEILLANCE & PUBLIC SAFETY SCHEMA
-- © SEUSHI, ANWAR 2025 | Dar es Salaam, Tanzania
-- Run in: rtms_database_6mgd via pgAdmin Query Tool
-- ═══════════════════════════════════════════════════════════════

-- ── 1. WATCHLIST ─────────────────────────────────────────────
-- Persons or vehicles flagged by law enforcement for monitoring
CREATE TABLE IF NOT EXISTS watchlist (
  id                 SERIAL PRIMARY KEY,
  entry_type         VARCHAR(20) NOT NULL CHECK (entry_type IN ('VEHICLE','PERSON')),

  -- Vehicle watch fields
  plate_number       VARCHAR(20),
  vehicle_make       VARCHAR(60),
  vehicle_model      VARCHAR(60),
  vehicle_color      VARCHAR(40),

  -- Person watch fields (linked to NID)
  national_id        VARCHAR(30),
  full_name          VARCHAR(120),
  date_of_birth      DATE,
  known_associates   TEXT,
  last_known_address TEXT,
  photo_url          TEXT,

  -- Watch details
  watch_reason       VARCHAR(40) NOT NULL CHECK (watch_reason IN (
                       'STOLEN_VEHICLE','WANTED_PERSON','SUSPECT',
                       'MISSING_PERSON','COURT_ORDER','IMMIGRATION',
                       'TAKUKURU','TERRORISM_WATCH','CUSTOMS_FLAG',
                       'TRAFFIC_WARRANT','OTHER')),
  severity           VARCHAR(10) NOT NULL DEFAULT 'MEDIUM'
                       CHECK (severity IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  warrant_number     VARCHAR(60),
  issuing_authority  VARCHAR(120),
  case_reference     VARCHAR(60),
  description        TEXT,
  instructions       TEXT,   -- what officer should do on intercept

  -- Status
  status             VARCHAR(20) NOT NULL DEFAULT 'ACTIVE'
                       CHECK (status IN ('ACTIVE','RESOLVED','EXPIRED','CANCELLED')),
  active_since       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at         TIMESTAMPTZ,
  resolved_at        TIMESTAMPTZ,
  resolved_by        INTEGER REFERENCES users(id),
  resolution_notes   TEXT,

  -- Tracking
  created_by         INTEGER REFERENCES users(id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_watchlist_plate  ON watchlist (plate_number) WHERE plate_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_watchlist_nid    ON watchlist (national_id)  WHERE national_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_watchlist_status ON watchlist (status);
CREATE INDEX IF NOT EXISTS idx_watchlist_severity ON watchlist (severity);

-- ── 2. WATCHLIST HITS ────────────────────────────────────────
-- Every time a camera detects a plate on the watchlist
CREATE TABLE IF NOT EXISTS watchlist_hits (
  id               SERIAL PRIMARY KEY,
  watchlist_id     INTEGER NOT NULL REFERENCES watchlist(id),
  plate_number     VARCHAR(20) NOT NULL,
  camera_id        VARCHAR(30) NOT NULL,
  detected_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  gps_lat          NUMERIC(9,6),
  gps_lng          NUMERIC(9,6),
  confidence       NUMERIC(5,3),
  evidence_url     TEXT,
  direction        VARCHAR(20),
  officer_notified BOOLEAN DEFAULT FALSE,
  acknowledged     BOOLEAN DEFAULT FALSE,
  acknowledged_by  INTEGER REFERENCES users(id),
  acknowledged_at  TIMESTAMPTZ,
  notes            TEXT
);

CREATE INDEX IF NOT EXISTS idx_hits_watchlist ON watchlist_hits (watchlist_id);
CREATE INDEX IF NOT EXISTS idx_hits_plate     ON watchlist_hits (plate_number);
CREATE INDEX IF NOT EXISTS idx_hits_camera    ON watchlist_hits (camera_id);
CREATE INDEX IF NOT EXISTS idx_hits_detected  ON watchlist_hits (detected_at DESC);

-- ── 3. INCIDENTS ─────────────────────────────────────────────
-- Crime/security incidents logged at or near camera locations
CREATE TABLE IF NOT EXISTS incidents (
  id                 SERIAL PRIMARY KEY,
  incident_number    VARCHAR(30) UNIQUE NOT NULL DEFAULT 'INC-' || to_char(NOW(),'YYMMDDHH24MISS') || '-' || floor(random()*1000)::text,
  incident_type      VARCHAR(40) NOT NULL CHECK (incident_type IN (
                       'THEFT','ROBBERY','ASSAULT','CARJACKING',
                       'HIT_AND_RUN','RECKLESS_DRIVING','DUI',
                       'SUSPICIOUS_VEHICLE','SUSPICIOUS_PERSON',
                       'ROAD_ACCIDENT','PUBLIC_DISORDER','OTHER')),
  title              VARCHAR(200) NOT NULL,
  description        TEXT,

  -- Location
  camera_id          VARCHAR(30),
  gps_lat            NUMERIC(9,6),
  gps_lng            NUMERIC(9,6),
  location_name      VARCHAR(200),

  -- Linked vehicle/person
  plate_number       VARCHAR(20),
  national_id        VARCHAR(30),
  suspect_description TEXT,

  -- Status
  severity           VARCHAR(10) NOT NULL DEFAULT 'MEDIUM'
                       CHECK (severity IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  status             VARCHAR(20) NOT NULL DEFAULT 'OPEN'
                       CHECK (status IN ('OPEN','ASSIGNED','INVESTIGATING','RESOLVED','CLOSED')),

  -- Evidence
  evidence_urls      TEXT[],
  
  -- Assignment
  reported_by        INTEGER REFERENCES users(id),
  assigned_officer   INTEGER REFERENCES users(id),
  assigned_at        TIMESTAMPTZ,

  occurred_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at        TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_incidents_status   ON incidents (status);
CREATE INDEX IF NOT EXISTS idx_incidents_type     ON incidents (incident_type);
CREATE INDEX IF NOT EXISTS idx_incidents_plate    ON incidents (plate_number) WHERE plate_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_incidents_camera   ON incidents (camera_id)    WHERE camera_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_incidents_occurred ON incidents (occurred_at DESC);

-- ── 4. NID VEHICLE LOOKUP VIEW ───────────────────────────────
-- Lookup all vehicles registered to a given NID
CREATE OR REPLACE VIEW v_nid_vehicles AS
  SELECT
    v.id,
    v.plate_number,
    v.make,
    v.model,
    v.color,
    v.year,
    v.vehicle_category,
    v.owner_name,
    v.owner_phone,
    v.owner_email,
    v.owner_national_id AS national_id,
    v.owner_address,
    v.registration_expiry,
    COUNT(f.id)          AS total_fines,
    SUM(CASE WHEN f.status='PENDING' THEN f.amount_tzs ELSE 0 END) AS outstanding_tzs,
    EXISTS (
      SELECT 1 FROM watchlist w
      WHERE w.plate_number = v.plate_number AND w.status = 'ACTIVE'
    ) AS on_watchlist
  FROM vehicles v
  LEFT JOIN violations vi ON vi.vehicle_id = v.id
  LEFT JOIN fines f ON f.violation_id = vi.id
  GROUP BY v.id;

-- ── 5. SURVEILLANCE STATS VIEW ───────────────────────────────
CREATE OR REPLACE VIEW v_surveillance_stats AS
  SELECT
    (SELECT COUNT(*) FROM watchlist WHERE status='ACTIVE')                  AS active_watches,
    (SELECT COUNT(*) FROM watchlist WHERE severity='CRITICAL' AND status='ACTIVE') AS critical_watches,
    (SELECT COUNT(*) FROM watchlist_hits WHERE detected_at > NOW()-INTERVAL'24h') AS hits_24h,
    (SELECT COUNT(*) FROM watchlist_hits WHERE acknowledged=FALSE)          AS unacknowledged_hits,
    (SELECT COUNT(*) FROM incidents WHERE status='OPEN')                    AS open_incidents,
    (SELECT COUNT(*) FROM incidents WHERE severity='CRITICAL' AND status='OPEN') AS critical_incidents,
    (SELECT COUNT(*) FROM incidents WHERE occurred_at > NOW()-INTERVAL'24h') AS incidents_24h;

-- Confirm
SELECT 'Surveillance schema installed successfully' AS result;
