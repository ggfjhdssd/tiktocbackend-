const express = require('express');
const { Telegraf, Markup } = require('telegraf');
const { Server } = require('socket.io');
const http = require('http');
const mongoose = require('mongoose');
const crypto = require('crypto');
const https = require('https');
require('dotenv').config();

const app = express();
const server = http.createServer(app);

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type,Authorization,x-admin-id,x-telegram-id');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
app.use(express.json());

const io = new Server(server, {
  cors: { origin: '*', methods: ['GET','POST'] },
  allowEIO3: true,
  pingTimeout: 30000,
  pingInterval: 10000
});

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = process.env.ADMIN_ID ? parseInt(process.env.ADMIN_ID) : null;
// Extra admins — comma-separated telegram IDs in env: ADMIN_IDS=111,222,333
const EXTRA_ADMIN_IDS = (process.env.ADMIN_IDS || process.env.PARTNER_IDS || '')
  .split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));
// Full list of admins with complete control
function isAnyAdmin(tid) {
  const id = parseInt(tid);
  return (ADMIN_ID && id === ADMIN_ID) || EXTRA_ADMIN_IDS.includes(id);
}
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://tictokfrontend.vercel.app';
const BACKEND_URL = process.env.BACKEND_URL || 'https://tiktocbackend-zktq.onrender.com';
const BOT_USERNAME = process.env.BOT_USERNAME || 'tictoe1_bot';
const ENTRY_FEE = 500;
const WIN_PRIZE = 800;
const DRAW_REFUND = 400;

const VALID_BETS = [500, 1000, 3000];
const BET_TABLE = {
  500:  { entryFee: 500,  winPrize: 800,  drawRefund: 400  },
  1000: { entryFee: 1000, winPrize: 1700, drawRefund: 900  },
  3000: { entryFee: 3000, winPrize: 5500, drawRefund: 2800 },
};
function getBetPrizes(bet) {
  return BET_TABLE[parseInt(bet)] || BET_TABLE[500];
}
const L1_COMMISSION = 50;
const L2_COMMISSION = 20;
const L3_COMMISSION = 10;
const TURN_SECONDS = 10;
const SEARCH_TIMEOUT_S = 60;
const DISCONNECT_GRACE_S = 10; // FIX #3: 10 second grace period

// ===== MongoDB =====
let isConnected = false;
async function connectDB() {
  const uris = [process.env.MONGODB_URI1, process.env.MONGODB_URI2].filter(Boolean);
  for (const uri of uris) {
    try {
      await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
      isConnected = true;
      console.log('✅ MongoDB connected');
      return;
    } catch (e) { console.error('❌ MongoDB failed:', e.message); }
  }
  setTimeout(connectDB, 10000);
}
mongoose.connection.on('disconnected', () => { isConnected = false; });
mongoose.connection.on('reconnected', () => { isConnected = true; });
connectDB();

async function seedAgentPaymentInfo() {
  try {
    const agentUser = await User.findOne({ referralCode: 'TIC3W2ZCO6CXBK', role: 'agent' }).lean();
    if (!agentUser) return;
    const existing = await Agent.findOne({ telegramId: agentUser.telegramId }).lean();
    if (existing && existing.agentKpayNumber === '09781317607') return;
    await Agent.findOneAndUpdate(
      { telegramId: agentUser.telegramId },
      { $set: { agentKpayNumber: '09781317607', agentKpayName: 'Nang pauk', hasWave: false } },
      { upsert: false }
    );
    console.log('✅ Seeded Nang pauk kpay info');
  } catch(e) { console.error('seedAgentPaymentInfo err:', e.message); }
}
setTimeout(seedAgentPaymentInfo, 5000);

// ===== Schemas =====
// FIX #2: Removed botMode, botMatchCount from userSchema
const userSchema = new mongoose.Schema({
  telegramId: { type: Number, required: true, unique: true },
  username: { type: String, default: '' },
  firstName: { type: String, default: '' },
  balance: { type: Number, default: 0 },
  referredBy: { type: Number, default: null },
  referralCode: { type: String, unique: true, sparse: true },
  totalGames: { type: Number, default: 0 },
  wins: { type: Number, default: 0 },
  losses: { type: Number, default: 0 },
  isBanned: { type: Boolean, default: false },
  role: { type: String, enum: ['user','agent'], default: 'user' },
  kpayNumber: { type: String, default: '' },
  waveNumber: { type: String, default: '' },
  referralTree: {
    l1Agent: { type: Number, default: null },
    l2Agent: { type: Number, default: null },
    l3Agent: { type: Number, default: null }
  },
  lastActive: { type: Date, default: Date.now },
  createdAt: { type: Date, default: Date.now },
  isFirstDepositUsed: { type: Boolean, default: false },
  turnoverTarget:     { type: Number,  default: 0 },
  turnoverProgress:   { type: Number,  default: 0 },
  consecutiveLosses:  { type: Number,  default: 0 }
});
userSchema.index({ telegramId: 1 });
userSchema.index({ referralCode: 1 });

const depositSchema = new mongoose.Schema({
  userId: { type: Number, required: true },
  kpayName: String,
  transactionId: { type: String, required: true, unique: true },
  amount: { type: Number, required: true },
  paymentMethod: { type: String, enum: ['kpay','wave'], default: 'kpay' },
  status: { type: String, enum: ['pending','confirmed','rejected'], default: 'pending' },
  processedBy: { type: String, enum: ['admin','agent'], default: 'admin' },
  createdAt: { type: Date, default: Date.now },
  processedAt: Date,
  expireAt: { type: Date, default: null }
});
depositSchema.index({ transactionId: 1 });
depositSchema.index({ status: 1 });
depositSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });

const withdrawalSchema = new mongoose.Schema({
  userId: { type: Number, required: true },
  kpayName: String,
  kpayNumber: String,
  amount: { type: Number, required: true },
  paymentMethod: { type: String, enum: ['kpay','wave'], default: 'kpay' },
  status: { type: String, enum: ['pending','confirmed','rejected'], default: 'pending' },
  createdAt: { type: Date, default: Date.now },
  processedAt: Date,
  expireAt: { type: Date, default: null }
});
withdrawalSchema.index({ status: 1 });
withdrawalSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });

// FIX #2: Removed isAIGame from gameSchema
const gameSchema = new mongoose.Schema({
  gameId: { type: String, required: true, unique: true },
  players: [Number],
  playerNames: { type: Map, of: String, default: {} },
  symbols: { type: Map, of: String },
  board: { type: [[String]], default: () => Array(5).fill(null).map(() => Array(5).fill('')) },
  winner: { type: mongoose.Schema.Types.Mixed, default: null },
  winnerName: { type: String, default: '' },
  status: { type: String, enum: ['waiting','active','completed'], default: 'waiting' },
  createdAt: { type: Date, default: Date.now, expires: 86400*30 }
});
gameSchema.index({ gameId: 1 });

const settingsSchema = new mongoose.Schema({
  key: { type: String, unique: true },
  value: mongoose.Schema.Types.Mixed
});

const redeemCodeSchema = new mongoose.Schema({
  code:       { type: String, required: true, unique: true, uppercase: true, trim: true },
  amount:     { type: Number, required: true },
  maxUses:    { type: Number, default: 1 },
  usedBy:     [{ type: Number }],
  isActive:   { type: Boolean, default: true },
  createdAt:  { type: Date, default: Date.now }
});
redeemCodeSchema.index({ code: 1 });

const agentSchema = new mongoose.Schema({
  telegramId:    { type: Number, required: true, unique: true },
  referralCode:  { type: String },
  agentKpayNumber:  { type: String, default: '' },
  agentKpayName:    { type: String, default: '' },
  agentWaveNumber:  { type: String, default: '' },
  agentWaveName:    { type: String, default: '' },
  hasWave:          { type: Boolean, default: false },
  totalEarned:   { type: Number, default: 0 },
  isActive:      { type: Boolean, default: true },
  createdAt:     { type: Date, default: Date.now }
});
agentSchema.index({ telegramId: 1 });

const User = mongoose.model('User', userSchema);
const Deposit = mongoose.model('Deposit', depositSchema);
const Withdrawal = mongoose.model('Withdrawal', withdrawalSchema);
const Game = mongoose.model('Game', gameSchema);
const Settings = mongoose.model('Settings', settingsSchema);
const RedeemCode = mongoose.model('RedeemCode', redeemCodeSchema);
const Agent = mongoose.model('Agent', agentSchema);

// ===== In-Memory State =====
const waitingQueue = [];
const activeGames = new Map();
const gameTurnTimeouts = new Map();
const userSockets = new Map();
const searchNotifications = new Map();
const searchTimeouts = new Map();
const fakeGameIds = new Set();
const blockedUsers = new Set(); // FIX #4: telegram IDs that blocked the bot — skip in sends

// FIX #6: Spam/Race Protection Maps
const processingUsers = new Set();
const moveCooldowns    = new Map();
const findGameCooldowns = new Map();
const MOVE_COOLDOWN_MS     = 300;
const FINDGAME_COOLDOWN_MS = 2000;

// ===== Helpers =====
function genRefCode(id) {
  return 'TIC' + id.toString(36).toUpperCase() + Math.random().toString(36).substr(2,4).toUpperCase();
}
function genGameId() {
  return 'g' + Date.now() + Math.random().toString(36).substr(2,5);
}

function verifyTgAuth(initData) {
  if (!initData || !BOT_TOKEN) return null;
  try {
    const p = new URLSearchParams(initData);
    const hash = p.get('hash');
    if (!hash) return null;
    const check = Array.from(p.entries())
      .filter(([k]) => k !== 'hash')
      .sort(([a],[b]) => a.localeCompare(b))
      .map(([k,v]) => `${k}=${v}`).join('\n');
    const secret = crypto.createHmac('sha256','WebAppData').update(BOT_TOKEN).digest();
    const hmac = crypto.createHmac('sha256',secret).update(check).digest('hex');
    if (hmac !== hash) return null;
    const u = p.get('user');
    return u ? JSON.parse(u) : null;
  } catch { return null; }
}

// ===== Board Logic =====
const BOARD_SIZE = 5;
const WIN_LEN = 4;

function checkWin(board, sym) {
  const dirs = [[0,1],[1,0],[1,1],[1,-1]];
  for (let r = 0; r < BOARD_SIZE; r++) {
    for (let c = 0; c < BOARD_SIZE; c++) {
      if (board[r][c] !== sym) continue;
      for (const [dr, dc] of dirs) {
        let cnt = 1;
        for (let i = 1; i < WIN_LEN; i++) {
          const nr = r + dr * i, nc = c + dc * i;
          if (nr < 0 || nr >= BOARD_SIZE || nc < 0 || nc >= BOARD_SIZE || board[nr][nc] !== sym) break;
          cnt++;
        }
        if (cnt >= WIN_LEN) return true;
      }
    }
  }
  return false;
}

function boardFull(board) {
  return board.every(r => r.every(c => c !== ''));
}

// ===== FIX #2: Fake Notification Names (replaces removed AI_NAMES) =====
const FAKE_NAMES = [
  'Min Khant Kyaw','Thura Aung','Nay Chi Win','Su Myat Noe','Kyaw Zin Htet',
  'Aye Chan Ko','Phyu Phyu Win','Kaung Myat Thu','Zaw_Lin_Htet','Myo_Min_Tun',
  'Ei_Thandar_Phyu','Ko_Phyo_99','Mg_Kaung_Mandalay','Shine_Htet_Aung','AungKyaw2026',
  'Htet_Naing_88','Khin_Su_112','Bo_Bo_Gyi_007','Thin_Zar_9','Kyaw_Kyaw_MM'
];
function randomFakeName() {
  return FAKE_NAMES[Math.floor(Math.random() * FAKE_NAMES.length)];
}

