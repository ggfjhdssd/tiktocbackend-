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
  cors: { origin: '*', methods: ['GET','POST'] },
  allowEIO3: true,
  pingTimeout: 30000,
  pingInterval: 10000
});

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = process.env.ADMIN_ID ? parseInt(process.env.ADMIN_ID) : null;
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://tictokfrontend.vercel.app';
const BACKEND_URL = process.env.BACKEND_URL || 'https://tiktocbackend.onrender.com';
const BOT_USERNAME = process.env.BOT_USERNAME || 'tictoe1_bot';
const ENTRY_FEE = 1000;
const WIN_PRIZE = 1600;
const DRAW_REFUND = 500;
const TURN_SECONDS = 10;
const SEARCH_TIMEOUT_S = 30;

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

// ===== Schemas =====
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
  botMode: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});
userSchema.index({ telegramId: 1 });
userSchema.index({ referralCode: 1 });

const depositSchema = new mongoose.Schema({
  userId: { type: Number, required: true },
  kpayName: String,
  transactionId: { type: String, required: true, unique: true },
  amount: { type: Number, required: true },
  status: { type: String, enum: ['pending','confirmed','rejected'], default: 'pending' },
  createdAt: { type: Date, default: Date.now },
  processedAt: Date
});
depositSchema.index({ transactionId: 1 });
depositSchema.index({ status: 1 });

const withdrawalSchema = new mongoose.Schema({
  userId: { type: Number, required: true },
  kpayName: String,
  kpayNumber: String,
  amount: { type: Number, required: true },
  status: { type: String, enum: ['pending','confirmed','rejected'], default: 'pending' },
  createdAt: { type: Date, default: Date.now },
  processedAt: Date
});
withdrawalSchema.index({ status: 1 });

const gameSchema = new mongoose.Schema({
  gameId: { type: String, required: true, unique: true },
  players: [Number],
  playerNames: { type: Map, of: String, default: {} },
  symbols: { type: Map, of: String },
  board: { type: [[String]], default: () => Array(5).fill(null).map(() => Array(5).fill('')) },
  winner: { type: mongoose.Schema.Types.Mixed, default: null },
  winnerName: { type: String, default: '' },
  status: { type: String, enum: ['waiting','active','completed'], default: 'waiting' },
  isAIGame: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now, expires: 86400*30 }
});
gameSchema.index({ gameId: 1 });

const settingsSchema = new mongoose.Schema({
  key: { type: String, unique: true },
  value: mongoose.Schema.Types.Mixed
});

const User = mongoose.model('User', userSchema);
const Deposit = mongoose.model('Deposit', depositSchema);
const Withdrawal = mongoose.model('Withdrawal', withdrawalSchema);
const Game = mongoose.model('Game', gameSchema);
const Settings = mongoose.model('Settings', settingsSchema);

// ===== In-Memory =====
const waitingQueue = [];
const activeGames = new Map();
const gameTurnTimeouts = new Map();
const userSockets = new Map();
const searchNotifications = new Map();

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

function checkWin(board, sym) {
  const dirs = [[0,1],[1,0],[1,1],[1,-1]];
  for (let r=0;r<5;r++) for (let c=0;c<5;c++) {
    if (board[r][c] !== sym) continue;
    for (const [dr,dc] of dirs) {
      let cnt=1;
      for (let i=1;i<4;i++) {
        const nr=r+dr*i,nc=c+dc*i;
        if (nr<0||nr>=5||nc<0||nc>=5||board[nr][nc]!==sym) break;
        cnt++;
      }
      if (cnt>=4) return true;
    }
  }
  return false;
}
function boardFull(board) { return board.every(r=>r.every(c=>c!=='')); }

// ===== AI Config & Brain =====
const AI_ID = -999999;
const AI_NAMES = [
  'Min Khant Kyaw','Thura Aung','Nay Chi Win','Su Myat Noe','Kyaw Zin Htet',
  'Aye Chan Ko','Phyu Phyu Win','Kaung Myat Thu','Zaw_Lin_Htet','Myo_Min_Tun',
  'Ei_Thandar_Phyu','Ko_Phyo_99','Mg_Kaung_Mandalay','Shine_Htet_Aung','AungKyaw2026',
  'Htet_Naing_88','Khin_Su_112','Bo_Bo_Gyi_007','Thin_Zar_9','Kyaw_Kyaw_MM'
];
function randomAIName() { return AI_NAMES[Math.floor(Math.random()*AI_NAMES.length)]; }

const AI_TYPE_EASY = 'easy';
const AI_TYPE_HARD = 'hard';
const AI_TYPE_SABOTAGE = 'sabotage';

function wouldWin(board, r, c, sym) {
  board[r][c] = sym;
  const w = checkWin(board, sym);
  board[r][c] = '';
  return w;
}
function scoreBoard(board, sym, oppSym) {
  const dirs = [[0,1],[1,0],[1,1],[1,-1]];
  let best = null, bestScore = -1;
  for (let r=0;r<5;r++) for (let c=0;c<5;c++) {
    if (board[r][c] !== '') continue;
    let score = (2-Math.abs(r-2)) + (2-Math.abs(c-2));
    for (const [dr,dc] of dirs) {
      let cnt=0, blocked=false;
      for (let i=-3;i<=3;i++) {
        const nr=r+dr*i, nc=c+dc*i;
        if (nr<0||nr>=5||nc<0||nc>=5) continue;
        if (board[nr][nc]===sym) cnt++;
        else if (board[nr][nc]===oppSym) { blocked=true; break; }
      }
      if (!blocked) score += cnt*3;
    }
    if (score > bestScore) { bestScore=score; best={r,c}; }
  }
  return best;
}
function aiPickMove(board, aiSym, humanSym) {
  // 1) Win immediately
  for (let r=0;r<5;r++) for (let c=0;c<5;c++) {
    if (board[r][c]==='' && wouldWin(board,r,c,aiSym)) return {r,c};
  }
  // 2) Block human win
  for (let r=0;r<5;r++) for (let c=0;c<5;c++) {
    if (board[r][c]==='' && wouldWin(board,r,c,humanSym)) return {r,c};
  }
  // 3) Strategic score
  const best = scoreBoard(board, aiSym, humanSym);
  if (best) return best;
  // 4) Fallback
  for (let r=0;r<5;r++) for (let c=0;c<5;c++) {
    if (board[r][c]==='') return {r,c};
  }
  return null;
}

// ---------- HARD AI (minimax) ----------
function minimax(board, depth, alpha, beta, isMax, aiSym, humanSym) {
  if (checkWin(board, aiSym)) return 100 - depth;
  if (checkWin(board, humanSym)) return -100 + depth;
  if (boardFull(board) || depth === 0) return 0;

  if (isMax) {
    let best = -Infinity;
    for (let r=0; r<5; r++) {
      for (let c=0; c<5; c++) {
        if (board[r][c] !== '') continue;
        board[r][c] = aiSym;
        let score = minimax(board, depth-1, alpha, beta, false, aiSym, humanSym);
        board[r][c] = '';
        best = Math.max(best, score);
        alpha = Math.max(alpha, best);
        if (beta <= alpha) break;
      }
    }
    return best;
  } else {
    let best = Infinity;
    for (let r=0; r<5; r++) {
      for (let c=0; c<5; c++) {
        if (board[r][c] !== '') continue;
        board[r][c] = humanSym;
        let score = minimax(board, depth-1, alpha, beta, true, aiSym, humanSym);
        board[r][c] = '';
        best = Math.min(best, score);
        beta = Math.min(beta, best);
        if (beta <= alpha) break;
      }
    }
    return best;
  }
}

