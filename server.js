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
  res.header('Access-Control-Allow-Headers', 'Content-Type,Authorization,x-admin-id');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
app.use(express.json());

const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  allowEIO3: true,
  pingTimeout: 30000,
  pingInterval: 10000
});

const BOT_TOKEN      = process.env.BOT_TOKEN;
const ADMIN_ID       = process.env.ADMIN_ID ? parseInt(process.env.ADMIN_ID) : null;
const FRONTEND_URL   = process.env.FRONTEND_URL  || 'https://tictokfrontend.vercel.app';
const BACKEND_URL    = process.env.BACKEND_URL   || 'https://tiktocbackend.onrender.com';
const BOT_USERNAME   = process.env.BOT_USERNAME  || 'tictoe1_bot';

const ENTRY_FEE        = 1000;
const WIN_PRIZE        = 1600;
const DRAW_REFUND      = 500;
const TURN_SECONDS     = 10;
const SEARCH_TIMEOUT_S = 30;

// ── AI fake ID (negative — never conflicts with real Telegram IDs) ──
const AI_ID = -999999;

// ── Random Myanmar names for AI opponent ──
const AI_NAMES = [
  'Kaung Kaung','Htun Htun','Maythu','Naylom','Yamone',
  'Thuta','Zawmin','Minmayloe','Khantkyi','Leethal','Soethu',
  'Pyaephyo','Waiyan','Aungmyat','Eindray','Kyawzin','Sandar',
  'Thidasoe','Naythu','Phyomin'
];
function randomAIName() {
  return AI_NAMES[Math.floor(Math.random() * AI_NAMES.length)];
}

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
mongoose.connection.on('reconnected',  () => { isConnected = true;  });
connectDB();

// ===== Schemas =====
const userSchema = new mongoose.Schema({
  telegramId:   { type: Number, required: true, unique: true },
  username:     { type: String, default: '' },
  firstName:    { type: String, default: '' },
  balance:      { type: Number, default: 0 },
  referredBy:   { type: Number, default: null },
  referralCode: { type: String, unique: true, sparse: true },
  totalGames:   { type: Number, default: 0 },
  wins:         { type: Number, default: 0 },
  losses:       { type: Number, default: 0 },
  isBanned:     { type: Boolean, default: false },
  createdAt:    { type: Date, default: Date.now }
});
userSchema.index({ telegramId: 1 });
userSchema.index({ referralCode: 1 });

const depositSchema = new mongoose.Schema({
  userId:        { type: Number, required: true },
  kpayName:      String,
  transactionId: { type: String, required: true, unique: true },
  amount:        { type: Number, required: true },
  status:        { type: String, enum: ['pending','confirmed','rejected'], default: 'pending' },
  createdAt:     { type: Date, default: Date.now },
  processedAt:   Date
});
depositSchema.index({ transactionId: 1 });
depositSchema.index({ status: 1 });
depositSchema.index({ userId: 1 });

const withdrawalSchema = new mongoose.Schema({
  userId:      { type: Number, required: true },
  kpayName:    String,
  kpayNumber:  String,
  amount:      { type: Number, required: true },
  status:      { type: String, enum: ['pending','confirmed','rejected'], default: 'pending' },
  createdAt:   { type: Date, default: Date.now },
  processedAt: Date
});
withdrawalSchema.index({ status: 1 });
withdrawalSchema.index({ userId: 1 });

const gameSchema = new mongoose.Schema({
  gameId:    { type: String, required: true, unique: true },
  players:   [Number],
  symbols:   { type: Map, of: String },
  board:     { type: [[String]], default: () => Array(5).fill(null).map(() => Array(5).fill('')) },
  winner:    { type: mongoose.Schema.Types.Mixed, default: null },
  status:    { type: String, enum: ['waiting','active','completed'], default: 'waiting' },
  createdAt: { type: Date, default: Date.now, expires: 86400 }
});
gameSchema.index({ gameId: 1 });

const settingsSchema = new mongoose.Schema({
  key:   { type: String, unique: true },
  value: mongoose.Schema.Types.Mixed
});

const User       = mongoose.model('User',       userSchema);
const Deposit    = mongoose.model('Deposit',    depositSchema);
const Withdrawal = mongoose.model('Withdrawal', withdrawalSchema);
const Game       = mongoose.model('Game',       gameSchema);
const Settings   = mongoose.model('Settings',   settingsSchema);

// ===== In-Memory =====
const waitingQueue        = [];
const activeGames         = new Map();
const gameTurnTimeouts    = new Map();
const userSockets         = new Map();
const searchNotifications = new Map();

// ===== Helpers =====
function genRefCode(id) {
  return 'TIC' + id.toString(36).toUpperCase() + Math.random().toString(36).substr(2, 4).toUpperCase();
}
function genGameId() {
  return 'g' + Date.now() + Math.random().toString(36).substr(2, 5);
}

function verifyTgAuth(initData) {
  if (!initData || !BOT_TOKEN) return null;
  try {
    const p    = new URLSearchParams(initData);
    const hash = p.get('hash');
    if (!hash) return null;
    const check = Array.from(p.entries())
      .filter(([k]) => k !== 'hash')
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');
    const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const hmac   = crypto.createHmac('sha256', secret).update(check).digest('hex');
    if (hmac !== hash) return null;
    const u = p.get('user');
    return u ? JSON.parse(u) : null;
  } catch { return null; }
}

