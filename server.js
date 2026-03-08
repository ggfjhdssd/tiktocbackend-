const express = require('express');
const { Telegraf } = require('telegraf');
const { Server } = require('socket.io');
const http = require('http');
const mongoose = require('mongoose');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
const server = http.createServer(app);

// ==================== CORS ====================
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.json());

// ==================== Socket.io ====================
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  allowEIO3: true,
  transports: ['websocket', 'polling']
});

// ==================== Env Validation ====================
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = process.env.ADMIN_ID ? parseInt(process.env.ADMIN_ID) : null;
const MONGODB_URI1 = process.env.MONGODB_URI1;
const MONGODB_URI2 = process.env.MONGODB_URI2;

if (!BOT_TOKEN || !ADMIN_ID || !MONGODB_URI1) {
  console.error('❌ Missing required environment variables');
  process.exit(1);
}

// ==================== MongoDB ====================
let isConnected = false;

const connectDB = async () => {
  const uris = [MONGODB_URI1, MONGODB_URI2].filter(Boolean);
  for (const uri of uris) {
    try {
      if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
      await mongoose.connect(uri, {
        serverSelectionTimeoutMS: 10000,
        socketTimeoutMS: 45000,
      });
      isConnected = true;
      console.log('✅ MongoDB connected');
      return;
    } catch (e) {
      console.error('❌ MongoDB connect failed:', e.message);
    }
  }
  console.error('❌ All MongoDB URIs failed, retrying in 10s...');
  setTimeout(connectDB, 10000);
};

mongoose.connection.on('disconnected', () => { isConnected = false; });
mongoose.connection.on('reconnected', () => { isConnected = true; });

connectDB();

// ==================== Schemas ====================
const userSchema = new mongoose.Schema({
  telegramId: { type: Number, required: true, unique: true },
  username: String,
  firstName: String,
  balance: { type: Number, default: 0 },
  referredBy: { type: Number, default: null },
  referralCode: { type: String, unique: true },
  createdAt: { type: Date, default: Date.now },
  totalGames: { type: Number, default: 0 },
  wins: { type: Number, default: 0 },
  losses: { type: Number, default: 0 }
});

const depositSchema = new mongoose.Schema({
  userId: { type: Number, required: true },
  kpayName: String,
  transactionId: { type: String, required: true, unique: true },
  amount: { type: Number, required: true },
  status: { type: String, enum: ['pending', 'confirmed', 'rejected'], default: 'pending' },
  createdAt: { type: Date, default: Date.now },
  confirmedAt: Date
});

const withdrawalSchema = new mongoose.Schema({
  userId: { type: Number, required: true },
  kpayName: String,
  kpayNumber: String,
  amount: { type: Number, required: true },
  status: { type: String, enum: ['pending', 'confirmed', 'rejected'], default: 'pending' },
  createdAt: { type: Date, default: Date.now },
  confirmedAt: Date
});

const gameSchema = new mongoose.Schema({
  gameId: { type: String, required: true, unique: true },
  players: [{ type: Number }],
  board: { type: mongoose.Schema.Types.Mixed, default: () => Array(5).fill(null).map(() => Array(5).fill('')) },
  currentTurn: { type: Number, default: null },
  gameStartTime: { type: Date, default: Date.now },
  turnStartTime: { type: Date, default: Date.now },
  winner: { type: Number, default: null },
  status: { type: String, enum: ['waiting', 'active', 'completed'], default: 'waiting' },
  isBotGame: { type: Boolean, default: false }
});

const User = mongoose.model('User', userSchema);
const Deposit = mongoose.model('Deposit', depositSchema);
const Withdrawal = mongoose.model('Withdrawal', withdrawalSchema);
const Game = mongoose.model('Game', gameSchema);

// ==================== Helpers ====================
function generateReferralCode(telegramId) {
  return 'TIC' + telegramId.toString(36).toUpperCase() + Math.random().toString(36).substr(2, 4).toUpperCase();
}

// FIX: Accept initData OR direct telegramId for dev/testing fallback
function validateInitData(initData) {
  if (!initData) return null;
  try {
    // Standard Telegram initData format
    const urlParams = new URLSearchParams(initData);
    const userStr = urlParams.get('user');
    if (userStr) {
      return JSON.parse(userStr);
    }
    // Fallback: try parsing as direct JSON (for testing)
    return JSON.parse(initData);
  } catch (e) {
    return null;
  }
}