function hardAIPickMove(board, aiSym, humanSym) {
  // First, try to win immediately (depth 1)
  for (let r=0;r<5;r++) for (let c=0;c<5;c++) {
    if (board[r][c]==='' && wouldWin(board,r,c,aiSym)) return {r,c};
  }
  // Then, block opponent win
  for (let r=0;r<5;r++) for (let c=0;c<5;c++) {
    if (board[r][c]==='' && wouldWin(board,r,c,humanSym)) return {r,c};
  }
  // Otherwise use minimax depth 4
  let bestScore = -Infinity;
  let bestMove = null;
  for (let r=0; r<5; r++) {
    for (let c=0; c<5; c++) {
      if (board[r][c] !== '') continue;
      board[r][c] = aiSym;
      let score = minimax(board, 4, -Infinity, Infinity, false, aiSym, humanSym);
      board[r][c] = '';
      if (score > bestScore) {
        bestScore = score;
        bestMove = {r,c};
      }
    }
  }
  return bestMove || aiPickMove(board, aiSym, humanSym); // fallback
}

// ===== Hard AI Game Functions =====
function scheduleHardAIMove(gameId) {
  const thinkMs = 3000 + Math.random() * 2000; // 3-5 sec
  setTimeout(async () => {
    const game = activeGames.get(gameId);
    if (!game || game.status !== 'active' || game.currentTurn !== AI_ID) return;
    const humanId = game.players.find(p => p !== AI_ID);
    const aiSym = game.symbols[AI_ID];
    const humanSym = game.symbols[humanId];
    const move = hardAIPickMove(game.board, aiSym, humanSym);
    if (!move) return;
    clearTurnTimer(gameId);
    game.board[move.r][move.c] = aiSym;
    io.to(gameId).emit('moveMade', { row:move.r, col:move.c, symbol:aiSym, playerId:AI_ID, board:game.board });
    if (checkWin(game.board, aiSym)) {
      await endGameAI(gameId, AI_ID, 'win');
    } else if (boardFull(game.board)) {
      await endGameAI(gameId, -1, 'draw');
    } else {
      game.currentTurn = humanId;
      io.to(gameId).emit('turnChanged', { currentTurn: humanId });
      const t = setTimeout(() => handleTurnTimeoutAI(gameId, humanId), TURN_SECONDS*1000+1500);
      gameTurnTimeouts.set(gameId, t);
    }
  }, thinkMs);
}

async function startHardAIGame(socket, userId, gameId, userName) {
  const u = await User.findOneAndUpdate(
    { telegramId: userId, balance: { $gte: ENTRY_FEE }, isBanned: { $ne: true } },
    { $inc: { balance: -ENTRY_FEE } },
    { new: true }
  );
  if (!u) {
    return socket.emit('insufficientBalance', { balance: 0, required: ENTRY_FEE });
  }
  const aiName = randomAIName();
  // Hard AI always goes first (X)
  const symbols = {};
  symbols[userId] = 'O';
  symbols[AI_ID] = 'X';
  const firstTurn = AI_ID;
  const gameState = {
    gameId, players:[userId, AI_ID], symbols,
    board: Array(5).fill(null).map(()=>Array(5).fill('')),
    currentTurn: firstTurn, status:'active', isAIGame:true,
    aiType: AI_TYPE_HARD,
    playerNames: { [userId]: userName, [AI_ID]: aiName }
  };
  activeGames.set(gameId, gameState);
  socket.join(gameId);
  socket.emit('gameStarted', {
    gameId, board: gameState.board, currentTurn: firstTurn,
    players: gameState.playerNames, mySymbol: symbols[userId]
  });
  // AI moves first after a short delay
  scheduleHardAIMove(gameId);
  console.log('HARD AI game started:', gameId, 'User:', userId, 'vs AI:', aiName);
}

// ===== Existing AI game (easy) =====
function scheduleEasyAIMove(gameId) {
  const thinkMs = 3000 + Math.random() * 2000;
  setTimeout(async () => {
    const game = activeGames.get(gameId);
    if (!game || game.status !== 'active' || game.currentTurn !== AI_ID) return;
    const humanId = game.players.find(p => p !== AI_ID);
    const aiSym = game.symbols[AI_ID];
    const humanSym = game.symbols[humanId];
    const move = aiPickMove(game.board, aiSym, humanSym);
    if (!move) return;
    clearTurnTimer(gameId);
    game.board[move.r][move.c] = aiSym;
    io.to(gameId).emit('moveMade', { row:move.r, col:move.c, symbol:aiSym, playerId:AI_ID, board:game.board });
    if (checkWin(game.board, aiSym)) {
      await endGameAI(gameId, AI_ID, 'win');
    } else if (boardFull(game.board)) {
      await endGameAI(gameId, -1, 'draw');
    } else {
      game.currentTurn = humanId;
      io.to(gameId).emit('turnChanged', { currentTurn: humanId });
      const t = setTimeout(() => handleTurnTimeoutAI(gameId, humanId), TURN_SECONDS*1000+1500);
      gameTurnTimeouts.set(gameId, t);
    }
  }, thinkMs);
}

async function startAIGame(socket, userId, gameId, userName) {
  const u = await User.findOneAndUpdate(
    { telegramId: userId, balance: { $gte: ENTRY_FEE }, isBanned: { $ne: true } },
    { $inc: { balance: -ENTRY_FEE } },
    { new: true }
  );
  if (!u) {
    return socket.emit('insufficientBalance', { balance: 0, required: ENTRY_FEE });
  }
  const aiName = randomAIName();
  const symbols = {};
  if (Math.random() > 0.5) { symbols[userId]='X'; symbols[AI_ID]='O'; }
  else { symbols[userId]='O'; symbols[AI_ID]='X'; }
  const firstTurn = parseInt(Object.entries(symbols).find(([,v])=>v==='X')[0]);
  const gameState = {
    gameId, players:[userId, AI_ID], symbols,
    board: Array(5).fill(null).map(()=>Array(5).fill('')),
    currentTurn: firstTurn, status:'active', isAIGame:true,
    aiType: AI_TYPE_EASY,
    playerNames: { [userId]: userName, [AI_ID]: aiName }
  };
  activeGames.set(gameId, gameState);
  socket.join(gameId);
  socket.emit('gameStarted', {
    gameId, board: gameState.board, currentTurn: firstTurn,
    players: gameState.playerNames, mySymbol: symbols[userId]
  });
  if (firstTurn === AI_ID) {
    scheduleEasyAIMove(gameId);
  } else {
    const t = setTimeout(() => handleTurnTimeoutAI(gameId, userId), TURN_SECONDS*1000+1500);
    gameTurnTimeouts.set(gameId, t);
  }
  console.log('AI game started:', gameId, 'User:', userId, 'vs AI:', aiName);
}