function checkWin(board, sym) {
  const dirs = [[0,1],[1,0],[1,1],[1,-1]];
  for (let r = 0; r < 5; r++) {
    for (let c = 0; c < 5; c++) {
      if (board[r][c] !== sym) continue;
      for (const [dr, dc] of dirs) {
        let cnt = 1;
        for (let i = 1; i < 4; i++) {
          const nr = r + dr*i, nc = c + dc*i;
          if (nr < 0 || nr >= 5 || nc < 0 || nc >= 5 || board[nr][nc] !== sym) break;
          cnt++;
        }
        if (cnt >= 4) return true;
      }
    }
  }
  return false;
}

function boardFull(board) { return board.every(row => row.every(c => c !== '')); }

async function getSetting(key, def) {
  try { const s = await Settings.findOne({ key }).lean(); return s ? s.value : def; } catch { return def; }
}
async function setSetting(key, value) {
  await Settings.findOneAndUpdate({ key }, { value }, { upsert: true });
}

// ===== AI Logic (Strong AI) =====
function aiPickMove(board, aiSym) {
  const humanSym = aiSym === 'X' ? 'O' : 'X';

  function countLine(b, r, c, dr, dc, sym) {
    let cnt = 0;
    for (let i = 1; i < 4; i++) {
      const nr = r + dr*i, nc = c + dc*i;
      if (nr < 0 || nr >= 5 || nc < 0 || nc >= 5) break;
      if (b[nr][nc] === sym) cnt++;
      else break;
    }
    return cnt;
  }

  function scoreCell(b, r, c, sym) {
    const dirs = [[0,1],[1,0],[1,1],[1,-1]];
    let score = 0;
    for (const [dr, dc] of dirs) {
      const fwd = countLine(b, r, c, dr, dc, sym);
      const bwd = countLine(b, r, c, -dr, -dc, sym);
      const total = fwd + bwd;
      if (total >= 3) score += 500;
      else if (total === 2) score += 40;
      else if (total === 1) score += 8;
    }
    // Prefer center area
    score += (4 - Math.abs(r - 2) - Math.abs(c - 2)) * 2;
    return score;
  }

  const empty = [];
  for (let r = 0; r < 5; r++)
    for (let c = 0; c < 5; c++)
      if (board[r][c] === '') empty.push([r, c]);

  if (empty.length === 0) return null;

  // 1. Immediate win?
  for (const [r, c] of empty) {
    const t = board.map(row => [...row]);
    t[r][c] = aiSym;
    if (checkWin(t, aiSym)) return [r, c];
  }

  // 2. Block human immediate win?
  for (const [r, c] of empty) {
    const t = board.map(row => [...row]);
    t[r][c] = humanSym;
    if (checkWin(t, humanSym)) return [r, c];
  }

  // 3. Score-based best move
  let best = null, bestScore = -Infinity;
  for (const [r, c] of empty) {
    const sc = scoreCell(board, r, c, aiSym) + scoreCell(board, r, c, humanSym) * 0.85;
    if (sc > bestScore) { bestScore = sc; best = [r, c]; }
  }

  return best || empty[Math.floor(Math.random() * empty.length)];
}

function scheduleAIMove(gameId) {
  const game = activeGames.get(gameId);
  if (!game || game.status !== 'active' || game.currentTurn !== AI_ID) return;

  // AI "thinks" 3–5 seconds to feel natural
  const thinkMs = (3 + Math.random() * 2) * 1000;

  const t = setTimeout(async () => {
    const g = activeGames.get(gameId);
    if (!g || g.status !== 'active' || g.currentTurn !== AI_ID) return;

    clearTurnTimer(gameId);

    const move = aiPickMove(g.board, g.symbols[AI_ID]);
    if (!move) { await endGame(gameId, -1, 'draw'); return; }

    const [row, col] = move;
    const sym = g.symbols[AI_ID];
    g.board[row][col] = sym;

    io.to(gameId).emit('moveMade', { row, col, symbol: sym, playerId: AI_ID, board: g.board });

    if (checkWin(g.board, sym)) {
      await endGame(gameId, AI_ID, 'win');
    } else if (boardFull(g.board)) {
      await endGame(gameId, -1, 'draw');
    } else {
      const humanId = g.players.find(p => p !== AI_ID);
      g.currentTurn = humanId;
      io.to(gameId).emit('turnChanged', { currentTurn: humanId });
      const nt = setTimeout(() => handleTurnTimeout(gameId, humanId), TURN_SECONDS * 1000 + 1500);
      gameTurnTimeouts.set(gameId, nt);
    }
  }, thinkMs);

  gameTurnTimeouts.set(gameId, t);
}

