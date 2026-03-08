// server.js - TicToeTic Telegram Mini App Backend
const express = require('express');
const mongoose = require('mongoose');
const { Telegraf, Markup } = require('telegraf');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
const server = http.createServer(app);

// ─── CORS Setup (Vercel frontend + Telegram) ─────────────────────────────────
const io = socketIo(server, {
  cors: { origin: '*', methods: ['GET', 'POST'], credentials: false },
  pingTimeout: 60000,
  pingInterval: 25000
});

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'x-admin-key', 'Authorization']
}));
app.options('*', cors());
app.use(express.json());
app.use(express.static('public'));

// ─── Dual MongoDB Auto-Failover ─────────────────────────────────────────────
const MONGO_URIS = [
  process.env.MONGODB_URI_1,
  process.env.MONGODB_URI_2
].filter(Boolean);

let currentMongoIndex = 0;
let isConnected = false;

async function connectMongoDB(uriIndex = 0) {
  if (uriIndex >= MONGO_URIS.length) {
    console.error('❌ All MongoDB connections failed!');
    setTimeout(() => connectMongoDB(0), 10000);
    return;
  }
  try {
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
    await mongoose.connect(MONGO_URIS[uriIndex], {
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
      maxPoolSize: 10,
    });
    currentMongoIndex = uriIndex;
    isConnected = true;
    console.log(`✅ MongoDB [${uriIndex + 1}] connected`);
  } catch (err) {
    console.error(`❌ MongoDB [${uriIndex + 1}] failed: ${err.message}`);
    isConnected = false;
    setTimeout(() => connectMongoDB(uriIndex + 1 < MONGO_URIS.length ? uriIndex + 1 : 0), 3000);
  }
}

mongoose.connection.on('disconnected', () => {
  if (isConnected) {
    isConnected = false;
    console.log('⚠️ MongoDB disconnected, trying next...');
    const nextIndex = (currentMongoIndex + 1) % MONGO_URIS.length;
    setTimeout(() => connectMongoDB(nextIndex), 2000);
  }
});

mongoose.connection.on('error', (err) => {
  console.error('MongoDB error:', err.message);
});

// ─── Schemas ─────────────────────────────────────────────────────────────────
const userSchema = new mongoose.Schema({
  telegramId: { type: String, required: true, unique: true, index: true },
  username: { type: String, default: '' },
  firstName: { type: String, default: '' },
  lastName: { type: String, default: '' },
  balance: { type: Number, default: 0, min: 0 },
  referredBy: { type: String, default: null },
  referralCount: { type: Number, default: 0 },
  totalWins: { type: Number, default: 0 },
  totalGames: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now }
});

const transactionSchema = new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  type: { type: String, enum: ['deposit', 'withdraw', 'game_win', 'game_loss', 'game_draw', 'referral', 'adjust'] },
  amount: { type: Number, required: true },
  status: { type: String, enum: ['pending', 'completed', 'rejected'], default: 'pending' },
  details: {
    kpayName: String,
    transactionId: String,
    phoneNumber: String,
    note: String,
    referredUser: String
  },
  processedAt: Date,
  createdAt: { type: Date, default: Date.now }
});

const gameSchema = new mongoose.Schema({
  gameId: { type: String, required: true, unique: true, index: true },
  player1: { type: String, required: true },
  player2: { type: String, default: null },
  winner: { type: String, default: null },
  boardState: { type: Array, default: () => Array(5).fill(null).map(() => Array(5).fill('')) },
  currentTurn: { type: String, default: null },
  gameStatus: { type: String, enum: ['waiting', 'playing', 'completed', 'abandoned'], default: 'waiting', index: true },
  betAmount: { type: Number, default: 1000 },
  prizeAmount: { type: Number, default: 1600 },
  startTime: { type: Date, default: Date.now },
  endTime: Date,
  player1Timeout: Number,
  player2Timeout: Number,
  isDraw: { type: Boolean, default: false }
});

const settingsSchema = new mongoose.Schema({
  key: { type: String, unique: true },
  value: mongoose.Schema.Types.Mixed
});

const User = mongoose.model('User', userSchema);
const Transaction = mongoose.model('Transaction', transactionSchema);
const Game = mongoose.model('Game', gameSchema);
const Settings = mongoose.model('Settings', settingsSchema);

// ─── Default Settings ─────────────────────────────────────────────────────
async function getSettings() {
  try {
    const s = await Settings.findOne({ key: 'game' });
    return s?.value || {
      minDeposit: 1000,
      minWithdraw: 3000,
      gameFee: 1000,
      gamePrize: 1600,
      referralBonus: 100
    };
  } catch { return { minDeposit: 1000, minWithdraw: 3000, gameFee: 1000, gamePrize: 1600, referralBonus: 100 }; }
}

