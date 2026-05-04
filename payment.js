// ============================================================
// RTMS — Mobile Money & SMS Integration
// payment.js
// © SEUSHI, ANWAR 2025 | Dar es Salaam, Tanzania
// ============================================================

require('dotenv').config();
const axios  = require('axios');
const crypto = require('crypto');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
const db = (text, params) => pool.query(text, params);

// ─── CONFIG ──────────────────────────────────────────────────
const AZAMPAY = {
  APP_NAME:     process.env.AZAMPAY_APP_NAME     || 'RTMS',
  CLIENT_ID:    process.env.AZAMPAY_CLIENT_ID    || '',
  CLIENT_SECRET:process.env.AZAMPAY_CLIENT_SECRET|| '',
  BASE_URL:     process.env.AZAMPAY_BASE_URL     || 'https://sandbox.azampay.co.tz',
  // Auth URL is DIFFERENT from BASE_URL — this was causing the 404
  AUTH_URL:     process.env.AZAMPAY_AUTH_URL     || 'https://authenticator-sandbox.azampay.co.tz',
  CALLBACK_URL: process.env.PAYMENT_CALLBACK_URL || 'http://localhost:3000/payments/callback',
};

const NOTIFY = {
  API_TOKEN:   process.env.NOTIFY_API_TOKEN   || '',
  SENDER_ID:   process.env.NOTIFY_SENDER_ID   || '73',
  SENDER_NAME: process.env.NOTIFY_SENDER_NAME || 'PUNGUZO',
  BASE_URL:    'https://api.notify.africa/api/v1/api/messages/send',
};

const PROVIDER_MAP = {
  'M-Pesa':      'Mpesa',
  'Tigo Pesa':   'Tigopesa',
  'Airtel Money':'Airtel',
  'Halopesa':    'Halopesa',
};

// ─── HELPERS ─────────────────────────────────────────────────
function log(module, level, message, data = {}) {
  console.log(JSON.stringify({ time: new Date().toISOString(), module, level, message, ...data }));
}

