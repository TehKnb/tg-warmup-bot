const Database = require('better-sqlite3');

const db = new Database('bot.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_user_id TEXT NOT NULL UNIQUE,
    chat_id TEXT NOT NULL,
    username TEXT,
    first_name TEXT,
    lead_token TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'warming',
    started_at TEXT NOT NULL,
    next_message_at TEXT,
    last_sent_step INTEGER NOT NULL DEFAULT 0
  );
`);

module.exports = db;