// ─── Telegram Bot ─────────────────────────────────────────────────────────
const bot = new Telegraf(process.env.BOT_TOKEN);
const ADMIN_ID = process.env.ADMIN_ID;
const APP_URL = process.env.APP_URL || 'https://your-app.onrender.com';
const BOT_USERNAME = process.env.BOT_USERNAME || 'your_bot';

bot.start(async (ctx) => {
  const telegramId = ctx.from.id.toString();
  const username = ctx.from.username || '';
  const firstName = ctx.from.first_name || '';
  const lastName = ctx.from.last_name || '';
  const startPayload = ctx.startPayload;

  try {
    let referredBy = null;
    if (startPayload && startPayload !== telegramId) {
      const referrer = await User.findOne({ telegramId: startPayload });
      if (referrer) referredBy = startPayload;
    }

    const existing = await User.findOne({ telegramId });
    if (!existing) {
      await User.create({ telegramId, username, firstName, lastName, referredBy });
    } else {
      await User.updateOne({ telegramId }, { username, firstName, lastName });
    }

    await ctx.reply(
      `🎮 မင်္ဂလာပါ ${firstName}!\n\nTicToeTic မှ ကြိုဆိုပါသည်။`,
      Markup.inlineKeyboard([
        [Markup.button.webApp('▶️  PLAY GAME', `${APP_URL}/index.html`)]
      ])
    );
  } catch (error) {
    console.error('Bot start error:', error);
    await ctx.reply('မင်္ဂလာပါ! ဂိမ်းကစားရန် ကြိုဆိုပါသည်။');
  }
});

bot.command('admin', async (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID) return ctx.reply('⛔ ခွင့်မပြုပါ။');
  await ctx.reply('👑 Admin Panel', Markup.inlineKeyboard([
    [Markup.button.webApp('📊 Admin Dashboard', `${APP_URL}/admin.html`)]
  ]));
});

// Admin callback actions
bot.action(/confirm_(deposit|withdraw)_(.+)/, async (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID) return ctx.answerCbQuery('⛔ ခွင့်မပြုပါ။');
  const type = ctx.match[1];
  const transactionId = ctx.match[2];
  try {
    const transaction = await Transaction.findById(transactionId);
    if (!transaction || transaction.status !== 'pending') return ctx.answerCbQuery('❌ မရှိပါ သို့မဟုတ် ပြုလုပ်ပြီးပါပြီ။');

    if (type === 'deposit') {
      const settings = await getSettings();
      const user = await User.findOne({ telegramId: transaction.userId });
      if (user) {
        user.balance += transaction.amount;
        await user.save();

        // Referral bonus on FIRST deposit only
        if (user.referredBy && user.totalGames === 0) {
          const referrer = await User.findOne({ telegramId: user.referredBy });
          if (referrer) {
            referrer.balance += settings.referralBonus;
            referrer.referralCount += 1;
            await referrer.save();
            await Transaction.create({ userId: referrer.telegramId, type: 'referral', amount: settings.referralBonus, status: 'completed', details: { referredUser: user.telegramId } });
            await bot.telegram.sendMessage(referrer.telegramId, `🎉 မိတ်ဆက်ဆု ${settings.referralBonus} ကျပ် ရရှိပါသည်!\nလက်ကျန်: ${referrer.balance} ကျပ်`).catch(() => {});
          }
        }

        await bot.telegram.sendMessage(user.telegramId, `✅ ငွေ ${transaction.amount} ကျပ် ဖြည့်ပြီးပါပြီ!\nလက်ကျန်: ${user.balance} ကျပ်`).catch(() => {});
        io.emit('balanceUpdate', { telegramId: user.telegramId, balance: user.balance });
      }
    } else {
      const user = await User.findOne({ telegramId: transaction.userId });
      if (!user || user.balance < transaction.amount) return ctx.answerCbQuery('❌ လက်ကျန်မလုံလောက်ပါ။');
      user.balance -= transaction.amount;
      await user.save();
      await bot.telegram.sendMessage(user.telegramId, `✅ ငွေ ${transaction.amount} ကျပ် ထုတ်ပေးပြီးပါပြီ!\nKPay: ${transaction.details.kpayName}\nဖုန်း: ${transaction.details.phoneNumber}\nလက်ကျန်: ${user.balance} ကျပ်`).catch(() => {});
      io.emit('balanceUpdate', { telegramId: user.telegramId, balance: user.balance });
    }

    transaction.status = 'completed';
    transaction.processedAt = new Date();
    await transaction.save();

    await ctx.editMessageText(ctx.callbackQuery.message.text + '\n\n✅ အတည်ပြုပြီး', { reply_markup: { inline_keyboard: [] } }).catch(() => {});
    await ctx.answerCbQuery('✅ အောင်မြင်ပါသည်။');
  } catch (err) {
    console.error('Confirm error:', err);
    await ctx.answerCbQuery('❌ အမှားရှိသည်။');
  }
});

