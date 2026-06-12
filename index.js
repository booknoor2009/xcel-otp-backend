require('dotenv').config();
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const cors = require('cors');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

const app = express();
app.use(express.json());
app.use(cors());

initializeApp({
  credential: cert({
    projectId:   process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  }),
});

const db = getFirestore();
const SESSIONS = 'bot_sessions';

const BOT_TOKEN = process.env.BOT_TOKEN || '8925798122:AAGxxMZc_zTTGli59_6PbEn4tYs5DQMvfko';
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// ══════════════════════════════════════════
//   حماية Rate Limiting في الذاكرة
//   حد: 5 طلبات لكل IP كل 10 دقائق
// ══════════════════════════════════════════
const rateLimitMap = new Map();
const RATE_LIMIT    = 5;
const RATE_WINDOW   = 10 * 60 * 1000; // 10 دقائق

function isRateLimited(ip) {
  const now  = Date.now();
  const data = rateLimitMap.get(ip) || { count: 0, firstRequest: now };

  // إعادة تعيين إذا انتهت النافذة الزمنية
  if (now - data.firstRequest > RATE_WINDOW) {
    rateLimitMap.set(ip, { count: 1, firstRequest: now });
    return false;
  }

  if (data.count >= RATE_LIMIT) return true;

  data.count++;
  rateLimitMap.set(ip, data);
  return false;
}

// ══════════════════════════════════════════
//   حماية: تحقق من صحة username تلجرام
// ══════════════════════════════════════════
function isValidUsername(username) {
  // يجب أن يكون 5-32 حرف، أحرف وأرقام وunderscore فقط
  return /^[a-zA-Z0-9_]{5,32}$/.test(username);
}

// ══════════════════════════════════════════
//   Middleware: Rate Limiter
// ══════════════════════════════════════════
function rateLimitMiddleware(req, res, next) {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  if (isRateLimited(ip)) {
    console.warn(`🚫 Rate limit exceeded: ${ip}`);
    return res.status(429).json({
      success: false,
      message: 'طلبات كثيرة جداً، انتظر 10 دقائق وحاول مجدداً ⏳',
    });
  }
  next();
}

// /start — حفظ chatId في Firestore
bot.onText(/\/start/, async (msg) => {
  const chatId   = msg.chat.id;
  const username = msg.from.username;

  if (!username) {
    bot.sendMessage(chatId,
      '⚠️ يجب أن يكون لديك username في تلجرام!\n' +
      'اذهب إلى الإعدادات → تعيين اسم مستخدم'
    );
    return;
  }

  try {
    await db.collection(SESSIONS).doc(username.toLowerCase()).set({
      chatId: chatId.toString(), username, linkedAt: new Date(),
    }, { merge: true });

    await bot.sendMessage(chatId,
      `✅ مرحباً ${msg.from.first_name}!\n\n` +
      `تم ربط حسابك بتطبيق XCEL بنجاح 🎉\n\n` +
      `ستصلك رموز التحقق هنا عند تسجيل الدخول أو إنشاء الحساب.`
    );
    console.log(`✅ Linked: @${username} → ${chatId}`);
  } catch (err) {
    console.error('Error saving session:', err);
  }
});

