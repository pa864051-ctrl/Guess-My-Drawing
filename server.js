'use strict';
const express = require('express');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_FILE = path.join(DATA_DIR, 'profiles.json');
const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=()');
  next();
});
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.get('/health', (_req, res) => res.json({ ok: true }));
app.get('/api/leaderboard', (_req, res) => {
  const db = loadDb();
  res.json(Object.values(db).sort((a,b) => b.totalPoints-a.totalPoints).slice(0,20).map(publicProfile));
});
app.get('/api/profile/:id', (req, res) => {
  if (!/^[a-f0-9-]{20,50}$/i.test(req.params.id)) return res.status(400).json({ error: 'Invalid profile id' });
  const p = loadDb()[req.params.id];
  if (!p) return res.status(404).json({ error: 'Profile not found' });
  res.json(publicProfile(p));
});
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e5, cors: { origin: process.env.PUBLIC_ORIGIN ? [process.env.PUBLIC_ORIGIN] : true } });

const MAX_PLAYERS = 8, MIN_PLAYERS = 2, GRACE_MS = 90_000;
const ROUND_DEFAULT = 75;
const MODES = ['classic','speed','blind','one-line','teams'];
const PACKS = {
  objects: { easy:['chair','key','umbrella','toothbrush','clock','backpack','candle','ladder'], medium:['telescope','hourglass','compass','sewing machine','typewriter'], hard:['barometer','metronome','kaleidoscope'] },
  animals: { easy:['cat','dog','rabbit','fish','turtle','duck','frog','owl'], medium:['chameleon','flamingo','hedgehog','octopus'], hard:['axolotl','narwhal','pangolin'] },
  food: { easy:['pizza','banana','ice cream','burger','carrot','cake','taco'], medium:['sushi','pretzel','pineapple','pancakes'], hard:['croissant','pomegranate','ratatouille'] },
  blockworld: { easy:['pickaxe','crafting table','torch','creeper','diamond'], medium:['enchantment table','minecart','redstone lamp'], hard:['conduit','observer block','end crystal'] },
  anime: { easy:['ninja','mecha robot','magical wand','school festival'], medium:['spirit fox','training dojo','giant monster'], hard:['celestial dragon','time portal'] },
  games: { easy:['dice','chess knight','game controller','puzzle piece'], medium:['pinball machine','arcade cabinet','joystick'], hard:['strategy map','speedrun timer'] },
  nature: { easy:['tree','flower','mountain','cloud','rainbow','volcano'], medium:['waterfall','cactus','mushroom','coral reef'], hard:['aurora','stalactite','tidal wave'] }
};
const rooms = new Map(), socketPlayer = new Map(), reconnectTokens = new Map(), rateBuckets = new Map();
function loadDb() { try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { return {}; } }
function saveDb(db) { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }
function publicProfile(p) { const {id,nickname,gamesPlayed,wins,totalPoints,correctGuesses,drawingsCompleted,bestScore,longestStreak,achievements}=p; return {id,nickname,gamesPlayed,wins,totalPoints,correctGuesses,drawingsCompleted,bestScore,longestStreak,achievements}; }
function profileFor(id, nickname) {
  const db = loadDb();
  if (!db[id]) db[id] = { id, nickname, gamesPlayed:0,wins:0,totalPoints:0,correctGuesses:0,drawingsCompleted:0,bestScore:0,longestStreak:0,achievements:[] };
  else db[id].nickname = nickname;
  saveDb(db); return db[id];
}
function safeText(v, max=24) { return typeof v === 'string' ? v.replace(/[<>]/g,'').replace(/[\u0000-\u001f\u007f]/g,'').trim().slice(0,max) : ''; }
function fail(socket, message) { socket.emit('notice', { type:'error', message }); }
function rate(socket, key, limit, interval=1000) {
  const id = socket.id + ':' + key, now = Date.now(), arr = (rateBuckets.get(id)||[]).filter(t => now-t < interval);
  arr.push(now); rateBuckets.set(id,arr); return arr.length <= limit;
}
function code() { let s; do { s = crypto.randomBytes(3).toString('hex').toUpperCase(); } while (rooms.has(s)); return s; }
function hashPassword(p, salt) { return crypto.scryptSync(p, salt, 32).toString('hex'); }
function passwordMatches(p, stored) { if (!stored) return true; const [salt, hash] = stored.split(':'); const a=Buffer.from(hashPassword(p||'',salt),'hex'), b=Buffer.from(hash,'hex'); return a.length===b.length && crypto.timingSafeEqual(a,b); }
function roomOf(socket) { const ref=socketPlayer.get(socket.id); return ref && rooms.get(ref.code); }
function playerOf(socket, room=roomOf(socket)) { const ref=socketPlayer.get(socket.id); return room && ref ? room.players.get(ref.pid) : null; }
function cleanPlayer(p) { return { id:p.id, nickname:p.nickname, score:p.score, ready:p.ready, connected:p.connected, host:p.host, muted:p.muted, team:p.team, profileId:p.profileId }; }
function emitRoom(room) {
  io.to(room.code).emit('room-state', {
    code:room.code, hostId:room.hostId, status:room.status, config:room.config,
    players:[...room.players.values()].map(cleanPlayer),
    round:room.round, totalRounds:room.config.rounds, drawerId:room.drawerId,
    deadline:room.deadline, wordLength:room.word ? room.word.length : 0,
    hint:room.hint, mode:room.config.mode, gallery:room.gallery.slice(-12),
    teamScores:room.teamScores, voteCounts:room.voteCounts || {}
  });
}
function privateState(socket, room, p) {
  socket.emit('private-state', { playerId:p.id, token:p.token, profileId:p.profileId, isDrawer:room.drawerId===p.id, word:room.drawerId===p.id ? room.word : null, choices:room.status==='choosing' && room.drawerId===p.id ? room.choices : [], guessed:room.guessed.has(p.id), canvas:room.strokes, hidden:room.config.mode==='blind' && room.drawerId===p.id });
}
function makeRoom(host, config, passwordHash) {
  const c=code();
  const room={ code:c, hostId:host.id, players:new Map(), status:'lobby', config, passwordHash, round:0, drawerId:null, word:null, choices:[], strokes:[], undoStacks:new Map(), guessed:new Set(), deadline:null, timer:null, hint:'', gallery:[], votes:new Map(), voteCounts:{}, teamScores:[0,0], roundScores:new Map(), muted:new Set(), modeVotes:new Map(), createdAt:Date.now(), lobbyTimer:null, roundStartedAt:0, lastGuess:new Map() };
  rooms.set(c,room); return room;
}
function assignSocket(socket, room, p) {
  socket.join(room.code); socketPlayer.set(socket.id,{code:room.code,pid:p.id}); p.socketId=socket.id; p.connected=true; p.disconnectedAt=null;
  privateState(socket,room,p); emitRoom(room);
}
function stopTimer(room) { if (room.timer) clearInterval(room.timer); room.timer=null; }
function startLobbyCountdown(room) {
  if (room.lobbyTimer || room.status!=='lobby') return;
  room.lobbyTimer=setTimeout(()=>{ room.lobbyTimer=null; if (room.status==='lobby' && room.players.size>=MIN_PLAYERS && [...room.players.values()].filter(p=>p.connected && p.ready).length>=MIN_PLAYERS) startGame(room); },5000);
  io.to(room.code).emit('notice',{type:'info',message:'Enough players are ready. Game starts in 5 seconds!'});
}
function pickChoices(room) {
  const selected=room.config.packs.flatMap(pack=>Object.entries(PACKS[pack]||{}).flatMap(([difficulty,words])=>words.map(word=>({word,difficulty,pack}))));
  const unique=[...new Map(selected.map(x=>[x.word.toLowerCase(),x])).values()];
  for (let i=unique.length-1;i>0;i--) { const j=crypto.randomInt(i+1); [unique[i],unique[j]]=[unique[j],unique[i]]; }
  return unique.slice(0,3);
}
function startGame(room) {
  if (room.players.size<MIN_PLAYERS) return;
  if (room.lobbyTimer) clearTimeout(room.lobbyTimer); room.lobbyTimer=null;
  room.status='playing'; room.round=0; room.gallery=[]; room.players.forEach(p=>{p.score=0;p.ready=false;p.team=null;});
  if (room.config.mode==='teams') { let i=0; for (const p of room.players.values()) p.team=(i++%2)+1; }
  startRound(room);
}
function startRound(room) {
  stopTimer(room);
  const players=[...room.players.values()].filter(p=>p.connected);
  if (players.length<MIN_PLAYERS) { room.status='lobby'; emitRoom(room); return; }
  room.round++;
  if (room.round>room.config.rounds) { finishGame(room); return; }
  room.drawerId=players[(room.round-1)%players.length].id;
  room.status='choosing'; room.word=null; room.choices=pickChoices(room); room.strokes=[]; room.undoStacks=new Map(); room.guessed=new Set([room.drawerId]); room.hint=''; room.deadline=Date.now()+20000; room.roundStartedAt=Date.now(); room.roundScores=new Map(); room.votes=new Map();
  io.to(room.code).emit('round-start',{round:room.round,total:room.config.rounds,drawerId:room.drawerId,chooseSeconds:20,mode:room.config.mode});
  for (const p of room.players.values()) if (p.socketId) { const s=io.sockets.sockets.get(p.socketId); if(s) privateState(s,room,p); }
  emitRoom(room);
  room.timer=setInterval(()=>{
    if (room.status==='choosing' && Date.now()>=room.deadline) {
      const choices=room.choices; if (!choices.length) return;
      chooseWord(room, room.drawerId, choices[0].word);
    } else if (room.status==='drawing') {
      const left=Math.max(0,Math.ceil((room.deadline-Date.now())/1000));
      if (left===Math.floor(room.config.duration*0.66) || left===Math.floor(room.config.duration*0.33)) revealHint(room);
      io.to(room.code).emit('tick',{left, hint:room.hint});
      if (left<=0) endRound(room,'time');
    }
  },1000);
}
function chooseWord(room, pid, word) {
  if(room.status!=='choosing'||room.drawerId!==pid||!room.choices.some(c=>c.word===word)) return false;
  room.word=word; room.status='drawing'; room.deadline=Date.now()+room.config.duration*1000; room.roundStartedAt=Date.now(); room.hint=word.replace(/[a-z]/gi,'_').split('').join(' ');
  io.to(room.code).emit('word-chosen',{drawerId:pid,wordLength:word.length,deadline:room.deadline});
  for(const p of room.players.values()) if(p.socketId){const s=io.sockets.sockets.get(p.socketId);if(s)privateState(s,room,p);}
  emitRoom(room); return true;
}
function revealHint(room) {
  if(!room.word) return;
  const chars=room.word.split(''), positions=chars.map((c,i)=>/[a-z]/i.test(c)?i:-1).filter(i=>i>=0);
  const revealCount=Math.min(positions.length-1, Math.floor((room.config.duration*1000-(room.deadline-Date.now()))/(room.config.duration*1000/3)));
  for(let i=0;i<revealCount;i++) chars[positions[i]] = room.word[positions[i]];
  room.hint=chars.map((c,i)=>/[a-z]/i.test(c)&&!positions.slice(0,revealCount).includes(i)?'_':c).join(' ');
  io.to(room.code).emit('hint',{hint:room.hint});
}
function endRound(room, reason) {
  if(!['drawing','choosing'].includes(room.status)) return;
  stopTimer(room); room.status='gallery'; room.deadline=null;
  if(!room.word) room.word=room.choices[0]?.word||'unknown';
  const drawer=room.players.get(room.drawerId);
  if(drawer) { const db=loadDb(); const prof=db[drawer.profileId]; if(prof) prof.drawingsCompleted++; saveDb(db); }
  const item={id:crypto.randomUUID(),round:room.round,drawerId:room.drawerId,drawerName:drawer?.nickname||'Player',word:room.word,strokes:room.strokes.slice(),reason, votes:0};
  room.gallery.push(item);
  io.to(room.code).emit('round-ended',{answer:room.word,drawerId:room.drawerId,drawerName:item.drawerName,reason,strokes:item.strokes,round:room.round,points:Object.fromEntries(room.roundScores),galleryId:item.id});
  emitRoom(room);
  setTimeout(()=>{ if(room.status==='gallery') startRound(room); },9000);
}
function finishGame(room) {
  stopTimer(room); room.status='finished'; room.drawerId=null;
  const players=[...room.players.values()].sort((a,b)=>b.score-a.score);
  if(players[0]) {
    const db=loadDb();
    for(const p of players) { const prof=db[p.profileId]; if(!prof) continue; prof.gamesPlayed++; prof.totalPoints+=p.score; prof.bestScore=Math.max(prof.bestScore,p.score); if(p===players[0]) prof.wins++; }
    saveDb(db);
  }
  io.to(room.code).emit('game-finished',{rankings:players.map((p,i)=>({...cleanPlayer(p),rank:i+1})),gallery:room.gallery});
  emitRoom(room);
}
function leavePlayer(socket, explicit=false) {
  const ref=socketPlayer.get(socket.id); if(!ref)return;
  const room=rooms.get(ref.code), p=room?.players.get(ref.pid); socketPlayer.delete(socket.id);
  if(!room||!p)return;
  p.connected=false; p.disconnectedAt=Date.now(); p.socketId=null;
  socket.leave(room.code);
  if(room.hostId===p.id) {
    const next=[...room.players.values()].find(x=>x.connected);
    if(next){room.hostId=next.id;next.host=true;io.to(room.code).emit('notice',{type:'info',message:`${next.nickname} is now host.`});}
  }
  if(room.drawerId===p.id && ['choosing','drawing'].includes(room.status)) endRound(room,'drawer-disconnected');
  emitRoom(room);
  setTimeout(()=>{ if(!p.connected && p.disconnectedAt && Date.now()-p.disconnectedAt>=GRACE_MS){room.players.delete(p.id);reconnectTokens.delete(p.token); if(room.players.size===0){stopTimer(room);if(room.lobbyTimer)clearTimeout(room.lobbyTimer);rooms.delete(room.code);} else {if(room.hostId===p.id){const n=room.players.values().next().value;if(n){room.hostId=n.id;n.host=true;}}emitRoom(room);} } },GRACE_MS+100);
}
io.on('connection', socket=>{
  socket.emit('connected',{id:socket.id});
  socket.on('create-room',(payload={})=>{
    if(!rate(socket,'create',3,10000))return fail(socket,'Please wait before creating another room.');
    const nickname=safeText(payload.nickname,20); if(nickname.length<2)return fail(socket,'Nickname must be 2–20 characters.');
    const packs=Array.isArray(payload.packs)?payload.packs.filter(p=>PACKS[p]):['objects','animals','food'];
    const mode=MODES.includes(payload.mode)?payload.mode:'classic';
    const config={rounds:Math.max(2,Math.min(12,Number(payload.rounds)||5)),duration:Math.max(30,Math.min(120,Number(payload.duration)||ROUND_DEFAULT)),mode,packs:packs.length?packs:['objects','animals']};
    const isPrivate=!!payload.private, password=safeText(payload.password,64);
    if(isPrivate && password.length<4)return fail(socket,'Private room passwords must be at least 4 characters.');
    const p={id:crypto.randomUUID(),nickname,score:0,ready:false,connected:true,host:true,muted:false,team:null,profileId:crypto.randomUUID(),token:crypto.randomBytes(32).toString('hex'),socketId:socket.id};
    profileFor(p.profileId,nickname); reconnectTokens.set(p.token,{code:null,pid:p.id});
    const room=makeRoom(p,config,isPrivate?crypto.randomBytes(16).toString('hex')+':'+hashPassword(password,crypto.randomBytes(16).toString('hex')):null);
    // Store a correctly paired salt/hash; password material never leaves server.
    if(isPrivate){const salt=crypto.randomBytes(16).toString('hex');room.passwordHash=salt+':'+hashPassword(password,salt);}
    room.players.set(p.id,p); reconnectTokens.get(p.token).code=room.code;
    assignSocket(socket,room,p); socket.emit('room-created',{code:room.code,invite:`${publicBase(socket.request)}?room=${room.code}`,token:p.token});
  });
  socket.on('join-room',(payload={})=>{
    if(!rate(socket,'join',6,10000))return fail(socket,'Too many join attempts. Try again shortly.');
    const c=safeText(payload.code,10).toUpperCase(), room=rooms.get(c), nickname=safeText(payload.nickname,20);
    if(!room)return fail(socket,'Room code not found.');
    if(nickname.length<2)return fail(socket,'Nickname must be 2–20 characters.');
    if(room.players.size>=MAX_PLAYERS)return fail(socket,'This room is full (8 players maximum).');
    if(room.passwordHash&&!passwordMatches(safeText(payload.password,64),room.passwordHash))return fail(socket,'Incorrect room password.');
    if(room.status==='playing'||room.status==='choosing'||room.status==='drawing'||room.status==='gallery')return fail(socket,'This game has already started.');
    const p={id:crypto.randomUUID(),nickname,score:0,ready:false,connected:true,host:false,muted:false,team:null,profileId:crypto.randomUUID(),token:crypto.randomBytes(32).toString('hex'),socketId:socket.id};
    profileFor(p.profileId,nickname); reconnectTokens.set(p.token,{code:room.code,pid:p.id}); room.players.set(p.id,p);
    assignSocket(socket,room,p); socket.emit('joined-room',{code:room.code,invite:`${publicBase(socket.request)}?room=${room.code}`,token:p.token});
  });
  socket.on('rejoin-room',(payload={})=>{
    const token=typeof payload.token==='string'?payload.token:''; const ref=reconnectTokens.get(token); if(!ref)return fail(socket,'Rejoin token is invalid or expired.');
    const room=rooms.get(ref.code),p=room?.players.get(ref.pid); if(!p||p.connected||Date.now()-(p.disconnectedAt||0)>GRACE_MS)return fail(socket,'Your reconnect window has expired.');
    assignSocket(socket,room,p); socket.emit('rejoined',{code:room.code,token:p.token}); emitRoom(room);
  });
  socket.on('ready',()=>{
    const room=roomOf(socket),p=playerOf(socket,room); if(!room||!p||room.status!=='lobby')return;
    p.ready=!p.ready; emitRoom(room);
    if([...room.players.values()].filter(x=>x.connected&&x.ready).length>=MIN_PLAYERS)startLobbyCountdown(room);
    else if(room.lobbyTimer){clearTimeout(room.lobbyTimer);room.lobbyTimer=null;}
  });
  socket.on('host-config',(payload={})=>{
    const room=roomOf(socket),p=playerOf(socket,room); if(!room||!p||room.hostId!==p.id||room.status!=='lobby')return fail(socket,'Only the host can configure the lobby.');
    const cfg=room.config;
    if(payload.rounds!==undefined)cfg.rounds=Math.max(2,Math.min(12,Number(payload.rounds)||5));
    if(payload.duration!==undefined)cfg.duration=Math.max(30,Math.min(120,Number(payload.duration)||75));
    if(payload.mode!==undefined&&MODES.includes(payload.mode))cfg.mode=payload.mode;
    if(Array.isArray(payload.packs)){const packs=payload.packs.filter(x=>PACKS[x]);if(packs.length)cfg.packs=packs;}
    emitRoom(room);
  });
  socket.on('start-game',()=>{
    const room=roomOf(socket),p=playerOf(socket,room); if(!room||!p||room.hostId!==p.id)return fail(socket,'Only the host can start the game.');
    if(room.players.size<MIN_PLAYERS)return fail(socket,'At least 2 players are needed.');
    if(room.status!=='lobby'&&room.status!=='finished')return fail(socket,'A game is already in progress.');
    startGame(room);
  });
  socket.on('choose-word',payload=>{
    const room=roomOf(socket),p=playerOf(socket,room); if(!room||!p||typeof payload?.word!=='string')return;
    if(!chooseWord(room,p.id,payload.word))fail(socket,'That word choice is no longer available.');
  });
  socket.on('draw',payload=>{
    const room=roomOf(socket),p=playerOf(socket,room); if(!room||!p||room.status!=='drawing'||room.drawerId!==p.id||!rate(socket,'draw',100,1000))return;
    if(!payload||!['stroke','clear','undo','redo'].includes(payload.type))return;
    if(payload.type==='stroke'){
      const s=payload.stroke;
      if(!s||!Array.isArray(s.points)||s.points.length>120||s.points.some(pt=>!Number.isFinite(pt.x)||!Number.isFinite(pt.y)||pt.x<0||pt.x>1||pt.y<0||pt.y>1))return;
      if(room.config.mode==='one-line'&&room.strokes.length>0)return;
      const stroke={tool:['pencil','eraser','line','rect','circle','fill'].includes(s.tool)?s.tool:'pencil',color:/^#[0-9a-f]{6}$/i.test(s.color)?s.color:'#172033',size:Math.max(1,Math.min(40,Number(s.size)||4)),points:s.points.map(pt=>({x:pt.x,y:pt.y})),bg:/^#[0-9a-f]{6}$/i.test(s.bg)?s.bg:null};
      room.strokes.push(stroke); if(room.strokes.length>600)return;
      io.to(room.code).emit('draw-update',{type:'stroke',stroke});
    } else if(payload.type==='clear'){room.strokes=[];io.to(room.code).emit('draw-update',{type:'clear'});}
    else if(payload.type==='undo'){room.strokes.pop();io.to(room.code).emit('draw-update',{type:'restore',strokes:room.strokes});}
    else if(payload.type==='redo'&&Array.isArray(payload.strokes)&&payload.strokes.length<=600){room.strokes=payload.strokes;io.to(room.code).emit('draw-update',{type:'restore',strokes:room.strokes});}
  });
  socket.on('guess',payload=>{
    const room=roomOf(socket),p=playerOf(socket,room); if(!room||!p||room.status!=='drawing'||!rate(socket,'guess',1,900)||p.muted)return;
    const guess=safeText(payload?.text,80);if(guess.length<1)return;
    if(room.guessed.has(p.id)){socket.emit('chat-message',{nickname:'System',text:'You already guessed correctly this round.',system:true});return;}
    if(room.lastGuess.has(p.id)&&Date.now()-room.lastGuess.get(p.id)<650)return;room.lastGuess.set(p.id,Date.now());
    if(guess.toLowerCase().replace(/[^a-z0-9]/g,'')===room.word.toLowerCase().replace(/[^a-z0-9]/g,'')){
      room.guessed.add(p.id);
      const remaining=Math.max(0,(room.deadline-Date.now())/1000);
      const points=Math.max(50,Math.round(100+150*remaining/room.config.duration));
      p.score+=points;room.roundScores.set(p.id,(room.roundScores.get(p.id)||0)+points);
      const drawer=room.players.get(room.drawerId);if(drawer){drawer.score+=Math.round(points*.35);room.roundScores.set(drawer.id,(room.roundScores.get(drawer.id)||0)+Math.round(points*.35));}
      const db=loadDb(),prof=db[p.profileId];if(prof){prof.correctGuesses++;saveDb(db);}
      socket.emit('chat-message',{nickname:'System',text:`Correct! +${points} points`,system:true});
      io.to(room.code).emit('correct-guess',{playerId:p.id,nickname:p.nickname,points,drawerBonus:Math.round(points*.35),scores:[...room.players.values()].map(x=>({id:x.id,score:x.score}))});
      if([...room.players.values()].filter(x=>x.id!==room.drawerId&&x.connected).every(x=>room.guessed.has(x.id)))endRound(room,'all-guessed');
    } else {
      io.to(room.code).emit('chat-message',{nickname:p.nickname,text:guess,system:false});
    }
    emitRoom(room);
  });
  socket.on('chat',payload=>{
    const room=roomOf(socket),p=playerOf(socket,room);if(!room||!p||p.muted||!rate(socket,'chat',4,5000))return fail(socket,'Chat cooldown: please slow down.');
    const text=safeText(payload?.text,180);if(!text)return;
    io.to(room.code).emit('chat-message',{nickname:p.nickname,text,system:false});
  });
  socket.on('reaction',payload=>{
    const room=roomOf(socket),p=playerOf(socket,room);const emoji=String(payload?.emoji||'');
    if(!room||!p||!['😂','❤️','👏','😮','🔥','😭','🤔','🎉'].includes(emoji)||!rate(socket,'reaction',2,1500))return;
    io.to(room.code).emit('reaction',{playerId:p.id,nickname:p.nickname,emoji});
  });
  socket.on('vote-drawing',payload=>{
    const room=roomOf(socket),p=playerOf(socket,room);if(!room||!p||room.status!=='gallery')return;
    const item=room.gallery.find(x=>x.id===payload?.galleryId);if(!item||item.drawerId===p.id||room.votes.has(p.id))return fail(socket,'You cannot vote for your own drawing or vote twice.');
    room.votes.set(p.id,item.id);item.votes++;room.voteCounts[item.id]=item.votes;
    io.to(room.code).emit('vote-update',{galleryId:item.id,votes:item.votes});emitRoom(room);
  });
  socket.on('host-moderate',payload=>{
    const room=roomOf(socket),p=playerOf(socket,room);if(!room||!p||room.hostId!==p.id)return fail(socket,'Host permission required.');
    const target=room.players.get(payload?.playerId);if(!target||target.id===p.id)return;
    if(payload.action==='mute'){target.muted=true;io.to(room.code).emit('notice',{type:'info',message:`${target.nickname} was muted by the host.`});}
    else if(payload.action==='unmute'){target.muted=false;}
    else if(payload.action==='remove'){const s=io.sockets.sockets.get(target.socketId);if(s){fail(s,'You were removed by the host.');s.disconnect(true);}room.players.delete(target.id);reconnectTokens.delete(target.token);}
    emitRoom(room);
  });
  socket.on('report-player',payload=>{
    const room=roomOf(socket),p=playerOf(socket,room),target=room?.players.get(payload?.playerId);
    if(!room||!p||!target||p.id===target.id||!rate(socket,'report',2,60000))return;
    io.to(room.code).emit('notice',{type:'info',message:`A report about ${target.nickname} was submitted to the room host.`});
    const host=room.players.get(room.hostId);if(host?.socketId)io.to(host.socketId).emit('report',{reporter:p.nickname,target:target.nickname,reason:safeText(payload?.reason,120)});
  });
  socket.on('mode-vote',payload=>{
    const room=roomOf(socket),p=playerOf(socket,room);if(!room||!p||!MODES.includes(payload?.mode))return;
    room.modeVotes.set(p.id,payload.mode);io.to(room.code).emit('notice',{type:'info',message:`${p.nickname} voted for ${payload.mode}.`});
    if(room.modeVotes.size>=room.players.size){const counts={};for(const m of room.modeVotes.values())counts[m]=(counts[m]||0)+1;const max=Math.max(...Object.values(counts));const tied=Object.keys(counts).filter(m=>counts[m]===max);room.config.mode=tied[crypto.randomInt(tied.length)];room.modeVotes.clear();io.to(room.code).emit('notice',{type:'info',message:`Next mode: ${room.config.mode}.`});emitRoom(room);}
  });
  socket.on('profile',payload=>{
    const room=roomOf(socket);if(!room)return;const p=room.players.get(payload?.playerId);if(!p)return;
    const db=loadDb();socket.emit('profile-result',publicProfile(db[p.profileId]||profileFor(p.profileId,p.nickname)));
  });
  socket.on('disconnect',()=>{leavePlayer(socket);rateBuckets.forEach((_,k)=>{if(k.startsWith(socket.id+':'))rateBuckets.delete(k);});});
});
function publicBase(req) { const proto=(req.headers['x-forwarded-proto']||'http').split(',')[0];const host=(req.headers['x-forwarded-host']||req.headers.host||`localhost:${PORT}`).split(',')[0];return `${proto}://${host}`; }
setInterval(()=>{ for(const [c,r] of rooms){ if(r.players.size===0||Date.now()-r.createdAt>24*60*60*1000&&r.status==='lobby'){stopTimer(r);if(r.lobbyTimer)clearTimeout(r.lobbyTimer);rooms.delete(c);} } },60_000).unref();
if (require.main === module) {
  server.listen(PORT, () => console.log(`Guess My Drawing running on port ${PORT}`));
}
module.exports = { safeText, passwordMatches, pickChoices, PACKS, MODES };
