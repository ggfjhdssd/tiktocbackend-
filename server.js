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
const io = new Server(server, {
  cors: {
    origin: ['https://tictokfrontend.vercel.app', 'http://localhost:3000'],
    methods: ['GET', 'POST'],
    credentials: true
  }
});

// Middleware
app.use(express.json());
app.use(cors({
  origin: ['https://tictokfrontend.vercel.app', 'http://localhost:3000'],
  credentials: true
}));

// Environment Variables with validation
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = process.env.ADMIN_ID ? parseInt(process.env.ADMIN_ID) : null;
const MONGODB_URI1 = process.env.MONGODB_URI1;
const MONGODB_URI2 = process.env.MONGODB_URI2;

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

if (!MONGODB_URI2) {
  console.warn('⚠️ MONGODB_URI2 is not set - failover will not work');
}

console.log('✅ Environment variables loaded:');
console.log(`- BOT_TOKEN: ${BOT_TOKEN.substring(0, 10)}...`);
console.log(`- ADMIN_ID: ${ADMIN_ID}`);
console.log(`- MONGODB_URI1: ${MONGODB_URI1 ? MONGODB_URI1.substring(0, 20) + '...' : 'NOT SET'}`);
console.log(`- MONGODB_URI2: ${MONGODB_URI2 ? MONGODB_URI2.substring(0, 20) + '...' : 'NOT SET'}`);

// ==================== MongoDB Connection with Failover ====================
let isConnected = false;
let activeConnectionString = MONGODB_URI1;
let dbConnection = null;
let reconnectTimer = null;

