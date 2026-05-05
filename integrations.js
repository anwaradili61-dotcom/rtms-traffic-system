// ============================================================
// RTMS — External Integrations Engine
// integrations.js
//
// Integrates with:
//   1. LATRA  — Land Transport Regulatory Authority (transit permits)
//   2. TIRA   — Tanzania Insurance Regulatory Authority (insurance)
//   3. TRA    — Tanzania Revenue Authority (vehicle import registry)
//
// Currently uses PLACEHOLDER APIs — swap with real credentials
// once MOUs are signed with each government agency.
//
// © SEUSHI, ANWAR 2025 | Dar es Salaam, Tanzania
// ============================================================

require('dotenv').config();
const axios  = require('axios');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
const db = (text, params) => pool.query(text, params);

// ─── CONFIG ──────────────────────────────────────────────────
const LATRA = {
  BASE_URL: process.env.LATRA_API_URL    || 'https://api.latra.go.tz/v1',
  API_KEY:  process.env.LATRA_API_KEY    || 'PLACEHOLDER_LATRA_KEY',
  ENABLED:  process.env.LATRA_ENABLED    === 'true',
};

const TIRA = {
  BASE_URL: process.env.TIRA_API_URL     || 'https://api.tira.go.tz/v1',
  API_KEY:  process.env.TIRA_API_KEY     || 'PLACEHOLDER_TIRA_KEY',
  ENABLED:  process.env.TIRA_ENABLED     === 'true',
};

const TRA = {
  BASE_URL: process.env.TRA_API_URL      || 'https://api.tra.go.tz/v1',
  API_KEY:  process.env.TRA_API_KEY      || 'PLACEHOLDER_TRA_KEY',
  WEBHOOK_SECRET: process.env.TRA_WEBHOOK_SECRET || 'PLACEHOLDER_TRA_SECRET',
  ENABLED:  process.env.TRA_ENABLED      === 'true',
};

// Fine amounts for integration violations (TZS)
const INTEGRATION_FINES = {
  NO_LATRA_PERMIT:    500000,  // No transit permit
  EXPIRED_LATRA:      300000,  // Expired transit permit
  NO_INSURANCE:       200000,  // No insurance
  EXPIRED_INSURANCE:  150000,  // Expired insurance
};

function log(module, level, message, data = {}) {
  console.log(JSON.stringify({ time: new Date().toISOString(), module, level, message, ...data }));
}

// ─────────────────────────────────────────────────────────────
// SIMULATION MODE
// When real APIs are not connected, simulate responses based
// on plate patterns so you can test the full flow
// ─────────────────────────────────────────────────────────────
function simulateLatraCheck(plateNumber) {
  // Simulate: plates ending in odd numbers have no permit
  const lastChar = plateNumber.slice(-1);
  const hasPermit = !['1','3','5','7','9'].includes(lastChar);
  const expired   = plateNumber.includes('X');
  return {
    has_permit:    hasPermit && !expired,
    expired:       expired,
    permit_number: hasPermit ? 'LTR-' + plateNumber + '-2025' : null,
    permit_type:   hasPermit ? 'TRANSIT' : null,
    expiry_date:   hasPermit ? '2025-12-31' : null,
    vehicle_class: 'HEAVY_GOODS',
    route:         hasPermit ? 'DSM-ARUSHA-NAIROBI' : null,
  };
}

function simulateTiraCheck(plateNumber) {
  // Simulate: plates with 'Z' have no insurance
  const hasInsurance = !plateNumber.includes('Z');
  const daysExpired  = hasInsurance ? 0 : Math.floor(Math.random() * 60) + 1;
  return {
    has_insurance:    hasInsurance,
    policy_number:    hasInsurance ? 'POL-' + plateNumber + '-2025' : null,
    insurer:          hasInsurance ? 'Jubilee Insurance Tanzania' : null,
    policy_type:      hasInsurance ? 'COMPREHENSIVE' : null,
    expiry_date:      hasInsurance ? '2025-12-31' : null,
    days_since_expiry: daysExpired,
    owner_name:       null,
  };
}

function simulateTraCheck(plateNumber) {
  return {
    registered:        true,
    owner_national_id: 'TZN-' + Math.random().toString(36).slice(2,10).toUpperCase(),
    owner_name:        'Registered Owner',
    import_date:       '2022-01-15',
    customs_paid:      true,
    vehicle_class:     'HEAVY_GOODS',
    tonnage:           10,
  };
}

