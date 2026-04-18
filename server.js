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
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://tictokfrontend.vercel.app';
const BACKEND_URL = process.env.BACKEND_URL || 'https://tiktocbackend-zktq.onrender.com';
const BOT_USERNAME = process.env.BOT_USERNAME || 'tictoe1_bot';
const ENTRY_FEE = 500;
const WIN_PRIZE = 800;
const DRAW_REFUND = 400;

// ── Feature 2: Multi-Tier Bet — exact reward table ──
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

// ── Seed agent payment info on startup ──
// Sets Nang pauk's kpay for agent with referralCode TIC3W2ZCO6CXBK
async function seedAgentPaymentInfo() {
  try {
    const agentUser = await User.findOne({ referralCode: 'TIC3W2ZCO6CXBK', role: 'agent' }).lean();
    if (!agentUser) return; // agent not yet registered
    const existing = await Agent.findOne({ telegramId: agentUser.telegramId }).lean();
    if (existing && existing.agentKpayNumber === '09781317607') return; // already seeded
    await Agent.findOneAndUpdate(
      { telegramId: agentUser.telegramId },
      { $set: { agentKpayNumber: '09781317607', agentKpayName: 'Nang pauk', hasWave: false } },
      { upsert: false }
    );
    console.log('✅ Seeded Nang pauk kpay info for agent TIC3W2ZCO6CXBK');
  } catch(e) { console.error('seedAgentPaymentInfo err:', e.message); }
}
setTimeout(seedAgentPaymentInfo, 5000); // run after DB connects

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
  role: { type: String, enum: ['user','agent'], default: 'user' },
  kpayNumber: { type: String, default: '' },
  waveNumber: { type: String, default: '' },
  referralTree: {
    l1Agent: { type: Number, default: null },
    l2Agent: { type: Number, default: null },
    l3Agent: { type: Number, default: null }
  },
  botMode: { type: Boolean, default: false },
  botMatchCount: { type: Number, default: 0 },
  lastActive: { type: Date, default: Date.now },
  createdAt: { type: Date, default: Date.now },
  // ── Feature 1: First Deposit Bonus & Turnover ──
  isFirstDepositUsed: { type: Boolean, default: false },
  turnoverTarget:     { type: Number,  default: 0 },
  turnoverProgress:   { type: Number,  default: 0 },
  // ── Feature 3: Rescue Bonus (consecutive losses counter) ──
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
  processedBy: { type: String, enum: ['admin','agent'], default: 'admin' }, // who confirmed/rejected
  createdAt: { type: Date, default: Date.now },
  processedAt: Date,
  expireAt: { type: Date, default: null } // TTL: auto-delete after 72h (set on confirm/reject)
});
depositSchema.index({ transactionId: 1 });
depositSchema.index({ status: 1 });
depositSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 }); // MongoDB TTL index

const withdrawalSchema = new mongoose.Schema({
  userId: { type: Number, required: true },
  kpayName: String,
  kpayNumber: String,
  amount: { type: Number, required: true },
  paymentMethod: { type: String, enum: ['kpay','wave'], default: 'kpay' },
  status: { type: String, enum: ['pending','confirmed','rejected'], default: 'pending' },
  createdAt: { type: Date, default: Date.now },
  processedAt: Date,
  expireAt: { type: Date, default: null } // TTL: auto-delete after 72h (set on confirm/reject)
});
withdrawalSchema.index({ status: 1 });
withdrawalSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 }); // MongoDB TTL index

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


const redeemCodeSchema = new mongoose.Schema({
  code:       { type: String, required: true, unique: true, uppercase: true, trim: true },
  amount:     { type: Number, required: true },          // MMK to award
  maxUses:    { type: Number, default: 1 },              // max redemptions (0 = unlimited)
  usedBy:     [{ type: Number }],                        // telegramId list
  isActive:   { type: Boolean, default: true },
  createdAt:  { type: Date, default: Date.now }
});
redeemCodeSchema.index({ code: 1 });

