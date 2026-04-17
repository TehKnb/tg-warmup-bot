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
    console.log('TELEGRAM CALL:', method, payload);
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  const data = await res.json();
  console.log('TELEGRAM RESPONSE:', data);

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

app.get('/', (req, res) => {
  res.json({ ok: true, service: 'tg-warmup-bot' });
});

app.post('/telegram/webhook', async (req, res) => {
    console.log('WEBHOOK HIT');
    console.log('BODY:', JSON.stringify(req.body));

  try {
    const update = req.body;

    if (!update.message || !update.message.text) {
        console.log('NO MESSAGE TEXT');
      return res.sendStatus(200);
    }

    const message = update.message;
    const text = message.text.trim();
    const chatId = String(message.chat.id);
    const telegramUserId = String(message.from.id);
    console.log('TEXT:', text);
    console.log('CHAT ID:', chatId);
    console.log('USER ID:', telegramUserId);
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
           SET chat_id = $1,
               username = $2,
               first_name = $3,
               status = 'warming',
               next_message_at = $4,
               last_sent_step = 0
           WHERE telegram_user_id = $5`,
          [
            chatId,
            username,
            firstName,
            scheduleFirstMessageTime(),
            telegramUserId
          ]
        );

        result = await pool.query(
          `SELECT * FROM users WHERE telegram_user_id = $1`,
          [telegramUserId]
        );
        user = result.rows[0];
      }

      await telegram('sendMessage', {
        chat_id: chatId,
        text: 'Вас успішно підключено. Незабаром надішлю перше повідомлення.'
      });

      return res.sendStatus(200);
    }
    if (text === '/start') {

  // 1. КНОПКА СТАРТ
  await telegram('sendMessage', {
    chat_id: chatId,
    text: 'Натисніть кнопку нижче, щоб почати 👇',
    reply_markup: {
      keyboard: [
        [{ text: '🚀 Старт' }]
      ],
      resize_keyboard: true,
      one_time_keyboard: true
    }
  });

  return res.sendStatus(200);
}

if (text === '🚀 Старт') {

  // 2. СТВОРЕННЯ КОРИСТУВАЧА (твоя логіка)
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
  }

  // 3. КАРТИНКА + ТЕКСТ
  await telegram('sendPhoto', {
    chat_id: chatId,
    photo: 'https://i.ibb.co/7h4WjNn/image.png',
    caption:
`Вас вітає український Бізнес-Клуб для підприємців «Конс на Бі$»!
Місце, яке викликає у підприємців звичку ПОСТІЙНО ЗРОСТАТИ🔥`
  });

  return res.sendStatus(200);
}
    if (text === '/me') {
      const result = await pool.query(
        `SELECT id, telegram_user_id, chat_id, username, first_name, lead_token, status, started_at, next_message_at, last_sent_step
         FROM users
         WHERE telegram_user_id = $1`,
        [telegramUserId]
      );

      const user = result.rows[0];

      if (!user) {
        await telegram('sendMessage', {
          chat_id: chatId,
          text: 'Користувача ще немає в базі. Спочатку натисніть /start'
        });
      } else {
        await telegram('sendMessage', {
          chat_id: chatId,
          text:
            `ID: ${user.id}\n` +
            `telegram_user_id: ${user.telegram_user_id}\n` +
            `chat_id: ${user.chat_id}\n` +
            `username: ${user.username || '-'}\n` +
            `first_name: ${user.first_name || '-'}\n` +
            `lead_token: ${user.lead_token}\n` +
            `status: ${user.status}\n` +
            `started_at: ${user.started_at}\n` +
            `next_message_at: ${user.next_message_at || '-'}\n` +
            `last_sent_step: ${user.last_sent_step}`
        });
      }

      return res.sendStatus(200);
    }

    if (text === '/reset') {
      const result = await pool.query(
        `SELECT * FROM users WHERE telegram_user_id = $1`,
        [telegramUserId]
      );

      const user = result.rows[0];

      if (!user) {
        await telegram('sendMessage', {
          chat_id: chatId,
          text: 'Користувача ще немає в базі. Спочатку натисніть /start'
        });
      } else {
        await pool.query(
          `UPDATE users
           SET status = 'warming',
               next_message_at = $1,
               last_sent_step = 0
           WHERE telegram_user_id = $2`,
          [scheduleFirstMessageTime(), telegramUserId]
        );

        await telegram('sendMessage', {
          chat_id: chatId,
          text: 'Прогрів скинуто. Перше повідомлення знову прийде за розкладом.'
        });
      }

      return res.sendStatus(200);
    }

    res.sendStatus(200);
  } catch (error) {
    console.error('WEBHOOK ERROR:', error);
    res.sendStatus(500);
  }
});

app.post('/lead', async (req, res) => {
  try {
    const { lead_token } = req.body;

    if (!lead_token) {
      return res.status(400).json({ ok: false, error: 'No lead_token provided' });
    }

    const result = await pool.query(
      `UPDATE users
       SET status = 'converted',
           next_message_at = NULL
       WHERE lead_token = $1
       RETURNING id, telegram_user_id, lead_token, status`,
      [lead_token]
    );

    if (!result.rows.length) {
      return res.status(404).json({ ok: false, error: 'User not found by lead_token' });
    }

    console.log('Lead converted:', result.rows[0]);

    return res.json({ ok: true, user: result.rows[0] });
  } catch (error) {
    console.error('LEAD ERROR:', error);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

cron.schedule('* * * * *', async () => {
  try {
    const result = await pool.query(
      `SELECT * FROM users
       WHERE status = 'warming'
         AND next_message_at IS NOT NULL
         AND next_message_at <= NOW()
       ORDER BY id ASC`
    );

    const users = result.rows;

    for (const user of users) {
      const messages = getWarmupMessages(user.lead_token);
      const nextStep = user.last_sent_step + 1;
      const currentMessage = messages[user.last_sent_step];

      if (!currentMessage) {
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
        text: currentMessage
      });

      const nextMessageAt = scheduleNextByStep(nextStep);

      await pool.query(
        `UPDATE users
         SET last_sent_step = $1,
             next_message_at = $2
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

start();