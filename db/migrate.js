require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

async function migrate() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined
  });

  // List of SQL files to run in order
  const sqlFiles = [
    'schema.sql',
    'migration-002-checkin-form.sql',
    'migration-003-payments.sql',
    'migration-multi-pms.sql'
  ];

  try {
    for (const file of sqlFiles) {
      const filePath = path.join(__dirname, file);
      if (fs.existsSync(filePath)) {
        const sql = fs.readFileSync(filePath, 'utf8');
        await pool.query(sql);
        console.log('Executed: ' + file);
      } else {
        console.log('Skipped (not found): ' + file);
      }
    }
    console.log('Migration complete -- all files executed.');
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

migrate();
