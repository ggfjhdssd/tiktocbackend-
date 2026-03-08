// server.js - TicToeTic Backend
// Frontend : https://tictokfrontend.vercel.app
// Backend  : https://tiktocbackend.onrender.com
// Bot      : https://t.me/tictoe1_bot

const express  = require('express');
const mongoose = require('mongoose');
const { Telegraf, Markup } = require('telegraf');
const http     = require('http');
const socketIo = require('socket.io');
const cors     = require('cors');
const dotenv   = require('dotenv');
dotenv.config();

const app    = express();
const server = http.createServer(app);

const FRONTEND_URL = 'https://tictokfrontend.vercel.app';
const BACKEND_URL  = 'https://tiktocbackend.onrender.com';
const BOT_LINK     = 'https://t.me/tictoe1_bot';

// ── CORS ─────────────────────────────────────────────────────────────────────
const io = socketIo(server, {
  cors: { origin: '*', methods: ['GET','POST'], credentials: false },
  pingTimeout: 60000,
  pingInterval: 25000
});

app.use(cors({ origin: '*', methods: ['GET','POST','PUT','DELETE','OPTIONS'], allowedHeaders: ['Content-Type','x-admin-id'] }));
app.options('*', cors());
app.use(express.json());
app.use(express.static('public'));

// ── Dual MongoDB Auto-Failover ────────────────────────────────────────────────
const MONGO_URIS = [ process.env.MONGODB_URI_1, process.env.MONGODB_URI_2 ].filter(Boolean);
let currentMongoIndex = 0;
let isConnected = false;

async function connectMongoDB(idx = 0) {
  if (idx >= MONGO_URIS.length) { console.error('❌ All MongoDB failed'); setTimeout(() => connectMongoDB(0), 10000); return; }
  try {
    if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
    await mongoose.connect(MONGO_URIS[idx], { serverSelectionTimeoutMS: 5000, socketTimeoutMS: 45000, maxPoolSize: 10 });
    currentMongoIndex = idx; isConnected = true;
    console.log(`✅ MongoDB [${idx + 1}] connected`);
  } catch (err) {
    console.error(`❌ MongoDB [${idx + 1}] failed: ${err.message}`);
    isConnected = false;
    setTimeout(() => connectMongoDB(idx + 1 < MONGO_URIS.length ? idx + 1 : 0), 3000);
  }
}
mongoose.connection.on('disconnected', () => {
  if (isConnected) { isConnected = false; setTimeout(() => connectMongoDB((currentMongoIndex + 1) % MONGO_URIS.length), 2000); }
});

// ── Schemas ───────────────────────────────────────────────────────────────────
const userSchema = new mongoose.Schema({
  telegramId:    { type: String, required: true, unique: true, index: true },
  username:      { type: String, default: '' },
  firstName:     { type: String, default: '' },
  lastName:      { type: String, default: '' },
  balance:       { type: Number, default: 0, min: 0 },
  referredBy:    { type: String, default: null },
  referralCount: { type: Number, default: 0 },
  totalWins:     { type: Number, default: 0 },
  totalGames:    { type: Number, default: 0 },
  banned:        { type: Boolean, default: false },
  createdAt:     { type: Date, default: Date.now }
});

const transactionSchema = new mongoose.Schema({
  userId:  { type: String, required: true, index: true },
  type:    { type: String, enum: ['deposit','withdraw','game_win','game_loss','game_draw','referral','adjust'] },
  amount:  { type: Number, required: true },
  status:  { type: String, enum: ['pending','completed','rejected'], default: 'pending' },
  details: { kpayName: String, transactionId: String, phoneNumber: String, note: String, referredUser: String },
  processedAt: Date,
  createdAt: { type: Date, default: Date.now }
});

const gameSchema = new mongoose.Schema({
  gameId:       { type: String, required: true, unique: true, index: true },
  player1:      { type: String, required: true },
  player2:      { type: String, default: null },
  winner:       { type: String, default: null },
  boardState:   { type: Array, default: () => Array(5).fill(null).map(() => Array(5).fill('')) },
  currentTurn:  { type: String, default: null },
  gameStatus:   { type: String, enum: ['waiting','playing','completed','abandoned'], default: 'waiting', index: true },
  betAmount:    { type: Number, default: 1000 },
  prizeAmount:  { type: Number, default: 1600 },
  isDraw:       { type: Boolean, default: false },
  startTime:    { type: Date, default: Date.now },
  endTime:      Date
});