function generateTxnRef(prefix = 'RTMS') {
  return `${prefix}-${Date.now()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

function sanitizePhone(phone) {
  let p = phone.replace(/\s+/g, '').replace(/[^0-9+]/g, '');
  if (p.startsWith('0'))    p = '255' + p.slice(1);
  if (p.startsWith('+255')) p = p.slice(1);
  if (p.startsWith('+'))    p = '255' + p.slice(1);
  if (!p.startsWith('255')) p = '255' + p;
  return p;
}

// ─────────────────────────────────────────────────────────────
// ENGINE 1: AZAMPAY AUTHENTICATION
// Uses AUTH_URL (authenticator-sandbox.azampay.co.tz)
// NOT BASE_URL — this was the root cause of the 404 error
// ─────────────────────────────────────────────────────────────
let azampayToken    = null;
let azampayTokenExp = 0;

async function getAzampayToken() {
  if (azampayToken && Date.now() < azampayTokenExp) {
    return azampayToken;
  }

  log('AZAMPAY_AUTH', 'INFO', 'Fetching new Azampay token', {
    authUrl: AZAMPAY.AUTH_URL
  });

  const res = await axios.post(
    `${AZAMPAY.AUTH_URL}/AppRegistration/GenerateToken`,
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
// ENGINE 2: MOBILE MONEY CHECKOUT
// Sends push payment request to customer's phone
// ─────────────────────────────────────────────────────────────
async function initiateMobilePayment({
  fineId, fineNumber, amountTzs, phone, provider, ownerName,
}) {
  const txnRef          = generateTxnRef('RTMS');
  const cleanPhone      = sanitizePhone(phone);
  const azampayProvider = PROVIDER_MAP[provider];

  if (!azampayProvider) {
    throw new Error(`Unsupported provider: ${provider}. Use M-Pesa, Tigo Pesa, Airtel Money, or Halopesa`);
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

    log('MOBILE_PAYMENT', 'INFO', 'Sending to Azampay checkout', {
      url: `${AZAMPAY.BASE_URL}/azampay/mno/checkout`
    });

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
    const errMsg = err.response?.data?.message || err.response?.data || err.message;
log('MOBILE_PAYMENT', 'ERROR', 'Azampay full error', { 
  status: err.response?.status,
  data: JSON.stringify(err.response?.data),
  url: `${AZAMPAY.BASE_URL}/azampay/mno/checkout`,
  headers: err.response?.headers
});
    log('MOBILE_PAYMENT', 'ERROR', 'Azampay request failed', { error: errMsg, txnRef });
    throw new Error(`Payment initiation failed: ${errMsg}`);
  }
}

// ─────────────────────────────────────────────────────────────
// ENGINE 3: PAYMENT CALLBACK HANDLER
// Called by Azampay when customer enters PIN
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

  if (pay.status === 'SUCCESS') {
    log('CALLBACK', 'WARN', 'Duplicate callback — already processed', { externalId });
    return { success: true, reason: 'Already processed' };
  }

  const isSuccess =
    (message || '').toLowerCase().includes('success') ||
    (message || '').toLowerCase().includes('successful');

  if (isSuccess) {
    await db(`UPDATE payments SET status='SUCCESS', paid_at=NOW() WHERE transaction_ref=$1`, [externalId]);
    await db(`UPDATE fines SET status='PAID', paid_at=NOW() WHERE id=$1`, [pay.fine_id]);

    const receiptMsg =
      `RTMS Malipo Yamethibitishwa!\n` +
      `Faini: ${pay.fine_number}\n` +
      `Kiasi: TZS ${Number(pay.amount_tzs).toLocaleString()}\n` +
      `Kumbukumbu: ${externalId}\n` +
      `Hali: IMELIPWA\n` +
      `Asante. - RTMS`;

    await sendSMS(pay.owner_phone, receiptMsg, pay.fine_id);

    if (pay.owner_email) {
      await db(
        `INSERT INTO notifications (fine_id, channel, recipient, message, status) VALUES ($1,'EMAIL',$2,$3,'PENDING')`,
        [pay.fine_id, pay.owner_email, `Payment confirmed for fine ${pay.fine_number}. Amount: TZS ${Number(pay.amount_tzs).toLocaleString()}. Ref: ${externalId}`]
      );
    }

    log('CALLBACK', 'INFO', 'Payment SUCCESS — fine marked PAID', { fine_number: pay.fine_number, txnRef: externalId });
    return { success: true, status: 'PAID', fine_number: pay.fine_number, txnRef: externalId };

  } else {
    await db(`UPDATE payments SET status='FAILED' WHERE transaction_ref=$1`, [externalId]);

    const failMsg =
      `RTMS Malipo Yameshindwa\n` +
      `Faini: ${pay.fine_number}\n` +
      `Kiasi: TZS ${Number(pay.amount_tzs).toLocaleString()}\n` +
      `Sababu: ${message || 'Malipo hayakuidhinishwa'}\n` +
      `Jaribu tena: portal.rtms.go.tz`;

    await sendSMS(pay.owner_phone, failMsg, pay.fine_id);

    log('CALLBACK', 'WARN', 'Payment FAILED', { fine_number: pay.fine_number, message, txnRef: externalId });
    return { success: false, status: 'FAILED', reason: message || 'Payment declined' };
  }
}

// ─────────────────────────────────────────────────────────────
// ENGINE 4: NOTIFY AFRICA SMS
// ─────────────────────────────────────────────────────────────
async function sendSMS(phone, message, fineId = null) {
  if (!phone) {
    log('SMS', 'WARN', 'No phone number — SMS skipped');
    return { success: false, error: 'No phone number' };
  }

  const cleanPhone = sanitizePhone(phone);

  if (fineId) {
    await db(
      `INSERT INTO notifications (fine_id, channel, recipient, message, status) VALUES ($1,'SMS',$2,$3,'PENDING')`,
      [fineId, cleanPhone, message]
    ).catch(() => {});
  }

  try {
    log('SMS', 'INFO', 'Sending SMS via Notify Africa', { phone: cleanPhone });

    const res = await axios.post(
      NOTIFY.BASE_URL,
      {
        phone_number: cleanPhone,
        message,
        sender_id:    String(NOTIFY.SENDER_ID),
      },
      {
        headers: {
          'Authorization': `Bearer ${NOTIFY.API_TOKEN}`,
          'Content-Type':  'application/json',
        }
      }
    );

    const success = res.status === 200 || res.status === 201 || !!res.data?.message_id || !!res.data?.id;

    if (fineId) {
      await db(
        `UPDATE notifications SET status=$1, sent_at=NOW() WHERE fine_id=$2 AND channel='SMS' AND recipient=$3 AND status='PENDING'`,
        [success ? 'SENT' : 'FAILED', fineId, cleanPhone]
      ).catch(() => {});
    }

    log('SMS', success ? 'INFO' : 'WARN', 'Notify Africa SMS result', { success, phone: cleanPhone });
    return { success, phone: cleanPhone, response: res.data };

  } catch (err) {
    const errMsg = err.response?.data || err.message;
    log('SMS', 'ERROR', 'Notify Africa SMS failed', { error: errMsg, phone: cleanPhone });
    if (fineId) {
      await db(`UPDATE notifications SET status='FAILED' WHERE fine_id=$1 AND channel='SMS' AND status='PENDING'`, [fineId]).catch(() => {});
    }
    return { success: false, error: errMsg };
  }
}

// ─────────────────────────────────────────────────────────────
// ENGINE 5: FINE ISSUED NOTIFICATION
// ─────────────────────────────────────────────────────────────
async function notifyFineIssued({ fineId, fineNumber, amountTzs, ownerName, ownerPhone, ownerEmail, violationType, occurredAt }) {
  const date = occurredAt
    ? new Date(occurredAt).toLocaleDateString('en-TZ', { day:'numeric', month:'short', year:'numeric' })
    : new Date().toLocaleDateString('en-TZ');

  const smsMsg =
    `RTMS Taarifa ya Faini\n` +
    `Ndugu ${ownerName},\n` +
    `Faini: ${fineNumber}\n` +
    `Kosa: ${(violationType||'').replace(/_/g,' ')}\n` +
    `Tarehe: ${date}\n` +
    `Kiasi: TZS ${Number(amountTzs).toLocaleString()}\n` +
    `Muda: Siku 30\n` +
    `Lipa: portal.rtms.go.tz`;

  const results = {};
  if (ownerPhone) results.sms = await sendSMS(ownerPhone, smsMsg, fineId);
  if (ownerEmail && fineId) {
    await db(
      `INSERT INTO notifications (fine_id, channel, recipient, message, status) VALUES ($1,'EMAIL',$2,$3,'PENDING')`,
      [fineId, ownerEmail, `Dear ${ownerName}, fine ${fineNumber} of TZS ${Number(amountTzs).toLocaleString()} issued for ${(violationType||'').replace(/_/g,' ')} on ${date}. Pay at portal.rtms.go.tz`]
    ).catch(() => {});
    results.email = 'queued';
  }
  return results;
}

// ─────────────────────────────────────────────────────────────
// ENGINE 6: OVERDUE REMINDER
// ─────────────────────────────────────────────────────────────
async function sendOverdueReminders() {
  log('REMINDER', 'INFO', 'Running overdue reminder job');

  const { rows } = await db(
    `SELECT f.id, f.fine_number, f.amount_tzs, f.penalty_amount, vh.owner_name, vh.owner_phone
     FROM fines f
     JOIN violations vi ON vi.id = f.violation_id
     JOIN vehicles   vh ON vh.id = vi.vehicle_id
     WHERE f.status = 'OVERDUE'
       AND vh.owner_phone IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM notifications n
         WHERE n.fine_id = f.id AND n.channel = 'SMS' AND n.status = 'SENT'
           AND n.sent_at > NOW() - INTERVAL '24 hours'
       )
     LIMIT 50`
  );

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
// ─────────────────────────────────────────────────────────────
async function notifyAppealDecision({ fineId, fineNumber, decision, ownerPhone, ownerName }) {
  const isUpheld = decision === 'UPHELD';
  const msg = isUpheld
    ? `RTMS Matokeo ya Malalamiko\nNdugu ${ownerName},\nMalalamiko yako kwa faini ${fineNumber} YAMEKUBALIWA.\nFaini imefutwa. Malipo hayahitajiki.\nRTMS Traffic Authority`
    : `RTMS Matokeo ya Malalamiko\nNdugu ${ownerName},\nMalalamiko yako kwa faini ${fineNumber} YAMEKATALIWA.\nTafadhali lipa faini pamoja na ada ya TZS 10,000.\nLipa: portal.rtms.go.tz`;

  if (ownerPhone) await sendSMS(ownerPhone, msg, fineId);
  log('APPEAL', 'INFO', 'Appeal decision notification sent', { fineNumber, decision, ownerPhone });
}

// ─────────────────────────────────────────────────────────────
// PAYMENT STATUS CHECK
// ─────────────────────────────────────────────────────────────
async function checkPaymentStatus(txnRef) {
  try {
    const { rows } = await db(
      `SELECT p.*, f.fine_number, f.status as fine_status FROM payments p JOIN fines f ON f.id = p.fine_id WHERE p.transaction_ref = $1`,
      [txnRef]
    );
    if (!rows.length) return { found: false };
    const p = rows[0];
    return { found: true, txnRef, status: p.status, fineNumber: p.fine_number, fineStatus: p.fine_status, amountTzs: p.amount_tzs, provider: p.provider, paidAt: p.paid_at };
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