function generateGameId() {
  return 'game_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

// ==================== AI (Heuristic - fast) ====================
class TicTacToeAI {
  checkWin(board, symbol) {
    for (let i = 0; i < 5; i++) {
      for (let j = 0; j <= 1; j++) {
        if (board[i][j] === symbol && board[i][j+1] === symbol && board[i][j+2] === symbol && board[i][j+3] === symbol) return true;
      }
    }
    for (let i = 0; i <= 1; i++) {
      for (let j = 0; j < 5; j++) {
        if (board[i][j] === symbol && board[i+1][j] === symbol && board[i+2][j] === symbol && board[i+3][j] === symbol) return true;
      }
    }
    for (let i = 0; i <= 1; i++) {
      for (let j = 0; j <= 1; j++) {
        if (board[i][j] === symbol && board[i+1][j+1] === symbol && board[i+2][j+2] === symbol && board[i+3][j+3] === symbol) return true;
      }
    }
    for (let i = 0; i <= 1; i++) {
      for (let j = 3; j < 5; j++) {
        if (board[i][j] === symbol && board[i+1][j-1] === symbol && board[i+2][j-2] === symbol && board[i+3][j-3] === symbol) return true;
      }
    }
    return false;
  }

  scoreCell(board, row, col, symbol) {
    let score = 0;
    const dirs = [[0,1],[1,0],[1,1],[1,-1]];
    for (const [dr, dc] of dirs) {
      let count = 1, blocked = 0;
      for (let k = 1; k < 4; k++) {
        const r = row + dr*k, c = col + dc*k;
        if (r < 0 || r >= 5 || c < 0 || c >= 5) { blocked++; break; }
        if (board[r][c] === symbol) count++;
        else if (board[r][c] !== '') { blocked++; break; }
        else break;
      }
      for (let k = 1; k < 4; k++) {
        const r = row - dr*k, c = col - dc*k;
        if (r < 0 || r >= 5 || c < 0 || c >= 5) { blocked++; break; }
        if (board[r][c] === symbol) count++;
        else if (board[r][c] !== '') { blocked++; break; }
        else break;
      }
      if (count >= 4) score += 10000;
      else if (count === 3 && blocked === 0) score += 500;
      else if (count === 3) score += 100;
      else if (count === 2 && blocked === 0) score += 50;
    }
    return score;
  }

  getBestMove(board, currentPlayer) {
    const opponent = currentPlayer === 'X' ? 'O' : 'X';
    let best = -1, bestMove = null;
    const empty = [];
    for (let i = 0; i < 5; i++)
      for (let j = 0; j < 5; j++)
        if (board[i][j] === '') empty.push([i, j]);
    
    if (empty.length === 25) return [2, 2]; // Start center
    
    for (const [r, c] of empty) {
      board[r][c] = currentPlayer;
      const attackScore = this.scoreCell(board, r, c, currentPlayer);
      board[r][c] = '';
      board[r][c] = opponent;
      const defenseScore = this.scoreCell(board, r, c, opponent);
      board[r][c] = '';
      const score = Math.max(attackScore, defenseScore * 0.9);
      if (score > best) { best = score; bestMove = [r, c]; }
    }
    return bestMove || empty[Math.floor(Math.random() * empty.length)];
  }
}

const ai = new TicTacToeAI();

// ==================== Bot ====================
let bot;
try {
  bot = new Telegraf(BOT_TOKEN);

  bot.start(async (ctx) => {
    const userId = ctx.from.id;
    const args = ctx.payload;
    try {
      let user = await User.findOne({ telegramId: userId });
      if (!user) {
        user = new User({
          telegramId: userId,
          username: ctx.from.username || '',
          firstName: ctx.from.first_name || '',
          referralCode: generateReferralCode(userId)
        });
        if (args) {
          const referrer = await User.findOne({ referralCode: args });
          if (referrer && referrer.telegramId !== userId) {
            user.referredBy = referrer.telegramId;
          }
        }
        await user.save();
      }
      const webAppUrl = 'https://tictokfrontend.vercel.app';
      ctx.reply(`🎮 မင်္ဂလာပါ ${ctx.from.first_name}!\n\n💰 လက်ကျန်: ${user.balance} MMK\n\nကစားရန် PLAY ကိုနှိပ်ပါ 👇`, {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🎮 PLAY GAME', web_app: { url: webAppUrl } }],
            [{ text: '💰 Balance', callback_data: 'balance' }, { text: '🔗 Referral', callback_data: 'referral' }]
          ]
        }
      });
    } catch (error) {
      console.error('Bot start error:', error);
      ctx.reply('⚠️ ဝန်ဆောင်မှု ယာယီရပ်နားနေပါသည်။ ခဏနေ ပြန်ကြိုးစားပါ။');
    }
  });

  bot.action('referral', async (ctx) => {
    try {
      const user = await User.findOne({ telegramId: ctx.from.id });
      if (user) {
        const botUsername = ctx.botInfo?.username || 'tictoe1_bot';
        await ctx.answerCbQuery();
        ctx.reply(`🔗 သင့် Referral Link:\nhttps://t.me/${botUsername}?start=${user.referralCode}\n\nမိတ်ဆွေတစ်ဦး 1000 MMK ဖြည့်တိုင်း 100 MMK ရမည်!`);
      }
    } catch (e) { ctx.answerCbQuery(); }
  });

  bot.action('balance', async (ctx) => {
    try {
      const user = await User.findOne({ telegramId: ctx.from.id });
      if (user) {
        await ctx.answerCbQuery();
        ctx.reply(`💰 လက်ကျန်ငွေ: ${user.balance} MMK\n🎮 ကစားမှုအရေအတွက်: ${user.totalGames}\n🏆 နိုင်မှု: ${user.wins} | ရှုံးမှု: ${user.losses}`);
      }
    } catch (e) { ctx.answerCbQuery(); }
  });

  bot.command('admin', (ctx) => {
    if (ctx.from.id === ADMIN_ID) {
      ctx.reply('👑 Admin Panel', {
        reply_markup: {
          inline_keyboard: [[{ text: '⚙️ Admin Panel', web_app: { url: 'https://tictokfrontend.vercel.app/admin.html' } }]]
        }
      });
    } else {
      ctx.reply('⛔ ခွင့်ပြုချက်မရှိပါ။');
    }
  });

  bot.launch().then(() => console.log('✅ Bot started')).catch(err => console.error('❌ Bot failed:', err));
} catch (e) {
  console.error('Bot init error:', e);
}