// ===== 3-Level Commission =====
async function distribute3LevelCommission(playerId) {
  if (!playerId) return;
  try {
    const player = await User.findOne({ telegramId: playerId }).lean();
    if (!player || !player.referredBy) return;
    const l1 = await User.findOneAndUpdate(
      { telegramId: player.referredBy },
      { $inc: { balance: L1_COMMISSION } },
      { new: true }
    );
    if (l1) {
      if (bot) bot.telegram.sendMessage(player.referredBy,
        `💸 သင့်ဆီသို့ <b>Level 1</b> ကော်မရှင် <b>${L1_COMMISSION} ကျပ်</b> ရောက်ရှိပါပြီ`,
        { parse_mode: 'HTML' }).catch(() => {});
    }
    if (!l1?.referredBy) return;
    const l2 = await User.findOneAndUpdate(
      { telegramId: l1.referredBy },
      { $inc: { balance: L2_COMMISSION } },
      { new: true }
    );
    if (l2) {
      if (bot) bot.telegram.sendMessage(l1.referredBy,
        `💸 သင့်ဆီသို့ <b>Level 2</b> ကော်မရှင် <b>${L2_COMMISSION} ကျပ်</b> ရောက်ရှိပါပြီ`,
        { parse_mode: 'HTML' }).catch(() => {});
    }
    if (!l2?.referredBy) return;
    const l3 = await User.findOneAndUpdate(
      { telegramId: l2.referredBy },
      { $inc: { balance: L3_COMMISSION } },
      { new: true }
    );
    if (l3) {
      if (bot) bot.telegram.sendMessage(l2.referredBy,
        `💸 သင့်ဆီသို့ <b>Level 3</b> ကော်မရှင် <b>${L3_COMMISSION} ကျပ်</b> ရောက်ရှိပါပြီ`,
        { parse_mode: 'HTML' }).catch(() => {});
    }
  } catch(e) { console.error('3-level commission err:', e.message); }
}

async function checkRescueBonus(userId) {
  try {
    const u = await User.findOne({ telegramId: userId }).lean();
    if (!u) return;
    if (u.consecutiveLosses === 5) {
      await User.findOneAndUpdate(
        { telegramId: userId },
        { $inc: { balance: 200 }, $set: { consecutiveLosses: 0 } }
      );
      const sockId = userSockets.get(userId);
      if (sockId) {
        const sock = io.sockets.sockets.get(sockId);
        if (sock) sock.emit('rescueBonus', { amount: 200 });
      }
      if (bot) bot.telegram.sendMessage(userId,
        `🛡️ <b>Rescue Bonus ရရှိပြီ!</b>\n\n၅ ပွဲဆက်တိုက်ရှုံးသွားသဖြင့် Rescue Bonus <b>200 MMK</b> ပြန်ရရှိပါသည် 🎁\n\nဆက်လက်ကြိုးစားပါ 💪`,
        { parse_mode: 'HTML' }).catch(() => {});
    }
  } catch(e) { console.error('rescueBonus err:', e.message); }
}

async function applyFirstDepositBonus(userId, depositAmount) {
  try {
    const u = await User.findOne({ telegramId: userId }).lean();
    if (!u || u.isFirstDepositUsed) return;
    if (depositAmount >= 5000) {
      await User.findOneAndUpdate({ telegramId: userId }, {
        $inc: { balance: 500, turnoverTarget: 2500 },
        $set: { isFirstDepositUsed: true }
      });
      if (bot) bot.telegram.sendMessage(userId,
        `🎉 <b>First Deposit Bonus ရရှိပြီ!</b>\n\n+<b>500 MMK</b> Bonus သင့်ကောင့်တွင် ပေါင်းထည့်ပြီ 🎁\n\n⚠️ Bonus ကိုထုတ်ယူနိုင်ရန် <b>2,500 MMK</b> ဖိုး အနည်းဆုံး ကစားရပါမည် (Turnover)`,
        { parse_mode: 'HTML' }).catch(() => {});
    }
  } catch(e) { console.error('firstDepositBonus err:', e.message); }
}

async function getSetting(key, def) {
  try { const s = await Settings.findOne({key}).lean(); return s ? s.value : def; } catch { return def; }
}
async function setSetting(key, value) {
  await Settings.findOneAndUpdate({key},{value},{upsert:true});
}

// ===== Bot =====
let bot = null;
if (BOT_TOKEN) {
  bot = new Telegraf(BOT_TOKEN);

  const CHANNEL_USERNAME = 'EzMoneyPayy';
  const CHANNEL_LINK = 'https://t.me/EzMoneyPayy';

  async function isChannelMember(userId) {
    try {
      const member = await bot.telegram.getChatMember(`@${CHANNEL_USERNAME}`, userId);
      return ['member','administrator','creator'].includes(member.status);
    } catch(e) { return false; }
  }

  bot.start(async (ctx) => {
    try {
      const id = ctx.from.id;
      const args = ctx.payload;
      const maint = await getSetting('maintenance', false);
      if (maint && !isAnyAdmin(id)) {
        try { await ctx.reply('🔧 ဆာဗာ ပြင်ဆင်နေသောကြောင့် ယာယီပိတ်ထားပါသည်။'); } catch (e) {}
        return;
      }
      let user = await User.findOne({ telegramId: id });
      if (!user) {
        user = new User({
          telegramId: id,
          username: ctx.from.username||'',
          firstName: ctx.from.first_name||'',
          referralCode: genRefCode(id)
        });
        if (args && args.length > 3) {
          const ref = await User.findOne({ referralCode: args }).lean();
          if (ref && ref.telegramId !== id) user.referredBy = ref.telegramId;
        }
        await user.save();
      }
      const isMember = await isChannelMember(id);
      if (!isMember) {
        await ctx.reply(
          `👋 မင်္ဂလာပါ ${ctx.from.first_name}!\n\n🎮 ကစားရန် ဦးစွာ Channel ကို Join ဖြစ်ရပါမည်!\n\n📢 Join ပြုလုပ်ပြီးနောက် <b>/start</b> ကို ထပ်နှိပ်ပါ`,
          {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
              [Markup.button.url('📢 Channel Join ရန်', CHANNEL_LINK)],
              [Markup.button.callback('✅ Join ပြီးပြီ — စစ်ဆေးပါ', 'check_join')]
            ])
          }
        ).catch(()=>{});
        return;
      }
      await ctx.reply(
        `🎮 မင်္ဂလာပါ ${ctx.from.first_name}!\n\n💰 လက်ကျန်: ${user.balance.toLocaleString()} MMK\n🏆 နိုင်: ${user.wins}  •  ❌ ရှုံး: ${user.losses}`,
        Markup.inlineKeyboard([
          [Markup.button.webApp('🎮 PLAY NOW', FRONTEND_URL)],
          [Markup.button.callback('💰 Balance','bal'), Markup.button.callback('🔗 Referral','ref')]
        ])
      ).catch(()=>{});
    } catch(e) {
      console.error('Error in /start:', e.stack || e);
      ctx.reply('⚠️ ဆာဗာ ချိတ်ဆက်မှု ပြဿနာ').catch(()=>{});
    }
  });

  bot.action('check_join', async (ctx) => {
    try {
      await ctx.answerCbQuery('စစ်ဆေးနေပါသည်...').catch(()=>{});
      const id = ctx.from.id;
      const isMember = await isChannelMember(id);
      if (!isMember) {
        await ctx.reply(
          `❌ Channel Join မပြုလုပ်ရသေးပါ!\n\nChannel ကို Join ပြုလုပ်ပြီးမှ ထပ်စစ်ဆေးပါ 👇`,
          Markup.inlineKeyboard([
            [Markup.button.url('📢 Channel Join ရန်', CHANNEL_LINK)],
            [Markup.button.callback('✅ Join ပြီးပြီ — စစ်ဆေးပါ', 'check_join')]
          ])
        ).catch(()=>{});
        return;
      }
      const user = await User.findOne({ telegramId: id }).lean();
      if (!user) {
        await ctx.reply('ဦးစွာ /start နှိပ်ပါ').catch(()=>{});
        return;
      }
      await ctx.reply(
        `✅ Channel Join ပြုလုပ်ပြီး!\n\n🎮 TicToeTic ကစားနိုင်ပြီ!\n💰 လက်ကျန်: ${user.balance.toLocaleString()} MMK`,
        Markup.inlineKeyboard([[Markup.button.webApp('🎮 PLAY NOW', FRONTEND_URL)]])
      ).catch(()=>{});
    } catch(e) { console.error('check_join err:', e.stack || e); }
  });

  bot.action('bal', async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(()=>{});
      const u = await User.findOne({ telegramId: ctx.from.id }).lean();
      if (!u) return;
      await ctx.reply(`💰 လက်ကျန်: <b>${u.balance.toLocaleString()} MMK</b>`, { parse_mode: 'HTML' }).catch(()=>{});
    } catch(e) {}
  });

  bot.action('ref', async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(()=>{});
      const u = await User.findOne({ telegramId: ctx.from.id }).lean();
      if (!u) return;
      const refCount = await User.countDocuments({ referredBy: ctx.from.id });
      const refLink = `https://t.me/${BOT_USERNAME}?start=${u.referralCode}`;
      await ctx.reply(
        `🔗 <b>Referral Link:</b>\n<code>${refLink}</code>\n\n👥 Referral Count: <b>${refCount}</b>`,
        { parse_mode: 'HTML' }
      ).catch(()=>{});
    } catch(e) {}
  });

  bot.action(/^join_(.+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery('ပွဲဝင်မည်...').catch(()=>{});
      const gameId = ctx.match[1];
      const userId = ctx.from.id;
      if (fakeGameIds.has(gameId)) {
        await ctx.reply(
          `🎮 ပွဲဝင်ရန် App ကိုဖွင့်ပြီး ကစားသူ ရှာပါ!`,
          Markup.inlineKeyboard([[Markup.button.webApp('🎮 ကစားမည်', FRONTEND_URL)]])
        ).catch(()=>{});
        deleteSearchMsgs(gameId);
        fakeGameIds.delete(gameId);
        return;
      }
      const joinUrl = `${FRONTEND_URL}/play.html?join=${gameId}`;
      await ctx.reply(
        `🎮 ပွဲသို့ ဝင်ရောက်ရန် ↓`,
        Markup.inlineKeyboard([[Markup.button.webApp('🎮 ဝင်ရောက်ကစားမည်', joinUrl)]])
      ).catch(()=>{});
    } catch(e) { console.error('join action err:', e); }
  });

  bot.action('dismiss', async (ctx) => {
    try { await ctx.answerCbQuery('ပယ်ဖျက်ပြီ').catch(()=>{}); } catch(e) {}
  });

  bot.command('agent', async (ctx) => {
    try {
      const id = ctx.from.id;
      const user = await User.findOne({ telegramId: id }).lean();
      if (!user) { await ctx.reply('ဦးစွာ /start နှိပ်ပါ').catch(()=>{}); return; }
      if (user.role !== 'agent') {
        await ctx.reply('🚫 သင်သည် အေးဂျင့် မဟုတ်သေးပါ\n\nAdmin ကို ဆက်သွယ်ပြီး Agent ခွင့်ပြုချက် ရယူပါ').catch(()=>{});
        return;
      }
      await ctx.reply(
        `🎯 <b>Agent Panel</b>\n\nမင်္ဂလာပါ Agent!\n\nသင်၏ Agent Dashboard သို့ ဝင်ရောက်ပါ ↓`,
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [Markup.button.webApp('🎯 Agent Panel သို့ဝင်ရန်', `${FRONTEND_URL}/agent.html`)]
          ])
        }
      ).catch(()=>{});
    } catch(e) { console.error('agent cmd err:', e.stack || e); }
  });

  // ===== /admin command — Admin Panel button (silent for non-admins) =====
  async function adminPanelHandler(ctx) {
    try {
      const id = ctx.from.id;
      console.log(`[/admin] from ${id} | isAdmin=${isAnyAdmin(id)} | ADMIN_ID=${ADMIN_ID} | EXTRA=[${EXTRA_ADMIN_IDS.join(',')}]`);
      if (!isAnyAdmin(id)) return; // not admin -> stay silent

      let base = (FRONTEND_URL || '').trim().replace(/\/+$/,'');
      if (!/^https:\/\//i.test(base)) base = 'https://' + base.replace(/^https?:\/\//i,'');
      const adminUrl = `${base}/admin.html`;

      const kb = /^https:\/\//i.test(adminUrl)
        ? Markup.inlineKeyboard([[Markup.button.webApp('🔓 Login To Admin Panel', adminUrl)]])
        : Markup.inlineKeyboard([[Markup.button.url('🔓 Login To Admin Panel', adminUrl)]]);

      await ctx.reply(
        `🔐 <b>Admin Panel</b>\n\nLogin To Admin Panel`,
        { parse_mode: 'HTML', ...kb }
      ).catch(async (e) => {
        console.error('/admin reply err:', e.message, e.response?.description || '');
        await ctx.reply(`🔐 Login To Admin Panel:\n${adminUrl}`).catch(()=>{});
      });
    } catch(e) { console.error('admin cmd err:', e.stack || e); }
  }
  bot.command('admin', adminPanelHandler);
  // Text fallback — catches "/admin" even if command parsing misses it
  bot.hears(/^\/?admin\b/i, adminPanelHandler);

  bot.catch((err, ctx) => {
    if (err.response && err.response.error_code === 403) {
      const uid = ctx?.from?.id;
      if (uid) blockedUsers.add(uid); // FIX: remember blocked users
      console.log(`User ${uid || 'unknown'} blocked the bot.`);
    } else {
      console.error('Bot global error:', err, ctx?.update);
    }
  });

  bot.launch().then(()=>{
    console.log('✅ Bot launched');
    bot.telegram.setMyCommands([
      { command:'start', description:'⚡ ကစားမည်' },
      { command:'agent', description:'🎯 Agent Panel' },
      { command:'admin', description:'🔐 Admin Panel' }
    ]).then(()=>console.log('✅ Commands registered')).catch(e=>console.error('setMyCommands err:',e.message));
    console.log(`🔐 ADMIN_ID=${ADMIN_ID} | EXTRA_ADMINS=[${EXTRA_ADMIN_IDS.join(',')}] | FRONTEND_URL=${FRONTEND_URL}`);
  }).catch(e=>console.error('Bot launch err:',e));
}