// ─────────────────────────────────────────────────────────────
// ENGINE 1: LATRA CHECK
// Verifies vehicle has valid transit permit
// ─────────────────────────────────────────────────────────────
async function checkLatra(plateNumber) {
  log('LATRA', 'INFO', 'Checking transit permit', { plate: plateNumber });

  let result;

  if (LATRA.ENABLED) {
    try {
      const res = await axios.get(
        `${LATRA.BASE_URL}/permits/check`,
        {
          params: { plate_number: plateNumber },
          headers: { 'X-API-Key': LATRA.API_KEY, 'Content-Type': 'application/json' },
          timeout: 5000,
        }
      );
      result = res.data;
    } catch (err) {
      log('LATRA', 'ERROR', 'LATRA API failed — using simulation', { error: err.message });
      result = simulateLatraCheck(plateNumber);
    }
  } else {
    result = simulateLatraCheck(plateNumber);
  }

  const violation = !result.has_permit ? 'NO_LATRA_PERMIT' : result.expired ? 'EXPIRED_LATRA' : null;

  return {
    source:        'LATRA',
    plate:         plateNumber,
    compliant:     result.has_permit && !result.expired,
    violation,
    fine_amount:   violation ? INTEGRATION_FINES[violation] : 0,
    details:       result,
    checked_at:    new Date().toISOString(),
    simulated:     !LATRA.ENABLED,
  };
}

// ─────────────────────────────────────────────────────────────
// ENGINE 2: TIRA INSURANCE CHECK
// Verifies vehicle has valid insurance policy
// ─────────────────────────────────────────────────────────────
async function checkInsurance(plateNumber) {
  log('TIRA', 'INFO', 'Checking insurance', { plate: plateNumber });

  let result;

  if (TIRA.ENABLED) {
    try {
      const res = await axios.get(
        `${TIRA.BASE_URL}/insurance/verify`,
        {
          params: { plate_number: plateNumber },
          headers: { 'X-API-Key': TIRA.API_KEY, 'Content-Type': 'application/json' },
          timeout: 5000,
        }
      );
      result = res.data;
    } catch (err) {
      log('TIRA', 'ERROR', 'TIRA API failed — using simulation', { error: err.message });
      result = simulateTiraCheck(plateNumber);
    }
  } else {
    result = simulateTiraCheck(plateNumber);
  }

  const violation = !result.has_insurance ? 'NO_INSURANCE' :
                    result.days_since_expiry > 0 ? 'EXPIRED_INSURANCE' : null;

  return {
    source:      'TIRA',
    plate:       plateNumber,
    compliant:   result.has_insurance && result.days_since_expiry === 0,
    violation,
    fine_amount: violation ? INTEGRATION_FINES[violation] : 0,
    details:     result,
    checked_at:  new Date().toISOString(),
    simulated:   !TIRA.ENABLED,
  };
}

// ─────────────────────────────────────────────────────────────
// ENGINE 3: TRA REGISTRY CHECK
// Verifies vehicle is registered with TRA and customs paid
// ─────────────────────────────────────────────────────────────
async function checkTra(plateNumber) {
  log('TRA', 'INFO', 'Checking TRA registry', { plate: plateNumber });

  let result;

  if (TRA.ENABLED) {
    try {
      const res = await axios.get(
        `${TRA.BASE_URL}/vehicles/lookup`,
        {
          params: { plate_number: plateNumber },
          headers: { 'X-API-Key': TRA.API_KEY, 'Content-Type': 'application/json' },
          timeout: 5000,
        }
      );
      result = res.data;
    } catch (err) {
      log('TRA', 'ERROR', 'TRA API failed — using simulation', { error: err.message });
      result = simulateTraCheck(plateNumber);
    }
  } else {
    result = simulateTraCheck(plateNumber);
  }

  return {
    source:    'TRA',
    plate:     plateNumber,
    compliant: result.registered && result.customs_paid,
    violation: !result.registered ? 'UNREGISTERED_VEHICLE' : !result.customs_paid ? 'CUSTOMS_UNPAID' : null,
    details:   result,
    checked_at: new Date().toISOString(),
    simulated: !TRA.ENABLED,
  };
}

