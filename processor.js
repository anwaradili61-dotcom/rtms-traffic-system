// ============================================================
// Smart Traffic System — Layer 3: Central Processing Core
// processor.js
//
// Contains three engines:
//   1. AI Violation Engine   — validates detections, filters confidence
//   2. Plate Lookup Engine   — matches plate to owner, checks flags
//   3. Case Management       — builds case, issues fine, triggers alerts
//
// Usage in server.js:
//   const processor = require('./processor');
//   const result = await processor.processDetection(payload);
// ============================================================

const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db   = (text, params) => pool.query(text, params);

// ─── CONSTANTS ────────────────────────────────────────────────

const CONFIDENCE = {
  AUTO_FINE:   0.92,   // above this → auto issue fine
  HUMAN_REVIEW: 0.75,  // above this → queue for human review
                       // below 0.75 → reject silently
};

const DUPLICATE_WINDOW_MINUTES = 30; // same plate + violation + camera within this window = duplicate

const FINE_AMOUNTS = {
  RED_LIGHT:        150000,
  SPEEDING:         200000,
  ILLEGAL_PARKING:   50000,
  WRONG_WAY:        300000,
  NO_SEATBELT:       30000,
  PHONE_USE:         50000,
  PEDESTRIAN_ZONE:  100000,
  EXPIRED_PLATE:     80000,
};

// ─── HELPERS ─────────────────────────────────────────────────

function fineNumber() {
  return 'TRF-' + Date.now().toString().slice(-7);
}

function daysFromNow(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}

function log(stage, message, data = {}) {
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    stage,
    message,
    ...data
  }));
}

// ─────────────────────────────────────────────────────────────
// ENGINE 1: AI VIOLATION ENGINE
// Validates the detection, scores confidence, checks duplicates
// ─────────────────────────────────────────────────────────────

async function runViolationEngine(payload) {
  const {
    plate_number,
    camera_id,
    violation_type,
    confidence_score,
    evidence_image_url,
    evidence_video_url,
    occurred_at,
    gps_lat,
    gps_lng,
  } = payload;

  log('VIOLATION_ENGINE', 'Detection received', { plate_number, violation_type, confidence_score });

  // ── Step 1: Validate required fields ──
  const required = ['plate_number', 'camera_id', 'violation_type', 'confidence_score', 'evidence_image_url'];
  for (const field of required) {
    if (!payload[field]) {
      return { status: 'REJECTED', reason: `Missing required field: ${field}` };
    }
  }

  // ── Step 2: Validate violation type ──
  if (!FINE_AMOUNTS[violation_type]) {
    return { status: 'REJECTED', reason: `Unknown violation type: ${violation_type}` };
  }

  // ── Step 3: Confidence scoring ──
  const score = parseFloat(confidence_score);
  if (isNaN(score) || score < 0 || score > 1) {
    return { status: 'REJECTED', reason: 'Invalid confidence score — must be between 0 and 1' };
  }

  if (score < CONFIDENCE.HUMAN_REVIEW) {
    log('VIOLATION_ENGINE', 'Rejected — confidence too low', { score, threshold: CONFIDENCE.HUMAN_REVIEW });
    return { status: 'REJECTED', reason: `Confidence ${score} below minimum threshold ${CONFIDENCE.HUMAN_REVIEW}` };
  }

  const needsReview = score < CONFIDENCE.AUTO_FINE;

  // ── Step 4: Duplicate detection ──
  const windowStart = new Date(Date.now() - DUPLICATE_WINDOW_MINUTES * 60 * 1000).toISOString();
  const { rows: dupes } = await db(
    `SELECT v.id FROM violations v
     JOIN vehicles vh ON vh.id = v.vehicle_id
     WHERE vh.plate_number = $1
       AND v.violation_type = $2
       AND v.camera_id = $3
       AND v.occurred_at > $4`,
    [plate_number.toUpperCase(), violation_type, camera_id, windowStart]
  );

  if (dupes.length > 0) {
    log('VIOLATION_ENGINE', 'Duplicate detected — discarding', { plate_number, violation_type, camera_id });
    return { status: 'DUPLICATE', reason: `Duplicate violation detected within ${DUPLICATE_WINDOW_MINUTES} minutes` };
  }

  log('VIOLATION_ENGINE', needsReview ? 'Queued for human review' : 'Auto-approved', { score });

  return {
    status: 'APPROVED',
    needsReview,
    validated: {
      plate_number:       plate_number.toUpperCase(),
      camera_id,
      violation_type,
      confidence_score:   score,
      evidence_image_url,
      evidence_video_url: evidence_video_url || null,
      occurred_at:        occurred_at || new Date().toISOString(),
      gps_lat:            gps_lat || null,
      gps_lng:            gps_lng || null,
    }
  };
}