// ===== Notify Helpers =====
function obfuscateUsername(username) {
  if (!username) return '';
  if (username.length <= 3) return username;
  return username.substring(0, 3) + '...';
}

// FIX #4: shared sender that skips blocked users and records new blocks
async function sendOneBotMsg(userId, text, markup) {
  if (blockedUsers.has(userId)) return null;
  try {
    const msg = await bot.telegram.sendMessage(userId, text, { parse_mode:'HTML', reply_markup: markup });
    return { userId, msgId: msg.message_id };
  } catch(e) {
    const code = e?.response?.error_code;
    const desc = e?.response?.description || '';
    if (code === 403 || (code === 400 && desc.includes('chat not found'))) {
      blockedUsers.add(userId);
    }
    return null;
  }
}

async function notifyUsersGameSearch(searcherId, gameId, betAmount=500) {
  if (!bot) return;
  const { winPrize } = getBetPrizes(betAmount);
  try {
    const NOW = Date.now();
    const ACTIVE_24H = NOW - 24*60*60*1000;
    const [searcher, allUsers] = await Promise.all([
      User.findOne({ telegramId: searcherId }).select('firstName username').lean(),
      User.find({ telegramId: { $ne: searcherId }, isBanned: { $ne: true } }).select('telegramId lastActive').lean()
    ]);
    const displayName = searcher?.username
      ? obfuscateUsername(searcher.username)
      : (searcher?.firstName || 'တစ်ယောက်');
    const msgText = `⚡ <b>${displayName}</b> ပွဲရှာနေသည်!\n\n⏱ ${SEARCH_TIMEOUT_S} စက္ကန့်အတွင်း Join မနှိပ်ရင် ပွဲပျောက်မည်\n💰 ဝင်ကြေး: ${betAmount.toLocaleString()} MMK  •  🏆 ဆု: ${winPrize.toLocaleString()} MMK`;
    const replyMarkup = { inline_keyboard: [[
      { text:'🎮 ကစားမည်', callback_data:`join_${gameId}` },
      { text:'❌ မကစားဘူး', callback_data:'dismiss' }
    ]]};

    // Tier 1: Online (socket connected) — immediate parallel
    const tier1 = allUsers.filter(u => userSockets.has(u.telegramId));
    // Tier 2: Active in last 24h, not online
    const tier2 = allUsers
      .filter(u => !userSockets.has(u.telegramId) && u.lastActive && new Date(u.lastActive).getTime() >= ACTIVE_24H)
      .sort((a,b) => new Date(b.lastActive).getTime() - new Date(a.lastActive).getTime());
    // Tier 3: Inactive > 24h
    const tier3 = allUsers
      .filter(u => !userSockets.has(u.telegramId) && (!u.lastActive || new Date(u.lastActive).getTime() < ACTIVE_24H))
      .sort((a,b) => new Date(b.lastActive||0).getTime() - new Date(a.lastActive||0).getTime());

    const sent = [];
    // Tier 1 — immediate
    const t1 = await Promise.allSettled(tier1.map(u => sendOneBotMsg(u.telegramId, msgText, replyMarkup)));
    t1.forEach(r => { if (r.status === 'fulfilled' && r.value) sent.push(r.value); });

    // Tier 2 & 3 — background
    setImmediate(async () => {
      const CHUNK2 = 50;
      for (let i = 0; i < tier2.length; i += CHUNK2) {
        if (!waitingQueue.find(w => w.gameId === gameId)) return;
        const batch = tier2.slice(i, i + CHUNK2);
        const r = await Promise.allSettled(batch.map(u => sendOneBotMsg(u.telegramId, msgText, replyMarkup)));
        r.forEach(x => { if (x.status === 'fulfilled' && x.value) sent.push(x.value); });
        if (i + CHUNK2 < tier2.length) await new Promise(r => setTimeout(r, 100));
      }
      const CHUNK3 = 25;
      for (let i = 0; i < tier3.length; i += CHUNK3) {
        if (!waitingQueue.find(w => w.gameId === gameId)) return;
        const batch = tier3.slice(i, i + CHUNK3);
        const r = await Promise.allSettled(batch.map(u => sendOneBotMsg(u.telegramId, msgText, replyMarkup)));
        r.forEach(x => { if (x.status === 'fulfilled' && x.value) sent.push(x.value); });
        if (i + CHUNK3 < tier3.length) await new Promise(r => setTimeout(r, 300));
      }
    });
    searchNotifications.set(gameId, sent);
  } catch(e){ console.error('notify err:', e.stack || e); }
}

async function deleteSearchMsgs(gameId) {
  if (!bot) return;
  const msgs = searchNotifications.get(gameId);
  if (!msgs) return;
  searchNotifications.delete(gameId);
  for (const {userId, msgId} of msgs) {
    try { await bot.telegram.deleteMessage(userId, msgId); await new Promise(r=>setTimeout(r,30)); } catch(e){}
  }
}

// ===== Fake Search Notifications (kept, AI removed) =====
async function sendFakeSearchNotification() {
  if (!bot) return;
  const fakeEnabled = await getSetting('fakeNotifications', false);
  if (!fakeEnabled) return;

  const fakeGameId = genGameId();
  fakeGameIds.add(fakeGameId);

  // FIX #2: Use randomFakeName() instead of randomAIName()
  const fakeName = randomFakeName();
  const displayName = obfuscateUsername(fakeName);
  const fakeBet = VALID_BETS[Math.floor(Math.random() * VALID_BETS.length)];
  const { winPrize: fakeWin } = getBetPrizes(fakeBet);

  const allFakeUsers = await User.find({ isBanned: { $ne: true } }).select('telegramId lastActive').lean();
  const fakeOnline  = allFakeUsers.filter(u => userSockets.has(u.telegramId));
  const fakeOffline = allFakeUsers
    .filter(u => !userSockets.has(u.telegramId))
    .sort((a, b) => (b.lastActive||0) - (a.lastActive||0));
  const users = [...fakeOnline, ...fakeOffline];
  const sent = [];
  const CHUNK = 30;
  const fakeMsgText = `⚡ <b>${displayName}</b> ပွဲရှာနေသည်!\n\n⏱ ${SEARCH_TIMEOUT_S} စက္ကန့်အတွင်း Join မနှိပ်ရင် ပွဲပျောက်မည်\n💰 ဝင်ကြေး: ${fakeBet.toLocaleString()} MMK  •  🏆 ဆု: ${fakeWin.toLocaleString()} MMK`;
  for (let i = 0; i < users.length; i += CHUNK) {
    const batch = users.slice(i, i + CHUNK);
    const r = await Promise.allSettled(batch.map(u => sendOneBotMsg(u.telegramId, fakeMsgText, { inline_keyboard: [[
      { text:'🎮 ကစားမည်', callback_data:`join_${fakeGameId}` },
      { text:'❌ မကစားဘူး', callback_data:'dismiss' }
    ]]})));
    r.forEach(x => { if (x.status === 'fulfilled' && x.value) sent.push(x.value); });
    if (i + CHUNK < users.length) await new Promise(r => setTimeout(r, 100));
  }
  searchNotifications.set(fakeGameId, sent);
  console.log(`📢 Fake notification sent (${sent.length} users) gameId: ${fakeGameId}`);
  // Auto-delete after 1 hour if not clicked
  setTimeout(() => deleteSearchMsgs(fakeGameId), 3600000);
}

// ===== FIX #6: Zombie Game Cleanup (every 5 minutes) =====
setInterval(async () => {
  const now = Date.now();
  const IDLE_LIMIT_MS = 2 * 60 * 1000;
  for (const [gameId, game] of activeGames.entries()) {
    if (game.status !== 'active') continue;
    const lastMove = game.lastMoveAt || game.startedAt || 0;
    if (now - lastMove < IDLE_LIMIT_MS) continue;
    console.log(`🧹 Zombie cleanup: ${gameId} (idle ${Math.round((now-lastMove)/1000)}s)`);
    try {
      // FIX #2: All games are PvP now — no AI branch needed
      const betAmt = game.betAmount || 500;
      clearTurnTimer(gameId);
      // Refund both players
      for (const pid of (game.players || [])) {
        const refAmt = getBetPrizes(betAmt).entryFee;
        await User.findOneAndUpdate({telegramId:pid},{$inc:{balance:refAmt}}).catch(()=>{});
      }
      io.to(gameId).emit('gameOver', {
        winner: -1, reason: 'timeout', board: game.board,
        betAmount: betAmt,
        drawRefund: getBetPrizes(betAmt).drawRefund
      });
      activeGames.delete(gameId);
      for (const pid of (game.players || [])) {
        const t = searchTimeouts.get(pid); if (t) { clearTimeout(t); searchTimeouts.delete(pid); }
        moveCooldowns.delete(pid);
        findGameCooldowns.delete(pid);
        processingUsers.delete(pid);
      }
      setTimeout(()=>deleteSearchMsgs(gameId),500);
    } catch(e) { console.error('Zombie cleanup err:', e); }
  }
}, 5 * 60 * 1000);

// ===== Dynamic Fake Notification Scheduler =====
let fakeNotifTimer = null;
async function scheduleFakeNotification() {
  if (fakeNotifTimer) { clearTimeout(fakeNotifTimer); fakeNotifTimer = null; }
  const intervalMins = await getSetting('fakeNotifInterval', 3);
  const delay = Math.max(1, Number(intervalMins)) * 60 * 1000;
  fakeNotifTimer = setTimeout(async () => {
    await sendFakeSearchNotification();
    scheduleFakeNotification();
  }, delay);
}
scheduleFakeNotification();

// ===== Core Game Functions =====
function clearTurnTimer(gameId) {
  const t = gameTurnTimeouts.get(gameId);
  if (t) { clearTimeout(t); gameTurnTimeouts.delete(gameId); }
}

// FIX #1: Robust endGame — accepts 'active' or 'ending', sets 'completed' synchronously first
async function endGame(gameId, winner, reason='normal') {
  const game = activeGames.get(gameId);
  if (!game || (game.status !== 'active' && game.status !== 'ending')) return;

  // ── Claim the game result synchronously to prevent double-end ──
  clearTurnTimer(gameId);
  game.status = 'completed';

  const winnerId = winner === -1 ? -1 : Number(winner);
  const betAmt = game.betAmount || 500;
  const { winPrize, drawRefund } = getBetPrizes(betAmt);

  console.log(`[endGame] gameId=${gameId} | winner=${winnerId} | reason=${reason}`);

  try {
    if (winnerId === -1) {
      // Draw
      for (const pid of game.players) {
        await User.findOneAndUpdate(
          { telegramId: pid },
          { $inc: { balance: drawRefund, totalGames: 1 } }
        );
        distribute3LevelCommission(pid).catch(()=>{});
      }
    } else if (winnerId) {
      const loser = game.players.find(p => Number(p) !== winnerId);
      // Winner
      await User.findOneAndUpdate(
        { telegramId: winnerId },
        { $inc: { balance: winPrize, wins: 1, totalGames: 1, turnoverProgress: betAmt },
          $set: { consecutiveLosses: 0 } }
      );
      // Loser
      if (loser) {
        await User.findOneAndUpdate(
          { telegramId: loser },
          { $inc: { losses: 1, totalGames: 1, consecutiveLosses: 1, turnoverProgress: betAmt } }
        );
        await checkRescueBonus(loser);
      }
      distribute3LevelCommission(winnerId).catch(()=>{});
      if (loser) distribute3LevelCommission(loser).catch(()=>{});
    }
    await Game.findOneAndUpdate({gameId},{
      winner: winnerId, status:'completed', board: game.board,
      playerNames: game.playerNames,
      winnerName: winnerId===-1 ? 'draw' : (game.playerNames?.[winnerId] || String(winnerId))
    },{upsert:true});
  } catch(e){ console.error('endGame DB err:', e.stack || e); }

  // Emit result to all players in the room
  io.to(gameId).emit('gameOver', {
    winner: winnerId, reason, board: game.board,
    betAmount: betAmt,
    winPrize: getBetPrizes(betAmt).winPrize,
    drawRefund: getBetPrizes(betAmt).drawRefund
  });

  // Full memory cleanup
  activeGames.delete(gameId);
  clearTurnTimer(gameId);
  for (const pid of (game.players || [])) {
    const t = searchTimeouts.get(pid);
    if (t) { clearTimeout(t); searchTimeouts.delete(pid); }
    moveCooldowns.delete(pid);
    findGameCooldowns.delete(pid);
    processingUsers.delete(pid);
  }
  setTimeout(()=>deleteSearchMsgs(gameId),500);
}