// ─────────────────────────────────────────────────────────────
// MAIN: RUN ALL CHECKS FOR A PLATE
// Called by processor.js on every detection
// Returns array of violations found
// ─────────────────────────────────────────────────────────────
async function runAllChecks(plateNumber, vehicleId, cameraId, gpsLat, gpsLng) {
  log('INTEGRATIONS', 'INFO', 'Running all external checks', { plate: plateNumber });

  // Run all three checks in parallel for speed
  const [latraResult, tiraResult, traResult] = await Promise.all([
    checkLatra(plateNumber),
    checkInsurance(plateNumber),
    checkTra(plateNumber),
  ]);

  const results = [latraResult, tiraResult, traResult];
  const violations = results.filter(r => r.violation);

  // Save all check results to database
  for (const r of results) {
    await db(
      `INSERT INTO external_checks
         (plate_number, vehicle_id, source, compliant, violation_type,
          fine_amount, details, camera_id, gps_lat, gps_lng, simulated)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        plateNumber, vehicleId, r.source, r.compliant,
        r.violation || null, r.fine_amount || 0,
        JSON.stringify(r.details), cameraId,
        gpsLat || null, gpsLng || null, r.simulated
      ]
    ).catch(err => log('DB', 'ERROR', 'Failed to save check result', { error: err.message }));
  }

  if (violations.length > 0) {
    log('INTEGRATIONS', 'WARN', 'Violations found', {
      plate: plateNumber,
      violations: violations.map(v => v.violation)
    });
  } else {
    log('INTEGRATIONS', 'INFO', 'All checks passed', { plate: plateNumber });
  }

  return {
    plate:      plateNumber,
    vehicleId,
    cameraId,
    violations,
    allPassed:  violations.length === 0,
    latraOk:    latraResult.compliant,
    insuranceOk:tiraResult.compliant,
    traOk:      traResult.compliant,
    checkedAt:  new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────
// TRA WEBHOOK HANDLER
// Called when TRA registers a new imported vehicle
// Auto-creates vehicle in RTMS and links to owner
// ─────────────────────────────────────────────────────────────
async function handleTraWebhook(payload) {
  const {
    plate_number,
    owner_national_id,
    owner_name,
    owner_phone,
    owner_email,
    owner_address,
    make,
    model,
    color,
    year,
    chassis_number,
    engine_number,
    import_date,
    vehicle_class,
    tonnage,
    secret,
  } = payload;

  // Verify webhook secret
  if (secret !== TRA.WEBHOOK_SECRET) {
    throw new Error('Invalid TRA webhook secret');
  }

  if (!plate_number || !owner_national_id) {
    throw new Error('plate_number and owner_national_id are required');
  }

  log('TRA_WEBHOOK', 'INFO', 'New vehicle from TRA', { plate: plate_number, owner: owner_name });

  // Check if vehicle already exists
  const { rows: existing } = await db(
    'SELECT id FROM vehicles WHERE plate_number = $1',
    [plate_number.trim().toUpperCase()]
  );

  if (existing.length) {
    // Update existing vehicle with TRA data
    await db(
      `UPDATE vehicles SET
         owner_name = COALESCE($1, owner_name),
         owner_phone = COALESCE($2, owner_phone),
         owner_email = COALESCE($3, owner_email),
         owner_national_id = COALESCE($4, owner_national_id),
         owner_address = COALESCE($5, owner_address),
         make = COALESCE($6, make),
         model = COALESCE($7, model),
         color = COALESCE($8, color),
         year = COALESCE($9, year),
         chassis_number = COALESCE($10, chassis_number),
         engine_number = COALESCE($11, engine_number),
         updated_at = NOW()
       WHERE plate_number = $12`,
      [owner_name, owner_phone, owner_email, owner_national_id, owner_address,
       make, model, color, year, chassis_number, engine_number,
       plate_number.trim().toUpperCase()]
    );
    log('TRA_WEBHOOK', 'INFO', 'Updated existing vehicle', { plate: plate_number });
    return { action: 'updated', plate: plate_number };
  }

  // Create new vehicle
  const { rows } = await db(
    `INSERT INTO vehicles
       (plate_number, owner_name, owner_phone, owner_email,
        owner_national_id, owner_address,
        make, model, color, year,
        chassis_number, engine_number,
        registration_expiry, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'ACTIVE')
     RETURNING id, plate_number`,
    [
      plate_number.trim().toUpperCase(),
      owner_name || 'TRA Registered Owner',
      owner_phone || null,
      owner_email || null,
      owner_national_id,
      owner_address || null,
      make || null,
      model || null,
      color || null,
      year || null,
      chassis_number || null,
      engine_number || null,
      new Date(Date.now() + 365*24*60*60*1000).toISOString().split('T')[0], // 1 year from now
    ]
  );

  log('TRA_WEBHOOK', 'INFO', 'Created new vehicle from TRA', {
    plate: plate_number, owner: owner_national_id
  });

  return { action: 'created', plate: plate_number, vehicle_id: rows[0].id };
}

// ─────────────────────────────────────────────────────────────
// OWNER MANAGEMENT
// Get all vehicles owned by a national ID
// ─────────────────────────────────────────────────────────────
async function getOwnerVehicles(nationalId) {
  const { rows } = await db(
    `SELECT v.*,
            COUNT(f.id) AS total_fines,
            COUNT(f.id) FILTER (WHERE f.status IN ('ISSUED','OVERDUE')) AS unpaid_fines,
            COALESCE(SUM(f.amount_tzs + f.penalty_amount)
              FILTER (WHERE f.status IN ('ISSUED','OVERDUE')), 0) AS total_outstanding
     FROM vehicles v
     LEFT JOIN violations vi ON vi.vehicle_id = v.id
     LEFT JOIN fines      f  ON f.violation_id = vi.id
     WHERE v.owner_national_id = $1
     GROUP BY v.id
     ORDER BY v.created_at DESC`,
    [nationalId]
  );
  return rows;
}

async function getCheckHistory(plateNumber, limit = 20) {
  const { rows } = await db(
    `SELECT * FROM external_checks
     WHERE plate_number = $1
     ORDER BY checked_at DESC
     LIMIT $2`,
    [plateNumber, limit]
  );
  return rows;
}

// ─────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────
module.exports = {
  runAllChecks,
  checkLatra,
  checkInsurance,
  checkTra,
  handleTraWebhook,
  getOwnerVehicles,
  getCheckHistory,
};