// ─────────────────────────────────────────────────────────────
// ENGINE 2: PLATE LOOKUP ENGINE
// Matches plate string to registered vehicle and owner
// Checks vehicle status flags
// ─────────────────────────────────────────────────────────────

async function runPlateLookupEngine(plateNumber) {
  log('PLATE_LOOKUP', 'Looking up plate', { plate_number: plateNumber });

  const { rows } = await db(
    `SELECT * FROM vehicles WHERE plate_number = $1`,
    [plateNumber]
  );

  // ── Plate not found ──
  if (!rows.length) {
    log('PLATE_LOOKUP', 'Plate not found in registry', { plate_number: plateNumber });
    return {
      status: 'NOT_FOUND',
      reason: 'Plate not registered in the vehicle registry',
      requiresHumanReview: true,
      alerts: [{
        type: 'UNREGISTERED_PLATE',
        severity: 'MEDIUM',
        message: `Plate ${plateNumber} not found in registry — may be fake or unregistered`,
        plate_number: plateNumber,
      }]
    };
  }

  const vehicle = rows[0];
  const alerts  = [];
  let extraViolations = [];

  // ── Check registration expiry ──
  const today   = new Date();
  const expiry  = new Date(vehicle.registration_expiry);
  if (expiry < today) {
    log('PLATE_LOOKUP', 'Expired registration detected', { plate_number: plateNumber, expiry: vehicle.registration_expiry });
    alerts.push({
      type:     'EXPIRED_REGISTRATION',
      severity: 'LOW',
      message:  `Registration expired on ${vehicle.registration_expiry}`,
    });
    // Add expired plate as an additional violation
    extraViolations.push('EXPIRED_PLATE');
  }

  // ── Check vehicle status ──
  switch (vehicle.status) {
    case 'STOLEN':
      log('PLATE_LOOKUP', '🚨 STOLEN VEHICLE DETECTED', { plate_number: plateNumber });
      alerts.push({
        type:     'STOLEN_VEHICLE',
        severity: 'CRITICAL',
        message:  `STOLEN VEHICLE — ${plateNumber} reported stolen. Dispatch police immediately.`,
        plate_number: plateNumber,
        camera_id:    null, // will be filled in by caller
      });
      return {
        status:             'FLAGGED',
        flag:               'STOLEN',
        vehicle,
        alerts,
        requiresHumanReview: true,
        pauseFineProcessing: true, // don't auto-fine a stolen vehicle — police handle it
        extraViolations,
      };

    case 'SUSPENDED':
      log('PLATE_LOOKUP', 'Suspended vehicle detected', { plate_number: plateNumber });
      alerts.push({
        type:     'SUSPENDED_VEHICLE',
        severity: 'HIGH',
        message:  `Vehicle registration is SUSPENDED — ${plateNumber}. Notify traffic police.`,
        plate_number: plateNumber,
      });
      break;

    case 'EXPIRED':
      alerts.push({
        type:     'EXPIRED_STATUS',
        severity: 'MEDIUM',
        message:  `Vehicle status is EXPIRED — ${plateNumber}`,
      });
      if (!extraViolations.includes('EXPIRED_PLATE')) {
        extraViolations.push('EXPIRED_PLATE');
      }
      break;

    case 'ACTIVE':
    default:
      // No flag issues — proceed normally
      break;
  }

  log('PLATE_LOOKUP', 'Owner identified', {
    plate_number: plateNumber,
    owner: vehicle.owner_name,
    status: vehicle.status,
  });

  return {
    status:          'FOUND',
    vehicle,
    alerts,
    extraViolations,
    requiresHumanReview: false,
  };
}

// ─────────────────────────────────────────────────────────────
// ENGINE 3: CASE MANAGEMENT
// Creates violation + fine records, packages evidence, logs audit trail
// ─────────────────────────────────────────────────────────────