const settingsSchema = new mongoose.Schema({ key: { type: String, unique: true }, value: mongoose.Schema.Types.Mixed });

const User        = mongoose.model('User', userSchema);
const Transaction = mongoose.model('Transaction', transactionSchema);
const Game        = mongoose.model('Game', gameSchema);
const Settings    = mongoose.model('Settings', settingsSchema);

// ── Settings Helper ───────────────────────────────────────────────────────────
async function getSettings() {
  try {
    const s = await Settings.findOne({ key: 'game' });
    return s?.value || { minDeposit:1000, minWithdraw:3000, gameFee:1000, gamePrize:1600, referralBonus:100 };
  } catch { return { minDeposit:1000, minWithdraw:3000, gameFee:1000, gamePrize:1600, referralBonus:100 }; }
}

// ── Admin Auth Middleware (Telegram ID based — no secret in frontend) ─────────
function adminAuth(req, res, next) {
  const telegramId = req.headers['x-admin-id'];
  if (!telegramId || telegramId !== process.env.ADMIN_ID) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  next();
}

// ── Telegram Bot ──────────────────────────────────────────────────────────────
const bot      = new Telegraf(process.env.BOT_TOKEN);
const ADMIN_ID = process.env.ADMIN_ID;

bot.start(async (ctx) => {
  const telegramId  = ctx.from.id.toString();
  const username    = ctx.from.username  || '';
  const firstName   = ctx.from.first_name || '';
  const lastName    = ctx.from.last_name  || '';
  const startPayload = ctx.startPayload;
  try {
    let referredBy = null;
    if (startPayload && startPayload !== telegramId) {
      const ref = await User.findOne({ telegramId: startPayload });
      if (ref) referredBy = startPayload;
    }
    const existing = await User.findOne({ telegramId });
    if (!existing) await User.create({ telegramId, username, firstName, lastName, referredBy });
    else           await User.updateOne({ telegramId }, { username, firstName, lastName });

    await ctx.reply(
      `🎮 မင်္ဂလာပါ ${firstName}!\n\nTicToeTic မှ ကြိုဆိုပါသည်။`,
      Markup.inlineKeyboard([[Markup.button.webApp('▶️  PLAY GAME', `${FRONTEND_URL}/index.html`)]])
    );
  } catch (e) {
    console.error('Bot start error:', e);
    await ctx.reply('မင်္ဂလာပါ! ဂိမ်းကစားရန် ကြိုဆိုပါသည်။');
  }
});

bot.command('admin', async (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID) return ctx.reply('⛔ ခွင့်မပြုပါ။');
  await ctx.reply('👑 Admin Panel', Markup.inlineKeyboard([[Markup.button.webApp('📊 Admin Dashboard', `${FRONTEND_URL}/admin.html`)]]));
});