// ===== Sabotage AI Game =====
async function startSabotageAIGame(socket, userId, gameId, userName) {
  const u = await User.findOneAndUpdate(
    { telegramId: userId, balance: { $gte: ENTRY_FEE }, isBanned: { $ne: true } },
    { $inc: { balance: -ENTRY_FEE } },
    { new: true }
  );
  if (!u) {
    return socket.emit('insufficientBalance', { balance: 0, required: ENTRY_FEE });
  }
  const aiName = randomAIName();
  const symbols = {};
  if (Math.random() > 0.5) { symbols[userId]='X'; symbols[AI_ID]='O'; }
  else { symbols[userId]='O'; symbols[AI_ID]='X'; }
  const firstTurn = parseInt(Object.entries(symbols).find(([,v])=>v==='X')[0]);
  const gameState = {
    gameId, players:[userId, AI_ID], symbols,
    board: Array(5).fill(null).map(()=>Array(5).fill('')),
    currentTurn: firstTurn, status:'active', isAIGame:true,
    aiType: AI_TYPE_SABOTAGE,
    playerNames: { [userId]: userName, [AI_ID]: aiName }
  };
  activeGames.set(gameId, gameState);
  socket.join(gameId);
  socket.emit('gameStarted', {
    gameId, board: gameState.board, currentTurn: firstTurn,
    players: gameState.playerNames, mySymbol: symbols[userId]
  });
  if (firstTurn === AI_ID) {
    scheduleEasyAIMove(gameId);
  } else {
    const t = setTimeout(() => handleTurnTimeoutAI(gameId, userId), TURN_SECONDS*1000+1500);
    gameTurnTimeouts.set(gameId, t);
  }
  console.log('SABOTAGE AI game started:', gameId, 'User:', userId, 'vs AI:', aiName);
}

async function endGameAI(gameId, winner, reason='normal') {
  const game = activeGames.get(gameId);
  if (!game || game.status !== 'active') return;
  clearTurnTimer(gameId);
  game.status = 'completed';
  const humanId = game.players.find(p => p !== AI_ID);
  try {
    if (winner === -1) {
      if (humanId) await User.findOneAndUpdate({telegramId:humanId},{$inc:{balance:DRAW_REFUND,totalGames:1}});
    } else if (winner === humanId) {
      await User.findOneAndUpdate({telegramId:humanId},{$inc:{balance:WIN_PRIZE,wins:1,totalGames:1}});
    } else {
      if (humanId) await User.findOneAndUpdate({telegramId:humanId},{$inc:{losses:1,totalGames:1}});
    }
    await Game.findOneAndUpdate({gameId},{
      winner, status:'completed', board:game.board,
      playerNames: game.playerNames,
      winnerName: winner===-1 ? 'draw' : (game.playerNames?.[winner] || String(winner)),
      isAIGame: !!game.isAIGame
    },{upsert:true});
  } catch(e){ console.error('endGameAI err:', e); }
  io.to(gameId).emit('gameOver', { winner, reason, board:game.board });
  activeGames.delete(gameId);
}

async function handleTurnTimeoutAI(gameId, playerId) {
  const game = activeGames.get(gameId);
  if (!game || game.status !== 'active' || game.currentTurn !== playerId) return;
  if (playerId === AI_ID) {
    scheduleEasyAIMove(gameId);
  } else {
    await endGameAI(gameId, AI_ID, 'timeout');
  }
}

// ===== Sabotage Helpers =====
function checkWinAfterMove(board, r, c, sym) {
  const boardCopy = board.map(row => [...row]);
  boardCopy[r][c] = sym;
  return checkWin(boardCopy, sym);
}

async function handleSabotage(game, userId, move) {
  const rand = Math.random() * 100;
  if (rand < 40) {
    // Network Lag Error
    io.to(game.gameId).emit('moveError', { message: '⚠️ Connection lost. Please check your internet.' });
    await endGameAI(game.gameId, AI_ID, 'connectionLost');
  } else if (rand < 70) {
    // Time Warp
    game.sabotageTimeWarp = true;
    io.to(game.gameId).emit('turnTimerChanged', { seconds: 1 });
    clearTurnTimer(game.gameId);
    const t = setTimeout(async () => {
      const g = activeGames.get(game.gameId);
      if (g && g.status === 'active' && g.currentTurn === userId) {
        await endGameAI(game.gameId, AI_ID, 'timeout');
      }
    }, 1000);
    gameTurnTimeouts.set(game.gameId, t);
  } else {
    // Ghost Block
    io.to(game.gameId).emit('moveError', { message: '⚠️ Network error. Please try again.' });
    game.currentTurn = AI_ID;
    io.to(game.gameId).emit('turnChanged', { currentTurn: AI_ID });
    scheduleEasyAIMove(game.gameId);
  }
}

// ===== Settings Helpers =====
async function getSetting(key, def) {
  try { const s=await Settings.findOne({key}).lean(); return s?s.value:def; } catch { return def; }
}
async function setSetting(key,value) {
  await Settings.findOneAndUpdate({key},{value},{upsert:true});
}

// ===== Bot =====
let bot = null;
if (BOT_TOKEN) {
  bot = new Telegraf(BOT_TOKEN);

  const CHANNEL_USERNAME = 'EzMoneyPayy'; // channel username without @
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
      if (maint && id !== ADMIN_ID) {
        try {
          await ctx.reply('🔧 ဆာဗာ ပြင်ဆင်နေသောကြောင့် ယာယီပိတ်ထားပါသည်။');
        } catch (e) {
          console.error(`Failed to send maintenance message to ${id}:`, e.message);
        }
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
        await ctx.reply('⚠️ /start ကိုနှိပ်ပါ').catch(()=>{});
        return;
      }
      await ctx.reply(
        `✅ Channel Join အောင်မြင်သည်!\n\n🎮 မင်္ဂလာပါ ${ctx.from.first_name}!\n💰 လက်ကျန်: ${user.balance.toLocaleString()} MMK\n🏆 နိုင်: ${user.wins}  •  ❌ ရှုံး: ${user.losses}`,
        Markup.inlineKeyboard([
          [Markup.button.webApp('🎮 PLAY NOW', FRONTEND_URL)],
          [Markup.button.callback('💰 Balance','bal'), Markup.button.callback('🔗 Referral','ref')]
        ])
      ).catch(()=>{});
    } catch(e) {
      console.error('check_join error:', e.stack || e);
    }
  });

  bot.action('bal', async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(()=>{});
      const u = await User.findOne({ telegramId: ctx.from.id }).lean();
      if (!u) return;
      await ctx.reply(`💰 လက်ကျန်: ${u.balance.toLocaleString()} MMK\n🎮 ကစားမှု: ${u.totalGames}\n🏆 နိုင်: ${u.wins}  •  ❌ ရှုံး: ${u.losses}`,
        Markup.inlineKeyboard([[Markup.button.webApp('🎮 ကစားမည်', FRONTEND_URL)]])
      ).catch(()=>{});
    } catch(e) { console.error('bal error:', e.stack || e); }
  });

  bot.action('ref', async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(()=>{});
      const u = await User.findOne({ telegramId: ctx.from.id }).lean();
      if (!u) return;
      const link = `https://t.me/${BOT_USERNAME}?start=${u.referralCode}`;
      await ctx.reply(
        `🔗 <b>Referral Link</b>\n\nသူငယ်ချင်း တစ်ယောက် 1,000 MMK ဖြည့်တိုင်း သင် <b>100 MMK</b> ရမည်!\n\n<code>${link}</code>`,
        { parse_mode:'HTML', ...Markup.inlineKeyboard([[
          Markup.button.url('📤 Share', `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent('🎮 TicToeTic ကစားပြီးငွေရှာကြစို့!')}`)
        ]])}
      ).catch(()=>{});
    } catch(e) { console.error('ref error:', e.stack || e); }
  });

  bot.action(/^join_(.+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery('ချိတ်ဆက်နေပါသည်...').catch(()=>{});
      const gameId = ctx.match[1];
      const id = ctx.from.id;

      try { await ctx.deleteMessage(); } catch(e){}

      const user = await User.findOne({ telegramId: id }).lean();
      if (!user) {
        await ctx.reply('ဦးစွာ /start နှိပ်ပါ').catch(()=>{});
        return;
      }
      if (user.balance < ENTRY_FEE) {
        await ctx.reply(
          `⚠️ ငွေမလုံလောက်ပါ!\n\nပွဲဝင်ကြေး: ${ENTRY_FEE.toLocaleString()} MMK\nသင့်ကျန်: ${user.balance.toLocaleString()} MMK`,
          Markup.inlineKeyboard([[Markup.button.webApp('💰 ငွေဖြည့်ရန်', FRONTEND_URL)]])
        ).catch(()=>{});
        return;
      }
      await ctx.reply(
        '✅ ပွဲတွင် ဝင်ရောက်ရန် Join ကိုနှိပ်ပါ',
        Markup.inlineKeyboard([[Markup.button.webApp('🎮 JOIN NOW', `${FRONTEND_URL}/play.html?join=${gameId}`)]])
      ).catch(()=>{});
    } catch(e) { console.error('join action err:', e.stack || e); }
  });

  bot.action('dismiss', async (ctx) => {
    try { await ctx.answerCbQuery().catch(()=>{}); await ctx.deleteMessage().catch(()=>{}); } catch(e){}
  });

  bot.command('admin', async (ctx) => {
    try {
      const id = ctx.from.id;
      if (!ADMIN_ID || id !== ADMIN_ID) {
        await ctx.reply('🚫 Admin အကောင့်မဟုတ်ပါ။').catch(()=>{});
        return;
      }
      await ctx.reply(
        `🛡️ <b>Admin Panel</b>\n\nမင်္ဂလာပါ Admin!\n\nAdmin Panel သို့ဝင်ရောက်ရန် ↓`,
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [Markup.button.webApp('🛡️ Admin Panel ဝင်ရန်', `${FRONTEND_URL}/admin.html`)],
          ])
        }
      ).catch(()=>{});
    } catch(e) { console.error('admin cmd err:', e.stack || e); }
  });

  bot.catch((err, ctx) => {
    if (err.response && err.response.error_code === 403) {
      console.log(`User ${ctx?.from?.id || 'unknown'} blocked the bot.`);
    } else {
      console.error('Bot global error:', err, ctx?.update);
    }
  });

  bot.launch().then(()=>console.log('✅ Bot launched')).catch(e=>console.error('Bot launch err:',e));
}

