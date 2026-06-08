require('dotenv').config();
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

// ── إعدادات البوت ──
const BOT_TOKEN = process.env.BOT_TOKEN || '8925798122:AAGxxMZc_zTTGli59_6PbEn4tYs5DQMvfko';
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// ── تخزين مؤقت في الذاكرة ──
// { username: { chatId, otp, expiry } }
const userSessions = {};

// ── توليد OTP عشوائي 6 أرقام ──
function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// ══════════════════════════════════════════
//   معالجة رسائل البوت
//   عندما يكتب المستخدم /start يحفظ chatId
// ══════════════════════════════════════════
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const username = msg.from.username;

  if (!username) {
    bot.sendMessage(chatId,
      '⚠️ يجب أن يكون لديك username في تلجرام!\n' +
      'اذهب إلى الإعدادات → تعيين اسم مستخدم'
    );
    return;
  }

  // حفظ chatId مرتبط بـ username
  if (!userSessions[username]) {
    userSessions[username] = {};
  }
  userSessions[username].chatId = chatId;

  bot.sendMessage(chatId,
    `✅ مرحباً ${msg.from.first_name}!\n\n` +
    `تم ربط حسابك بتطبيق XCEL بنجاح 🎉\n\n` +
    `ستصلك رموز التحقق هنا عند تسجيل الدخول أو إنشاء الحساب.`
  );
});

// ══════════════════════════════════════════
//   API: إرسال OTP
//   POST /send-otp
//   Body: { username: "ahmed123" }
// ══════════════════════════════════════════
app.post('/send-otp', async (req, res) => {
  try {
    let { username } = req.body;

    if (!username) {
      return res.status(400).json({ success: false, message: 'username مطلوب' });
    }

    // إزالة @ إذا أدخله المستخدم
    username = username.replace('@', '').trim();

    // تحقق إن المستخدم ربط حسابه مع البوت
    if (!userSessions[username] || !userSessions[username].chatId) {
      return res.status(404).json({
        success: false,
        message: 'لم يتم ربط حساب تلجرام، يجب فتح البوت أولاً',
        botLink: 'https://t.me/xcel_verify_bot' // غيّر هذا لاسم بوتك
      });
    }

    const chatId = userSessions[username].chatId;
    const otp = generateOTP();
    const expiry = Date.now() + 5 * 60 * 1000; // ينتهي بعد 5 دقائق

    // حفظ OTP
    userSessions[username].otp = otp;
    userSessions[username].expiry = expiry;

    // إرسال OTP عبر تلجرام
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
    console.error('Error sending OTP:', error);
    return res.status(500).json({ success: false, message: 'خطأ في الإرسال' });
  }
});

// ══════════════════════════════════════════
//   API: التحقق من OTP
//   POST /verify-otp
//   Body: { username: "ahmed123", otp: "123456" }
// ══════════════════════════════════════════
app.post('/verify-otp', (req, res) => {
  try {
    let { username, otp } = req.body;

    if (!username || !otp) {
      return res.status(400).json({ success: false, message: 'username و otp مطلوبان' });
    }

    username = username.replace('@', '').trim();

    const session = userSessions[username];

    if (!session || !session.otp) {
      return res.status(404).json({ success: false, message: 'لا يوجد رمز تحقق، أرسل أولاً' });
    }

    // تحقق من انتهاء الصلاحية
    if (Date.now() > session.expiry) {
      delete session.otp;
      delete session.expiry;
      return res.status(400).json({ success: false, message: 'انتهت صلاحية الرمز، أرسل رمزاً جديداً' });
    }

    // تحقق من صحة الرمز
    if (session.otp !== otp.trim()) {
      return res.status(400).json({ success: false, message: 'الرمز غير صحيح ❌' });
    }

    // ✅ الرمز صحيح — احذفه فوراً
    delete session.otp;
    delete session.expiry;

    return res.json({ success: true, message: 'تم التحقق بنجاح ✅' });

  } catch (error) {
    console.error('Error verifying OTP:', error);
    return res.status(500).json({ success: false, message: 'خطأ في التحقق' });
  }
});

// ══════════════════════════════════════════
//   API: التحقق إن المستخدم ربط البوت
//   GET /check-user/:username
// ══════════════════════════════════════════
app.get('/check-user/:username', (req, res) => {
  let { username } = req.params;
  username = username.replace('@', '').trim();

  const linked = !!(userSessions[username] && userSessions[username].chatId);
  return res.json({ success: true, linked });
});

// ── تشغيل السيرفر ──
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ XCEL OTP Server running on port ${PORT}`);
  console.log(`🤖 Telegram Bot is active and listening...`);
});