// ===== Bot =====
let bot = null;
if (BOT_TOKEN) {
  bot = new Telegraf(BOT_TOKEN);

  bot.start(async (ctx) => {
    const id   = ctx.from.id;
    const args = ctx.payload;
    try {
      let user = await User.findOne({ telegramId: id });
      if (!user) {
        user = new User({
          telegramId:   id,
          username:     ctx.from.username   || '',
          firstName:    ctx.from.first_name || '',
          referralCode: genRefCode(id)
        });
        if (args && args.length > 3) {
          const ref = await User.findOne({ referralCode: args }).lean();
          if (ref && ref.telegramId !== id) user.referredBy = ref.telegramId;
        }
        await user.save();
      }
      const maint = await getSetting('maintenance', false);
      if (maint && id !== ADMIN_ID) {
        return ctx.reply('🔧 ဆာဗာ ပြင်ဆင်နေသောကြောင့် ယာယီပိတ်ထားပါသည်။');
      }
      await ctx.reply(
        `🎮 မင်္ဂလာပါ ${ctx.from.first_name}!\n\n💰 လက်ကျန်: ${user.balance.toLocaleString()} MMK\n🏆 အနိုင်: ${user.wins}  •  ❌ ရှုံး: ${user.losses}`,
        Markup.inlineKeyboard([
          [Markup.button.webApp('🎮 PLAY NOW', FRONTEND_URL)],
          [Markup.button.callback('💰 Balance', 'bal'), Markup.button.callback('🔗 Referral', 'ref')]
        ])
      );
    } catch (e) { console.error(e); ctx.reply('⚠️ ဆာဗာ ချိတ်ဆက်မှု ပြဿနာ'); }
  });

  bot.action('bal', async (ctx) => {
    try {
      await ctx.answerCbQuery();
      const u = await User.findOne({ telegramId: ctx.from.id }).lean();
      if (!u) return;
      ctx.reply(
        `💰 လက်ကျန်: ${u.balance.toLocaleString()} MMK\n🎮 ကစားကြိမ်: ${u.totalGames}\n🏆 အနိုင်ရရှိခြင်း: ${u.wins}  •  ❌ ရှုံးထားခြင်း: ${u.losses}`,
        Markup.inlineKeyboard([[Markup.button.webApp('🎮 ကစားမည်', FRONTEND_URL)]])
      );
    } catch (e) {}
  });

  bot.action('ref', async (ctx) => {
    try {
      await ctx.answerCbQuery();
      const u = await User.findOne({ telegramId: ctx.from.id }).lean();
      if (!u) return;
      const link = `https://t.me/${BOT_USERNAME}?start=${u.referralCode}`;
      ctx.reply(
        `🔗 <b>Referral Link</b>\n\nသူငယ်ချင်း တစ်ယောက်မှ 1,000 MMK ဖြည့်တိုင်း သင် <b>100 MMK</b> ရမည်!\n\n<code>${link}</code>`,
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([[
            Markup.button.url('📤 Share', `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent('🎮 TicToeTic ကစားပြီးငွေရှာကြစို့!')}`)
          ]])
        }
      );
    } catch (e) {}
  });

  bot.action(/^join_(.+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery('ချိတ်ဆက်နေပါသည်...');
      const gameId = ctx.match[1];
      const id     = ctx.from.id;
      try { await ctx.deleteMessage(); } catch (e) {}
      const user = await User.findOne({ telegramId: id }).lean();
      if (!user) return ctx.reply('ဦးစွာ /start နှိပ်ပါ');
      if (user.balance < ENTRY_FEE) {
        return ctx.reply(
          `⚠️ ငွေမလုံလောက်ပါ!\n\nပွဲဝင်ကြေး: ${ENTRY_FEE.toLocaleString()} MMK\nသင့်ကျန်: ${user.balance.toLocaleString()} MMK`,
          Markup.inlineKeyboard([[Markup.button.webApp('💰 ငွေဖြည့်ရန်', FRONTEND_URL)]])
        );
      }
      await ctx.reply(
        '✅ ပွဲတွင် ဝင်ရောက်ရန် PLAY ကိုနှိပ်ပါ',
        Markup.inlineKeyboard([[Markup.button.webApp('🎮 JOIN NOW', `${FRONTEND_URL}/play.html?join=${gameId}`)]])
      );
    } catch (e) { console.error('join action err:', e); }
  });

  bot.action('dismiss', async (ctx) => {
    try { await ctx.answerCbQuery(); await ctx.deleteMessage(); } catch (e) {}
  });

  bot.launch().then(() => console.log('✅ Bot launched')).catch(e => console.error('Bot err:', e));
}

// ===== Notify users =====
async function notifyUsersGameSearch(searcherId, gameId) {
  if (!bot) return;
  try {
    const searcher = await User.findOne({ telegramId: searcherId }).select('firstName username').lean();
    const name     = searcher?.firstName || searcher?.username || 'တစ်ယောက်';
    const users    = await User.find({ telegramId: { $ne: searcherId }, isBanned: false })
      .select('telegramId').lean().limit(200);
    const sent = [];
    for (const u of users) {
      try {
        const msg = await bot.telegram.sendMessage(
          u.telegramId,
          `⚡ <b>${name}</b> ပွဲရှာနေသည်!\n\n⏱ ${SEARCH_TIMEOUT_S} စက္ကန့်အတွင်း Join မနှိပ်ရင် ပွဲပျောက်မည်\n💰 ဝင်ကြေး: ${ENTRY_FEE.toLocaleString()} MMK  •  🏆 ဆု: ${WIN_PRIZE.toLocaleString()} MMK`,
          {
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: [[
              { text: '🎮 Join Game', callback_data: `join_${gameId}` },
              { text: '❌ မကစားဘူး',  callback_data: 'dismiss' }
            ]]}
          }
        );
        sent.push({ userId: u.telegramId, msgId: msg.message_id });
        await new Promise(r => setTimeout(r, 50));
      } catch (e) {}
    }
    searchNotifications.set(gameId, sent);
  } catch (e) { console.error('notify err:', e); }
}

async function deleteSearchMsgs(gameId) {
  if (!bot) return;
  const msgs = searchNotifications.get(gameId);
  if (!msgs) return;
  searchNotifications.delete(gameId);
  for (const { userId, msgId } of msgs) {
    try { await bot.telegram.deleteMessage(userId, msgId); await new Promise(r => setTimeout(r, 30)); } catch (e) {}
  }
}

// ===== Game helpers =====
function clearTurnTimer(gameId) {
  const t = gameTurnTimeouts.get(gameId);
  if (t) { clearTimeout(t); gameTurnTimeouts.delete(gameId); }
}

// Forward declaration (used in scheduleAIMove)
async function handleTurnTimeout(gameId, playerId) {
  const game = activeGames.get(gameId);
  if (!game || game.status !== 'active' || game.currentTurn !== playerId) return;
  const opp = game.players.find(p => p !== playerId);
  await endGame(gameId, opp, 'timeout');
}

