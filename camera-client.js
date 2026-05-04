// ============================================================
// RTMS — Camera Client
// camera-client.js
//
// This file runs on the computer connected to your cameras.
// It reads from any IP camera (RTSP stream), passes frames
// to the ALPR engine, and sends detections to your server.
//
// npm install axios node-rtsp-stream sharp form-data dotenv
// node camera-client.js
// ============================================================

require('dotenv').config();
const axios    = require('axios');
const fs       = require('fs');
const path     = require('path');
const alpr     = require('./alpr-engine');

// ─── CAMERA CONFIGURATION ─────────────────────────────────────
// Add as many cameras as you have. Each camera needs:
//   id:       unique camera identifier (used in violation records)
//   name:     human readable name (shown in dashboard)
//   location: description of where it is placed
//   rtsp_url: the RTSP stream URL of your IP camera
//   gps_lat:  GPS latitude of camera location
//   gps_lng:  GPS longitude of camera location
//   type:     what the camera monitors

const CAMERAS = [
  {
    id:       'CAM-DSM-001',
    name:     'Uhuru Street Junction',
    location: 'Uhuru Street & Kivukoni Rd, Dar es Salaam',
    rtsp_url: process.env.CAM_001_URL || 'rtsp://admin:password@192.168.1.101:554/stream1',
    gps_lat:  -6.8161,
    gps_lng:  39.2894,
    type:     'INTERSECTION',
  },
  {
    id:       'CAM-DSM-002',
    name:     'Morogoro Road Speed Point',
    location: 'Morogoro Road near Ubungo, Dar es Salaam',
    rtsp_url: process.env.CAM_002_URL || 'rtsp://admin:password@192.168.1.102:554/stream1',
    gps_lat:  -6.7924,
    gps_lng:  39.2083,
    type:     'SPEED',
  },
  {
    id:       'CAM-DSM-003',
    name:     'Kariakoo Pedestrian Zone',
    location: 'Kariakoo Market area, Dar es Salaam',
    rtsp_url: process.env.CAM_003_URL || 'rtsp://admin:password@192.168.1.103:554/stream1',
    gps_lat:  -6.8219,
    gps_lng:  39.2741,
    type:     'PEDESTRIAN',
  },
];

// ─── SYSTEM CONFIG ────────────────────────────────────────────
const CONFIG = {
  SERVER_URL:          process.env.SERVER_URL || 'http://localhost:3000',
  SERVER_TOKEN:        process.env.CAMERA_TOKEN || '',        // JWT token for OFFICER role
  FRAME_INTERVAL_MS:   parseInt(process.env.FRAME_INTERVAL || '2000'), // check every 2 seconds
  MIN_CONFIDENCE:      parseFloat(process.env.MIN_CONFIDENCE || '0.75'),
  EVIDENCE_DIR:        path.join(__dirname, 'evidence'),
  MAX_RETRIES:         3,
  RETRY_DELAY_MS:      5000,
};

// ─── STATE ────────────────────────────────────────────────────
const cameraStats = {};
CAMERAS.forEach(c => {
  cameraStats[c.id] = {
    detections:  0,
    fines_issued: 0,
    errors:      0,
    last_seen:   null,
    status:      'STARTING',
  };
});

// ─── HELPERS ──────────────────────────────────────────────────
function log(cameraId, level, message, data = {}) {
  const entry = {
    time:     new Date().toISOString(),
    camera:   cameraId,
    level,
    message,
    ...data,
  };
  console.log(JSON.stringify(entry));
}

function ensureEvidenceDir() {
  if (!fs.existsSync(CONFIG.EVIDENCE_DIR)) {
    fs.mkdirSync(CONFIG.EVIDENCE_DIR, { recursive: true });
  }
}

// Save a frame as evidence image
function saveEvidenceFrame(cameraId, frameData) {
  ensureEvidenceDir();
  const filename  = `${cameraId}-${Date.now()}.jpg`;
  const filepath  = path.join(CONFIG.EVIDENCE_DIR, filename);
  // frameData is base64 or Buffer
  const buffer = Buffer.isBuffer(frameData) ? frameData : Buffer.from(frameData, 'base64');
  fs.writeFileSync(filepath, buffer);
  return filepath;
}

