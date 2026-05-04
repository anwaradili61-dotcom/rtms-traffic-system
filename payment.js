// ============================================================
// RTMS — Mobile Money & SMS Integration
// payment.js
//
// Integrates with:
//   1. Azampay       — Tanzania mobile money (M-Pesa, Tigo, Airtel, Halopesa)
//   2. Notify Africa — Tanzania SMS provider (sender: PUNGUZO, id: 73)
//   3. server.js     — called by POST /fines/:id/pay/mobile
//   4. processor.js  — notifies after violation fine is auto-issued
//   5. PostgreSQL    — records every transaction and notification
//
// Setup:
//   npm install axios crypto dotenv
//   Add to .env:
//     AZAMPAY_APP_NAME=RTMS
//     AZAMPAY_CLIENT_ID=your_client_id
//     AZAMPAY_CLIENT_SECRET=your_client_secret
//     AZAMPAY_BASE_URL=https://sandbox.azampay.co.tz
//     PAYMENT_CALLBACK_URL=https://your-ngrok-url/payments/callback
//     NOTIFY_API_TOKEN=ntfy_c30247b62bab4aed9ca57a6798c39f613b45250a78b26974ef7f909b624735f2
//     NOTIFY_SENDER_ID=73
//     NOTIFY_SENDER_NAME=PUNGUZO
// ============================================================

require('dotenv').config();
const axios  = require('axios');
const crypto = require('crypto');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db   = (text, params) => pool.query(text, params);

// ─── CONFIG ──────────────────────────────────────────────────
const AZAMPAY = {
  APP_NAME:     process.env.AZAMPAY_APP_NAME     || 'RTMS',
  CLIENT_ID:    process.env.AZAMPAY_CLIENT_ID    || '',
  CLIENT_SECRET:process.env.AZAMPAY_CLIENT_SECRET|| '',
  BASE_URL:     process.env.AZAMPAY_BASE_URL     || 'https://sandbox.azampay.co.tz',
  CALLBACK_URL: process.env.PAYMENT_CALLBACK_URL || 'http://localhost:3000/payments/callback',
};

// Notify Africa SMS config
const NOTIFY = {
  API_TOKEN:   process.env.NOTIFY_API_TOKEN   || '',
  SENDER_ID:   process.env.NOTIFY_SENDER_ID   || '73',
  SENDER_NAME: process.env.NOTIFY_SENDER_NAME || 'PUNGUZO',
  BASE_URL:    'https://api.notify.africa/api/v1/api/messages/send',
};

// Provider codes used by Azampay
const PROVIDER_MAP = {
  'M-Pesa':      'Mpesa',
  'Tigo Pesa':   'Tigopesa',
  'Airtel Money':'Airtel',
  'Halopesa':    'Halopesa',
};

// ─── HELPERS ─────────────────────────────────────────────────
function log(module, level, message, data = {}) {
  console.log(JSON.stringify({
    time: new Date().toISOString(),
    module, level, message, ...data
  }));
}