// ==================== API Routes ====================
app.get('/', (req, res) => res.json({ status: 'ok', message: 'TicToeTic Backend', time: new Date() }));

app.get('/health', (req, res) => res.json({
  status: 'ok',
  mongodb: isConnected ? 'connected' : 'disconnected',
  uptime: process.uptime()
}));

// AUTH - FIX: Better error handling + dev mode fallback
app.post('/api/auth', async (req, res) => {
  try {
    const { initData, telegramId: directId } = req.body;
    
    let telegramId, username, firstName;
    
    if (directId) {
      // Dev mode / direct ID
      telegramId = parseInt(directId);
      username = 'User' + telegramId;
      firstName = 'User';
    } else {
      const userData = validateInitData(initData);
      if (!userData) {
        return res.status(401).json({ error: 'Invalid Telegram auth data. Please open from Telegram.' });
      }
      telegramId = userData.id;
      username = userData.username || '';
      firstName = userData.first_name || '';
    }

    let user = await User.findOne({ telegramId });
    if (!user) {
      user = new User({
        telegramId,
        username,
        firstName,
        referralCode: generateReferralCode(telegramId)
      });
      await user.save();
    } else {
      let changed = false;
      if (username && user.username !== username) { user.username = username; changed = true; }
      if (firstName && user.firstName !== firstName) { user.firstName = firstName; changed = true; }
      if (changed) await user.save();
    }

    res.json({
      telegramId: user.telegramId,
      username: user.username || user.firstName || 'User',
      firstName: user.firstName,
      balance: user.balance,
      referralCode: user.referralCode,
      totalGames: user.totalGames,
      wins: user.wins,
      losses: user.losses
    });
  } catch (error) {
    console.error('Auth error:', error);
    res.status(500).json({ error: 'Server error: ' + error.message });
  }
});