// ─── SERVER COMMUNICATION ─────────────────────────────────────

// Login as camera system user and get JWT token
async function getAuthToken() {
  if (CONFIG.SERVER_TOKEN) return CONFIG.SERVER_TOKEN;

  try {
    const res = await axios.post(`${CONFIG.SERVER_URL}/login`, {
      username: process.env.CAMERA_USERNAME || 'camera_system',
      password: process.env.CAMERA_PASSWORD || 'camera_password',
    });
    CONFIG.SERVER_TOKEN = res.data.token;
    log('SYSTEM', 'INFO', 'Authentication successful');
    return CONFIG.SERVER_TOKEN;
  } catch (err) {
    log('SYSTEM', 'ERROR', 'Authentication failed', { error: err.message });
    throw err;
  }
}

// Send a detected violation to the server
async function sendViolationToServer(camera, detection) {
  const token = await getAuthToken();

  const payload = {
    plate_number:       detection.plate_number,
    camera_id:          camera.id,
    violation_type:     detection.violation_type,
    confidence_score:   detection.confidence_score,
    evidence_image_url: detection.evidence_image_url,
    evidence_video_url: detection.evidence_video_url || null,
    occurred_at:        detection.occurred_at,
    gps_lat:            camera.gps_lat,
    gps_lng:            camera.gps_lng,
  };

  for (let attempt = 1; attempt <= CONFIG.MAX_RETRIES; attempt++) {
    try {
      const res = await axios.post(
        `${CONFIG.SERVER_URL}/violations`,
        payload,
        { headers: { Authorization: `Bearer ${token}` } }
      );

      cameraStats[camera.id].fines_issued++;
      log(camera.id, 'INFO', 'Violation sent to server', {
        plate:       detection.plate_number,
        violation:   detection.violation_type,
        fine_number: res.data.fine?.fine_number,
        status:      res.data.stage,
      });

      return res.data;

    } catch (err) {
      const status = err.response?.status;
      const body   = err.response?.data;

      // 202 = low confidence queued / duplicate — not a real error
      if (status === 202) {
        log(camera.id, 'INFO', 'Detection queued or rejected by server', { reason: body?.reason });
        return body;
      }

      // 401 = token expired — refresh and retry
      if (status === 401) {
        CONFIG.SERVER_TOKEN = '';
        await getAuthToken();
      }

      log(camera.id, 'WARN', `Send attempt ${attempt} failed`, { error: err.message, status });

      if (attempt < CONFIG.MAX_RETRIES) {
        await new Promise(r => setTimeout(r, CONFIG.RETRY_DELAY_MS));
      }
    }
  }

  cameraStats[camera.id].errors++;
  log(camera.id, 'ERROR', 'Failed to send violation after max retries', {
    plate: detection.plate_number,
  });
}

// Send camera heartbeat to server every 60 seconds
async function sendHeartbeat(camera) {
  try {
    const token = await getAuthToken();
    await axios.post(
      `${CONFIG.SERVER_URL}/cameras/heartbeat`,
      {
        camera_id:  camera.id,
        status:     cameraStats[camera.id].status,
        stats:      cameraStats[camera.id],
        timestamp:  new Date().toISOString(),
      },
      { headers: { Authorization: `Bearer ${token}` } }
    ).catch(() => {}); // heartbeat failure is non-critical
  } catch {}
}

// ─── CAMERA PROCESSING LOOP ───────────────────────────────────

