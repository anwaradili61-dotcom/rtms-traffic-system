// ============================================================
// RTMS — Real-Time Officer Alert System
// alerts.js
//
// Uses Server-Sent Events (SSE) to push instant alerts to
// all connected officer dashboards when a flagged vehicle
// is detected heading their way.
//
// © SEUSHI, ANWAR 2025 | Dar es Salaam, Tanzania
// ============================================================

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
const db = (text, params) => pool.query(text, params);

// Store all connected officer SSE clients
// Map of userId -> response object
const connectedOfficers = new Map();

function log(module, level, message, data = {}) {
  console.log(JSON.stringify({ time: new Date().toISOString(), module, level, message, ...data }));
}

// ─────────────────────────────────────────────────────────────
// REGISTER OFFICER CONNECTION
// Called when officer opens dashboard and connects to /alerts/stream
// ─────────────────────────────────────────────────────────────
function registerOfficer(userId, role, res) {
  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  // Send initial connection confirmation
  sendToClient(res, {
    type: 'CONNECTED',
    message: 'Alert stream connected',
    userId,
    role,
    time: new Date().toISOString(),
  });

  // Store this connection
  connectedOfficers.set(userId, { res, role, connectedAt: Date.now() });

  log('ALERTS', 'INFO', 'Officer connected to alert stream', {
    userId, role, totalConnected: connectedOfficers.size
  });

  // Send heartbeat every 30 seconds to keep connection alive
  const heartbeat = setInterval(() => {
    try {
      sendToClient(res, { type: 'HEARTBEAT', time: new Date().toISOString() });
    } catch(e) {
      clearInterval(heartbeat);
    }
  }, 30000);

  // Cleanup when officer disconnects
  res.on('close', () => {
    connectedOfficers.delete(userId);
    clearInterval(heartbeat);
    log('ALERTS', 'INFO', 'Officer disconnected from alert stream', {
      userId, totalConnected: connectedOfficers.size
    });
  });
}

// ─────────────────────────────────────────────────────────────
// SEND EVENT TO SINGLE CLIENT
// ─────────────────────────────────────────────────────────────
function sendToClient(res, data) {
  try {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  } catch(e) {
    // Client disconnected
  }
}

// ─────────────────────────────────────────────────────────────
// BROADCAST ALERT TO ALL OFFICERS
// Sends alert to every connected officer dashboard
// ─────────────────────────────────────────────────────────────
function broadcastAlert(alert) {
  let sent = 0;
  const toDelete = [];

  connectedOfficers.forEach((client, userId) => {
    try {
      sendToClient(client.res, alert);
      sent++;
    } catch(e) {
      toDelete.push(userId);
    }
  });

  // Remove disconnected clients
  toDelete.forEach(id => connectedOfficers.delete(id));

  log('ALERTS', 'INFO', 'Alert broadcast', {
    alertType: alert.type,
    officersReached: sent,
    totalConnected: connectedOfficers.size,
  });

  return sent;
}

// ─────────────────────────────────────────────────────────────
// TRIGGER INTEGRATION ALERT
// Called when LATRA/TIRA/TRA check finds a violation
// Broadcasts to all connected officers
// ─────────────────────────────────────────────────────────────
async function triggerIntegrationAlert({
  plateNumber,
  vehicleId,
  cameraId,
  violations,        // array of violation objects from integrations.js
  gpsLat,
  gpsLng,
  direction,         // estimated direction of travel
  ownerName,
  vehicleDescription,
}) {
  if (!violations || violations.length === 0) return;

  const alert = {
    type:        'INTEGRATION_ALERT',
    severity:    violations.some(v => v.source === 'LATRA') ? 'HIGH' : 'MEDIUM',
    plateNumber,
    vehicleId,
    cameraId,
    ownerName:   ownerName || 'Unknown Owner',
    vehicleDesc: vehicleDescription || 'Unknown Vehicle',
    violations:  violations.map(v => ({
      source:     v.source,
      type:       v.violation,
      fineAmount: v.fine_amount,
      details:    v.details,
    })),
    location: {
      gpsLat,
      gpsLng,
      cameraId,
      direction: direction || 'UNKNOWN',
    },
    message:   buildAlertMessage(plateNumber, violations, direction),
    time:      new Date().toISOString(),
    alertId:   'ALT-' + Date.now(),
  };

  // Save alert to database
  await db(
    `INSERT INTO officer_alerts
       (plate_number, vehicle_id, camera_id, alert_type, severity,
        violations, gps_lat, gps_lng, direction, message)
     VALUES ($1,$2,$3,'INTEGRATION',$4,$5,$6,$7,$8,$9)`,
    [
      plateNumber, vehicleId, cameraId,
      alert.severity,
      JSON.stringify(violations),
      gpsLat || null, gpsLng || null,
      direction || null,
      alert.message,
    ]
  ).catch(err => log('DB', 'ERROR', 'Failed to save alert', { error: err.message }));

  // Broadcast to all connected officers
  const reached = broadcastAlert(alert);

  log('ALERTS', 'WARN', 'Integration alert triggered', {
    plate: plateNumber,
    violations: violations.map(v => v.violation),
    officersReached: reached,
  });

  return { alertId: alert.alertId, officersReached: reached };
}

// ─────────────────────────────────────────────────────────────
// BUILD HUMAN-READABLE ALERT MESSAGE
// ─────────────────────────────────────────────────────────────
function buildAlertMessage(plateNumber, violations, direction) {
  const parts = [];

  violations.forEach(v => {
    if (v.source === 'LATRA') {
      if (v.violation === 'NO_LATRA_PERMIT') {
        parts.push('has NO LATRA transit permit');
      } else if (v.violation === 'EXPIRED_LATRA') {
        parts.push('has an EXPIRED LATRA transit permit');
      }
    }
    if (v.source === 'TIRA') {
      if (v.violation === 'NO_INSURANCE') {
        parts.push('is driving WITHOUT insurance');
      } else if (v.violation === 'EXPIRED_INSURANCE') {
        const days = v.details?.days_since_expiry;
        parts.push(`has EXPIRED insurance (${days} days overdue)`);
      }
    }
    if (v.source === 'TRA') {
      if (v.violation === 'UNREGISTERED_VEHICLE') {
        parts.push('is NOT registered with TRA');
      } else if (v.violation === 'CUSTOMS_UNPAID') {
        parts.push('has UNPAID customs duties');
      }
    }
  });

  const dirStr = direction && direction !== 'UNKNOWN'
    ? ` Vehicle heading ${direction}.`
    : '';

  return `⚠ ALERT: Vehicle ${plateNumber} ${parts.join(' and ')}.${dirStr} Pull over immediately.`;
}

// ─────────────────────────────────────────────────────────────
// GET RECENT ALERTS
// ─────────────────────────────────────────────────────────────
async function getRecentAlerts(limit = 50) {
  const { rows } = await db(
    `SELECT * FROM officer_alerts
     ORDER BY created_at DESC
     LIMIT $1`,
    [limit]
  );
  return rows;
}

function getConnectedCount() {
  return connectedOfficers.size;
}

// ─────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────
module.exports = {
  registerOfficer,
  broadcastAlert,
  triggerIntegrationAlert,
  getRecentAlerts,
  getConnectedCount,
};
