const bcrypt = require('bcryptjs');

async function run() {
  const password = "admin123"; // change if you want
  const hashed = await bcrypt.hash(password, 10);
  console.log(hashed);
}

run();