async function processCameraFrame(camera) {
  try {
    cameraStats[camera.id].status   = 'ACTIVE';
    cameraStats[camera.id].last_seen = new Date().toISOString();

    // Get frame from ALPR engine
    // In production this reads from the real RTSP stream
    // In simulation mode this generates synthetic detections
    const result = await alpr.analyzeFrame(camera);

    if (!result || !result.plate_detected) {
      return; // no plate in this frame — skip
    }

    cameraStats[camera.id].detections++;

    log(camera.id, 'INFO', 'Plate detected', {
      plate:      result.plate_number,
      confidence: result.confidence_score,
      violation:  result.violation_type,
    });

    // Only send if confidence meets minimum threshold
    if (result.confidence_score < CONFIG.MIN_CONFIDENCE) {
      log(camera.id, 'INFO', 'Confidence too low — skipping', {
        confidence: result.confidence_score,
        minimum:    CONFIG.MIN_CONFIDENCE,
      });
      return;
    }

    // Only send if a violation was detected (not just a passing car)
    if (!result.violation_type) {
      return;
    }

    // Save evidence frame locally as backup
    if (result.frame_data) {
      const savedPath = saveEvidenceFrame(camera.id, result.frame_data);
      log(camera.id, 'INFO', 'Evidence frame saved locally', { path: savedPath });
    }

    // Send to server
    await sendViolationToServer(camera, result);

  } catch (err) {
    cameraStats[camera.id].status = 'ERROR';
    cameraStats[camera.id].errors++;
    log(camera.id, 'ERROR', 'Frame processing error', { error: err.message });
  }
}

// Main loop for a single camera
async function runCamera(camera) {
  log(camera.id, 'INFO', `Camera starting`, {
    name:     camera.name,
    location: camera.location,
    type:     camera.type,
    url:      camera.rtsp_url.replace(/:[^:@]+@/, ':***@'), // hide password in logs
  });

  // Connect to RTSP stream
  const connected = await alpr.connectToStream(camera);
  if (!connected) {
    cameraStats[camera.id].status = 'OFFLINE';
    log(camera.id, 'ERROR', 'Failed to connect to camera stream — will retry in 30s');
    setTimeout(() => runCamera(camera), 30000);
    return;
  }

  log(camera.id, 'INFO', 'Connected to camera stream');
  cameraStats[camera.id].status = 'ACTIVE';

  // Start heartbeat
  setInterval(() => sendHeartbeat(camera), 60000);

  // Main processing loop
  const loop = setInterval(async () => {
    await processCameraFrame(camera);
  }, CONFIG.FRAME_INTERVAL_MS);

  // Handle stream disconnect
  alpr.onStreamDisconnect(camera, () => {
    clearInterval(loop);
    cameraStats[camera.id].status = 'OFFLINE';
    log(camera.id, 'WARN', 'Stream disconnected — reconnecting in 30s');
    setTimeout(() => runCamera(camera), 30000);
  });
}

// ─── STATUS REPORTER ──────────────────────────────────────────
function printStatus() {
  console.log('\n══════════════ CAMERA STATUS ══════════════');
  CAMERAS.forEach(c => {
    const s = cameraStats[c.id];
    console.log(`${c.id} | ${c.name}`);
    console.log(`  Status: ${s.status} | Detections: ${s.detections} | Fines: ${s.fines_issued} | Errors: ${s.errors}`);
    console.log(`  Last seen: ${s.last_seen || 'never'}`);
  });
  console.log('═══════════════════════════════════════════\n');
}

// ─── MAIN ─────────────────────────────────────────────────────
async function main() {
  console.log('');
  console.log('╔═══════════════════════════════════════════╗');
  console.log('║   RTMS Camera Client v1.0                 ║');
  console.log('║   Road Traffic Management System          ║');
  console.log('╚═══════════════════════════════════════════╝');
  console.log('');
  console.log(`Server:   ${CONFIG.SERVER_URL}`);
  console.log(`Cameras:  ${CAMERAS.length}`);
  console.log(`Interval: ${CONFIG.FRAME_INTERVAL_MS}ms`);
  console.log('');

  // Authenticate first
  try {
    await getAuthToken();
  } catch {
    console.error('❌ Cannot authenticate with server. Check CAMERA_USERNAME and CAMERA_PASSWORD in .env');
    process.exit(1);
  }

  // Start all cameras in parallel
  await Promise.all(CAMERAS.map(camera => runCamera(camera)));

  // Print status every 5 minutes
  setInterval(printStatus, 300000);

  console.log(`✅ All ${CAMERAS.length} cameras started`);
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
