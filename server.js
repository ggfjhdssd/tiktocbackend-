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
  res.header('Access-Control-Allow-Headers', 'Content-Type,Authorization,x-admin-id,x-telegram-id,x-bot-source');
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

// ===== Config =====
const BOT_TOKEN   = process.env.BOT_TOKEN;   // 8169341644:AAEuEOxOSAVvt2fRkO9DbzJJ_FhF2oSbt0k
const BOT_SOURCE  = 'Bot2';

// ADMIN_ID = main admin (you)
// PARTNER_IDS = comma-separated telegram IDs of partner admins (can see Bot2 users only)
const ADMIN_ID    = process.env.ADMIN_ID ? parseInt(process.env.ADMIN_ID) : null;
const PARTNER_IDS = (process.env.PARTNER_IDS || '').split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));

const FRONTEND_URL  = process.env.FRONTEND_URL || 'https://tictoefrontend2-iota.vercel.app';
const BACKEND_URL   = process.env.BACKEND_URL  || 'https://tictoebackend2.onrender.com';
const BOT_USERNAME  = process.env.BOT_USERNAME || 'BamBamBoomm_bot';

const ENTRY_FEE    = 500;
const WIN_PRIZE    = 800;
const DRAW_REFUND  = 250;
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
  role:         { type: String, enum: ['user','agent'], default: 'user' },
  botMode:      { type: Boolean, default: false },
  botSource:    { type: String, default: 'Bot2' },   // Bot1 | Bot2
  lastActive:   { type: Date, default: Date.now },
  createdAt:    { type: Date, default: Date.now }
});
userSchema.index({ telegramId: 1 });
userSchema.index({ referralCode: 1 });
userSchema.index({ botSource: 1 });

const depositSchema = new mongoose.Schema({
  userId:       { type: Number, required: true },
  kpayName:     String,
  transactionId:{ type: String, required: true, unique: true },
  amount:       { type: Number, required: true },
  paymentMethod:{ type: String, enum: ['kpay','wave'], default: 'kpay' },
  botSource:    { type: String, default: 'Bot2' },
  status:       { type: String, enum: ['pending','confirming','confirmed','rejected'], default: 'pending' },
  processedBy:  { type: String, enum: ['admin','agent','partner'], default: 'admin' },
  createdAt:    { type: Date, default: Date.now },
  processedAt:  Date,
  expireAt:     { type: Date, default: null }
});
depositSchema.index({ transactionId: 1 });
depositSchema.index({ status: 1 });
depositSchema.index({ botSource: 1 });
depositSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });

const withdrawalSchema = new mongoose.Schema({
  userId:       { type: Number, required: true },
  kpayName:     String,
  kpayNumber:   String,
  amount:       { type: Number, required: true },
  paymentMethod:{ type: String, enum: ['kpay','wave'], default: 'kpay' },
  botSource:    { type: String, default: 'Bot2' },
  status:       { type: String, enum: ['pending','confirmed','rejected'], default: 'pending' },
  createdAt:    { type: Date, default: Date.now },
  processedAt:  Date,
  expireAt:     { type: Date, default: null }
});
withdrawalSchema.index({ status: 1 });
withdrawalSchema.index({ botSource: 1 });
withdrawalSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });

const gameSchema = new mongoose.Schema({
  gameId:      { type: String, required: true, unique: true },
  players:     [Number],
  playerNames: { type: Map, of: String, default: {} },
  symbols:     { type: Map, of: String },
  board:       { type: [[String]], default: () => Array(5).fill(null).map(() => Array(5).fill('')) },
  winner:      { type: mongoose.Schema.Types.Mixed, default: null },
  winnerName:  { type: String, default: '' },
  status:      { type: String, enum: ['waiting','active','completed'], default: 'waiting' },
  isAIGame:    { type: Boolean, default: false },
  createdAt:   { type: Date, default: Date.now, expires: 86400*30 }
});
gameSchema.index({ gameId: 1 });

const settingsSchema = new mongoose.Schema({
  key:   { type: String, unique: true },
  value: mongoose.Schema.Types.Mixed
});

const redeemCodeSchema = new mongoose.Schema({
  code:      { type: String, required: true, unique: true, uppercase: true, trim: true },
  amount:    { type: Number, required: true },
  maxUses:   { type: Number, default: 1 },
  usedBy:    [{ type: Number }],
  isActive:  { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now }
});
redeemCodeSchema.index({ code: 1 });

const agentSchema = new mongoose.Schema({
  telegramId:       { type: Number, required: true, unique: true },
  referralCode:     { type: String },
  agentKpayNumber:  { type: String, default: '' },
  agentKpayName:    { type: String, default: '' },
  hasWave:          { type: Boolean, default: false },
  milestones: {
    1:  { current:{type:Number,default:0}, claimed:{type:Boolean,default:false} },
    2:  { current:{type:Number,default:0}, claimed:{type:Boolean,default:false} },
    3:  { current:{type:Number,default:0}, claimed:{type:Boolean,default:false} },
    4:  { current:{type:Number,default:0}, claimed:{type:Boolean,default:false} },
    5:  { current:{type:Number,default:0}, claimed:{type:Boolean,default:false} },
    6:  { current:{type:Number,default:0}, claimed:{type:Boolean,default:false} },
    7:  { current:{type:Number,default:0}, claimed:{type:Boolean,default:false} },
    8:  { current:{type:Number,default:0}, claimed:{type:Boolean,default:false} },
    9:  { current:{type:Number,default:0}, claimed:{type:Boolean,default:false} },
    10: { current:{type:Number,default:0}, claimed:{type:Boolean,default:false} }
  },
  totalEarned:    { type: Number, default: 0 },
  completedBoxes: { type: Number, default: 0 },
  isActive:       { type: Boolean, default: true },
  createdAt:      { type: Date, default: Date.now }
});
agentSchema.index({ telegramId: 1 });

const BOX_CONFIG = [
  { box:1, people:5,   perPerson:1000,  bonus:500      },
  { box:2, people:10,  perPerson:2000,  bonus:2000     },
  { box:3, people:30,  perPerson:3000,  bonus:10000    },
  { box:4, people:50,  perPerson:5000,  bonus:30000    },
  { box:5, people:70,  perPerson:10000, bonus:80000    },
  { box:6, people:100, perPerson:20000, bonus:300000   },
  { box:7, people:150, perPerson:30000, bonus:800000   },
  { box:8, people:200, perPerson:50000, bonus:2000000  },
  { box:9, people:70,  perPerson:70000, bonus:1000000  },
  { box:10,people:10,  perPerson:2000,  bonus:2000, loop:true }
];

const User       = mongoose.model('User',       userSchema);
const Deposit    = mongoose.model('Deposit',    depositSchema);
const Withdrawal = mongoose.model('Withdrawal', withdrawalSchema);
const Game       = mongoose.model('Game',       gameSchema);
const Settings   = mongoose.model('Settings',   settingsSchema);
const RedeemCode = mongoose.model('RedeemCode', redeemCodeSchema);
const Agent      = mongoose.model('Agent',      agentSchema);

// ===== In-Memory =====
const waitingQueue        = [];
const activeGames         = new Map();
const gameTurnTimeouts    = new Map();
const userSockets         = new Map();
const searchNotifications = new Map();
const searchTimeouts      = new Map();
const fakeGameIds         = new Set();
const processingUsers     = new Set();
const moveCooldowns       = new Map();
const findGameCooldowns   = new Map();
const MOVE_COOLDOWN_MS     = 300;
const FINDGAME_COOLDOWN_MS = 2000;

// ===== Helpers =====
function genRefCode(id) {
  return 'B2' + id.toString(36).toUpperCase() + Math.random().toString(36).substr(2,4).toUpperCase();
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
        const nr=r+dr*i, nc=c+dc*i;
        if (nr<0||nr>=5||nc<0||nc>=5||board[nr][nc]!==sym) break;
        cnt++;
      }
      if (cnt>=4) return true;
    }
  }
  return false;
}
function boardFull(board) { return board.every(r=>r.every(c=>c!=='')); }

// ===== Admin Auth Helpers =====
function isMainAdmin(tid) {
  return ADMIN_ID && parseInt(tid) === ADMIN_ID;
}
function isPartnerAdmin(tid) {
  return PARTNER_IDS.includes(parseInt(tid));
}
function isAnyAdmin(tid) {
  return isMainAdmin(tid) || isPartnerAdmin(tid);
}

// isAdmin middleware — accepts main admin + partner admins
function isAdmin(req, res, next) {
  const tid = parseInt(req.headers['x-admin-id'] || req.query.adminId);
  if (!tid || !isAnyAdmin(tid)) return res.status(403).json({ error: 'Access denied' });
  req.adminTid = tid;
  req.isMainAdmin = isMainAdmin(tid);
  req.isPartner   = isPartnerAdmin(tid);
  next();
}

// ===== AI Config =====
const AI_ID = -999999;
const AI_NAMES = [
  'Min Khant Kyaw','Thura Aung','Nay Chi Win','Su Myat Noe','Kyaw Zin Htet',
  'Aye Chan Ko','Phyu Phyu Win','Kaung Myat Thu','Zaw_Lin_Htet','Myo_Min_Tun',
  'Ei_Thandar_Phyu','Ko_Phyo_99','Mg_Kaung_Mandalay','Shine_Htet_Aung','AungKyaw2026',
  'Htet_Naing_88','Khin_Su_112','Bo_Bo_Gyi_007','Thin_Zar_9','Kyaw_Kyaw_MM'
];
function randomAIName() { return AI_NAMES[Math.floor(Math.random()*AI_NAMES.length)]; }
function obfuscateUsername(n) {
  if (!n || n.length <= 3) return n + '...';
  return n.slice(0,3) + '...';
}

const AI_TYPE_SABOTAGE = 'sabotage';

function wouldWin(board,r,c,sym){ board[r][c]=sym; const w=checkWin(board,sym); board[r][c]=''; return w; }
function scoreBoard(board,sym,oppSym){
  const dirs=[[0,1],[1,0],[1,1],[1,-1]];
  let best=null,bestScore=-1;
  for(let r=0;r<5;r++) for(let c=0;c<5;c++){
    if(board[r][c]!=='') continue;
    let score=(2-Math.abs(r-2))+(2-Math.abs(c-2));
    for(const[dr,dc]of dirs){
      let cnt=0,blocked=false;
      for(let i=-3;i<=3;i++){
        const nr=r+dr*i,nc=c+dc*i;
        if(nr<0||nr>=5||nc<0||nc>=5) continue;
        if(board[nr][nc]===sym) cnt++;
        else if(board[nr][nc]===oppSym){blocked=true;break;}
      }
      if(!blocked) score+=cnt*3;
    }
    if(score>bestScore){bestScore=score;best={r,c};}
  }
  return best;
}
function aiPickMove(board,aiSym,humanSym){
  for(let r=0;r<5;r++) for(let c=0;c<5;c++){if(board[r][c]===''&&wouldWin(board,r,c,aiSym)) return{r,c};}
  for(let r=0;r<5;r++) for(let c=0;c<5;c++){if(board[r][c]===''&&wouldWin(board,r,c,humanSym)) return{r,c};}
  const best=scoreBoard(board,aiSym,humanSym);
  if(best) return best;
  for(let r=0;r<5;r++) for(let c=0;c<5;c++){if(board[r][c]==='') return{r,c};}
  return null;
}

