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

// /start — حفظ chatId في Firestore
bot.onText(/\/start/, async (msg) => {
  const chatId   = msg.chat.id;
  const username = msg.from.username;

  if (!username) {
    bot.sendMessage(chatId, '⚠️ يجب أن يكون لديك username في تلجرام!\nاذهب إلى الإعدادات → تعيين اسم مستخدم');
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
    console.log(`Linked: @${username} → ${chatId}`);
  } catch (err) {
    console.error('Error saving session:', err);
  }
});

// POST /send-otp
app.post('/send-otp', async (req, res) => {
  try {
    let { username } = req.body;
    if (!username) return res.status(400).json({ success: false, message: 'username مطلوب' });
    username = username.replace('@', '').trim().toLowerCase();

    const doc = await db.collection(SESSIONS).doc(username).get();
    if (!doc.exists || !doc.data()?.chatId) {
      return res.status(404).json({ success: false, message: 'لم يتم ربط حساب تلجرام، يجب فتح البوت أولاً', botLink: 'https://t.me/xcel_verify_bot' });
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

    return res.json({ success: true, message: 'تم إرسال رمز التحقق على تلجرام' });
  } catch (error) {
    console.error('send-otp error:', error);
    return res.status(500).json({ success: false, message: 'خطأ في الإرسال' });
  }
});

// POST /verify-otp
app.post('/verify-otp', async (req, res) => {
  try {
    let { username, otp } = req.body;
    if (!username || !otp) return res.status(400).json({ success: false, message: 'username و otp مطلوبان' });
    username = username.replace('@', '').trim().toLowerCase();

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
      return res.status(400).json({ success: false, message: 'الرمز غير صحيح ❌' });
    }

    await db.collection(SESSIONS).doc(username).update({ otp: null, expiry: null });
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
    const doc = await db.collection(SESSIONS).doc(username).get();
    const linked = doc.exists && !!doc.data()?.chatId;
    return res.json({ success: true, linked });
  } catch (error) {
    console.error('check-user error:', error);
    return res.status(500).json({ success: false, linked: false });
  }
});

// Self-ping كل 14 دقيقة لمنع النوم
const https = require('https');
const RENDER_URL = process.env.RENDER_URL || '';
if (RENDER_URL) {
  setInterval(() => {
    https.get(RENDER_URL, (r) => console.log(`Ping: ${r.statusCode}`))
         .on('error', (e) => console.error('Ping error:', e.message));
  }, 14 * 60 * 1000);
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ XCEL OTP Server on port ${PORT} — Firestore: ON`);
});