// Bot confirm/reject callbacks
bot.action(/confirm_(deposit|withdraw)_(.+)/, async (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID) return ctx.answerCbQuery('⛔');
  const [, type, txId] = ctx.match;
  try {
    const txn = await Transaction.findById(txId);
    if (!txn || txn.status !== 'pending') return ctx.answerCbQuery('Already processed');
    const settings = await getSettings();
    const user = await User.findOne({ telegramId: txn.userId });
    if (!user) return ctx.answerCbQuery('User not found');

    if (type === 'deposit') {
      user.balance += txn.amount;
      await user.save();
      // Referral bonus — first deposit only
      if (user.referredBy && user.totalGames === 0) {
        const referrer = await User.findOne({ telegramId: user.referredBy });
        if (referrer) {
          referrer.balance += settings.referralBonus;
          referrer.referralCount += 1;
          await referrer.save();
          await Transaction.create({ userId: referrer.telegramId, type:'referral', amount:settings.referralBonus, status:'completed', details:{ referredUser: user.telegramId } });
          bot.telegram.sendMessage(referrer.telegramId, `🎉 မိတ်ဆက်ဆု ${settings.referralBonus} ကျပ် ရရှိသည်!\nလက်ကျန်: ${referrer.balance} ကျပ်`).catch(()=>{});
        }
      }
      bot.telegram.sendMessage(user.telegramId, `✅ ငွေ ${txn.amount} ကျပ် ဖြည့်ပြီး!\nလက်ကျန်: ${user.balance} ကျပ်`).catch(()=>{});
      io.emit('balanceUpdate', { telegramId: user.telegramId, balance: user.balance });
    } else {
      if (user.balance < txn.amount) return ctx.answerCbQuery('❌ လက်ကျန်မလုံပါ');
      user.balance -= txn.amount;
      await user.save();
      bot.telegram.sendMessage(user.telegramId, `✅ ငွေ ${txn.amount} ကျပ် ထုတ်ပြီး!\nKPay: ${txn.details.kpayName}\nဖုန်း: ${txn.details.phoneNumber}\nလက်ကျန်: ${user.balance} ကျပ်`).catch(()=>{});
      io.emit('balanceUpdate', { telegramId: user.telegramId, balance: user.balance });
    }
    txn.status = 'completed'; txn.processedAt = new Date(); await txn.save();
    await ctx.editMessageText(ctx.callbackQuery.message.text + '\n\n✅ အတည်ပြုပြီး', { reply_markup:{ inline_keyboard:[] } }).catch(()=>{});
    ctx.answerCbQuery('✅ OK');
  } catch (e) { console.error(e); ctx.answerCbQuery('Error'); }
});

bot.action(/reject_(deposit|withdraw)_(.+)/, async (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID) return ctx.answerCbQuery('⛔');
  const [, type, txId] = ctx.match;
  try {
    const txn = await Transaction.findById(txId);
    if (!txn || txn.status !== 'pending') return ctx.answerCbQuery('Already processed');
    txn.status = 'rejected'; txn.processedAt = new Date(); await txn.save();
    const user = await User.findOne({ telegramId: txn.userId });
    if (user) bot.telegram.sendMessage(user.telegramId, `❌ ${type==='deposit'?'ငွေဖြည့်':'ငွေထုတ်'}မှု ပယ်ချပါသည်!\nပမာဏ: ${txn.amount} ကျပ်`).catch(()=>{});
    await ctx.editMessageText(ctx.callbackQuery.message.text + '\n\n❌ ပယ်ချပြီး', { reply_markup:{ inline_keyboard:[] } }).catch(()=>{});
    ctx.answerCbQuery('❌ Rejected');
  } catch (e) { console.error(e); ctx.answerCbQuery('Error'); }
});

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => res.json({ ok: true, mongo: mongoose.connection.readyState, db: currentMongoIndex + 1 }));