// ===== Agent Schema =====
const agentSchema = new mongoose.Schema({
  telegramId:    { type: Number, required: true, unique: true },
  referralCode:  { type: String },           // same as User.referralCode
  // Agent-specific payment info (shown to users on deposit page)
  agentKpayNumber:  { type: String, default: '' },  // e.g. 09781317607
  agentKpayName:    { type: String, default: '' },  // e.g. Nang pauk
  agentWaveNumber:  { type: String, default: '' },
  agentWaveName:    { type: String, default: '' },
  hasWave:          { type: Boolean, default: false }, // hide Wave if false
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

// ===== In-Memory =====
const waitingQueue = [];
const activeGames = new Map();
const gameTurnTimeouts = new Map();
const userSockets = new Map();
const searchNotifications = new Map();
const searchTimeouts = new Map(); // store timeouts for search expiry notifications

// Store fake game IDs generated for fake search notifications
const fakeGameIds = new Set();

// ===== Concurrency & Spam Protection =====
// FIX 1: Lock set – prevents double-click race on findGame
const processingUsers = new Set();
// FIX 5: Cooldown maps – prevent spam (ms timestamps)
const moveCooldowns    = new Map();  // userId → lastMove timestamp
const findGameCooldowns = new Map(); // userId → lastFindGame timestamp
const MOVE_COOLDOWN_MS     = 300;   // 300ms between moves
const FINDGAME_COOLDOWN_MS = 2000;  // 2s between findGame attempts

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

// ===== Board Constants =====
const BOARD_SIZE = 5;
const WIN_LEN = 4;

function checkWin(board, sym) {
  const dirs = [[0,1],[1,0],[1,1],[1,-1]];
  for (let r=0;r<BOARD_SIZE;r++) for (let c=0;c<BOARD_SIZE;c++) {
    if (board[r][c] !== sym) continue;
    for (const [dr,dc] of dirs) {
      let cnt=1;
      for (let i=1;i<WIN_LEN;i++) {
        const nr=r+dr*i,nc=c+dc*i;
        if (nr<0||nr>=BOARD_SIZE||nc<0||nc>=BOARD_SIZE||board[nr][nc]!==sym) break;
        cnt++;
      }
      if (cnt>=WIN_LEN) return true;
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
const AI_TYPE_SABOTAGE = 'sabotage';

function wouldWin(board, r, c, sym) {
  board[r][c] = sym;
  const w = checkWin(board, sym);
  board[r][c] = '';
  return w;
}

// ── Hard Mode Heuristic Scoring (5x5, 4-in-a-row) ──────────────────────────

// Count consecutive sym pieces from (r,c) in direction (dr,dc), not including (r,c) itself
function countStreak(board, r, c, dr, dc, sym) {
  let cnt = 0;
  let nr = r + dr, nc = c + dc;
  while (nr >= 0 && nr < BOARD_SIZE && nc >= 0 && nc < BOARD_SIZE && board[nr][nc] === sym) {
    cnt++; nr += dr; nc += dc;
  }
  return cnt;
}

// Is the next cell in direction (dr,dc) from streak endpoint open (empty)?
function isEndOpen(board, r, c, dr, dc, streak) {
  const nr = r + dr*(streak+1), nc = c + dc*(streak+1);
  return nr >= 0 && nr < BOARD_SIZE && nc >= 0 && nc < BOARD_SIZE && board[nr][nc] === '';
}

// Heuristic score for a line through (r,c) based on streak and openness
function lineScore(total, openEnds) {
  if (total >= WIN_LEN) return 100000;   // 4-in-a-row
  if (total === 3) {
    if (openEnds === 2) return 5000;     // Open 3 (double threat, must block!)
    if (openEnds === 1) return 2000;     // Half-open 3
    return 200;
  }
  if (total === 2) {
    if (openEnds === 2) return 1000;     // Open 2
    if (openEnds === 1) return 300;
    return 50;
  }
  if (total === 1) {
    if (openEnds === 2) return 100;
    if (openEnds === 1) return 25;
    return 5;
  }
  return 0;
}

// Evaluate heuristic attack/defense score for placing `sym` at (r,c)
function evalCell(board, r, c, sym, oppSym) {
  if (board[r][c] !== '') return -Infinity;
  const dirs = [[0,1],[1,0],[1,1],[1,-1]];

  // Center bonus — cells closer to center (2.5, 2.5) are worth more
  const center = (BOARD_SIZE - 1) / 2;
  const centerBonus = (center - Math.abs(r - center)) + (center - Math.abs(c - center));

  board[r][c] = sym; // temporarily place
  let score = centerBonus * 8;

  for (const [dr, dc] of dirs) {
    const fwd  = countStreak(board, r, c,  dr,  dc, sym);
    const bwd  = countStreak(board, r, c, -dr, -dc, sym);
    const total = fwd + bwd + 1;

    const fwdOpen = isEndOpen(board, r, c,  dr,  dc, fwd);
    const bwdOpen = isEndOpen(board, r, c, -dr, -dc, bwd);
    const openEnds = (fwdOpen ? 1 : 0) + (bwdOpen ? 1 : 0);

    score += lineScore(total, openEnds);
  }

  board[r][c] = ''; // restore
  return score;
}

// Detect double-attack potential: count how many open-3 (or open-4) threats exist after placing
function countThreats(board, r, c, sym, minLen) {
  if (board[r][c] !== '') return 0;
  const dirs = [[0,1],[1,0],[1,1],[1,-1]];
  board[r][c] = sym;
  let threats = 0;
  for (const [dr, dc] of dirs) {
    const fwd  = countStreak(board, r, c,  dr,  dc, sym);
    const bwd  = countStreak(board, r, c, -dr, -dc, sym);
    const total = fwd + bwd + 1;
    const fwdOpen = isEndOpen(board, r, c,  dr,  dc, fwd);
    const bwdOpen = isEndOpen(board, r, c, -dr, -dc, bwd);
    if (total >= minLen && (fwdOpen || bwdOpen)) threats++;
  }
  board[r][c] = '';
  return threats;
}

// Main AI move picker — supports mercy mode (3rd game: let user win)
function aiPickMove(board, aiSym, humanSym, mercyMode = false) {
  const empty = [];
  for (let r=0;r<BOARD_SIZE;r++) for (let c=0;c<BOARD_SIZE;c++) {
    if (board[r][c] === '') empty.push({r,c});
  }
  if (!empty.length) return null;

  // ── Mercy Mode: every 3rd game, let user win ────────────────────────────────
  // If user has a 4-in-a-row threat (one move away from winning), play elsewhere
  if (mercyMode) {
    const winCells = empty.filter(({r,c}) => wouldWin(board,r,c,humanSym));
    if (winCells.length > 0) {
      // Intentionally skip blocking — play a random non-winning, non-blocking cell
      const nonBlock = empty.filter(e => !winCells.find(w=>w.r===e.r&&w.c===e.c));
      const pool = nonBlock.length > 0 ? nonBlock : empty;
      // Pick from corners/edges to look natural
      return pool[Math.floor(Math.random() * Math.min(pool.length, 4))];
    }
  }

  // ── Step 1: Win immediately ─────────────────────────────────────────────────
  for (const {r,c} of empty) {
    if (wouldWin(board,r,c,aiSym)) return {r,c};
  }

  // ── Step 2: Block human immediate win ──────────────────────────────────────
  for (const {r,c} of empty) {
    if (wouldWin(board,r,c,humanSym)) return {r,c};
  }

  // ── Step 3: Create double attack (two open-4s or open-3s simultaneously) ──
  for (const {r,c} of empty) {
    if (countThreats(board,r,c,aiSym,4) >= 2) return {r,c};
  }

  // ── Step 4: Block human double attack ──────────────────────────────────────
  for (const {r,c} of empty) {
    if (countThreats(board,r,c,humanSym,4) >= 2) return {r,c};
  }

  // ── Step 5: Full heuristic scoring ─────────────────────────────────────────
  let best = null, bestScore = -Infinity;
  for (const {r,c} of empty) {
    const attackScore = evalCell(board, r, c, aiSym, humanSym);
    const defenseScore = evalCell(board, r, c, humanSym, aiSym);
    // Weight offense slightly higher to favor winning over pure defense
    const combined = attackScore + defenseScore * 0.9;
    if (combined > bestScore) { bestScore = combined; best = {r,c}; }
  }

  return best || empty[0];
}

// ===== Sabotage AI Game Functions =====
async function startSabotageAIGame(socket, userId, gameId, userName, betAmount=500) {
  const selectedBet = VALID_BETS.includes(betAmount) ? betAmount : 500;
  const { entryFee, winPrize, drawRefund } = getBetPrizes(selectedBet);
  // Increment botMatchCount and determine mercy mode (every 3rd game)
  const u = await User.findOneAndUpdate(
    { telegramId: userId, balance: { $gte: entryFee }, isBanned: { $ne: true } },
    { $inc: { balance: -entryFee, botMatchCount: 1 } },
    { new: true }
  );
  if (!u) {
    return socket.emit('insufficientBalance', { balance: 0, required: entryFee });
  }

  // Mercy: every 3rd game (botMatchCount divisible by 3), let user win
  const mercyMode = (u.botMatchCount % 3 === 0);

  const aiName = randomAIName();
  const symbols = {};
  if (Math.random() > 0.5) { symbols[userId]='X'; symbols[AI_ID]='O'; }
  else { symbols[userId]='O'; symbols[AI_ID]='X'; }
  const firstTurn = parseInt(Object.entries(symbols).find(([,v])=>v==='X')[0]);
  const gameState = {
    gameId, players:[userId, AI_ID], symbols,
    board: Array(BOARD_SIZE).fill(null).map(()=>Array(BOARD_SIZE).fill('')),
    currentTurn: firstTurn, status:'active', isAIGame:true,
    betAmount: selectedBet,
    aiType: AI_TYPE_SABOTAGE,
    mercyMode,
    startedAt: Date.now(), lastMoveAt: Date.now(),
    playerNames: { [userId]: userName, [AI_ID]: aiName }
  };
  activeGames.set(gameId, gameState);
  socket.join(gameId);
  socket.emit('gameStarted', {
    gameId, board: gameState.board, currentTurn: firstTurn,
    players: gameState.playerNames, mySymbol: symbols[userId]
  });
  if (firstTurn === AI_ID) {
    scheduleSabotageAIMove(gameId);
  } else {
    const t = setTimeout(() => handleTurnTimeoutAI(gameId, userId), TURN_SECONDS*1000+1500);
    gameTurnTimeouts.set(gameId, t);
  }
  console.log(`SABOTAGE AI game started: ${gameId} | User: ${userId} vs AI: ${aiName} | mercy: ${mercyMode}`);
}

function scheduleSabotageAIMove(gameId) {
  const thinkMs = 3000 + Math.random() * 2000;
  setTimeout(async () => {
    const game = activeGames.get(gameId);
    if (!game || game.status !== 'active' || game.currentTurn !== AI_ID) return;
    const humanId = game.players.find(p => p !== AI_ID);
    const aiSym = game.symbols[AI_ID];
    const humanSym = game.symbols[humanId];
    // Pass mercy mode flag to aiPickMove
    const move = aiPickMove(game.board, aiSym, humanSym, game.mercyMode || false);
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

async function endGameAI(gameId, winner, reason='normal') {
  const game = activeGames.get(gameId);
  if (!game || (game.status !== 'active' && game.status !== 'ending')) return;
  clearTurnTimer(gameId);
  game.status = 'completed';
  const humanId = game.players.find(p => p !== AI_ID);
  const betAmt = game.betAmount || 500;
  const { winPrize, drawRefund } = getBetPrizes(betAmt);
  try {
    if (winner === -1) {
      // Draw — refund + totalGames only (NO turnoverProgress for draw)
      if (humanId) await User.findOneAndUpdate(
        { telegramId: humanId },
        { $inc: { balance: drawRefund, totalGames: 1 } }
      );
    } else if (winner === humanId) {
      // Human wins — prize + stats reset consecutiveLosses + turnoverProgress
      await User.findOneAndUpdate(
        { telegramId: humanId },
        { $inc: { balance: winPrize, wins: 1, totalGames: 1, turnoverProgress: betAmt },
          $set: { consecutiveLosses: 0 } }
      );
    } else {
      // Human loses — stats + consecutiveLosses + turnoverProgress
      if (humanId) {
        await User.findOneAndUpdate(
          { telegramId: humanId },
          { $inc: { losses: 1, totalGames: 1, consecutiveLosses: 1, turnoverProgress: betAmt } }
        );
        await checkRescueBonus(humanId);
      }
    }
    // 3-level commission for the human player
    if (humanId) {
      distribute3LevelCommission(humanId).catch(()=>{});
    }
    await Game.findOneAndUpdate({gameId},{
      winner, status:'completed', board:game.board,
      playerNames: game.playerNames,
      winnerName: winner===-1 ? 'draw' : (game.playerNames?.[winner] || String(winner)),
      isAIGame: !!game.isAIGame
    },{upsert:true});
  } catch(e){ console.error('endGameAI err:', e); }
  io.to(gameId).emit('gameOver', {
    winner, reason, board: game.board,
    betAmount: betAmt,
    winPrize: getBetPrizes(betAmt).winPrize,
    drawRefund: getBetPrizes(betAmt).drawRefund
  });
  // FIX 4: Full memory cleanup for AI games
  activeGames.delete(gameId);
  clearTurnTimer(gameId);
  const humanIdForCleanup = game.players.find(p => p !== AI_ID);
  if (humanIdForCleanup) {
    const t = searchTimeouts.get(humanIdForCleanup);
    if (t) { clearTimeout(t); searchTimeouts.delete(humanIdForCleanup); }
    moveCooldowns.delete(humanIdForCleanup);
    findGameCooldowns.delete(humanIdForCleanup);
    processingUsers.delete(humanIdForCleanup);
  }
}

async function handleTurnTimeoutAI(gameId, playerId) {
  const game = activeGames.get(gameId);
  if (!game || game.status !== 'active' || game.currentTurn !== playerId) return;
  if (playerId === AI_ID) {
    scheduleSabotageAIMove(gameId);
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

async function handleSabotage(game, userId) {
  // Mark game so no further moves / AI actions fire during the fake-disconnect window
  game.status = 'ending';
  clearTurnTimer(game.gameId);

  // ── Step 1: Show "Reconnecting…" overlay on the USER's screen only ──
  //   (emit to the whole room; client ignores it for AI-side — AI has no socket)
  const userSocketId = userSockets.get(userId);
  const userSocket   = userSocketId ? io.sockets.sockets.get(userSocketId) : null;
  if (userSocket) {
    userSocket.emit('fakeDisconnect', {
      message: 'မိတ်ဆွေ၏ Internet လိုင်းကျနေပါသည်၊ ပြန်လည်ချိတ်ဆက်နေပါသည်...'
    });
  }

  // ── Step 2: After a short realistic delay, resolve as loss (connectionLost) ──
  //   Backend records AI as winner; client already sees the "disconnected" screen.
  const delayMs = 4000 + Math.random() * 2000; // 4-6s feels natural
  setTimeout(async () => {
    // Double-check game wasn't already cleaned up
    const g = activeGames.get(game.gameId);
    if (!g) return;
    await endGameAI(game.gameId, AI_ID, 'connectionLost');
  }, delayMs);
}

// ===== 3-Level Commission =====
async function distribute3LevelCommission(playerId) {
  if (!playerId || playerId === AI_ID) return;
  try {
    const player = await User.findOne({ telegramId: playerId }).lean();
    if (!player || !player.referredBy) return;

    // Level 1
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

    // Level 2
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

    // Level 3
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


// ── Feature 3: Rescue Bonus helper ──
async function checkRescueBonus(userId) {
  try {
    const u = await User.findOne({ telegramId: userId }).lean();
    if (!u) return;
    // ✅ FIX: exactly 5 consecutive losses triggers bonus (=== 5, not >= 5)
    if (u.consecutiveLosses === 5) {
      await User.findOneAndUpdate(
        { telegramId: userId },
        { $inc: { balance: 200 }, $set: { consecutiveLosses: 0 } }
      );
      // Notify via Socket
      const sockId = userSockets.get(userId);
      if (sockId) {
        const sock = io.sockets.sockets.get(sockId);
        if (sock) sock.emit('rescueBonus', { amount: 200 });
      }
      // Notify via Bot
      if (bot) bot.telegram.sendMessage(userId,
        `🛡️ <b>Rescue Bonus ရရှိပြီ!</b>\n\n၅ ပွဲဆက်တိုက်ရှုံးသွားသဖြင့် Rescue Bonus <b>200 MMK</b> ပြန်ရရှိပါသည် 🎁\n\nဆက်လက်ကြိုးစားပါ 💪`,
        { parse_mode: 'HTML' }).catch(() => {});
    }
  } catch(e) { console.error('rescueBonus err:', e.message); }
}

// ── Feature 1: First-deposit bonus helper ──
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

      // ── Dynamic bet: look up actual bet from waiting queue ──
      const queueEntry = waitingQueue.find(w => w.gameId === gameId);
      const joinBet = queueEntry?.betAmount || 500;
      const { entryFee: joinFee, winPrize: joinWin } = getBetPrizes(joinBet);

      if (user.balance < joinFee) {
        await ctx.reply(
          `⚠️ ငွေမလုံလောက်ပါ!\n\n💰 ဝင်ကြေး: ${joinFee.toLocaleString()} MMK\n🏦 သင့်ကျန်: ${user.balance.toLocaleString()} MMK`,
          Markup.inlineKeyboard([[Markup.button.webApp('💰 ငွေဖြည့်ရန်', FRONTEND_URL)]])
        ).catch(()=>{});
        return;
      }
      await ctx.reply(
        `✅ ပွဲဝင်ရန် Join ကိုနှိပ်ပါ\n💰 ဝင်ကြေး: ${joinFee.toLocaleString()} MMK  •  🏆 ဆု: ${joinWin.toLocaleString()} MMK`,
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

async function notifyUsersGameSearch(searcherId, gameId, betAmount=500) {
  if (!bot) return;
  const { winPrize } = getBetPrizes(betAmount);
  try {
    // ① DB queries တပြိုင်နက် run (parallel)
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

    // ② Online (socket ချိတ်ဆက်ထားသူ) နဲ့ Offline ကို ခွဲ
    //    Offline users ကို lastActive DESC အစဉ်အလိုက် sort (မကြာသေးမီ active user ကို အရင်ပို့)
    const onlineUsers  = allUsers.filter(u => userSockets.has(u.telegramId));
    const offlineUsers = allUsers
      .filter(u => !userSockets.has(u.telegramId))
      .sort((a, b) => (b.lastActive||0) - (a.lastActive||0));

    const sent = [];

    // ③ ONLINE users → ချက်ချင်း တပြိုင်နက် ပို့ (delay မပါ)
    const onlineResults = await Promise.allSettled(onlineUsers.map(async u => {
      try {
        const msg = await bot.telegram.sendMessage(u.telegramId, msgText,
          { parse_mode:'HTML', reply_markup: replyMarkup }
        );
        return { userId: u.telegramId, msgId: msg.message_id };
      } catch(e) { return null; }
    }));
    onlineResults.forEach(r => { if (r.status === 'fulfilled' && r.value) sent.push(r.value); });

    // ④ OFFLINE users → background မှာ chunk ခွဲပြီး ဖြည်းဖြည်းချင်း ပို့
    //    setImmediate နဲ့ defer လုပ်ထားတာကြောင့် online notify ပြီးတာနဲ့ return ဖြစ်မည်
    setImmediate(async () => {
      const CHUNK = 25;
      for (let i = 0; i < offlineUsers.length; i += CHUNK) {
        // Game match ဖြစ်ပြီး / cancel ဆိုရင် ရပ်
        if (!waitingQueue.find(w => w.gameId === gameId)) break;

        const batch = offlineUsers.slice(i, i + CHUNK);
        await Promise.allSettled(batch.map(async u => {
          try {
            const msg = await bot.telegram.sendMessage(u.telegramId, msgText,
              { parse_mode:'HTML', reply_markup: replyMarkup }
            );
            sent.push({ userId: u.telegramId, msgId: msg.message_id });
          } catch(e) {}
        }));
        // FIX 6b: 50ms delay (rate limit safe, much faster than 200ms)
        if (i + CHUNK < offlineUsers.length) await new Promise(r => setTimeout(r, 50));
      }
      console.log(`📢 Offline notify done. Total: ${sent.length}/${allUsers.length} for game ${gameId}`);
    });

    searchNotifications.set(gameId, sent);
    console.log(`📢 Online: ${onlineUsers.length} notified instantly | Offline: ${offlineUsers.length} queued`);
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

// ===== Fake Search Notifications =====
async function sendFakeSearchNotification() {
  if (!bot) return;

  // Check if fake notifications are enabled
  const fakeEnabled = await getSetting('fakeNotifications', false);
  if (!fakeEnabled) return;

  // FIX: Fake notifications are purely cosmetic — always send regardless of bot mode
  // (Bot matching only happens when allBotMode is ALSO on — see findGame handler)

  const fakeGameId = genGameId();
  fakeGameIds.add(fakeGameId);

  const fakeName = randomAIName();
  const displayName = obfuscateUsername(fakeName);

  // ── Feature 3: Random bet from valid tiers ──
  const fakeBet = VALID_BETS[Math.floor(Math.random() * VALID_BETS.length)];
  const { winPrize: fakeWin } = getBetPrizes(fakeBet);

  // FIX 6c: Online-first + lastActive sort for fake notifications
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
    await Promise.allSettled(batch.map(async u => {
      try {
        const msg = await bot.telegram.sendMessage(u.telegramId, fakeMsgText,
          { parse_mode:'HTML', reply_markup: { inline_keyboard: [[
            { text:'🎮 ကစားမည်', callback_data:`join_${fakeGameId}` },
            { text:'❌ မကစားဘူး', callback_data:'dismiss' }
          ]]}}
        );
        sent.push({ userId: u.telegramId, msgId: msg.message_id });
      } catch(e) {}
    }));
    // FIX 6c: 100ms instead of 1000ms
    if (i + CHUNK < users.length) await new Promise(r => setTimeout(r, 100));
  }
  searchNotifications.set(fakeGameId, sent);
  console.log(`📢 Fake search notification sent (${sent.length} users) with gameId ${fakeGameId}`);

  // Auto-delete after 30 seconds if not clicked
  setTimeout(() => deleteSearchMsgs(fakeGameId), 3600000); // 1 hour
}

// ===== FIX 3: Zombie Game Cleanup (every 5 minutes) =====
// If a game has been active but had no moves for >2 minutes, auto-end it
setInterval(async () => {
  const now = Date.now();
  const IDLE_LIMIT_MS = 2 * 60 * 1000; // 2 minutes
  for (const [gameId, game] of activeGames.entries()) {
    if (game.status !== 'active') continue;
    const lastMove = game.lastMoveAt || game.startedAt || 0;
    if (now - lastMove < IDLE_LIMIT_MS) continue;
    console.log(`🧹 Zombie game cleanup: ${gameId} (idle ${Math.round((now-lastMove)/1000)}s)`);
    try {
      if (game.isAIGame) {
        await endGameAI(gameId, -1, 'timeout');
      } else {
        // Refund both players with correct bet amount
        for (const pid of (game.players || [])) {
          const refAmt = getBetPrizes(game.betAmount || 500).entryFee;
          await User.findOneAndUpdate({telegramId:pid},{$inc:{balance:refAmt}}).catch(()=>{});
        }
        io.to(gameId).emit('gameOver', { winner: -1, reason: 'timeout', board: game.board,
          betAmount: game.betAmount || 500,
          drawRefund: getBetPrizes(game.betAmount || 500).drawRefund
        });
        activeGames.delete(gameId);
        clearTurnTimer(gameId);
        for (const pid of (game.players || [])) {
          const t = searchTimeouts.get(pid); if (t) { clearTimeout(t); searchTimeouts.delete(pid); }
        }
        setTimeout(()=>deleteSearchMsgs(gameId),500);
      }
    } catch(e) { console.error('Zombie cleanup err:', e); }
  }
}, 5 * 60 * 1000);

// Dynamic fake notification interval (admin-configurable, default 3 minutes)
let fakeNotifTimer = null;
async function scheduleFakeNotification() {
  if (fakeNotifTimer) { clearTimeout(fakeNotifTimer); fakeNotifTimer = null; }
  const intervalMins = await getSetting('fakeNotifInterval', 3); // default 3 min
  const delay = Math.max(1, Number(intervalMins)) * 60 * 1000;
  fakeNotifTimer = setTimeout(async () => {
    await sendFakeSearchNotification();
    scheduleFakeNotification(); // reschedule after each fire
  }, delay);
}
scheduleFakeNotification();

// ===== Game Logic =====
function clearTurnTimer(gameId) {
  const t = gameTurnTimeouts.get(gameId);
  if (t) { clearTimeout(t); gameTurnTimeouts.delete(gameId); }
}

async function endGame(gameId, winner, reason='normal') {
  const game = activeGames.get(gameId);
  // Accept 'active' OR our pre-marked 'ending' state; reject anything else
  if (!game || (game.status !== 'active' && game.status !== 'ending')) return;
  clearTurnTimer(gameId);
  game.status = 'completed';
  const winnerId = winner === -1 ? -1 : Number(winner); // ── FIX: explicit cast
  const betAmt = game.betAmount || 500;
  const { winPrize, drawRefund } = getBetPrizes(betAmt);

  try {
    if (winnerId === -1) {
      // Draw — both players get refund + totalGames only (NO turnoverProgress for draw)
      for (const pid of game.players) {
        await User.findOneAndUpdate(
          { telegramId: pid },
          { $inc: { balance: drawRefund, totalGames: 1 } }
        );
        distribute3LevelCommission(pid).catch(()=>{});
      }
    } else if (winnerId) {
      const loser = game.players.find(p => Number(p) !== winnerId);
      // Winner — prize + stats reset consecutiveLosses + turnoverProgress
      await User.findOneAndUpdate(
        { telegramId: winnerId },
        { $inc: { balance: winPrize, wins: 1, totalGames: 1, turnoverProgress: betAmt },
          $set: { consecutiveLosses: 0 } }
      );
      // Loser — stats + consecutiveLosses + turnoverProgress
      if (loser) {
        await User.findOneAndUpdate(
          { telegramId: loser },
          { $inc: { losses: 1, totalGames: 1, consecutiveLosses: 1, turnoverProgress: betAmt } }
        );
        await checkRescueBonus(loser);
      }
      // Commission for both players
      distribute3LevelCommission(winnerId).catch(()=>{});
      if (loser) distribute3LevelCommission(loser).catch(()=>{});
    }
    await Game.findOneAndUpdate({gameId},{
      winner: winnerId, status:'completed', board:game.board,
      playerNames: game.playerNames,
      winnerName: winnerId===-1 ? 'draw' : (game.playerNames?.[winnerId] || String(winnerId)),
      isAIGame: !!game.isAIGame
    },{upsert:true});
  } catch(e){ console.error('endGame err:', e.stack || e); }

  io.to(gameId).emit('gameOver', {
    winner: winnerId, reason, board: game.board,
    betAmount: betAmt,
    winPrize: getBetPrizes(betAmt).winPrize,
    drawRefund: getBetPrizes(betAmt).drawRefund
  });
  // FIX 4: Full memory cleanup
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

// ===== Socket =====
io.on('connection', (socket) => {
  let myUserId = null;
  let myGameId = null;

  socket.on('findGame', async ({userId, betAmount}) => {
    if (!userId) return socket.emit('error',{msg:'userId မပါ'});
    myUserId = parseInt(userId);
    // ── Feature 2: Validate betAmount ──
    const selectedBet = VALID_BETS.includes(parseInt(betAmount)) ? parseInt(betAmount) : 500;
    const { entryFee, winPrize, drawRefund } = getBetPrizes(selectedBet);

    // FIX 5: findGame cooldown – prevent spam
    const lastFG = findGameCooldowns.get(myUserId) || 0;
    if (Date.now() - lastFG < FINDGAME_COOLDOWN_MS) {
      return socket.emit('error',{msg:'နည်းနည်းစောင့်ပါ...'});
    }
    findGameCooldowns.set(myUserId, Date.now());

    // FIX 1: processingUsers lock – prevent double-click race
    if (processingUsers.has(myUserId)) {
      return socket.emit('error',{msg:'ရှာဖွေနေဆဲ ဖြစ်သည်'});
    }
    processingUsers.add(myUserId);

    try {
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
      if (user.balance < entryFee) {
        return socket.emit('insufficientBalance',{balance:user.balance,required:entryFee});
      }

      // Update lastActive timestamp
      User.findOneAndUpdate({telegramId:myUserId},{lastActive:new Date()}).catch(()=>{});

    const allBotMode = await getSetting('allBotMode', false);
    const joinGameId = socket.handshake.query?.join;

    // ── FIX 1 & 2: AI mode gate ──────────────────────────────────────
    // If joining via a fake notification:
    //   allBotMode ON  → AI game (intended fake-lure behavior)
    //   allBotMode OFF → treat as normal matchmaking (ignore fake flag)
    if (joinGameId && fakeGameIds.has(joinGameId)) {
      if (allBotMode) {
        const gameId = genGameId();
        myGameId = gameId;
        const uName = user.firstName || user.username || `User${myUserId}`;
        await startSabotageAIGame(socket, myUserId, gameId, uName, selectedBet);
        await deleteSearchMsgs(joinGameId);
        return;
      } else {
        // allBotMode is OFF → delete the fake notification and fall through
        // to normal matchmaking below
        deleteSearchMsgs(joinGameId);
        fakeGameIds.delete(joinGameId);
      }
    }

    // Global All Bot Mode → sabotage AI for everyone
    if (allBotMode) {
      const gameId = genGameId();
      myGameId = gameId;
      const uName = user.firstName || user.username || `User${myUserId}`;
      await startSabotageAIGame(socket, myUserId, gameId, uName, selectedBet);
      return;
    }

    // User-level botMode: only if global allBotMode is also ON
    // (if global is OFF, user.botMode is ignored → real matchmaking)
    if (user.botMode && allBotMode) {
      const gameId = genGameId();
      myGameId = gameId;
      const uName = user.firstName || user.username || `User${myUserId}`;
      await startSabotageAIGame(socket, myUserId, gameId, uName, selectedBet);
      return;
    }

    // Normal matchmaking — ── Feature 2: Match only same betAmount ──
    let waiterIdx = -1;
    if (joinGameId) {
      waiterIdx = waitingQueue.findIndex(w=>w.gameId===joinGameId && w.userId!==myUserId);
    }
    if (waiterIdx === -1) {
      waiterIdx = waitingQueue.findIndex(w=>w.userId!==myUserId && w.betAmount===selectedBet);
    }

    if (waiterIdx !== -1) {
      const waiter = waitingQueue.splice(waiterIdx,1)[0];
      myGameId = waiter.gameId;
      const matchedBet = waiter.betAmount || selectedBet;
      const matchedFee = getBetPrizes(matchedBet).entryFee;

      // Clear any pending search timeout for this user
      const timeout = searchTimeouts.get(myUserId);
      if (timeout) { clearTimeout(timeout); searchTimeouts.delete(myUserId); }

      // FIX 5: Deduct both balances in parallel (atomic-like, prevent race)
      try {
        const [w1, w2] = await Promise.all([
          User.findOneAndUpdate({telegramId:waiter.userId,balance:{$gte:matchedFee}},{$inc:{balance:-matchedFee}},{new:true}),
          User.findOneAndUpdate({telegramId:myUserId,balance:{$gte:matchedFee}},{$inc:{balance:-matchedFee}},{new:true})
        ]);
        if (!w1||!w2) {
          // Rollback whoever succeeded
          await Promise.all([
            w1 ? User.findOneAndUpdate({telegramId:waiter.userId},{$inc:{balance:matchedFee}}) : Promise.resolve(),
            w2 ? User.findOneAndUpdate({telegramId:myUserId},{$inc:{balance:matchedFee}}) : Promise.resolve()
          ]);

          // ── FIX: differentiate waiter vs joiner failure ──────────────────
          if (!w1) {
            // Waiter's balance was insufficient — notify waiter, DO NOT push back to queue
            const waiterSockId = userSockets.get(waiter.userId);
            const waiterSock = waiterSockId ? io.sockets.sockets.get(waiterSockId) : null;
            const wUser = await User.findOne({telegramId:waiter.userId}).select('balance').lean();
            if (waiterSock) {
              waiterSock.emit('insufficientBalance', {balance: wUser?.balance||0, required: matchedFee});
            }
            // Waiter removed from queue (already spliced) — they must re-search with sufficient balance
          } else {
            // Waiter's balance was fine — push waiter back to queue so others can match
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
      const symbols = {};
      if (Math.random()>0.5) { symbols[waiter.userId]='X'; symbols[myUserId]='O'; }
      else { symbols[waiter.userId]='O'; symbols[myUserId]='X'; }
      const firstTurn = parseInt(Object.entries(symbols).find(([,v])=>v==='X')[0]);

      const gameState = {
        gameId:myGameId, players:[waiter.userId,myUserId], symbols,
        board: Array(BOARD_SIZE).fill(null).map(()=>Array(BOARD_SIZE).fill('')),
        currentTurn:firstTurn, status:'active',
        betAmount: matchedBet,
        startedAt: Date.now(), lastMoveAt: Date.now(), // FIX 2: zombie tracking
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

      const base = {gameId:myGameId,board:gameState.board,currentTurn:firstTurn,players:gameState.playerNames,betAmount:matchedBet};
      socket.emit('gameStarted',{...base,mySymbol:symbols[myUserId]});
      if (waiterSocket) waiterSocket.emit('gameStarted',{...base,mySymbol:symbols[waiter.userId]});

      await deleteSearchMsgs(myGameId);
      const t = setTimeout(()=>handleTurnTimeout(myGameId,firstTurn),TURN_SECONDS*1000+1500);
      gameTurnTimeouts.set(myGameId,t);

    } else {
      const gameId = genGameId();
      myGameId = gameId;
      socket.join(gameId);
      waitingQueue.push({socketId:socket.id,userId:myUserId,gameId,betAmount:selectedBet});
      socket.emit('waitingForPlayer',{gameId,searchTimeout:SEARCH_TIMEOUT_S,betAmount:selectedBet});
      notifyUsersGameSearch(myUserId, gameId, selectedBet);

      // Set a timeout to notify the user that no one has joined yet
      const timeout = setTimeout(() => {
        if (socket.connected) {
          socket.emit('searchUpdate', { message: 'လက်ရှိဆော့ကစားနေသူမရှိသေးပါ ဆက်လက်ရှာဖွေဖို့' });
        }
      }, SEARCH_TIMEOUT_S * 1000);
      searchTimeouts.set(myUserId, timeout);
    }
    } catch(e) {
      console.error('findGame err:', e);
      socket.emit('error',{msg:'ဆာဗာ error ဖြစ်သည်'});
    } finally {
      // FIX 1: Always release the processing lock
      processingUsers.delete(myUserId);
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
    // Clear search timeout
    const timeout = searchTimeouts.get(uid);
    if (timeout) { clearTimeout(timeout); searchTimeouts.delete(uid); }
    socket.emit('searchCancelled');
  });

  socket.on('makeMove', async ({gameId,row,col}) => {
    // FIX 5: Move cooldown – prevent spam clicking
    const lastMove = moveCooldowns.get(myUserId) || 0;
    if (Date.now() - lastMove < MOVE_COOLDOWN_MS) return;
    moveCooldowns.set(myUserId, Date.now());

    try {
      const game = activeGames.get(gameId);
      if (!game||game.status!=='active') return;
      // Block user move while AI is thinking (race condition guard)
      if (game.isAIGame && game.currentTurn === AI_ID) {
        return socket.emit('error',{msg:'AI စဉ်းစားနေဆဲ ဖြစ်သည်'});
      }
      if (game.currentTurn!==myUserId) return socket.emit('error',{msg:'သင့်လှည့် မဟုတ်ပါ'});
      if (row<0||row>4||col<0||col>4) return socket.emit('error',{msg:'Invalid move'});
      if (game.board[row][col]!=='') return socket.emit('error',{msg:'ထိုနေရာ ယူပြီးသား'});

      // ── FIX A: safe symbol lookup (handles both Number & String keys) ──
      // Must be resolved BEFORE sabotage check which needs the symbol
      const sym = game.symbols[myUserId] || game.symbols[String(myUserId)];
      if (!sym) return socket.emit('error',{msg:'Symbol မတွေ့ပါ — ဂိမ်းပြန်ဝင်ပါ'});

      // ── Sabotage check ──────────────────────────────────────────────────────
      // ONLY fires in AI games (isAIGame = true, aiType = sabotage).
      // Real PvP games (isAIGame = false) are fully protected — sabotage NEVER runs.
      if (
        game.isAIGame &&
        game.aiType === AI_TYPE_SABOTAGE &&
        checkWinAfterMove(game.board, row, col, sym)
      ) {
        clearTurnTimer(gameId);
        await handleSabotage(game, myUserId);
        return;
      }
      // ────────────────────────────────────────────────────────────────────────

      // ── FIX B: guard – reject if game already ended by another path ──
      if (game.status !== 'active') return;

      // Normal move processing
      clearTurnTimer(gameId);
      game.board[row][col] = sym;
      game.lastMoveAt = Date.now();

      // ── FIX C: detect outcome BEFORE emitting so client gets correct flags ──
      const didWin  = checkWin(game.board, sym);
      const isDraw  = !didWin && boardFull(game.board);
      const gameEnds = didWin || isDraw;

      // ── FIX D: determine next turn only when game continues ──
      const nextPlayer = gameEnds ? null : game.players.find(p => p !== myUserId);

      // Emit moveMade WITH currentTurn and gameEnded flag so client is never confused
      io.to(gameId).emit('moveMade', {
        row, col, symbol: sym, playerId: myUserId, board: game.board.map(r=>[...r]),
        currentTurn: nextPlayer,   // null when game ends
        gameEnded: gameEnds
      });

      if (didWin) {
        // ── FIX E: mark status SYNCHRONOUSLY before any await ──
        game.status = 'ending';
        if (game.isAIGame) await endGameAI(gameId, myUserId, 'win');
        else                await endGame(gameId, myUserId, 'win');
      } else if (isDraw) {
        game.status = 'ending';
        if (game.isAIGame) await endGameAI(gameId, -1, 'draw');
        else                await endGame(gameId, -1, 'draw');
      } else {
        // ── FIX F: update currentTurn, then emit turnChanged, THEN set timer ──
        game.currentTurn = nextPlayer;
        io.to(gameId).emit('turnChanged', {currentTurn: nextPlayer});
        if (nextPlayer === AI_ID) {
          scheduleSabotageAIMove(gameId);
        } else {
          const t = setTimeout(() => handleTurnTimeout(gameId, nextPlayer), TURN_SECONDS*1000+1500);
          gameTurnTimeouts.set(gameId, t);
        }
      }
    } catch(e) {
      console.error('makeMove err:', e);
      socket.emit('error',{msg:'Move error ဖြစ်သည်'});
    }
  });

  socket.on('disconnect', async () => {
    const wIdx = waitingQueue.findIndex(w=>w.socketId===socket.id);
    if (wIdx!==-1) {
      const {gameId, userId} = waitingQueue[wIdx];
      waitingQueue.splice(wIdx,1);
      await deleteSearchMsgs(gameId);
      // Clear search timeout
      const timeout = searchTimeouts.get(userId);
      if (timeout) { clearTimeout(timeout); searchTimeouts.delete(userId); }
    }

    // ── Disconnect Loss: 5 second delay to handle brief network drops ──
    // လိုင်းခဏကျပြီး ပြန်ချိတ်တဲ့ case မှာ ချက်ချင်း loss မပေးဖို့ delay ထည့်သည်
    const disconnectedUserId = myUserId;
    const disconnectedGameId = myGameId;

    if (disconnectedUserId) {
      userSockets.delete(disconnectedUserId);
      processingUsers.delete(disconnectedUserId);
      moveCooldowns.delete(disconnectedUserId);
      findGameCooldowns.delete(disconnectedUserId);
    }

    if (disconnectedGameId && activeGames.has(disconnectedGameId)) {
      setTimeout(async () => {
        // 5 စက္ကန့် နောက်မှ check — ပြန်ချိတ်ဆက်ပြီ ဖြစ်ရင် userSockets မှာ ပြန်ရှိနေမည်
        const reconnected = disconnectedUserId && userSockets.has(disconnectedUserId);
        if (reconnected) {
          console.log(`[Disconnect] User ${disconnectedUserId} reconnected — no loss applied`);
          return;
        }

        const game = activeGames.get(disconnectedGameId);
        if (!game || game.status !== 'active') return;

        console.log(`[Disconnect] User ${disconnectedUserId} confirmed disconnected — ending game ${disconnectedGameId}`);
        if (game.isAIGame) {
          await endGameAI(disconnectedGameId, AI_ID, 'disconnect');
        } else {
          const opp = game.players.find(p => Number(p) !== Number(disconnectedUserId));
          if (opp) await endGame(disconnectedGameId, opp, 'disconnect');
        }
      }, 5000); // 5 seconds grace period
    }
  });

  // ✅ NEW: In-game emote handler
  socket.on('sendEmote', ({ gameId, emote }) => {
    try {
      if (!gameId || !emote || !myUserId) return;
      const game = activeGames.get(gameId);
      if (!game || game.status !== 'active') return;
      if (!game.players.includes(myUserId)) return;
      // Broadcast emote to the game room with sender info
      io.to(gameId).emit('emoteReceived', {
        senderId: myUserId,
        emote
      });
    } catch(e) { console.error('emote err:', e); }
  });

  async function handleTurnTimeout(gameId, playerId) {
    const game = activeGames.get(gameId);
    // Guard: game မရှိရင် / active မဟုတ်ရင် / stale timer ဖြစ်ရင် skip
    if (!game || game.status !== 'active') return;

    const timedOutId = Number(playerId);
    const currentTurnId = Number(game.currentTurn);

    // အချိန်ကုန်သူ (timedOutId) သာ ရှုံးရမည် — တစ်ဖက်လူ မဟုတ်
    // currentTurn === timedOut player မဟုတ်ရင် ဒီ timer က stale ဖြစ်ပြီ — skip
    if (currentTurnId !== timedOutId) {
      console.log(`[Timeout] Stale timer ignored: currentTurn=${currentTurnId}, timedOut=${timedOutId}`);
      return;
    }

    // တစ်ဖက်လူ (opponent) ကို ရှာပြီး အနိုင်ပေး
    const winner = game.players.find(p => Number(p) !== timedOutId);
    if (!winner) {
      console.log(`[Timeout] No opponent found for game ${gameId}, cannot determine winner`);
      return;
    }

    console.log(`[Timeout] gameId=${gameId} | timedOut=${timedOutId} loses | winner=${winner}`);
    await endGame(gameId, winner, 'timeout');
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

// ── Feature 4: Queue-info for pre-join balance check ──
app.get('/api/queue-info/:gameId', async(req,res)=>{
  const entry = waitingQueue.find(w=>w.gameId===req.params.gameId);
  if (!entry) return res.status(404).json({error:'Not found'});
  res.json({ betAmount: entry.betAmount || 500 });
});

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
      botMode:user.botMode,
      turnoverTarget:user.turnoverTarget||0,
      turnoverProgress:user.turnoverProgress||0,
      consecutiveLosses:user.consecutiveLosses||0
    });
  } catch(e){ console.error(e); res.status(500).json({error:'Server error'}); }
});

app.get('/api/user/:id', async(req,res)=>{
  try {
    const u=await User.findOne({telegramId:parseInt(req.params.id)}).select('balance totalGames wins losses botMode turnoverTarget turnoverProgress consecutiveLosses').lean();
    if (!u) return res.status(404).json({error:'Not found'});
    res.json(u);
  } catch(e){ res.status(500).json({error:'Server error'}); }
});

app.post('/api/deposit', async(req,res)=>{
  try {
    const {telegramId,kpayName,transactionId,amount,paymentMethod}=req.body;
    if (!telegramId||!kpayName||!transactionId||!amount)
      return res.status(400).json({error:'ကွင်းလပ်များ ဖြည့်ပေးပါ'});
    if (parseInt(amount)<500)
      return res.status(400).json({error:'အနည်းဆုံး 500 MMK'});
    const u=await User.findOne({telegramId:parseInt(telegramId)}).lean();
    if (!u) return res.status(404).json({error:'User not found'});
    if (u.isBanned) return res.status(403).json({error:'ကောင်ပိတ်ဆို့ထားသည်'});
    const dup=await Deposit.findOne({transactionId}).lean();
    if (dup) return res.status(400).json({error:'Transaction ID ကို အသုံးပြုပြီးသည်'});
    const method = (paymentMethod === 'wave') ? 'wave' : 'kpay';
    const methodLabel = method === 'wave' ? '🌊 Wave Pay' : '📱 KPay';
    const dep=await new Deposit({userId:u.telegramId,kpayName,transactionId,amount:parseInt(amount),paymentMethod:method}).save();
    if (bot) bot.telegram.sendMessage(ADMIN_ID,
      `💰 *ငွေသွင်း တောင်းဆိုမှု*\n👤 ${u.firstName||u.username} (${u.telegramId})\n💵 ${parseInt(amount).toLocaleString()} ကျပ်\n${methodLabel} ဖြင့် သွင်းထားသည်\n📝 ${kpayName}\n🔢 \`${transactionId}\``,
      {parse_mode:'Markdown'}).catch(()=>{});
    res.json({success:true,depositId:dep._id});
  } catch(e){ console.error(e); res.status(500).json({error:'Server error'}); }
});

app.post('/api/withdraw', async(req,res)=>{
  try {
    const {telegramId,kpayName,kpayNumber,amount,paymentMethod}=req.body;
    if (!telegramId||!kpayName||!kpayNumber||!amount)
      return res.status(400).json({error:'ကွင်းလပ်များ ဖြည့်ပေးပါ'});
    const amt=parseInt(amount);
    if (isNaN(amt)||amt<2500)
      return res.status(400).json({error:'အနည်းဆုံး 2,500 MMK'});
    const tid=parseInt(telegramId);

    const chk=await User.findOne({telegramId:tid}).select('balance isBanned firstName username turnoverTarget turnoverProgress').lean();
    if (!chk) return res.status(404).json({error:'User မတွေ့ပါ'});
    if (chk.isBanned===true) return res.status(403).json({error:'🚫 ကောင်ပိတ်ဆို့ထားသည်'});
    if (chk.balance<amt) return res.status(400).json({error:`လက်ကျန်ငွေ မလုံလောက်ပါ (ကျန်: ${chk.balance.toLocaleString()} MMK)`});
    // ── Feature 1: Turnover check ──
    const remaining = (chk.turnoverTarget||0) - (chk.turnoverProgress||0);
    if (remaining > 0) {
      return res.status(400).json({error:`Bonus Turnover မပြည့်သေးပါ 🎮\nကျန်လောင်းရန်: ${remaining.toLocaleString()} MMK ဖိုး ကစားမှ ငွေထုတ်ခွင့်ပြုမည်`});
    }

    const method = (paymentMethod === 'wave') ? 'wave' : 'kpay';
    const methodLabel = method === 'wave' ? '🌊 Wave Pay' : '📱 KPay';

    let wd;
    try {
      wd=await new Withdrawal({userId:tid,kpayName,kpayNumber,amount:amt,paymentMethod:method}).save();
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
      `💸 *ငွေထုတ် တောင်းဆိုမှု*\n👤 ${u.firstName||u.username} (${u.telegramId})\n💵 ${amt.toLocaleString()} ကျပ်\n${methodLabel} ဖြင့် ထုတ်မည်\n📝 ${kpayName}\n📱 ${kpayNumber}\n🏦 ကျန်: ${u.balance.toLocaleString()} ကျပ်`,
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
  const fakeNotifications = await getSetting('fakeNotifications', false);
  const fakeNotifInterval = await getSetting('fakeNotifInterval', 3);
  res.json({maintenance:maint, allBotMode, fakeNotifications, fakeNotifInterval, entryFee:ENTRY_FEE, winPrize:WIN_PRIZE, drawRefund:DRAW_REFUND, turnSeconds:TURN_SECONDS});
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

// Fake Notifications toggle
app.get('/api/admin/fakenotifications', isAdmin, async(req,res)=>{
  const fakeNotifications = await getSetting('fakeNotifications', false);
  res.json({fakeNotifications});
});

app.post('/api/admin/fakenotifications', isAdmin, async(req,res)=>{
  await setSetting('fakeNotifications', !!req.body.enabled);
  res.json({success:true, fakeNotifications: !!req.body.enabled});
});

// Set fake notification interval (minutes)
app.post('/api/admin/fakenotifinterval', isAdmin, async(req,res)=>{
  const mins = Math.max(1, Number(req.body.interval) || 3);
  await setSetting('fakeNotifInterval', mins);
  // Restart scheduler with new interval
  scheduleFakeNotification();
  res.json({success:true, fakeNotifInterval: mins});
});

app.get('/api/admin/deposits', isAdmin, async(req,res)=>{
  try {
    // ── FIX: Exclude deposits from agent-referred users (agents handle those) ──
    const agents = await User.find({role:'agent'}).select('telegramId').lean();
    const agentIds = agents.map(a => a.telegramId);
    const agentReferredUserIds = agentIds.length
      ? (await User.find({referredBy:{$in:agentIds}}).select('telegramId').lean()).map(u=>u.telegramId)
      : [];

    const query = { status: req.query.status||'pending' };
    if (agentReferredUserIds.length) query.userId = { $nin: agentReferredUserIds };

    const deps=await Deposit.find(query).sort({createdAt:-1}).limit(50).lean();
    const out=await Promise.all(deps.map(async d=>{
      const u=await User.findOne({telegramId:d.userId}).select('firstName username').lean();
      return {...d,userName:u?.firstName||u?.username||String(d.userId)};
    }));
    res.json(out);
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.post('/api/admin/deposits/:id/confirm', isAdmin, async(req,res)=>{
  try {
    const dep=await Deposit.findOneAndUpdate(
      { _id: req.params.id, status: 'pending' },
      { $set: { status: 'confirmed', processedAt: new Date(), expireAt: new Date(Date.now() + 72*60*60*1000) } },
      { new: true }
    );
    if (!dep) return res.status(400).json({error:'Deposit မတွေ့ပါ သို့မဟုတ် ပြင်ဆင်ပြီးသားဖြစ်သည်'});
    await User.findOneAndUpdate({telegramId:dep.userId},{$inc:{balance:dep.amount}});
    const user=await User.findOne({telegramId:dep.userId}).lean();
    // ── Feature 1: First Deposit Bonus ──
    await applyFirstDepositBonus(dep.userId, dep.amount);
    if (user?.referredBy) {
      const prevDeps=await Deposit.countDocuments({userId:dep.userId,status:'confirmed',_id:{$ne:dep._id}});
      if (prevDeps===0) {
        await User.findOneAndUpdate({telegramId:user.referredBy},{$inc:{balance:100}});
        if (bot) bot.telegram.sendMessage(user.referredBy,
          `🎉 သင့် referral မှ ငွေဖြည့်သောကြောင့် <b>100 MMK</b> ရရှိပါပြီ!`,
          {parse_mode:'HTML'}).catch(()=>{});
      }
      // ── Deposit Commission 5% to referring agent ──
      const referrer = await User.findOne({ telegramId: user.referredBy, role: 'agent' }).lean();
      if (referrer) {
        const commission5 = Math.floor(dep.amount * 0.05);
        if (commission5 > 0) {
          await User.findOneAndUpdate({ telegramId: user.referredBy }, { $inc: { balance: commission5 } });
          if (bot) bot.telegram.sendMessage(user.referredBy,
            `💸 <b>Deposit Commission ရရှိပြီ!</b>\n👤 User ငွေဖြည့်: ${dep.amount.toLocaleString()} ကျပ်\n🎉 သင့်ဆီ 5% = <b>${commission5.toLocaleString()} ကျပ်</b> ရောက်ရှိပါပြီ`,
            { parse_mode: 'HTML' }).catch(() => {});
        }
      }
    }
    if (bot) bot.telegram.sendMessage(dep.userId,
      `✅ ငွေ ${dep.amount.toLocaleString()} ကျပ် သွင်းမှု အတည်ပြုပြီး!\n\nသင့်လက်ကျန်ငွေ ပေါင်းထည့်ပြီး 🎉`,
      Markup.inlineKeyboard([[Markup.button.webApp('🎮 ကစားမည်', FRONTEND_URL)]]) ).catch(()=>{});
    res.json({success:true});
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.post('/api/admin/deposits/:id/reject', isAdmin, async(req,res)=>{
  try {
    const { reason } = req.body;
    const TTL_72H = new Date(Date.now() + 72 * 60 * 60 * 1000);
    const dep=await Deposit.findByIdAndUpdate(req.params.id,
      {status:'rejected', processedAt:new Date(), expireAt:TTL_72H},
      {new:true});
    if (!dep) return res.status(404).json({error:'Deposit မတွေ့ပါ'});
    const reasonText = reason ? `\nအကြောင်းပြချက်: ${reason}` : '';
    if (bot) bot.telegram.sendMessage(dep.userId,
      `❌ ငွေ ${dep.amount.toLocaleString()} ကျပ် သွင်းမှု ပယ်ချပြီ\nTxn: ${dep.transactionId}${reasonText}`).catch(()=>{});
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
    const wd=await Withdrawal.findOneAndUpdate(
      { _id: req.params.id, status: 'pending' },
      { $set: { status: 'confirmed', processedAt: new Date(), expireAt: new Date(Date.now() + 72*60*60*1000) } },
      { new: true }
    );
    if (!wd) return res.status(400).json({error:'Withdrawal မတွေ့ပါ သို့မဟုတ် ပြင်ဆင်ပြီးသားဖြစ်သည်'});
    const wdUser = await User.findOne({telegramId:wd.userId}).select('firstName username').lean();
    const displayName = wdUser?.firstName || wdUser?.username || `User${wd.userId}`;
    const globalMsg = `🎉 အသုံးပြုသူ ${displayName} က ${wd.amount.toLocaleString()} MMK ထုတ်ယူမှု အောင်မြင်သွားပါပြီ!`;
    // ── Global Payout Notification — both event names for compatibility ──
    io.emit('globalPayout', { name: displayName, amount: wd.amount, message: globalMsg });
    io.emit('globalNoti',   { message: globalMsg });
    if (bot) bot.telegram.sendMessage(wd.userId,
      `✅ ငွေ ${wd.amount.toLocaleString()} ကျပ် ထုတ်မှု အတည်ပြုပြီး!\n${wd.paymentMethod === 'wave' ? '🌊 Wave Pay' : '📱 KPay'}: ${wd.kpayNumber} 🎉`).catch(()=>{});

    // ── Telegram Broadcast: Notify all other users about successful withdrawal ──
    // Build clickable mention for the withdrawn user
    (async () => {
      try {
        if (!bot) return;

        // Build clickable mention text
        const mentionText = wdUser?.username
          ? `@${wdUser.username}`
          : `<a href="tg://user?id=${wd.userId}">${displayName}</a>`;

        const broadcastMsg =
          `🎉 ဂုဏ်ယူပါတယ်! ► ငွေထုတ်ယူမှု အောင်မြင်ပါသည်။\n\n` +
          `ကစားသမား ${mentionText} သည် TicToeTic ဂိမ်းမှ ${wd.amount.toLocaleString()} MMK ကို အောင်မြင်စွာ ထုတ်ယူသွားပါပြီ! 💸\n\n` +
          `🎮 မိတ်ဆွေလည်း အခုပဲ ဝင်ရောက်ကစားပြီး အမြတ်တွေ ထုတ်ယူလိုက်ပါ!`;

        // Fetch all users except the withdrawn user, with telegramId
        const allUsers = await User.find(
          { telegramId: { $ne: wd.userId }, isBanned: { $ne: true } },
          { telegramId: 1, lastActive: 1, _id: 0 }
        ).lean();

        // Sort: online users (socket connected or recently active within 5 min) first
        const fiveMinAgo = Date.now() - 5 * 60 * 1000;
        const sorted = allUsers.sort((a, b) => {
          const aOnline = userSockets.has(a.telegramId) || (a.lastActive && new Date(a.lastActive).getTime() > fiveMinAgo);
          const bOnline = userSockets.has(b.telegramId) || (b.lastActive && new Date(b.lastActive).getTime() > fiveMinAgo);
          if (aOnline && !bOnline) return -1;
          if (!aOnline && bOnline) return 1;
          // Both same status: sort by lastActive descending
          return new Date(b.lastActive || 0).getTime() - new Date(a.lastActive || 0).getTime();
        });

        // Send with 100–200ms delay between each message to avoid Telegram spam block
        for (const u of sorted) {
          const delay = 100 + Math.floor(Math.random() * 101); // 100~200ms
          await new Promise(resolve => setTimeout(resolve, delay));
          bot.telegram.sendMessage(u.telegramId, broadcastMsg, { parse_mode: 'HTML' }).catch(() => {});
        }
      } catch (broadcastErr) {
        console.error('Withdrawal broadcast err:', broadcastErr.message);
      }
    })();
    // ── End Telegram Broadcast ──

    res.json({success:true});
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.post('/api/admin/withdrawals/:id/reject', isAdmin, async(req,res)=>{
  try {
    const wd=await Withdrawal.findById(req.params.id);
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

// High Balancers endpoint (balance >= 4000)
app.get('/api/admin/high-balancers', isAdmin, async(req,res)=>{
  try {
    const highUsers = await User.find({ balance: { $gte: 4000 }, isBanned: { $ne: true } })
      .sort({ balance: -1 })
      .lean();
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
        `💰 Admin မှ ${sign}${parseInt(amount).toLocaleString()} ကျပ်\n${reason?`မှတ်ချက်: ${reason}`:''}\nလက်ကျန်: ${u.balance.toLocaleString()} ကျပ်`).catch(()=>{});
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


// ===== Agent API =====

// Middleware: verify agent
async function isAgent(req, res, next) {
  const tid = parseInt(req.headers['x-telegram-id'] || req.query.telegramId);
  if (!tid) return res.status(401).json({ error: 'Telegram ID မပါ' });
  const user = await User.findOne({ telegramId: tid, role: 'agent' }).lean();
  if (!user) return res.status(403).json({ error: 'Agent မဟုတ်သေးပါ' });
  req.agentUser = user;
  next();
}

// Get agent panel data
app.get('/api/agent/panel', isAgent, async (req, res) => {
  try {
    const user = req.agentUser;
    let agent = await Agent.findOne({ telegramId: user.telegramId });
    if (!agent) {
      agent = new Agent({ telegramId: user.telegramId, referralCode: user.referralCode });
      await agent.save();
    }
    const totalReferrals = await User.countDocuments({ referredBy: user.telegramId });

    // Total Sales: sum of all confirmed deposits from agent's referral users
    const referredIds = (await User.find({ referredBy: user.telegramId }).select('telegramId').lean()).map(u => u.telegramId);
    const salesAgg = referredIds.length
      ? await Deposit.aggregate([
          { $match: { userId: { $in: referredIds }, status: 'confirmed' } },
          { $group: { _id: null, total: { $sum: '$amount' } } }
        ])
      : [];
    const totalSales = salesAgg[0]?.total || 0;

    res.json({
      telegramId: user.telegramId,
      firstName: user.firstName,
      username: user.username,
      balance: user.balance,
      referralCode: user.referralCode,
      botUsername: BOT_USERNAME,
      totalEarned: agent.totalEarned,
      totalReferrals,
      totalSales
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Get agent referrals
app.get('/api/agent/referrals', isAgent, async (req, res) => {
  try {
    const referrals = await User.find({ referredBy: req.agentUser.telegramId })
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
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ===== Agent Deposit Control =====

// Get pending deposits for agent's referral users
app.get('/api/agent/deposits', isAgent, async (req, res) => {
  try {
    const agentId = req.agentUser.telegramId;
    // Find all users referred by this agent
    const referredUsers = await User.find({ referredBy: agentId }).select('telegramId firstName username').lean();
    if (!referredUsers.length) return res.json([]);

    const referredIds = referredUsers.map(u => u.telegramId);
    const userMap = {};
    referredUsers.forEach(u => { userMap[u.telegramId] = u.firstName || u.username || `User${u.telegramId}`; });

    const status = req.query.status || 'pending';
    const deps = await Deposit.find({ userId: { $in: referredIds }, status })
      .sort({ createdAt: -1 }).limit(50).lean();

    const out = deps.map(d => ({
      ...d,
      userName: userMap[d.userId] || String(d.userId)
    }));
    res.json(out);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Agent confirms a deposit for their referral user
app.post('/api/agent/deposits/:id/confirm', isAgent, async (req, res) => {
  try {
    const agentId = req.agentUser.telegramId;

    // ── Atomic status flip: only proceed if status was 'pending' ──
    // This prevents double-confirm race condition even with simultaneous requests
    const dep = await Deposit.findOneAndUpdate(
      { _id: req.params.id, status: 'pending' },
      { $set: { status: 'confirming' } }, // temp lock state
      { new: false }
    );
    if (!dep) {
      // Either not found or already processed
      const existing = await Deposit.findById(req.params.id).lean();
      if (!existing) return res.status(404).json({ error: 'မတွေ့ပါ' });
      return res.status(400).json({ error: 'ပြင်ဆင်ပြီးသားဖြစ်သည် (Double confirm ကာကွယ်ထားသည်)' });
    }

    // Verify this deposit belongs to one of the agent's referrals
    const user = await User.findOne({ telegramId: dep.userId }).lean();
    if (!user || user.referredBy !== agentId) {
      // Revert lock
      await Deposit.findByIdAndUpdate(dep._id, { $set: { status: 'pending' } });
      return res.status(403).json({ error: 'ဤ User သည် သင့် Referral မဟုတ်ပါ' });
    }

    // ── Agent Wallet Check ──
    const agentFresh = await User.findOne({ telegramId: agentId }).lean();
    if (!agentFresh || agentFresh.balance < dep.amount) {
      // Revert lock
      await Deposit.findByIdAndUpdate(dep._id, { $set: { status: 'pending' } });
      return res.status(402).json({
        error: `လက်ကျန်ငွေ မလောက်ပါ (ကျန်: ${(agentFresh?.balance||0).toLocaleString()} ကျပ် / လိုသည်: ${dep.amount.toLocaleString()} ကျပ်)\nGame Developer ကို ဆက်သွယ်ပြီး ယူနစ်ဖြည့်ပါ`,
        insufficientBalance: true,
        agentBalance: agentFresh?.balance || 0,
        required: dep.amount
      });
    }

    // ── Finalize confirm ──
    const TTL_72H = new Date(Date.now() + 72 * 60 * 60 * 1000);
    await Deposit.findByIdAndUpdate(dep._id, {
      $set: { status: 'confirmed', processedAt: new Date(), processedBy: 'agent', expireAt: TTL_72H }
    });

    // Deduct from agent balance, credit to user balance — atomic via separate updates
    await User.findOneAndUpdate({ telegramId: agentId }, { $inc: { balance: -dep.amount } });
    await User.findOneAndUpdate({ telegramId: dep.userId }, { $inc: { balance: dep.amount } });

    // First deposit referral bonus (100 ကျပ် to agent)
    const prevDeps = await Deposit.countDocuments({ userId: dep.userId, status: 'confirmed', _id: { $ne: dep._id } });
    if (prevDeps === 0) {
      await User.findOneAndUpdate({ telegramId: agentId }, { $inc: { balance: 100 } });
      if (bot) bot.telegram.sendMessage(agentId,
        `🎉 Referral မှ ပထမဆုံး ငွေဖြည့်သောကြောင့် <b>၁၀၀ ကျပ်</b> ရရှိပါပြီ!`,
        { parse_mode: 'HTML' }).catch(() => {});
    }
    // ── Feature 1: First Deposit Bonus for user ──
    await applyFirstDepositBonus(dep.userId, dep.amount);

    // ── Deposit Commission 5% to agent ──
    const commission5 = Math.floor(dep.amount * 0.05);
    if (commission5 > 0) {
      await User.findOneAndUpdate({ telegramId: agentId }, { $inc: { balance: commission5 } });
      if (bot) bot.telegram.sendMessage(agentId,
        `💸 <b>Deposit Commission ရရှိပြီ!</b>\n👤 User ငွေဖြည့်: ${dep.amount.toLocaleString()} ကျပ်\n🎉 5% = <b>${commission5.toLocaleString()} ကျပ်</b> သင့် Balance ထဲ ရောက်ပြီ`,
        { parse_mode: 'HTML' }).catch(() => {});
    }

    // Notify user via bot
    const methodLabel = dep.paymentMethod === 'wave' ? '🌊 Wave Pay' : '📱 KPay';
    if (bot) bot.telegram.sendMessage(dep.userId,
      `✅ ငွေ ${dep.amount.toLocaleString()} ကျပ် သွင်းမှု အတည်ပြုပြီး!\n${methodLabel}\n\nသင့်လက်ကျန်ငွေ ပေါင်းထည့်ပြီး 🎉`,
      Markup.inlineKeyboard([[Markup.button.webApp('🎮 ကစားမည်', FRONTEND_URL)]]) ).catch(() => {});

    // Notify Admin about agent-confirmed deposit (record keeping)
    const agentName = agentFresh.firstName || agentFresh.username || `Agent${agentId}`;
    const userName = user.firstName || user.username || `User${dep.userId}`;
    if (bot) bot.telegram.sendMessage(ADMIN_ID,
      `🎯 <b>Agent မှ Deposit Confirm</b>\n👤 User: ${userName} (${dep.userId})\n💰 ${dep.amount.toLocaleString()} ကျပ် (${methodLabel})\n🎯 Agent: ${agentName} (${agentId})\n🔢 Txn: <code>${dep.transactionId}</code>`,
      { parse_mode: 'HTML' }).catch(() => {});

    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Agent rejects a deposit for their referral user
app.post('/api/agent/deposits/:id/reject', isAgent, async (req, res) => {
  try {
    const agentId = req.agentUser.telegramId;
    const { reason } = req.body;

    // Atomic reject — prevent double-click issues
    const dep = await Deposit.findOneAndUpdate(
      { _id: req.params.id, status: 'pending' },
      { $set: { status: 'rejected', processedAt: new Date(), processedBy: 'agent',
                expireAt: new Date(Date.now() + 72 * 60 * 60 * 1000) } },
      { new: true }
    );
    if (!dep) {
      const existing = await Deposit.findById(req.params.id).lean();
      if (!existing) return res.status(404).json({ error: 'မတွေ့ပါ' });
      return res.status(400).json({ error: 'ပြင်ဆင်ပြီးသားဖြစ်သည်' });
    }

    // Verify this deposit belongs to one of the agent's referrals
    const user = await User.findOne({ telegramId: dep.userId }).lean();
    if (!user || user.referredBy !== agentId) {
      return res.status(403).json({ error: 'ဤ User သည် သင့် Referral မဟုတ်ပါ' });
    }

    const reasonText = reason ? `\nအကြောင်းပြချက်: ${reason}` : '';
    if (bot) bot.telegram.sendMessage(dep.userId,
      `❌ ငွေ ${dep.amount.toLocaleString()} ကျပ် သွင်းမှု ပယ်ချပြီ\nTxn: ${dep.transactionId}${reasonText}`).catch(() => {});

    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Agent: Top-up user balance
app.post('/api/agent/topup-user', isAgent, async (req, res) => {
  try {
    const agentId = req.agentUser.telegramId;
    const { userId, amount } = req.body;
    const uid = parseInt(userId);
    const amt = parseInt(amount);
    if (!uid || isNaN(amt) || amt <= 0)
      return res.status(400).json({ error: 'userId နှင့် amount လိုအပ်သည်' });
    if (amt < 100)
      return res.status(400).json({ error: 'အနည်းဆုံး 100 ကျပ် မှ လွှဲနိုင်သည်' });

    // Check agent balance
    const agent = await User.findOne({ telegramId: agentId }).lean();
    if (!agent || agent.balance < amt)
      return res.status(402).json({ error: `လက်ကျန်ငွေ မလောက်ပါ (ကျန်: ${(agent?.balance||0).toLocaleString()} ကျပ်)` });

    const targetUser = await User.findOne({ telegramId: uid }).lean();
    if (!targetUser)
      return res.status(404).json({ error: 'User မတွေ့ပါ' });
    if (targetUser.isBanned)
      return res.status(403).json({ error: 'User ပိတ်ထားသည်' });

    // Transfer
    await User.findOneAndUpdate({ telegramId: agentId }, { $inc: { balance: -amt } });
    const updated = await User.findOneAndUpdate({ telegramId: uid }, { $inc: { balance: amt } }, { new: true });

    if (bot) {
      bot.telegram.sendMessage(uid,
        `💰 Agent မှ <b>${amt.toLocaleString()} ကျပ်</b> ဖြည့်ပေးပါပြီ!\n🏦 လက်ကျန်: ${updated.balance.toLocaleString()} ကျပ်`,
        { parse_mode: 'HTML' }).catch(() => {});
    }

    // Refresh agent balance for response
    const agentUpdated = await User.findOne({ telegramId: agentId }).select('balance').lean();
    res.json({ success: true, transferredAmount: amt, userNewBalance: updated.balance, agentNewBalance: agentUpdated.balance });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Agent: 3-Level Commission Stats
app.get('/api/agent/commission-stats', isAgent, async (req, res) => {
  try {
    const agentId = req.agentUser.telegramId;

    // L1: direct referrals
    const l1Users = await User.find({ referredBy: agentId }).select('telegramId firstName username').lean();
    const l1Ids = l1Users.map(u => u.telegramId);

    // L2: referrals of L1
    const l2Users = l1Ids.length
      ? await User.find({ referredBy: { $in: l1Ids } }).select('telegramId firstName username referredBy').lean()
      : [];
    const l2Ids = l2Users.map(u => u.telegramId);

    // L3: referrals of L2
    const l3Users = l2Ids.length
      ? await User.find({ referredBy: { $in: l2Ids } }).select('telegramId firstName username referredBy').lean()
      : [];

    // Count total games per level to estimate commissions
    const [l1Games, l2Games, l3Games] = await Promise.all([
      l1Ids.length ? Game.countDocuments({ players: { $in: l1Ids }, status: 'completed' }) : 0,
      l2Ids.length ? Game.countDocuments({ players: { $in: l2Ids }, status: 'completed' }) : 0,
      l3Users.length ? Game.countDocuments({ players: { $in: l3Users.map(u=>u.telegramId) }, status: 'completed' }) : 0,
    ]);

    res.json({
      l1: { count: l1Users.length, totalGames: l1Games, commissionPerGame: L1_COMMISSION, estimated: l1Games * L1_COMMISSION },
      l2: { count: l2Users.length, totalGames: l2Games, commissionPerGame: L2_COMMISSION, estimated: l2Games * L2_COMMISSION },
      l3: { count: l3Users.length, totalGames: l3Games, commissionPerGame: L3_COMMISSION, estimated: l3Games * L3_COMMISSION },
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Agent: Get own payment info (read-only, set by admin)
app.get('/api/agent/payment-info', isAgent, async (req, res) => {
  try {
    const agentDoc = await Agent.findOne({ telegramId: req.agentUser.telegramId }).lean();
    if (!agentDoc) return res.json({ kpayNumber: '', kpayName: '', waveNumber: '', waveName: '', hasWave: false });
    res.json({
      kpayNumber: agentDoc.agentKpayNumber || '',
      kpayName: agentDoc.agentKpayName || '',
      waveNumber: agentDoc.agentWaveNumber || '',
      waveName: agentDoc.agentWaveName || '',
      hasWave: agentDoc.hasWave || false
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});



// Get payment info for a user (shows agent's kpay if referred by agent with kpay info)
app.get('/api/payment-info/:telegramId', async (req, res) => {
  try {
    const tid = parseInt(req.params.telegramId);
    const user = await User.findOne({ telegramId: tid }).lean();
    if (!user) return res.status(404).json({ error: 'User မတွေ့ပါ' });

    // Default admin kpay info (fallback)
    const defaultInfo = {
      kpayNumber: process.env.ADMIN_KPAY_NUMBER || '09792310926',
      kpayName: process.env.ADMIN_KPAY_NAME || 'Daw Mi Thaung',
      hasWave: true,
      waveNumber: process.env.ADMIN_WAVE_NUMBER || '09792310926',
      waveName: process.env.ADMIN_WAVE_NAME || 'Min Oak Soe',
      isAgentPayment: false
    };

    if (!user.referredBy) return res.json(defaultInfo);

    // Check if the referring agent has custom payment info (kpay or wave)
    const agentDoc = await Agent.findOne({ telegramId: user.referredBy }).lean();
    if (!agentDoc || (!agentDoc.agentKpayNumber && !agentDoc.agentWaveNumber)) return res.json(defaultInfo);

    // Return agent-specific payment info
    res.json({
      kpayNumber: agentDoc.agentKpayNumber,
      kpayName: agentDoc.agentKpayName || '',
      hasWave: agentDoc.hasWave || false,
      waveNumber: agentDoc.agentWaveNumber || '',
      waveName: agentDoc.agentWaveName || '',
      isAgentPayment: true
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/agents/:tid/payment-info', isAdmin, async (req, res) => {
  try {
    const tid = parseInt(req.params.tid);
    const { kpayNumber, kpayName, hasWave, waveNumber, waveName } = req.body;

    // Require at least one payment method
    const hasKpay = !!(kpayNumber && kpayNumber.trim());
    const hasWaveVal = !!(hasWave && waveNumber && waveNumber.trim());
    if (!hasKpay && !hasWaveVal) {
      return res.status(400).json({ error: 'KPay သို့မဟုတ် Wave Pay အနည်းဆုံး တစ်ခု ထည့်ပေးပါ' });
    }

    const agent = await Agent.findOneAndUpdate(
      { telegramId: tid },
      { $set: {
          agentKpayNumber: kpayNumber || '',
          agentKpayName: kpayName || '',
          hasWave: !!hasWave,
          agentWaveNumber: waveNumber || '',
          agentWaveName: waveName || ''
        }
      },
      { new: true, upsert: false }
    );
    if (!agent) return res.status(404).json({ error: 'Agent Data မတွေ့ပါ' });
    res.json({ success: true, agentKpayNumber: agent.agentKpayNumber, agentKpayName: agent.agentKpayName });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Admin: Balance top-up for agent
app.post('/api/admin/agents/:tid/balance', isAdmin, async (req, res) => {
  try {
    const tid = parseInt(req.params.tid);
    const { amount, reason } = req.body;
    const amt = parseInt(amount);
    if (isNaN(amt) || amt === 0) return res.status(400).json({ error: 'Amount မှားနေသည်' });
    const u = await User.findOneAndUpdate(
      { telegramId: tid, role: 'agent' },
      { $inc: { balance: amt } },
      { new: true }
    );
    if (!u) return res.status(404).json({ error: 'Agent မတွေ့ပါ' });
    if (bot) {
      const sign = amt > 0 ? '+' : '';
      bot.telegram.sendMessage(tid,
        `💰 <b>Admin မှ Balance ဖြည့်ပေးသည်</b>\n${sign}${amt.toLocaleString()} ကျပ်${reason ? `\nမှတ်ချက်: ${reason}` : ''}\n🏦 လက်ကျန်: ${u.balance.toLocaleString()} ကျပ်`,
        { parse_mode: 'HTML' }).catch(() => {});
    }
    res.json({ success: true, newBalance: u.balance });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Admin: Invited-from-agent overview (per-agent stats)
app.get('/api/admin/agent-referrals', isAdmin, async (req, res) => {
  try {
    const agents = await User.find({ role: 'agent' })
      .select('telegramId firstName username balance')
      .sort({ createdAt: -1 }).lean();

    const result = await Promise.all(agents.map(async agent => {
      const referredUsers = await User.find({ referredBy: agent.telegramId })
        .select('telegramId firstName username balance createdAt').lean();

      const referredIds = referredUsers.map(u => u.telegramId);

      // Active referrals: those who have at least 1 confirmed deposit
      let activeCount = 0;
      let totalSales = 0;
      if (referredIds.length) {
        const depositors = await Deposit.aggregate([
          { $match: { userId: { $in: referredIds }, status: 'confirmed' } },
          { $group: { _id: '$userId', total: { $sum: '$amount' } } }
        ]);
        activeCount = depositors.length;
        totalSales = depositors.reduce((s, d) => s + d.total, 0);
      }

      return {
        agentId: agent.telegramId,
        agentName: agent.firstName || agent.username || `Agent${agent.telegramId}`,
        agentBalance: agent.balance || 0,
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

// Admin: Make user an Agent
app.post('/api/admin/users/:tid/make-agent', isAdmin, async (req, res) => {
  try {
    const tid = parseInt(req.params.tid);
    const { isAgent: makeAgent } = req.body;
    const newRole = makeAgent ? 'agent' : 'user';
    const u = await User.findOneAndUpdate(
      { telegramId: tid },
      { role: newRole },
      { new: true }
    );
    if (!u) return res.status(404).json({ error: 'User မတွေ့ပါ' });

    if (makeAgent) {
      // Create agent record if not exists
      await Agent.findOneAndUpdate(
        { telegramId: tid },
        { $setOnInsert: { telegramId: tid, referralCode: u.referralCode } },
        { upsert: true }
      );
      if (bot) {
        bot.telegram.sendMessage(tid,
          `🎯 <b>Agent အဖြစ် ခွင့်ပြုပြီ!</b>\n\n🎉 မင်္ဂလာပါ Agent!\n\nBot တွင် <code>/agent</code> ရိုက်ပြီး Agent Panel ကို ဝင်ရောက်ပါ`,
          { parse_mode: 'HTML' }
        ).catch(() => {});
      }
    } else {
      if (bot) {
        bot.telegram.sendMessage(tid,
          `ℹ️ သင်၏ Agent အဆင့်ကို ဖယ်ရှားပြီးပါပြီ`,
          { parse_mode: 'HTML' }
        ).catch(() => {});
      }
    }

    res.json({ success: true, role: newRole });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Admin: List all agents
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
      return {
        ...u,
        agentData: agentDoc,
        totalReferrals
      };
    }));

    res.json({ agents: enriched, total, pages: Math.ceil(total / limit) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Admin: Get single agent details
app.get('/api/admin/agents/:tid', isAdmin, async (req, res) => {
  try {
    const tid = parseInt(req.params.tid);
    const user = await User.findOne({ telegramId: tid, role: 'agent' }).lean();
    if (!user) return res.status(404).json({ error: 'Agent မတွေ့ပါ' });
    const agentDoc = await Agent.findOne({ telegramId: tid }).lean();
    const referrals = await User.find({ referredBy: tid })
      .select('firstName username balance createdAt').sort({ createdAt: -1 }).lean();
    const totalReferrals = referrals.length;
    res.json({ user, agentData: agentDoc, referrals, totalReferrals });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ===== Redeem Code API =====

// User redeems a code
app.post('/api/redeem', async(req, res) => {
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

    // Atomic: add user to usedBy and credit balance
    await RedeemCode.updateOne({ _id: rc._id }, { $push: { usedBy: tid } });
    const updated = await User.findOneAndUpdate(
      { telegramId: tid },
      { $inc: { balance: rc.amount } },
      { new: true }
    );

    // Notify admin
    if (bot) bot.telegram.sendMessage(ADMIN_ID,
      `🎟️ Redeem Code အသုံးပြု
👤 ${user.firstName||user.username} (${tid})
🎫 Code: <code>${rc.code}</code>
💰 ${rc.amount.toLocaleString()} MMK`,
      { parse_mode: 'HTML' }).catch(() => {});

    res.json({ success: true, amount: rc.amount, newBalance: updated.balance });
  } catch(e) { console.error('redeem err:', e); res.status(500).json({ error: 'Server error' }); }
});

// Admin: create code
app.post('/api/admin/redeem/create', isAdmin, async(req, res) => {
  try {
    const { code, amount, maxUses } = req.body;
    if (!code || !amount) return res.status(400).json({ error: 'code နှင့် amount လိုသည်' });
    const amt = parseInt(amount);
    if (isNaN(amt) || amt <= 0) return res.status(400).json({ error: 'Amount မှားနေသည်' });
    const mx = parseInt(maxUses) || 1;
    const rc = await new RedeemCode({
      code: code.toUpperCase().trim(), amount: amt, maxUses: mx
    }).save();
    res.json({ success: true, code: rc });
  } catch(e) {
    if (e.code === 11000) return res.status(400).json({ error: 'ထို Code ရှိပြီးသားဖြစ်သည်' });
    res.status(500).json({ error: e.message });
  }
});

// Admin: list all codes
app.get('/api/admin/redeem/list', isAdmin, async(req, res) => {
  try {
    const codes = await RedeemCode.find().sort({ createdAt: -1 }).lean();
    res.json(codes);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Admin: toggle code active/inactive
app.post('/api/admin/redeem/:id/toggle', isAdmin, async(req, res) => {
  try {
    const rc = await RedeemCode.findById(req.params.id);
    if (!rc) return res.status(404).json({ error: 'Not found' });
    rc.isActive = !rc.isActive;
    await rc.save();
    res.json({ success: true, isActive: rc.isActive });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Admin: delete code
app.delete('/api/admin/redeem/:id', isAdmin, async(req, res) => {
  try {
    await RedeemCode.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
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
