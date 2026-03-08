const express = require('express');
const { Telegraf } = require('telegraf');
const { Server } = require('socket.io');
const http = require('http');
const mongoose = require('mongoose');
const crypto = require('crypto');
const dotenv = require('dotenv');
const cors = require('cors');

// Load environment variables
dotenv.config();

const app = express();
const server = http.createServer(app);

// ==================== CORS Configuration ====================
// Simple CORS - အရင်ဆုံး ဒီလိုစမ်းပါ
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.use(express.json());

// ==================== Socket.io with CORS ====================
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
    credentials: true,
    transports: ['websocket', 'polling']
  },
  allowEIO3: true
});

// ==================== Environment Variables Validation ====================
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = process.env.ADMIN_ID ? parseInt(process.env.ADMIN_ID) : null;
const MONGODB_URI1 = process.env.MONGODB_URI1;
const MONGODB_URI2 = process.env.MONGODB_URI2;

console.log('🔍 Checking environment variables...');
console.log(`- BOT_TOKEN: ${BOT_TOKEN ? '✅ Set' : '❌ Not set'}`);
console.log(`- ADMIN_ID: ${ADMIN_ID ? '✅ Set' : '❌ Not set'}`);
console.log(`- MONGODB_URI1: ${MONGODB_URI1 ? '✅ Set' : '❌ Not set'}`);
console.log(`- MONGODB_URI2: ${MONGODB_URI2 ? '✅ Set' : '❌ Not set'}`);

// Validate required environment variables
if (!BOT_TOKEN) {
  console.error('❌ BOT_TOKEN is not set in environment variables');
  process.exit(1);
}

if (!ADMIN_ID) {
  console.error('❌ ADMIN_ID is not set in environment variables');
  process.exit(1);
}

if (!MONGODB_URI1) {
  console.error('❌ MONGODB_URI1 is not set in environment variables');
  process.exit(1);
}

// ==================== MongoDB Connection with Failover ====================
let isConnected = false;
let activeConnectionString = MONGODB_URI1;
let reconnectTimer = null;

const connectWithFailover = async (retryCount = 0) => {
  const maxRetries = 5;
  const baseDelay = 5000;

  const connectToURI = async (uri) => {
    if (!uri) {
      console.error('❌ MongoDB URI is undefined or null');
      return null;
    }

    try {
      console.log(`🔄 Attempting to connect to MongoDB...`);
      
      if (mongoose.connection.readyState !== 0) {
        await mongoose.disconnect();
      }

      const conn = await mongoose.connect(uri, {
        useNewUrlParser: true,
        useUnifiedTopology: true,
        serverSelectionTimeoutMS: 10000,
        socketTimeoutMS: 45000,
      });

      console.log(`✅ Connected to MongoDB successfully`);
      return conn;
    } catch (error) {
      console.error(`❌ Failed to connect to MongoDB:`, error.message);
      return null;
    }
  };

  // Try primary URI
  let connection = null;
  
  if (MONGODB_URI1) {
    connection = await connectToURI(MONGODB_URI1);
  }
  
  // If primary fails and secondary exists, try secondary
  if (!connection && MONGODB_URI2) {
    console.log('⚠️ Primary connection failed, switching to secondary...');
    connection = await connectToURI(MONGODB_URI2);
    if (connection) {
      activeConnectionString = MONGODB_URI2;
      console.log('✅ Successfully failed over to secondary MongoDB');
    }
  }

  if (!connection) {
    console.error('❌ All MongoDB connections failed.');
    
    if (retryCount < maxRetries) {
      const delay = baseDelay * Math.pow(2, retryCount);
      console.log(`⏰ Retrying in ${delay/1000} seconds... (Attempt ${retryCount + 1}/${maxRetries})`);
      
      reconnectTimer = setTimeout(() => {
        connectWithFailover(retryCount + 1);
      }, delay);
    } else {
      console.error('❌ Max retries reached. Continuing without database...');
    }
    return;
  }

  isConnected = true;

  // Monitor connection events
  mongoose.connection.on('disconnected', () => {
    console.log('❌ MongoDB disconnected!');
    isConnected = false;
  });

  mongoose.connection.on('error', (err) => {
    console.error('MongoDB error:', err);
    isConnected = false;
  });

  mongoose.connection.on('reconnected', () => {
    console.log('✅ MongoDB reconnected');
    isConnected = true;
  });
};