// ===== Sabotage AI =====
async function startSabotageAIGame(socket,userId,gameId,userName){
  const u=await User.findOneAndUpdate(
    {telegramId:userId,balance:{$gte:ENTRY_FEE},isBanned:{$ne:true}},
    {$inc:{balance:-ENTRY_FEE}},{new:true});
  if(!u) return socket.emit('insufficientBalance',{balance:0,required:ENTRY_FEE});
  const aiName=randomAIName();
  const symbols={};
  if(Math.random()>0.5){symbols[userId]='X';symbols[AI_ID]='O';}
  else{symbols[userId]='O';symbols[AI_ID]='X';}
  const firstTurn=parseInt(Object.entries(symbols).find(([,v])=>v==='X')[0]);
  const gameState={
    gameId,players:[userId,AI_ID],symbols,
    board:Array(5).fill(null).map(()=>Array(5).fill('')),
    currentTurn:firstTurn,status:'active',isAIGame:true,aiType:AI_TYPE_SABOTAGE,
    startedAt:Date.now(),lastMoveAt:Date.now(),
    playerNames:{[userId]:userName,[AI_ID]:aiName}
  };
  activeGames.set(gameId,gameState);
  socket.join(gameId);
  socket.emit('gameStart',{gameId,board:gameState.board,currentTurn:firstTurn,players:gameState.playerNames,mySymbol:symbols[userId]});
  if(firstTurn===AI_ID) scheduleSabotageAIMove(gameId);
  else{
    const t=setTimeout(()=>handleTurnTimeoutAI(gameId,userId),TURN_SECONDS*1000+1500);
    gameTurnTimeouts.set(gameId,t);
  }
}

function scheduleSabotageAIMove(gameId){
  const thinkMs=3000+Math.random()*2000;
  setTimeout(async()=>{
    const game=activeGames.get(gameId);
    if(!game||game.status!=='active'||game.currentTurn!==AI_ID) return;
    const humanId=game.players.find(p=>p!==AI_ID);
    const aiSym=game.symbols[AI_ID],humanSym=game.symbols[humanId];
    const move=aiPickMove(game.board,aiSym,humanSym);
    if(!move) return;
    clearTurnTimer(gameId);
    game.board[move.r][move.c]=aiSym;
    io.to(gameId).emit('moveMade',{row:move.r,col:move.c,symbol:aiSym,playerId:AI_ID,board:game.board});
    if(checkWin(game.board,aiSym)) await endGameAI(gameId,AI_ID,'win');
    else if(boardFull(game.board)) await endGameAI(gameId,-1,'draw');
    else{
      game.currentTurn=humanId;
      io.to(gameId).emit('turnChanged',{currentTurn:humanId});
      const t=setTimeout(()=>handleTurnTimeoutAI(gameId,humanId),TURN_SECONDS*1000+1500);
      gameTurnTimeouts.set(gameId,t);
    }
  },thinkMs);
}

async function endGameAI(gameId,winner,reason='normal'){
  const game=activeGames.get(gameId);
  if(!game||(game.status!=='active'&&game.status!=='ending')) return;
  clearTurnTimer(gameId);
  game.status='completed';
  const humanId=game.players.find(p=>p!==AI_ID);
  try{
    if(winner===-1){if(humanId) await User.findOneAndUpdate({telegramId:humanId},{$inc:{balance:DRAW_REFUND,totalGames:1}});}
    else if(winner===humanId){await User.findOneAndUpdate({telegramId:humanId},{$inc:{balance:WIN_PRIZE,wins:1,totalGames:1}});}
    else{if(humanId) await User.findOneAndUpdate({telegramId:humanId},{$inc:{losses:1,totalGames:1}});}
    await Game.findOneAndUpdate({gameId},{winner,status:'completed',board:game.board,playerNames:game.playerNames,
      winnerName:winner===-1?'draw':(game.playerNames?.[winner]||String(winner)),isAIGame:!!game.isAIGame},{upsert:true});
  }catch(e){console.error('endGameAI err:',e);}
  io.to(gameId).emit('gameOver',{winner,reason,board:game.board});
  activeGames.delete(gameId);clearTurnTimer(gameId);
  if(humanId){
    const t=searchTimeouts.get(humanId);if(t){clearTimeout(t);searchTimeouts.delete(humanId);}
    moveCooldowns.delete(humanId);findGameCooldowns.delete(humanId);processingUsers.delete(humanId);
  }
}

async function handleTurnTimeoutAI(gameId,playerId){
  const game=activeGames.get(gameId);
  if(!game||game.status!=='active'||game.currentTurn!==playerId) return;
  if(playerId===AI_ID) scheduleSabotageAIMove(gameId);
  else await endGameAI(gameId,AI_ID,'timeout');
}

function checkWinAfterMove(board,r,c,sym){
  const bc=board.map(row=>[...row]);bc[r][c]=sym;return checkWin(bc,sym);
}

async function handleSabotage(game,userId){
  game.status='ending';clearTurnTimer(game.gameId);
  const userSocketId=userSockets.get(userId);
  const userSocket=userSocketId?io.sockets.sockets.get(userSocketId):null;
  if(userSocket) userSocket.emit('fakeDisconnect',{message:'Internet ချိတ်ဆက်မှု ပြဿနာ ဖြစ်နေသည်...'});
  const delayMs=4000+Math.random()*2000;
  setTimeout(async()=>{
    const g=activeGames.get(game.gameId);if(!g) return;
    await endGameAI(game.gameId,AI_ID,'connectionLost');
  },delayMs);
}

// ===== Settings =====
async function getSetting(key,def){try{const s=await Settings.findOne({key}).lean();return s?s.value:def;}catch{return def;}}
async function setSetting(key,value){await Settings.findOneAndUpdate({key},{value},{upsert:true});}

// ===== Turn/Game helpers =====
function clearTurnTimer(gameId){const t=gameTurnTimeouts.get(gameId);if(t){clearTimeout(t);gameTurnTimeouts.delete(gameId);}}

async function endGame(gameId,winner,reason='normal'){
  const game=activeGames.get(gameId);
  if(!game||(game.status!=='active'&&game.status!=='ending')) return;
  clearTurnTimer(gameId);game.status='completed';
  const winnerId=winner===-1?-1:Number(winner);
  try{
    if(winnerId===-1){for(const pid of game.players) await User.findOneAndUpdate({telegramId:pid},{$inc:{balance:DRAW_REFUND,totalGames:1}});}
    else if(winnerId){
      const loser=game.players.find(p=>Number(p)!==winnerId);
      await User.findOneAndUpdate({telegramId:winnerId},{$inc:{balance:WIN_PRIZE,wins:1,totalGames:1}});
      if(loser) await User.findOneAndUpdate({telegramId:loser},{$inc:{losses:1,totalGames:1}});
    }
    await Game.findOneAndUpdate({gameId},{winner:winnerId,status:'completed',board:game.board,
      playerNames:game.playerNames,winnerName:winnerId===-1?'draw':(game.playerNames?.[winnerId]||String(winnerId)),
      isAIGame:!!game.isAIGame},{upsert:true});
  }catch(e){console.error('endGame err:',e);}
  io.to(gameId).emit('gameOver',{winner:winnerId,reason,board:game.board});
  activeGames.delete(gameId);clearTurnTimer(gameId);
  for(const pid of(game.players||[])){
    const t=searchTimeouts.get(pid);if(t){clearTimeout(t);searchTimeouts.delete(pid);}
    moveCooldowns.delete(pid);findGameCooldowns.delete(pid);processingUsers.delete(pid);
  }
  setTimeout(()=>deleteSearchMsgs(gameId),500);
}

// ===== Zombie cleanup =====
setInterval(async()=>{
  const now=Date.now(),IDLE=2*60*1000;
  for(const[gameId,game] of activeGames.entries()){
    if(game.status!=='active') continue;
    const lastMove=game.lastMoveAt||game.startedAt||0;
    if(now-lastMove<IDLE) continue;
    console.log(`🧹 Zombie cleanup: ${gameId}`);
    try{
      if(game.isAIGame) await endGameAI(gameId,-1,'timeout');
      else{
        for(const pid of(game.players||[])) await User.findOneAndUpdate({telegramId:pid},{$inc:{balance:ENTRY_FEE}}).catch(()=>{});
        io.to(gameId).emit('gameOver',{winner:-1,reason:'timeout',board:game.board});
        activeGames.delete(gameId);clearTurnTimer(gameId);
        setTimeout(()=>deleteSearchMsgs(gameId),500);
      }
    }catch(e){console.error('Zombie cleanup err:',e);}
  }
},5*60*1000);

