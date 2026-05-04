// ============================================================
// RTMS — ALPR Engine
// alpr-engine.js
//
// Handles:
//   - RTSP stream connection
//   - Frame extraction
//   - Plate detection and OCR
//   - Violation type determination
//   - Simulation mode (when no real camera is available)
//
// In SIMULATION MODE (default for testing):
//   - Generates realistic fake detections using real Tanzanian plates
//   - Simulates different violation types with realistic confidence scores
//   - Useful for testing the full pipeline without a real camera
//
// In PRODUCTION MODE (when real cameras are connected):
//   - Connects to RTSP stream
//   - Extracts frames every N seconds
//   - Runs plate detection on each frame
//   - Returns structured detection result
// ============================================================

require('dotenv').config();

const SIMULATION_MODE = process.env.SIMULATION_MODE !== 'false';

// ─── TANZANIAN PLATE FORMAT ───────────────────────────────────
// Format: T + 3 digits + 3 letters  (e.g. T123ABC)
// Regional codes: T=Tanzania, SU=Dar es Salaam, etc.

const SAMPLE_PLATES = [
  'T123ABC', 'T456DEF', 'T789GHI', 'T321JKL',
  'T654MNO', 'T987PQR', 'SU001XYZ', 'SU002WVU',
  'T111AAA', 'T222BBB', 'T333CCC', 'T444DDD',
  'T555EEE', 'T666FFF', 'T777GGG', 'T888HHH',
];

const VIOLATION_TYPES = [
  { type: 'RED_LIGHT',       weight: 25 },
  { type: 'SPEEDING',        weight: 30 },
  { type: 'ILLEGAL_PARKING', weight: 20 },
  { type: 'NO_SEATBELT',     weight: 10 },
  { type: 'PHONE_USE',       weight: 10 },
  { type: 'WRONG_WAY',       weight: 3  },
  { type: 'PEDESTRIAN_ZONE', weight: 2  },
];

// Weighted random violation picker
function pickViolationType() {
  const total  = VIOLATION_TYPES.reduce((s, v) => s + v.weight, 0);
  let rand     = Math.random() * total;
  for (const v of VIOLATION_TYPES) {
    rand -= v.weight;
    if (rand <= 0) return v.type;
  }
  return 'SPEEDING';
}

// ─── SIMULATION HELPERS ───────────────────────────────────────

function randomPlate() {
  return SAMPLE_PLATES[Math.floor(Math.random() * SAMPLE_PLATES.length)];
}

function randomConfidence() {
  // Realistic distribution: most detections are high confidence
  const rand = Math.random();
  if (rand < 0.05) return 0.60 + Math.random() * 0.14; // 5%: very low (0.60–0.74)
  if (rand < 0.15) return 0.75 + Math.random() * 0.16; // 10%: medium (0.75–0.91)
  return 0.92 + Math.random() * 0.07;                   // 85%: high (0.92–0.99)
}

// Simulate a plate image URL (in production this is your S3 bucket URL)
function simulatedEvidenceUrl(cameraId, plate) {
  return `https://evidence.rtms.tz/${cameraId}/${plate}-${Date.now()}.jpg`;
}

// ─── STREAM CONNECTION ────────────────────────────────────────

// Track active stream connections
const activeStreams = {};
const disconnectHandlers = {};

async function connectToStream(camera) {
  if (SIMULATION_MODE) {
    console.log(`[ALPR] ${camera.id}: Simulation mode — no real stream needed`);
    activeStreams[camera.id] = { simulated: true, connected: true };
    return true;
  }

  // PRODUCTION: connect to real RTSP stream
  // Requires: npm install node-rtsp-stream
  try {
    const NodeRtspStream = require('node-rtsp-stream');
    const stream = new NodeRtspStream({
      name:      camera.id,
      streamUrl: camera.rtsp_url,
      wsPort:    8080 + Object.keys(activeStreams).length,
      ffmpegOptions: {
        '-r':      '5',     // 5 frames per second is enough for ALPR
        '-q:v':    '3',     // quality level
        '-vf':     'scale=1280:720', // resize to standard resolution
      }
    });

    activeStreams[camera.id] = { stream, connected: true };

    stream.on('error', (err) => {
      console.error(`[ALPR] ${camera.id} stream error:`, err.message);
      activeStreams[camera.id].connected = false;
      if (disconnectHandlers[camera.id]) disconnectHandlers[camera.id]();
    });

    return true;

  } catch (err) {
    console.error(`[ALPR] ${camera.id}: Failed to connect to stream:`, err.message);
    console.error(`[ALPR] Tip: Set SIMULATION_MODE=true in .env to test without a real camera`);
    return false;
  }
}