app.get('/api/user/:telegramId', async (req, res) => {
  try {
    const user = await User.findOne({ telegramId: parseInt(req.params.telegramId) });
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ balance: user.balance, totalGames: user.totalGames, wins: user.wins, losses: user.losses });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/deposit', async (req, res) => {
  try {
    const { telegramId, kpayName, transactionId, amount } = req.body;
    if (!telegramId || !kpayName || !transactionId || !amount) {
      return res.status(400).json({ error: 'ကွင်းအားလုံး ဖြည့်ပါ' });
    }
    if (amount < 1000) return res.status(400).json({ error: 'အနည်းဆုံး 1000 MMK လိုပါသည်' });

    const user = await User.findOne({ telegramId: parseInt(telegramId) });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const existing = await Deposit.findOne({ transactionId });
    if (existing) return res.status(400).json({ error: 'Transaction ID ကိုအသုံးပြုပြီးပါပြီ' });

    const deposit = new Deposit({ userId: user.telegramId, kpayName, transactionId, amount });
    await deposit.save();

    try {
      await bot.telegram.sendMessage(ADMIN_ID,
        `💰 *ငွေသွင်း တောင်းဆိုမှု*\n\nUser: ${user.username || user.firstName || 'N/A'} (${user.telegramId})\nပမာဏ: ${amount} MMK\nKPay Name: ${kpayName}\nTransaction ID: \`${transactionId}\``,
        { parse_mode: 'Markdown' }
      );
    } catch (e) { console.error('Bot notify error:', e.message); }

    res.json({ success: true, depositId: deposit._id });
  } catch (error) {
    console.error('Deposit error:', error);
    res.status(500).json({ error: 'Server error: ' + error.message });
  }
});

app.post('/api/withdraw', async (req, res) => {
  try {
    const { telegramId, kpayName, kpayNumber, amount } = req.body;
    if (!telegramId || !kpayName || !kpayNumber || !amount) {
      return res.status(400).json({ error: 'ကွင်းအားလုံး ဖြည့်ပါ' });
    }
    if (amount < 3000) return res.status(400).json({ error: 'အနည်းဆုံး 3000 MMK မှ ထုတ်ယူနိုင်သည်' });

    const user = await User.findOne({ telegramId: parseInt(telegramId) });
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.balance < amount) return res.status(400).json({ error: 'လက်ကျန်ငွေ မလုံလောက်ပါ' });

    const withdrawal = new Withdrawal({ userId: user.telegramId, kpayName, kpayNumber, amount });
    await withdrawal.save();

    try {
      await bot.telegram.sendMessage(ADMIN_ID,
        `💸 *ငွေထုတ် တောင်းဆိုမှု*\n\nUser: ${user.username || user.firstName || 'N/A'} (${user.telegramId})\nပမာဏ: ${amount} MMK\nKPay Name: ${kpayName}\nKPay Number: ${kpayNumber}`,
        { parse_mode: 'Markdown' }
      );
    } catch (e) { console.error('Bot notify error:', e.message); }

    res.json({ success: true, withdrawalId: withdrawal._id });
  } catch (error) {
    console.error('Withdrawal error:', error);
    res.status(500).json({ error: 'Server error: ' + error.message });
  }
});