// ===== Bot =====
let bot=null;
if(BOT_TOKEN){
  bot=new Telegraf(BOT_TOKEN);
  const CHANNEL_USERNAME='EzMoneyPayy';
  const CHANNEL_LINK='https://t.me/EzMoneyPayy';

  async function isChannelMember(userId){
    try{const m=await bot.telegram.getChatMember(`@${CHANNEL_USERNAME}`,userId);return['member','administrator','creator'].includes(m.status);}
    catch{return false;}
  }

  bot.start(async(ctx)=>{
    try{
      const id=ctx.from.id;const args=ctx.payload;
      const maint=await getSetting('maintenance',false);
      if(maint&&id!==ADMIN_ID){await ctx.reply('🔧 ဆာဗာ ပြင်ဆင်နေပါသည်').catch(()=>{});return;}
      let user=await User.findOne({telegramId:id});
      if(!user){
        user=new User({telegramId:id,username:ctx.from.username||'',firstName:ctx.from.first_name||'',
          referralCode:genRefCode(id),botSource:BOT_SOURCE});
        if(args&&args.length>3){const ref=await User.findOne({referralCode:args}).lean();if(ref&&ref.telegramId!==id) user.referredBy=ref.telegramId;}
        await user.save();
      } else {
        let d=false;
        if(ctx.from.username&&user.username!==ctx.from.username){user.username=ctx.from.username;d=true;}
        if(ctx.from.first_name&&user.firstName!==ctx.from.first_name){user.firstName=ctx.from.first_name;d=true;}
        if(!user.botSource){user.botSource=BOT_SOURCE;d=true;}
        if(d) await user.save();
      }
      const isMember=await isChannelMember(id);
      if(!isMember){
        await ctx.reply(`👋 မင်္ဂလာပါ ${ctx.from.first_name}!\n\n🎮 ကစားရန် Channel ကို Join ဦးဆုံး ဝင်ပါ!\n\n📢 Join ပြီးနောက် /start ထပ်နှိပ်ပါ`,
          {parse_mode:'HTML',...Markup.inlineKeyboard([
            [Markup.button.url('📢 Channel Join ရန်',CHANNEL_LINK)],
            [Markup.button.callback('✅ Join ပြီးပြီ — စစ်ဆေးပါ','check_join')]
          ])}).catch(()=>{});
        return;
      }
      await ctx.reply(`⚡ မင်္ဂလာပါ ${ctx.from.first_name}!\n\n💰 လက်ကျန်: ${user.balance.toLocaleString()} MMK\n🏆 နိုင်: ${user.wins}  •  ❌ ရှုံး: ${user.losses}`,
        Markup.inlineKeyboard([
          [Markup.button.webApp('⚡ PLAY NOW',FRONTEND_URL)],
          [Markup.button.callback('💰 Balance','bal'),Markup.button.callback('🔗 Referral','ref')]
        ])).catch(()=>{});
    }catch(e){console.error('start err:',e);ctx.reply('⚠️ Server ချိတ်ဆက်မှု ပြဿနာ').catch(()=>{});}
  });

  bot.action('check_join',async(ctx)=>{
    try{
      await ctx.answerCbQuery('စစ်ဆေးနေသည်...').catch(()=>{});
      const id=ctx.from.id;
      if(!await isChannelMember(id)){
        await ctx.reply('❌ Channel Join မပြုလုပ်ရသေးပါ!',Markup.inlineKeyboard([
          [Markup.button.url('📢 Channel Join ရန်',CHANNEL_LINK)],
          [Markup.button.callback('✅ Join ပြီးပြီ — စစ်ဆေးပါ','check_join')]
        ])).catch(()=>{});return;
      }
      const user=await User.findOne({telegramId:id}).lean();
      if(!user){await ctx.reply('⚠️ /start ကိုနှိပ်ပါ').catch(()=>{});return;}
      await ctx.reply(`✅ Join အောင်မြင်!\n\n⚡ မင်္ဂလာပါ ${ctx.from.first_name}!\n💰 ${user.balance.toLocaleString()} MMK`,
        Markup.inlineKeyboard([[Markup.button.webApp('⚡ PLAY NOW',FRONTEND_URL)]])).catch(()=>{});
    }catch(e){console.error('check_join err:',e);}
  });

  bot.action('bal',async(ctx)=>{
    try{
      await ctx.answerCbQuery().catch(()=>{});
      const u=await User.findOne({telegramId:ctx.from.id}).lean();if(!u) return;
      await ctx.reply(`💰 လက်ကျန်: ${u.balance.toLocaleString()} MMK\n🎮 ကစားမှု: ${u.totalGames}\n🏆 ${u.wins}  •  ❌ ${u.losses}`,
        Markup.inlineKeyboard([[Markup.button.webApp('⚡ ကစားမည်',FRONTEND_URL)]])).catch(()=>{});
    }catch(e){console.error('bal err:',e);}
  });

  bot.action('ref',async(ctx)=>{
    try{
      await ctx.answerCbQuery().catch(()=>{});
      const u=await User.findOne({telegramId:ctx.from.id}).lean();if(!u) return;
      const link=`https://t.me/${BOT_USERNAME}?start=${u.referralCode}`;
      await ctx.reply(`🔗 <b>Referral Link</b>\n\nတစ်ယောက် 1,000 MMK ဖြည့်တိုင်း <b>100 MMK</b> ရမည်!\n\n<code>${link}</code>`,
        {parse_mode:'HTML'}).catch(()=>{});
    }catch(e){console.error('ref err:',e);}
  });

  // /admin command — admin panel button for admins, silent for others
  // Registered BEFORE callback_query catch-all to ensure it fires reliably
  async function adminPanelHandler(ctx){
    try {
      const id = ctx.from.id;
      console.log(`[/admin] from ${id} (type ${typeof id}) | isAdmin=${isAnyAdmin(id)} | ADMIN_ID=${ADMIN_ID} | PARTNERS=[${PARTNER_IDS.join(',')}]`);
      if (!isAnyAdmin(id)) return; // not admin -> stay silent

      // Ensure URL is a valid HTTPS link (WebApp buttons require https)
      let base = (FRONTEND_URL || '').trim().replace(/\/+$/,'');
      if (!/^https:\/\//i.test(base)) base = 'https://' + base.replace(/^https?:\/\//i,'');
      const adminUrl = `${base}/admin.html`;

      const kb = /^https:\/\//i.test(adminUrl)
        ? Markup.inlineKeyboard([[Markup.button.webApp('🛠 Admin Panel ဖွင့်ရန်', adminUrl)]])
        : Markup.inlineKeyboard([[Markup.button.url('🛠 Admin Panel ဖွင့်ရန်', adminUrl)]]);

      await ctx.reply(
        `🔐 <b>Admin Panel</b>\n\nAdmin Dashboard သို့ ဝင်ရောက်ရန် အောက်ပါ Button ကို နှိပ်ပါ။`,
        { parse_mode: 'HTML', ...kb }
      ).catch(async (e) => {
        console.error('/admin reply err:', e.message, e.response?.description||'');
        // Fallback: plain text link if button send fails (e.g. invalid webapp url)
        await ctx.reply(`🔐 Admin Panel:\n${adminUrl}`).catch(()=>{});
      });
    } catch (e) { console.error('/admin cmd err:', e); }
  }

  bot.command('admin', adminPanelHandler);
  // Text fallback — catches "/admin" even if command parsing misses it
  bot.hears(/^\/?admin\b/i, adminPanelHandler);

  bot.on('callback_query',async(ctx)=>{
    const data=ctx.callbackQuery.data;
    if(data.startsWith('join_')){
      try{
        await ctx.answerCbQuery('ကစားမည်...').catch(()=>{});
        const gameId=data.replace('join_','');
        const userId=ctx.from.id;
        if(fakeGameIds.has(gameId)){
          await ctx.reply('❌ ဤပွဲကို ပိတ်သွားပြီ').catch(()=>{});
          return;
        }
        const entry=waitingQueue.find(w=>w.gameId===gameId);
        if(!entry){await ctx.reply('❌ ပွဲမတွေ့ပါ — ကုန်သွားပြီ').catch(()=>{});return;}
        // Open the webapp directly — matching happens via socket
        await ctx.reply(`⚡ ကစားမည်! Game Join နှိပ်ပါ`,
          Markup.inlineKeyboard([[Markup.button.webApp('⚡ Join Game',`${FRONTEND_URL}/play.html?gameId=${gameId}`)]])).catch(()=>{});
      }catch(e){console.error('join cb err:',e);}
    }
    if(data==='dismiss'){await ctx.answerCbQuery('OK').catch(()=>{});}
  });

  bot.launch().then(()=>{
    console.log('✅ Bot-2 launched:',BOT_USERNAME);
    // Register slash commands so Telegram recognizes /admin etc.
    bot.telegram.setMyCommands([
      {command:'start',description:'⚡ ကစားမည်'},
      {command:'admin',description:'🔐 Admin Panel'}
    ]).then(()=>console.log('✅ Commands registered')).catch(e=>console.error('setMyCommands err:',e.message));
    // Diagnostic: confirm who the admin is at boot
    console.log(`🔐 ADMIN_ID=${ADMIN_ID} | PARTNER_IDS=[${PARTNER_IDS.join(',')}] | FRONTEND_URL=${FRONTEND_URL}`);
  }).catch(e=>console.error('Bot launch err:',e));
  process.once('SIGINT',()=>bot.stop('SIGINT'));
  process.once('SIGTERM',()=>bot.stop('SIGTERM'));
}

// ===== Search Notifications =====
// Tracks telegram IDs that have blocked the bot — skip them in future sends
const blockedUsers=new Set();

async function sendOneBotMsg(userId,text,markup){
  if(blockedUsers.has(userId)) return null;
  try{
    const msg=await bot.telegram.sendMessage(userId,text,{parse_mode:'HTML',reply_markup:markup});
    return{userId,msgId:msg.message_id};
  }catch(e){
    // 403 = user blocked bot; 400 Bad Request with "chat not found" also skip
    const code=e?.response?.error_code;
    if(code===403||(code===400&&e?.response?.description?.includes('chat not found'))){
      blockedUsers.add(userId);
    }
    return null;
  }
}

async function sendSearchNotification(gameId,searcherId){
  try{
    if(!bot) return;
    const NOW=Date.now();
    const ACTIVE_24H=NOW - 24*60*60*1000;
    const[searcher,allUsers]=await Promise.all([
      User.findOne({telegramId:searcherId}).select('firstName username').lean(),
      User.find({telegramId:{$ne:searcherId},isBanned:{$ne:true}}).select('telegramId lastActive').lean()
    ]);
    const displayName=searcher?.username?obfuscateUsername(searcher.username):(searcher?.firstName||'တစ်ယောက်');
    const msgText=`⚡ <b>${displayName}</b> ပွဲရှာနေသည်!\n\n⏱ ${SEARCH_TIMEOUT_S} စက္ကန့်အတွင်း Join မနှိပ်ရင် ပွဲပျောက်မည်\n💰 ဝင်ကြေး: ${ENTRY_FEE.toLocaleString()} MMK  •  🏆 ဆု: ${WIN_PRIZE.toLocaleString()} MMK`;
    const replyMarkup={inline_keyboard:[[{text:'⚡ ကစားမည်',callback_data:`join_${gameId}`},{text:'❌ မကစားဘူး',callback_data:'dismiss'}]]};

    // Tier 1: Online users (socket connected) — send immediately in parallel
    const tier1=allUsers.filter(u=>userSockets.has(u.telegramId));
    // Tier 2: Active in last 24h but not online
    const tier2=allUsers.filter(u=>!userSockets.has(u.telegramId)&&u.lastActive&&new Date(u.lastActive).getTime()>=ACTIVE_24H)
      .sort((a,b)=>new Date(b.lastActive).getTime()-new Date(a.lastActive).getTime());
    // Tier 3: Inactive > 24h
    const tier3=allUsers.filter(u=>!userSockets.has(u.telegramId)&&(!u.lastActive||new Date(u.lastActive).getTime()<ACTIVE_24H))
      .sort((a,b)=>new Date(b.lastActive||0).getTime()-new Date(a.lastActive||0).getTime());

    const sent=[];

    // Tier 1 — immediate parallel
    const t1Results=await Promise.allSettled(tier1.map(u=>sendOneBotMsg(u.telegramId,msgText,replyMarkup)));
    t1Results.forEach(r=>{if(r.status==='fulfilled'&&r.value) sent.push(r.value);});

    // Tier 2 & 3 in background
    setImmediate(async()=>{
      // Tier 2: chunks of 50, 100ms gap
      const CHUNK2=50;
      for(let i=0;i<tier2.length;i+=CHUNK2){
        if(!waitingQueue.find(w=>w.gameId===gameId)) return;
        const batch=tier2.slice(i,i+CHUNK2);
        const r=await Promise.allSettled(batch.map(u=>sendOneBotMsg(u.telegramId,msgText,replyMarkup)));
        r.forEach(x=>{if(x.status==='fulfilled'&&x.value) sent.push(x.value);});
        if(i+CHUNK2<tier2.length) await new Promise(r=>setTimeout(r,100));
      }
      // Tier 3: chunks of 25, 300ms gap (slow, they're unlikely to join)
      const CHUNK3=25;
      for(let i=0;i<tier3.length;i+=CHUNK3){
        if(!waitingQueue.find(w=>w.gameId===gameId)) return;
        const batch=tier3.slice(i,i+CHUNK3);
        const r=await Promise.allSettled(batch.map(u=>sendOneBotMsg(u.telegramId,msgText,replyMarkup)));
        r.forEach(x=>{if(x.status==='fulfilled'&&x.value) sent.push(x.value);});
        if(i+CHUNK3<tier3.length) await new Promise(r=>setTimeout(r,300));
      }
    });
    searchNotifications.set(gameId,sent);
  }catch(e){console.error('notify err:',e);}
}

async function deleteSearchMsgs(gameId){
  if(!bot) return;
  const msgs=searchNotifications.get(gameId);if(!msgs) return;
  searchNotifications.delete(gameId);
  for(const{userId,msgId}of msgs){try{await bot.telegram.deleteMessage(userId,msgId);await new Promise(r=>setTimeout(r,30));}catch{}}
}

// Fake notifications
let fakeNotifTimer=null;
async function sendFakeSearchNotification(){
  if(!bot) return;
  const fakeEnabled=await getSetting('fakeNotifications',false);if(!fakeEnabled) return;
  const fakeGameId=genGameId();fakeGameIds.add(fakeGameId);
  const fakeName=randomAIName();
  const allUsers=await User.find({isBanned:{$ne:true}}).select('telegramId lastActive').lean();
  const fakeOnline=allUsers.filter(u=>userSockets.has(u.telegramId));
  const fakeOffline=allUsers.filter(u=>!userSockets.has(u.telegramId)).sort((a,b)=>(b.lastActive||0)-(a.lastActive||0));
  const users=[...fakeOnline,...fakeOffline];
  const fakeMsgText=`⚡ <b>${obfuscateUsername(fakeName)}</b> ပွဲရှာနေသည်!\n\n⏱ ${SEARCH_TIMEOUT_S} စက္ကန့်အတွင်း Join မနှိပ်ရင် ပွဲပျောက်မည်\n💰 ဝင်ကြေး: ${ENTRY_FEE.toLocaleString()} MMK  •  🏆 ဆု: ${WIN_PRIZE.toLocaleString()} MMK`;
  const sent=[];const CHUNK=30;
  for(let i=0;i<users.length;i+=CHUNK){
    const batch=users.slice(i,i+CHUNK);
    const r=await Promise.allSettled(batch.map(u=>sendOneBotMsg(u.telegramId,fakeMsgText,{inline_keyboard:[[{text:'⚡ ကစားမည်',callback_data:`join_${fakeGameId}`},{text:'❌ မကစားဘူး',callback_data:'dismiss'}]]})));
    r.forEach(x=>{if(x.status==='fulfilled'&&x.value) sent.push(x.value);});
    if(i+CHUNK<users.length) await new Promise(r=>setTimeout(r,100));
  }
  searchNotifications.set(fakeGameId,sent);
  setTimeout(()=>deleteSearchMsgs(fakeGameId),3600000);
}

async function scheduleFakeNotification(){
  if(fakeNotifTimer){clearTimeout(fakeNotifTimer);fakeNotifTimer=null;}
  const intervalMins=await getSetting('fakeNotifInterval',3);
  const delay=Math.max(1,Number(intervalMins))*60*1000;
  fakeNotifTimer=setTimeout(async()=>{await sendFakeSearchNotification();scheduleFakeNotification();},delay);
}
scheduleFakeNotification();

// ===== Socket.io =====
io.on('connection',(socket)=>{
  let myUserId=null,myGameId=null;

  socket.on('findGame',async({userId})=>{
    if(!userId) return socket.emit('error',{msg:'userId မပါ'});
    myUserId=parseInt(userId);
    const lastFG=findGameCooldowns.get(myUserId)||0;
    if(Date.now()-lastFG<FINDGAME_COOLDOWN_MS) return socket.emit('error',{msg:'နည်းနည်းစောင့်ပါ'});
    findGameCooldowns.set(myUserId,Date.now());
    if(processingUsers.has(myUserId)) return socket.emit('error',{msg:'ရှာဖွေနေဆဲ'});
    processingUsers.add(myUserId);
    try{
      userSockets.set(myUserId,socket.id);
      // Resume existing game
      const existEntry=[...activeGames.entries()].find(([,g])=>g.players.includes(myUserId));
      if(existEntry){
        const[gid,game]=existEntry;myGameId=gid;socket.join(gid);
        socket.emit('gameResumed',{gameId:gid,board:game.board,
          mySymbol:game.symbols.get?game.symbols.get(String(myUserId)):game.symbols[myUserId],
          currentTurn:game.currentTurn,players:game.playerNames});
        return;
      }
      const user=await User.findOne({telegramId:myUserId}).lean();
      if(!user||user.isBanned) return socket.emit('error',{msg:'Access denied'});
      if(user.balance<ENTRY_FEE) return socket.emit('insufficientBalance',{balance:user.balance,required:ENTRY_FEE});

      // Check allBotMode
      const allBotMode=await getSetting('allBotMode',false);
      const gameId=genGameId();
      if(allBotMode||user.botMode){
        await startSabotageAIGame(socket,myUserId,gameId,user.firstName||user.username||`User${myUserId}`);
        return;
      }

      // PvP matching — shared queue across Bot-1 & Bot-2
      const waitIdx=waitingQueue.findIndex(w=>w.userId!==myUserId);
      if(waitIdx!==-1){
        const opponent=waitingQueue.splice(waitIdx,1)[0];
        await deleteSearchMsgs(opponent.gameId);
        const oppTimeout=searchTimeouts.get(opponent.userId);
        if(oppTimeout){clearTimeout(oppTimeout);searchTimeouts.delete(opponent.userId);}
        // Deduct entry fees
        const[p1,p2]=await Promise.all([
          User.findOneAndUpdate({telegramId:myUserId,balance:{$gte:ENTRY_FEE},isBanned:{$ne:true}},{$inc:{balance:-ENTRY_FEE}},{new:true}),
          User.findOneAndUpdate({telegramId:opponent.userId,balance:{$gte:ENTRY_FEE},isBanned:{$ne:true}},{$inc:{balance:-ENTRY_FEE}},{new:true})
        ]);
        if(!p1||!p2){
          if(p1) await User.findOneAndUpdate({telegramId:myUserId},{$inc:{balance:ENTRY_FEE}});
          if(p2) await User.findOneAndUpdate({telegramId:opponent.userId},{$inc:{balance:ENTRY_FEE}});
          socket.emit('error',{msg:'잔액 부족 또는 오류'});
          waitingQueue.push(opponent);
          return;
        }
        const symbols={};
        if(Math.random()>0.5){symbols[myUserId]='X';symbols[opponent.userId]='O';}
        else{symbols[myUserId]='O';symbols[opponent.userId]='X';}
        const firstTurn=parseInt(Object.entries(symbols).find(([,v])=>v==='X')[0]);
        const pNames={
          [myUserId]:user.firstName||user.username||`User${myUserId}`,
          [opponent.userId]:opponent.userName
        };
        const gameState={gameId:opponent.gameId,players:[myUserId,opponent.userId],symbols,
          board:Array(5).fill(null).map(()=>Array(5).fill('')),currentTurn:firstTurn,
          status:'active',isAIGame:false,startedAt:Date.now(),lastMoveAt:Date.now(),playerNames:pNames};
        activeGames.set(opponent.gameId,gameState);
        myGameId=opponent.gameId;
        socket.join(opponent.gameId);
        io.to(opponent.gameId).emit('gameStart',{gameId:opponent.gameId,board:gameState.board,
          currentTurn:firstTurn,players:pNames,
          mySymbol:symbols[myUserId]});
        const oppSocket=io.sockets.sockets.get(opponent.socketId);
        if(oppSocket) oppSocket.emit('gameStart',{gameId:opponent.gameId,board:gameState.board,
          currentTurn:firstTurn,players:pNames,mySymbol:symbols[opponent.userId]});
        const t=setTimeout(()=>handleTurnTimeout(opponent.gameId,firstTurn),TURN_SECONDS*1000+1500);
        gameTurnTimeouts.set(opponent.gameId,t);
      } else {
        // Queue up
        myGameId=gameId;
        waitingQueue.push({gameId,userId:myUserId,socketId:socket.id,userName:user.firstName||user.username||`User${myUserId}`});
        socket.join(gameId);
        socket.emit('waiting',{gameId,message:'ကစားသူ ရှာဖွေနေသည်...'});
        await sendSearchNotification(gameId,myUserId);
        const timeout=setTimeout(()=>{
          if(socket.connected) socket.emit('searchUpdate',{message:'ကစားသူ မတွေ့သေးပါ'});
        },SEARCH_TIMEOUT_S*1000);
        searchTimeouts.set(myUserId,timeout);
      }
    }catch(e){console.error('findGame err:',e);socket.emit('error',{msg:'Server error'});}
    finally{processingUsers.delete(myUserId);}
  });

  socket.on('cancelSearch',async({userId})=>{
    const uid=parseInt(userId||myUserId);
    const idx=waitingQueue.findIndex(w=>w.userId===uid);
    if(idx!==-1){const{gameId}=waitingQueue[idx];waitingQueue.splice(idx,1);await deleteSearchMsgs(gameId);}
    const timeout=searchTimeouts.get(uid);if(timeout){clearTimeout(timeout);searchTimeouts.delete(uid);}
    socket.emit('searchCancelled');
  });

  socket.on('makeMove',async({gameId,row,col})=>{
    const lastMove=moveCooldowns.get(myUserId)||0;
    if(Date.now()-lastMove<MOVE_COOLDOWN_MS) return;
    moveCooldowns.set(myUserId,Date.now());
    try{
      const game=activeGames.get(gameId);
      if(!game||game.status!=='active') return;
      if(game.isAIGame&&game.currentTurn===AI_ID) return socket.emit('error',{msg:'AI စဉ်းစားနေဆဲ'});
      if(game.currentTurn!==myUserId) return socket.emit('error',{msg:'သင့်လှည့် မဟုတ်ပါ'});
      if(row<0||row>4||col<0||col>4) return socket.emit('error',{msg:'Invalid move'});
      if(game.board[row][col]!=='') return socket.emit('error',{msg:'ထိုနေရာ ယူပြီးသား'});
      const sym=game.symbols[myUserId]||game.symbols[String(myUserId)];
      if(!sym) return socket.emit('error',{msg:'Symbol မတွေ့ပါ'});
      if(game.isAIGame&&game.aiType===AI_TYPE_SABOTAGE&&checkWinAfterMove(game.board,row,col,sym)){
        // Only sabotage if AI mode is intentionally enabled; otherwise let player win
        const allBotMode=await getSetting('allBotMode',false);
        const userDoc=await User.findOne({telegramId:myUserId}).select('botMode').lean();
        if(allBotMode||userDoc?.botMode){
          clearTurnTimer(gameId);await handleSabotage(game,myUserId);return;
        }
        // AI mode off — let normal win logic proceed
      }
      if(game.status!=='active') return;
      clearTurnTimer(gameId);
      game.board[row][col]=sym;game.lastMoveAt=Date.now();
      const didWin=checkWin(game.board,sym),isDraw=!didWin&&boardFull(game.board),gameEnds=didWin||isDraw;
      const nextPlayer=gameEnds?null:game.players.find(p=>p!==myUserId);
      io.to(gameId).emit('moveMade',{row,col,symbol:sym,playerId:myUserId,board:game.board.map(r=>[...r]),currentTurn:nextPlayer,gameEnded:gameEnds});
      if(didWin){game.status='ending';if(game.isAIGame) await endGameAI(gameId,myUserId,'win');else await endGame(gameId,myUserId,'win');}
      else if(isDraw){game.status='ending';if(game.isAIGame) await endGameAI(gameId,-1,'draw');else await endGame(gameId,-1,'draw');}
      else{
        game.currentTurn=nextPlayer;io.to(gameId).emit('turnChanged',{currentTurn:nextPlayer});
        if(nextPlayer===AI_ID) scheduleSabotageAIMove(gameId);
        else{const t=setTimeout(()=>handleTurnTimeout(gameId,nextPlayer),TURN_SECONDS*1000+1500);gameTurnTimeouts.set(gameId,t);}
      }
    }catch(e){console.error('makeMove err:',e);socket.emit('error',{msg:'Move error'});}
  });

  socket.on('surrender',({gameId,userId})=>{
    const uid=parseInt(userId||myUserId);
    const game=activeGames.get(gameId);if(!game||game.status!=='active') return;
    const opp=game.players.find(p=>Number(p)!==uid);
    if(opp) endGame(gameId,opp,'surrender').catch(()=>{});
  });

  socket.on('sendEmote',({gameId,emote})=>{
    try{
      if(!gameId||!emote||!myUserId) return;
      const game=activeGames.get(gameId);
      if(!game||game.status!=='active'||!game.players.includes(myUserId)) return;
      const senderName=game.playerNames?.[myUserId]||`User${myUserId}`;
      io.to(gameId).emit('emote',{senderId:myUserId,fromName:senderName,emote});
    }catch(e){console.error('emote err:',e);}
  });

  async function handleTurnTimeout(gameId,playerId){
    const game=activeGames.get(gameId);
    if(!game||game.status!=='active') return;
    const timedOutId=Number(playerId),currentTurnId=Number(game.currentTurn);
    if(currentTurnId!==timedOutId) return;
    const winner=game.players.find(p=>Number(p)!==timedOutId);
    if(winner) await endGame(gameId,winner,'timeout');
  }

  socket.on('disconnect',async()=>{
    const wIdx=waitingQueue.findIndex(w=>w.socketId===socket.id);
    if(wIdx!==-1){const{gameId,userId}=waitingQueue[wIdx];waitingQueue.splice(wIdx,1);await deleteSearchMsgs(gameId);
      const t=searchTimeouts.get(userId);if(t){clearTimeout(t);searchTimeouts.delete(userId);}
    }
    const dUid=myUserId,dGid=myGameId;
    if(dUid){userSockets.delete(dUid);processingUsers.delete(dUid);moveCooldowns.delete(dUid);findGameCooldowns.delete(dUid);}
    if(dGid&&activeGames.has(dGid)){
      setTimeout(async()=>{
        const reconnected=dUid&&userSockets.has(dUid);if(reconnected) return;
        const game=activeGames.get(dGid);if(!game||game.status!=='active') return;
        if(game.isAIGame) await endGameAI(dGid,AI_ID,'disconnect');
        else{const opp=game.players.find(p=>Number(p)!==Number(dUid));if(opp) await endGame(dGid,opp,'disconnect');}
      },5000);
    }
  });
});

// ===== Admin verify =====
app.post('/api/admin/verify',async(req,res)=>{
  try{
    const{telegramId}=req.body;
    if(!telegramId) return res.status(400).json({error:'telegramId required'});
    const tid=parseInt(telegramId);
    if(!isAnyAdmin(tid)) return res.status(403).json({error:'Access denied'});
    const user=await User.findOne({telegramId:tid}).select('firstName username').lean();
    const name=user?.firstName||user?.username||`Admin${tid}`;
    res.json({ok:true,adminId:tid,name,isMainAdmin:isMainAdmin(tid),isPartner:isPartnerAdmin(tid)});
  }catch(e){res.status(500).json({error:'Server error'});}
});

// ===== Agent milestone helper =====
async function updateAgentMilestone(agentTelegramId,depositAmount){
  try{
    const agentUser=await User.findOne({telegramId:agentTelegramId,role:'agent'}).lean();if(!agentUser) return;
    let agent=await Agent.findOne({telegramId:agentTelegramId});
    if(!agent){agent=new Agent({telegramId:agentTelegramId,referralCode:agentUser.referralCode});await agent.save();}
    for(const cfg of BOX_CONFIG){
      const ms=agent.milestones[cfg.box];if(!ms||ms.claimed) continue;
      if(depositAmount>=cfg.perPerson&&ms.current<cfg.people) agent.milestones[cfg.box].current=ms.current+1;
    }
    await agent.save();
  }catch(e){console.error('agentMilestone err:',e);}
}

// ===== Routes =====
app.get('/',(_,res)=>res.json({ok:true,bot:BOT_USERNAME,source:BOT_SOURCE}));
app.get('/health',(_,res)=>res.json({ok:true,mongodb:isConnected?'connected':'disconnected',activeGames:activeGames.size,queue:waitingQueue.length,bot:BOT_USERNAME}));

// Auth — saves botSource
app.post('/api/auth',async(req,res)=>{
  try{
    const{initData,telegramId:devId,botSource:reqSource}=req.body;
    let tid,username,firstName;
    if(initData){const u=verifyTgAuth(initData);if(!u) return res.status(401).json({error:'Auth မှား'});tid=u.id;username=u.username||'';firstName=u.first_name||'';}
    else if(devId){tid=parseInt(devId);username='';firstName='User';}
    else return res.status(401).json({error:'Auth required'});
    const maint=await getSetting('maintenance',false);
    if(maint&&tid!==ADMIN_ID) return res.status(503).json({error:'🔧 ဆာဗာ ပြင်ဆင်နေသည်'});
    let user=await User.findOne({telegramId:tid});
    const src=reqSource||BOT_SOURCE;
    if(!user){
      user=new User({telegramId:tid,username,firstName,referralCode:genRefCode(tid),botSource:src});
      await user.save();
    }else{
      let d=false;
      if(username&&user.username!==username){user.username=username;d=true;}
      if(firstName&&user.firstName!==firstName){user.firstName=firstName;d=true;}
      if(!user.botSource){user.botSource=src;d=true;}
      if(d){user.lastActive=new Date();await user.save();}
    }
    if(user.isBanned) return res.status(403).json({error:'🚫 ကောင်ပိတ်ဆို့ထားသည်'});
    res.json({telegramId:user.telegramId,username:user.username||user.firstName||`User${user.telegramId}`,
      firstName:user.firstName,balance:user.balance,referralCode:user.referralCode,
      totalGames:user.totalGames,wins:user.wins,losses:user.losses,botMode:user.botMode,botSource:user.botSource});
  }catch(e){console.error(e);res.status(500).json({error:'Server error'});}
});

app.get('/api/user/:id',async(req,res)=>{
  try{
    const u=await User.findOne({telegramId:parseInt(req.params.id)}).select('balance totalGames wins losses botMode firstName username').lean();
    if(!u) return res.status(404).json({error:'Not found'});
    res.json(u);
  }catch(e){res.status(500).json({error:'Server error'});}
});

// Deposit — stores botSource
app.post('/api/deposit',async(req,res)=>{
  try{
    const{telegramId,kpayName,transactionId,amount,paymentMethod,botSource:reqSrc}=req.body;
    if(!telegramId||!kpayName||!transactionId||!amount) return res.status(400).json({error:'ကွင်းလပ်များ ဖြည့်ပါ'});
    if(parseInt(amount)<500) return res.status(400).json({error:'အနည်းဆုံး 500 MMK'});
    const u=await User.findOne({telegramId:parseInt(telegramId)}).lean();
    if(!u) return res.status(404).json({error:'User not found'});
    if(u.isBanned) return res.status(403).json({error:'ကောင်ပိတ်ဆို့ထားသည်'});
    if(await Deposit.findOne({transactionId}).lean()) return res.status(400).json({error:'Transaction ID ကို အသုံးပြုပြီးသည်'});
    const method=(paymentMethod==='wave')?'wave':'kpay';
    const src=reqSrc||u.botSource||BOT_SOURCE;
    const dep=await new Deposit({userId:u.telegramId,kpayName,transactionId,amount:parseInt(amount),paymentMethod:method,botSource:src}).save();
    if(bot) bot.telegram.sendMessage(ADMIN_ID,
      `💰 *ငွေသွင်း* [${src}]\n👤 ${u.firstName||u.username} (${u.telegramId})\n💵 ${parseInt(amount).toLocaleString()} MMK\n📝 ${kpayName}\n🔢 \`${transactionId}\``,
      {parse_mode:'Markdown'}).catch(()=>{});
    res.json({success:true,depositId:dep._id});
  }catch(e){console.error(e);res.status(500).json({error:'Server error'});}
});

// Withdraw — stores botSource
app.post('/api/withdraw',async(req,res)=>{
  try{
    const{telegramId,kpayName,kpayNumber,amount,paymentMethod,botSource:reqSrc}=req.body;
    if(!telegramId||!kpayName||!kpayNumber||!amount) return res.status(400).json({error:'ကွင်းလပ်များ ဖြည့်ပါ'});
    const amt=parseInt(amount);if(isNaN(amt)||amt<2500) return res.status(400).json({error:'အနည်းဆုံး 2,500 MMK'});
    const tid=parseInt(telegramId);
    const chk=await User.findOne({telegramId:tid}).select('balance isBanned firstName username botSource').lean();
    if(!chk) return res.status(404).json({error:'User မတွေ့ပါ'});
    if(chk.isBanned) return res.status(403).json({error:'🚫 ကောင်ပိတ်ဆို့ထားသည်'});
    if(chk.balance<amt) return res.status(400).json({error:`လက်ကျန်ငွေ မလုံလောက်ပါ (ကျန်: ${chk.balance.toLocaleString()} MMK)`});
    const method=(paymentMethod==='wave')?'wave':'kpay';
    const src=reqSrc||chk.botSource||BOT_SOURCE;
    let wd;
    try{wd=await new Withdrawal({userId:tid,kpayName,kpayNumber,amount:amt,paymentMethod:method,botSource:src}).save();}
    catch(e){return res.status(500).json({error:'Record သိမ်းမရပါ'});}
    const u=await User.findOneAndUpdate({telegramId:tid,balance:{$gte:amt},isBanned:{$ne:true}},{$inc:{balance:-amt}},{new:true});
    if(!u){
      await Withdrawal.findByIdAndDelete(wd._id).catch(()=>{});
      return res.status(400).json({error:'လက်ကျန်ငွေ မလုံလောက်ပါ'});
    }
    if(bot) bot.telegram.sendMessage(ADMIN_ID,
      `💸 *ငွေထုတ်* [${src}]\n👤 ${u.firstName||u.username} (${u.telegramId})\n💵 ${amt.toLocaleString()} MMK\n📝 ${kpayName} — ${kpayNumber}\n🏦 ကျန်: ${u.balance.toLocaleString()} MMK`,
      {parse_mode:'Markdown'}).catch(()=>{});
    res.json({success:true,withdrawalId:wd._id,newBalance:u.balance});
  }catch(e){console.error(e);res.status(500).json({error:'Server error'});}
});

app.get('/api/referrals/:telegramId',async(req,res)=>{
  try{
    const tid=parseInt(req.params.telegramId);if(isNaN(tid)) return res.status(400).json({error:'Invalid ID'});
    const referrals=await User.find({referredBy:tid}).select('firstName username balance createdAt').sort({createdAt:-1}).lean();
    res.json({total:referrals.length,referrals:referrals.map(u=>({name:u.firstName||u.username||`User${u.telegramId}`,username:u.username||'',balance:u.balance||0,joinedAt:u.createdAt}))});
  }catch(e){res.status(500).json({error:e.message});}
});

// Payment info (agent-specific kpay)
app.get('/api/payment-info/:telegramId',async(req,res)=>{
  try{
    const tid=parseInt(req.params.telegramId);
    const user=await User.findOne({telegramId:tid}).lean();if(!user) return res.status(404).json({error:'User မတွေ့ပါ'});
    const defaultInfo={
      kpayNumber:process.env.ADMIN_KPAY_NUMBER||'09792310926',
      kpayName:process.env.ADMIN_KPAY_NAME||'Admin',
      hasWave:true,waveNumber:process.env.ADMIN_WAVE_NUMBER||'09792310926',
      waveName:process.env.ADMIN_WAVE_NAME||'Admin',isAgentPayment:false
    };
    if(!user.referredBy) return res.json(defaultInfo);
    const agentDoc=await Agent.findOne({telegramId:user.referredBy}).lean();
    if(!agentDoc||!agentDoc.agentKpayNumber) return res.json(defaultInfo);
    res.json({kpayNumber:agentDoc.agentKpayNumber,kpayName:agentDoc.agentKpayName||'',hasWave:agentDoc.hasWave||false,waveNumber:'',waveName:'',isAgentPayment:true});
  }catch(e){res.status(500).json({error:e.message});}
});

// ===== Admin Stats — filtered by botSource for partners =====
app.get('/api/admin/stats',isAdmin,async(req,res)=>{
  try{
    const src=req.query.botSource;
    // Partners always see only Bot2; main admin can filter or see all
    const filter=req.isPartner?{botSource:BOT_SOURCE}:(src?{botSource:src}:{});
    const[tu,tg,pd,pw]=await Promise.all([
      User.countDocuments(filter),
      Game.countDocuments({status:'completed'}),
      Deposit.countDocuments({status:'pending',...filter}),
      Withdrawal.countDocuments({status:'pending',...filter})
    ]);
    const[depAgg,wdAgg]=await Promise.all([
      Deposit.aggregate([{$match:{status:'confirmed',...filter}},{$group:{_id:null,t:{$sum:'$amount'}}}]),
      Withdrawal.aggregate([{$match:{status:'confirmed',...filter}},{$group:{_id:null,t:{$sum:'$amount'}}}])
    ]);
    res.json({totalUsers:tu,bot2Users:tu,totalGames:tg,pendingDeposits:pd,pendingWithdrawals:pw,
      activeGames:activeGames.size,queueLength:waitingQueue.length,
      totalDeposited:depAgg[0]?.t||0,totalWithdrawn:wdAgg[0]?.t||0});
  }catch(e){res.status(500).json({error:e.message});}
});

app.get('/api/admin/settings',isAdmin,async(_,res)=>{
  const maint=await getSetting('maintenance',false);
  const allBotMode=await getSetting('allBotMode',false);
  const fakeNotifications=await getSetting('fakeNotifications',false);
  const fakeNotifInterval=await getSetting('fakeNotifInterval',3);
  res.json({maintenance:maint,allBotMode,fakeNotifications,fakeNotifInterval,entryFee:ENTRY_FEE,winPrize:WIN_PRIZE,drawRefund:DRAW_REFUND,turnSeconds:TURN_SECONDS});
});

app.post('/api/admin/maintenance',isAdmin,async(req,res)=>{if(!req.isMainAdmin) return res.status(403).json({error:'Main admin only'});await setSetting('maintenance',!!req.body.enabled);res.json({success:true});});
app.post('/api/admin/allbotmode',isAdmin,async(req,res)=>{if(!req.isMainAdmin) return res.status(403).json({error:'Main admin only'});await setSetting('allBotMode',!!req.body.enabled);res.json({success:true});});
app.post('/api/admin/fakenotifications',isAdmin,async(req,res)=>{if(!req.isMainAdmin) return res.status(403).json({error:'Main admin only'});await setSetting('fakeNotifications',!!req.body.enabled);res.json({success:true});});
app.post('/api/admin/fakenotifinterval',isAdmin,async(req,res)=>{if(!req.isMainAdmin) return res.status(403).json({error:'Main admin only'});const mins=Math.max(1,Number(req.body.interval)||3);await setSetting('fakeNotifInterval',mins);scheduleFakeNotification();res.json({success:true,fakeNotifInterval:mins});});

// Deposits — partner sees only Bot2
app.get('/api/admin/deposits',isAdmin,async(req,res)=>{
  try{
    const src=req.isPartner?BOT_SOURCE:(req.query.botSource||null);
    const query={status:req.query.status||'pending'};
    if(src) query.botSource=src;
    // Main admin: exclude agent-referred deposits (agents handle those) unless partner
    if(req.isMainAdmin&&!src){
      const agents=await User.find({role:'agent'}).select('telegramId').lean();
      const agentIds=agents.map(a=>a.telegramId);
      if(agentIds.length){
        const agentReferredIds=(await User.find({referredBy:{$in:agentIds}}).select('telegramId').lean()).map(u=>u.telegramId);
        if(agentReferredIds.length) query.userId={$nin:agentReferredIds};
      }
    }
    const deps=await Deposit.find(query).sort({createdAt:-1}).limit(60).lean();
    const out=await Promise.all(deps.map(async d=>{const u=await User.findOne({telegramId:d.userId}).select('firstName username').lean();return{...d,userName:u?.firstName||u?.username||String(d.userId)};}));
    res.json(out);
  }catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/admin/deposits/:id/confirm',isAdmin,async(req,res)=>{
  try{
    const dep=await Deposit.findOneAndUpdate(
      {_id:req.params.id,status:'pending',...(req.isPartner?{botSource:BOT_SOURCE}:{})},
      {$set:{status:'confirmed',processedAt:new Date(),expireAt:new Date(Date.now()+72*60*60*1000)}},{new:true});
    if(!dep) return res.status(400).json({error:'မတွေ့ပါ သို့မဟုတ် ပြင်ဆင်ပြီးသား'});
    await User.findOneAndUpdate({telegramId:dep.userId},{$inc:{balance:dep.amount}});
    const user=await User.findOne({telegramId:dep.userId}).lean();
    if(user?.referredBy){
      const prevDeps=await Deposit.countDocuments({userId:dep.userId,status:'confirmed',_id:{$ne:dep._id}});
      if(prevDeps===0){await User.findOneAndUpdate({telegramId:user.referredBy},{$inc:{balance:100}});
        if(bot) bot.telegram.sendMessage(user.referredBy,`🎉 Referral ငွေဖြည့်ကြောင့် <b>100 MMK</b> ရရှိပြီ!`,{parse_mode:'HTML'}).catch(()=>{});}
      await updateAgentMilestone(user.referredBy,dep.amount);
    }
    if(bot) bot.telegram.sendMessage(dep.userId,
      `✅ ငွေ ${dep.amount.toLocaleString()} MMK သွင်းမှု အတည်ပြုပြီ! 🎉`,
      Markup.inlineKeyboard([[Markup.button.webApp('⚡ ကစားမည်',FRONTEND_URL)]])).catch(()=>{});
    res.json({success:true});
  }catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/admin/deposits/:id/reject',isAdmin,async(req,res)=>{
  try{
    const{reason}=req.body;
    const filter={_id:req.params.id,...(req.isPartner?{botSource:BOT_SOURCE}:{})};
    const dep=await Deposit.findOneAndUpdate(filter,{status:'rejected',processedAt:new Date(),expireAt:new Date(Date.now()+72*60*60*1000)},{new:true});
    if(!dep) return res.status(404).json({error:'မတွေ့ပါ'});
    if(bot) bot.telegram.sendMessage(dep.userId,`❌ ငွေသွင်း ${dep.amount.toLocaleString()} MMK ပယ်ချပြီ${reason?'\nအကြောင်း: '+reason:''}`).catch(()=>{});
    res.json({success:true});
  }catch(e){res.status(500).json({error:e.message});}
});

// Withdrawals — partner sees only Bot2
app.get('/api/admin/withdrawals',isAdmin,async(req,res)=>{
  try{
    const src=req.isPartner?BOT_SOURCE:(req.query.botSource||null);
    const query={status:req.query.status||'pending'};if(src) query.botSource=src;
    const wds=await Withdrawal.find(query).sort({createdAt:-1}).limit(60).lean();
    const out=await Promise.all(wds.map(async w=>{const u=await User.findOne({telegramId:w.userId}).select('firstName username balance').lean();return{...w,userName:u?.firstName||u?.username||String(w.userId),userBalance:u?.balance};}));
    res.json(out);
  }catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/admin/withdrawals/:id/confirm',isAdmin,async(req,res)=>{
  try{
    const filter={_id:req.params.id,status:'pending',...(req.isPartner?{botSource:BOT_SOURCE}:{})};
    const wd=await Withdrawal.findOneAndUpdate(filter,{$set:{status:'confirmed',processedAt:new Date(),expireAt:new Date(Date.now()+72*60*60*1000)}},{new:true});
    if(!wd) return res.status(400).json({error:'မတွေ့ပါ သို့မဟုတ် ပြင်ဆင်ပြီးသား'});
    if(bot) bot.telegram.sendMessage(wd.userId,`✅ ငွေထုတ် ${wd.amount.toLocaleString()} MMK အတည်ပြုပြီ! ${wd.kpayNumber} 🎉`).catch(()=>{});
    res.json({success:true});
  }catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/admin/withdrawals/:id/reject',isAdmin,async(req,res)=>{
  try{
    const filter={_id:req.params.id,...(req.isPartner?{botSource:BOT_SOURCE}:{})};
    const wd=await Withdrawal.findById(req.params.id);
    if(!wd||wd.status!=='pending') return res.status(400).json({error:'မတွေ့ပါ သို့မဟုတ် ပြင်ဆင်ပြီးသား'});
    wd.status='rejected';wd.processedAt=new Date();wd.expireAt=new Date(Date.now()+72*60*60*1000);await wd.save();
    await User.findOneAndUpdate({telegramId:wd.userId},{$inc:{balance:wd.amount}});
    if(bot) bot.telegram.sendMessage(wd.userId,`❌ ငွေထုတ် ${wd.amount.toLocaleString()} MMK ပယ်ချပြီ — ငွေပြန်အမ်းပြီ`).catch(()=>{});
    res.json({success:true});
  }catch(e){res.status(500).json({error:e.message});}
});

// Users — partner sees only Bot2
app.get('/api/admin/users',isAdmin,async(req,res)=>{
  try{
    const{search,page=1}=req.query;
    const src=req.isPartner?BOT_SOURCE:(req.query.botSource||null);
    let q=src?{botSource:src}:{};
    if(search) q={...q,$or:[{telegramId:isNaN(search)?-1:parseInt(search)},{username:{$regex:search,$options:'i'}},{firstName:{$regex:search,$options:'i'}}]};
    const users=await User.find(q).sort({createdAt:-1}).skip((page-1)*20).limit(20).lean();
    const total=await User.countDocuments(q);
    res.json({users,total,pages:Math.ceil(total/20)});
  }catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/admin/users/:tid/balance',isAdmin,async(req,res)=>{
  try{
    const{amount,reason}=req.body;
    const u=await User.findOneAndUpdate({telegramId:parseInt(req.params.tid)},{$inc:{balance:parseInt(amount)}},{new:true});
    if(!u) return res.status(404).json({error:'Not found'});
    if(bot){const sign=amount>0?'+':'';bot.telegram.sendMessage(u.telegramId,`💰 Admin: ${sign}${parseInt(amount).toLocaleString()} MMK${reason?'\n'+reason:''}\nလက်ကျန်: ${u.balance.toLocaleString()} MMK`).catch(()=>{});}
    res.json({success:true,newBalance:u.balance});
  }catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/admin/users/:tid/ban',isAdmin,async(req,res)=>{
  try{
    const{ban}=req.body;
    const u=await User.findOneAndUpdate({telegramId:parseInt(req.params.tid)},{isBanned:!!ban},{new:true});
    if(!u) return res.status(404).json({error:'Not found'});
    if(bot&&ban) bot.telegram.sendMessage(u.telegramId,'🚫 ကောင်ပိတ်ဆို့ထားပါသည်').catch(()=>{});
    res.json({success:true});
  }catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/admin/users/:tid/botmode',isAdmin,async(req,res)=>{
  if(!req.isMainAdmin) return res.status(403).json({error:'Main admin only'});
  try{const{enabled}=req.body;const u=await User.findOneAndUpdate({telegramId:parseInt(req.params.tid)},{botMode:!!enabled},{new:true});if(!u) return res.status(404).json({error:'Not found'});res.json({success:true,botMode:u.botMode});}
  catch(e){res.status(500).json({error:e.message});}
});

// Broadcast (main admin only)
app.post('/api/admin/broadcast',isAdmin,async(req,res)=>{
  if(!req.isMainAdmin) return res.status(403).json({error:'Main admin only'});
  try{
    const{message,buttonText,buttonUrl,botSource:src}=req.body;
    if(!message) return res.status(400).json({error:'Message required'});
    res.json({success:true,msg:'Broadcast started'});
    setImmediate(async()=>{
      const filter=src?{isBanned:{$ne:true},botSource:src}:{isBanned:{$ne:true}};
      const users=await User.find(filter).select('telegramId').lean();
      const kb=buttonText&&buttonUrl?{inline_keyboard:[[{text:buttonText,url:buttonUrl}]]}:undefined;
      const CHUNK=30;
      for(let i=0;i<users.length;i+=CHUNK){
        const batch=users.slice(i,i+CHUNK);
        await Promise.allSettled(batch.map(async u=>{try{await bot.telegram.sendMessage(u.telegramId,message,{parse_mode:'HTML',reply_markup:kb});}catch{}}));
        if(i+CHUNK<users.length) await new Promise(r=>setTimeout(r,1000));
      }
    });
  }catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/admin/message',isAdmin,async(req,res)=>{
  try{
    const{telegramId,message}=req.body;if(!telegramId||!message) return res.status(400).json({error:'Missing fields'});
    await bot.telegram.sendMessage(parseInt(telegramId),message,{parse_mode:'HTML'});
    res.json({success:true});
  }catch(e){res.status(500).json({error:e.message});}
});

// Agent routes (main admin only)
async function isAgent(req,res,next){const tid=parseInt(req.headers['x-telegram-id']||req.query.telegramId);if(!tid) return res.status(401).json({error:'Telegram ID မပါ'});const user=await User.findOne({telegramId:tid,role:'agent'}).lean();if(!user) return res.status(403).json({error:'Agent မဟုတ်သေးပါ'});req.agentUser=user;next();}

app.get('/api/agent/panel',isAgent,async(req,res)=>{
  try{
    const user=req.agentUser;let agent=await Agent.findOne({telegramId:user.telegramId});
    if(!agent){agent=new Agent({telegramId:user.telegramId,referralCode:user.referralCode});await agent.save();}
    const totalReferrals=await User.countDocuments({referredBy:user.telegramId});
    const referredIds=(await User.find({referredBy:user.telegramId}).select('telegramId').lean()).map(u=>u.telegramId);
    const salesAgg=referredIds.length?await Deposit.aggregate([{$match:{userId:{$in:referredIds},status:'confirmed'}},{$group:{_id:null,total:{$sum:'$amount'}}}]):[];
    res.json({telegramId:user.telegramId,firstName:user.firstName,username:user.username,balance:user.balance,
      referralCode:user.referralCode,botUsername:BOT_USERNAME,milestones:agent.milestones,
      totalEarned:agent.totalEarned,completedBoxes:agent.completedBoxes,totalReferrals,totalSales:salesAgg[0]?.total||0});
  }catch(e){res.status(500).json({error:e.message});}
});

app.get('/api/agent/deposits',isAgent,async(req,res)=>{
  try{
    const agentId=req.agentUser.telegramId;
    const referredUsers=await User.find({referredBy:agentId}).select('telegramId firstName username').lean();
    if(!referredUsers.length) return res.json([]);
    const referredIds=referredUsers.map(u=>u.telegramId);
    const userMap={};referredUsers.forEach(u=>{userMap[u.telegramId]=u.firstName||u.username||`User${u.telegramId}`;});
    const deps=await Deposit.find({userId:{$in:referredIds},status:req.query.status||'pending'}).sort({createdAt:-1}).limit(50).lean();
    res.json(deps.map(d=>({...d,userName:userMap[d.userId]||String(d.userId)})));
  }catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/agent/deposits/:id/confirm',isAgent,async(req,res)=>{
  try{
    const agentId=req.agentUser.telegramId;
    const dep=await Deposit.findOneAndUpdate({_id:req.params.id,status:'pending'},{$set:{status:'confirming'}},{new:false});
    if(!dep){const e=await Deposit.findById(req.params.id).lean();if(!e) return res.status(404).json({error:'မတွေ့ပါ'});return res.status(400).json({error:'ပြင်ဆင်ပြီးသား'});}
    const user=await User.findOne({telegramId:dep.userId}).lean();
    if(!user||user.referredBy!==agentId){await Deposit.findByIdAndUpdate(dep._id,{$set:{status:'pending'}});return res.status(403).json({error:'Referral မဟုတ်ပါ'});}
    const agentFresh=await User.findOne({telegramId:agentId}).lean();
    if(!agentFresh||agentFresh.balance<dep.amount){await Deposit.findByIdAndUpdate(dep._id,{$set:{status:'pending'}});
      return res.status(402).json({error:`လက်ကျန်ငွေ မလောက်ပါ (ကျန်: ${(agentFresh?.balance||0).toLocaleString()} MMK)\nGame Developer ကို ဆက်သွယ်ပြီး ယူနစ်ဖြည့်ပါ`,insufficientBalance:true});}
    await Deposit.findByIdAndUpdate(dep._id,{$set:{status:'confirmed',processedAt:new Date(),processedBy:'agent',expireAt:new Date(Date.now()+72*60*60*1000)}});
    await User.findOneAndUpdate({telegramId:agentId},{$inc:{balance:-dep.amount}});
    await User.findOneAndUpdate({telegramId:dep.userId},{$inc:{balance:dep.amount}});
    const prevDeps=await Deposit.countDocuments({userId:dep.userId,status:'confirmed',_id:{$ne:dep._id}});
    if(prevDeps===0){await User.findOneAndUpdate({telegramId:agentId},{$inc:{balance:100}});if(bot) bot.telegram.sendMessage(agentId,`🎉 Referral ပထမ ဖြည့်ကြောင့် <b>100 MMK</b> ရပြီ!`,{parse_mode:'HTML'}).catch(()=>{});}
    await updateAgentMilestone(agentId,dep.amount);
    if(bot) bot.telegram.sendMessage(dep.userId,`✅ ငွေ ${dep.amount.toLocaleString()} MMK သွင်းမှု အတည်ပြုပြီ! 🎉`,Markup.inlineKeyboard([[Markup.button.webApp('⚡ ကစားမည်',FRONTEND_URL)]])).catch(()=>{});
    res.json({success:true});
  }catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/agent/deposits/:id/reject',isAgent,async(req,res)=>{
  try{
    const agentId=req.agentUser.telegramId;const{reason}=req.body;
    const dep=await Deposit.findOneAndUpdate({_id:req.params.id,status:'pending'},{$set:{status:'rejected',processedAt:new Date(),processedBy:'agent',expireAt:new Date(Date.now()+72*60*60*1000)}},{new:true});
    if(!dep){return res.status(400).json({error:'ပြင်ဆင်ပြီးသား'});}
    if(bot) bot.telegram.sendMessage(dep.userId,`❌ ငွေ ${dep.amount.toLocaleString()} MMK ပယ်ချပြီ${reason?'\n'+reason:''}`).catch(()=>{});
    res.json({success:true});
  }catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/admin/agents/:tid/payment-info',isAdmin,async(req,res)=>{
  try{
    const tid=parseInt(req.params.tid);const{kpayNumber,kpayName,hasWave}=req.body;
    if(!kpayNumber) return res.status(400).json({error:'KPay နံပါတ် လိုသည်'});
    const agent=await Agent.findOneAndUpdate({telegramId:tid},{$set:{agentKpayNumber:kpayNumber,agentKpayName:kpayName||'',hasWave:!!hasWave}},{new:true,upsert:false});
    if(!agent) return res.status(404).json({error:'Agent မတွေ့ပါ'});
    res.json({success:true,agentKpayNumber:agent.agentKpayNumber,agentKpayName:agent.agentKpayName});
  }catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/admin/users/:tid/make-agent',isAdmin,async(req,res)=>{
  if(!req.isMainAdmin) return res.status(403).json({error:'Main admin only'});
  try{
    const tid=parseInt(req.params.tid);const{isAgent:makeAgent}=req.body;
    const u=await User.findOneAndUpdate({telegramId:tid},{role:makeAgent?'agent':'user'},{new:true});
    if(!u) return res.status(404).json({error:'Not found'});
    if(makeAgent){await Agent.findOneAndUpdate({telegramId:tid},{$setOnInsert:{telegramId:tid,referralCode:u.referralCode}},{upsert:true});
      if(bot) bot.telegram.sendMessage(tid,'🎯 <b>Agent ခွင့်ပြုပြီ!</b>',{parse_mode:'HTML'}).catch(()=>{});}
    res.json({success:true,role:u.role});
  }catch(e){res.status(500).json({error:e.message});}
});

// Redeem codes
app.post('/api/redeem',async(req,res)=>{
  try{
    const{telegramId,code}=req.body;if(!telegramId||!code) return res.status(400).json({error:'ကွင်းလပ် ဖြည့်ပါ'});
    const tid=parseInt(telegramId);
    const user=await User.findOne({telegramId:tid}).lean();if(!user) return res.status(404).json({error:'User မတွေ့ပါ'});
    if(user.isBanned) return res.status(403).json({error:'🚫 ကောင်ပိတ်ဆို့ထားသည်'});
    const rc=await RedeemCode.findOne({code:code.toUpperCase().trim()});
    if(!rc||!rc.isActive) return res.status(400).json({error:'❌ Code မမှန်ပါ'});
    if(rc.usedBy.includes(tid)) return res.status(400).json({error:'⚠️ ဤ Code အသုံးပြုပြီးသားဖြစ်သည်'});
    if(rc.maxUses>0&&rc.usedBy.length>=rc.maxUses) return res.status(400).json({error:'⚠️ Code ကုန်ဆုံးပြီ'});
    await RedeemCode.updateOne({_id:rc._id},{$push:{usedBy:tid}});
    const updated=await User.findOneAndUpdate({telegramId:tid},{$inc:{balance:rc.amount}},{new:true});
    if(bot) bot.telegram.sendMessage(ADMIN_ID,`🎟️ Redeem [Bot2]\n👤 ${user.firstName||user.username} (${tid})\n🎫 ${rc.code}\n💰 ${rc.amount.toLocaleString()} MMK`,{parse_mode:'HTML'}).catch(()=>{});
    res.json({success:true,amount:rc.amount,newBalance:updated.balance});
  }catch(e){console.error('redeem err:',e);res.status(500).json({error:'Server error'});}
});

app.post('/api/admin/redeem/create',isAdmin,async(req,res)=>{
  try{
    const{code,amount,maxUses}=req.body;if(!code||!amount) return res.status(400).json({error:'code + amount လိုသည်'});
    const rc=await new RedeemCode({code:code.toUpperCase().trim(),amount:parseInt(amount),maxUses:parseInt(maxUses)||1}).save();
    res.json({success:true,code:rc});
  }catch(e){if(e.code===11000) return res.status(400).json({error:'ထို Code ရှိပြီး'});res.status(500).json({error:e.message});}
});

app.get('/api/admin/redeem/list',isAdmin,async(_,res)=>{
  try{const codes=await RedeemCode.find().sort({createdAt:-1}).lean();res.json(codes);}
  catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/admin/redeem/:id/toggle',isAdmin,async(req,res)=>{
  try{const rc=await RedeemCode.findById(req.params.id);if(!rc) return res.status(404).json({error:'Not found'});rc.isActive=!rc.isActive;await rc.save();res.json({success:true,isActive:rc.isActive});}
  catch(e){res.status(500).json({error:e.message});}
});

app.delete('/api/admin/redeem/:id',isAdmin,async(req,res)=>{
  try{await RedeemCode.findByIdAndDelete(req.params.id);res.json({success:true});}
  catch(e){res.status(500).json({error:e.message});}
});

// Game history
app.get('/api/admin/games',isAdmin,async(req,res)=>{
  try{
    const{page=1,search=''}=req.query;const limit=20,skip=(parseInt(page)-1)*limit;
    let q={status:'completed'};if(search){const tid=isNaN(search)?null:parseInt(search);if(tid) q={...q,players:tid};}
    const games=await Game.find(q).sort({createdAt:-1}).skip(skip).limit(limit).lean();
    const total=await Game.countDocuments(q);
    const enriched=await Promise.all(games.map(async g=>{
      const pNames={};
      for(const pid of(g.players||[])){if(pid===-999999){pNames[pid]='🤖 AI';continue;}
        const nm=g.playerNames?(g.playerNames instanceof Map?g.playerNames.get(String(pid)):g.playerNames[pid]):null;
        if(nm){pNames[pid]=nm;continue;}
        const u=await User.findOne({telegramId:pid}).select('firstName username').lean();
        pNames[pid]=u?.firstName||u?.username||`User${pid}`;}
      return{...g,pNames,winnerName:g.winner===-1?'Draw':g.winner?(pNames[g.winner]||String(g.winner)):'—'};
    }));
    res.json({games:enriched,total,pages:Math.ceil(total/limit)});
  }catch(e){res.status(500).json({error:e.message});}
});

// Agent referrals list (for admin panel)
app.get('/api/admin/agent-referrals',isAdmin,async(req,res)=>{
  try{
    const agents=await User.find({role:'agent'}).select('telegramId firstName username').lean();
    const result=await Promise.all(agents.map(async a=>{
      const referrals=await User.find({referredBy:a.telegramId}).select('telegramId firstName username balance createdAt').lean();
      const depAgg=referrals.length?await Deposit.aggregate([
        {$match:{userId:{$in:referrals.map(r=>r.telegramId)},status:'confirmed'}},
        {$group:{_id:null,total:{$sum:'$amount'}}}
      ]):[];
      return{
        agentId:a.telegramId,
        agentName:a.firstName||a.username||`Agent${a.telegramId}`,
        agentUsername:a.username||'',
        totalReferrals:referrals.length,
        totalDeposited:depAgg[0]?.total||0,
        referrals:referrals.map(u=>({
          telegramId:u.telegramId,
          name:u.firstName||u.username||`User${u.telegramId}`,
          username:u.username||'',
          balance:u.balance||0,
          joinedAt:u.createdAt
        }))
      };
    }));
    res.json(result);
  }catch(e){res.status(500).json({error:e.message});}
});

// Analytics — hourly activity + daily revenue for charts
app.get('/api/admin/analytics',isAdmin,async(req,res)=>{
  try{
    const src=req.isPartner?BOT_SOURCE:(req.query.botSource||null);
    const filter=src?{botSource:src}:{};
    const now=new Date();
    const day7=new Date(now.getTime()-7*24*60*60*1000);
    const day30=new Date(now.getTime()-30*24*60*60*1000);

    // Daily deposits & withdrawals (last 30 days)
    const[depDaily,wdDaily,gameHourly,newUsersDaily]=await Promise.all([
      Deposit.aggregate([
        {$match:{status:'confirmed',createdAt:{$gte:day30},...filter}},
        {$group:{_id:{$dateToString:{format:'%Y-%m-%d',date:'$createdAt'}},total:{$sum:'$amount'},count:{$sum:1}}},
        {$sort:{_id:1}}
      ]),
      Withdrawal.aggregate([
        {$match:{status:'confirmed',createdAt:{$gte:day30},...filter}},
        {$group:{_id:{$dateToString:{format:'%Y-%m-%d',date:'$createdAt'}},total:{$sum:'$amount'},count:{$sum:1}}},
        {$sort:{_id:1}}
      ]),
      // Hourly game count (last 7 days) — peak hour detection
      Game.aggregate([
        {$match:{status:'completed',createdAt:{$gte:day7}}},
        {$group:{_id:{$hour:'$createdAt'},count:{$sum:1}}},
        {$sort:{_id:1}}
      ]),
      // New users per day (last 30 days)
      User.aggregate([
        {$match:{createdAt:{$gte:day30},...filter}},
        {$group:{_id:{$dateToString:{format:'%Y-%m-%d',date:'$createdAt'}},count:{$sum:1}}},
        {$sort:{_id:1}}
      ])
    ]);

    res.json({depDaily,wdDaily,gameHourly,newUsersDaily});
  }catch(e){res.status(500).json({error:e.message});}
});

// Self-ping
setInterval(()=>{try{https.get(`${BACKEND_URL}/health`,()=>{}).on('error',()=>{});}catch{}},5*60*1000);

process.on('unhandledRejection',(reason,promise)=>{console.error('Unhandled Rejection:',promise,'reason:',reason);});
process.on('uncaughtException',(err)=>{console.error('Uncaught Exception:',err);});

const PORT=process.env.PORT||3000;
server.listen(PORT,()=>console.log(`🚀 Bot-2 Server on port ${PORT} (${BOT_USERNAME})`));