async function endGame(gameId, winner, reason = 'normal') {
  const game = activeGames.get(gameId);
  if (!game || game.status !== 'active') return;

  clearTurnTimer(gameId);
  game.status = 'completed';

  try {
    const humanPlayers = game.players.filter(p => p !== AI_ID);

    if (winner === -1) {
      // Draw
      for (const pid of humanPlayers) {
        await User.findOneAndUpdate({ telegramId: pid }, { $inc: { balance: DRAW_REFUND, totalGames: 1 } });
      }
    } else if (winner === AI_ID) {
      // AI wins — human loses (entry fee already deducted, no prize)
      for (const pid of humanPlayers) {
        await User.findOneAndUpdate({ telegramId: pid }, { $inc: { losses: 1, totalGames: 1 } });
      }
    } else if (winner) {
      // Human wins
      await User.findOneAndUpdate({ telegramId: winner }, { $inc: { balance: WIN_PRIZE, wins: 1, totalGames: 1 } });
      const loser = humanPlayers.find(p => p !== winner);
      if (loser && loser !== AI_ID) {
        await User.findOneAndUpdate({ telegramId: loser }, { $inc: { losses: 1, totalGames: 1 } });
      }
    }

    await Game.findOneAndUpdate(
      { gameId },
      { winner, status: 'completed', board: game.board },
      { upsert: true }
    );
  } catch (e) { console.error('endGame err:', e); }

  io.to(gameId).emit('gameOver', { winner, reason, board: game.board, isAIGame: !!game.isAIGame });
  activeGames.delete(gameId);
  setTimeout(() => deleteSearchMsgs(gameId), 500);
}

// ===== Start AI Game =====
function startAIGame(socket, userId, userName) {
  const gameId  = genGameId();
  const aiName  = randomAIName();

  const humanSym = Math.random() > 0.5 ? 'X' : 'O';
  const aiSym    = humanSym === 'X' ? 'O' : 'X';
  const symbols  = { [userId]: humanSym, [AI_ID]: aiSym };
  const firstTurn = parseInt(Object.entries(symbols).find(([, v]) => v === 'X')[0]);

  const gameState = {
    gameId, players: [userId, AI_ID], symbols,
    board: Array(5).fill(null).map(() => Array(5).fill('')),
    currentTurn: firstTurn, status: 'active', isAIGame: true,
    playerNames: { [userId]: userName, [AI_ID]: aiName }
  };

  activeGames.set(gameId, gameState);
  socket.join(gameId);

  // Deduct entry fee
  User.findOneAndUpdate(
    { telegramId: userId, balance: { $gte: ENTRY_FEE } },
    { $inc: { balance: -ENTRY_FEE } }
  ).catch(e => console.error('AI fee err:', e));

  socket.emit('gameStarted', {
    gameId, board: gameState.board, currentTurn: firstTurn,
    players: gameState.playerNames, mySymbol: humanSym,
    isAIGame: true, aiName
  });

  if (firstTurn === AI_ID) {
    scheduleAIMove(gameId);
  } else {
    const t = setTimeout(() => handleTurnTimeout(gameId, userId), TURN_SECONDS * 1000 + 1500);
    gameTurnTimeouts.set(gameId, t);
  }
}

