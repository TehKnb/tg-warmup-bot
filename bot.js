require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const cron = require('node-cron');
const { pool, initDb } = require('./db');

const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const BASE_URL = process.env.BASE_URL;
const LANDING_URL = process.env.LANDING_URL;
const PORT = process.env.PORT || 3000;

function generateToken() {
  return crypto.randomBytes(16).toString('hex');
}

async function telegram(method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  const data = await res.json();
  if (!data.ok) {
    throw new Error(JSON.stringify(data));
  }
  return data;
}

function buildLandingLink(leadToken) {
  return `${LANDING_URL}?lead_token=${encodeURIComponent(leadToken)}`;
}

function getWarmupMessages(leadToken) {
  const link = buildLandingLink(leadToken);

  return [
    `Привіт! Підготували для вас матеріал.\n\nПерейдіть за посиланням:\n${link}`,
    `Надсилаю ще раз посилання, щоб не загубилось:\n${link}`,
    `Якщо актуально, залиште контакти на сторінці:\n${link}`
  ];
}

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60000);
}

function scheduleFirstMessageTime() {
  return addMinutes(new Date(), 5).toISOString();
}

function scheduleNextByStep(step) {
  const now = new Date();

  if (step === 1) return addMinutes(now, 60).toISOString();
  if (step === 2) return addMinutes(now, 24 * 60).toISOString();

  return null;
}

app.post('/telegram/webhook', async (req, res) => {
  try {
    const update = req.body;

    if (!update.message || !update.message.text) {
      return res.sendStatus(200);
    }

    const message = update.message;
    const text = message.text.trim();
    const chatId = String(message.chat.id);
    const telegramUserId = String(message.from.id);
    const username = message.from.username || null;
    const firstName = message.from.first_name || null;

    if (text.startsWith('/start')) {
      let result = await pool.query(
        `SELECT * FROM users WHERE telegram_user_id = $1`,
        [telegramUserId]
      );

      let user = result.rows[0];

      if (!user) {
        const leadToken = generateToken();

        await pool.query(
          `INSERT INTO users (
            telegram_user_id,
            chat_id,
            username,
            first_name,
            lead_token,
            status,
            started_at,
            next_message_at,
            last_sent_step
          ) VALUES ($1, $2, $3, $4, $5, 'warming', $6, $7, 0)`,
          [
            telegramUserId,
            chatId,
            username,
            firstName,
            leadToken,
            new Date().toISOString(),
            scheduleFirstMessageTime()
          ]
        );

        result = await pool.query(
          `SELECT * FROM users WHERE telegram_user_id = $1`,
          [telegramUserId]
        );
        user = result.rows[0];
      } else {
        await pool.query(
          `UPDATE users
           SET chat_id = $1, username = $2, first_name = $3, status = 'warming'
           WHERE telegram_user_id = $4`,
          [chatId, username, firstName, telegramUserId]
        );
      }

      await telegram('sendMessage', {
        chat_id: chatId,
        text: 'Вас успішно підключено. Незабаром надішлю перше повідомлення.'
      });
    }

    res.sendStatus(200);
  } catch (error) {
    console.error('WEBHOOK ERROR:', error);
    res.sendStatus(500);
  }
});

cron.schedule('* * * * *', async () => {
  try {
    const result = await pool.query(
      `SELECT * FROM users
       WHERE status = 'warming'
         AND next_message_at IS NOT NULL
         AND next_message_at <= NOW()`
    );

    const users = result.rows;

    for (const user of users) {
      const messages = getWarmupMessages(user.lead_token);
      const nextStep = user.last_sent_step + 1;

      if (!messages[user.last_sent_step]) {
        await pool.query(
          `UPDATE users
           SET next_message_at = NULL
           WHERE id = $1`,
          [user.id]
        );
        continue;
      }

      await telegram('sendMessage', {
        chat_id: user.chat_id,
        text: messages[user.last_sent_step]
      });

      const nextMessageAt = scheduleNextByStep(nextStep);

      await pool.query(
        `UPDATE users
         SET last_sent_step = $1, next_message_at = $2
         WHERE id = $3`,
        [nextStep, nextMessageAt, user.id]
      );
    }
  } catch (error) {
    console.error('CRON ERROR:', error);
  }
});

async function start() {
  try {
    await initDb();

    app.listen(PORT, async () => {
      try {
        await telegram('setWebhook', {
          url: `${BASE_URL}/telegram/webhook`
        });

        console.log(`Server running on port ${PORT}`);
        console.log(`Webhook set to ${BASE_URL}/telegram/webhook`);
      } catch (error) {
        console.error('SET WEBHOOK ERROR:', error);
      }
    });
  } catch (error) {
    console.error('START ERROR:', error);
    process.exit(1);
  }
}
console.log('DATABASE_URL exists:', !!process.env.DATABASE_URL);
console.log('DATABASE_URL prefix:', process.env.DATABASE_URL?.slice(0, 18));
start();