// ===== Notify All Users (with obfuscated username) =====
function obfuscateUsername(username) {
  if (!username) return '';
  if (username.length <= 3) return username;
  return username.substring(0, 3) + '...';
}

async function notifyUsersGameSearch(searcherId, gameId) {
  if (!bot) return;
  try {
    const searcher = await User.findOne({ telegramId: searcherId }).select('firstName username').lean();
    const displayName = searcher?.username
      ? obfuscateUsername(searcher.username)
      : (searcher?.firstName || 'တစ်ယောက်');

    const users = await User.find({
      telegramId: { $ne: searcherId },
      isBanned: { $ne: true }
    }).select('telegramId').lean();

    const sent = [];
    const CHUNK = 30;
    for (let i = 0; i < users.length; i += CHUNK) {
      const batch = users.slice(i, i + CHUNK);
      await Promise.allSettled(batch.map(async u => {
        try {
          const msg = await bot.telegram.sendMessage(u.telegramId,
            `⚡ <b>${displayName}</b> ပွဲရှာနေသည်!\n\n⏱ ${SEARCH_TIMEOUT_S} စက္ကန့်အတွင်း Join မနှိပ်ရင် ပွဲပျောက်မည်\n💰 ဝင်ကြေး: ${ENTRY_FEE.toLocaleString()} MMK  •  🏆 ဆု: ${WIN_PRIZE.toLocaleString()} MMK`,
            { parse_mode:'HTML', reply_markup: { inline_keyboard: [[
              { text:'🎮 ကစားမည်', callback_data:`join_${gameId}` },
              { text:'❌ မကစားဘူး', callback_data:'dismiss' }
            ]]}}
          );
          sent.push({ userId: u.telegramId, msgId: msg.message_id });
        } catch(e) {}
      }));
      if (i + CHUNK < users.length) await new Promise(r => setTimeout(r, 1000));
    }
    searchNotifications.set(gameId, sent);
    console.log(`📢 Notified ${sent.length}/${users.length} users for game ${gameId}`);
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

// ===== Game Logic =====
function clearTurnTimer(gameId) {
  const t = gameTurnTimeouts.get(gameId);
  if (t) { clearTimeout(t); gameTurnTimeouts.delete(gameId); }
}

async function endGame(gameId, winner, reason='normal') {
  const game = activeGames.get(gameId);
  if (!game || game.status !== 'active') return;
  clearTurnTimer(gameId);
  game.status = 'completed';

  try {
    if (winner === -1) {
      for (const pid of game.players) {
        await User.findOneAndUpdate({telegramId:pid},{$inc:{balance:DRAW_REFUND,totalGames:1}});
      }
    } else if (winner) {
      const loser = game.players.find(p=>p!==winner);
      await User.findOneAndUpdate({telegramId:winner},{$inc:{balance:WIN_PRIZE,wins:1,totalGames:1}});
      if (loser) await User.findOneAndUpdate({telegramId:loser},{$inc:{losses:1,totalGames:1}});
    }
    await Game.findOneAndUpdate({gameId},{
      winner, status:'completed', board:game.board,
      playerNames: game.playerNames,
      winnerName: winner===-1 ? 'draw' : (game.playerNames?.[winner] || String(winner)),
      isAIGame: !!game.isAIGame
    },{upsert:true});
  } catch(e){ console.error('endGame err:', e.stack || e); }

  io.to(gameId).emit('gameOver',{winner,reason,board:game.board});
  activeGames.delete(gameId);
  setTimeout(()=>deleteSearchMsgs(gameId),500);
}

// ===== Socket =====
io.on('connection', (socket) => {
  let myUserId = null;
  let myGameId = null;

  socket.on('findGame', async ({userId}) => {
    if (!userId) return socket.emit('error',{msg:'userId မပါ'});
    myUserId = parseInt(userId);
    userSockets.set(myUserId, socket.id);

    const existEntry = [...activeGames.entries()].find(([,g])=>g.players.includes(myUserId));
    if (existEntry) {
      const [gid, game] = existEntry;
      myGameId = gid;
      socket.join(gid);
      socket.emit('gameResumed',{
        gameId:gid, board:game.board,
        mySymbol: game.symbols.get ? game.symbols.get(String(myUserId)) : game.symbols[myUserId],
        currentTurn:game.currentTurn, players:game.playerNames
      });
      return;
    }

    const user = await User.findOne({telegramId:myUserId}).lean();
    if (!user) return socket.emit('error',{msg:'User မတွေ့ပါ'});
    if (user.isBanned===true) return socket.emit('error',{msg:'ကောင်ပိတ်ဆို့ထားသည်'});
    if (user.balance < ENTRY_FEE) {
      return socket.emit('insufficientBalance',{balance:user.balance,required:ENTRY_FEE});
    }

    const allBotMode = await getSetting('allBotMode', false);
    if (allBotMode) {
      const gameId = genGameId();
      myGameId = gameId;
      const uName = user.firstName || user.username || `User${myUserId}`;
      await startHardAIGame(socket, myUserId, gameId, uName);
      return;
    } else if (user.botMode) {
      const gameId = genGameId();
      myGameId = gameId;
      const uName = user.firstName || user.username || `User${myUserId}`;
      await startSabotageAIGame(socket, myUserId, gameId, uName);
      return;
    }

    const joinGameId = socket.handshake.query?.join;
    let waiterIdx = -1;
    if (joinGameId) {
      waiterIdx = waitingQueue.findIndex(w=>w.gameId===joinGameId && w.userId!==myUserId);
    }
    if (waiterIdx === -1) {
      waiterIdx = waitingQueue.findIndex(w=>w.userId!==myUserId);
    }

    if (waiterIdx !== -1) {
      const waiter = waitingQueue.splice(waiterIdx,1)[0];
      myGameId = waiter.gameId;

      try {
        const w1 = await User.findOneAndUpdate({telegramId:waiter.userId,balance:{$gte:ENTRY_FEE}},{$inc:{balance:-ENTRY_FEE}},{new:true});
        const w2 = await User.findOneAndUpdate({telegramId:myUserId,balance:{$gte:ENTRY_FEE}},{$inc:{balance:-ENTRY_FEE}},{new:true});
        if (!w1||!w2) {
          if (w1) await User.findOneAndUpdate({telegramId:waiter.userId},{$inc:{balance:ENTRY_FEE}});
          if (w2) await User.findOneAndUpdate({telegramId:myUserId},{$inc:{balance:ENTRY_FEE}});
          waitingQueue.push(waiter);
          return socket.emit('error',{msg:'ငွေ မလုံလောက်ပါ'});
        }
      } catch(e) {
        waitingQueue.push(waiter);
        return socket.emit('error',{msg:'ငွေ ဆုတ်ယူ မအောင်မြင်ပါ'});
      }

      const waiterUser = await User.findOne({telegramId:waiter.userId}).lean();
      const joinerUser = user;
      const symbols = {};
      if (Math.random()>0.5) { symbols[waiter.userId]='X'; symbols[myUserId]='O'; }
      else { symbols[waiter.userId]='O'; symbols[myUserId]='X'; }
      const firstTurn = parseInt(Object.entries(symbols).find(([,v])=>v==='X')[0]);

      const gameState = {
        gameId:myGameId, players:[waiter.userId,myUserId], symbols,
        board: Array(5).fill(null).map(()=>Array(5).fill('')),
        currentTurn:firstTurn, status:'active',
        playerNames: {
          [waiter.userId]: waiterUser?.firstName||waiterUser?.username||`User${waiter.userId}`,
          [myUserId]: joinerUser?.firstName||joinerUser?.username||`User${myUserId}`
        }
      };
      activeGames.set(myGameId, gameState);
      new Game({gameId:myGameId,players:gameState.players,symbols:gameState.symbols,status:'active'})
        .save().catch(e=>console.error('Game save:',e));

      socket.join(myGameId);
      const waiterSocket = io.sockets.sockets.get(waiter.socketId);
      if (waiterSocket) waiterSocket.join(myGameId);

      const base = {gameId:myGameId,board:gameState.board,currentTurn:firstTurn,players:gameState.playerNames};
      socket.emit('gameStarted',{...base,mySymbol:symbols[myUserId]});
      if (waiterSocket) waiterSocket.emit('gameStarted',{...base,mySymbol:symbols[waiter.userId]});

      await deleteSearchMsgs(myGameId);
      const t = setTimeout(()=>handleTurnTimeout(myGameId,firstTurn),TURN_SECONDS*1000+1500);
      gameTurnTimeouts.set(myGameId,t);

    } else {
      const gameId = genGameId();
      myGameId = gameId;
      socket.join(gameId);
      waitingQueue.push({socketId:socket.id,userId:myUserId,gameId});
      socket.emit('waitingForPlayer',{gameId,searchTimeout:SEARCH_TIMEOUT_S});
      notifyUsersGameSearch(myUserId, gameId);

      setTimeout(async()=>{
        const idx=waitingQueue.findIndex(w=>w.gameId===gameId);
        if (idx===-1) return;
        waitingQueue.splice(idx,1);
        await deleteSearchMsgs(gameId);
        if (!socket.connected) return;
        const freshUser = await User.findOne({telegramId:myUserId}).lean();
        if (!freshUser || freshUser.balance < ENTRY_FEE) {
          return socket.emit('insufficientBalance', {balance: freshUser?.balance||0, required: ENTRY_FEE});
        }
        const uName = freshUser.firstName || freshUser.username || `User${myUserId}`;
        await startAIGame(socket, myUserId, gameId, uName);
      }, SEARCH_TIMEOUT_S*1000);
    }
  });

  socket.on('cancelSearch', async ({userId}) => {
    const uid = parseInt(userId||myUserId);
    const idx = waitingQueue.findIndex(w=>w.userId===uid);
    if (idx!==-1) {
      const {gameId} = waitingQueue[idx];
      waitingQueue.splice(idx,1);
      await deleteSearchMsgs(gameId);
    }
    socket.emit('searchCancelled');
  });

  socket.on('makeMove', async ({gameId,row,col}) => {
    const game = activeGames.get(gameId);
    if (!game||game.status!=='active') return;
    if (game.currentTurn!==myUserId) return socket.emit('error',{msg:'သင့်လှည့် မဟုတ်ပါ'});
    if (row<0||row>4||col<0||col>4) return socket.emit('error',{msg:'Invalid move'});
    if (game.board[row][col]!=='') return socket.emit('error',{msg:'ထိုနေရာ ယူပြီးသား'});

    const sym = game.symbols[myUserId];

    // ----- Sabotage check -----
    if (game.aiType === AI_TYPE_SABOTAGE && checkWinAfterMove(game.board, row, col, sym)) {
      // User is about to win – trigger sabotage
      clearTurnTimer(gameId);
      await handleSabotage(game, myUserId, {row, col});
      return;
    }

    // Normal move processing
    clearTurnTimer(gameId);
    game.board[row][col] = sym;

    io.to(gameId).emit('moveMade',{row,col,symbol:sym,playerId:myUserId,board:game.board});

    if (checkWin(game.board,sym)) {
      if (game.isAIGame) await endGameAI(gameId,myUserId,'win');
      else await endGame(gameId,myUserId,'win');
    } else if (boardFull(game.board)) {
      if (game.isAIGame) await endGameAI(gameId,-1,'draw');
      else await endGame(gameId,-1,'draw');
    } else {
      const next = game.players.find(p=>p!==myUserId);
      game.currentTurn = next;
      io.to(gameId).emit('turnChanged',{currentTurn:next});
      if (next === AI_ID) {
        if (game.aiType === AI_TYPE_HARD) {
          scheduleHardAIMove(gameId);
        } else {
          scheduleEasyAIMove(gameId);
        }
      } else {
        const t = setTimeout(()=>handleTurnTimeout(gameId,next),TURN_SECONDS*1000+1500);
        gameTurnTimeouts.set(gameId,t);
      }
    }
  });

  socket.on('disconnect', async () => {
    const wIdx = waitingQueue.findIndex(w=>w.socketId===socket.id);
    if (wIdx!==-1) {
      const {gameId} = waitingQueue[wIdx];
      waitingQueue.splice(wIdx,1);
      await deleteSearchMsgs(gameId);
    }
    if (myGameId && activeGames.has(myGameId)) {
      const game = activeGames.get(myGameId);
      if (game?.status==='active') {
        if (game.isAIGame) {
          setTimeout(async()=>{
            const g = activeGames.get(myGameId);
            if (g?.status==='active') {
              const newSid = userSockets.get(myUserId);
              if (!newSid||!io.sockets.sockets.get(newSid)) {
                await endGameAI(myGameId, AI_ID, 'disconnect');
              }
            }
          }, 30000);
        } else {
          const opp = game.players.find(p=>p!==myUserId);
          if (opp) {
            const oppSid = userSockets.get(opp);
            if (oppSid) io.to(oppSid).emit('opponentDisconnected',{reconnectWindow:30});
            setTimeout(async()=>{
              const g = activeGames.get(myGameId);
              if (g?.status==='active') {
                const newSid = userSockets.get(myUserId);
                if (!newSid||!io.sockets.sockets.get(newSid)) {
                  await endGame(myGameId,opp,'disconnect');
                }
              }
            },30000);
          }
        }
      }
    }
    if (myUserId) userSockets.delete(myUserId);
  });

  async function handleTurnTimeout(gameId, playerId) {
    const game = activeGames.get(gameId);
    if (!game||game.status!=='active'||game.currentTurn!==playerId) return;
    const opp = game.players.find(p=>p!==playerId);
    await endGame(gameId,opp,'timeout');
  }
});

// ===== Admin middleware =====
function isAdmin(req,res,next) {
  const aid = parseInt(req.headers['x-admin-id']||req.query.adminId);
  if (!aid||aid!==ADMIN_ID) return res.status(403).json({error:'Forbidden'});
  next();
}

// Admin identity verification endpoint
app.post('/api/admin/verify', async(req,res)=>{
  try {
    const {telegramId}=req.body;
    if (!telegramId) return res.status(400).json({error:'telegramId required'});
    const tid=parseInt(telegramId);
    if (!ADMIN_ID||tid!==ADMIN_ID) return res.status(403).json({error:'Admin မဟုတ်ပါ'});
    res.json({ok:true,adminId:tid});
  } catch(e){ res.status(500).json({error:'Server error'}); }
});

// ===== Routes =====
app.get('/', (_,res)=>res.json({ok:true}));
app.get('/health', (_,res)=>res.json({
  ok:true, mongodb:isConnected?'connected':'disconnected',
  activeGames:activeGames.size, queue:waitingQueue.length
}));

app.post('/api/auth', async(req,res)=>{
  try {
    const {initData,telegramId:devId} = req.body;
    let tid,username,firstName;
    if (initData) {
      const u=verifyTgAuth(initData);
      if (!u) return res.status(401).json({error:'Telegram auth မှား'});
      tid=u.id; username=u.username||''; firstName=u.first_name||'';
    } else if (devId) {
      tid=parseInt(devId); username=''; firstName='User';
    } else return res.status(401).json({error:'Auth required'});

    const maint=await getSetting('maintenance',false);
    if (maint&&tid!==ADMIN_ID) return res.status(503).json({error:'🔧 ဆာဗာ ပြင်ဆင်နေပါသည်'});

    let user=await User.findOne({telegramId:tid});
    if (!user) {
      user=new User({telegramId:tid,username,firstName,referralCode:genRefCode(tid)});
      await user.save();
    } else {
      let d=false;
      if (username&&user.username!==username){user.username=username;d=true;}
      if (firstName&&user.firstName!==firstName){user.firstName=firstName;d=true;}
      if (d) await user.save();
    }
    if (user.isBanned) return res.status(403).json({error:'🚫 ကောင်ပိတ်ဆို့ထားပါသည်'});
    res.json({
      telegramId:user.telegramId,
      username:user.username||user.firstName||`User${user.telegramId}`,
      firstName:user.firstName,
      balance:user.balance,
      referralCode:user.referralCode,
      totalGames:user.totalGames,
      wins:user.wins,
      losses:user.losses,
      botMode:user.botMode
    });
  } catch(e){ console.error(e); res.status(500).json({error:'Server error'}); }
});

app.get('/api/user/:id', async(req,res)=>{
  try {
    const u=await User.findOne({telegramId:parseInt(req.params.id)}).select('balance totalGames wins losses botMode').lean();
    if (!u) return res.status(404).json({error:'Not found'});
    res.json(u);
  } catch(e){ res.status(500).json({error:'Server error'}); }
});

app.post('/api/deposit', async(req,res)=>{
  try {
    const {telegramId,kpayName,transactionId,amount}=req.body;
    if (!telegramId||!kpayName||!transactionId||!amount)
      return res.status(400).json({error:'ကွင်းလပ်များ ဖြည့်ပေးပါ'});
    if (parseInt(amount)<1000)
      return res.status(400).json({error:'အနည်းဆုံး 1,000 MMK'});
    const u=await User.findOne({telegramId:parseInt(telegramId)}).lean();
    if (!u) return res.status(404).json({error:'User not found'});
    if (u.isBanned) return res.status(403).json({error:'ကောင်ပိတ်ဆို့ထားသည်'});
    const dup=await Deposit.findOne({transactionId}).lean();
    if (dup) return res.status(400).json({error:'Transaction ID ကို အသုံးပြုပြီးသည်'});
    const dep=await new Deposit({userId:u.telegramId,kpayName,transactionId,amount:parseInt(amount)}).save();
    if (bot) bot.telegram.sendMessage(ADMIN_ID,
      `💰 *ငွေသွင်း တောင်းဆိုမှု*\n👤 ${u.firstName||u.username} (${u.telegramId})\n💵 ${parseInt(amount).toLocaleString()} MMK\n📝 ${kpayName}\n🔢 \`${transactionId}\``,
      {parse_mode:'Markdown'}).catch(()=>{});
    res.json({success:true,depositId:dep._id});
  } catch(e){ console.error(e); res.status(500).json({error:'Server error'}); }
});

app.post('/api/withdraw', async(req,res)=>{
  try {
    const {telegramId,kpayName,kpayNumber,amount}=req.body;
    if (!telegramId||!kpayName||!kpayNumber||!amount)
      return res.status(400).json({error:'ကွင်းလပ်များ ဖြည့်ပေးပါ'});
    const amt=parseInt(amount);
    if (isNaN(amt)||amt<3000)
      return res.status(400).json({error:'အနည်းဆုံး 3,000 MMK'});
    const tid=parseInt(telegramId);

    const chk=await User.findOne({telegramId:tid}).select('balance isBanned firstName username').lean();
    if (!chk) return res.status(404).json({error:'User မတွေ့ပါ'});
    if (chk.isBanned===true) return res.status(403).json({error:'🚫 ကောင်ပိတ်ဆို့ထားသည်'});
    if (chk.balance<amt) return res.status(400).json({error:`လက်ကျန်ငွေ မလုံလောက်ပါ (ကျန်: ${chk.balance.toLocaleString()} MMK)`});

    let wd;
    try {
      wd=await new Withdrawal({userId:tid,kpayName,kpayNumber,amount:amt}).save();
    } catch(saveErr) {
      console.error('Withdrawal record save err:',saveErr);
      return res.status(500).json({error:'Record သိမ်းမရပါ၊ ထပ်ကြိုးစားပါ'});
    }

    const u=await User.findOneAndUpdate(
      {telegramId:tid, balance:{$gte:amt}, isBanned:{$ne:true}},
      {$inc:{balance:-amt}},
      {new:true}
    );
    if (!u) {
      await Withdrawal.findByIdAndDelete(wd._id).catch(()=>{});
      const rechk=await User.findOne({telegramId:tid}).select('balance isBanned').lean();
      if (rechk?.isBanned===true) return res.status(403).json({error:'🚫 ကောင်ပိတ်ဆို့ထားသည်'});
      return res.status(400).json({error:`လက်ကျန်ငွေ မလုံလောက်ပါ (ကျန်: ${(rechk?.balance||0).toLocaleString()} MMK)`});
    }

    if (bot) bot.telegram.sendMessage(ADMIN_ID,
      `💸 *ငွေထုတ် တောင်းဆိုမှု*\n👤 ${u.firstName||u.username} (${u.telegramId})\n💵 ${amt.toLocaleString()} MMK\n📝 ${kpayName}\n📱 ${kpayNumber}\n🏦 ကျန်: ${u.balance.toLocaleString()} MMK`,
      {parse_mode:'Markdown'}).catch(()=>{});
    res.json({success:true,withdrawalId:wd._id,newBalance:u.balance});
  } catch(e){ console.error('withdraw err:',e); res.status(500).json({error:'Server error'}); }
});

app.get('/api/referrals/:telegramId', async(req,res)=>{
  try {
    const tid = parseInt(req.params.telegramId);
    if (isNaN(tid)) return res.status(400).json({error:'Invalid ID'});
    const referrals = await User.find({ referredBy: tid })
      .select('firstName username balance createdAt')
      .sort({ createdAt: -1 })
      .lean();
    const list = referrals.map(u => ({
      name: u.firstName || u.username || `User${u.telegramId}`,
      username: u.username || '',
      balance: u.balance || 0,
      joinedAt: u.createdAt
    }));
    res.json({ total: list.length, referrals: list });
  } catch(e) { res.status(500).json({error:e.message}); }
});

// ===== Game History Admin Routes =====
app.get('/api/admin/games', isAdmin, async(req,res)=>{
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
        if (pid === -999999) { pNames[pid]='🤖 AI'; continue; }
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

app.delete('/api/admin/games/:gameId', isAdmin, async(req,res)=>{
  try {
    const g = await Game.findOne({gameId:req.params.gameId}).lean();
    if (!g) return res.status(404).json({error:'Game not found'});
    if (g.status==='completed' && g.winner && g.winner !== -1 && g.winner !== -999999) {
      await User.findOneAndUpdate({telegramId:g.winner},{$inc:{balance:-WIN_PRIZE,wins:-1,totalGames:-1}});
      const loser = (g.players||[]).find(p=>p!==g.winner&&p!==-999999);
      if (loser) await User.findOneAndUpdate({telegramId:loser},{$inc:{losses:-1,totalGames:-1}});
    } else if (g.status==='completed' && g.winner===-1) {
      for (const pid of (g.players||[])) {
        if (pid===-999999) continue;
        await User.findOneAndUpdate({telegramId:pid},{$inc:{balance:-DRAW_REFUND,totalGames:-1}});
      }
    }
    await Game.deleteOne({gameId:req.params.gameId});
    res.json({success:true});
  } catch(e){ res.status(500).json({error:e.message}); }
});

// ===== Admin Routes =====
app.get('/api/admin/stats', isAdmin, async(_,res)=>{
  try {
    const [tu,tg,pd,pw]=await Promise.all([
      User.countDocuments(),
      Game.countDocuments({status:'completed'}),
      Deposit.countDocuments({status:'pending'}),
      Withdrawal.countDocuments({status:'pending'})
    ]);
    const [depAgg,wdAgg]=await Promise.all([
      Deposit.aggregate([{$match:{status:'confirmed'}},{$group:{_id:null,t:{$sum:'$amount'}}}]),
      Withdrawal.aggregate([{$match:{status:'confirmed'}},{$group:{_id:null,t:{$sum:'$amount'}}}])
    ]);
    res.json({
      totalUsers:tu,totalGames:tg,pendingDeposits:pd,pendingWithdrawals:pw,
      activeGames:activeGames.size,queueLength:waitingQueue.length,
      totalDeposited:depAgg[0]?.t||0,totalWithdrawn:wdAgg[0]?.t||0
    });
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.get('/api/admin/settings', isAdmin, async(_,res)=>{
  const maint = await getSetting('maintenance',false);
  const allBotMode = await getSetting('allBotMode', false);
  res.json({maintenance:maint, allBotMode, entryFee:ENTRY_FEE, winPrize:WIN_PRIZE, drawRefund:DRAW_REFUND, turnSeconds:TURN_SECONDS});
});

app.post('/api/admin/maintenance', isAdmin, async(req,res)=>{
  await setSetting('maintenance',!!req.body.enabled);
  res.json({success:true,maintenance:!!req.body.enabled});
});

app.get('/api/admin/allbotmode', isAdmin, async(req,res)=>{
  const allBotMode = await getSetting('allBotMode', false);
  res.json({allBotMode});
});

app.post('/api/admin/allbotmode', isAdmin, async(req,res)=>{
  await setSetting('allBotMode', !!req.body.enabled);
  res.json({success:true, allBotMode: !!req.body.enabled});
});

app.get('/api/admin/deposits', isAdmin, async(req,res)=>{
  try {
    const deps=await Deposit.find({status:req.query.status||'pending'}).sort({createdAt:-1}).limit(50).lean();
    const out=await Promise.all(deps.map(async d=>{
      const u=await User.findOne({telegramId:d.userId}).select('firstName username').lean();
      return {...d,userName:u?.firstName||u?.username||String(d.userId)};
    }));
    res.json(out);
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.post('/api/admin/deposits/:id/confirm', isAdmin, async(req,res)=>{
  try {
    const dep=await Deposit.findById(req.params.id);
    if (!dep) return res.status(404).json({error:'Not found'});
    if (dep.status!=='pending') return res.status(400).json({error:'Already processed'});
    dep.status='confirmed'; dep.processedAt=new Date(); await dep.save();
    await User.findOneAndUpdate({telegramId:dep.userId},{$inc:{balance:dep.amount}});
    const user=await User.findOne({telegramId:dep.userId}).lean();
    if (user?.referredBy) {
      const prevDeps=await Deposit.countDocuments({userId:dep.userId,status:'confirmed',_id:{$ne:dep._id}});
      if (prevDeps===0) {
        await User.findOneAndUpdate({telegramId:user.referredBy},{$inc:{balance:100}});
        if (bot) bot.telegram.sendMessage(user.referredBy,
          `🎉 သင့် referral မှ ငွေဖြည့်သောကြောင့် <b>100 MMK</b> ရရှိပါပြီ!`,
          {parse_mode:'HTML'}).catch(()=>{});
      }
    }
    if (bot) bot.telegram.sendMessage(dep.userId,
      `✅ ငွေ ${dep.amount.toLocaleString()} MMK သွင်းမှု အတည်ပြုပြီး!\n\nသင့်လက်ကျန်ငွေ ပေါင်းထည့်ပြီး 🎉`,
      Markup.inlineKeyboard([[Markup.button.webApp('🎮 ကစားမည်', FRONTEND_URL)]]) ).catch(()=>{});
    res.json({success:true});
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.post('/api/admin/deposits/:id/reject', isAdmin, async(req,res)=>{
  try {
    const { reason } = req.body;
    const dep=await Deposit.findByIdAndUpdate(req.params.id,{status:'rejected',processedAt:new Date()},{new:true});
    if (!dep) return res.status(404).json({error:'Not found'});
    const reasonText = reason ? `\nအကြောင်းပြချက်: ${reason}` : '';
    if (bot) bot.telegram.sendMessage(dep.userId,
      `❌ ငွေ ${dep.amount.toLocaleString()} MMK သွင်းမှု ပယ်ချပြီ\nTxn: ${dep.transactionId}${reasonText}`).catch(()=>{});
    res.json({success:true});
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.get('/api/admin/withdrawals', isAdmin, async(req,res)=>{
  try {
    const wds=await Withdrawal.find({status:req.query.status||'pending'}).sort({createdAt:-1}).limit(50).lean();
    const out=await Promise.all(wds.map(async w=>{
      const u=await User.findOne({telegramId:w.userId}).select('firstName username balance').lean();
      return {...w,userName:u?.firstName||u?.username||String(w.userId),userBalance:u?.balance};
    }));
    res.json(out);
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.post('/api/admin/withdrawals/:id/confirm', isAdmin, async(req,res)=>{
  try {
    const wd=await Withdrawal.findById(req.params.id);
    if (!wd) return res.status(404).json({error:'Not found'});
    if (wd.status!=='pending') return res.status(400).json({error:'Already processed'});
    wd.status='confirmed'; wd.processedAt=new Date(); await wd.save();
    if (bot) bot.telegram.sendMessage(wd.userId,
      `✅ ငွေ ${wd.amount.toLocaleString()} MMK ထုတ်မှု အတည်ပြုပြီး!\nKPay: ${wd.kpayNumber} 🎉`).catch(()=>{});
    res.json({success:true});
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.post('/api/admin/withdrawals/:id/reject', isAdmin, async(req,res)=>{
  try {
    const wd=await Withdrawal.findById(req.params.id);
    if (!wd) return res.status(404).json({error:'Not found'});
    if (wd.status!=='pending') return res.status(400).json({error:'Already processed'});
    wd.status='rejected'; wd.processedAt=new Date(); await wd.save();
    await User.findOneAndUpdate({telegramId:wd.userId},{$inc:{balance:wd.amount}});
    if (bot) bot.telegram.sendMessage(wd.userId,
      `❌ ငွေ ${wd.amount.toLocaleString()} MMK ထုတ်မှု ပယ်ချပြီး ငွေပြန်အမ်းပြီ`).catch(()=>{});
    res.json({success:true});
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.get('/api/admin/users', isAdmin, async(req,res)=>{
  try {
    const {search,page=1}=req.query;
    const q=search?{$or:[
      {telegramId:isNaN(search)?-1:parseInt(search)},
      {username:{$regex:search,$options:'i'}},
      {firstName:{$regex:search,$options:'i'}}
    ]}:{};
    const users=await User.find(q).sort({createdAt:-1}).skip((page-1)*20).limit(20).lean();
    const total=await User.countDocuments(q);
    res.json({users,total,pages:Math.ceil(total/20)});
  } catch(e){ res.status(500).json({error:e.message}); }
});

// NEW: High Balancers endpoint (balance >= 4000)
app.get('/api/admin/high-balancers', isAdmin, async(req,res)=>{
  try {
    const highUsers = await User.find({ balance: { $gte: 4000 }, isBanned: { $ne: true } })
      .sort({ balance: -1 })
      .lean();
    // For each user, get total deposited amount from confirmed deposits
    const enriched = await Promise.all(highUsers.map(async u => {
      const deposits = await Deposit.aggregate([
        { $match: { userId: u.telegramId, status: 'confirmed' } },
        { $group: { _id: null, total: { $sum: '$amount' } } }
      ]);
      const totalDeposited = deposits[0]?.total || 0;
      return {
        telegramId: u.telegramId,
        username: u.username,
        firstName: u.firstName,
        balance: u.balance,
        totalDeposited,
        botMode: u.botMode,
        isBanned: u.isBanned
      };
    }));
    res.json(enriched);
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.post('/api/admin/users/:tid/balance', isAdmin, async(req,res)=>{
  try {
    const {amount,reason}=req.body;
    const u=await User.findOneAndUpdate({telegramId:parseInt(req.params.tid)},{$inc:{balance:parseInt(amount)}},{new:true});
    if (!u) return res.status(404).json({error:'Not found'});
    if (bot) {
      const sign=amount>0?'+':'';
      bot.telegram.sendMessage(u.telegramId,
        `💰 Admin မှ ${sign}${parseInt(amount).toLocaleString()} MMK\n${reason?`မှတ်ချက်: ${reason}`:''}\nလက်ကျန်: ${u.balance.toLocaleString()} MMK`).catch(()=>{});
    }
    res.json({success:true,newBalance:u.balance});
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.post('/api/admin/users/:tid/ban', isAdmin, async(req,res)=>{
  try {
    const {ban}=req.body;
    const u=await User.findOneAndUpdate({telegramId:parseInt(req.params.tid)},{isBanned:!!ban},{new:true});
    if (!u) return res.status(404).json({error:'Not found'});
    if (bot&&ban) bot.telegram.sendMessage(u.telegramId,'🚫 ကောင်ပိတ်ဆို့ထားပါသည်။ Admin ကို ဆက်သွယ်ပါ').catch(()=>{});
    res.json({success:true});
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.post('/api/admin/users/:tid/botmode', isAdmin, async(req,res)=>{
  try {
    const {enabled}=req.body;
    const u=await User.findOneAndUpdate({telegramId:parseInt(req.params.tid)},{botMode:!!enabled},{new:true});
    if (!u) return res.status(404).json({error:'User not found'});
    res.json({success:true, botMode:u.botMode});
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.post('/api/admin/broadcast', isAdmin, async(req,res)=>{
  try {
    const {message,buttonText,buttonUrl}=req.body;
    if (!message) return res.status(400).json({error:'Message required'});
    res.json({success:true,msg:'Broadcast started in background'});
    setImmediate(async()=>{
      const users=await User.find({isBanned:{$ne:true}}).select('telegramId').lean();
      const kb=buttonText&&buttonUrl?{inline_keyboard:[[{text:buttonText,url:buttonUrl}]]}:undefined;
      let sent=0,fail=0;
      const CHUNK=30;
      for (let i=0;i<users.length;i+=CHUNK) {
        const batch=users.slice(i,i+CHUNK);
        await Promise.allSettled(batch.map(async u=>{
          try {
            await bot.telegram.sendMessage(u.telegramId,message,{parse_mode:'HTML',reply_markup:kb});
            sent++;
          } catch(e){fail++;}
        }));
        if (i+CHUNK<users.length) await new Promise(r=>setTimeout(r,1000));
      }
      console.log(`Broadcast done: ${sent} sent, ${fail} failed / ${users.length} total`);
    });
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.post('/api/admin/message', isAdmin, async(req,res)=>{
  try {
    const {telegramId,message}=req.body;
    if (!telegramId||!message) return res.status(400).json({error:'Missing fields'});
    await bot.telegram.sendMessage(parseInt(telegramId),message,{parse_mode:'HTML'});
    res.json({success:true});
  } catch(e){ res.status(500).json({error:e.message}); }
});

// ===== Self-ping =====
setInterval(()=>{
  try { https.get(`${BACKEND_URL}/health`,()=>{}).on('error',()=>{}); } catch(e){}
}, 5*60*1000);

// ===== Global unhandled rejection/exception handlers =====
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

const PORT = process.env.PORT||3000;
server.listen(PORT, ()=>console.log(`🚀 Server on port ${PORT}`));