// ===== Socket.IO =====
io.on('connection', (socket) => {
  let myUserId = null;
  let myGameId = null;

  socket.on('findGame', async ({ userId }) => {
    if (!userId) return socket.emit('error', { msg: 'userId မပါ' });
    myUserId = parseInt(userId);
    userSockets.set(myUserId, socket.id);

    // Reconnect to active game
    const existEntry = [...activeGames.entries()].find(([, g]) => g.players.includes(myUserId));
    if (existEntry) {
      const [gid, game] = existEntry;
      myGameId = gid;
      socket.join(gid);
      const sym = game.symbols instanceof Map
        ? game.symbols.get(String(myUserId))
        : game.symbols[myUserId];
      socket.emit('gameResumed', {
        gameId: gid, board: game.board, mySymbol: sym,
        currentTurn: game.currentTurn, players: game.playerNames,
        isAIGame: !!game.isAIGame
      });
      return;
    }

    // ── FIX: always fetch fresh balance from DB ──
    const user = await User.findOne({ telegramId: myUserId }).lean();
    if (!user)         return socket.emit('error', { msg: 'User မတွေ့ပါ' });
    if (user.isBanned) return socket.emit('error', { msg: 'ကောင်ပိတ်ဆို့ထားသည်' });
    if (user.balance < ENTRY_FEE) {
      return socket.emit('insufficientBalance', { balance: user.balance, required: ENTRY_FEE });
    }

    const joinGameId = socket.handshake.query?.join;
    let waiterIdx = -1;
    if (joinGameId) waiterIdx = waitingQueue.findIndex(w => w.gameId === joinGameId && w.userId !== myUserId);
    if (waiterIdx === -1) waiterIdx = waitingQueue.findIndex(w => w.userId !== myUserId);

    if (waiterIdx !== -1) {
      // Match with real player
      const waiter = waitingQueue.splice(waiterIdx, 1)[0];
      myGameId = waiter.gameId;

      const w1 = await User.findOneAndUpdate(
        { telegramId: waiter.userId, balance: { $gte: ENTRY_FEE } },
        { $inc: { balance: -ENTRY_FEE } }, { new: true }
      );
      const w2 = await User.findOneAndUpdate(
        { telegramId: myUserId, balance: { $gte: ENTRY_FEE } },
        { $inc: { balance: -ENTRY_FEE } }, { new: true }
      );

      if (!w1 || !w2) {
        if (w1) await User.findOneAndUpdate({ telegramId: waiter.userId }, { $inc: { balance: ENTRY_FEE } });
        if (w2) await User.findOneAndUpdate({ telegramId: myUserId },      { $inc: { balance: ENTRY_FEE } });
        waitingQueue.push(waiter);
        return socket.emit('error', { msg: 'ငွေ မလုံလောက်ပါ' });
      }

      const waiterUser = await User.findOne({ telegramId: waiter.userId }).lean();
      const symbols = {};
      if (Math.random() > 0.5) { symbols[waiter.userId] = 'X'; symbols[myUserId] = 'O'; }
      else                     { symbols[waiter.userId] = 'O'; symbols[myUserId] = 'X'; }
      const firstTurn = parseInt(Object.entries(symbols).find(([, v]) => v === 'X')[0]);

      const gameState = {
        gameId: myGameId, players: [waiter.userId, myUserId], symbols,
        board: Array(5).fill(null).map(() => Array(5).fill('')),
        currentTurn: firstTurn, status: 'active', isAIGame: false,
        playerNames: {
          [waiter.userId]: waiterUser?.firstName || waiterUser?.username || `User${waiter.userId}`,
          [myUserId]:      user.firstName        || user.username        || `User${myUserId}`
        }
      };

      activeGames.set(myGameId, gameState);
      new Game({ gameId: myGameId, players: gameState.players, symbols: gameState.symbols, status: 'active' })
        .save().catch(e => console.error('Game save:', e));

      socket.join(myGameId);
      const waiterSocket = io.sockets.sockets.get(waiter.socketId);
      if (waiterSocket) waiterSocket.join(myGameId);

      const base = { gameId: myGameId, board: gameState.board, currentTurn: firstTurn, players: gameState.playerNames };
      socket.emit('gameStarted',    { ...base, mySymbol: symbols[myUserId] });
      if (waiterSocket) waiterSocket.emit('gameStarted', { ...base, mySymbol: symbols[waiter.userId] });

      await deleteSearchMsgs(myGameId);
      const t = setTimeout(() => handleTurnTimeout(myGameId, firstTurn), TURN_SECONDS * 1000 + 1500);
      gameTurnTimeouts.set(myGameId, t);

    } else {
      // Queue — wait for real player, fallback to AI
      const gameId = genGameId();
      myGameId = gameId;
      socket.join(gameId);
      waitingQueue.push({ socketId: socket.id, userId: myUserId, gameId });
      socket.emit('waitingForPlayer', { gameId, searchTimeout: SEARCH_TIMEOUT_S });
      notifyUsersGameSearch(myUserId, gameId);

      setTimeout(async () => {
        const idx = waitingQueue.findIndex(w => w.gameId === gameId);
        if (idx !== -1) {
          // No real player joined → start AI game
          waitingQueue.splice(idx, 1);
          await deleteSearchMsgs(gameId);

          const freshU = await User.findOne({ telegramId: myUserId }).select('balance firstName username').lean();
          if (!freshU || freshU.balance < ENTRY_FEE) {
            socket.emit('searchTimeout', { msg: 'ကစားမည့်သူ မတွေ့ပါ' });
            return;
          }
          const uName = freshU.firstName || freshU.username || `User${myUserId}`;
          startAIGame(socket, myUserId, uName);
        }
      }, SEARCH_TIMEOUT_S * 1000);
    }
  });

  socket.on('cancelSearch', async ({ userId }) => {
    const uid = parseInt(userId || myUserId);
    const idx = waitingQueue.findIndex(w => w.userId === uid);
    if (idx !== -1) {
      const { gameId } = waitingQueue[idx];
      waitingQueue.splice(idx, 1);
      await deleteSearchMsgs(gameId);
    }
    socket.emit('searchCancelled');
  });

  socket.on('makeMove', async ({ gameId, row, col }) => {
    const game = activeGames.get(gameId);
    if (!game || game.status !== 'active') return;
    if (game.currentTurn !== myUserId) return socket.emit('error', { msg: 'သင့်လှည့် မဟုတ်ပါ' });
    if (row < 0 || row > 4 || col < 0 || col > 4) return socket.emit('error', { msg: 'Invalid move' });
    if (game.board[row][col] !== '') return socket.emit('error', { msg: 'ထိုနေရာ ယူပြီးသား' });

    clearTurnTimer(gameId);
    const sym = game.symbols[myUserId];
    game.board[row][col] = sym;
    io.to(gameId).emit('moveMade', { row, col, symbol: sym, playerId: myUserId, board: game.board });

    if (checkWin(game.board, sym)) {
      await endGame(gameId, myUserId, 'win');
    } else if (boardFull(game.board)) {
      await endGame(gameId, -1, 'draw');
    } else {
      const next = game.players.find(p => p !== myUserId);
      game.currentTurn = next;
      io.to(gameId).emit('turnChanged', { currentTurn: next });
      if (next === AI_ID) {
        scheduleAIMove(gameId);
      } else {
        const t = setTimeout(() => handleTurnTimeout(gameId, next), TURN_SECONDS * 1000 + 1500);
        gameTurnTimeouts.set(gameId, t);
      }
    }
  });

  socket.on('disconnect', async () => {
    const wIdx = waitingQueue.findIndex(w => w.socketId === socket.id);
    if (wIdx !== -1) {
      const { gameId } = waitingQueue[wIdx];
      waitingQueue.splice(wIdx, 1);
      await deleteSearchMsgs(gameId);
    }
    if (myGameId && activeGames.has(myGameId)) {
      const game = activeGames.get(myGameId);
      if (game?.status === 'active') {
        if (game.isAIGame) {
          await endGame(myGameId, AI_ID, 'disconnect');
        } else {
          const opp = game.players.find(p => p !== myUserId);
          if (opp) {
            const oppSid = userSockets.get(opp);
            if (oppSid) io.to(oppSid).emit('opponentDisconnected', { reconnectWindow: 30 });
            setTimeout(async () => {
              const g = activeGames.get(myGameId);
              if (g?.status === 'active') {
                const newSid = userSockets.get(myUserId);
                if (!newSid || !io.sockets.sockets.get(newSid)) {
                  await endGame(myGameId, opp, 'disconnect');
                }
              }
            }, 30000);
          }
        }
      }
    }
    if (myUserId) userSockets.delete(myUserId);
  });
});