function generateTxnRef(prefix = 'RTMS') {
  return `${prefix}-${Date.now()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

function sanitizePhone(phone) {
  // Normalize to Tanzania format without + : 255XXXXXXXXX
  // Notify Africa requires: 255XXXXXXXXX (no + prefix)
  let p = phone.replace(/\s+/g, '').replace(/[^0-9+]/g, '');
  if (p.startsWith('0'))    p = '255' + p.slice(1);
  if (p.startsWith('+255')) p = p.slice(1);
  if (p.startsWith('+'))    p = '255' + p.slice(1);
  if (!p.startsWith('255')) p = '255' + p;
  return p;
}

// ─────────────────────────────────────────────────────────────
// ENGINE 1: AZAMPAY AUTHENTICATION
// Gets a bearer token — cached for 55 minutes
// ─────────────────────────────────────────────────────────────
let azampayToken    = null;
let azampayTokenExp = 0;

async function getAzampayToken() {
  if (azampayToken && Date.now() < azampayTokenExp) {
    return azampayToken;
  }

  log('AZAMPAY_AUTH', 'INFO', 'Fetching new Azampay token');

  const res = await axios.post(
    `${AZAMPAY.BASE_URL}/AppRegistration/GenerateToken`,
    {
      appName:      AZAMPAY.APP_NAME,
      clientId:     AZAMPAY.CLIENT_ID,
      clientSecret: AZAMPAY.CLIENT_SECRET,
    },
    { headers: { 'Content-Type': 'application/json' } }
  );

  if (!res.data?.data?.accessToken) {
    throw new Error('Azampay token fetch failed: ' + JSON.stringify(res.data));
  }

  azampayToken    = res.data.data.accessToken;
  azampayTokenExp = Date.now() + (55 * 60 * 1000);

  log('AZAMPAY_AUTH', 'INFO', 'Token obtained successfully');
  return azampayToken;
}

// ─────────────────────────────────────────────────────────────
// ENGINE 2: MOBILE MONEY CHECKOUT (Azampay)
// Sends push payment request to customer's phone
// ─────────────────────────────────────────────────────────────
async function initiateMobilePayment({
  fineId, fineNumber, amountTzs, phone, provider, ownerName,
}) {
  const txnRef          = generateTxnRef('RTMS');
  const cleanPhone      = sanitizePhone(phone);
  const azampayProvider = PROVIDER_MAP[provider];

  if (!azampayProvider) {
    throw new Error(
      `Unsupported provider: ${provider}. Use M-Pesa, Tigo Pesa, Airtel Money, or Halopesa`
    );
  }

  log('MOBILE_PAYMENT', 'INFO', 'Initiating mobile payment', {
    fineNumber, amountTzs, phone: cleanPhone, provider, txnRef
  });

  // Save pending payment to DB
  await db(
    `INSERT INTO payments
       (fine_id, amount_tzs, payment_method, provider, transaction_ref, status)
     VALUES ($1,$2,'MOBILE_MONEY',$3,$4,'PENDING')
     ON CONFLICT (transaction_ref) DO NOTHING`,
    [fineId, amountTzs, provider, txnRef]
  );

  try {
    const token = await getAzampayToken();

    const payload = {
      accountNumber: '+' + cleanPhone,
      amount:        String(Math.round(amountTzs)),
      currency:      'TZS',
      externalId:    txnRef,
      provider:      azampayProvider,
      callbackUrl:   AZAMPAY.CALLBACK_URL,
      returnUrl:     AZAMPAY.CALLBACK_URL,
      requestOrigin: 'RTMS Fine Payment',
      additionalProperties: {
        description: `RTMS Fine: ${fineNumber}`,
        ownerName:   ownerName || '',
      },
    };

    const res = await axios.post(
      `${AZAMPAY.BASE_URL}/azampay/mno/checkout`,
      payload,
      {
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${token}`,
        }
      }
    );

    log('MOBILE_PAYMENT', 'INFO', 'Azampay response', { response: res.data });

    if (res.data?.transactionId) {
      await db(
        `UPDATE payments SET status='PENDING', provider=$1 WHERE transaction_ref=$2`,
        [provider + ':' + res.data.transactionId, txnRef]
      );
    }

    return {
      success:      true,
      txnRef,
      azampayTxnId: res.data?.transactionId,
      message:      res.data?.message || 'Payment request sent to your phone',
      status:       'PENDING',
    };

  } catch (err) {
    await db(
      `UPDATE payments SET status='FAILED' WHERE transaction_ref=$1`,
      [txnRef]
    );
    const errMsg = err.response?.data?.message || err.message;
    log('MOBILE_PAYMENT', 'ERROR', 'Azampay request failed', { error: errMsg, txnRef });
    throw new Error(`Payment initiation failed: ${errMsg}`);
  }
}

