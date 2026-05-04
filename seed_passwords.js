// ============================================================
// RTMS — Seed Passwords Script
// Run: node seed_passwords.js
// This will set correct bcrypt passwords for all default users
// ============================================================

require('dotenv').config();
const { Pool } = require('pg');
const bcrypt   = require('bcryptjs');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const users = [
  { username: 'admin',      password: 'Admin@2024'   },
  { username: 'officer001', password: 'Officer@2024' },
  { username: 'officer002', password: 'Officer@2024' },
  { username: 'cashier001', password: 'Cashier@2024' },
  { username: 'user001',    password: 'User@2024'    },
  {
  username:     'camera_system',
  password:     'Camera@1234',
  full_name:    'Camera System Service',
  role:         'OFFICER',
  badge_number: 'CAM-SYS',
},
];

async function seedPasswords() {
  console.log('🔐 Seeding passwords...\n');
  for (const u of users) {
    const hash = await bcrypt.hash(u.password, 10);
    await pool.query(
      'UPDATE users SET password_hash = $1 WHERE username = $2',
      [hash, u.username]
    );
    console.log(`✅  ${u.username.padEnd(12)} → password: ${u.password}`);
  }
  console.log('\n✅  All passwords set. You can now log in.');
  await pool.end();
}

seedPasswords().catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