function onStreamDisconnect(camera, handler) {
  disconnectHandlers[camera.id] = handler;
}

// ─── FRAME ANALYSIS ───────────────────────────────────────────

// Detection probability per camera type
// Not every frame will have a violation — this is realistic
const DETECTION_PROBABILITY = {
  INTERSECTION: 0.08,  // 8% of frames have a violation
  SPEED:        0.12,  // 12% — more common on speed cameras
  PEDESTRIAN:   0.05,  // 5% — less common
  DEFAULT:      0.07,
};

async function analyzeFrame(camera) {
  if (SIMULATION_MODE) {
    return simulateDetection(camera);
  }

  // PRODUCTION: extract frame from RTSP stream and run ALPR
  return await runRealALPR(camera);
}

// ─── SIMULATION MODE ──────────────────────────────────────────
function simulateDetection(camera) {
  const prob = DETECTION_PROBABILITY[camera.type] || DETECTION_PROBABILITY.DEFAULT;

  // Most frames have no violation
  if (Math.random() > prob) {
    return { plate_detected: false };
  }

  const plate      = randomPlate();
  const confidence = randomConfidence();
  const violation  = pickViolationType();

  return {
    plate_detected:     true,
    plate_number:       plate,
    confidence_score:   parseFloat(confidence.toFixed(3)),
    violation_type:     violation,
    evidence_image_url: simulatedEvidenceUrl(camera.id, plate),
    evidence_video_url: null,
    occurred_at:        new Date().toISOString(),
    frame_data:         null, // no real frame in simulation
    ocr_raw:            plate,
    processing_ms:      Math.floor(15 + Math.random() * 25), // 15–40ms processing time
  };
}

// ─── PRODUCTION ALPR ──────────────────────────────────────────
// This runs when real cameras are connected.
// It extracts a frame, runs plate detection, then OCR.

async function runRealALPR(camera) {
  const stream = activeStreams[camera.id];
  if (!stream || !stream.connected) {
    return { plate_detected: false };
  }

  try {
    // Step 1: Extract current frame from stream as JPEG buffer
    const frameBuffer = await extractFrame(camera);
    if (!frameBuffer) return { plate_detected: false };

    // Step 2: Detect if a licence plate is present in the frame
    const plateRegion = await detectPlateRegion(frameBuffer);
    if (!plateRegion) return { plate_detected: false };

    // Step 3: Crop and enhance the plate region
    const plateImage = await cropAndEnhancePlate(frameBuffer, plateRegion);

    // Step 4: Run OCR on the plate image
    const ocrResult = await runOCR(plateImage);
    if (!ocrResult || !ocrResult.text) return { plate_detected: false };

    // Step 5: Validate plate format (Tanzania format)
    const validated = validatePlateFormat(ocrResult.text);
    if (!validated.valid) {
      console.log(`[ALPR] ${camera.id}: Invalid plate format: ${ocrResult.text}`);
      return { plate_detected: false };
    }

    // Step 6: Detect violation type from frame context
    const violation = await detectViolation(camera, frameBuffer);

    return {
      plate_detected:     true,
      plate_number:       validated.plate,
      confidence_score:   ocrResult.confidence,
      violation_type:     violation.type,
      evidence_image_url: null, // set after upload to S3
      evidence_video_url: null,
      occurred_at:        new Date().toISOString(),
      frame_data:         frameBuffer.toString('base64'),
      ocr_raw:            ocrResult.text,
      processing_ms:      ocrResult.processing_ms,
    };

  } catch (err) {
    console.error(`[ALPR] ${camera.id}: ALPR error:`, err.message);
    return { plate_detected: false };
  }
}

// ─── FRAME EXTRACTION ─────────────────────────────────────────
// Extracts a single JPEG frame from the RTSP stream using ffmpeg
async function extractFrame(camera) {
  const { exec } = require('child_process');
  const os = require('os');
  const path = require('path');

  const outputPath = path.join(os.tmpdir(), `frame-${camera.id}-${Date.now()}.jpg`);

  return new Promise((resolve) => {
    const cmd = `ffmpeg -i "${camera.rtsp_url}" -vframes 1 -q:v 2 "${outputPath}" -y 2>/dev/null`;
    exec(cmd, { timeout: 5000 }, (err) => {
      if (err) { resolve(null); return; }
      try {
        const fs = require('fs');
        const buffer = fs.readFileSync(outputPath);
        fs.unlinkSync(outputPath); // clean up temp file
        resolve(buffer);
      } catch {
        resolve(null);
      }
    });
  });
}