// ─────────────────────────────────────────────────────────────
// ENGINE 3: PAYMENT CALLBACK HANDLER
// Called by Azampay when customer enters PIN
// Updates fine status and sends SMS receipt
// ─────────────────────────────────────────────────────────────
async function handlePaymentCallback(callbackData) {
  const { transactionId, externalId, msisdn, amount, message } = callbackData;

  log('CALLBACK', 'INFO', 'Payment callback received', { externalId, transactionId, message });

  const { rows: payRows } = await db(
    `SELECT p.*, f.id as fine_id, f.fine_number, f.amount_tzs,
            f.penalty_amount, f.status as fine_status,
            vh.owner_name, vh.owner_phone, vh.owner_email
     FROM payments p
     JOIN fines      f  ON f.id  = p.fine_id
     JOIN violations vi ON vi.id = f.violation_id
     JOIN vehicles   vh ON vh.id = vi.vehicle_id
     WHERE p.transaction_ref = $1`,
    [externalId]
  );

  if (!payRows.length) {
    log('CALLBACK', 'ERROR', 'No payment found for txnRef', { externalId });
    return { success: false, reason: 'Payment record not found' };
  }

  const pay = payRows[0];

  // Prevent duplicate processing
  if (pay.status === 'SUCCESS') {
    log('CALLBACK', 'WARN', 'Duplicate callback — already processed', { externalId });
    return { success: true, reason: 'Already processed' };
  }

  const isSuccess =
    (message || '').toLowerCase().includes('success') ||
    (message || '').toLowerCase().includes('successful');

  if (isSuccess) {
    // 1. Mark payment SUCCESS
    await db(
      `UPDATE payments SET status='SUCCESS', paid_at=NOW() WHERE transaction_ref=$1`,
      [externalId]
    );

    // 2. Mark fine PAID
    await db(
      `UPDATE fines SET status='PAID', paid_at=NOW() WHERE id=$1`,
      [pay.fine_id]
    );

    // 3. Send SMS receipt via Notify Africa
    const receiptMsg =
      `RTMS Malipo Yamethibitishwa!\n` +
      `Faini: ${pay.fine_number}\n` +
      `Kiasi: TZS ${Number(pay.amount_tzs).toLocaleString()}\n` +
      `Kumbukumbu: ${externalId}\n` +
      `Hali: IMELIPWA\n` +
      `Asante. - RTMS`;

    await sendSMS(pay.owner_phone, receiptMsg, pay.fine_id);

    // 4. Queue email notification
    if (pay.owner_email) {
      await db(
        `INSERT INTO notifications (fine_id, channel, recipient, message, status)
         VALUES ($1,'EMAIL',$2,$3,'PENDING')`,
        [pay.fine_id, pay.owner_email,
         `Payment confirmed for fine ${pay.fine_number}. ` +
         `Amount: TZS ${Number(pay.amount_tzs).toLocaleString()}. Ref: ${externalId}`]
      );
    }

    log('CALLBACK', 'INFO', 'Payment SUCCESS — fine marked PAID', {
      fine_number: pay.fine_number,
      amount:      pay.amount_tzs,
      txnRef:      externalId,
      owner:       pay.owner_name,
    });

    return {
      success:     true,
      status:      'PAID',
      fine_number: pay.fine_number,
      txnRef:      externalId,
    };

  } else {
    // Payment failed
    await db(
      `UPDATE payments SET status='FAILED' WHERE transaction_ref=$1`,
      [externalId]
    );

    const failMsg =
      `RTMS Malipo Yameshindwa\n` +
      `Faini: ${pay.fine_number}\n` +
      `Kiasi: TZS ${Number(pay.amount_tzs).toLocaleString()}\n` +
      `Sababu: ${message || 'Malipo hayakuidhinishwa'}\n` +
      `Jaribu tena: portal.rtms.go.tz`;

    await sendSMS(pay.owner_phone, failMsg, pay.fine_id);

    log('CALLBACK', 'WARN', 'Payment FAILED', {
      fine_number: pay.fine_number,
      message,
      txnRef:      externalId,
    });

    return {
      success: false,
      status:  'FAILED',
      reason:  message || 'Payment declined',
    };
  }
}