const connectWithFailover = async (retryCount = 0) => {
  const maxRetries = 5;
  const baseDelay = 5000; // 5 seconds

  const connectToURI = async (uri) => {
    if (!uri) {
      console.error('❌ MongoDB URI is undefined or null');
      return null;
    }

    try {
      console.log(`🔄 Attempting to connect to MongoDB: ${uri.substring(0, 25)}...`);
      
      // Disconnect existing connection if any
      if (mongoose.connection.readyState !== 0) {
        await mongoose.disconnect();
      }

      const conn = await mongoose.connect(uri, {
        useNewUrlParser: true,
        useUnifiedTopology: true,
        serverSelectionTimeoutMS: 10000,
        socketTimeoutMS: 45000,
        heartbeatFrequencyMS: 10000,
        retryWrites: true,
        retryReads: true
      });

      console.log(`✅ Connected to MongoDB: ${uri.substring(0, 25)}...`);
      return conn;
    } catch (error) {
      console.error(`❌ Failed to connect to ${uri.substring(0, 25)}...:`, error.message);
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
      console.error('❌ Max retries reached. Will continue without database...');
      // Don't exit, let the server run but with limited functionality
    }
    return;
  }

  dbConnection = connection;
  isConnected = true;
  retryCount = 0; // Reset retry count on successful connection

  // Monitor connection events
  mongoose.connection.on('disconnected', async () => {
    console.log('❌ MongoDB disconnected! Attempting failover...');
    isConnected = false;
    
    // Clear any existing reconnect timer
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
    }

    // Try to reconnect with exponential backoff
    const tryReconnect = async (attempt = 0) => {
      const newURI = activeConnectionString === MONGODB_URI1 ? MONGODB_URI2 : MONGODB_URI1;
      
      if (!newURI) {
        console.error('❌ No alternative MongoDB URI available');
        return;
      }
      
      console.log(`🔄 Failing over to: ${newURI.substring(0, 25)}... (Attempt ${attempt + 1})`);
      
      try {
        await mongoose.connect(newURI, {
          useNewUrlParser: true,
          useUnifiedTopology: true,
          serverSelectionTimeoutMS: 10000,
        });
        
        activeConnectionString = newURI;
        isConnected = true;
        console.log('✅ Failover successful!');
      } catch (error) {
        console.error('❌ Failover attempt failed:', error.message);
        
        if (attempt < 5) {
          const delay = Math.min(1000 * Math.pow(2, attempt), 30000);
          reconnectTimer = setTimeout(() => tryReconnect(attempt + 1), delay);
        } else {
          console.error('❌ Max failover attempts reached. Manual intervention required.');
        }
      }
    };

    tryReconnect();
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

// ==================== Minimax AI for 5x5 (4-in-a-row) ====================
class TicTacToeAI {
  constructor() {
    this.boardSize = 5;
    this.winLength = 4;
  }

  evaluateBoard(board, player, opponent) {
    if (this.checkWin(board, player)) return 100;
    if (this.checkWin(board, opponent)) return -100;
    return 0;
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
    const score = this.evaluateBoard(board, player, opponent);
    
    if (score === 100) return score - depth;
    if (score === -100) return score + depth;
    
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

bot.action(/join_(.+)/, async (ctx) => {
  const gameId = ctx.match[1];
  const userId = ctx.from.id;

  try {
    const game = await Game.findOne({ gameId, status: 'waiting' });
    if (!game) {
      return ctx.answerCbQuery('❌ Game no longer available.');
    }

    if (game.players.includes(userId)) {
      return ctx.answerCbQuery('⚠️ You are already in this game.');
    }

    const user = await User.findOne({ telegramId: userId });
    if (!user || user.balance < 1000) {
      return ctx.answerCbQuery('💰 Insufficient balance to join.');
    }

    user.balance -= 1000;
    await user.save();

    game.players.push(userId);
    game.status = 'active';
    game.currentTurn = game.players[0];
    game.gameStartTime = new Date();
    game.lastMoveTime = new Date();
    game.turnStartTime = new Date();
    await game.save();

    io.to(gameId).emit('gameStarted', { 
      gameId, 
      players: game.players, 
      currentTurn: game.currentTurn,
      turnStartTime: game.turnStartTime
    });

    ctx.answerCbQuery('✅ Game joined!');
    ctx.editMessageText('🎮 Game started!', { reply_markup: {} });
  } catch (error) {
    console.error('Join game error:', error);
    ctx.answerCbQuery('❌ Error joining game');
  }
});

bot.launch().then(() => console.log('✅ Bot started')).catch(err => {
  console.error('❌ Bot failed to start:', err);
});

// Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

// ==================== API Routes ====================
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
      `💰 *New Deposit Request*\n\nUser: ${user.username || 'N/A'} (${user.telegramId})\nAmount: ${amount} MMK\nKPay Name: ${kpayName}\nTransaction ID: ${transactionId}\n\nApprove or reject in admin panel.`,
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
      `💸 *New Withdrawal Request*\n\nUser: ${user.username || 'N/A'} (${user.telegramId})\nAmount: ${amount} MMK\nKPay Name: ${kpayName}\nKPay Number: ${kpayNumber}\n\nApprove or reject in admin panel.`,
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
      `✅ *Deposit Confirmed*\n\nYour deposit of ${deposit.amount} MMK has been confirmed.\nNew balance: ${user.balance} MMK.\n\nThank you for using TicToeTic!`,
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
      `❌ *Deposit Rejected*\n\nYour deposit of ${deposit.amount} MMK has been rejected.\nReason: ${reason || 'Please contact admin for details.'}\n\nPlease check and try again.`,
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
      `✅ *Withdrawal Confirmed*\n\nYour withdrawal of ${withdrawal.amount} MMK has been confirmed and sent to your KPay account.\nKPay Name: ${withdrawal.kpayName}\nKPay Number: ${withdrawal.kpayNumber}\nNew balance: ${user.balance} MMK.\n\nThank you for using TicToeTic!`,
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
      `❌ *Withdrawal Rejected*\n\nYour withdrawal request of ${withdrawal.amount} MMK has been rejected.\nReason: ${reason || 'Please contact admin for details.'}\n\nPlease check and try again.`,
      { parse_mode: 'Markdown' }
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Reject withdrawal error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/admin/stats', async (req, res) => {
  try {
    const { adminId } = req.query;
    if (parseInt(adminId) !== ADMIN_ID) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    const totalUsers = await User.countDocuments();
    const totalDeposits = await Deposit.countDocuments({ status: 'confirmed' });
    const totalDepositAmount = await Deposit.aggregate([
      { $match: { status: 'confirmed' } },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]);
    const totalWithdrawals = await Withdrawal.countDocuments({ status: 'confirmed' });
    const totalWithdrawalAmount = await Withdrawal.aggregate([
      { $match: { status: 'confirmed' } },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]);

    res.json({
      totalUsers,
      totalDeposits,
      totalDepositAmount: totalDepositAmount[0]?.total || 0,
      totalWithdrawals,
      totalWithdrawalAmount: totalWithdrawalAmount[0]?.total || 0
    });
  } catch (error) {
    console.error('Stats error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ==================== Socket.io Game Logic ====================
const turnTimers = new Map();
const gameTurnTimeouts = new Map();
const activeGames = new Map();

io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error('Authentication error'));
  socket.userId = parseInt(token);
  next();
});

io.on('connection', (socket) => {
  console.log('👤 User connected:', socket.userId);

  socket.on('findGame', async () => {
    try {
      const userId = socket.userId;

      const user = await User.findOne({ telegramId: userId });
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
        players: [userId],
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
            gameStillWaiting.players.push(0);
            gameStillWaiting.status = 'active';
            gameStillWaiting.currentTurn = gameStillWaiting.players[0];
            gameStillWaiting.gameStartTime = new Date();
            gameStillWaiting.lastMoveTime = new Date();
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

      if (game.currentTurn !== socket.userId) {
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
        
        if (winner !== 0) {
          const winnerUser = await User.findOne({ telegramId: winner });
          if (winnerUser) {
            winnerUser.wins += 1;
            await winnerUser.save();
          }
        }
        
        const loserUser = await User.findOne({ telegramId: loser });
        if (loserUser) {
          loserUser.losses += 1;
          await loserUser.save();
        }
        
        io.to(gameId).emit('gameOver', { 
          winner, 
          board: game.board,
          reason: 'timeout'
        });
        
        await handleGameEnd(game);
        return;
      }

      const symbol = socket.userId === game.players[0] ? 'X' : 'O';
      game.board[row][col] = symbol;
      game.lastMoveTime = now;
      game.turnStartTime = now;

      if (ai.checkWin(game.board, symbol)) {
        game.winner = socket.userId;
        game.status = 'completed';
        await game.save();
        
        clearTurnTimer(gameId);
        
        const winnerUser = await User.findOne({ telegramId: socket.userId });
        if (winnerUser) {
          winnerUser.wins += 1;
          await winnerUser.save();
        }
        
        io.to(gameId).emit('gameOver', { 
          winner: socket.userId, 
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

      game.currentTurn = game.players.find(p => p !== socket.userId);
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
                  
                  const humanId = currentGame.players.find(p => p !== 0);
                  if (humanId) {
                    const humanUser = await User.findOne({ telegramId: humanId });
                    if (humanUser) {
                      humanUser.losses += 1;
                      await humanUser.save();
                    }
                  }
                  
                  io.to(gameId).emit('gameOver', { 
                    winner: 0, 
                    board: currentGame.board,
                    reason: 'bot_win'
                  });
                  
                  await handleGameEnd(currentGame);
                  return;
                }

                const isBoardFull = currentGame.board.every(row => row.every(cell => cell !== ''));
                if (isBoardFull) {
                  currentGame.winner = -1;
                  currentGame.status = 'completed';
                  await currentGame.save();
                  
                  clearTurnTimer(gameId);
                  
                  io.to(gameId).emit('gameOver', { 
                    winner: -1, 
                    board: currentGame.board,
                    reason: 'draw'
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

  socket.on('playAgain', async ({ gameId }) => {
    try {
      const game = await Game.findOne({ gameId });
      if (!game) return;

      socket.emit('findGame');
    } catch (error) {
      console.error('Play again error:', error);
    }
  });

  socket.on('disconnect', () => {
    console.log('👋 User disconnected:', socket.userId);
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
          
          if (winner !== 0) {
            const winnerUser = await User.findOne({ telegramId: winner });
            if (winnerUser) {
              winnerUser.wins += 1;
              await winnerUser.save();
            }
          }
          
          const loserUser = await User.findOne({ telegramId: loser });
          if (loserUser) {
            loserUser.losses += 1;
            await loserUser.save();
          }
          
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
        await winner.save();
        
        await bot.telegram.sendMessage(game.winner, 
          `🎉 *You Won!*\n\nCongratulations! You won the game!\nYou received 1600 MMK.\nNew balance: ${winner.balance} MMK.\n\nPlay again to win more!`,
          { parse_mode: 'Markdown' }
        );
      }
      
      const loserId = game.players.find(p => p !== game.winner && p !== 0);
      if (loserId) {
        await bot.telegram.sendMessage(loserId, 
          `😢 *Game Over*\n\nYou lost the game. Better luck next time!\nPlay again to win back your losses.`,
          { parse_mode: 'Markdown' }
        );
      }
    } else if (game.winner === -1) {
      for (let playerId of game.players) {
        if (playerId !== 0) {
          const user = await User.findOne({ telegramId: playerId });
          if (user) {
            user.balance += 500;
            await user.save();
            await bot.telegram.sendMessage(playerId, 
              `🤝 *Game Draw*\n\nThe game ended in a draw.\nYou received 500 MMK refund.\nNew balance: ${user.balance} MMK.\n\nPlay again to win more!`,
              { parse_mode: 'Markdown' }
            );
          }
        }
      }
    } else if (game.winner === 0) {
      const humanId = game.players.find(p => p !== 0);
      if (humanId) {
        await bot.telegram.sendMessage(humanId, 
          `🤖 *Game Over*\n\nYou lost to the AI. Better luck next time!\nPlay again to challenge the AI.`,
          { parse_mode: 'Markdown' }
        );
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

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    mongodb: isConnected ? 'connected' : 'disconnected',
    activeURI: activeConnectionString ? activeConnectionString.substring(0, 25) + '...' : 'none',
    uptime: process.uptime(),
    env: {
      botToken: BOT_TOKEN ? '✅ Set' : '❌ Not set',
      adminId: ADMIN_ID ? '✅ Set' : '❌ Not set',
      mongodb1: MONGODB_URI1 ? '✅ Set' : '❌ Not set',
      mongodb2: MONGODB_URI2 ? '✅ Set' : '❌ Not set'
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`🌐 Frontend URL: https://tictokfrontend.vercel.app`);
  console.log(`🤖 Bot URL: https://t.me/tictoe1_bot`);
  console.log(`🔍 Health check: http://localhost:${PORT}/health`);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received. Closing connections...');
  
  for (const [gameId, timeout] of gameTurnTimeouts) {
    clearTimeout(timeout);
  }
  
  for (const [gameId, gameData] of activeGames) {
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