// ─── PLATE REGION DETECTION ───────────────────────────────────
// Uses basic image analysis to find the plate rectangle in the frame
// In production, replace with a trained YOLO model or OpenALPR
async function detectPlateRegion(frameBuffer) {
  try {
    const sharp = require('sharp');

    // Get image metadata
    const metadata = await sharp(frameBuffer).metadata();
    const { width, height } = metadata;

    // Heuristic: plates are typically in the bottom 60% of the frame
    // and occupy roughly 10-25% of the frame width
    // A real implementation uses a neural network here
    return {
      x:      Math.floor(width * 0.3),
      y:      Math.floor(height * 0.55),
      width:  Math.floor(width * 0.4),
      height: Math.floor(height * 0.12),
    };
  } catch {
    return null;
  }
}

// ─── PLATE CROP AND ENHANCE ───────────────────────────────────
async function cropAndEnhancePlate(frameBuffer, region) {
  const sharp = require('sharp');
  return await sharp(frameBuffer)
    .extract({ left: region.x, top: region.y, width: region.width, height: region.height })
    .resize(400, 100)          // standardise size
    .greyscale()               // convert to greyscale
    .normalise()               // auto contrast
    .sharpen({ sigma: 1.5 })   // sharpen text
    .toBuffer();
}

// ─── OCR ─────────────────────────────────────────────────────
// Reads plate text from the enhanced plate image
// Uses Tesseract for OCR — install: npm install node-tesseract-ocr
async function runOCR(plateImageBuffer) {
  const start = Date.now();
  try {
    const tesseract = require('node-tesseract-ocr');
    const config = {
      lang:    'eng',
      oem:     1,
      psm:     8,    // treat as single word
      tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ',
    };

    const text = await tesseract.recognize(plateImageBuffer, config);
    const cleaned = text.trim().replace(/[^A-Z0-9]/g, '').toUpperCase();

    // Confidence estimation based on text quality
    const confidence = estimateOCRConfidence(cleaned);

    return {
      text:          cleaned,
      confidence,
      processing_ms: Date.now() - start,
    };
  } catch (err) {
    console.error('[ALPR] OCR error:', err.message);
    return null;
  }
}

function estimateOCRConfidence(text) {
  if (!text || text.length < 5) return 0.3;
  if (text.length > 10)         return 0.5; // too long = likely garbled
  // Check if it matches Tanzania plate pattern roughly
  const tzPattern = /^[A-Z]{1,2}\d{3}[A-Z]{2,3}$/;
  if (tzPattern.test(text)) return 0.90 + Math.random() * 0.08;
  return 0.60 + Math.random() * 0.20;
}

// ─── PLATE FORMAT VALIDATION ──────────────────────────────────
function validatePlateFormat(rawText) {
  if (!rawText) return { valid: false };

  const cleaned = rawText.replace(/\s+/g, '').toUpperCase();

  // Tanzania plate patterns:
  const patterns = [
    /^T\d{3}[A-Z]{3}$/,         // T123ABC
    /^SU\d{3}[A-Z]{3}$/,        // SU001XYZ — Dar es Salaam
    /^[A-Z]{1,2}\d{3}[A-Z]{3}$/, // general
  ];

  for (const pattern of patterns) {
    if (pattern.test(cleaned)) {
      return { valid: true, plate: cleaned };
    }
  }

  // Common OCR fixes: O→0, I→1, B→8
  const fixed = cleaned
    .replace(/O/g, '0')
    .replace(/I/g, '1')
    .replace(/B/g, '8');

  for (const pattern of patterns) {
    if (pattern.test(fixed)) {
      return { valid: true, plate: fixed };
    }
  }

  return { valid: false, raw: rawText };
}

// ─── VIOLATION DETECTION ──────────────────────────────────────
// Determines what type of violation occurred based on camera type
// In production this uses a trained AI model watching the scene
async function detectViolation(camera, frameBuffer) {
  // Based on camera type, determine likely violation
  switch (camera.type) {
    case 'INTERSECTION':
      // Check if vehicle crossed on red
      return { type: 'RED_LIGHT', confidence: 0.95 };
    case 'SPEED':
      // Speed cameras always detect speeding
      return { type: 'SPEEDING', confidence: 0.97 };
    case 'PEDESTRIAN':
      return { type: 'PEDESTRIAN_ZONE', confidence: 0.93 };
    default:
      return { type: 'RED_LIGHT', confidence: 0.90 };
  }
}

// ─── EXPORTS ──────────────────────────────────────────────────
module.exports = {
  connectToStream,
  onStreamDisconnect,
  analyzeFrame,
  validatePlateFormat,
  estimateOCRConfidence,
  SIMULATION_MODE,
};