// ─────────────────────────────────────────────────────────────
// ENGINE 4: NOTIFY AFRICA SMS
// Sends real SMS to Tanzanian numbers
// Sender: PUNGUZO (ID: 73)
// ─────────────────────────────────────────────────────────────
async function sendSMS(phone, message, fineId = null) {
  if (!phone) {
    log('SMS', 'WARN', 'No phone number — SMS skipped');
    return { success: false, error: 'No phone number' };
  }

  const cleanPhone = sanitizePhone(phone);

  // Save to notifications table first
  if (fineId) {
    await db(
      `INSERT INTO notifications (fine_id, channel, recipient, message, status)
       VALUES ($1,'SMS',$2,$3,'PENDING')`,
      [fineId, cleanPhone, message]
    ).catch(() => {});
  }

  try {
    log('SMS', 'INFO', 'Sending SMS via Notify Africa', {
      phone:  cleanPhone,
      sender: NOTIFY.SENDER_NAME,
      length: message.length,
    });

    const res = await axios.post(
      NOTIFY.BASE_URL,
      {
        phone_number: cleanPhone,        // Notify Africa requires phone_number
        message,
        sender_id:    String(NOTIFY.SENDER_ID), // must be a string e.g. "73"
      },
      {
        headers: {
          'Authorization': `Bearer ${NOTIFY.API_TOKEN}`,
          'Api-Key':       NOTIFY.API_TOKEN,
          'Content-Type':  'application/json',
        }
      }
    );

    // Notify Africa returns 200 with a message_id on success
    const success =
      res.status === 200 ||
      res.status === 201 ||
      !!res.data?.message_id ||
      !!res.data?.id;

    // Update notification status in DB
    if (fineId) {
      await db(
        `UPDATE notifications
         SET status=$1, sent_at=NOW()
         WHERE fine_id=$2 AND channel='SMS' AND recipient=$3 AND status='PENDING'`,
        [success ? 'SENT' : 'FAILED', fineId, cleanPhone]
      ).catch(() => {});
    }

    log('SMS', success ? 'INFO' : 'WARN', 'Notify Africa SMS result', {
      success,
      phone:    cleanPhone,
      response: res.data,
    });

    return {
      success,
      phone:    cleanPhone,
      response: res.data,
    };

  } catch (err) {
    const errMsg = err.response?.data || err.message;
    log('SMS', 'ERROR', 'Notify Africa SMS failed', { error: errMsg, phone: cleanPhone });

    if (fineId) {
      await db(
        `UPDATE notifications SET status='FAILED'
         WHERE fine_id=$1 AND channel='SMS' AND status='PENDING'`,
        [fineId]
      ).catch(() => {});
    }

    return { success: false, error: errMsg };
  }
}

// ─────────────────────────────────────────────────────────────
// ENGINE 5: FINE ISSUED NOTIFICATION
// Called by server.js after a new fine is created
// Sends instant SMS to vehicle owner
// ─────────────────────────────────────────────────────────────
async function notifyFineIssued({
  fineId, fineNumber, amountTzs, ownerName,
  ownerPhone, ownerEmail, violationType, occurredAt,
}) {
  log('NOTIFICATION', 'INFO', 'Sending fine issued notification', { fineNumber, ownerName });

  const date = occurredAt
    ? new Date(occurredAt).toLocaleDateString('en-TZ', {
        day: 'numeric', month: 'short', year: 'numeric'
      })
    : new Date().toLocaleDateString('en-TZ');

  const smsMsg =
    `RTMS Taarifa ya Faini\n` +
    `Ndugu ${ownerName},\n` +
    `Faini: ${fineNumber}\n` +
    `Kosa: ${(violationType || '').replace(/_/g, ' ')}\n` +
    `Tarehe: ${date}\n` +
    `Kiasi: TZS ${Number(amountTzs).toLocaleString()}\n` +
    `Muda: Siku 30\n` +
    `Lipa: portal.rtms.go.tz`;

  const emailMsg =
    `Dear ${ownerName}, a traffic fine of TZS ${Number(amountTzs).toLocaleString()} ` +
    `has been issued for ${(violationType || '').replace(/_/g, ' ')} on ${date}. ` +
    `Fine ref: ${fineNumber}. Pay within 30 days at portal.rtms.go.tz`;

  const results = {};

  if (ownerPhone) {
    results.sms = await sendSMS(ownerPhone, smsMsg, fineId);
  }

  if (ownerEmail && fineId) {
    await db(
      `INSERT INTO notifications (fine_id, channel, recipient, message, status)
       VALUES ($1,'EMAIL',$2,$3,'PENDING')`,
      [fineId, ownerEmail, emailMsg]
    ).catch(() => {});
    results.email = 'queued';
  }

  return results;
}

