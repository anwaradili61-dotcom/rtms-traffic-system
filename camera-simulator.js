// ============================================================
// RTMS — Camera Simulator
// camera-simulator.js
//
// Simulates multiple cameras sending real detections to your
// server. Use this to test the full pipeline without physical
// cameras. Generates realistic Tanzanian traffic scenarios.
//
// node camera-simulator.js
//
// Options (set in .env or command line):
//   SIM_CAMERAS=3          number of cameras to simulate
//   SIM_INTERVAL=5000      ms between detections per camera
//   SIM_DURATION=0         run forever (0) or N seconds
//   SERVER_URL=http://localhost:3000
// ============================================================

require('dotenv').config();
const axios = require('axios');

const CONFIG = {
  SERVER_URL:    process.env.SERVER_URL    || 'http://localhost:3000',
  NUM_CAMERAS:   parseInt(process.env.SIM_CAMERAS   || '3'),
  INTERVAL_MS:   parseInt(process.env.SIM_INTERVAL  || '5000'),
  DURATION_MS:   parseInt(process.env.SIM_DURATION  || '0') * 1000,
  USERNAME:      process.env.CAMERA_USERNAME || 'camera_system',
  PASSWORD:      process.env.CAMERA_PASSWORD || 'camera_password',
};

// ─── SIMULATED CAMERAS ────────────────────────────────────────
const CAMERA_CONFIGS = [
  { id: 'CAM-DSM-001', name: 'Uhuru Street Junction',       gps_lat: -6.8161, gps_lng: 39.2894, type: 'INTERSECTION' },
  { id: 'CAM-DSM-002', name: 'Morogoro Road Speed Point',   gps_lat: -6.7924, gps_lng: 39.2083, type: 'SPEED'        },
  { id: 'CAM-DSM-003', name: 'Kariakoo Pedestrian Zone',    gps_lat: -6.8219, gps_lng: 39.2741, type: 'PEDESTRIAN'   },
  { id: 'CAM-DSM-004', name: 'Bagamoyo Road Junction',      gps_lat: -6.7689, gps_lng: 39.2456, type: 'INTERSECTION' },
  { id: 'CAM-DSM-005', name: 'Nelson Mandela Expressway',   gps_lat: -6.8034, gps_lng: 39.2612, type: 'SPEED'        },
];

// ─── REALISTIC TANZANIAN PLATES ───────────────────────────────
const PLATES = [
  'T123ABC', 'T456DEF', 'T789GHI', 'T321JKL', 'T654MNO',
  'T987PQR', 'T111STU', 'T222VWX', 'T333YZA', 'T444BCD',
  'SU001EFG', 'SU002HIJ', 'SU003KLM', 'T555NOP', 'T666QRS',
  'T777TUV', 'T888WXY', 'T999ZAB', 'T000CDE', 'T112FGH',
];

// ─── VIOLATION SCENARIOS ──────────────────────────────────────
const SCENARIOS = {
  INTERSECTION: [
    { type: 'RED_LIGHT',    weight: 40, conf: [0.90, 0.99] },
    { type: 'PHONE_USE',    weight: 25, conf: [0.85, 0.97] },
    { type: 'NO_SEATBELT',  weight: 20, conf: [0.87, 0.96] },
    { type: 'WRONG_WAY',    weight: 15, conf: [0.92, 0.99] },
  ],
  SPEED: [
    { type: 'SPEEDING',     weight: 80, conf: [0.93, 0.99] },
    { type: 'PHONE_USE',    weight: 20, conf: [0.80, 0.95] },
  ],
  PEDESTRIAN: [
    { type: 'PEDESTRIAN_ZONE', weight: 60, conf: [0.88, 0.97] },
    { type: 'ILLEGAL_PARKING', weight: 40, conf: [0.85, 0.95] },
  ],
};

// Detection probability — not every check has a violation
const DETECTION_PROB = { INTERSECTION: 0.3, SPEED: 0.4, PEDESTRIAN: 0.25 };