async function runCaseManagement(validated, vehicle, needsReview) {
  log('CASE_MANAGEMENT', 'Building case', {
    plate: validated.plate_number,
    violation: validated.violation_type,
    owner: vehicle.owner_name,
  });

  // ── Step 1: Create violation record ──
  const { rows: vRows } = await db(
    `INSERT INTO violations
       (vehicle_id, camera_id, violation_type, confidence_score,
        evidence_image_url, evidence_video_url, occurred_at, gps_lat, gps_lng)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING *`,
    [
      vehicle.id,
      validated.camera_id,
      validated.violation_type,
      validated.confidence_score,
      validated.evidence_image_url,
      validated.evidence_video_url,
      validated.occurred_at,
      validated.gps_lat,
      validated.gps_lng,
    ]
  );
  const violation = vRows[0];

  // ── Step 2: Get fine amount from database ──
  const { rows: amtRows } = await db(
    `SELECT base_amount_tzs FROM fine_amounts WHERE violation_type = $1`,
    [validated.violation_type]
  );
  const amount = amtRows[0]?.base_amount_tzs || FINE_AMOUNTS[validated.violation_type] || 50000;

  // ── Step 3: Create fine record ──
  const fineStatus = needsReview ? 'PENDING' : 'ISSUED';
  const { rows: fRows } = await db(
    `INSERT INTO fines
       (violation_id, fine_number, amount_tzs, status, due_date, issued_at)
     VALUES ($1,$2,$3,$4,$5,$6)
     RETURNING *`,
    [
      violation.id,
      fineNumber(),
      amount,
      fineStatus,
      daysFromNow(30),
      needsReview ? null : new Date().toISOString(),
    ]
  );
  const fine = fRows[0];

  // ── Step 4: Log audit trail entry ──
  const auditEntry = {
    fine_id:    fine.id,
    action:     needsReview ? 'QUEUED_FOR_REVIEW' : 'AUTO_ISSUED',
    actor:      needsReview ? 'SYSTEM_REVIEW_QUEUE' : 'SYSTEM_AUTO',
    confidence: validated.confidence_score,
    timestamp:  new Date().toISOString(),
    note:       needsReview
      ? `Confidence ${validated.confidence_score} requires human review before issuing`
      : `Auto-issued. Confidence ${validated.confidence_score} above threshold ${CONFIDENCE.AUTO_FINE}`,
  };
  log('CASE_MANAGEMENT', 'Audit trail entry', auditEntry);

  // ── Step 5: Queue notifications (only if auto-issued) ──
  const notifications = [];
  if (!needsReview) {
    const message =
      `Dear ${vehicle.owner_name}, a traffic fine of TZS ${Number(amount).toLocaleString()} ` +
      `has been issued for ${validated.violation_type.replace(/_/g, ' ')} ` +
      `on ${new Date(validated.occurred_at).toDateString()}. ` +
      `Fine ref: ${fine.fine_number}. ` +
      `Pay within 30 days at traffic.go.tz or reply APPEAL to contest.`;

    if (vehicle.owner_phone) {
      await db(
        `INSERT INTO notifications (fine_id, channel, recipient, message)
         VALUES ($1, 'SMS', $2, $3)`,
        [fine.id, vehicle.owner_phone, message]
      );
      notifications.push({ channel: 'SMS', recipient: vehicle.owner_phone });
    }

    if (vehicle.owner_email) {
      await db(
        `INSERT INTO notifications (fine_id, channel, recipient, message)
         VALUES ($1, 'EMAIL', $2, $3)`,
        [fine.id, vehicle.owner_email, message]
      );
      notifications.push({ channel: 'EMAIL', recipient: vehicle.owner_email });
    }

    log('CASE_MANAGEMENT', 'Notifications queued', { count: notifications.length });
  }

  log('CASE_MANAGEMENT', 'Case created successfully', {
    fine_number: fine.fine_number,
    status:      fine.status,
    amount_tzs:  amount,
  });

  return {
    violation,
    fine,
    notifications,
    audit: auditEntry,
  };
}

// ─────────────────────────────────────────────────────────────
// MAIN PROCESSOR — orchestrates all three engines in sequence
// Called by server.js POST /violations
// ─────────────────────────────────────────────────────────────