// Admin routes
app.get('/api/admin/pending', async (req, res) => {
  try {
    const { adminId } = req.query;
    if (parseInt(adminId) !== ADMIN_ID) return res.status(403).json({ error: 'Unauthorized' });

    const [deposits, withdrawals] = await Promise.all([
      Deposit.find({ status: 'pending' }).sort({ createdAt: -1 }),
      Withdrawal.find({ status: 'pending' }).sort({ createdAt: -1 })
    ]);

    const userIds = [...new Set([...deposits.map(d => d.userId), ...withdrawals.map(w => w.userId)])];
    const users = await User.find({ telegramId: { $in: userIds } });
    const userMap = users.reduce((acc, u) => ({ ...acc, [u.telegramId]: u }), {});

    res.json({
      deposits: deposits.map(d => ({ ...d.toObject(), username: userMap[d.userId]?.username || userMap[d.userId]?.firstName, userBalance: userMap[d.userId]?.balance })),
      withdrawals: withdrawals.map(w => ({ ...w.toObject(), username: userMap[w.userId]?.username || userMap[w.userId]?.firstName, userBalance: userMap[w.userId]?.balance }))
    });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/admin/stats', async (req, res) => {
  try {
    const { adminId } = req.query;
    if (parseInt(adminId) !== ADMIN_ID) return res.status(403).json({ error: 'Unauthorized' });

    const [totalUsers, totalGames, pendingDeposits, pendingWithdrawals, confirmedDeposits] = await Promise.all([
      User.countDocuments(),
      Game.countDocuments({ status: 'completed' }),
      Deposit.countDocuments({ status: 'pending' }),
      Withdrawal.countDocuments({ status: 'pending' }),
      Deposit.aggregate([{ $match: { status: 'confirmed' } }, { $group: { _id: null, total: { $sum: '$amount' } } }])
    ]);

    res.json({
      totalUsers,
      totalGames,
      pendingDeposits,
      pendingWithdrawals,
      totalDeposited: confirmedDeposits[0]?.total || 0
    });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/admin/confirm-deposit', async (req, res) => {
  try {
    const { adminId, depositId } = req.body;
    if (parseInt(adminId) !== ADMIN_ID) return res.status(403).json({ error: 'Unauthorized' });

    const deposit = await Deposit.findById(depositId);
    if (!deposit) return res.status(404).json({ error: 'Deposit not found' });
    if (deposit.status !== 'pending') return res.status(400).json({ error: 'Already processed' });

    deposit.status = 'confirmed';
    deposit.confirmedAt = new Date();
    await deposit.save();

    const user = await User.findOne({ telegramId: deposit.userId });
    if (user) {
      user.balance += deposit.amount;
      await user.save();

      // Referral bonus
      if (user.referredBy) {
        const referrer = await User.findOne({ telegramId: user.referredBy });
        if (referrer) {
          referrer.balance += 100;
          await referrer.save();
          try {
            await bot.telegram.sendMessage(referrer.telegramId,
              `🎉 မိတ်ဆွေ @${user.username || user.telegramId} ၏ ${deposit.amount} MMK ဖြည့်မှုအတွက် Referral ကြေး 100 MMK ရပါပြီ!\nလက်ကျန်: ${referrer.balance} MMK`
            );
          } catch (e) {}
        }
      }

      try {
        await bot.telegram.sendMessage(deposit.userId,
          `✅ *ငွေသွင်း အတည်ပြုပြီး*\n\n${deposit.amount} MMK ဖြည့်ပြီးပါပြီ!\nလက်ကျန်: ${user.balance} MMK`,
          { parse_mode: 'Markdown' }
        );
      } catch (e) {}
    }

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Server error: ' + error.message });
  }
});

app.post('/api/admin/reject-deposit', async (req, res) => {
  try {
    const { adminId, depositId, reason } = req.body;
    if (parseInt(adminId) !== ADMIN_ID) return res.status(403).json({ error: 'Unauthorized' });

    const deposit = await Deposit.findById(depositId);
    if (!deposit) return res.status(404).json({ error: 'Deposit not found' });

    deposit.status = 'rejected';
    await deposit.save();

    try {
      await bot.telegram.sendMessage(deposit.userId,
        `❌ *ငွေသွင်း ငြင်းပယ်ခံရသည်*\n\n${deposit.amount} MMK ငြင်းပယ်ခံရပါသည်.\nအကြောင်းပြချက်: ${reason || 'Admin ကိုဆက်သွယ်ပါ'}`,
        { parse_mode: 'Markdown' }
      );
    } catch (e) {}

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/admin/confirm-withdrawal', async (req, res) => {
  try {
    const { adminId, withdrawalId } = req.body;
    if (parseInt(adminId) !== ADMIN_ID) return res.status(403).json({ error: 'Unauthorized' });

    const withdrawal = await Withdrawal.findById(withdrawalId);
    if (!withdrawal) return res.status(404).json({ error: 'Withdrawal not found' });
    if (withdrawal.status !== 'pending') return res.status(400).json({ error: 'Already processed' });

    const user = await User.findOne({ telegramId: withdrawal.userId });
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.balance < withdrawal.amount) return res.status(400).json({ error: 'Insufficient balance' });

    user.balance -= withdrawal.amount;
    await user.save();

    withdrawal.status = 'confirmed';
    withdrawal.confirmedAt = new Date();
    await withdrawal.save();

    try {
      await bot.telegram.sendMessage(withdrawal.userId,
        `✅ *ငွေထုတ် အတည်ပြုပြီး*\n\n${withdrawal.amount} MMK ပေးပို့ပြီးပါပြီ!\nKPay: ${withdrawal.kpayName} (${withdrawal.kpayNumber})\nလက်ကျန်: ${user.balance} MMK`,
        { parse_mode: 'Markdown' }
      );
    } catch (e) {}

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Server error: ' + error.message });
  }
});

app.post('/api/admin/reject-withdrawal', async (req, res) => {
  try {
    const { adminId, withdrawalId, reason } = req.body;
    if (parseInt(adminId) !== ADMIN_ID) return res.status(403).json({ error: 'Unauthorized' });

    const withdrawal = await Withdrawal.findById(withdrawalId);
    if (!withdrawal) return res.status(404).json({ error: 'Withdrawal not found' });

    withdrawal.status = 'rejected';
    await withdrawal.save();

    try {
      await bot.telegram.sendMessage(withdrawal.userId,
        `❌ *ငွေထုတ် ငြင်းပယ်ခံရသည်*\n\n${withdrawal.amount} MMK ငြင်းပယ်ခံရပါသည်.\nအကြောင်းပြချက်: ${reason || 'Admin ကိုဆက်သွယ်ပါ'}`,
        { parse_mode: 'Markdown' }
      );
    } catch (e) {}

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ==================== Socket.io Game Logic ====================
const waitingQueue = []; // { socketId, userId, gameId }
const gameTurnTimeouts = new Map();
const activeGames = new Map(); // gameId -> { aiTimeout }
const socketUserMap = new Map(); // socketId -> userId

io.on('connection', (socket) => {
  console.log('👤 Connected:', socket.id);

  socket.on('findGame', async (data) => {
    try {
      // FIX: Accept userId from socket auth OR from event data
      const userId = parseInt(socket.handshake.auth?.token || data?.userId);
      if (!userId) {
        socket.emit('error', { message: 'Authentication required' });
        return;
      }

      socketUserMap.set(socket.id, userId);

      const user = await User.findOne({ telegramId: userId });
      if (!user) {
        socket.emit('error', { message: 'User not found' });
        return;
      }
      if (user.balance < 1000) {
        socket.emit('error', { message: 'လက်ကျန်ငွေ မလုံလောက်ပါ (1000 MMK လိုအပ်သည်)' });
        return;
      }

      // Deduct entry fee
      user.balance -= 1000;
      user.totalGames += 1;
      await user.save();

      // FIX: Check waiting queue for opponent
      const waitingPlayer = waitingQueue.find(p => p.userId !== userId);
      
      if (waitingPlayer) {
        // Found opponent - start game
        const idx = waitingQueue.indexOf(waitingPlayer);
        waitingQueue.splice(idx, 1);
        
        const gameId = generateGameId();
        const game = new Game({
          gameId,
          players: [waitingPlayer.userId, userId],
          status: 'active',
          currentTurn: waitingPlayer.userId,
          gameStartTime: new Date(),
          turnStartTime: new Date(),
          isBotGame: false
        });
        await game.save();

        // Clear waiting timeout for first player
        if (activeGames.has(waitingPlayer.gameId)) {
          const wd = activeGames.get(waitingPlayer.gameId);
          if (wd.aiTimeout) clearTimeout(wd.aiTimeout);
          activeGames.delete(waitingPlayer.gameId);
        }

        // Join both to room
        const waitingSocket = io.sockets.sockets.get(waitingPlayer.socketId);
        if (waitingSocket) waitingSocket.join(gameId);
        socket.join(gameId);

        activeGames.set(gameId, {});

        io.to(gameId).emit('gameStarted', {
          gameId,
          players: game.players,
          currentTurn: game.currentTurn,
          isBot: false,
          board: game.board,
          turnStartTime: game.turnStartTime
        });

        startTurnTimer(gameId);

      } else {
        // Add to waiting queue
        const gameId = generateGameId();
        waitingQueue.push({ socketId: socket.id, userId, gameId });
        socket.join(gameId);
        socket.emit('waitingForPlayer', { gameId });

        // 30s timeout -> AI game
        const aiTimeout = setTimeout(async () => {
          try {
            const qIdx = waitingQueue.findIndex(p => p.userId === userId);
            if (qIdx === -1) return; // Already matched
            waitingQueue.splice(qIdx, 1);

            const game = new Game({
              gameId,
              players: [userId, 0],
              status: 'active',
              currentTurn: userId,
              gameStartTime: new Date(),
              turnStartTime: new Date(),
              isBotGame: true
            });
            await game.save();

            activeGames.set(gameId, {});

            io.to(gameId).emit('gameStarted', {
              gameId,
              players: game.players,
              currentTurn: game.currentTurn,
              isBot: true,
              board: game.board,
              turnStartTime: game.turnStartTime
            });

            startTurnTimer(gameId);
          } catch (e) {
            console.error('AI timeout error:', e);
          }
        }, 30000);

        activeGames.set(gameId, { aiTimeout });
      }
    } catch (error) {
      console.error('findGame error:', error);
      socket.emit('error', { message: 'ဂိမ်းစတင်မှု မအောင်မြင်ပါ: ' + error.message });
    }
  });

  socket.on('makeMove', async ({ gameId, row, col }) => {
    try {
      const userId = socketUserMap.get(socket.id);
      if (!userId) return socket.emit('error', { message: 'Not authenticated' });

      const game = await Game.findOne({ gameId });
      if (!game || game.status !== 'active') {
        return socket.emit('error', { message: 'Game not active' });
      }
      if (game.currentTurn !== userId) {
        return socket.emit('error', { message: 'သင့်လှည့် မဟုတ်ပါ' });
      }
      if (game.board[row][col] !== '') {
        return socket.emit('error', { message: 'ထိုနေရာတွင် ကစားပြီးပါပြီ' });
      }

      // Check time
      const now = new Date();
      const elapsed = (now - game.turnStartTime) / 1000;
      if (elapsed > 6) {
        // Timeout - auto lose
        const winner = game.players.find(p => p !== userId) ?? 0;
        game.winner = winner;
        game.status = 'completed';
        game.markModified('board');
        await game.save();
        clearTurnTimer(gameId);
        io.to(gameId).emit('gameOver', { winner, board: game.board, reason: 'timeout' });
        await handleGameEnd(game);
        return;
      }

      const symbol = userId === game.players[0] ? 'X' : 'O';
      game.board[row][col] = symbol;
      game.markModified('board'); // FIX: needed for mongoose to detect nested array change
      game.turnStartTime = now;

      if (ai.checkWin(game.board, symbol)) {
        game.winner = userId;
        game.status = 'completed';
        await game.save();
        clearTurnTimer(gameId);
        io.to(gameId).emit('gameOver', { winner: userId, board: game.board, reason: 'win' });
        await handleGameEnd(game);
        return;
      }

      const isFull = game.board.every(r => r.every(c => c !== ''));
      if (isFull) {
        game.winner = -1;
        game.status = 'completed';
        await game.save();
        clearTurnTimer(gameId);
        io.to(gameId).emit('gameOver', { winner: -1, board: game.board, reason: 'draw' });
        await handleGameEnd(game);
        return;
      }

      game.currentTurn = game.players.find(p => p !== userId);
      game.turnStartTime = new Date();
      await game.save();

      io.to(gameId).emit('moveMade', {
        board: game.board,
        currentTurn: game.currentTurn,
        turnStartTime: game.turnStartTime
      });

      resetTurnTimer(gameId);

      // Bot move
      if (game.currentTurn === 0) {
        setTimeout(async () => {
          try {
            const g = await Game.findOne({ gameId });
            if (!g || g.status !== 'active' || g.currentTurn !== 0) return;

            const botSymbol = g.players[1] === 0 ? 'O' : 'X';
            const move = ai.getBestMove(g.board.map(r => [...r]), botSymbol);
            if (!move) return;

            const [br, bc] = move;
            g.board[br][bc] = botSymbol;
            g.markModified('board');
            g.turnStartTime = new Date();

            if (ai.checkWin(g.board, botSymbol)) {
              g.winner = 0;
              g.status = 'completed';
              await g.save();
              clearTurnTimer(gameId);
              io.to(gameId).emit('gameOver', { winner: 0, board: g.board, reason: 'bot_win' });
              await handleGameEnd(g);
              return;
            }

            const full = g.board.every(r => r.every(c => c !== ''));
            if (full) {
              g.winner = -1;
              g.status = 'completed';
              await g.save();
              clearTurnTimer(gameId);
              io.to(gameId).emit('gameOver', { winner: -1, board: g.board, reason: 'draw' });
              await handleGameEnd(g);
              return;
            }

            g.currentTurn = g.players[0];
            await g.save();
            io.to(gameId).emit('moveMade', { board: g.board, currentTurn: g.currentTurn, turnStartTime: g.turnStartTime });
            resetTurnTimer(gameId);
          } catch (e) {
            console.error('Bot move error:', e);
          }
        }, 1500);
      }
    } catch (error) {
      console.error('makeMove error:', error);
      socket.emit('error', { message: 'Move failed: ' + error.message });
    }
  });

  socket.on('cancelSearch', () => {
    const userId = socketUserMap.get(socket.id);
    if (!userId) return;
    const idx = waitingQueue.findIndex(p => p.userId === userId);
    if (idx !== -1) {
      const item = waitingQueue.splice(idx, 1)[0];
      if (activeGames.has(item.gameId)) {
        const d = activeGames.get(item.gameId);
        if (d.aiTimeout) clearTimeout(d.aiTimeout);
        activeGames.delete(item.gameId);
      }
      // Refund
      User.findOne({ telegramId: userId }).then(u => {
        if (u) { u.balance += 1000; u.totalGames -= 1; u.save(); }
      }).catch(() => {});
      socket.emit('searchCancelled');
    }
  });

  socket.on('disconnect', () => {
    const userId = socketUserMap.get(socket.id);
    socketUserMap.delete(socket.id);
    // Remove from waiting queue
    const idx = waitingQueue.findIndex(p => p.socketId === socket.id);
    if (idx !== -1) {
      const item = waitingQueue.splice(idx, 1)[0];
      if (activeGames.has(item.gameId)) {
        const d = activeGames.get(item.gameId);
        if (d.aiTimeout) clearTimeout(d.aiTimeout);
        activeGames.delete(item.gameId);
      }
      // Refund on disconnect while waiting
      if (userId) {
        User.findOne({ telegramId: userId }).then(u => {
          if (u) { u.balance += 1000; u.totalGames -= 1; u.save(); }
        }).catch(() => {});
      }
    }
    console.log('👋 Disconnected:', socket.id);
  });
});

function startTurnTimer(gameId) {
  const timeout = setTimeout(async () => {
    try {
      const game = await Game.findOne({ gameId });
      if (!game || game.status !== 'active') return;

      const elapsed = (Date.now() - game.turnStartTime) / 1000;
      if (elapsed >= 5) {
        const loser = game.currentTurn;
        const winner = game.players.find(p => p !== loser) ?? 0;
        game.winner = winner;
        game.status = 'completed';
        await game.save();
        clearTurnTimer(gameId);
        io.to(gameId).emit('gameOver', { winner, board: game.board, reason: 'timeout' });
        await handleGameEnd(game);
      } else {
        startTurnTimer(gameId);
      }
    } catch (e) {
      console.error('Turn timer error:', e);
    }
  }, 1000);
  gameTurnTimeouts.set(gameId, timeout);
}

function resetTurnTimer(gameId) {
  clearTurnTimer(gameId);
  startTurnTimer(gameId);
}

function clearTurnTimer(gameId) {
  const t = gameTurnTimeouts.get(gameId);
  if (t) { clearTimeout(t); gameTurnTimeouts.delete(gameId); }
}

async function handleGameEnd(game) {
  try {
    if (game.winner && game.winner !== -1 && game.winner !== 0) {
      // Human winner
      const winner = await User.findOne({ telegramId: game.winner });
      if (winner) {
        winner.balance += 1600;
        winner.wins += 1;
        await winner.save();
        try {
          await bot.telegram.sendMessage(game.winner,
            `🏆 *အနိုင်ရပြီ!*\n\n1600 MMK ရပါပြီ!\nလက်ကျန်: ${winner.balance} MMK`,
            { parse_mode: 'Markdown' }
          );
        } catch (e) {}
      }
      const loserId = game.players.find(p => p !== game.winner && p !== 0);
      if (loserId) {
        const loser = await User.findOne({ telegramId: loserId });
        if (loser) { loser.losses += 1; await loser.save(); }
      }
    } else if (game.winner === -1) {
      // Draw
      for (const pid of game.players) {
        if (pid === 0) continue;
        const u = await User.findOne({ telegramId: pid });
        if (u) { u.balance += 500; await u.save(); }
      }
    }
    // Bot wins - player already lost 1000

    if (activeGames.has(game.gameId)) {
      activeGames.delete(game.gameId);
    }
  } catch (e) {
    console.error('handleGameEnd error:', e);
  }
}

// ==================== Start ====================
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server running on port ${PORT}`);
});

process.on('SIGTERM', async () => {
  for (const t of gameTurnTimeouts.values()) clearTimeout(t);
  for (const d of activeGames.values()) if (d.aiTimeout) clearTimeout(d.aiTimeout);
  if (bot) bot.stop('SIGTERM');
  await mongoose.disconnect();
  server.close(() => process.exit(0));
});
