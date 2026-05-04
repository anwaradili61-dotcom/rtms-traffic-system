// ============================================================
// RTMS — Road Traffic Management System API
// Roles: ADMIN | OFFICER | CASHIER | USER
// ============================================================

require('dotenv').config();
const express   = require('express');
const cors      = require('cors');
const { Pool }  = require('pg');
const cron      = require('node-cron');
const processor = require('./processor');
const payment   = require('./payment');
const bcrypt    = require('bcryptjs');
const jwt       = require('jsonwebtoken');

const app = express();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) throw new Error('JWT_SECRET is not defined in .env file');

app.use(cors());
app.use(express.json());

const db = (text, params) => pool.query(text, params);

function authenticateToken(req, res, next) {
  const header = req.headers['authorization'];
  const token  = header && header.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token provided' });
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid or expired token' });
    req.user = user;
    next();
  });
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role))
      return res.status(403).json({ error: `Access denied. Required: ${roles.join(' or ')}` });
    next();
  };
}

// ── HEALTH ───────────────────────────────────────────────────
app.get('/health', async (_, res) => {
  try {
    await db('SELECT 1');
    res.json({ status: 'ok', db: 'connected', time: new Date() });
  } catch (err) {
    res.json({ status: 'ok', db: 'FAILED', error: err.message });
  }
});

// ── LOGIN ────────────────────────────────────────────────────
app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ error: 'Username and password are required' });
  try {
    const { rows } = await db(
      'SELECT * FROM users WHERE username = $1 AND is_active = TRUE',
      [username.trim().toLowerCase()]
    );
    if (!rows.length)
      return res.status(401).json({ error: 'Invalid username or password' });
    const user  = rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid)
      return res.status(401).json({ error: 'Invalid username or password' });
    await db('UPDATE users SET last_login = NOW() WHERE id = $1', [user.id]);
    const token = jwt.sign(
      { id: user.id, role: user.role, username: user.username, full_name: user.full_name },
      JWT_SECRET,
      { expiresIn: '24h' }
    );
    res.json({ token, user: { id: user.id, username: user.username, full_name: user.full_name, role: user.role, badge_number: user.badge_number || null } });
  } catch (err) {
    console.error('[LOGIN ERROR]', err.message, err.stack);
    res.status(500).json({ error: 'Server error — check your DATABASE_URL in .env' });
  }
});