bot.action(/reject_(deposit|withdraw)_(.+)/, async (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID) return ctx.answerCbQuery('⛔ ခွင့်မပြုပါ။');
  const type = ctx.match[1];
  const transactionId = ctx.match[2];
  try {
    const transaction = await Transaction.findById(transactionId);
    if (!transaction || transaction.status !== 'pending') return ctx.answerCbQuery('❌ မရှိပါ သို့မဟုတ် ပြုလုပ်ပြီးပါပြီ။');

    transaction.status = 'rejected';
    transaction.processedAt = new Date();
    await transaction.save();

    const user = await User.findOne({ telegramId: transaction.userId });
    if (user) {
      await bot.telegram.sendMessage(user.telegramId, `❌ ${type === 'deposit' ? 'ငွေဖြည့်' : 'ငွေထုတ်'}မှု ပယ်ချပါသည်!\nပမာဏ: ${transaction.amount} ကျပ်\nကျေးဇူးပြု၍ ထပ်မံဆက်သွယ်ပါ။`).catch(() => {});
    }

    await ctx.editMessageText(ctx.callbackQuery.message.text + '\n\n❌ ပယ်ချပြီး', { reply_markup: { inline_keyboard: [] } }).catch(() => {});
    await ctx.answerCbQuery('❌ ပယ်ချလိုက်ပြီ။');
  } catch (err) {
    console.error('Reject error:', err);
    await ctx.answerCbQuery('❌ အမှားရှိသည်။');
  }
});

// ─── REST API ─────────────────────────────────────────────────────────────

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', mongo: mongoose.connection.readyState, mongoDb: currentMongoIndex + 1 });
});