// ===== Socket.io =====
io.on('connection', (socket) => {
  let myUserId = null;
  let myGameId = null;

  // ── findGame ──
  socket.on('findGame', async ({userId, betAmount}) => {
    if (!userId) return socket.emit('error',{msg:'userId မပါ'});
    myUserId = parseInt(userId);
    const selectedBet = VALID_BETS.includes(parseInt(betAmount)) ? parseInt(betAmount) : 500;
    const { entryFee } = getBetPrizes(selectedBet);

    // FIX #6: findGame cooldown
    const lastFG = findGameCooldowns.get(myUserId) || 0;
    if (Date.now() - lastFG < FINDGAME_COOLDOWN_MS) {
      return socket.emit('error',{msg:'နည်းနည်းစောင့်ပါ...'});
    }
    findGameCooldowns.set(myUserId, Date.now());

    // FIX #4 + #6: processingUsers lock
    if (processingUsers.has(myUserId)) {
      return socket.emit('error',{msg:'ရှာဖွေနေဆဲ ဖြစ်သည်'});
    }
    processingUsers.add(myUserId);

    try {
      userSockets.set(myUserId, socket.id);

      // Check if already in an active game — reconnect
      const existEntry = [...activeGames.entries()].find(([,g])=>g.players.includes(myUserId));
      if (existEntry) {
        const [gid, game] = existEntry;
        myGameId = gid;
        socket.join(gid);
        socket.emit('gameResumed',{
          gameId: gid, board: game.board,
          mySymbol: game.symbols[myUserId] || game.symbols[String(myUserId)],
          currentTurn: game.currentTurn, players: game.playerNames
        });
        return;
      }

      const user = await User.findOne({telegramId:myUserId}).lean();
      if (!user) return socket.emit('error',{msg:'User မတွေ့ပါ'});
      if (user.isBanned===true) return socket.emit('error',{msg:'ကောင်ပိတ်ဆို့ထားသည်'});
      if (user.balance < entryFee) {
        return socket.emit('insufficientBalance',{balance:user.balance,required:entryFee});
      }

      User.findOneAndUpdate({telegramId:myUserId},{lastActive:new Date()}).catch(()=>{});

      // FIX #4: Simple maintenance check
      const maint = await getSetting('maintenance', false);
      if (maint) return socket.emit('error',{msg:'🔧 ဆာဗာ ပြင်ဆင်နေပါသည်'});

      // FIX #2: No allBotMode or botMode routing — straight to PvP matchmaking
      const joinGameId = socket.handshake.query?.join;

      // Fake notification join — just delete the fake notification and do normal matchmaking
      if (joinGameId && fakeGameIds.has(joinGameId)) {
        deleteSearchMsgs(joinGameId);
        fakeGameIds.delete(joinGameId);
      }

      // Normal PvP matchmaking — match by betAmount
      let waiterIdx = -1;
      if (joinGameId && !fakeGameIds.has(joinGameId)) {
        waiterIdx = waitingQueue.findIndex(w => w.gameId === joinGameId && w.userId !== myUserId);
      }
      if (waiterIdx === -1) {
        waiterIdx = waitingQueue.findIndex(w => w.userId !== myUserId && w.betAmount === selectedBet);
      }

      if (waiterIdx !== -1) {
        const waiter = waitingQueue.splice(waiterIdx,1)[0];
        myGameId = waiter.gameId;
        const matchedBet = waiter.betAmount || selectedBet;
        const matchedFee = getBetPrizes(matchedBet).entryFee;

        const wTimeout = searchTimeouts.get(myUserId);
        if (wTimeout) { clearTimeout(wTimeout); searchTimeouts.delete(myUserId); }

        // FIX #5: Deduct both balances atomically
        try {
          const [w1, w2] = await Promise.all([
            User.findOneAndUpdate({telegramId:waiter.userId,balance:{$gte:matchedFee}},{$inc:{balance:-matchedFee}},{new:true}),
            User.findOneAndUpdate({telegramId:myUserId,balance:{$gte:matchedFee}},{$inc:{balance:-matchedFee}},{new:true})
          ]);
          if (!w1 || !w2) {
            await Promise.all([
              w1 ? User.findOneAndUpdate({telegramId:waiter.userId},{$inc:{balance:matchedFee}}) : Promise.resolve(),
              w2 ? User.findOneAndUpdate({telegramId:myUserId},{$inc:{balance:matchedFee}}) : Promise.resolve()
            ]);
            if (!w1) {
              const waiterSockId = userSockets.get(waiter.userId);
              const waiterSock = waiterSockId ? io.sockets.sockets.get(waiterSockId) : null;
              const wUser = await User.findOne({telegramId:waiter.userId}).select('balance').lean();
              if (waiterSock) waiterSock.emit('insufficientBalance', {balance: wUser?.balance||0, required: matchedFee});
            } else {
              waitingQueue.push(waiter);
            }
            if (!w2) {
              const jUser = await User.findOne({telegramId:myUserId}).select('balance').lean();
              return socket.emit('insufficientBalance', {balance: jUser?.balance||0, required: matchedFee});
            }
            return;
          }
        } catch(e) {
          waitingQueue.push(waiter);
          return socket.emit('error',{msg:'ငွေ ဆုတ်ယူ မအောင်မြင်ပါ'});
        }

        const waiterUser = await User.findOne({telegramId:waiter.userId}).lean();
        const joinerUser = user;

        // Assign symbols randomly
        const symbols = {};
        if (Math.random() > 0.5) { symbols[waiter.userId]='X'; symbols[myUserId]='O'; }
        else { symbols[waiter.userId]='O'; symbols[myUserId]='X'; }
        const firstTurn = parseInt(Object.entries(symbols).find(([,v])=>v==='X')[0]);

        const gameState = {
          gameId: myGameId,
          players: [waiter.userId, myUserId],
          symbols,
          board: Array(BOARD_SIZE).fill(null).map(()=>Array(BOARD_SIZE).fill('')),
          currentTurn: firstTurn,
          status: 'active',
          betAmount: matchedBet,
          startedAt: Date.now(),
          lastMoveAt: Date.now(),
          playerNames: {
            [waiter.userId]: waiterUser?.firstName||waiterUser?.username||`User${waiter.userId}`,
            [myUserId]: joinerUser?.firstName||joinerUser?.username||`User${myUserId}`
          }
        };
        activeGames.set(myGameId, gameState);

        new Game({
          gameId: myGameId,
          players: gameState.players,
          symbols: gameState.symbols,
          status: 'active',
          playerNames: gameState.playerNames
        }).save().catch(e=>console.error('Game save:',e));

        socket.join(myGameId);
        const waiterSocket = io.sockets.sockets.get(waiter.socketId);
        if (waiterSocket) waiterSocket.join(myGameId);

        const base = {
          gameId: myGameId, board: gameState.board,
          currentTurn: firstTurn, players: gameState.playerNames,
          betAmount: matchedBet
        };
        socket.emit('gameStarted',{...base, mySymbol: symbols[myUserId]});
        if (waiterSocket) waiterSocket.emit('gameStarted',{...base, mySymbol: symbols[waiter.userId]});

        await deleteSearchMsgs(myGameId);

        // FIX #6: Set timer only once, with guard
        const t = setTimeout(() => handleTurnTimeout(myGameId, firstTurn), TURN_SECONDS*1000+1500);
        gameTurnTimeouts.set(myGameId, t);

      } else {
        // Enter waiting queue
        const gameId = genGameId();
        myGameId = gameId;
        socket.join(gameId);
        waitingQueue.push({socketId:socket.id, userId:myUserId, gameId, betAmount:selectedBet});
        socket.emit('waitingForPlayer',{gameId, searchTimeout:SEARCH_TIMEOUT_S, betAmount:selectedBet});
        notifyUsersGameSearch(myUserId, gameId, selectedBet);

        // FIX #4: Search timeout notification
        const timeout = setTimeout(() => {
          if (socket.connected) {
            socket.emit('searchUpdate', { message: 'လက်ရှိဆော့ကစားနေသူမရှိသေးပါ ဆက်လက်ရှာဖွေဖို့' });
          }
        }, SEARCH_TIMEOUT_S * 1000);
        searchTimeouts.set(myUserId, timeout);
      }
    } catch(e) {
      console.error('findGame err:', e);
      // FIX #4: Always emit error so frontend can reset state
      socket.emit('searchFailed', {msg:'ဆာဗာ error ဖြစ်သည်၊ ထပ်ကြိုးစားပါ'});
    } finally {
      // FIX #4: Always release processingUsers lock
      processingUsers.delete(myUserId);
    }
  });

  // ── cancelSearch ──
  socket.on('cancelSearch', async ({userId}) => {
    const uid = parseInt(userId || myUserId);
    const idx = waitingQueue.findIndex(w => w.userId === uid);
    if (idx !== -1) {
      const {gameId} = waitingQueue[idx];
      waitingQueue.splice(idx, 1);
      await deleteSearchMsgs(gameId);
    }
    const timeout = searchTimeouts.get(uid);
    if (timeout) { clearTimeout(timeout); searchTimeouts.delete(uid); }
    socket.emit('searchCancelled');
  });

  // ── makeMove ──
  socket.on('makeMove', async ({gameId, row, col}) => {
    // FIX #6: Move cooldown — prevent spam clicking
    const lastMove = moveCooldowns.get(myUserId) || 0;
    if (Date.now() - lastMove < MOVE_COOLDOWN_MS) return;
    moveCooldowns.set(myUserId, Date.now());

    try {
      const game = activeGames.get(gameId);
      // FIX #1: Basic guards — must be active and it must be this player's turn
      if (!game || game.status !== 'active') return;
      if (Number(game.currentTurn) !== Number(myUserId)) {
        return socket.emit('error',{msg:'သင့်လှည့် မဟုတ်ပါ'});
      }
      if (row < 0 || row > 4 || col < 0 || col > 4) {
        return socket.emit('error',{msg:'Invalid move'});
      }
      if (game.board[row][col] !== '') {
        return socket.emit('error',{msg:'ထိုနေရာ ယူပြီးသား'});
      }

      // FIX #1: Resolve symbol safely
      const sym = game.symbols[myUserId] || game.symbols[String(myUserId)];
      if (!sym) return socket.emit('error',{msg:'Symbol မတွေ့ပါ — ဂိမ်းပြန်ဝင်ပါ'});

      // ── FIX #1 KEY: Lock game status to 'ending' IMMEDIATELY after validation ──
      // This prevents any timer callback (handleTurnTimeout) from interfering
      // because they check game.status === 'active'. By setting 'ending' here
      // synchronously, we guarantee no race condition even if a queued timer
      // callback fires between now and the next await.
      game.status = 'ending';
      clearTurnTimer(gameId); // Cancel any pending turn timer

      // Apply move
      game.board[row][col] = sym;
      game.lastMoveAt = Date.now();

      const didWin  = checkWin(game.board, sym);
      const isDraw  = !didWin && boardFull(game.board);
      const gameEnds = didWin || isDraw;
      const nextPlayer = gameEnds ? null : game.players.find(p => Number(p) !== Number(myUserId));

      // FIX #5: Emit moveMade with complete state to both players
      io.to(gameId).emit('moveMade', {
        row, col,
        symbol: sym,
        playerId: myUserId,
        board: game.board.map(r => [...r]),
        currentTurn: nextPlayer,
        gameEnded: gameEnds
      });

      if (didWin) {
        // game.status is already 'ending' — endGame will see it
        await endGame(gameId, myUserId, 'win');
      } else if (isDraw) {
        await endGame(gameId, -1, 'draw');
      } else {
        // Game continues — restore active status, update turn, set new timer
        game.status = 'active';
        game.currentTurn = nextPlayer;
        io.to(gameId).emit('turnChanged', {currentTurn: nextPlayer});

        // FIX #6: Single timer per game — gameTurnTimeouts already cleared above
        const t = setTimeout(() => handleTurnTimeout(gameId, nextPlayer), TURN_SECONDS*1000+1500);
        gameTurnTimeouts.set(gameId, t);
      }
    } catch(e) {
      console.error('makeMove err:', e);
      socket.emit('error',{msg:'Move error ဖြစ်သည်'});
    }
  });

  // ── disconnect ──
  socket.on('disconnect', async () => {
    // Remove from waiting queue if searching
    const wIdx = waitingQueue.findIndex(w => w.socketId === socket.id);
    if (wIdx !== -1) {
      const {gameId, userId} = waitingQueue[wIdx];
      waitingQueue.splice(wIdx, 1);
      await deleteSearchMsgs(gameId);
      const timeout = searchTimeouts.get(userId);
      if (timeout) { clearTimeout(timeout); searchTimeouts.delete(userId); }
    }

    const disconnectedUserId = myUserId;
    const disconnectedGameId = myGameId;

    if (disconnectedUserId) {
      userSockets.delete(disconnectedUserId);
      processingUsers.delete(disconnectedUserId);
      moveCooldowns.delete(disconnectedUserId);
      findGameCooldowns.delete(disconnectedUserId);
    }

    if (disconnectedGameId && activeGames.has(disconnectedGameId)) {
      const gameNow = activeGames.get(disconnectedGameId);

      // FIX #3: Immediately notify the OPPONENT about disconnect with 10s countdown
      if (gameNow && gameNow.status === 'active') {
        const oppId = gameNow.players.find(p => Number(p) !== Number(disconnectedUserId));
        if (oppId) {
          const oppSockId = userSockets.get(oppId);
          const oppSock = oppSockId ? io.sockets.sockets.get(oppSockId) : null;
          if (oppSock) {
            oppSock.emit('opponentDisconnectedDelay', {
              message: 'ကစားသူ လိုင်းကျသွားပါသည်၊ ပြန်လည်ချိတ်ဆက်ရန် 10 စက္ကန့် စောင့်ဆိုင်းနေပါသည်...',
              seconds: DISCONNECT_GRACE_S
            });
          }
        }
      }

      // FIX #3: 10-second grace period before declaring loss
      setTimeout(async () => {
        // Check if player reconnected
        const reconnected = disconnectedUserId && userSockets.has(disconnectedUserId);

        if (reconnected) {
          console.log(`[Disconnect] User ${disconnectedUserId} reconnected within grace period`);
          // Notify opponent that the player came back
          const game = activeGames.get(disconnectedGameId);
          if (game && game.status === 'active') {
            const oppId = game.players.find(p => Number(p) !== Number(disconnectedUserId));
            if (oppId) {
              const oppSockId = userSockets.get(oppId);
              const oppSock = oppSockId ? io.sockets.sockets.get(oppSockId) : null;
              if (oppSock) {
                oppSock.emit('opponentReconnected', {
                  message: 'ကစားသူ ပြန်လည်ချိတ်ဆက်ပြီ ✅'
                });
              }
            }
          }
          return;
        }

        const game = activeGames.get(disconnectedGameId);
        if (!game || game.status !== 'active') return;

        console.log(`[Disconnect] User ${disconnectedUserId} did not reconnect — ending game ${disconnectedGameId}`);
        const opp = game.players.find(p => Number(p) !== Number(disconnectedUserId));
        if (opp) await endGame(disconnectedGameId, opp, 'disconnect');
      }, DISCONNECT_GRACE_S * 1000);
    }
  });

  // ── In-game emote ──
  socket.on('sendEmote', ({ gameId, emote }) => {
    try {
      if (!gameId || !emote || !myUserId) return;
      const game = activeGames.get(gameId);
      if (!game || game.status !== 'active') return;
      if (!game.players.includes(myUserId)) return;
      io.to(gameId).emit('emoteReceived', { senderId: myUserId, emote });
    } catch(e) { console.error('emote err:', e); }
  });

  // ── handleTurnTimeout (inner function — closes over socket scope) ──
  async function handleTurnTimeout(gameId, playerId) {
    const game = activeGames.get(gameId);
    // FIX #1: Guard — only fire for active games
    if (!game || game.status !== 'active') return;

    const timedOutId = Number(playerId);
    const currentTurnId = Number(game.currentTurn);

    // FIX #1: Stale timer check — the player whose turn it is must match
    if (currentTurnId !== timedOutId) {
      console.log(`[Timeout] Stale timer ignored: currentTurn=${currentTurnId}, timedOut=${timedOutId}`);
      return;
    }

    const winner = game.players.find(p => Number(p) !== timedOutId);
    if (!winner) {
      console.log(`[Timeout] No opponent found for game ${gameId}`);
      return;
    }

    // FIX #1: Mark 'ending' SYNCHRONOUSLY before any await
    // This is the same pattern used in makeMove — prevents double-end race condition
    game.status = 'ending';
    clearTurnTimer(gameId);

    console.log(`[Timeout] gameId=${gameId} | timedOut=${timedOutId} loses | winner=${winner}`);
    await endGame(gameId, winner, 'timeout');
  }
}); // end io.on('connection')