// ── REGISTER ─────────────────────────────────────────────────
app.post('/register', async (req, res) => {
  const { username, password, full_name, email, phone, national_id } = req.body;
  if (!username || !password || !full_name || !phone)
    return res.status(400).json({ error: 'Username, password, full name and phone are required' });
  if (password.length < 6)
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  try {
    const { rows: existing } = await db('SELECT id FROM users WHERE username = $1', [username.trim().toLowerCase()]);
    if (existing.length) return res.status(400).json({ error: 'Username already taken' });
    if (email) {
      const { rows: emailCheck } = await db('SELECT id FROM users WHERE email = $1', [email.trim().toLowerCase()]);
      if (emailCheck.length) return res.status(400).json({ error: 'Email already registered' });
    }
    const hash = await bcrypt.hash(password, 10);
    const { rows } = await db(
      `INSERT INTO users (username, password_hash, full_name, email, phone, national_id, role)
       VALUES ($1,$2,$3,$4,$5,$6,'USER') RETURNING id, username, full_name, email, phone, role`,
      [username.trim().toLowerCase(), hash, full_name, email || null, phone, national_id || null]
    );
    const newUser = rows[0];
    const token = jwt.sign(
      { id: newUser.id, role: 'USER', username: newUser.username, full_name: newUser.full_name },
      JWT_SECRET, { expiresIn: '24h' }
    );
    res.status(201).json({ message: 'Account created successfully', token, user: { id: newUser.id, username: newUser.username, full_name: newUser.full_name, role: newUser.role } });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Username or email already exists' });
    console.error('[REGISTER ERROR]', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── USERS ────────────────────────────────────────────────────
app.get('/users', authenticateToken, requireRole('ADMIN'), async (req, res) => {
  try {
    const { rows } = await db(`SELECT id, username, full_name, email, phone, role, badge_number, is_active, created_at, last_login FROM users ORDER BY role, full_name`);
    res.json({ data: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/users', authenticateToken, requireRole('ADMIN'), async (req, res) => {
  const { username, password, full_name, email, phone, role, badge_number } = req.body;
  if (!username || !password || !full_name || !role) return res.status(400).json({ error: 'username, password, full_name and role are required' });
  if (!['ADMIN','OFFICER','CASHIER','USER'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
  try {
    const hash = await bcrypt.hash(password, 10);
    const { rows } = await db(
      `INSERT INTO users (username, password_hash, full_name, email, phone, role, badge_number)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, username, full_name, email, role, badge_number`,
      [username.trim().toLowerCase(), hash, full_name, email, phone, role, badge_number]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Username or email already exists' });
    res.status(500).json({ error: err.message });
  }
});

app.patch('/users/:id/toggle', authenticateToken, requireRole('ADMIN'), async (req, res) => {
  try {
    const { rows } = await db(`UPDATE users SET is_active = NOT is_active WHERE id = $1 RETURNING id, username, full_name, role, is_active`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── VEHICLES ─────────────────────────────────────────────────
app.post('/vehicles', authenticateToken, requireRole('ADMIN','OFFICER'), async (req, res) => {
  const {
    plate_number, owner_name, owner_phone, owner_email,
    owner_national_id, owner_address,
    make, model, color, year,
    chassis_number, engine_number, registration_expiry
  } = req.body;
  if (!plate_number || !owner_name)
    return res.status(400).json({ error: 'plate_number and owner_name are required' });
  try {
    const { rows } = await db(
      `INSERT INTO vehicles
         (plate_number, owner_name, owner_phone, owner_email,
          owner_national_id, owner_address,
          make, model, color, year,
          chassis_number, engine_number, registration_expiry)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [
        plate_number.trim().toUpperCase(),
        owner_name,
        owner_phone || null,
        owner_email || null,
        owner_national_id || null,
        owner_address || null,
        make || null,
        model || null,
        color || null,
        year || null,
        chassis_number || null,
        engine_number || null,
        registration_expiry
      ]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Plate already registered' });
    res.status(500).json({ error: err.message });
  }
});

app.get('/vehicles', authenticateToken, requireRole('ADMIN','OFFICER'), async (req, res) => {
  const { plate, page = 1, limit = 20 } = req.query;
  const params = [];
  let where = '';
  if (plate) { params.push('%' + plate.toUpperCase() + '%'); where = 'WHERE plate_number ILIKE $1'; }
  params.push(Number(limit), (Number(page) - 1) * Number(limit));
  try {
    const { rows } = await db(
      `SELECT * FROM vehicles ${where} ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    res.json({ data: rows, page: Number(page) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/vehicles/:plate', authenticateToken, requireRole('ADMIN','OFFICER','CASHIER'), async (req, res) => {
  try {
    const { rows } = await db(
      `SELECT v.*,
              COUNT(f.id) AS total_fines,
              COUNT(f.id) FILTER (WHERE f.status='PAID') AS paid_fines,
              COUNT(f.id) FILTER (WHERE f.status='OVERDUE') AS overdue_fines,
              COUNT(f.id) FILTER (WHERE f.status='ISSUED') AS issued_fines,
              COALESCE(SUM(f.amount_tzs + f.penalty_amount) FILTER (WHERE f.status NOT IN ('PAID','CANCELLED')), 0) AS total_outstanding
       FROM vehicles v
       LEFT JOIN violations vi ON vi.vehicle_id = v.id
       LEFT JOIN fines f ON f.violation_id = vi.id
       WHERE v.plate_number = $1
       GROUP BY v.id`,
      [req.params.plate.toUpperCase()]
    );
    if (!rows.length) return res.status(404).json({ error: 'Vehicle not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── VIOLATIONS ───────────────────────────────────────────────
app.post('/violations', authenticateToken, requireRole('ADMIN','OFFICER'), async (req, res) => {
  try {
    const result = await processor.processDetection(req.body);
    if (!result.success) return res.status(result.stage === 'ERROR' ? 500 : 202).json(result);
    if (result.status === 'POLICE_ALERT_TRIGGERED') return res.status(200).json(result);
    if (result.fine && !result.needsReview) {
      const { rows: vRows } = await db(
        `SELECT vh.owner_name, vh.owner_phone, vh.owner_email, v.violation_type, v.occurred_at
         FROM fines f
         JOIN violations v  ON v.id  = f.violation_id
         JOIN vehicles   vh ON vh.id = v.vehicle_id
         WHERE f.id = $1`,
        [result.fine.id]
      );
      if (vRows.length) {
        const vh = vRows[0];
        await payment.notifyFineIssued({
          fineId: result.fine.id, fineNumber: result.fine.fine_number,
          amountTzs: result.fine.amount_tzs, ownerName: vh.owner_name,
          ownerPhone: vh.owner_phone, ownerEmail: vh.owner_email,
          violationType: vh.violation_type, occurredAt: vh.occurred_at
        }).catch(err => console.error('[SMS]', err.message));
      }
    }
    res.status(201).json(result);
  } catch (err) { console.error('[VIOLATIONS ERROR]', err.message); res.status(500).json({ error: err.message }); }
});

app.get('/violations/pending', authenticateToken, requireRole('ADMIN','OFFICER'), async (req, res) => {
  try {
    const { rows } = await db(
      `SELECT v.id, v.camera_id, v.violation_type, v.confidence_score,
              v.evidence_image_url, v.occurred_at, v.gps_lat, v.gps_lng,
              vh.plate_number, vh.owner_name,
              f.id AS fine_id, f.fine_number, f.amount_tzs
       FROM violations v
       JOIN vehicles vh ON vh.id = v.vehicle_id
       JOIN fines    f  ON f.violation_id = v.id
       WHERE f.status = 'PENDING' AND v.reviewed_by IS NULL
       ORDER BY v.occurred_at DESC`
    );
    res.json({ data: rows, count: rows.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/violations/:id/review', authenticateToken, requireRole('ADMIN','OFFICER'), async (req, res) => {
  const { decision, officer_id } = req.body;
  if (!decision) return res.status(400).json({ error: 'decision is required' });
  try {
    const result = await processor.reviewDetection(req.params.id, decision.toUpperCase(), officer_id || req.user.id);
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── FINES ────────────────────────────────────────────────────
app.get('/fines/:id', authenticateToken, requireRole('ADMIN','OFFICER','CASHIER'), async (req, res) => {
  try {
    const { rows } = await db(
      `SELECT f.*, v.violation_type, v.occurred_at, v.evidence_image_url, v.camera_id,
              v.gps_lat, v.gps_lng, v.confidence_score,
              vh.plate_number, vh.owner_name, vh.owner_phone, vh.owner_email,
              vh.make AS vehicle_make, vh.model AS vehicle_model, vh.color AS vehicle_color
       FROM fines f
       JOIN violations v  ON v.id  = f.violation_id
       JOIN vehicles   vh ON vh.id = v.vehicle_id
       WHERE f.id::text = $1 OR f.fine_number = $1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Fine not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/fines', async (req, res) => {
  const { plate, status, page = 1, limit = 15 } = req.query;
  const conditions = []; const params = [];
  if (plate)  { params.push(plate.toUpperCase());  conditions.push(`vh.plate_number = $${params.length}`); }
  if (status) { params.push(status.toUpperCase()); conditions.push(`f.status = $${params.length}`); }
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  params.push(Number(limit), (Number(page) - 1) * Number(limit));
  try {
    const { rows } = await db(
      `SELECT f.id, f.fine_number, f.amount_tzs, f.penalty_amount, f.status, f.due_date, f.issued_at,
              v.violation_type, v.occurred_at, v.camera_id, v.evidence_image_url,
              vh.plate_number, vh.owner_name, vh.owner_phone,
              vh.make AS vehicle_make, vh.model AS vehicle_model, vh.color AS vehicle_color
       FROM fines f
       JOIN violations v  ON v.id  = f.violation_id
       JOIN vehicles   vh ON vh.id = v.vehicle_id
       ${where}
       ORDER BY f.issued_at DESC NULLS LAST
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    res.json({ data: rows, page: Number(page), limit: Number(limit) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/fines/:id/pay', authenticateToken, requireRole('ADMIN','CASHIER'), async (req, res) => {
  const { amount_tzs, payment_method, provider, transaction_ref } = req.body;
  try {
    const { rows: fineRows } = await db(`SELECT * FROM fines WHERE id::text = $1 OR fine_number = $1`, [req.params.id]);
    if (!fineRows.length) return res.status(404).json({ error: 'Fine not found' });
    const fine = fineRows[0];
    if (fine.status === 'PAID') return res.status(400).json({ error: 'Fine already paid' });
    if (fine.status === 'CANCELLED') return res.status(400).json({ error: 'Fine has been cancelled' });
    const totalDue = Number(fine.amount_tzs) + Number(fine.penalty_amount);
    if (Number(amount_tzs) < totalDue) return res.status(400).json({ error: 'Insufficient payment', amount_due: totalDue });
    const { rows: payRows } = await db(
      `INSERT INTO payments (fine_id, amount_tzs, payment_method, provider, transaction_ref, received_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [fine.id, amount_tzs, payment_method, provider, transaction_ref || ('TXN-' + Date.now()), req.user.id]
    );
    await db(`UPDATE fines SET status='PAID', paid_at=NOW() WHERE id=$1`, [fine.id]);
    res.json({ message: 'Payment recorded', payment: payRows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Duplicate transaction reference' });
    res.status(500).json({ error: err.message });
  }
});

app.post('/fines/:id/cancel', authenticateToken, requireRole('ADMIN'), async (req, res) => {
  try {
    const { rows } = await db(`SELECT * FROM fines WHERE id::text = $1 OR fine_number = $1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Fine not found' });
    if (rows[0].status === 'PAID') return res.status(400).json({ error: 'Cannot cancel a paid fine' });
    await db(`UPDATE fines SET status='CANCELLED', cancelled_by=$1, cancelled_at=NOW() WHERE id=$2`, [req.user.id, rows[0].id]);
    res.json({ message: 'Fine cancelled successfully' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/fines/:id/appeal', async (req, res) => {
  const { reason, supporting_docs } = req.body;
  if (!reason) return res.status(400).json({ error: 'Reason is required' });
  try {
    const { rows: fineRows } = await db(`SELECT * FROM fines WHERE id::text = $1 OR fine_number = $1`, [req.params.id]);
    if (!fineRows.length) return res.status(404).json({ error: 'Fine not found' });
    const fine = fineRows[0];
    if (!['ISSUED','PENDING','OVERDUE'].includes(fine.status))
      return res.status(400).json({ error: `Cannot appeal a ${fine.status} fine` });
    const { rows: appealRows } = await db(
      `INSERT INTO appeals (fine_id, reason, supporting_docs) VALUES ($1,$2,$3) RETURNING *`,
      [fine.id, reason, supporting_docs || []]
    );
    await db(`UPDATE fines SET status='APPEALED' WHERE id=$1`, [fine.id]);
    res.status(201).json({ appeal: appealRows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/appeals/:id/decide', authenticateToken, requireRole('ADMIN'), async (req, res) => {
  const { decision, decision_notes } = req.body;
  if (!['UPHELD','DISMISSED'].includes(decision))
    return res.status(400).json({ error: 'Decision must be UPHELD or DISMISSED' });
  try {
    const { rows: appealRows } = await db(
      `UPDATE appeals SET status=$1, decision_notes=$2, reviewed_by=$3, decided_at=NOW() WHERE id=$4 RETURNING *`,
      [decision, decision_notes, req.user.id, req.params.id]
    );
    if (!appealRows.length) return res.status(404).json({ error: 'Appeal not found' });
    const appeal = appealRows[0];
    if (decision === 'UPHELD') {
      await db(`UPDATE fines SET status='CANCELLED', cancelled_by=$1, cancelled_at=NOW() WHERE id=$2`, [req.user.id, appeal.fine_id]);
    } else {
      await db(`UPDATE fines SET status='ISSUED', penalty_amount=penalty_amount+10000 WHERE id=$1`, [appeal.fine_id]);
    }
    const { rows: fRows } = await db(
      `SELECT f.fine_number, vh.owner_phone, vh.owner_name
       FROM fines f
       JOIN violations v  ON v.id  = f.violation_id
       JOIN vehicles   vh ON vh.id = v.vehicle_id
       WHERE f.id = $1`,
      [appeal.fine_id]
    );
    if (fRows.length) {
      await payment.notifyAppealDecision({
        fineId: appeal.fine_id, fineNumber: fRows[0].fine_number,
        decision, ownerPhone: fRows[0].owner_phone, ownerName: fRows[0].owner_name
      }).catch(err => console.error('[SMS]', err.message));
    }
    res.json({ appeal });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── DASHBOARD STATS ──────────────────────────────────────────
app.get('/dashboard/stats', authenticateToken, requireRole('ADMIN','OFFICER','CASHIER'), async (_, res) => {
  try {
    const { rows } = await db(
      `SELECT COUNT(*) AS total_fines,
              COUNT(*) FILTER (WHERE status='PAID') AS paid,
              COUNT(*) FILTER (WHERE status='OVERDUE') AS overdue,
              COUNT(*) FILTER (WHERE status='APPEALED') AS appealed,
              COUNT(*) FILTER (WHERE status='ISSUED') AS pending_payment,
              COUNT(*) FILTER (WHERE status='COURT_REFERRED') AS court_referred,
              COALESCE(SUM(amount_tzs + penalty_amount) FILTER (WHERE status='PAID'), 0) AS total_collected_tzs,
              COALESCE(SUM(amount_tzs + penalty_amount) FILTER (WHERE status IN ('ISSUED','OVERDUE')), 0) AS total_outstanding_tzs
       FROM fines`
    );
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── CITIZEN PORTAL ───────────────────────────────────────────
app.get('/portal/fines', async (req, res) => {
  const { plate } = req.query;
  if (!plate) return res.status(400).json({ error: 'plate query parameter is required' });
  try {
    const { rows } = await db(
      `SELECT f.id, f.fine_number, f.amount_tzs, f.penalty_amount, f.status,
              f.due_date, f.issued_at, f.paid_at,
              v.violation_type, v.occurred_at, v.evidence_image_url, v.camera_id,
              vh.plate_number, vh.owner_name, vh.owner_phone,
              vh.make, vh.model, vh.color
       FROM fines f
       JOIN violations v  ON v.id  = f.violation_id
       JOIN vehicles   vh ON vh.id = v.vehicle_id
       WHERE vh.plate_number = $1
       ORDER BY f.issued_at DESC NULLS LAST`,
      [plate.toUpperCase()]
    );
    res.json({ data: rows, count: rows.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/my/fines', authenticateToken, requireRole('USER'), async (req, res) => {
  try {
    const { rows: uRows } = await db('SELECT * FROM users WHERE id = $1', [req.user.id]);
    const u = uRows[0];
    const { rows } = await db(
      `SELECT f.id, f.fine_number, f.amount_tzs, f.penalty_amount, f.status,
              f.due_date, f.issued_at, f.paid_at,
              v.violation_type, v.occurred_at, v.evidence_image_url,
              vh.plate_number, vh.owner_name, vh.make, vh.model, vh.color
       FROM fines f
       JOIN violations v  ON v.id  = f.violation_id
       JOIN vehicles   vh ON vh.id = v.vehicle_id
       WHERE vh.owner_email = $1 OR vh.owner_phone = $2
       ORDER BY f.issued_at DESC NULLS LAST`,
      [u.email || '', u.phone || '']
    );
    res.json({ data: rows, user: { full_name: u.full_name, email: u.email, phone: u.phone } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/my/vehicles', authenticateToken, requireRole('USER'), async (req, res) => {
  try {
    const { rows: uRows } = await db('SELECT * FROM users WHERE id = $1', [req.user.id]);
    const u = uRows[0];
    const { rows } = await db(
      `SELECT v.*,
              COUNT(f.id) AS total_fines,
              COUNT(f.id) FILTER (WHERE f.status='PAID') AS paid_fines,
              COUNT(f.id) FILTER (WHERE f.status IN ('ISSUED','OVERDUE')) AS unpaid_fines,
              COALESCE(SUM(f.amount_tzs + f.penalty_amount) FILTER (WHERE f.status IN ('ISSUED','OVERDUE')), 0) AS total_outstanding
       FROM vehicles v
       LEFT JOIN violations vi ON vi.vehicle_id = v.id
       LEFT JOIN fines      f  ON f.violation_id = vi.id
       WHERE v.owner_email = $1 OR v.owner_phone = $2
       GROUP BY v.id
       ORDER BY v.created_at DESC`,
      [u.email || '', u.phone || '']
    );
    res.json({ data: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── CRON ─────────────────────────────────────────────────────
cron.schedule('0 0 * * *', async () => {
  try {
    const { rowCount } = await db(
      `UPDATE fines SET status='OVERDUE', penalty_amount=amount_tzs*0.5, overdue_at=NOW()
       WHERE status='ISSUED' AND due_date < CURRENT_DATE`
    );
    console.log(`[CRON] Marked ${rowCount} fines as OVERDUE`);
    const { rowCount: c } = await db(
      `UPDATE fines SET status='COURT_REFERRED'
       WHERE status='OVERDUE' AND overdue_at < NOW() - INTERVAL '60 days'`
    );
    console.log(`[CRON] Court-referred ${c} fines`);
    await payment.sendOverdueReminders().catch(err => console.error('[CRON SMS]', err.message));
  } catch (err) { console.error('[CRON ERROR]', err.message); }
});

// ── MOBILE MONEY ─────────────────────────────────────────────
app.post('/fines/:id/pay/mobile', async (req, res) => {
  const { phone, provider, amount_tzs } = req.body;
  if (!phone || !provider) return res.status(400).json({ error: 'phone and provider are required' });
  try {
    const { rows } = await db(
      `SELECT f.*, vh.owner_name, vh.owner_phone
       FROM fines f
       JOIN violations v  ON v.id  = f.violation_id
       JOIN vehicles   vh ON vh.id = v.vehicle_id
       WHERE f.id::text = $1 OR f.fine_number = $1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Fine not found' });
    const fine = rows[0];
    if (fine.status === 'PAID') return res.status(400).json({ error: 'Fine already paid' });
    if (fine.status === 'CANCELLED') return res.status(400).json({ error: 'Fine has been cancelled' });
    const totalDue = Number(fine.amount_tzs) + Number(fine.penalty_amount || 0);
    const result = await payment.initiateMobilePayment({
      fineId: fine.id, fineNumber: fine.fine_number,
      amountTzs: amount_tzs || totalDue, phone, provider, ownerName: fine.owner_name
    });
    res.json(result);
  } catch (err) { console.error('[MOBILE PAY ERROR]', err.message); res.status(500).json({ error: err.message }); }
});

app.post('/payments/callback', async (req, res) => {
  console.log('[CALLBACK] Azampay callback received:', JSON.stringify(req.body));
  try {
    const result = await payment.handlePaymentCallback(req.body);
    res.status(200).json({ success: true, ...result });
  } catch (err) { console.error('[CALLBACK ERROR]', err.message); res.status(200).json({ success: false, error: err.message }); }
});

app.get('/payments/status/:txnRef', async (req, res) => {
  try {
    const result = await payment.checkPaymentStatus(req.params.txnRef);
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/sms/send', authenticateToken, requireRole('ADMIN'), async (req, res) => {
  const { phone, message, fine_id } = req.body;
  if (!phone || !message) return res.status(400).json({ error: 'phone and message required' });
  try {
    const result = await payment.sendSMS(phone, message, fine_id || null);
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/notifications', authenticateToken, requireRole('ADMIN','OFFICER'), async (req, res) => {
  const { status, channel, page = 1, limit = 20 } = req.query;
  const conditions = []; const params = [];
  if (status)  { params.push(status.toUpperCase());  conditions.push(`n.status=$${params.length}`); }
  if (channel) { params.push(channel.toUpperCase()); conditions.push(`n.channel=$${params.length}`); }
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  params.push(Number(limit), (Number(page) - 1) * Number(limit));
  try {
    const { rows } = await db(
      `SELECT n.*, f.fine_number FROM notifications n
       JOIN fines f ON f.id = n.fine_id
       ${where}
       ORDER BY n.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    res.json({ data: rows, page: Number(page) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── START ────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅  RTMS API running on port ${PORT}`));