// POST /send-otp — مع Rate Limiting
app.post('/send-otp', rateLimitMiddleware, async (req, res) => {
  try {
    let { username } = req.body;
    if (!username) return res.status(400).json({ success: false, message: 'username مطلوب' });

    username = username.replace('@', '').trim().toLowerCase();

    // ✅ تحقق من صحة الـ username
    if (!isValidUsername(username)) {
      return res.status(400).json({ success: false, message: 'اسم المستخدم غير صالح' });
    }

    const doc = await db.collection(SESSIONS).doc(username).get();
    if (!doc.exists || !doc.data()?.chatId) {
      return res.status(404).json({
        success: false,
        message: 'لم يتم ربط حساب تلجرام، يجب فتح البوت أولاً',
        botLink: 'https://t.me/xcel_verify_bot?start=link',
      });
    }

    // ✅ منع إرسال OTP جديد إذا كان هناك رمز حالي لم ينتهِ بعد 60 ثانية
    const sessionData = doc.data();
    if (sessionData.otp && sessionData.expiry) {
      const timeLeft = sessionData.expiry - Date.now();
      if (timeLeft > 4 * 60 * 1000) { // أقل من دقيقة مضت
        const secondsLeft = Math.ceil(timeLeft / 1000);
        return res.status(429).json({
          success: false,
          message: `الرمز السابق لا يزال صالحاً، انتظر ${Math.ceil((timeLeft - 4*60*1000)/1000)} ثانية`,
        });
      }
    }

    const chatId = doc.data().chatId;
    const otp    = generateOTP();
    const expiry = Date.now() + 5 * 60 * 1000;

    await db.collection(SESSIONS).doc(username).update({ otp, expiry });

    await bot.sendMessage(chatId,
      `🔐 رمز التحقق الخاص بك في XCEL:\n\n` +
      `┌─────────────────┐\n` +
      `│      ${otp}      │\n` +
      `└─────────────────┘\n\n` +
      `⏱ صالح لمدة 5 دقائق فقط\n` +
      `⚠️ لا تشارك هذا الرمز مع أحد`
    );

    console.log(`📩 OTP sent to @${username}`);
    return res.json({ success: true, message: 'تم إرسال رمز التحقق على تلجرام' });

  } catch (error) {
    console.error('send-otp error:', error);
    return res.status(500).json({ success: false, message: 'خطأ في الإرسال' });
  }
});

// POST /verify-otp — مع Rate Limiting
app.post('/verify-otp', rateLimitMiddleware, async (req, res) => {
  try {
    let { username, otp } = req.body;
    if (!username || !otp) return res.status(400).json({ success: false, message: 'username و otp مطلوبان' });

    username = username.replace('@', '').trim().toLowerCase();

    if (!isValidUsername(username)) {
      return res.status(400).json({ success: false, message: 'اسم المستخدم غير صالح' });
    }

    // ✅ منع brute force: OTP يجب أن يكون 6 أرقام فقط
    if (!/^\d{6}$/.test(otp.trim())) {
      return res.status(400).json({ success: false, message: 'الرمز يجب أن يكون 6 أرقام' });
    }

    const doc = await db.collection(SESSIONS).doc(username).get();
    if (!doc.exists || !doc.data()?.otp) {
      return res.status(404).json({ success: false, message: 'لا يوجد رمز تحقق، أرسل أولاً' });
    }

    const session = doc.data();

    if (Date.now() > session.expiry) {
      await db.collection(SESSIONS).doc(username).update({ otp: null, expiry: null });
      return res.status(400).json({ success: false, message: 'انتهت صلاحية الرمز، أرسل رمزاً جديداً' });
    }

    if (session.otp !== otp.trim()) {
      console.warn(`❌ Wrong OTP attempt for @${username}`);
      return res.status(400).json({ success: false, message: 'الرمز غير صحيح ❌' });
    }

    await db.collection(SESSIONS).doc(username).update({ otp: null, expiry: null });
    console.log(`✅ Verified: @${username}`);
    return res.json({ success: true, message: 'تم التحقق بنجاح ✅' });

  } catch (error) {
    console.error('verify-otp error:', error);
    return res.status(500).json({ success: false, message: 'خطأ في التحقق' });
  }
});

// GET /check-user/:username
app.get('/check-user/:username', async (req, res) => {
  try {
    let { username } = req.params;
    username = username.replace('@', '').trim().toLowerCase();

    if (!isValidUsername(username)) {
      return res.json({ success: true, linked: false });
    }

    const doc    = await db.collection(SESSIONS).doc(username).get();
    const linked = doc.exists && !!doc.data()?.chatId;
    return res.json({ success: true, linked });
  } catch (error) {
    return res.status(500).json({ success: false, linked: false });
  }
});

// Self-ping كل 14 دقيقة
const https = require('https');
const RENDER_URL = process.env.RENDER_URL || '';
if (RENDER_URL) {
  setInterval(() => {
    https.get(RENDER_URL, (r) => console.log(`🏓 Ping: ${r.statusCode}`))
         .on('error', (e) => console.error('Ping error:', e.message));
  }, 14 * 60 * 1000);
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ XCEL OTP Server on port ${PORT} — Firestore: ON — Rate Limiting: ON`);
});