// Initialize connection
connectWithFailover();

// ==================== MongoDB Schemas ====================
const userSchema = new mongoose.Schema({
  telegramId: { type: Number, required: true, unique: true },
  username: String,
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
  board: { type: [[String]], default: () => Array(5).fill().map(() => Array(5).fill('')) },
  currentTurn: { type: Number, default: null },
  gameStartTime: { type: Date, default: Date.now },
  lastMoveTime: { type: Date, default: Date.now },
  turnStartTime: { type: Date, default: Date.now },
  winner: { type: Number, default: null },
  status: { type: String, enum: ['waiting', 'active', 'completed'], default: 'waiting' },
  isBotGame: { type: Boolean, default: false }
});

const User = mongoose.model('User', userSchema);
const Deposit = mongoose.model('Deposit', depositSchema);
const Withdrawal = mongoose.model('Withdrawal', withdrawalSchema);
const Game = mongoose.model('Game', gameSchema);

// ==================== Helper Functions ====================
function generateReferralCode(telegramId) {
  return 'TIC' + telegramId.toString(36).toUpperCase() + Math.random().toString(36).substr(2, 4).toUpperCase();
}

function validateInitData(initData) {
  try {
    const urlParams = new URLSearchParams(initData);
    const user = JSON.parse(urlParams.get('user'));
    return user;
  } catch (e) {
    return null;
  }
}

function generateGameId() {
  return 'game_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

// ==================== Minimax AI ====================
class TicTacToeAI {
  constructor() {
    this.boardSize = 5;
    this.winLength = 4;
  }

  checkWin(board, symbol) {
    // Check rows
    for (let i = 0; i < 5; i++) {
      for (let j = 0; j <= 1; j++) {
        if (board[i][j] === symbol && 
            board[i][j+1] === symbol && 
            board[i][j+2] === symbol && 
            board[i][j+3] === symbol) {
          return true;
        }
      }
    }

    // Check columns
    for (let i = 0; i <= 1; i++) {
      for (let j = 0; j < 5; j++) {
        if (board[i][j] === symbol && 
            board[i+1][j] === symbol && 
            board[i+2][j] === symbol && 
            board[i+3][j] === symbol) {
          return true;
        }
      }
    }

    // Check diagonals
    for (let i = 0; i <= 1; i++) {
      for (let j = 0; j <= 1; j++) {
        if (board[i][j] === symbol && 
            board[i+1][j+1] === symbol && 
            board[i+2][j+2] === symbol && 
            board[i+3][j+3] === symbol) {
          return true;
        }
      }
    }

    for (let i = 0; i <= 1; i++) {
      for (let j = 3; j < 5; j++) {
        if (board[i][j] === symbol && 
            board[i+1][j-1] === symbol && 
            board[i+2][j-2] === symbol && 
            board[i+3][j-3] === symbol) {
          return true;
        }
      }
    }

    return false;
  }

  getEmptyCells(board) {
    const empty = [];
    for (let i = 0; i < 5; i++) {
      for (let j = 0; j < 5; j++) {
        if (board[i][j] === '') empty.push([i, j]);
      }
    }
    return empty;
  }

  minimax(board, depth, isMaximizing, player, opponent, alpha, beta) {
    if (this.checkWin(board, player)) return 100 - depth;
    if (this.checkWin(board, opponent)) return -100 + depth;
    
    const emptyCells = this.getEmptyCells(board);
    if (emptyCells.length === 0) return 0;

    if (isMaximizing) {
      let best = -Infinity;
      for (let [row, col] of emptyCells) {
        board[row][col] = player;
        best = Math.max(best, this.minimax(board, depth + 1, false, player, opponent, alpha, beta));
        board[row][col] = '';
        alpha = Math.max(alpha, best);
        if (beta <= alpha) break;
      }
      return best;
    } else {
      let best = Infinity;
      for (let [row, col] of emptyCells) {
        board[row][col] = opponent;
        best = Math.min(best, this.minimax(board, depth + 1, true, player, opponent, alpha, beta));
        board[row][col] = '';
        beta = Math.min(beta, best);
        if (beta <= alpha) break;
      }
      return best;
    }
  }

  getBestMove(board, currentPlayer) {
    const player = currentPlayer;
    const opponent = currentPlayer === 'X' ? 'O' : 'X';
    
    let bestScore = -Infinity;
    let bestMove = null;
    
    const emptyCells = this.getEmptyCells(board);
    
    for (let [row, col] of emptyCells) {
      board[row][col] = player;
      let moveScore = this.minimax(board, 0, false, player, opponent, -Infinity, Infinity);
      board[row][col] = '';
      
      if (moveScore > bestScore) {
        bestScore = moveScore;
        bestMove = [row, col];
      }
    }
    
    return bestMove;
  }
}

const ai = new TicTacToeAI();

// ==================== Bot Setup ====================
const bot = new Telegraf(BOT_TOKEN);

bot.start(async (ctx) => {
  const userId = ctx.from.id;
  const args = ctx.payload;
  
  try {
    let user = await User.findOne({ telegramId: userId });
    
    if (!user) {
      user = new User({
        telegramId: userId,
        username: ctx.from.username,
        referralCode: generateReferralCode(userId)
      });
      
      if (args) {
        const referrer = await User.findOne({ referralCode: args });
        if (referrer) {
          user.referredBy = referrer.telegramId;
        }
      }
      
      await user.save();
    }

    const webAppUrl = 'https://tictokfrontend.vercel.app';
    ctx.reply('🎮 ဂိမ်းကစားရန် PLAY ကိုနှိပ်ပါ', {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🎮 PLAY GAME', web_app: { url: webAppUrl } }],
          [{ text: '🔗 Referral Link', callback_data: 'referral' }],
          [{ text: '💰 Balance', callback_data: 'balance' }]
        ]
      }
    });
  } catch (error) {
    console.error('Bot start error:', error);
    ctx.reply('⚠️ Service temporarily unavailable. Please try again later.');
  }
});

