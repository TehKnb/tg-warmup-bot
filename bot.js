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
const CHANNEL_ID = process.env.CHANNEL_ID;
const CHANNEL_URL = process.env.CHANNEL_URL;
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

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function getDisplayName(firstName) {
  return firstName ? escapeHtml(firstName) : 'друже';
}

async function getChatMember(chatId, userId) {
  return telegram('getChatMember', {
    chat_id: chatId,
    user_id: Number(userId)
  });
}

async function isSubscribedToChannel(userId) {
  try {
    const response = await getChatMember(CHANNEL_ID, userId);
    const status = response?.result?.status;

    return ['creator', 'administrator', 'member'].includes(status);
  } catch (error) {
    console.error('SUBSCRIPTION CHECK ERROR:', error);
    return false;
  }
}

async function sendWarmupIntro(chatId, firstName) {
  const name = getDisplayName(firstName);

  await telegram('sendMessage', {
    chat_id: chatId,
    parse_mode: 'HTML',
    text:
`${name}, ми підготували для вас бонусні розбори бізнесів, в яких Олександр Морозов на онлайн-зустрічах відповідає на питання підприємців та дає практичні поради для впровадження.

Але спочатку перевіримо вашу підписку на наш канал:`,
    reply_markup: {
      inline_keyboard: [
        [{ text: 'Готово✅', callback_data: 'check_subscription' }]
      ]
    }
  });
}

async function sendNotSubscribed(chatId) {
  await telegram('sendMessage', {
    chat_id: chatId,
    text: 'Не бачимо вашої підписки, спробуйте ще раз 👇🏻',
    reply_markup: {
      inline_keyboard: [
        [{ text: 'Підписатись на канал', url: CHANNEL_URL }],
        [{ text: 'Готово✅', callback_data: 'check_subscription' }]
      ]
    }
  });
}

async function sendBonusLink(chatId, telegramUserId) {
  const result = await pool.query(
    `SELECT lead_token FROM users WHERE telegram_user_id = $1`,
    [telegramUserId]
  );

  const user = result.rows[0];

  if (!user) {
    console.error('USER NOT FOUND FOR BONUS LINK');
    return;
  }

  const link = `${LANDING_URL}?lead_token=${encodeURIComponent(user.lead_token)}`;

  await telegram('sendMessage', {
    chat_id: chatId,
    text: 'Бонусні розбори вже чекають вас тут:',
    reply_markup: {
      inline_keyboard: [
        [{ text: 'Забрати бонус!', url: link }]
      ]
    }
  });
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
  try {
    const update = req.body;

    // 1. inline-кнопки
    if (update.callback_query) {
      const callback = update.callback_query;
      const data = callback.data;
      const chatId = String(callback.message.chat.id);
      const telegramUserId = String(callback.from.id);
      const username = callback.from.username || null;
      const firstName = callback.from.first_name || null;
      const callbackQueryId = callback.id;

      if (data === 'start_warmup') {
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
        }

        await telegram('answerCallbackQuery', {
          callback_query_id: callbackQueryId
        });

        await sendWarmupIntro(chatId, firstName);

        return res.sendStatus(200);
      }

      if (data === 'check_subscription') {
        const subscribed = await isSubscribedToChannel(telegramUserId);

        await telegram('answerCallbackQuery', {
          callback_query_id: callbackQueryId
        });

        if (!subscribed) {
          await sendNotSubscribed(chatId);
          return res.sendStatus(200);
        }

        await sendBonusLink(chatId);
        return res.sendStatus(200);
      }

      return res.sendStatus(200);
    }

    // 2. звичайні повідомлення
    if (!update.message || !update.message.text) {
      return res.sendStatus(200);
    }

    const message = update.message;
    const text = message.text.trim();
    const chatId = String(message.chat.id);
    const telegramUserId = String(message.from.id);
    const username = message.from.username || null;
    const firstName = message.from.first_name || null;

    if (text === '/start' || text.startsWith('/start ')) {
      await telegram('sendPhoto', {
        chat_id: chatId,
        photo: 'https://i.ibb.co/7h4WjNn/image.png',
        caption:
        `Вас вітає український Бізнес-Клуб для підприємців «Конс на Бі$»!
        Місце, яке викликає у підприємців звичку ПОСТІЙНО ЗРОСТАТИ🔥`,
        reply_markup: {
          inline_keyboard: [
            [{ text: 'Старт', callback_data: 'start_warmup' }]
          ]
        }
      });

      return res.sendStatus(200);
    }

    if (text === '/forget') {
      await pool.query(
        `DELETE FROM users WHERE telegram_user_id = $1`,
        [telegramUserId]
      );

      await telegram('sendMessage', {
        chat_id: chatId,
        text: 'Ваші дані видалено. Тепер можете почати заново через /start'
      });

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

    return res.sendStatus(200);
  } catch (error) {
    console.error('WEBHOOK ERROR:', error);
    return res.sendStatus(500);
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