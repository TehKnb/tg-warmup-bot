const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway.app')
    ? { rejectUnauthorized: false }
    : false,
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      telegram_user_id TEXT NOT NULL UNIQUE,
      chat_id TEXT NOT NULL,
      username TEXT,
      first_name TEXT,
      lead_token TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'new',
      started_at TIMESTAMP NOT NULL,
      next_message_at TIMESTAMP,
      last_sent_step INTEGER NOT NULL DEFAULT 0,
      last_slot_key TEXT,
      subscribed_at TIMESTAMP
    );
  `);

  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_slot_key TEXT`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS subscribed_at TIMESTAMP`);
}

module.exports = {
  pool,
  initDb,
};