// ===== Admin middleware =====
function isAdmin(req, res, next) {
  const aid = parseInt(req.headers['x-admin-id'] || req.query.adminId);
  if (!aid || aid !== ADMIN_ID) return res.status(403).json({ error: 'Forbidden' });
  next();
}

// ===== Routes =====
app.get('/',       (_, res) => res.json({ ok: true }));
app.get('/health', (_, res) => res.json({
  ok: true, mongodb: isConnected ? 'connected' : 'disconnected',
  activeGames: activeGames.size, queue: waitingQueue.length
}));

// ── Auth — FIX: always fresh from DB, Telegram data persisted properly ──
app.post('/api/auth', async (req, res) => {
  try {
    const { initData, telegramId: devId } = req.body;
    let tid, username, firstName;

    if (initData) {
      const u = verifyTgAuth(initData);
      if (!u) return res.status(401).json({ error: 'Telegram auth မှား' });
      tid = u.id; username = u.username || ''; firstName = u.first_name || '';
    } else if (devId) {
      tid = parseInt(devId); username = ''; firstName = 'User';
    } else {
      return res.status(401).json({ error: 'Auth required' });
    }

    const maint = await getSetting('maintenance', false);
    if (maint && tid !== ADMIN_ID) return res.status(503).json({ error: '🔧 ဆာဗာ ပြင်ဆင်နေပါသည်' });

    // Always read from DB — never use stale in-memory data
    let user = await User.findOne({ telegramId: tid });
    if (!user) {
      user = new User({ telegramId: tid, username, firstName, referralCode: genRefCode(tid) });
      await user.save();
    } else {
      let dirty = false;
      if (username  && user.username  !== username)  { user.username  = username;  dirty = true; }
      if (firstName && user.firstName !== firstName) { user.firstName = firstName; dirty = true; }
      if (dirty) await user.save();
    }

    if (user.isBanned) return res.status(403).json({ error: '🚫 ကောင်ပိတ်ဆို့ထားပါသည်' });

    res.json({
      telegramId:   user.telegramId,
      username:     user.username || user.firstName || `User${user.telegramId}`,
      firstName:    user.firstName,
      balance:      user.balance,    // always fresh from DB
      referralCode: user.referralCode,
      totalGames:   user.totalGames,
      wins:         user.wins,
      losses:       user.losses
    });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// ── Fresh user data ──
app.get('/api/user/:id', async (req, res) => {
  try {
    const u = await User.findOne({ telegramId: parseInt(req.params.id) })
      .select('balance totalGames wins losses firstName username').lean();
    if (!u) return res.status(404).json({ error: 'Not found' });
    res.json(u);
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// ── Admin verify by Telegram ID ──
app.post('/api/admin/verify', async (req, res) => {
  const { telegramId } = req.body;
  if (!telegramId) return res.status(400).json({ error: 'Missing telegramId' });
  if (parseInt(telegramId) !== ADMIN_ID) return res.status(403).json({ error: 'Admin မဟုတ်ပါ' });
  res.json({ ok: true, adminId: ADMIN_ID });
});

// ── Referral list ──
app.get('/api/referrals/:telegramId', async (req, res) => {
  try {
    const uid  = parseInt(req.params.telegramId);
    const refs = await User.find({ referredBy: uid })
      .select('firstName username balance createdAt').lean();
    res.json({
      referrals: refs.map(r => ({
        name:     r.firstName || r.username || 'User',
        username: r.username || '',
        balance:  r.balance  || 0,
        joinedAt: r.createdAt
      })),
      total: refs.length
    });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// ── Deposit ──
app.post('/api/deposit', async (req, res) => {
  try {
    const { telegramId, kpayName, transactionId, amount } = req.body;
    if (!telegramId || !kpayName || !transactionId || !amount)
      return res.status(400).json({ error: 'ကွင်းလပ်များ ဖြည့်ပေးပါ' });
    if (parseInt(amount) < 1000) return res.status(400).json({ error: 'အနည်းဆုံး 1,000 MMK' });

    const u = await User.findOne({ telegramId: parseInt(telegramId) }).lean();
    if (!u)         return res.status(404).json({ error: 'User not found' });
    if (u.isBanned) return res.status(403).json({ error: 'ကောင်ပိတ်ဆို့ထားသည်' });

    const dup = await Deposit.findOne({ transactionId }).lean();
    if (dup) return res.status(400).json({ error: 'Transaction ID ကို အသုံးပြုပြီးသည်' });

    const dep = await new Deposit({ userId: u.telegramId, kpayName, transactionId, amount: parseInt(amount) }).save();

    if (bot) bot.telegram.sendMessage(ADMIN_ID,
      `💰 *ငွေသွင်း တောင်းဆိုမှု*\n👤 ${u.firstName || u.username} (${u.telegramId})\n💵 ${parseInt(amount).toLocaleString()} MMK\n📝 ${kpayName}\n🔢 \`${transactionId}\``,
      { parse_mode: 'Markdown' }).catch(() => {});

    res.json({ success: true, depositId: dep._id });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// ── Withdraw — FIX: atomic deduction with proper error message ──
app.post('/api/withdraw', async (req, res) => {
  try {
    const { telegramId, kpayName, kpayNumber, amount } = req.body;
    if (!telegramId || !kpayName || !kpayNumber || !amount)
      return res.status(400).json({ error: 'ကွင်းလပ်များ ဖြည့်ပေးပါ' });
    if (parseInt(amount) < 3000) return res.status(400).json({ error: 'အနည်းဆုံး 3,000 MMK' });

    // Atomic: deduct only if balance >= amount
    const u = await User.findOneAndUpdate(
      { telegramId: parseInt(telegramId), balance: { $gte: parseInt(amount) }, isBanned: false },
      { $inc: { balance: -parseInt(amount) } },
      { new: true }
    );

    if (!u) {
      // Find out exactly why it failed
      const check = await User.findOne({ telegramId: parseInt(telegramId) }).lean();
      if (!check)         return res.status(404).json({ error: 'User not found' });
      if (check.isBanned) return res.status(403).json({ error: 'ကောင်ပိတ်ဆို့ထားသည်' });
      return res.status(400).json({
        error: `လက်ကျန်ငွေ မလုံလောက်ပါ (လက်ကျန်: ${check.balance.toLocaleString()} MMK)`
      });
    }

    const wd = await new Withdrawal({ userId: u.telegramId, kpayName, kpayNumber, amount: parseInt(amount) }).save();

    if (bot) bot.telegram.sendMessage(ADMIN_ID,
      `💸 *ငွေထုတ် တောင်းဆိုမှု*\n👤 ${u.firstName || u.username} (${u.telegramId})\n💵 ${parseInt(amount).toLocaleString()} MMK\n📝 ${kpayName}\n📱 ${kpayNumber}`,
      { parse_mode: 'Markdown' }).catch(() => {});

    res.json({ success: true, withdrawalId: wd._id, newBalance: u.balance });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// ===== Admin Routes =====
app.get('/api/admin/stats', isAdmin, async (_, res) => {
  try {
    const [tu, tg, pd, pw] = await Promise.all([
      User.countDocuments(), Game.countDocuments({ status: 'completed' }),
      Deposit.countDocuments({ status: 'pending' }), Withdrawal.countDocuments({ status: 'pending' })
    ]);
    const [depAgg, wdAgg] = await Promise.all([
      Deposit.aggregate([{ $match: { status: 'confirmed' } }, { $group: { _id: null, t: { $sum: '$amount' } } }]),
      Withdrawal.aggregate([{ $match: { status: 'confirmed' } }, { $group: { _id: null, t: { $sum: '$amount' } } }])
    ]);
    res.json({
      totalUsers: tu, totalGames: tg, pendingDeposits: pd, pendingWithdrawals: pw,
      activeGames: activeGames.size, queueLength: waitingQueue.length,
      totalDeposited: depAgg[0]?.t || 0, totalWithdrawn: wdAgg[0]?.t || 0
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/settings', isAdmin, async (_, res) => {
  const maint = await getSetting('maintenance', false);
  res.json({ maintenance: maint, entryFee: ENTRY_FEE, winPrize: WIN_PRIZE, drawRefund: DRAW_REFUND, turnSeconds: TURN_SECONDS });
});

app.post('/api/admin/maintenance', isAdmin, async (req, res) => {
  await setSetting('maintenance', !!req.body.enabled);
  res.json({ success: true, maintenance: !!req.body.enabled });
});

app.get('/api/admin/deposits', isAdmin, async (req, res) => {
  try {
    const deps = await Deposit.find({ status: req.query.status || 'pending' }).sort({ createdAt: -1 }).limit(50).lean();
    const out = await Promise.all(deps.map(async d => {
      const u = await User.findOne({ telegramId: d.userId }).select('firstName username').lean();
      return { ...d, userName: u?.firstName || u?.username || String(d.userId) };
    }));
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/deposits/:id/confirm', isAdmin, async (req, res) => {
  try {
    const dep = await Deposit.findById(req.params.id);
    if (!dep) return res.status(404).json({ error: 'Not found' });
    if (dep.status !== 'pending') return res.status(400).json({ error: 'Already processed' });
    dep.status = 'confirmed'; dep.processedAt = new Date(); await dep.save();
    await User.findOneAndUpdate({ telegramId: dep.userId }, { $inc: { balance: dep.amount } });

    // Referral bonus on first deposit only
    const user = await User.findOne({ telegramId: dep.userId }).lean();
    if (user?.referredBy) {
      const prevDeps = await Deposit.countDocuments({ userId: dep.userId, status: 'confirmed', _id: { $ne: dep._id } });
      if (prevDeps === 0) {
        await User.findOneAndUpdate({ telegramId: user.referredBy }, { $inc: { balance: 100 } });
        if (bot) bot.telegram.sendMessage(user.referredBy,
          `🎉 သူငယ်ချင်း တစ်ယောက်မှ 1,000 MMK ဖြည့်သောကြောင့် သင် <b>100 MMK</b> ရရှိပါပြီ!`,
          { parse_mode: 'HTML' }).catch(() => {});
      }
    }

    if (bot) bot.telegram.sendMessage(dep.userId,
      `✅ ငွေ ${dep.amount.toLocaleString()} MMK သွင်းမှု အတည်ပြုပြီး!\n\nသင့်လက်ကျန်ငွေ ပေါင်းထည့်ပြီး 🎉`,
      Markup.inlineKeyboard([[Markup.button.webApp('🎮 ကစားမည်', FRONTEND_URL)]])
    ).catch(() => {});

    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/deposits/:id/reject', isAdmin, async (req, res) => {
  try {
    const dep = await Deposit.findByIdAndUpdate(req.params.id, { status: 'rejected', processedAt: new Date() }, { new: true });
    if (!dep) return res.status(404).json({ error: 'Not found' });
    if (bot) bot.telegram.sendMessage(dep.userId,
      `❌ ငွေ ${dep.amount.toLocaleString()} MMK သွင်းမှု ပယ်ချပြီ\nTxn: ${dep.transactionId}`).catch(() => {});
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/withdrawals', isAdmin, async (req, res) => {
  try {
    const wds = await Withdrawal.find({ status: req.query.status || 'pending' }).sort({ createdAt: -1 }).limit(50).lean();
    const out = await Promise.all(wds.map(async w => {
      const u = await User.findOne({ telegramId: w.userId }).select('firstName username balance').lean();
      return { ...w, userName: u?.firstName || u?.username || String(w.userId), userBalance: u?.balance };
    }));
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/withdrawals/:id/confirm', isAdmin, async (req, res) => {
  try {
    const wd = await Withdrawal.findById(req.params.id);
    if (!wd) return res.status(404).json({ error: 'Not found' });
    if (wd.status !== 'pending') return res.status(400).json({ error: 'Already processed' });
    wd.status = 'confirmed'; wd.processedAt = new Date(); await wd.save();
    if (bot) bot.telegram.sendMessage(wd.userId,
      `✅ ငွေ ${wd.amount.toLocaleString()} MMK ထုတ်မှု အတည်ပြုပြီး!\nKPay: ${wd.kpayNumber} 🎉`).catch(() => {});
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/withdrawals/:id/reject', isAdmin, async (req, res) => {
  try {
    const wd = await Withdrawal.findById(req.params.id);
    if (!wd) return res.status(404).json({ error: 'Not found' });
    if (wd.status !== 'pending') return res.status(400).json({ error: 'Already processed' });
    wd.status = 'rejected'; wd.processedAt = new Date(); await wd.save();
    await User.findOneAndUpdate({ telegramId: wd.userId }, { $inc: { balance: wd.amount } });
    if (bot) bot.telegram.sendMessage(wd.userId,
      `❌ ငွေ ${wd.amount.toLocaleString()} MMK ထုတ်မှု ပယ်ချပြီး ငွေပြန်အမ်းပြီ`).catch(() => {});
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/users', isAdmin, async (req, res) => {
  try {
    const { search, page = 1 } = req.query;
    const q = search ? { $or: [
      { telegramId: isNaN(search) ? -1 : parseInt(search) },
      { username:   { $regex: search, $options: 'i' } },
      { firstName:  { $regex: search, $options: 'i' } }
    ]} : {};
    const users = await User.find(q).sort({ createdAt: -1 }).skip((page - 1) * 20).limit(20).lean();
    const total = await User.countDocuments(q);
    res.json({ users, total, pages: Math.ceil(total / 20) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/users/:tid/balance', isAdmin, async (req, res) => {
  try {
    const { amount, reason } = req.body;
    const u = await User.findOneAndUpdate(
      { telegramId: parseInt(req.params.tid) }, { $inc: { balance: parseInt(amount) } }, { new: true }
    );
    if (!u) return res.status(404).json({ error: 'Not found' });
    if (bot) {
      const sign = amount > 0 ? '+' : '';
      bot.telegram.sendMessage(u.telegramId,
        `💰 Admin မှ ${sign}${parseInt(amount).toLocaleString()} MMK\n${reason ? `မှတ်ချက်: ${reason}` : ''}\nလက်ကျန်: ${u.balance.toLocaleString()} MMK`
      ).catch(() => {});
    }
    res.json({ success: true, newBalance: u.balance });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/users/:tid/ban', isAdmin, async (req, res) => {
  try {
    const { ban } = req.body;
    const u = await User.findOneAndUpdate({ telegramId: parseInt(req.params.tid) }, { isBanned: !!ban }, { new: true });
    if (!u) return res.status(404).json({ error: 'Not found' });
    if (bot && ban) bot.telegram.sendMessage(u.telegramId, '🚫 ကောင်ပိတ်ဆို့ထားပါသည်။ Admin ကို ဆက်သွယ်ပါ').catch(() => {});
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/broadcast', isAdmin, async (req, res) => {
  try {
    const { message, buttonText, buttonUrl } = req.body;
    if (!message) return res.status(400).json({ error: 'Message required' });
    res.json({ success: true, msg: 'Broadcast started in background' });
    const users = await User.find({ isBanned: false }).select('telegramId').lean();
    const kb = buttonText && buttonUrl ? { inline_keyboard: [[{ text: buttonText, url: buttonUrl }]] } : undefined;
    let sent = 0, fail = 0;
    for (const u of users) {
      try {
        await bot.telegram.sendMessage(u.telegramId, message, { parse_mode: 'HTML', reply_markup: kb });
        sent++; await new Promise(r => setTimeout(r, 50));
      } catch (e) { fail++; }
    }
    console.log(`Broadcast: ${sent} sent, ${fail} failed`);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/message', isAdmin, async (req, res) => {
  try {
    const { telegramId, message } = req.body;
    if (!telegramId || !message) return res.status(400).json({ error: 'Missing fields' });
    await bot.telegram.sendMessage(parseInt(telegramId), message, { parse_mode: 'HTML' });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== Self-ping =====
setInterval(() => {
  try { https.get(`${BACKEND_URL}/health`, () => {}).on('error', () => {}); } catch (e) {}
}, 5 * 60 * 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server on port ${PORT}`));
process.on('unhandledRejection', e => console.error('UnhandledRejection:', e));
process.on('uncaughtException',  e => console.error('UncaughtException:',  e));