// ===== Admin Middleware =====
function isAdmin(req,res,next) {
  const aid = parseInt(req.headers['x-admin-id']||req.query.adminId);
  if (!aid||!isAnyAdmin(aid)) return res.status(403).json({error:'Forbidden'});
  next();
}

// ===== REST Routes =====
app.get('/', (_,res) => res.json({ok:true}));
app.get('/health', (_,res) => res.json({
  ok:true, mongodb:isConnected?'connected':'disconnected',
  activeGames:activeGames.size, queue:waitingQueue.length
}));

app.get('/api/queue-info/:gameId', async(req,res) => {
  const entry = waitingQueue.find(w => w.gameId === req.params.gameId);
  if (!entry) return res.status(404).json({error:'Not found'});
  res.json({ betAmount: entry.betAmount || 500 });
});

app.post('/api/auth', async(req,res) => {
  try {
    const {initData,telegramId:devId} = req.body;
    let tid, username, firstName;
    if (initData) {
      const u = verifyTgAuth(initData);
      if (!u) return res.status(401).json({error:'Telegram auth မှား'});
      tid=u.id; username=u.username||''; firstName=u.first_name||'';
    } else if (devId) {
      tid=parseInt(devId); username=''; firstName='User';
    } else return res.status(401).json({error:'Auth required'});

    const maint = await getSetting('maintenance', false);
    if (maint && !isAnyAdmin(tid)) return res.status(503).json({error:'🔧 ဆာဗာ ပြင်ဆင်နေပါသည်'});

    let user = await User.findOne({telegramId:tid});
    if (!user) {
      user = new User({telegramId:tid, username, firstName, referralCode:genRefCode(tid)});
      await user.save();
    } else {
      let d = false;
      if (username && user.username !== username){ user.username=username; d=true; }
      if (firstName && user.firstName !== firstName){ user.firstName=firstName; d=true; }
      if (d) await user.save();
    }
    if (user.isBanned) return res.status(403).json({error:'🚫 ကောင်ပိတ်ဆို့ထားပါသည်'});

    // FIX #2: Removed botMode from response
    res.json({
      telegramId: user.telegramId,
      username: user.username||user.firstName||`User${user.telegramId}`,
      firstName: user.firstName,
      balance: user.balance,
      referralCode: user.referralCode,
      totalGames: user.totalGames,
      wins: user.wins,
      losses: user.losses,
      turnoverTarget: user.turnoverTarget||0,
      turnoverProgress: user.turnoverProgress||0,
      consecutiveLosses: user.consecutiveLosses||0
    });
  } catch(e){ console.error(e); res.status(500).json({error:'Server error'}); }
});

// FIX #2: Removed botMode from select
app.get('/api/user/:id', async(req,res) => {
  try {
    const u = await User.findOne({telegramId:parseInt(req.params.id)})
      .select('balance totalGames wins losses turnoverTarget turnoverProgress consecutiveLosses firstName username').lean();
    if (!u) return res.status(404).json({error:'Not found'});
    res.json(u);
  } catch(e){ res.status(500).json({error:'Server error'}); }
});

app.post('/api/deposit', async(req,res) => {
  try {
    const {telegramId,kpayName,transactionId,amount,paymentMethod} = req.body;
    if (!telegramId||!kpayName||!transactionId||!amount)
      return res.status(400).json({error:'ကွင်းလပ်များ ဖြည့်ပေးပါ'});
    if (parseInt(amount) < 500)
      return res.status(400).json({error:'အနည်းဆုံး 500 MMK'});
    const u = await User.findOne({telegramId:parseInt(telegramId)}).lean();
    if (!u) return res.status(404).json({error:'User not found'});
    if (u.isBanned) return res.status(403).json({error:'ကောင်ပိတ်ဆို့ထားသည်'});
    const dup = await Deposit.findOne({transactionId}).lean();
    if (dup) return res.status(400).json({error:'Transaction ID ကို အသုံးပြုပြီးသည်'});
    const method = (paymentMethod === 'wave') ? 'wave' : 'kpay';
    const methodLabel = method === 'wave' ? '🌊 Wave Pay' : '📱 KPay';
    const dep = await new Deposit({userId:u.telegramId,kpayName,transactionId,amount:parseInt(amount),paymentMethod:method}).save();
    if (bot) bot.telegram.sendMessage(ADMIN_ID,
      `💰 *ငွေသွင်း တောင်းဆိုမှု*\n👤 ${u.firstName||u.username} (${u.telegramId})\n💵 ${parseInt(amount).toLocaleString()} ကျပ်\n${methodLabel} ဖြင့် သွင်းထားသည်\n📝 ${kpayName}\n🔢 \`${transactionId}\``,
      {parse_mode:'Markdown'}).catch(()=>{});
    res.json({success:true, depositId:dep._id});
  } catch(e){ console.error(e); res.status(500).json({error:'Server error'}); }
});

app.post('/api/withdraw', async(req,res) => {
  try {
    const {telegramId,kpayName,kpayNumber,amount,paymentMethod} = req.body;
    if (!telegramId||!kpayName||!kpayNumber||!amount)
      return res.status(400).json({error:'ကွင်းလပ်များ ဖြည့်ပေးပါ'});
    const amt = parseInt(amount);
    if (isNaN(amt)||amt<2500)
      return res.status(400).json({error:'အနည်းဆုံး 2,500 MMK'});
    const tid = parseInt(telegramId);
    const chk = await User.findOne({telegramId:tid}).select('balance isBanned firstName username turnoverTarget turnoverProgress').lean();
    if (!chk) return res.status(404).json({error:'User မတွေ့ပါ'});
    if (chk.isBanned===true) return res.status(403).json({error:'🚫 ကောင်ပိတ်ဆို့ထားသည်'});
    if (chk.balance<amt) return res.status(400).json({error:`လက်ကျန်ငွေ မလုံလောက်ပါ (ကျန်: ${chk.balance.toLocaleString()} MMK)`});
    const remaining = (chk.turnoverTarget||0) - (chk.turnoverProgress||0);
    if (remaining > 0) {
      return res.status(400).json({error:`Bonus Turnover မပြည့်သေးပါ 🎮\nကျန်လောင်းရန်: ${remaining.toLocaleString()} MMK ဖိုး ကစားမှ ငွေထုတ်ခွင့်ပြုမည်`});
    }
    const method = (paymentMethod === 'wave') ? 'wave' : 'kpay';
    const methodLabel = method === 'wave' ? '🌊 Wave Pay' : '📱 KPay';
    let wd;
    try {
      wd = await new Withdrawal({userId:tid,kpayName,kpayNumber,amount:amt,paymentMethod:method}).save();
    } catch(saveErr) {
      return res.status(500).json({error:'Record သိမ်းမရပါ၊ ထပ်ကြိုးစားပါ'});
    }
    const u = await User.findOneAndUpdate(
      {telegramId:tid, balance:{$gte:amt}, isBanned:{$ne:true}},
      {$inc:{balance:-amt}},
      {new:true}
    );
    if (!u) {
      await Withdrawal.findByIdAndDelete(wd._id).catch(()=>{});
      const rechk = await User.findOne({telegramId:tid}).select('balance isBanned').lean();
      if (rechk?.isBanned===true) return res.status(403).json({error:'🚫 ကောင်ပိတ်ဆို့ထားသည်'});
      return res.status(400).json({error:`လက်ကျန်ငွေ မလုံလောက်ပါ (ကျန်: ${(rechk?.balance||0).toLocaleString()} MMK)`});
    }
    if (bot) bot.telegram.sendMessage(ADMIN_ID,
      `💸 *ငွေထုတ် တောင်းဆိုမှု*\n👤 ${u.firstName||u.username} (${u.telegramId})\n💵 ${amt.toLocaleString()} ကျပ်\n${methodLabel} ဖြင့် ထုတ်မည်\n📝 ${kpayName}\n📱 ${kpayNumber}\n🏦 ကျန်: ${u.balance.toLocaleString()} ကျပ်`,
      {parse_mode:'Markdown'}).catch(()=>{});
    res.json({success:true, withdrawalId:wd._id, newBalance:u.balance});
  } catch(e){ console.error('withdraw err:',e); res.status(500).json({error:'Server error'}); }
});