// Admin Stats
app.get('/api/admin/stats', adminAuth, async (req, res) => {
  try {
    const [totalUsers, pendingDeposits, pendingWithdraws, totalGames, completedGames] = await Promise.all([
      User.countDocuments(),
      Transaction.countDocuments({ type: 'deposit', status: 'pending' }),
      Transaction.countDocuments({ type: 'withdraw', status: 'pending' }),
      Game.countDocuments(),
      Game.countDocuments({ gameStatus: 'completed' })
    ]);
    const revenue = await Transaction.aggregate([
      { $match: { type: 'game_loss', status: 'completed' } },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]);
    const totalRevenue = revenue[0]?.total || 0;
    const prizesPaid = await Transaction.aggregate([
      { $match: { type: 'game_win', status: 'completed' } },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]);
    res.json({ totalUsers, pendingDeposits, pendingWithdraws, totalGames, completedGames, totalRevenue, netProfit: totalRevenue - (prizesPaid[0]?.total || 0) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Admin Deposits
app.get('/api/admin/deposits/pending', adminAuth, async (req, res) => {
  try {
    const d = await Transaction.find({ type: 'deposit', status: 'pending' }).sort({ createdAt: -1 }).limit(100);
    res.json(d);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/deposits/all', adminAuth, async (req, res) => {
  try {
    const d = await Transaction.find({ type: 'deposit' }).sort({ createdAt: -1 }).limit(200);
    res.json(d);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Admin Withdraws
app.get('/api/admin/withdraws/pending', adminAuth, async (req, res) => {
  try {
    const w = await Transaction.find({ type: 'withdraw', status: 'pending' }).sort({ createdAt: -1 }).limit(100);
    res.json(w);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/withdraws/all', adminAuth, async (req, res) => {
  try {
    const w = await Transaction.find({ type: 'withdraw' }).sort({ createdAt: -1 }).limit(200);
    res.json(w);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Admin Users
app.get('/api/admin/users', adminAuth, async (req, res) => {
  try {
    const users = await User.find().sort({ createdAt: -1 }).limit(500);
    res.json(users);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Admin Games
app.get('/api/admin/games', adminAuth, async (req, res) => {
  try {
    const games = await Game.find().sort({ startTime: -1 }).limit(200);
    res.json(games);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Admin Confirm/Reject via API
app.post('/api/admin/confirm/deposit/:id', adminAuth, async (req, res) => {
  try {
    const transaction = await Transaction.findById(req.params.id);
    if (!transaction || transaction.status !== 'pending') return res.status(400).json({ error: 'Not found or already processed' });
    const settings = await getSettings();
    const user = await User.findOne({ telegramId: transaction.userId });
    if (!user) return res.status(404).json({ error: 'User not found' });
    user.balance += transaction.amount;
    await user.save();
    transaction.status = 'completed';
    transaction.processedAt = new Date();
    await transaction.save();
    await bot.telegram.sendMessage(user.telegramId, `✅ ငွေ ${transaction.amount} ကျပ် ဖြည့်ပြီးပါပြီ!\nလက်ကျန်: ${user.balance} ကျပ်`).catch(() => {});
    io.emit('balanceUpdate', { telegramId: user.telegramId, balance: user.balance });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/reject/deposit/:id', adminAuth, async (req, res) => {
  try {
    const transaction = await Transaction.findById(req.params.id);
    if (!transaction || transaction.status !== 'pending') return res.status(400).json({ error: 'Not found or already processed' });
    transaction.status = 'rejected';
    transaction.processedAt = new Date();
    await transaction.save();
    const user = await User.findOne({ telegramId: transaction.userId });
    if (user) await bot.telegram.sendMessage(user.telegramId, `❌ ငွေဖြည့်မှု ပယ်ချပါသည်!\nပမာဏ: ${transaction.amount} ကျပ်`).catch(() => {});
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/confirm/withdraw/:id', adminAuth, async (req, res) => {
  try {
    const transaction = await Transaction.findById(req.params.id);
    if (!transaction || transaction.status !== 'pending') return res.status(400).json({ error: 'Not found or already processed' });
    const user = await User.findOne({ telegramId: transaction.userId });
    if (!user || user.balance < transaction.amount) return res.status(400).json({ error: 'Insufficient balance' });
    user.balance -= transaction.amount;
    await user.save();
    transaction.status = 'completed';
    transaction.processedAt = new Date();
    await transaction.save();
    await bot.telegram.sendMessage(user.telegramId, `✅ ငွေ ${transaction.amount} ကျပ် ထုတ်ပေးပြီးပါပြီ!\nKPay: ${transaction.details.kpayName}\nဖုန်း: ${transaction.details.phoneNumber}\nလက်ကျန်: ${user.balance} ကျပ်`).catch(() => {});
    io.emit('balanceUpdate', { telegramId: user.telegramId, balance: user.balance });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/reject/withdraw/:id', adminAuth, async (req, res) => {
  try {
    const transaction = await Transaction.findById(req.params.id);
    if (!transaction || transaction.status !== 'pending') return res.status(400).json({ error: 'Not found or already processed' });
    transaction.status = 'rejected';
    transaction.processedAt = new Date();
    await transaction.save();
    const user = await User.findOne({ telegramId: transaction.userId });
    if (user) await bot.telegram.sendMessage(user.telegramId, `❌ ငွေထုတ်မှု ပယ်ချပါသည်!\nပမာဏ: ${transaction.amount} ကျပ်`).catch(() => {});
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Adjust Balance
app.post('/api/admin/adjust-balance', adminAuth, async (req, res) => {
  try {
    const { userId, amount, note } = req.body;
    const user = await User.findOne({ telegramId: userId });
    if (!user) return res.status(404).json({ error: 'User not found' });
    const parsed = parseInt(amount);
    if (isNaN(parsed)) return res.status(400).json({ error: 'Invalid amount' });
    if (user.balance + parsed < 0) return res.status(400).json({ error: 'Balance cannot go negative' });
    user.balance += parsed;
    await user.save();
    await Transaction.create({ userId, type: 'adjust', amount: parsed, status: 'completed', details: { note: note || 'Admin adjustment' } });
    await bot.telegram.sendMessage(userId, `📋 Admin ကငွေ ${parsed > 0 ? '+' : ''}${parsed} ကျပ် ပြောင်းလဲပါသည်!\nလက်ကျန်: ${user.balance} ကျပ်`).catch(() => {});
    io.emit('balanceUpdate', { telegramId: userId, balance: user.balance });
    res.json({ success: true, newBalance: user.balance });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Ban/Unban User
app.post('/api/admin/ban-user', adminAuth, async (req, res) => {
  try {
    const { userId, banned } = req.body;
    await User.updateOne({ telegramId: userId }, { banned });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Broadcast Message
app.post('/api/admin/broadcast', adminAuth, async (req, res) => {
  try {
    const { message } = req.body;
    const users = await User.find({}, 'telegramId');
    let sent = 0, failed = 0;
    for (const user of users) {
      try {
        await bot.telegram.sendMessage(user.telegramId, `📢 ${message}`);
        sent++;
        await new Promise(r => setTimeout(r, 50)); // Rate limit
      } catch { failed++; }
    }
    res.json({ success: true, sent, failed });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Settings
app.get('/api/admin/settings', adminAuth, async (req, res) => {
  try {
    const s = await getSettings();
    res.json(s);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/settings', adminAuth, async (req, res) => {
  try {
    await Settings.findOneAndUpdate({ key: 'game' }, { key: 'game', value: req.body }, { upsert: true });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// User info for frontend
app.get('/api/user/:telegramId', async (req, res) => {
  try {
    const user = await User.findOne({ telegramId: req.params.telegramId });
    if (!user) return res.status(404).json({ error: 'Not found' });
    res.json({ telegramId: user.telegramId, username: user.username, firstName: user.firstName, balance: user.balance, referralCount: user.referralCount, totalWins: user.totalWins, totalGames: user.totalGames });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Admin auth middleware
function adminAuth(req, res, next) {
  const adminKey = req.headers['x-admin-key'] || req.query.adminKey;
  if (adminKey !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Unauthorized' });
  next();
}

// ─── Socket.IO ────────────────────────────────────────────────────────────
const waitingGames = new Map(); // gameId -> timeout handle
const playerSockets = new Map(); // telegramId -> socket

io.on('connection', (socket) => {
  socket.on('authenticate', async (data) => {
    try {
      if (!data?.telegramId) return;
      const user = await User.findOne({ telegramId: data.telegramId });
      if (user) {
        if (user.banned) { socket.emit('error', 'บัญชีถูกระงับ'); return; }
        socket.userId = data.telegramId;
        playerSockets.set(data.telegramId, socket.id);
        socket.emit('authenticated', { balance: user.balance, username: user.username || user.firstName, referralCount: user.referralCount, totalWins: user.totalWins, totalGames: user.totalGames });
      }
    } catch (err) { console.error('Auth error:', err); }
  });

  socket.on('requestDeposit', async (data) => {
    try {
      const { telegramId, kpayName, transactionId, amount } = data;
      const settings = await getSettings();
      if (!telegramId || !kpayName || !transactionId || !amount) return socket.emit('depositError', 'အချက်အလက် မပြည့်စုံပါ။');
      if (amount < settings.minDeposit) return socket.emit('depositError', `အနည်းဆုံး ${settings.minDeposit} ကျပ် ဖြည့်ရပါမည်။`);

      // Check duplicate transaction ID
      const existing = await Transaction.findOne({ 'details.transactionId': transactionId });
      if (existing) return socket.emit('depositError', 'ဒီ Transaction ID သုံးပြီးပါပြီ။');

      const txn = await Transaction.create({ userId: telegramId, type: 'deposit', amount, status: 'pending', details: { kpayName, transactionId } });

      await bot.telegram.sendMessage(ADMIN_ID,
        `💰 ငွေဖြည့်ရန် တောင်းဆိုချက်\n━━━━━━━━━━━\nUser: ${telegramId}\nKPay: ${kpayName}\nTxn ID: ${transactionId}\nပမာဏ: ${amount} ကျပ်`,
        Markup.inlineKeyboard([[
          Markup.button.callback('✅ Confirm', `confirm_deposit_${txn._id}`),
          Markup.button.callback('❌ Reject', `reject_deposit_${txn._id}`)
        ]])
      ).catch(err => console.error('Admin notify error:', err));

      socket.emit('depositSuccess', 'ငွေဖြည့်ရန် တောင်းဆိုချက် ပို့ပြီးပါပြီ။ Admin အတည်ပြုပါမည်။');
    } catch (err) { console.error('Deposit error:', err); socket.emit('depositError', 'အမှားရှိသည်။ နောက်မှ ထပ်ကြိုးစားပါ။'); }
  });

  socket.on('requestWithdraw', async (data) => {
    try {
      const { telegramId, kpayName, phoneNumber, amount } = data;
      const settings = await getSettings();
      if (!telegramId || !kpayName || !phoneNumber || !amount) return socket.emit('withdrawError', 'အချက်အလက် မပြည့်စုံပါ။');
      if (amount < settings.minWithdraw) return socket.emit('withdrawError', `အနည်းဆုံး ${settings.minWithdraw} ကျပ် ထုတ်ရပါမည်။`);

      const user = await User.findOne({ telegramId });
      if (!user || user.balance < amount) return socket.emit('withdrawError', 'လက်ကျန်ငွေ မလုံလောက်ပါ။');

      const txn = await Transaction.create({ userId: telegramId, type: 'withdraw', amount, status: 'pending', details: { kpayName, phoneNumber } });

      await bot.telegram.sendMessage(ADMIN_ID,
        `💸 ငွေထုတ်ရန် တောင်းဆိုချက်\n━━━━━━━━━━━\nUser: ${telegramId}\nKPay: ${kpayName}\nဖုန်း: ${phoneNumber}\nပမာဏ: ${amount} ကျပ်\nလက်ကျန်: ${user.balance} ကျပ်`,
        Markup.inlineKeyboard([[
          Markup.button.callback('✅ Confirm', `confirm_withdraw_${txn._id}`),
          Markup.button.callback('❌ Reject', `reject_withdraw_${txn._id}`)
        ]])
      ).catch(err => console.error('Admin notify error:', err));

      socket.emit('withdrawSuccess', 'ငွေထုတ်ရန် တောင်းဆိုချက် ပို့ပြီးပါပြီ။ Admin ထုတ်ပေးပါမည်။');
    } catch (err) { console.error('Withdraw error:', err); socket.emit('withdrawError', 'အမှားရှိသည်။ နောက်မှ ထပ်ကြိုးစားပါ။'); }
  });

  socket.on('startGame', async (data) => {
    try {
      const { telegramId } = data;
      const settings = await getSettings();
      const user = await User.findOne({ telegramId });
      if (!user) return socket.emit('gameError', 'အကောင့် မတွေ့ပါ။');
      if (user.balance < settings.gameFee) return socket.emit('gameError', `ငွေမလောက်ပါ။ အနည်းဆုံး ${settings.gameFee} ကျပ် လိုအပ်သည်။`);

      // Check if already in a game
      const activeGame = await Game.findOne({ $or: [{ player1: telegramId }, { player2: telegramId }], gameStatus: { $in: ['waiting', 'playing'] } });
      if (activeGame) return socket.emit('gameStarted', { gameId: activeGame.gameId, balance: user.balance });

      user.balance -= settings.gameFee;
      await user.save();

      const gameId = `game_${Date.now()}_${telegramId}`;
      await Game.create({
        gameId, player1: telegramId, gameStatus: 'waiting',
        betAmount: settings.gameFee, prizeAmount: settings.gamePrize,
        boardState: Array(5).fill(null).map(() => Array(5).fill('')),
        player1Timeout: Date.now() + 30000
      });

      socket.join(gameId);
      socket.gameId = gameId;

      socket.emit('gameStarted', { gameId, balance: user.balance });
      io.emit('balanceUpdate', { telegramId, balance: user.balance });

      // Auto bot after 30s if no player joins
      const handle = setTimeout(async () => {
        try {
          const g = await Game.findOne({ gameId, gameStatus: 'waiting' });
          if (!g) return;
          g.player2 = 'bot';
          g.gameStatus = 'playing';
          g.currentTurn = telegramId;
          await g.save();
          io.to(gameId).emit('gameMatched', { gameId, opponent: 'bot' });
          io.to(gameId).emit('moveMade', { gameId, board: g.boardState, currentTurn: telegramId });
        } catch (e) { console.error('Bot auto join error:', e); }
      }, 30000);
      waitingGames.set(gameId, handle);

    } catch (err) { console.error('Start game error:', err); socket.emit('gameError', 'ဂိမ်းမစနိုင်ပါ။'); }
  });

  socket.on('joinGame', async (data) => {
    try {
      const { telegramId, gameId } = data;
      const settings = await getSettings();
      if (telegramId === gameId.split('_')[2]) return socket.emit('gameError', 'မိမိကိုယ်တိုင်နှင့် ကစားမရပါ။');

      const user = await User.findOne({ telegramId });
      if (!user || user.balance < settings.gameFee) return socket.emit('gameError', 'ငွေမလောက်ပါ။');

      const game = await Game.findOne({ gameId, gameStatus: 'waiting' });
      if (!game) return socket.emit('gameError', 'ဂိမ်းမရှိတော့ပါ။');
      if (game.player1 === telegramId) return socket.emit('gameError', 'မိမိကိုယ်တိုင်နှင့် ကစားမရပါ။');

      user.balance -= settings.gameFee;
      await user.save();

      // Clear bot timeout
      if (waitingGames.has(gameId)) {
        clearTimeout(waitingGames.get(gameId));
        waitingGames.delete(gameId);
      }

      game.player2 = telegramId;
      game.gameStatus = 'playing';
      game.currentTurn = game.player1;
      await game.save();

      socket.join(gameId);
      socket.gameId = gameId;

      io.to(gameId).emit('gameMatched', { gameId, opponent: user.username || user.firstName });
      io.to(gameId).emit('moveMade', { gameId, board: game.boardState, currentTurn: game.player1 });
      io.emit('balanceUpdate', { telegramId, balance: user.balance });

    } catch (err) { console.error('Join game error:', err); socket.emit('gameError', 'ဂိမ်းဝင်မရပါ။'); }
  });

  socket.on('makeMove', async (data) => {
    try {
      const { gameId, telegramId, row, col } = data;
      if (row < 0 || row > 4 || col < 0 || col > 4) return;

      const game = await Game.findOne({ gameId, gameStatus: 'playing' });
      if (!game || game.currentTurn !== telegramId) return;

      if (game.boardState[row][col]) return; // Cell taken

      const symbol = telegramId === game.player1 ? 'X' : 'O';
      game.boardState[row][col] = symbol;
      game.markModified('boardState');

      if (checkWin(game.boardState, row, col, symbol)) {
        await endGame(game, telegramId, 'win', io, bot);
      } else if (game.boardState.flat().every(c => c)) {
        await endGame(game, null, 'draw', io, bot);
      } else {
        const nextPlayer = telegramId === game.player1 ? game.player2 : game.player1;
        game.currentTurn = nextPlayer;
        await game.save();

        io.to(gameId).emit('moveMade', { gameId, board: game.boardState, currentTurn: nextPlayer });

        if (nextPlayer === 'bot') {
          setTimeout(() => makeBotMove(gameId, io, bot), 800 + Math.random() * 700);
        }
      }
    } catch (err) { console.error('Move error:', err); }
  });

  socket.on('gameTimeout', async (data) => {
    try {
      const { gameId, telegramId } = data;
      const game = await Game.findOne({ gameId, gameStatus: 'playing' });
      if (!game) return;
      const winner = game.player1 === telegramId ? game.player2 : game.player1;
      await endGame(game, winner === 'bot' ? null : winner, winner === 'bot' ? 'botwin' : 'win', io, bot);
    } catch (err) { console.error('Timeout error:', err); }
  });

  socket.on('disconnect', async () => {
    if (socket.userId) playerSockets.delete(socket.userId);
    if (socket.gameId) {
      try {
        const game = await Game.findOne({ gameId: socket.gameId, gameStatus: 'playing' });
        if (game) {
          // Give opponent win on disconnect
          const winner = game.player1 === socket.userId ? game.player2 : game.player1;
          if (winner && winner !== 'bot') await endGame(game, winner, 'win', io, bot);
        }
      } catch (e) {}
    }
  });
});

// ─── Game Logic ──────────────────────────────────────────────────────────

async function endGame(game, winner, type, io, bot) {
  try {
    const settings = await getSettings();
    game.gameStatus = 'completed';
    game.endTime = new Date();
    game.winner = winner || null;
    game.isDraw = type === 'draw';

    if (type === 'draw') {
      // Refund both players
      const p1 = await User.findOne({ telegramId: game.player1 });
      if (p1) { p1.balance += game.betAmount; p1.totalGames += 1; await p1.save(); io.emit('balanceUpdate', { telegramId: game.player1, balance: p1.balance }); }
      if (game.player2 && game.player2 !== 'bot') {
        const p2 = await User.findOne({ telegramId: game.player2 });
        if (p2) { p2.balance += game.betAmount; p2.totalGames += 1; await p2.save(); io.emit('balanceUpdate', { telegramId: game.player2, balance: p2.balance }); }
      }
      await Transaction.create({ userId: game.player1, type: 'game_draw', amount: game.betAmount, status: 'completed' });
      io.to(game.gameId).emit('gameOver', { gameId: game.gameId, draw: true });
    } else if (winner) {
      const winnerUser = await User.findOne({ telegramId: winner });
      if (winnerUser) {
        winnerUser.balance += game.prizeAmount;
        winnerUser.totalWins += 1;
        winnerUser.totalGames += 1;
        await winnerUser.save();
        await Transaction.create({ userId: winner, type: 'game_win', amount: game.prizeAmount, status: 'completed' });
        io.emit('balanceUpdate', { telegramId: winner, balance: winnerUser.balance });
      }
      const loser = game.player1 === winner ? game.player2 : game.player1;
      if (loser && loser !== 'bot') {
        const loserUser = await User.findOne({ telegramId: loser });
        if (loserUser) { loserUser.totalGames += 1; await loserUser.save(); }
        await Transaction.create({ userId: loser, type: 'game_loss', amount: game.betAmount, status: 'completed' });
      }
      io.to(game.gameId).emit('gameOver', { gameId: game.gameId, winner });
    } else {
      // Bot wins
      const loser = game.player1 !== 'bot' ? game.player1 : game.player2;
      if (loser) {
        const loserUser = await User.findOne({ telegramId: loser });
        if (loserUser) { loserUser.totalGames += 1; await loserUser.save(); }
        await Transaction.create({ userId: loser, type: 'game_loss', amount: game.betAmount, status: 'completed' });
      }
      io.to(game.gameId).emit('gameOver', { gameId: game.gameId, winner: 'bot' });
    }

    await game.save();
  } catch (err) { console.error('End game error:', err); }
}

async function makeBotMove(gameId, io, bot) {
  try {
    const game = await Game.findOne({ gameId, gameStatus: 'playing', currentTurn: 'bot' });
    if (!game) return;
    const board = game.boardState;
    const move = findBestMove(board);
    if (!move) return;
    board[move.row][move.col] = 'O';
    game.markModified('boardState');

    if (checkWin(board, move.row, move.col, 'O')) {
      await endGame(game, null, 'botwin', io, bot);
    } else if (board.flat().every(c => c)) {
      await endGame(game, null, 'draw', io, bot);
    } else {
      const player = game.player1 !== 'bot' ? game.player1 : game.player2;
      game.currentTurn = player;
      await game.save();
      io.to(gameId).emit('moveMade', { gameId, board, currentTurn: player });
    }
  } catch (err) { console.error('Bot move error:', err); }
}

function checkWin(board, row, col, symbol) {
  const dirs = [[1,0],[0,1],[1,1],[1,-1]];
  for (const [dr, dc] of dirs) {
    let count = 1;
    for (let i = 1; i < 4; i++) { const r = row+dr*i, c = col+dc*i; if (r<0||r>=5||c<0||c>=5||board[r][c]!==symbol) break; count++; }
    for (let i = 1; i < 4; i++) { const r = row-dr*i, c = col-dc*i; if (r<0||r>=5||c<0||c>=5||board[r][c]!==symbol) break; count++; }
    if (count >= 4) return true;
  }
  return false;
}

function scoreBoard(board, symbol, row, col) {
  const dirs = [[1,0],[0,1],[1,1],[1,-1]];
  let score = 0;
  for (const [dr, dc] of dirs) {
    let count = 1;
    for (let i = 1; i < 5; i++) { const r = row+dr*i, c = col+dc*i; if (r<0||r>=5||c<0||c>=5||board[r][c]!==symbol) break; count++; }
    for (let i = 1; i < 5; i++) { const r = row-dr*i, c = col-dc*i; if (r<0||r>=5||c<0||c>=5||board[r][c]!==symbol) break; count++; }
    score += count * count;
  }
  return score;
}

function findBestMove(board) {
  // Try to win
  for (let r = 0; r < 5; r++) for (let c = 0; c < 5; c++) {
    if (!board[r][c]) { board[r][c]='O'; if (checkWin(board,r,c,'O')) { board[r][c]=''; return {row:r,col:c}; } board[r][c]=''; }
  }
  // Block player
  for (let r = 0; r < 5; r++) for (let c = 0; c < 5; c++) {
    if (!board[r][c]) { board[r][c]='X'; if (checkWin(board,r,c,'X')) { board[r][c]=''; return {row:r,col:c}; } board[r][c]=''; }
  }
  // Score-based strategic move
  let best = null, bestScore = -1;
  for (let r = 0; r < 5; r++) for (let c = 0; c < 5; c++) {
    if (!board[r][c]) {
      const s = scoreBoard(board,'O',r,c) + scoreBoard(board,'X',r,c) * 0.9 + (r===2&&c===2?10:0);
      if (s > bestScore) { bestScore = s; best = {row:r,col:c}; }
    }
  }
  return best;
}

// ─── Start ────────────────────────────────────────────────────────────────
(async () => {
  await connectMongoDB(0);
  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
  bot.launch({ dropPendingUpdates: true }).then(() => console.log('🤖 Bot started')).catch(e => console.error('Bot launch error:', e));
  process.once('SIGINT', () => { bot.stop('SIGINT'); process.exit(0); });
  process.once('SIGTERM', () => { bot.stop('SIGTERM'); process.exit(0); });
})();