async function processDetection(payload) {
  const startTime = Date.now();
  log('PROCESSOR', '═══ New detection received ═══', { plate: payload.plate_number });

  try {

    // ── ENGINE 1: Validate the violation ──────────────────────
    const violationResult = await runViolationEngine(payload);

    if (violationResult.status === 'REJECTED') {
      return { success: false, stage: 'VIOLATION_ENGINE', ...violationResult };
    }
    if (violationResult.status === 'DUPLICATE') {
      return { success: false, stage: 'VIOLATION_ENGINE', ...violationResult };
    }

    const { validated, needsReview } = violationResult;

    // ── ENGINE 2: Look up the plate ───────────────────────────
    const plateResult = await runPlateLookupEngine(validated.plate_number);

    // Handle stolen vehicle — alert but don't auto-fine
    if (plateResult.flag === 'STOLEN') {
      return {
        success:  true,
        stage:    'PLATE_LOOKUP',
        status:   'POLICE_ALERT_TRIGGERED',
        reason:   'Stolen vehicle — fine processing paused, police alerted',
        alerts:   plateResult.alerts,
        vehicle:  plateResult.vehicle,
      };
    }

    // Handle unregistered plate — queue for human review
    if (plateResult.status === 'NOT_FOUND') {
      return {
        success: false,
        stage:   'PLATE_LOOKUP',
        status:  'UNREGISTERED_PLATE',
        alerts:  plateResult.alerts,
        ...plateResult,
      };
    }

    const { vehicle, alerts, extraViolations } = plateResult;
    const finalNeedsReview = needsReview || plateResult.requiresHumanReview;

    // ── ENGINE 3: Build the case ──────────────────────────────
    const caseResult = await runCaseManagement(validated, vehicle, finalNeedsReview);

    // If vehicle has extra violations (e.g. expired plate), process them too
    const extraCases = [];
    for (const extraType of (extraViolations || [])) {
      if (extraType !== validated.violation_type) { // avoid exact duplicate
        const extraPayload = { ...validated, violation_type: extraType, confidence_score: 0.99 };
        try {
          const extra = await runCaseManagement(extraPayload, vehicle, false);
          extraCases.push(extra);
          log('PROCESSOR', 'Extra violation case created', { type: extraType, fine: extra.fine.fine_number });
        } catch (e) {
          log('PROCESSOR', 'Extra violation failed', { type: extraType, error: e.message });
        }
      }
    }

    const elapsed = Date.now() - startTime;
    log('PROCESSOR', `═══ Processing complete in ${elapsed}ms ═══`, {
      fine_number: caseResult.fine.fine_number,
      status:      caseResult.fine.status,
    });

    return {
      success:      true,
      stage:        'COMPLETE',
      elapsed_ms:   elapsed,
      needsReview:  finalNeedsReview,
      vehicle,
      violation:    caseResult.violation,
      fine:         caseResult.fine,
      notifications: caseResult.notifications,
      alerts,
      extra_cases:  extraCases.map(c => ({ fine_number: c.fine.fine_number, violation_type: c.violation.violation_type })),
    };

  } catch (err) {
    log('PROCESSOR', 'ERROR in processing pipeline', { error: err.message, stack: err.stack });
    return { success: false, stage: 'ERROR', reason: err.message };
  }
}

// ─────────────────────────────────────────────────────────────
// REVIEW QUEUE — officer approves/rejects PENDING detections
// Called by server.js PATCH /violations/:id/review
// ─────────────────────────────────────────────────────────────

async function reviewDetection(violationId, decision, officerId) {
  log('REVIEW', 'Officer reviewing detection', { violationId, decision, officerId });

  const { rows: vRows } = await db(
    `SELECT v.*, f.id as fine_id, f.fine_number, vh.owner_name, vh.owner_phone, vh.owner_email
     FROM violations v
     JOIN fines f ON f.violation_id = v.id
     JOIN vehicles vh ON vh.id = v.vehicle_id
     WHERE v.id = $1`,
    [violationId]
  );

  if (!vRows.length) return { success: false, reason: 'Violation not found' };
  const rec = vRows[0];

  if (decision === 'APPROVE') {
    // Mark violation as reviewed, issue the fine
    await db(`UPDATE violations SET reviewed_by = $1 WHERE id = $2`, [officerId, violationId]);
    await db(`UPDATE fines SET status = 'ISSUED', issued_at = NOW() WHERE id = $1`, [rec.fine_id]);

    // Send notification now
    const amount = await db(`SELECT amount_tzs FROM fines WHERE id = $1`, [rec.fine_id]);
    const amt = amount.rows[0]?.amount_tzs;
    const msg = `Dear ${rec.owner_name}, a traffic fine of TZS ${Number(amt).toLocaleString()} has been issued. Fine ref: ${rec.fine_number}. Pay within 30 days at traffic.go.tz`;

    if (rec.owner_phone) {
      await db(`INSERT INTO notifications (fine_id, channel, recipient, message) VALUES ($1,'SMS',$2,$3)`,
        [rec.fine_id, rec.owner_phone, msg]);
    }

    log('REVIEW', 'Detection approved and fine issued', { fine_number: rec.fine_number, officer: officerId });
    return { success: true, action: 'ISSUED', fine_number: rec.fine_number };

  } else if (decision === 'REJECT') {
    // Cancel the fine — detection was wrong
    await db(`UPDATE fines SET status = 'CANCELLED' WHERE id = $1`, [rec.fine_id]);
    await db(`UPDATE violations SET reviewed_by = $1 WHERE id = $2`, [officerId, violationId]);

    log('REVIEW', 'Detection rejected — fine cancelled', { fine_number: rec.fine_number, officer: officerId });
    return { success: true, action: 'CANCELLED', fine_number: rec.fine_number };
  }

  return { success: false, reason: 'Decision must be APPROVE or REJECT' };
}

// ─────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────

module.exports = {
  processDetection,
  reviewDetection,
  runViolationEngine,
  runPlateLookupEngine,
  runCaseManagement,
};