app.get('/api/referrals/:telegramId', async(req,res) => {
  try {
    const tid = parseInt(req.params.telegramId);
    if (isNaN(tid)) return res.status(400).json({error:'Invalid ID'});
    const referrals = await User.find({ referredBy: tid })
      .select('firstName username balance createdAt')
      .sort({ createdAt: -1 })
      .lean();
    res.json({
      total: referrals.length,
      referrals: referrals.map(u => ({
        name: u.firstName || u.username || `User${u.telegramId}`,
        username: u.username || '',
        balance: u.balance || 0,
        joinedAt: u.createdAt
      }))
    });
  } catch(e) { res.status(500).json({error:e.message}); }
});

// ===== Admin Routes =====
app.post('/api/admin/verify', async(req,res) => {
  try {
    const {telegramId} = req.body;
    if (!telegramId) return res.status(400).json({error:'telegramId required'});
    const tid = parseInt(telegramId);
    if (!isAnyAdmin(tid)) return res.status(403).json({error:'Admin မဟုတ်ပါ'});
    res.json({ok:true, adminId:tid});
  } catch(e){ res.status(500).json({error:'Server error'}); }
});

// FIX #2: Removed allBotMode from settings response
app.get('/api/admin/settings', isAdmin, async(_,res) => {
  const maint = await getSetting('maintenance', false);
  const fakeNotifications = await getSetting('fakeNotifications', false);
  const fakeNotifInterval = await getSetting('fakeNotifInterval', 3);
  res.json({
    maintenance: maint,
    fakeNotifications,
    fakeNotifInterval,
    entryFee: ENTRY_FEE,
    winPrize: WIN_PRIZE,
    drawRefund: DRAW_REFUND,
    turnSeconds: TURN_SECONDS
  });
});