bot.action('referral', async (ctx) => {
  try {
    const user = await User.findOne({ telegramId: ctx.from.id });
    if (user) {
      const botUsername = ctx.botInfo.username;
      ctx.reply(`🔗 Your referral link:\nhttps://t.me/${botUsername}?start=${user.referralCode}\n\nWhen your friend deposits 1000 MMK, you get 100 MMK!`, {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔙 Back', callback_data: 'back_to_main' }]
          ]
        }
      });
    }
  } catch (error) {
    console.error('Referral action error:', error);
    ctx.reply('⚠️ Error fetching referral info');
  }
});

bot.action('balance', async (ctx) => {
  try {
    const user = await User.findOne({ telegramId: ctx.from.id });
    if (user) {
      ctx.reply(`💰 Your balance: ${user.balance} MMK`, {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔙 Back', callback_data: 'back_to_main' }]
          ]
        }
      });
    }
  } catch (error) {
    console.error('Balance action error:', error);
    ctx.reply('⚠️ Error fetching balance');
  }
});

bot.action('back_to_main', async (ctx) => {
  ctx.deleteMessage();
  bot.start(ctx);
});

bot.command('admin', (ctx) => {
  const userId = ctx.from.id;
  if (userId === ADMIN_ID) {
    const adminWebAppUrl = 'https://tictokfrontend.vercel.app/admin.html';
    ctx.reply('👑 Admin Panel သို့ဝင်ရန်', {
      reply_markup: {
        inline_keyboard: [
          [{ text: '⚙️ Admin Panel', web_app: { url: adminWebAppUrl } }]
        ]
      }
    });
  } else {
    ctx.reply('⛔ You are not authorized.');
  }
});

bot.launch().then(() => console.log('✅ Bot started')).catch(err => {
  console.error('❌ Bot failed to start:', err);
});

// ==================== API Routes ====================
// Health check endpoint
app.get('/', (req, res) => {
  res.json({ 
    status: 'ok', 
    message: 'TicToeTic Backend is running',
    time: new Date().toISOString()
  });
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    mongodb: isConnected ? 'connected' : 'disconnected',
    uptime: process.uptime(),
    env: {
      botToken: BOT_TOKEN ? '✅ Set' : '❌ Not set',
      adminId: ADMIN_ID ? '✅ Set' : '❌ Not set',
      mongodb1: MONGODB_URI1 ? '✅ Set' : '❌ Not set',
      mongodb2: MONGODB_URI2 ? '✅ Set' : '❌ Not set'
    }
  });
});