// ─────────────────────────────────────────────────────────────
// ENGINE 6: OVERDUE REMINDER
// Called by nightly cron job — sends SMS to overdue fine owners
// ─────────────────────────────────────────────────────────────
async function sendOverdueReminders() {
  log('REMINDER', 'INFO', 'Running overdue reminder job');

  const { rows } = await db(
    `SELECT f.id, f.fine_number, f.amount_tzs, f.penalty_amount,
            vh.owner_name, vh.owner_phone
     FROM fines f
     JOIN violations vi ON vi.id = f.violation_id
     JOIN vehicles   vh ON vh.id = vi.vehicle_id
     WHERE f.status = 'OVERDUE'
       AND vh.owner_phone IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM notifications n
         WHERE n.fine_id = f.id
           AND n.channel = 'SMS'
           AND n.status  = 'SENT'
           AND n.sent_at > NOW() - INTERVAL '24 hours'
       )
     LIMIT 50`
  );

  log('REMINDER', 'INFO', `Found ${rows.length} overdue fines to remind`);

  let sent = 0;
  for (const fine of rows) {
    const total = Number(fine.amount_tzs) + Number(fine.penalty_amount || 0);
    const msg =
      `RTMS FAINI IMECHELEWA\n` +
      `Ndugu ${fine.owner_name},\n` +
      `Faini ${fine.fine_number} imechelewa.\n` +
      `Deni lote: TZS ${total.toLocaleString()} (pamoja na adhabu 50%).\n` +
      `Lipa sasa: portal.rtms.go.tz\n` +
      `Faini zisipolipwa zitapelekwa mahakamani.`;

    const result = await sendSMS(fine.owner_phone, msg, fine.id);
    if (result.success) sent++;
    await new Promise(r => setTimeout(r, 300));
  }

  log('REMINDER', 'INFO', `Overdue reminders sent: ${sent}/${rows.length}`);
  return { total: rows.length, sent };
}

// ─────────────────────────────────────────────────────────────
// ENGINE 7: APPEAL DECISION NOTIFICATION
// Called by server.js when officer decides an appeal
// ─────────────────────────────────────────────────────────────
async function notifyAppealDecision({ fineId, fineNumber, decision, ownerPhone, ownerName }) {
  const isUpheld = decision === 'UPHELD';

  const msg = isUpheld
    ? `RTMS Matokeo ya Malalamiko\n` +
      `Ndugu ${ownerName},\n` +
      `Malalamiko yako kwa faini ${fineNumber} YAMEKUBALIWA.\n` +
      `Faini imefutwa. Malipo hayahitajiki.\n` +
      `RTMS Traffic Authority`
    : `RTMS Matokeo ya Malalamiko\n` +
      `Ndugu ${ownerName},\n` +
      `Malalamiko yako kwa faini ${fineNumber} YAMEKATALIWA.\n` +
      `Tafadhali lipa faini pamoja na ada ya TZS 10,000.\n` +
      `Lipa: portal.rtms.go.tz`;

  if (ownerPhone) {
    await sendSMS(ownerPhone, msg, fineId);
  }

  log('APPEAL', 'INFO', 'Appeal decision notification sent', {
    fineNumber, decision, ownerPhone
  });
}

// ─────────────────────────────────────────────────────────────
// PAYMENT STATUS CHECK
// Citizen portal polls this to detect payment confirmation
// ─────────────────────────────────────────────────────────────
async function checkPaymentStatus(txnRef) {
  try {
    const { rows } = await db(
      `SELECT p.*, f.fine_number, f.status as fine_status
       FROM payments p
       JOIN fines f ON f.id = p.fine_id
       WHERE p.transaction_ref = $1`,
      [txnRef]
    );

    if (!rows.length) return { found: false };

    const p = rows[0];
    return {
      found:      true,
      txnRef,
      status:     p.status,
      fineNumber: p.fine_number,
      fineStatus: p.fine_status,
      amountTzs:  p.amount_tzs,
      provider:   p.provider,
      paidAt:     p.paid_at,
    };
  } catch (err) {
    return { found: false, error: err.message };
  }
}

// ─────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────
module.exports = {
  initiateMobilePayment,
  handlePaymentCallback,
  sendSMS,
  notifyFineIssued,
  notifyAppealDecision,
  sendOverdueReminders,
  checkPaymentStatus,
  sanitizePhone,
  generateTxnRef,
};