// ─── HELPERS ──────────────────────────────────────────────────
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function weightedPick(scenarios) {
  const total = scenarios.reduce((s, v) => s + v.weight, 0);
  let rand = Math.random() * total;
  for (const s of scenarios) {
    rand -= s.weight;
    if (rand <= 0) return s;
  }
  return scenarios[0];
}

function randBetween(min, max) {
  return parseFloat((min + Math.random() * (max - min)).toFixed(3));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── STATE ────────────────────────────────────────────────────
let authToken = '';
const stats = {
  total_sent:    0,
  fines_issued:  0,
  rejected:      0,
  duplicates:    0,
  errors:        0,
  started_at:    new Date().toISOString(),
};

// ─── AUTH ─────────────────────────────────────────────────────
async function authenticate() {
  try {
    const res = await axios.post(`${CONFIG.SERVER_URL}/login`, {
      username: CONFIG.USERNAME,
      password: CONFIG.PASSWORD,
    });
    authToken = res.data.token;
    console.log(`✅ Authenticated as ${CONFIG.USERNAME}`);
    return true;
  } catch (err) {
    console.error(`❌ Auth failed: ${err.response?.data?.error || err.message}`);
    console.error(`   Make sure your server is running and a camera_system user exists`);
    return false;
  }
}

// ─── GENERATE DETECTION ───────────────────────────────────────
function generateDetection(camera) {
  const prob = DETECTION_PROB[camera.type] || 0.3;
  if (Math.random() > prob) return null; // no violation this time

  const scenarios = SCENARIOS[camera.type] || SCENARIOS.INTERSECTION;
  const scenario  = weightedPick(scenarios);
  const conf      = randBetween(scenario.conf[0], scenario.conf[1]);
  const plate     = pick(PLATES);

  // Occasionally simulate edge cases
  const roll = Math.random();
  let finalConf = conf;
  if (roll < 0.03) finalConf = randBetween(0.60, 0.74); // 3% very low confidence
  if (roll < 0.08) finalConf = randBetween(0.75, 0.91); // 5% needs review

  return {
    plate_number:       plate,
    camera_id:          camera.id,
    violation_type:     scenario.type,
    confidence_score:   parseFloat(finalConf.toFixed(3)),
    evidence_image_url: `https://evidence.rtms.tz/${camera.id}/${plate}-${Date.now()}.jpg`,
    evidence_video_url: null,
    occurred_at:        new Date().toISOString(),
    gps_lat:            camera.gps_lat + (Math.random() - 0.5) * 0.001,
    gps_lng:            camera.gps_lng + (Math.random() - 0.5) * 0.001,
  };
}

// ─── SEND DETECTION ───────────────────────────────────────────
async function sendDetection(camera, detection) {
  try {
    const res = await axios.post(
      `${CONFIG.SERVER_URL}/violations`,
      detection,
      { headers: { Authorization: `Bearer ${authToken}` } }
    );

    stats.total_sent++;

    if (res.status === 201) {
      const d = res.data;
      if (d.status === 'POLICE_ALERT_TRIGGERED') {
        console.log(`🚨 [${camera.id}] STOLEN VEHICLE: ${detection.plate_number}`);
        stats.fines_issued++;
      } else if (d.needsReview) {
        console.log(`👀 [${camera.id}] QUEUED FOR REVIEW: ${detection.plate_number} | ${detection.violation_type} | conf: ${detection.confidence_score}`);
      } else {
        console.log(`✅ [${camera.id}] FINE ISSUED: ${d.fine?.fine_number} | ${detection.plate_number} | ${detection.violation_type} | TZS ${d.fine?.amount_tzs?.toLocaleString()}`);
        stats.fines_issued++;
      }
    } else if (res.status === 202) {
      const reason = res.data.reason || res.data.message || '';
      if (reason.toLowerCase().includes('duplicate')) {
        console.log(`🔁 [${camera.id}] DUPLICATE: ${detection.plate_number} — ${reason}`);
        stats.duplicates++;
      } else {
        console.log(`⚠️  [${camera.id}] REJECTED: ${detection.plate_number} — ${reason}`);
        stats.rejected++;
      }
    }

  } catch (err) {
    const status = err.response?.status;
    const body   = err.response?.data;

    if (status === 401) {
      // Token expired — re-authenticate
      console.log('🔑 Token expired — re-authenticating...');
      await authenticate();
      return;
    }

    stats.errors++;
    console.error(`❌ [${camera.id}] Error: ${body?.error || err.message}`);
  }
}

// ─── CAMERA SIMULATION LOOP ───────────────────────────────────
async function simulateCamera(camera, index) {
  // Stagger camera starts so they don't all fire at the same time
  await sleep(index * 1200);
  console.log(`📷 Camera started: ${camera.id} — ${camera.name}`);

  while (true) {
    const detection = generateDetection(camera);
    if (detection) {
      await sendDetection(camera, detection);
    }
    // Add slight randomness to interval so cameras don't sync up
    const jitter = (Math.random() - 0.5) * 1000;
    await sleep(CONFIG.INTERVAL_MS + jitter);
  }
}

// ─── STATS PRINTER ────────────────────────────────────────────
function printStats() {
  const elapsed = Math.floor((Date.now() - new Date(stats.started_at).getTime()) / 1000);
  const mins    = Math.floor(elapsed / 60);
  const secs    = elapsed % 60;
  console.log('');
  console.log('╔══════════════════════════════════╗');
  console.log('║       SIMULATOR STATS            ║');
  console.log(`║  Runtime:   ${String(mins).padStart(3, ' ')}m ${String(secs).padStart(2, '0')}s              ║`);
  console.log(`║  Sent:      ${String(stats.total_sent).padStart(5, ' ')}                  ║`);
  console.log(`║  Fines:     ${String(stats.fines_issued).padStart(5, ' ')}                  ║`);
  console.log(`║  Review:    ${String(stats.total_sent - stats.fines_issued - stats.rejected - stats.duplicates).padStart(5, ' ')}                  ║`);
  console.log(`║  Rejected:  ${String(stats.rejected).padStart(5, ' ')}                  ║`);
  console.log(`║  Duplicate: ${String(stats.duplicates).padStart(5, ' ')}                  ║`);
  console.log(`║  Errors:    ${String(stats.errors).padStart(5, ' ')}                  ║`);
  console.log('╚══════════════════════════════════╝');
  console.log('');
}

// ─── MAIN ─────────────────────────────────────────────────────
async function main() {
  console.log('');
  console.log('╔════════════════════════════════════════╗');
  console.log('║   RTMS Camera Simulator v1.0           ║');
  console.log('╚════════════════════════════════════════╝');
  console.log(`Server:   ${CONFIG.SERVER_URL}`);
  console.log(`Cameras:  ${CONFIG.NUM_CAMERAS}`);
  console.log(`Interval: ${CONFIG.INTERVAL_MS}ms per camera`);
  console.log('');
  console.log('Press Ctrl+C to stop');
  console.log('');

  const ok = await authenticate();
  if (!ok) {
    console.error('\n⚠️  Could not authenticate. Add a camera_system user to your database:');
    console.error('   INSERT INTO users (username, password_hash, full_name, role)');
    console.error('   VALUES (\'camera_system\', \'<bcrypt_hash>\', \'Camera System\', \'OFFICER\');');
    console.error('\n   Or run: node seed_passwords.js');
    process.exit(1);
  }

  // Start camera simulations in parallel
  const cameras = CAMERA_CONFIGS.slice(0, CONFIG.NUM_CAMERAS);
  const promises = cameras.map((cam, i) => simulateCamera(cam, i));

  // Print stats every 30 seconds
  setInterval(printStats, 30000);

  // Auto-stop if duration set
  if (CONFIG.DURATION_MS > 0) {
    setTimeout(() => {
      printStats();
      console.log('⏹  Simulation complete');
      process.exit(0);
    }, CONFIG.DURATION_MS);
  }

  await Promise.all(promises);
}

main().catch(err => {
  console.error('Fatal simulator error:', err.message);
  process.exit(1);
});