app.get('/api/admin/stats', isAdmin, async(_,res) => {
  try {
    const [tu,tg,pd,pw] = await Promise.all([
      User.countDocuments(),
      Game.countDocuments({status:'completed'}),
      Deposit.countDocuments({status:'pending'}),
      Withdrawal.countDocuments({status:'pending'})
    ]);
    const [depAgg,wdAgg] = await Promise.all([
      Deposit.aggregate([{$match:{status:'confirmed'}},{$group:{_id:null,t:{$sum:'$amount'}}}]),
      Withdrawal.aggregate([{$match:{status:'confirmed'}},{$group:{_id:null,t:{$sum:'$amount'}}}])
    ]);
    res.json({
      totalUsers:tu, totalGames:tg, pendingDeposits:pd, pendingWithdrawals:pw,
      activeGames:activeGames.size, queueLength:waitingQueue.length,
      totalDeposited:depAgg[0]?.t||0, totalWithdrawn:wdAgg[0]?.t||0
    });
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.post('/api/admin/maintenance', isAdmin, async(req,res) => {
  await setSetting('maintenance', !!req.body.enabled);
  res.json({success:true, maintenance:!!req.body.enabled});
});

// FIX #2: Removed /api/admin/allbotmode endpoints entirely

app.get('/api/admin/fakenotifications', isAdmin, async(req,res) => {
  const fakeNotifications = await getSetting('fakeNotifications', false);
  res.json({fakeNotifications});
});

app.post('/api/admin/fakenotifications', isAdmin, async(req,res) => {
  await setSetting('fakeNotifications', !!req.body.enabled);
  res.json({success:true, fakeNotifications:!!req.body.enabled});
});

app.post('/api/admin/fakenotifinterval', isAdmin, async(req,res) => {
  const mins = Math.max(1, Number(req.body.interval) || 3);
  await setSetting('fakeNotifInterval', mins);
  scheduleFakeNotification();
  res.json({success:true, fakeNotifInterval:mins});
});

app.get('/api/admin/deposits', isAdmin, async(req,res) => {
  try {
    const agents = await User.find({role:'agent'}).select('telegramId').lean();
    const agentIds = agents.map(a => a.telegramId);
    const agentReferredUserIds = agentIds.length
      ? (await User.find({referredBy:{$in:agentIds}}).select('telegramId').lean()).map(u=>u.telegramId)
      : [];
    const query = { status: req.query.status||'pending' };
    if (agentReferredUserIds.length) query.userId = { $nin: agentReferredUserIds };
    const deps = await Deposit.find(query).sort({createdAt:-1}).limit(50).lean();
    const out = await Promise.all(deps.map(async d => {
      const u = await User.findOne({telegramId:d.userId}).select('firstName username').lean();
      return {...d, userName:u?.firstName||u?.username||String(d.userId)};
    }));
    res.json(out);
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.post('/api/admin/deposits/:id/confirm', isAdmin, async(req,res) => {
  try {
    const dep = await Deposit.findOneAndUpdate(
      { _id: req.params.id, status: 'pending' },
      { $set: { status: 'confirmed', processedAt: new Date(), expireAt: new Date(Date.now() + 72*60*60*1000) } },
      { new: true }
    );
    if (!dep) return res.status(400).json({error:'Deposit မတွေ့ပါ သို့မဟုတ် ပြင်ဆင်ပြီးသားဖြစ်သည်'});
    await User.findOneAndUpdate({telegramId:dep.userId},{$inc:{balance:dep.amount}});
    const user = await User.findOne({telegramId:dep.userId}).lean();
    await applyFirstDepositBonus(dep.userId, dep.amount);
    if (user?.referredBy) {
      const prevDeps = await Deposit.countDocuments({userId:dep.userId,status:'confirmed',_id:{$ne:dep._id}});
      if (prevDeps === 0) {
        await User.findOneAndUpdate({telegramId:user.referredBy},{$inc:{balance:100}});
        if (bot) bot.telegram.sendMessage(user.referredBy,
          `🎉 သင့် referral မှ ငွေဖြည့်သောကြောင့် <b>100 MMK</b> ရရှိပါပြီ!`,
          {parse_mode:'HTML'}).catch(()=>{});
      }
      const referrer = await User.findOne({ telegramId: user.referredBy, role: 'agent' }).lean();
      if (referrer) {
        const commission5 = Math.floor(dep.amount * 0.05);
        if (commission5 > 0) {
          await User.findOneAndUpdate({ telegramId: user.referredBy }, { $inc: { balance: commission5 } });
          if (bot) bot.telegram.sendMessage(user.referredBy,
            `💸 <b>Deposit Commission ရရှိပြီ!</b>\n👤 User ငွေဖြည့်: ${dep.amount.toLocaleString()} ကျပ်\n🎉 သင့်ဆီ 5% = <b>${commission5.toLocaleString()} ကျပ်</b>`,
            { parse_mode: 'HTML' }).catch(() => {});
        }
      }
    }
    if (bot) bot.telegram.sendMessage(dep.userId,
      `✅ ငွေ ${dep.amount.toLocaleString()} ကျပ် သွင်းမှု အတည်ပြုပြီး!\n\nသင့်လက်ကျန်ငွေ ပေါင်းထည့်ပြီး 🎉`,
      Markup.inlineKeyboard([[Markup.button.webApp('🎮 ကစားမည်', FRONTEND_URL)]])).catch(()=>{});
    res.json({success:true});
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.post('/api/admin/deposits/:id/reject', isAdmin, async(req,res) => {
  try {
    const { reason } = req.body;
    const TTL_72H = new Date(Date.now() + 72 * 60 * 60 * 1000);
    const dep = await Deposit.findByIdAndUpdate(req.params.id,
      {status:'rejected', processedAt:new Date(), expireAt:TTL_72H},
      {new:true});
    if (!dep) return res.status(404).json({error:'Deposit မတွေ့ပါ'});
    const reasonText = reason ? `\nအကြောင်းပြချက်: ${reason}` : '';
    if (bot) bot.telegram.sendMessage(dep.userId,
      `❌ ငွေ ${dep.amount.toLocaleString()} ကျပ် သွင်းမှု ပယ်ချပြီ\nTxn: ${dep.transactionId}${reasonText}`).catch(()=>{});
    res.json({success:true});
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.get('/api/admin/withdrawals', isAdmin, async(req,res) => {
  try {
    const wds = await Withdrawal.find({status:req.query.status||'pending'}).sort({createdAt:-1}).limit(50).lean();
    const out = await Promise.all(wds.map(async w => {
      const u = await User.findOne({telegramId:w.userId}).select('firstName username balance').lean();
      return {...w, userName:u?.firstName||u?.username||String(w.userId), userBalance:u?.balance};
    }));
    res.json(out);
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.post('/api/admin/withdrawals/:id/confirm', isAdmin, async(req,res) => {
  try {
    const wd = await Withdrawal.findOneAndUpdate(
      { _id: req.params.id, status: 'pending' },
      { $set: { status: 'confirmed', processedAt: new Date(), expireAt: new Date(Date.now() + 72*60*60*1000) } },
      { new: true }
    );
    if (!wd) return res.status(400).json({error:'Withdrawal မတွေ့ပါ သို့မဟုတ် ပြင်ဆင်ပြီးသားဖြစ်သည်'});
    const wdUser = await User.findOne({telegramId:wd.userId}).select('firstName username').lean();
    const displayName = wdUser?.firstName || wdUser?.username || `User${wd.userId}`;
    const globalMsg = `🎉 အသုံးပြုသူ ${displayName} က ${wd.amount.toLocaleString()} MMK ထုတ်ယူမှု အောင်မြင်သွားပါပြီ!`;
    io.emit('globalPayout', { name: displayName, amount: wd.amount, message: globalMsg });
    io.emit('globalNoti',   { message: globalMsg });
    if (bot) bot.telegram.sendMessage(wd.userId,
      `✅ ငွေ ${wd.amount.toLocaleString()} ကျပ် ထုတ်မှု အတည်ပြုပြီး!\n${wd.paymentMethod === 'wave' ? '🌊 Wave Pay' : '📱 KPay'}: ${wd.kpayNumber} 🎉`).catch(()=>{});
    (async () => {
      try {
        if (!bot) return;
        const mentionText = wdUser?.username
          ? `@${wdUser.username}`
          : `<a href="tg://user?id=${wd.userId}">${displayName}</a>`;
        const broadcastMsg =
          `🎉 ဂုဏ်ယူပါတယ်! ► ငွေထုတ်ယူမှု အောင်မြင်ပါသည်။\n\n` +
          `ကစားသမား ${mentionText} သည် TicToeTic ဂိမ်းမှ ${wd.amount.toLocaleString()} MMK ကို အောင်မြင်စွာ ထုတ်ယူသွားပါပြီ! 💸\n\n` +
          `🎮 မိတ်ဆွေလည်း အခုပဲ ဝင်ရောက်ကစားပြီး အမြတ်တွေ ထုတ်ယူလိုက်ပါ!`;
        const allUsers = await User.find(
          { telegramId: { $ne: wd.userId }, isBanned: { $ne: true } },
          { telegramId: 1, lastActive: 1, _id: 0 }
        ).lean();
        const fiveMinAgo = Date.now() - 5 * 60 * 1000;
        const sorted = allUsers.sort((a, b) => {
          const aOnline = userSockets.has(a.telegramId) || (a.lastActive && new Date(a.lastActive).getTime() > fiveMinAgo);
          const bOnline = userSockets.has(b.telegramId) || (b.lastActive && new Date(b.lastActive).getTime() > fiveMinAgo);
          if (aOnline && !bOnline) return -1;
          if (!aOnline && bOnline) return 1;
          return new Date(b.lastActive || 0).getTime() - new Date(a.lastActive || 0).getTime();
        });
        for (const u of sorted) {
          const delay = 100 + Math.floor(Math.random() * 101);
          await new Promise(resolve => setTimeout(resolve, delay));
          bot.telegram.sendMessage(u.telegramId, broadcastMsg, { parse_mode: 'HTML' }).catch(() => {});
        }
      } catch (broadcastErr) { console.error('Withdrawal broadcast err:', broadcastErr.message); }
    })();
    res.json({success:true});
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.post('/api/admin/withdrawals/:id/reject', isAdmin, async(req,res) => {
  try {
    const wd = await Withdrawal.findById(req.params.id);
    if (!wd) return res.status(404).json({error:'Withdrawal မတွေ့ပါ'});
    if (wd.status!=='pending') return res.status(400).json({error:'ဤ Withdrawal ကို ပြင်ဆင်ပြီးသားဖြစ်သည်'});
    const TTL_72H = new Date(Date.now() + 72 * 60 * 60 * 1000);
    wd.status='rejected'; wd.processedAt=new Date(); wd.expireAt=TTL_72H;
    await wd.save();
    await User.findOneAndUpdate({telegramId:wd.userId},{$inc:{balance:wd.amount}});
    if (bot) bot.telegram.sendMessage(wd.userId,
      `❌ ငွေ ${wd.amount.toLocaleString()} ကျပ် ထုတ်မှု ပယ်ချပြီး ငွေပြန်အမ်းပြီ`).catch(()=>{});
    res.json({success:true});
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.get('/api/admin/users', isAdmin, async(req,res) => {
  try {
    const {search,page=1} = req.query;
    const q = search ? {$or:[
      {telegramId:isNaN(search)?-1:parseInt(search)},
      {username:{$regex:search,$options:'i'}},
      {firstName:{$regex:search,$options:'i'}}
    ]} : {};
    const users = await User.find(q).sort({createdAt:-1}).skip((page-1)*20).limit(20).lean();
    const total = await User.countDocuments(q);
    res.json({users, total, pages:Math.ceil(total/20)});
  } catch(e){ res.status(500).json({error:e.message}); }
});

// FIX #2: Removed botMode from high-balancers response
app.get('/api/admin/high-balancers', isAdmin, async(req,res) => {
  try {
    const highUsers = await User.find({ balance: { $gte: 4000 }, isBanned: { $ne: true } })
      .sort({ balance: -1 }).lean();
    const enriched = await Promise.all(highUsers.map(async u => {
      const deposits = await Deposit.aggregate([
        { $match: { userId: u.telegramId, status: 'confirmed' } },
        { $group: { _id: null, total: { $sum: '$amount' } } }
      ]);
      return {
        telegramId: u.telegramId,
        username: u.username,
        firstName: u.firstName,
        balance: u.balance,
        totalDeposited: deposits[0]?.total || 0,
        isBanned: u.isBanned
      };
    }));
    res.json(enriched);
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.post('/api/admin/users/:tid/balance', isAdmin, async(req,res) => {
  try {
    const {amount,reason} = req.body;
    const u = await User.findOneAndUpdate(
      {telegramId:parseInt(req.params.tid)},
      {$inc:{balance:parseInt(amount)}},
      {new:true}
    );
    if (!u) return res.status(404).json({error:'Not found'});
    if (bot) {
      const sign = amount > 0 ? '+' : '';
      bot.telegram.sendMessage(u.telegramId,
        `💰 Admin မှ ${sign}${parseInt(amount).toLocaleString()} ကျပ်\n${reason?`မှတ်ချက်: ${reason}`:''}\nလက်ကျန်: ${u.balance.toLocaleString()} ကျပ်`).catch(()=>{});
    }
    res.json({success:true, newBalance:u.balance});
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.post('/api/admin/users/:tid/ban', isAdmin, async(req,res) => {
  try {
    const {ban} = req.body;
    const u = await User.findOneAndUpdate(
      {telegramId:parseInt(req.params.tid)},
      {isBanned:!!ban},
      {new:true}
    );
    if (!u) return res.status(404).json({error:'Not found'});
    if (bot&&ban) bot.telegram.sendMessage(u.telegramId,'🚫 ကောင်ပိတ်ဆို့ထားပါသည်။ Admin ကို ဆက်သွယ်ပါ').catch(()=>{});
    res.json({success:true});
  } catch(e){ res.status(500).json({error:e.message}); }
});

// FIX #2: Removed /api/admin/users/:tid/botmode endpoint entirely

app.post('/api/admin/broadcast', isAdmin, async(req,res) => {
  try {
    const {message,buttonText,buttonUrl} = req.body;
    if (!message) return res.status(400).json({error:'Message required'});
    res.json({success:true, msg:'Broadcast started in background'});
    setImmediate(async() => {
      const users = await User.find({isBanned:{$ne:true}}).select('telegramId').lean();
      const kb = buttonText&&buttonUrl ? {inline_keyboard:[[{text:buttonText,url:buttonUrl}]]} : undefined;
      let sent=0, fail=0;
      const CHUNK = 30;
      for (let i = 0; i < users.length; i += CHUNK) {
        const batch = users.slice(i, i+CHUNK);
        await Promise.allSettled(batch.map(async u => {
          const r = await sendOneBotMsg(u.telegramId, message, kb);
          if (r) sent++; else fail++;
        }));
        if (i+CHUNK < users.length) await new Promise(r=>setTimeout(r,1000));
      }
      console.log(`Broadcast done: ${sent} sent, ${fail} failed / ${users.length} total`);
    });
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.post('/api/admin/message', isAdmin, async(req,res) => {
  try {
    const {telegramId,message} = req.body;
    if (!telegramId||!message) return res.status(400).json({error:'Missing fields'});
    await bot.telegram.sendMessage(parseInt(telegramId), message, {parse_mode:'HTML'});
    res.json({success:true});
  } catch(e){ res.status(500).json({error:e.message}); }
});

// ===== Game History Admin Routes =====
app.get('/api/admin/games', isAdmin, async(req,res) => {
  try {
    const { page=1, search='' } = req.query;
    const limit = 20;
    const skip = (parseInt(page)-1)*limit;
    let q = { status:'completed' };
    if (search) {
      const tid = isNaN(search) ? null : parseInt(search);
      if (tid) q = { ...q, players: tid };
    }
    const games = await Game.find(q).sort({createdAt:-1}).skip(skip).limit(limit).lean();
    const total = await Game.countDocuments(q);
    const enriched = await Promise.all(games.map(async g => {
      const pNames = {};
      for (const pid of (g.players||[])) {
        const nm = g.playerNames ? (g.playerNames instanceof Map ? g.playerNames.get(String(pid)) : g.playerNames[pid]) : null;
        if (nm) { pNames[pid]=nm; continue; }
        const u = await User.findOne({telegramId:pid}).select('firstName username').lean();
        pNames[pid] = u?.firstName||u?.username||`User${pid}`;
      }
      const winnerName = g.winner===-1 ? '🤝 သရေ' : g.winner ? (pNames[g.winner]||String(g.winner)) : '—';
      return { ...g, pNames, winnerName };
    }));
    res.json({ games: enriched, total, pages: Math.ceil(total/limit) });
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.delete('/api/admin/games/:gameId', isAdmin, async(req,res) => {
  try {
    const g = await Game.findOne({gameId:req.params.gameId}).lean();
    if (!g) return res.status(404).json({error:'Game not found'});
    if (g.status==='completed' && g.winner && g.winner !== -1) {
      await User.findOneAndUpdate({telegramId:g.winner},{$inc:{balance:-WIN_PRIZE,wins:-1,totalGames:-1}});
      const loser = (g.players||[]).find(p=>p!==g.winner);
      if (loser) await User.findOneAndUpdate({telegramId:loser},{$inc:{losses:-1,totalGames:-1}});
    } else if (g.status==='completed' && g.winner===-1) {
      for (const pid of (g.players||[])) {
        await User.findOneAndUpdate({telegramId:pid},{$inc:{balance:-DRAW_REFUND,totalGames:-1}});
      }
    }
    await Game.deleteOne({gameId:req.params.gameId});
    res.json({success:true});
  } catch(e){ res.status(500).json({error:e.message}); }
});

// ===== Redeem Code API =====
app.post('/api/redeem', async(req,res) => {
  try {
    const { telegramId, code } = req.body;
    if (!telegramId || !code)
      return res.status(400).json({ error: 'telegramId နှင့် code လိုအပ်သည်' });
    const tid = parseInt(telegramId);
    const user = await User.findOne({ telegramId: tid }).lean();
    if (!user) return res.status(404).json({ error: 'User မတွေ့ပါ' });
    if (user.isBanned) return res.status(403).json({ error: '🚫 ကောင်ပိတ်ဆို့ထားသည်' });
    const rc = await RedeemCode.findOne({ code: code.toUpperCase().trim() });
    if (!rc || !rc.isActive)
      return res.status(400).json({ error: '❌ Code မမှန်ပါ သို့မဟုတ် ပိတ်ထားပြီ' });
    if (rc.usedBy.includes(tid))
      return res.status(400).json({ error: '⚠️ ဤ Code ကို သင် အသုံးပြုပြီးသားဖြစ်သည်' });
    if (rc.maxUses > 0 && rc.usedBy.length >= rc.maxUses)
      return res.status(400).json({ error: '⚠️ Code ကုန်ဆုံးပြီ' });
    await RedeemCode.updateOne({ _id: rc._id }, { $push: { usedBy: tid } });
    const updated = await User.findOneAndUpdate(
      { telegramId: tid },
      { $inc: { balance: rc.amount } },
      { new: true }
    );
    if (bot) bot.telegram.sendMessage(ADMIN_ID,
      `🎟️ Redeem Code အသုံးပြု\n👤 ${user.firstName||user.username} (${tid})\n🎫 Code: <code>${rc.code}</code>\n💰 ${rc.amount.toLocaleString()} MMK`,
      { parse_mode: 'HTML' }).catch(() => {});
    res.json({ success: true, amount: rc.amount, newBalance: updated.balance });
  } catch(e) { console.error('redeem err:', e); res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/admin/redeem/create', isAdmin, async(req,res) => {
  try {
    const { code, amount, maxUses } = req.body;
    if (!code || !amount) return res.status(400).json({ error: 'code နှင့် amount လိုသည်' });
    const amt = parseInt(amount);
    if (isNaN(amt) || amt <= 0) return res.status(400).json({ error: 'Amount မှားနေသည်' });
    const mx = parseInt(maxUses) || 1;
    const rc = await new RedeemCode({ code: code.toUpperCase().trim(), amount: amt, maxUses: mx }).save();
    res.json({ success: true, code: rc });
  } catch(e) {
    if (e.code === 11000) return res.status(400).json({ error: 'ထို Code ရှိပြီးသားဖြစ်သည်' });
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/redeem/list', isAdmin, async(req,res) => {
  try {
    const codes = await RedeemCode.find().sort({ createdAt: -1 }).lean();
    res.json(codes);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/redeem/:id/toggle', isAdmin, async(req,res) => {
  try {
    const rc = await RedeemCode.findById(req.params.id);
    if (!rc) return res.status(404).json({ error: 'Not found' });
    rc.isActive = !rc.isActive;
    await rc.save();
    res.json({ success: true, isActive: rc.isActive });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/redeem/:id', isAdmin, async(req,res) => {
  try {
    await RedeemCode.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ===== Agent API =====
async function isAgent(req, res, next) {
  const tid = parseInt(req.headers['x-telegram-id'] || req.query.telegramId);
  if (!tid) return res.status(401).json({ error: 'Telegram ID မပါ' });
  const user = await User.findOne({ telegramId: tid, role: 'agent' }).lean();
  if (!user) return res.status(403).json({ error: 'Agent မဟုတ်သေးပါ' });
  req.agentUser = user;
  next();
}

app.get('/api/agent/panel', isAgent, async (req, res) => {
  try {
    const user = req.agentUser;
    let agent = await Agent.findOne({ telegramId: user.telegramId });
    if (!agent) {
      agent = new Agent({ telegramId: user.telegramId, referralCode: user.referralCode });
      await agent.save();
    }
    const totalReferrals = await User.countDocuments({ referredBy: user.telegramId });
    const referredIds = (await User.find({ referredBy: user.telegramId }).select('telegramId').lean()).map(u => u.telegramId);
    const salesAgg = referredIds.length
      ? await Deposit.aggregate([
          { $match: { userId: { $in: referredIds }, status: 'confirmed' } },
          { $group: { _id: null, total: { $sum: '$amount' } } }
        ])
      : [];
    res.json({
      telegramId: user.telegramId,
      firstName: user.firstName,
      username: user.username,
      balance: user.balance,
      referralCode: user.referralCode,
      botUsername: BOT_USERNAME,
      totalEarned: agent.totalEarned,
      totalReferrals,
      totalSales: salesAgg[0]?.total || 0
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/agent/referrals', isAgent, async (req, res) => {
  try {
    const referrals = await User.find({ referredBy: req.agentUser.telegramId })
      .select('firstName username balance createdAt')
      .sort({ createdAt: -1 })
      .lean();
    res.json({ referrals, total: referrals.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/agent/deposits', isAgent, async (req, res) => {
  try {
    const referredIds = (await User.find({ referredBy: req.agentUser.telegramId }).select('telegramId').lean()).map(u=>u.telegramId);
    if (!referredIds.length) return res.json([]);
    const status = req.query.status || 'pending';
    const deps = await Deposit.find({ userId: { $in: referredIds }, status }).sort({ createdAt: -1 }).limit(50).lean();
    const out = await Promise.all(deps.map(async d => {
      const u = await User.findOne({ telegramId: d.userId }).select('firstName username').lean();
      return { ...d, userName: u?.firstName||u?.username||String(d.userId) };
    }));
    res.json(out);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/agent/deposits/:id/confirm', isAgent, async (req, res) => {
  try {
    const dep = await Deposit.findOneAndUpdate(
      { _id: req.params.id, status: 'pending' },
      { $set: { status: 'confirmed', processedBy: 'agent', processedAt: new Date(), expireAt: new Date(Date.now() + 72*60*60*1000) } },
      { new: true }
    );
    if (!dep) return res.status(400).json({ error: 'Deposit မတွေ့ပါ' });
    // Verify this deposit belongs to agent's referral
    const isReferral = await User.findOne({ telegramId: dep.userId, referredBy: req.agentUser.telegramId }).lean();
    if (!isReferral) return res.status(403).json({ error: 'ခွင့်မပြုပါ' });
    await User.findOneAndUpdate({ telegramId: dep.userId }, { $inc: { balance: dep.amount } });
    await applyFirstDepositBonus(dep.userId, dep.amount);
    if (bot) bot.telegram.sendMessage(dep.userId,
      `✅ ငွေ ${dep.amount.toLocaleString()} ကျပ် သွင်းမှု Agent မှ အတည်ပြုပြီး! 🎉`).catch(()=>{});
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/agent/deposits/:id/reject', isAgent, async (req, res) => {
  try {
    const { reason } = req.body;
    const TTL_72H = new Date(Date.now() + 72 * 60 * 60 * 1000);
    const dep = await Deposit.findByIdAndUpdate(req.params.id,
      { status:'rejected', processedBy:'agent', processedAt: new Date(), expireAt: TTL_72H },
      { new: true }
    );
    if (!dep) return res.status(404).json({ error: 'Deposit မတွေ့ပါ' });
    const reasonText = reason ? `\nအကြောင်းပြချက်: ${reason}` : '';
    if (bot) bot.telegram.sendMessage(dep.userId,
      `❌ ငွေ ${dep.amount.toLocaleString()} ကျပ် သွင်းမှု ပယ်ချပြီ${reasonText}`).catch(()=>{});
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/agent/payment-info', isAgent, async (req, res) => {
  try {
    const agent = await Agent.findOne({ telegramId: req.agentUser.telegramId }).lean();
    res.json(agent || {});
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/agent/payment-info', isAgent, async (req, res) => {
  try {
    const { agentKpayNumber, agentKpayName, agentWaveNumber, agentWaveName, hasWave } = req.body;
    await Agent.findOneAndUpdate(
      { telegramId: req.agentUser.telegramId },
      { $set: { agentKpayNumber, agentKpayName, agentWaveNumber, agentWaveName, hasWave: !!hasWave } },
      { upsert: true }
    );
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/deposit/agent-info', async (req, res) => {
  try {
    const { referralCode } = req.query;
    if (!referralCode) return res.status(400).json({ error: 'referralCode လိုအပ်သည်' });
    const user = await User.findOne({ referralCode }).lean();
    if (!user || user.role !== 'agent') return res.status(404).json({ error: 'Agent မတွေ့ပါ' });
    const agent = await Agent.findOne({ telegramId: user.telegramId }).lean();
    if (!agent) return res.status(404).json({ error: 'Agent info မတွေ့ပါ' });
    res.json({
      agentKpayNumber: agent.agentKpayNumber,
      agentKpayName: agent.agentKpayName,
      agentWaveNumber: agent.agentWaveNumber,
      agentWaveName: agent.agentWaveName,
      hasWave: agent.hasWave
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ===== Admin: Users & Agents =====
app.get('/api/admin/users/:tid', isAdmin, async(req,res) => {
  try {
    const tid = parseInt(req.params.tid);
    const u = await User.findOne({ telegramId: tid }).lean();
    if (!u) return res.status(404).json({ error: 'User မတွေ့ပါ' });
    const deposits = await Deposit.aggregate([
      { $match: { userId: tid, status: 'confirmed' } },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]);
    res.json({ ...u, totalDeposited: deposits[0]?.total || 0 });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/users/referrals/tree', isAdmin, async (req, res) => {
  try {
    const agents = await User.find({ role: 'agent' }).select('telegramId firstName username referralCode').lean();
    const result = await Promise.all(agents.map(async (agent) => {
      const referredUsers = await User.find({ referredBy: agent.telegramId })
        .select('telegramId firstName username balance createdAt').lean();
      const activeCount = referredUsers.filter(u => u.balance > 0).length;
      const totalSalesAgg = referredUsers.length
        ? await Deposit.aggregate([
            { $match: { userId: { $in: referredUsers.map(u => u.telegramId) }, status: 'confirmed' } },
            { $group: { _id: null, total: { $sum: '$amount' } } }
          ])
        : [];
      const totalSales = totalSalesAgg[0]?.total || 0;
      return {
        agent: { telegramId: agent.telegramId, name: agent.firstName||agent.username, referralCode: agent.referralCode },
        totalReferrals: referredUsers.length,
        activeReferrals: activeCount,
        totalSales,
        referrals: referredUsers.map(u => ({
          telegramId: u.telegramId,
          name: u.firstName || u.username || `User${u.telegramId}`,
          username: u.username || '',
          balance: u.balance || 0,
          joinedAt: u.createdAt
        }))
      };
    }));
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/users/:tid/make-agent', isAdmin, async (req, res) => {
  try {
    const tid = parseInt(req.params.tid);
    const { isAgent: makeAgent } = req.body;
    const newRole = makeAgent ? 'agent' : 'user';
    const u = await User.findOneAndUpdate({ telegramId: tid }, { role: newRole }, { new: true });
    if (!u) return res.status(404).json({ error: 'User မတွေ့ပါ' });
    if (makeAgent) {
      await Agent.findOneAndUpdate(
        { telegramId: tid },
        { $setOnInsert: { telegramId: tid, referralCode: u.referralCode } },
        { upsert: true }
      );
      if (bot) bot.telegram.sendMessage(tid,
        `🎯 <b>Agent အဖြစ် ခွင့်ပြုပြီ!</b>\n\n🎉 မင်္ဂလာပါ Agent!\n\nBot တွင် <code>/agent</code> ရိုက်ပြီး Agent Panel ကို ဝင်ရောက်ပါ`,
        { parse_mode: 'HTML' }).catch(() => {});
    } else {
      if (bot) bot.telegram.sendMessage(tid,
        `ℹ️ သင်၏ Agent အဆင့်ကို ဖယ်ရှားပြီးပါပြီ`).catch(() => {});
    }
    res.json({ success: true, role: newRole });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/agents', isAdmin, async (req, res) => {
  try {
    const { page = 1, search = '' } = req.query;
    const limit = 20;
    const q = { role: 'agent' };
    if (search) {
      const tid = isNaN(search) ? null : parseInt(search);
      q.$or = [
        ...(tid ? [{ telegramId: tid }] : []),
        { username: { $regex: search, $options: 'i' } },
        { firstName: { $regex: search, $options: 'i' } }
      ];
    }
    const agents = await User.find(q).sort({ createdAt: -1 }).skip((page-1)*limit).limit(limit).lean();
    const total = await User.countDocuments(q);
    const enriched = await Promise.all(agents.map(async u => {
      const agentDoc = await Agent.findOne({ telegramId: u.telegramId }).lean();
      const totalReferrals = await User.countDocuments({ referredBy: u.telegramId });
      return { ...u, agentData: agentDoc, totalReferrals };
    }));
    res.json({ agents: enriched, total, pages: Math.ceil(total / limit) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/agents/:tid', isAdmin, async (req, res) => {
  try {
    const tid = parseInt(req.params.tid);
    const user = await User.findOne({ telegramId: tid, role: 'agent' }).lean();
    if (!user) return res.status(404).json({ error: 'Agent မတွေ့ပါ' });
    const agentDoc = await Agent.findOne({ telegramId: tid }).lean();
    const referrals = await User.find({ referredBy: tid })
      .select('firstName username balance createdAt').sort({ createdAt: -1 }).lean();
    res.json({ user, agentData: agentDoc, referrals, totalReferrals: referrals.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ===== FIX #1: /api/admin/agent-referrals (matches frontend field names) =====
app.get('/api/admin/agent-referrals', isAdmin, async (req, res) => {
  try {
    const agents = await User.find({ role: 'agent' }).select('telegramId firstName username referralCode balance').lean();
    const result = await Promise.all(agents.map(async (agent) => {
      const referredUsers = await User.find({ referredBy: agent.telegramId })
        .select('telegramId firstName username balance createdAt').lean();
      const activeReferrals = referredUsers.filter(u => (u.balance || 0) > 0).length;
      const totalSalesAgg = referredUsers.length
        ? await Deposit.aggregate([
            { $match: { userId: { $in: referredUsers.map(u => u.telegramId) }, status: 'confirmed' } },
            { $group: { _id: null, total: { $sum: '$amount' } } }
          ])
        : [];
      return {
        agentId: agent.telegramId,
        agentName: agent.firstName || agent.username || `Agent${agent.telegramId}`,
        agentUsername: agent.username || '',
        agentBalance: agent.balance || 0,
        referralCode: agent.referralCode,
        totalReferrals: referredUsers.length,
        activeReferrals,
        totalSales: totalSalesAgg[0]?.total || 0,
        totalDeposited: totalSalesAgg[0]?.total || 0,
        referrals: referredUsers.map(u => ({
          telegramId: u.telegramId,
          name: u.firstName || u.username || `User${u.telegramId}`,
          username: u.username || '',
          balance: u.balance || 0,
          joinedAt: u.createdAt
        }))
      };
    }));
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ===== Advanced Analytics — hourly activity + daily revenue for charts =====
app.get('/api/admin/analytics', isAdmin, async (req, res) => {
  try {
    const now = new Date();
    const day7  = new Date(now.getTime() - 7*24*60*60*1000);
    const day30 = new Date(now.getTime() - 30*24*60*60*1000);
    const [depDaily, wdDaily, gameHourly, newUsersDaily] = await Promise.all([
      Deposit.aggregate([
        { $match: { status:'confirmed', createdAt:{ $gte: day30 } } },
        { $group: { _id:{ $dateToString:{ format:'%Y-%m-%d', date:'$createdAt' } }, total:{ $sum:'$amount' }, count:{ $sum:1 } } },
        { $sort: { _id:1 } }
      ]),
      Withdrawal.aggregate([
        { $match: { status:'confirmed', createdAt:{ $gte: day30 } } },
        { $group: { _id:{ $dateToString:{ format:'%Y-%m-%d', date:'$createdAt' } }, total:{ $sum:'$amount' }, count:{ $sum:1 } } },
        { $sort: { _id:1 } }
      ]),
      Game.aggregate([
        { $match: { status:'completed', createdAt:{ $gte: day7 } } },
        { $group: { _id:{ $hour:'$createdAt' }, count:{ $sum:1 } } },
        { $sort: { _id:1 } }
      ]),
      User.aggregate([
        { $match: { createdAt:{ $gte: day30 } } },
        { $group: { _id:{ $dateToString:{ format:'%Y-%m-%d', date:'$createdAt' } }, count:{ $sum:1 } } },
        { $sort: { _id:1 } }
      ])
    ]);
    res.json({ depDaily, wdDaily, gameHourly, newUsersDaily });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ===== Self-ping =====
setInterval(() => {
  try { https.get(`${BACKEND_URL}/health`,()=>{}).on('error',()=>{}); } catch(e){}
}, 5*60*1000);

// ===== Global error handlers =====
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server on port ${PORT}`));