app.post('/api/auth', async (req, res) => {
  try {
    const { initData } = req.body;
    const userData = validateInitData(initData);
    if (!userData) {
      return res.status(401).json({ error: 'Invalid init data' });
    }

    const { id: telegramId, username } = userData;

    let user = await User.findOne({ telegramId });
    if (!user) {
      user = new User({ 
        telegramId, 
        username,
        referralCode: generateReferralCode(telegramId)
      });
      await user.save();
    } else if (username && user.username !== username) {
      user.username = username;
      await user.save();
    }

    res.json({ 
      telegramId: user.telegramId, 
      username: user.username, 
      balance: user.balance,
      referralCode: user.referralCode
    });
  } catch (error) {
    console.error('Auth error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/user/:telegramId', async (req, res) => {
  try {
    const { telegramId } = req.params;
    const user = await User.findOne({ telegramId: parseInt(telegramId) });
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ balance: user.balance });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/deposit', async (req, res) => {
  try {
    const { telegramId, kpayName, transactionId, amount } = req.body;
    if (amount < 1000) {
      return res.status(400).json({ error: 'Minimum deposit amount is 1000' });
    }

    const user = await User.findOne({ telegramId: parseInt(telegramId) });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const existing = await Deposit.findOne({ transactionId });
    if (existing) return res.status(400).json({ error: 'Transaction ID already used' });

    const deposit = new Deposit({
      userId: user.telegramId,
      kpayName,
      transactionId,
      amount
    });
    await deposit.save();

    await bot.telegram.sendMessage(ADMIN_ID, 
      `💰 *New Deposit Request*\n\nUser: ${user.username || 'N/A'} (${user.telegramId})\nAmount: ${amount} MMK\nKPay Name: ${kpayName}\nTransaction ID: ${transactionId}`,
      { parse_mode: 'Markdown' }
    );

    res.json({ success: true, depositId: deposit._id });
  } catch (error) {
    console.error('Deposit error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/withdraw', async (req, res) => {
  try {
    const { telegramId, kpayName, kpayNumber, amount } = req.body;
    if (amount < 3000) {
      return res.status(400).json({ error: 'Minimum withdrawal amount is 3000' });
    }

    const user = await User.findOne({ telegramId: parseInt(telegramId) });
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (user.balance < amount) {
      return res.status(400).json({ error: 'Insufficient balance' });
    }

    const withdrawal = new Withdrawal({
      userId: user.telegramId,
      kpayName,
      kpayNumber,
      amount
    });
    await withdrawal.save();

    await bot.telegram.sendMessage(ADMIN_ID,
      `💸 *New Withdrawal Request*\n\nUser: ${user.username || 'N/A'} (${user.telegramId})\nAmount: ${amount} MMK\nKPay Name: ${kpayName}\nKPay Number: ${kpayNumber}`,
      { parse_mode: 'Markdown' }
    );

    res.json({ success: true, withdrawalId: withdrawal._id });
  } catch (error) {
    console.error('Withdrawal error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/admin/pending', async (req, res) => {
  try {
    const { adminId } = req.query;
    if (parseInt(adminId) !== ADMIN_ID) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    const deposits = await Deposit.find({ status: 'pending' }).sort({ createdAt: -1 });
    const withdrawals = await Withdrawal.find({ status: 'pending' }).sort({ createdAt: -1 });
    
    const userIds = [...new Set([...deposits.map(d => d.userId), ...withdrawals.map(w => w.userId)])];
    const users = await User.find({ telegramId: { $in: userIds } });
    const userMap = users.reduce((acc, u) => ({ ...acc, [u.telegramId]: u }), {});
    
    res.json({ 
      deposits: deposits.map(d => ({ 
        ...d.toObject(), 
        username: userMap[d.userId]?.username,
        userBalance: userMap[d.userId]?.balance 
      })),
      withdrawals: withdrawals.map(w => ({ 
        ...w.toObject(), 
        username: userMap[w.userId]?.username,
        userBalance: userMap[w.userId]?.balance 
      }))
    });
  } catch (error) {
    console.error('Admin pending error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/admin/confirm-deposit', async (req, res) => {
  try {
    const { adminId, depositId } = req.body;
    if (parseInt(adminId) !== ADMIN_ID) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    const deposit = await Deposit.findById(depositId);
    if (!deposit) return res.status(404).json({ error: 'Deposit not found' });

    deposit.status = 'confirmed';
    deposit.confirmedAt = new Date();
    await deposit.save();

    const user = await User.findOne({ telegramId: deposit.userId });
    if (!user) return res.status(404).json({ error: 'User not found' });

    user.balance += deposit.amount;
    await user.save();

    // Handle referral bonus
    if (user.referredBy) {
      const referrer = await User.findOne({ telegramId: user.referredBy });
      if (referrer) {
        referrer.balance += 100;
        await referrer.save();
        await bot.telegram.sendMessage(referrer.telegramId, 
          `🎉 You received 100 MMK referral bonus from @${user.username || user.telegramId}'s deposit of ${deposit.amount} MMK.\nNew balance: ${referrer.balance} MMK.`
        );
      }
    }

    await bot.telegram.sendMessage(deposit.userId, 
      `✅ *Deposit Confirmed*\n\nYour deposit of ${deposit.amount} MMK has been confirmed.\nNew balance: ${user.balance} MMK.`,
      { parse_mode: 'Markdown' }
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Confirm deposit error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/admin/reject-deposit', async (req, res) => {
  try {
    const { adminId, depositId, reason } = req.body;
    if (parseInt(adminId) !== ADMIN_ID) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    const deposit = await Deposit.findById(depositId);
    if (!deposit) return res.status(404).json({ error: 'Deposit not found' });

    deposit.status = 'rejected';
    await deposit.save();

    await bot.telegram.sendMessage(deposit.userId, 
      `❌ *Deposit Rejected*\n\nYour deposit of ${deposit.amount} MMK has been rejected.\nReason: ${reason || 'Please contact admin for details.'}`,
      { parse_mode: 'Markdown' }
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Reject deposit error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/admin/confirm-withdrawal', async (req, res) => {
  try {
    const { adminId, withdrawalId } = req.body;
    if (parseInt(adminId) !== ADMIN_ID) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    const withdrawal = await Withdrawal.findById(withdrawalId);
    if (!withdrawal) return res.status(404).json({ error: 'Withdrawal not found' });

    const user = await User.findOne({ telegramId: withdrawal.userId });
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (user.balance < withdrawal.amount) {
      return res.status(400).json({ error: 'Insufficient balance now' });
    }

    user.balance -= withdrawal.amount;
    await user.save();

    withdrawal.status = 'confirmed';
    withdrawal.confirmedAt = new Date();
    await withdrawal.save();

    await bot.telegram.sendMessage(withdrawal.userId, 
      `✅ *Withdrawal Confirmed*\n\nYour withdrawal of ${withdrawal.amount} MMK has been confirmed and sent to your KPay account.\nKPay Name: ${withdrawal.kpayName}\nKPay Number: ${withdrawal.kpayNumber}\nNew balance: ${user.balance} MMK.`,
      { parse_mode: 'Markdown' }
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Confirm withdrawal error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/admin/reject-withdrawal', async (req, res) => {
  try {
    const { adminId, withdrawalId, reason } = req.body;
    if (parseInt(adminId) !== ADMIN_ID) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    const withdrawal = await Withdrawal.findById(withdrawalId);
    if (!withdrawal) return res.status(404).json({ error: 'Withdrawal not found' });

    withdrawal.status = 'rejected';
    await withdrawal.save();

    await bot.telegram.sendMessage(withdrawal.userId, 
      `❌ *Withdrawal Rejected*\n\nYour withdrawal request of ${withdrawal.amount} MMK has been rejected.\nReason: ${reason || 'Please contact admin for details.'}`,
      { parse_mode: 'Markdown' }
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Reject withdrawal error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ==================== Socket.io Game Logic ====================
const gameTurnTimeouts = new Map();
const activeGames = new Map();

io.on('connection', (socket) => {
  console.log('👤 User connected:', socket.id);

  socket.on('findGame', async () => {
    try {
      const userId = socket.handshake.auth.token;
      if (!userId) {
        socket.emit('error', 'Authentication required');
        return;
      }

      const user = await User.findOne({ telegramId: parseInt(userId) });
      if (!user || user.balance < 1000) {
        socket.emit('error', 'Insufficient balance to play.');
        return;
      }

      user.balance -= 1000;
      user.totalGames += 1;
      await user.save();

      const gameId = generateGameId();
      const game = new Game({
        gameId,
        players: [parseInt(userId)],
        status: 'waiting'
      });
      await game.save();

      socket.join(gameId);
      socket.emit('waitingForPlayer', { gameId });
      activeGames.set(gameId, { game, timeout: null });

      // Start 30-second timer for AI
      const aiTimeout = setTimeout(async () => {
        try {
          const gameStillWaiting = await Game.findOne({ gameId, status: 'waiting' });
          if (!gameStillWaiting) return;

          if (gameStillWaiting.players.length === 1) {
            gameStillWaiting.players.push(0); // Bot
            gameStillWaiting.status = 'active';
            gameStillWaiting.currentTurn = gameStillWaiting.players[0];
            gameStillWaiting.gameStartTime = new Date();
            gameStillWaiting.turnStartTime = new Date();
            gameStillWaiting.isBotGame = true;
            await gameStillWaiting.save();

            io.to(gameId).emit('gameStarted', { 
              gameId, 
              players: gameStillWaiting.players, 
              currentTurn: gameStillWaiting.currentTurn,
              isBot: true,
              turnStartTime: gameStillWaiting.turnStartTime
            });

            startTurnTimer(gameId);
          }
        } catch (error) {
          console.error('AI timeout error:', error);
        }
      }, 30000);

      if (activeGames.has(gameId)) {
        activeGames.get(gameId).timeout = aiTimeout;
      }
    } catch (error) {
      console.error('Find game error:', error);
      socket.emit('error', 'Game creation failed');
    }
  });

  socket.on('makeMove', async ({ gameId, row, col }) => {
    try {
      const game = await Game.findOne({ gameId });
      if (!game || game.status !== 'active') {
        return socket.emit('error', 'Game not active');
      }

      const userId = socket.handshake.auth.token;
      if (game.currentTurn !== parseInt(userId)) {
        return socket.emit('error', 'Not your turn');
      }

      if (game.board[row][col] !== '') {
        return socket.emit('error', 'Invalid move');
      }

      // Check turn timer
      const now = new Date();
      const timeSinceTurnStart = (now - game.turnStartTime) / 1000;
      if (timeSinceTurnStart > 5) {
        const loser = game.currentTurn;
        const winner = game.players.find(p => p !== loser) || 0;
        game.winner = winner;
        game.status = 'completed';
        await game.save();
        
        clearTurnTimer(gameId);
        
        io.to(gameId).emit('gameOver', { 
          winner, 
          board: game.board,
          reason: 'timeout'
        });
        
        await handleGameEnd(game);
        return;
      }

      const symbol = parseInt(userId) === game.players[0] ? 'X' : 'O';
      game.board[row][col] = symbol;
      game.lastMoveTime = now;
      game.turnStartTime = now;

      if (ai.checkWin(game.board, symbol)) {
        game.winner = parseInt(userId);
        game.status = 'completed';
        await game.save();
        
        clearTurnTimer(gameId);
        
        io.to(gameId).emit('gameOver', { 
          winner: parseInt(userId), 
          board: game.board,
          reason: 'win'
        });
        
        await handleGameEnd(game);
        return;
      }

      const isFull = game.board.every(row => row.every(cell => cell !== ''));
      if (isFull) {
        game.winner = -1;
        game.status = 'completed';
        await game.save();
        
        clearTurnTimer(gameId);
        
        io.to(gameId).emit('gameOver', { 
          winner: -1, 
          board: game.board,
          reason: 'draw'
        });
        
        await handleGameEnd(game);
        return;
      }

      game.currentTurn = game.players.find(p => p !== parseInt(userId));
      game.turnStartTime = new Date();
      await game.save();

      io.to(gameId).emit('moveMade', { 
        board: game.board, 
        currentTurn: game.currentTurn,
        turnStartTime: game.turnStartTime
      });

      resetTurnTimer(gameId);

      if (game.currentTurn === 0) {
        setTimeout(async () => {
          try {
            const currentGame = await Game.findOne({ gameId });
            if (currentGame && currentGame.status === 'active' && currentGame.currentTurn === 0) {
              const botSymbol = currentGame.players[1] === 0 ? 'O' : 'X';
              const bestMove = ai.getBestMove(currentGame.board, botSymbol);
              
              if (bestMove) {
                const [botRow, botCol] = bestMove;
                
                currentGame.board[botRow][botCol] = botSymbol;
                currentGame.lastMoveTime = new Date();
                currentGame.turnStartTime = new Date();

                if (ai.checkWin(currentGame.board, botSymbol)) {
                  currentGame.winner = 0;
                  currentGame.status = 'completed';
                  await currentGame.save();
                  
                  clearTurnTimer(gameId);
                  
                  io.to(gameId).emit('gameOver', { 
                    winner: 0, 
                    board: currentGame.board,
                    reason: 'bot_win'
                  });
                  
                  await handleGameEnd(currentGame);
                  return;
                }

                currentGame.currentTurn = currentGame.players[0];
                await currentGame.save();

                io.to(gameId).emit('moveMade', { 
                  board: currentGame.board, 
                  currentTurn: currentGame.currentTurn,
                  turnStartTime: currentGame.turnStartTime
                });

                resetTurnTimer(gameId);
              }
            }
          } catch (error) {
            console.error('Bot move error:', error);
          }
        }, 2000);
      }
    } catch (error) {
      console.error('Make move error:', error);
      socket.emit('error', 'Move failed');
    }
  });

  socket.on('disconnect', () => {
    console.log('👋 User disconnected:', socket.id);
  });
});

function startTurnTimer(gameId) {
  const timeout = setTimeout(async () => {
    try {
      const game = await Game.findOne({ gameId });
      if (game && game.status === 'active') {
        const now = new Date();
        const timeSinceTurnStart = (now - game.turnStartTime) / 1000;
        
        if (timeSinceTurnStart > 5) {
          const loser = game.currentTurn;
          const winner = game.players.find(p => p !== loser) || 0;
          game.winner = winner;
          game.status = 'completed';
          await game.save();
          
          io.to(gameId).emit('gameOver', { 
            winner, 
            board: game.board,
            reason: 'timeout'
          });
          
          await handleGameEnd(game);
        } else {
          startTurnTimer(gameId);
        }
      }
    } catch (error) {
      console.error('Turn timer error:', error);
    }
  }, 1000);
  
  gameTurnTimeouts.set(gameId, timeout);
}

function resetTurnTimer(gameId) {
  const timeout = gameTurnTimeouts.get(gameId);
  if (timeout) {
    clearTimeout(timeout);
    gameTurnTimeouts.delete(gameId);
  }
  startTurnTimer(gameId);
}

function clearTurnTimer(gameId) {
  const timeout = gameTurnTimeouts.get(gameId);
  if (timeout) {
    clearTimeout(timeout);
    gameTurnTimeouts.delete(gameId);
  }
}

async function handleGameEnd(game) {
  try {
    if (game.winner && game.winner !== -1 && game.winner !== 0) {
      const winner = await User.findOne({ telegramId: game.winner });
      if (winner) {
        winner.balance += 1600;
        winner.wins += 1;
        await winner.save();
        
        await bot.telegram.sendMessage(game.winner, 
          `🎉 *You Won!*\n\nYou received 1600 MMK.\nNew balance: ${winner.balance} MMK.`,
          { parse_mode: 'Markdown' }
        );
      }
      
      const loserId = game.players.find(p => p !== game.winner && p !== 0);
      if (loserId) {
        const loser = await User.findOne({ telegramId: loserId });
        if (loser) {
          loser.losses += 1;
          await loser.save();
        }
      }
    } else if (game.winner === -1) {
      for (let playerId of game.players) {
        if (playerId !== 0) {
          const user = await User.findOne({ telegramId: playerId });
          if (user) {
            user.balance += 500;
            await user.save();
          }
        }
      }
    }

    if (activeGames.has(game.gameId)) {
      const gameData = activeGames.get(game.gameId);
      if (gameData.timeout) {
        clearTimeout(gameData.timeout);
      }
      activeGames.delete(game.gameId);
    }
  } catch (error) {
    console.error('Handle game end error:', error);
  }
}

// ==================== Start Server ====================
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`🌐 Frontend URL: https://tictokfrontend.vercel.app`);
  console.log(`🤖 Bot URL: https://t.me/tictoe1_bot`);
  console.log(`🔍 Health check: https://tiktocbackend.onrender.com/health`);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received. Closing connections...');
  
  for (const timeout of gameTurnTimeouts.values()) {
    clearTimeout(timeout);
  }
  
  for (const gameData of activeGames.values()) {
    if (gameData.timeout) {
      clearTimeout(gameData.timeout);
    }
  }
  
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
  
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});