// ── Admin API (auth = Telegram ID in header x-admin-id) ───────────────────────
app.get('/api/admin/stats', adminAuth, async (req, res) => {
  try {
    const [totalUsers, pendingDeposits, pendingWithdraws, totalGames] = await Promise.all([
      User.countDocuments(), Transaction.countDocuments({ type:'deposit', status:'pending' }),
      Transaction.countDocuments({ type:'withdraw', status:'pending' }), Game.countDocuments()
    ]);
    const rev = await Transaction.aggregate([{ $match:{ type:'game_loss', status:'completed' } },{ $group:{ _id:null, t:{ $sum:'$amount' } } }]);
    const prizes = await Transaction.aggregate([{ $match:{ type:'game_win', status:'completed' } },{ $group:{ _id:null, t:{ $sum:'$amount' } } }]);
    const totalRevenue = rev[0]?.t||0, totalPrizes = prizes[0]?.t||0;
    res.json({ totalUsers, pendingDeposits, pendingWithdraws, totalGames, totalRevenue, totalPrizes, netProfit: totalRevenue - totalPrizes });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/deposits/pending', adminAuth, async (req, res) => {
  try { res.json(await Transaction.find({ type:'deposit', status:'pending' }).sort({ createdAt:-1 }).limit(200)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/admin/deposits/all', adminAuth, async (req, res) => {
  try { res.json(await Transaction.find({ type:'deposit' }).sort({ createdAt:-1 }).limit(300)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/admin/withdraws/pending', adminAuth, async (req, res) => {
  try { res.json(await Transaction.find({ type:'withdraw', status:'pending' }).sort({ createdAt:-1 }).limit(200)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/admin/withdraws/all', adminAuth, async (req, res) => {
  try { res.json(await Transaction.find({ type:'withdraw' }).sort({ createdAt:-1 }).limit(300)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/admin/users', adminAuth, async (req, res) => {
  try { res.json(await User.find().sort({ createdAt:-1 }).limit(500)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/admin/games', adminAuth, async (req, res) => {
  try { res.json(await Game.find().sort({ startTime:-1 }).limit(300)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/confirm/deposit/:id', adminAuth, async (req, res) => {
  try {
    const txn = await Transaction.findById(req.params.id);
    if (!txn || txn.status !== 'pending') return res.status(400).json({ error: 'Not found or processed' });
    const settings = await getSettings();
    const user = await User.findOne({ telegramId: txn.userId });
    if (!user) return res.status(404).json({ error: 'User not found' });
    user.balance += txn.amount; await user.save();
    txn.status = 'completed'; txn.processedAt = new Date(); await txn.save();
    bot.telegram.sendMessage(user.telegramId, `✅ ငွေ ${txn.amount} ကျပ် ဖြည့်ပြီး!\nလက်ကျန်: ${user.balance} ကျပ်`).catch(()=>{});
    io.emit('balanceUpdate', { telegramId: user.telegramId, balance: user.balance });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/reject/deposit/:id', adminAuth, async (req, res) => {
  try {
    const txn = await Transaction.findById(req.params.id);
    if (!txn || txn.status !== 'pending') return res.status(400).json({ error: 'Not found or processed' });
    txn.status = 'rejected'; txn.processedAt = new Date(); await txn.save();
    const user = await User.findOne({ telegramId: txn.userId });
    if (user) bot.telegram.sendMessage(user.telegramId, `❌ ငွေဖြည့်မှု ပယ်ချပါသည်!\nပမာဏ: ${txn.amount} ကျပ်`).catch(()=>{});
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/confirm/withdraw/:id', adminAuth, async (req, res) => {
  try {
    const txn = await Transaction.findById(req.params.id);
    if (!txn || txn.status !== 'pending') return res.status(400).json({ error: 'Not found or processed' });
    const user = await User.findOne({ telegramId: txn.userId });
    if (!user || user.balance < txn.amount) return res.status(400).json({ error: 'Insufficient balance' });
    user.balance -= txn.amount; await user.save();
    txn.status = 'completed'; txn.processedAt = new Date(); await txn.save();
    bot.telegram.sendMessage(user.telegramId, `✅ ငွေ ${txn.amount} ကျပ် ထုတ်ပြီး!\nKPay: ${txn.details.kpayName}\nဖုန်း: ${txn.details.phoneNumber}\nလက်ကျန်: ${user.balance} ကျပ်`).catch(()=>{});
    io.emit('balanceUpdate', { telegramId: user.telegramId, balance: user.balance });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/reject/withdraw/:id', adminAuth, async (req, res) => {
  try {
    const txn = await Transaction.findById(req.params.id);
    if (!txn || txn.status !== 'pending') return res.status(400).json({ error: 'Not found or processed' });
    txn.status = 'rejected'; txn.processedAt = new Date(); await txn.save();
    const user = await User.findOne({ telegramId: txn.userId });
    if (user) bot.telegram.sendMessage(user.telegramId, `❌ ငွေထုတ်မှု ပယ်ချပါသည်!\nပမာဏ: ${txn.amount} ကျပ်`).catch(()=>{});
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/adjust-balance', adminAuth, async (req, res) => {
  try {
    const { userId, amount, note } = req.body;
    const user = await User.findOne({ telegramId: userId });
    if (!user) return res.status(404).json({ error: 'User not found' });
    const parsed = parseInt(amount);
    if (isNaN(parsed)) return res.status(400).json({ error: 'Invalid amount' });
    if (user.balance + parsed < 0) return res.status(400).json({ error: 'Balance cannot go negative' });
    user.balance += parsed; await user.save();
    await Transaction.create({ userId, type:'adjust', amount:parsed, status:'completed', details:{ note: note||'Admin adjustment' } });
    bot.telegram.sendMessage(userId, `📋 Admin balance ${parsed>0?'+':''}${parsed} ကျပ် ပြောင်း\nလက်ကျန်: ${user.balance} ကျပ်`).catch(()=>{});
    io.emit('balanceUpdate', { telegramId: userId, balance: user.balance });
    res.json({ success: true, newBalance: user.balance });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/ban-user', adminAuth, async (req, res) => {
  try {
    await User.updateOne({ telegramId: req.body.userId }, { banned: req.body.banned });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/broadcast', adminAuth, async (req, res) => {
  try {
    const { message } = req.body;
    const users = await User.find({}, 'telegramId');
    let sent = 0, failed = 0;
    for (const u of users) {
      try { await bot.telegram.sendMessage(u.telegramId, `📢 ${message}`); sent++; await new Promise(r => setTimeout(r, 50)); }
      catch { failed++; }
    }
    res.json({ success: true, sent, failed });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/settings', adminAuth, async (req, res) => {
  try { res.json(await getSettings()); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/settings', adminAuth, async (req, res) => {
  try { await Settings.findOneAndUpdate({ key:'game' }, { key:'game', value: req.body }, { upsert:true }); res.json({ success:true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/user/:telegramId', async (req, res) => {
  try {
    const u = await User.findOne({ telegramId: req.params.telegramId });
    if (!u) return res.status(404).json({ error: 'Not found' });
    res.json({ telegramId:u.telegramId, username:u.username, firstName:u.firstName, balance:u.balance, referralCount:u.referralCount, totalWins:u.totalWins, totalGames:u.totalGames });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Socket.IO ─────────────────────────────────────────────────────────────────
const waitingGames  = new Map();
const playerSockets = new Map();

io.on('connection', (socket) => {
  socket.on('authenticate', async ({ telegramId } = {}) => {
    try {
      if (!telegramId) return;
      const user = await User.findOne({ telegramId });
      if (!user) return;
      if (user.banned) { socket.emit('error', 'ဤအကောင့် ပိတ်ထားပါသည်'); return; }
      socket.userId = telegramId;
      playerSockets.set(telegramId, socket.id);
      socket.emit('authenticated', { balance:user.balance, username:user.username||user.firstName, referralCount:user.referralCount, totalWins:user.totalWins, totalGames:user.totalGames });
    } catch (e) { console.error('Auth error:', e); }
  });

  socket.on('requestDeposit', async ({ telegramId, kpayName, transactionId, amount } = {}) => {
    try {
      const settings = await getSettings();
      if (!telegramId||!kpayName||!transactionId||!amount) return socket.emit('depositError','အချက်အလက် မပြည့်စုံပါ။');
      if (amount < settings.minDeposit) return socket.emit('depositError',`အနည်းဆုံး ${settings.minDeposit} ကျပ် ဖြည့်ပါ။`);
      if (await Transaction.findOne({ 'details.transactionId': transactionId })) return socket.emit('depositError','Transaction ID ထပ်နေသည်။');
      const txn = await Transaction.create({ userId:telegramId, type:'deposit', amount, status:'pending', details:{ kpayName, transactionId } });
      bot.telegram.sendMessage(ADMIN_ID,
        `💰 ငွေဖြည့် တောင်းဆိုချက်\n━━━━━━━━━\nUser: ${telegramId}\nKPay: ${kpayName}\nTxn: ${transactionId}\nပမာဏ: ${amount} ကျပ်`,
        Markup.inlineKeyboard([[Markup.button.callback('✅ Confirm',`confirm_deposit_${txn._id}`), Markup.button.callback('❌ Reject',`reject_deposit_${txn._id}`)]])
      ).catch(()=>{});
      socket.emit('depositSuccess','ငွေဖြည့်ရန် တောင်းဆိုချက် ပို့ပြီး။ Admin အတည်ပြုပါမည်။');
    } catch (e) { console.error(e); socket.emit('depositError','Server error — နောက်မှ ထပ်ကြိုးစားပါ။'); }
  });

  socket.on('requestWithdraw', async ({ telegramId, kpayName, phoneNumber, amount } = {}) => {
    try {
      const settings = await getSettings();
      if (!telegramId||!kpayName||!phoneNumber||!amount) return socket.emit('withdrawError','အချက်အလက် မပြည့်စုံပါ။');
      if (amount < settings.minWithdraw) return socket.emit('withdrawError',`အနည်းဆုံး ${settings.minWithdraw} ကျပ် ထုတ်ပါ။`);
      const user = await User.findOne({ telegramId });
      if (!user||user.balance<amount) return socket.emit('withdrawError','လက်ကျန်ငွေ မလုံပါ။');
      const txn = await Transaction.create({ userId:telegramId, type:'withdraw', amount, status:'pending', details:{ kpayName, phoneNumber } });
      bot.telegram.sendMessage(ADMIN_ID,
        `💸 ငွေထုတ် တောင်းဆိုချက်\n━━━━━━━━━\nUser: ${telegramId}\nKPay: ${kpayName}\nဖုန်း: ${phoneNumber}\nပမာဏ: ${amount} ကျပ်\nလက်ကျန်: ${user.balance} ကျပ်`,
        Markup.inlineKeyboard([[Markup.button.callback('✅ Confirm',`confirm_withdraw_${txn._id}`), Markup.button.callback('❌ Reject',`reject_withdraw_${txn._id}`)]])
      ).catch(()=>{});
      socket.emit('withdrawSuccess','ငွေထုတ်ရန် တောင်းဆိုချက် ပို့ပြီး။ Admin ထုတ်ပေးပါမည်။');
    } catch (e) { console.error(e); socket.emit('withdrawError','Server error — နောက်မှ ထပ်ကြိုးစားပါ။'); }
  });

  socket.on('startGame', async ({ telegramId } = {}) => {
    try {
      const settings = await getSettings();
      const user = await User.findOne({ telegramId });
      if (!user) return socket.emit('gameError','အကောင့် မတွေ့ပါ။');
      if (user.balance < settings.gameFee) return socket.emit('gameError',`ငွေမလောက်ပါ။ အနည်းဆုံး ${settings.gameFee} ကျပ် လိုသည်။`);
      const active = await Game.findOne({ $or:[{player1:telegramId},{player2:telegramId}], gameStatus:{$in:['waiting','playing']} });
      if (active) return socket.emit('gameStarted',{ gameId:active.gameId, balance:user.balance });
      user.balance -= settings.gameFee; await user.save();
      const gameId = `game_${Date.now()}_${telegramId}`;
      await Game.create({ gameId, player1:telegramId, gameStatus:'waiting', betAmount:settings.gameFee, prizeAmount:settings.gamePrize, boardState:Array(5).fill(null).map(()=>Array(5).fill('')) });
      socket.join(gameId); socket.gameId = gameId;
      socket.emit('gameStarted',{ gameId, balance:user.balance });
      io.emit('balanceUpdate',{ telegramId, balance:user.balance });
      const handle = setTimeout(async () => {
        try {
          const g = await Game.findOne({ gameId, gameStatus:'waiting' });
          if (!g) return;
          g.player2='bot'; g.gameStatus='playing'; g.currentTurn=telegramId; await g.save();
          io.to(gameId).emit('gameMatched',{ gameId, opponent:'bot' });
          io.to(gameId).emit('moveMade',{ gameId, board:g.boardState, currentTurn:telegramId });
        } catch(e){ console.error(e); }
      }, 30000);
      waitingGames.set(gameId, handle);
    } catch(e){ console.error(e); socket.emit('gameError','ဂိမ်းမစနိုင်ပါ။'); }
  });

  socket.on('joinGame', async ({ telegramId, gameId } = {}) => {
    try {
      const settings = await getSettings();
      const user = await User.findOne({ telegramId });
      if (!user||user.balance<settings.gameFee) return socket.emit('gameError','ငွေမလောက်ပါ။');
      const game = await Game.findOne({ gameId, gameStatus:'waiting' });
      if (!game) return socket.emit('gameError','ဂိမ်းမရှိတော့ပါ။');
      if (game.player1===telegramId) return socket.emit('gameError','မိမိကိုယ်တိုင်နှင့် ကစားမရပါ။');
      user.balance -= settings.gameFee; await user.save();
      if (waitingGames.has(gameId)) { clearTimeout(waitingGames.get(gameId)); waitingGames.delete(gameId); }
      game.player2=telegramId; game.gameStatus='playing'; game.currentTurn=game.player1; await game.save();
      socket.join(gameId); socket.gameId=gameId;
      io.to(gameId).emit('gameMatched',{ gameId, opponent:user.username||user.firstName });
      io.to(gameId).emit('moveMade',{ gameId, board:game.boardState, currentTurn:game.player1 });
      io.emit('balanceUpdate',{ telegramId, balance:user.balance });
    } catch(e){ console.error(e); socket.emit('gameError','ဂိမ်းဝင်မရပါ။'); }
  });

  socket.on('makeMove', async ({ gameId, telegramId, row, col } = {}) => {
    try {
      if (row<0||row>4||col<0||col>4) return;
      const game = await Game.findOne({ gameId, gameStatus:'playing' });
      if (!game||game.currentTurn!==telegramId||game.boardState[row][col]) return;
      const symbol = telegramId===game.player1?'X':'O';
      game.boardState[row][col]=symbol; game.markModified('boardState');
      if (checkWin(game.boardState,row,col,symbol)) {
        await endGame(game,telegramId,'win');
      } else if (game.boardState.flat().every(c=>c)) {
        await endGame(game,null,'draw');
      } else {
        const next = telegramId===game.player1?game.player2:game.player1;
        game.currentTurn=next; await game.save();
        io.to(gameId).emit('moveMade',{ gameId, board:game.boardState, currentTurn:next });
        if (next==='bot') setTimeout(()=>makeBotMove(gameId), 700+Math.random()*600);
      }
    } catch(e){ console.error(e); }
  });

  socket.on('gameTimeout', async ({ gameId, telegramId } = {}) => {
    try {
      const game = await Game.findOne({ gameId, gameStatus:'playing' });
      if (!game) return;
      const winner = game.player1===telegramId?game.player2:game.player1;
      await endGame(game, winner==='bot'?null:winner, winner==='bot'?'botwin':'win');
    } catch(e){ console.error(e); }
  });

  socket.on('forfeit', async ({ gameId, telegramId } = {}) => {
    try {
      const game = await Game.findOne({ gameId, gameStatus:'playing' });
      if (!game) return;
      const winner = game.player1===telegramId?game.player2:game.player1;
      if (winner&&winner!=='bot') await endGame(game,winner,'win');
    } catch(e){}
  });

  socket.on('disconnect', async () => {
    if (socket.userId) playerSockets.delete(socket.userId);
    if (socket.gameId) {
      try {
        const game = await Game.findOne({ gameId:socket.gameId, gameStatus:'playing' });
        if (game) {
          const winner = game.player1===socket.userId?game.player2:game.player1;
          if (winner&&winner!=='bot') await endGame(game,winner,'win');
        }
      } catch(e){}
    }
  });
});

// ── Game Logic ────────────────────────────────────────────────────────────────
async function endGame(game, winner, type) {
  try {
    game.gameStatus='completed'; game.endTime=new Date(); game.winner=winner||null; game.isDraw=(type==='draw');
    if (type==='draw') {
      const p1 = await User.findOne({ telegramId:game.player1 });
      if (p1){ p1.balance+=game.betAmount; p1.totalGames+=1; await p1.save(); io.emit('balanceUpdate',{ telegramId:game.player1, balance:p1.balance }); }
      if (game.player2&&game.player2!=='bot') {
        const p2 = await User.findOne({ telegramId:game.player2 });
        if (p2){ p2.balance+=game.betAmount; p2.totalGames+=1; await p2.save(); io.emit('balanceUpdate',{ telegramId:game.player2, balance:p2.balance }); }
      }
      await Transaction.create({ userId:game.player1, type:'game_draw', amount:game.betAmount, status:'completed' });
      io.to(game.gameId).emit('gameOver',{ gameId:game.gameId, draw:true });
    } else if (winner) {
      const wu = await User.findOne({ telegramId:winner });
      if (wu){ wu.balance+=game.prizeAmount; wu.totalWins+=1; wu.totalGames+=1; await wu.save(); await Transaction.create({ userId:winner, type:'game_win', amount:game.prizeAmount, status:'completed' }); io.emit('balanceUpdate',{ telegramId:winner, balance:wu.balance }); }
      const loser = game.player1===winner?game.player2:game.player1;
      if (loser&&loser!=='bot'){ const lu=await User.findOne({ telegramId:loser }); if(lu){ lu.totalGames+=1; await lu.save(); } await Transaction.create({ userId:loser, type:'game_loss', amount:game.betAmount, status:'completed' }); }
      io.to(game.gameId).emit('gameOver',{ gameId:game.gameId, winner });
    } else {
      const loser = game.player1!=='bot'?game.player1:game.player2;
      if (loser){ const lu=await User.findOne({ telegramId:loser }); if(lu){ lu.totalGames+=1; await lu.save(); } await Transaction.create({ userId:loser, type:'game_loss', amount:game.betAmount, status:'completed' }); }
      io.to(game.gameId).emit('gameOver',{ gameId:game.gameId, winner:'bot' });
    }
    await game.save();
  } catch(e){ console.error('endGame error:',e); }
}

async function makeBotMove(gameId) {
  try {
    const game = await Game.findOne({ gameId, gameStatus:'playing', currentTurn:'bot' });
    if (!game) return;
    const board = game.boardState;
    const move = findBestMove(board);
    if (!move) return;
    board[move.row][move.col]='O'; game.markModified('boardState');
    if (checkWin(board,move.row,move.col,'O')) {
      await endGame(game,null,'botwin');
    } else if (board.flat().every(c=>c)) {
      await endGame(game,null,'draw');
    } else {
      const player = game.player1!=='bot'?game.player1:game.player2;
      game.currentTurn=player; await game.save();
      io.to(gameId).emit('moveMade',{ gameId, board, currentTurn:player });
    }
  } catch(e){ console.error('botMove error:',e); }
}

function checkWin(board,row,col,symbol) {
  const dirs=[[1,0],[0,1],[1,1],[1,-1]];
  for (const [dr,dc] of dirs) {
    let n=1;
    for(let i=1;i<4;i++){const r=row+dr*i,c=col+dc*i;if(r<0||r>=5||c<0||c>=5||board[r][c]!==symbol)break;n++;}
    for(let i=1;i<4;i++){const r=row-dr*i,c=col-dc*i;if(r<0||r>=5||c<0||c>=5||board[r][c]!==symbol)break;n++;}
    if(n>=4)return true;
  }
  return false;
}

function findBestMove(board) {
  // Win
  for(let r=0;r<5;r++) for(let c=0;c<5;c++) if(!board[r][c]){board[r][c]='O';if(checkWin(board,r,c,'O')){board[r][c]='';return{row:r,col:c};}board[r][c]='';}
  // Block
  for(let r=0;r<5;r++) for(let c=0;c<5;c++) if(!board[r][c]){board[r][c]='X';if(checkWin(board,r,c,'X')){board[r][c]='';return{row:r,col:c};}board[r][c]='';}
  // Score
  let best=null,bs=-1;
  const score=(s,r,c)=>{let t=0;[[1,0],[0,1],[1,1],[1,-1]].forEach(([dr,dc])=>{let n=1;for(let i=1;i<5;i++){const nr=r+dr*i,nc=c+dc*i;if(nr<0||nr>=5||nc<0||nc>=5||board[nr][nc]!==s)break;n++;}for(let i=1;i<5;i++){const nr=r-dr*i,nc=c-dc*i;if(nr<0||nr>=5||nc<0||nc>=5||board[nr][nc]!==s)break;n++;}t+=n*n;});return t;};
  for(let r=0;r<5;r++) for(let c=0;c<5;c++) if(!board[r][c]){const s=score('O',r,c)+score('X',r,c)*0.9+(r===2&&c===2?10:0);if(s>bs){bs=s;best={row:r,col:c};}}
  return best;
}

// ── Start ─────────────────────────────────────────────────────────────────────
(async () => {
  await connectMongoDB(0);
  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => console.log(`🚀 Server on port ${PORT}`));
  bot.launch({ dropPendingUpdates: true }).then(() => console.log('🤖 Bot started')).catch(e => console.error('Bot error:', e));
  process.once('SIGINT',  () => { bot.stop('SIGINT');  process.exit(0); });
  process.once('SIGTERM', () => { bot.stop('SIGTERM'); process.exit(0); });
})();
