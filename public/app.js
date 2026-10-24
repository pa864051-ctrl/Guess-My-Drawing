(() => {
'use strict';
const $=id=>document.getElementById(id), socket=io();
const screens=['home','lobby','game','gallery','results','profile'];
let state={room:null,me:null,token:localStorage.getItem('gmd-token'),profileId:localStorage.getItem('gmd-profile'),invite:'',isDrawer:false,secret:null,choices:[],canDraw:false,roundData:null,strokes:[],redo:[],grid:false,painting:false,currentStroke:null,preview:null,activeGallery:null,mode:'classic',myVote:null,roundPoints:{},lastRound:null,oneLineUsed:false};
const canvas=$('board'),ctx=canvas.getContext('2d'),gcanvas=$('galleryCanvas'),gctx=gcanvas.getContext('2d');
function show(name){screens.forEach(s=>$(s).classList.toggle('active',s===name));window.scrollTo({top:0,behavior:'smooth'});}
function toast(msg){const el=$('toast');el.textContent=msg;el.classList.add('show');clearTimeout(toast.t);toast.t=setTimeout(()=>el.classList.remove('show'),3200);}
function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function me(){return state.room?.players?.find(p=>p.id===state.me)||null;}
function host(){return state.room?.hostId===state.me;}
function packSelection(){return [...document.querySelectorAll('.packs input:checked')].map(x=>x.value);}
function call(event,payload){if(!socket.connected)return toast('You are offline. Reconnecting…');socket.emit(event,payload);}
function refreshBoard(){fetch('/api/leaderboard').then(r=>r.json()).then(rows=>{$('leaderboard').innerHTML=rows.length?rows.map((p,i)=>`<div class="leader-item"><span class="rank">#${i+1}</span><span class="avatar">${escapeHtml((p.nickname||'?')[0].toUpperCase())}</span><span class="leader-name">${escapeHtml(p.nickname)}</span><span class="leader-score">${p.totalPoints} pts</span></div>`).join(''):'<span class="muted">No legends yet. Go make history.</span>';}).catch(()=>{$('leaderboard').textContent='Leaderboard unavailable.';});}
function updateJoinFromUrl(){const code=new URLSearchParams(location.search).get('room');if(code){$('joinCode').value=code.toUpperCase();$('joinPasswordWrap').classList.remove('hidden');}}
$('privateRoom').addEventListener('change',()=>{$('roomPassword').classList.toggle('hidden',!$('privateRoom').checked);});
$('createBtn').onclick=()=>{const nickname=$('createName').value.trim();call('create-room',{nickname,rounds:+$('rounds').value,duration:+$('duration').value,mode:$('mode').value,packs:packSelection(),private:$('privateRoom').checked,password:$('roomPassword').value});};
$('joinBtn').onclick=()=>call('join-room',{nickname:$('joinName').value.trim(),code:$('joinCode').value.trim().toUpperCase(),password:$('joinPassword').value});
$('joinCode').addEventListener('input',()=>{$('joinPasswordWrap').classList.toggle('hidden',!$('joinCode').value.trim());});
$('readyBtn').onclick=()=>call('ready');
$('startBtn').onclick=()=>call('start-game');
$('leaveLobby').onclick=$('leaveGame').onclick=()=>{socket.disconnect();socket.connect();state.room=null;state.me=null;show('home');};
$('copyInvite').onclick=async()=>{try{await navigator.clipboard.writeText(state.invite||`${location.origin}?room=${state.room.code}`);toast('Invite link copied! Send it to your crew.');}catch{prompt('Copy this invite link:',state.invite);}};
$('voteMode').onclick=()=>call('mode-vote',{mode:$('modeVote').value});
$('refreshBoard').onclick=refreshBoard;
$('profileBtn').onclick=showProfile;$('closeProfile').onclick=()=>show(state.room?'lobby':'home');
$('backHome').onclick=()=>{state.room=null;state.me=null;show('home');refreshBoard();};
$('playAgain').onclick=()=>{show('lobby');if(host())call('start-game');};
$('tool').onchange=()=>{};$('color').oninput=()=>{};$('gridBtn').onclick=()=>{state.grid=!state.grid;$('canvasWrap').classList.toggle('grid',state.grid);};
document.querySelectorAll('.swatches button').forEach(b=>b.onclick=()=>{$('color').value=b.dataset.color;});
$('undo').onclick=()=>{if(!state.canDraw||!state.strokes.length)return;state.redo.push(state.strokes.pop());call('draw',{type:'undo'});renderCanvas();};
$('redo').onclick=()=>{if(!state.canDraw||!state.redo.length)return;const s=state.redo.pop();state.strokes.push(s);call('draw',{type:'redo',strokes:state.strokes});renderCanvas();};
$('clear').onclick=()=>{if(!state.canDraw)return;state.strokes=[];state.redo=[];call('draw',{type:'clear'});renderCanvas();};
$('downloadCanvas').onclick=()=>download(canvas,'guess-my-drawing.png');
$('downloadGallery').onclick=()=>download(gcanvas,'guess-my-drawing-masterpiece.png');
$('voteDrawing').onclick=()=>{if(!state.activeGallery)return;call('vote-drawing',{galleryId:state.activeGallery});state.myVote=state.activeGallery;$('voteDrawing').disabled=true;$('voteDrawing').textContent='✓ Vote submitted';};
$('chatForm').onsubmit=e=>{e.preventDefault();const text=$('chatInput').value.trim();if(!text)return;call(state.room?.status==='drawing'&&!state.isDrawer?'guess':'chat',{text});$('chatInput').value='';};
document.querySelectorAll('[data-emoji]').forEach(b=>b.onclick=()=>call('reaction',{emoji:b.dataset.emoji}));
function download(c,name){const a=document.createElement('a');a.download=name;a.href=c.toDataURL('image/png');a.click();}
function showProfile(){show('profile');if(!state.profileId){$('profileContent').textContent='Play a game to start building your profile.';return;}fetch('/api/profile/'+state.profileId).then(r=>r.json()).then(p=>{$('profileContent').innerHTML=`<div class="section-head"><h2>${escapeHtml(p.nickname||'Player')}</h2><span class="pill">DOODLE PROFILE</span></div><div class="profile-stats">${[['Games played',p.gamesPlayed],['Wins',p.wins],['Total points',p.totalPoints],['Correct guesses',p.correctGuesses],['Drawings completed',p.drawingsCompleted],['Best score',p.bestScore]].map(x=>`<div class="stat-card"><strong>${x[1]||0}</strong><span>${x[0]}</span></div>`).join('')}</div>`;}).catch(()=>{$('profileContent').textContent='Profile unavailable.';});}
function renderRoom(){
 const r=state.room;if(!r)return;
 $('roomCodeDisplay').textContent=r.code;$('playerCount').textContent=`${r.players.length}/8`;
 $('playerList').innerHTML=r.players.map(p=>`<div class="player-row"><span class="avatar">${escapeHtml(p.nickname[0].toUpperCase())}</span><div><div class="name">${escapeHtml(p.nickname)} ${p.id===r.hostId?'👑':''}</div><div class="sub">${p.connected?'Connected':'Reconnecting…'} ${p.team?`· Team ${p.team}`:''}</div></div><span class="status">${p.ready?'READY ✓':(p.id===r.hostId?'HOST':'WAITING')}</span>${host()&&p.id!==state.me?`<button class="ghost moderate" data-mute="${p.id}">${p.muted?'Unmute':'Mute'}</button><button class="ghost moderate" data-remove="${p.id}">Kick</button>`:''}<button class="ghost moderate" data-report="${p.id}">Report</button></div>`).join('');
 document.querySelectorAll('[data-mute]').forEach(b=>b.onclick=()=>call('host-moderate',{action:state.room.players.find(p=>p.id===b.dataset.mute)?.muted?'unmute':'mute',playerId:b.dataset.mute}));
 document.querySelectorAll('[data-remove]').forEach(b=>b.onclick=()=>{if(confirm('Remove this player?'))call('host-moderate',{action:'remove',playerId:b.dataset.remove});});
 document.querySelectorAll('[data-report]').forEach(b=>b.onclick=()=>{const reason=prompt('Why are you reporting this player?')||'';call('report-player',{playerId:b.dataset.report,reason});toast('Report sent to the host.');});
 $('readyBtn').textContent=me()?.ready?'Not ready ↩':"I'm ready ✓";
 $('startBtn').classList.toggle('hidden',!host());$('readyBtn').classList.toggle('hidden',r.status!=='lobby');
 $('lobbySettings').innerHTML=[['Mode',r.config.mode],['Rounds',r.config.rounds],['Round time',`${r.config.duration} seconds`],['Word packs',r.config.packs.join(', ')],['Scoring','Fast guesses: 100–250 pts · drawer: 35% bonus']].map(x=>`<div class="lobby-settings-row"><span>${escapeHtml(x[0])}</span><b>${escapeHtml(x[1])}</b></div>`).join('');
 $('startBtn').textContent=r.status==='finished'?'Play another game →':'Start game →';
 $('modeBadge').textContent=(r.config.mode||'classic').toUpperCase().replace('-',' ');
 $('scoreList').innerHTML=[...r.players].sort((a,b)=>b.score-a.score).map(p=>`<div class="score-row"><span class="mini-avatar">${escapeHtml(p.nickname[0].toUpperCase())}</span><span>${escapeHtml(p.nickname)}${p.id===r.drawerId?' ✎':''}</span><span class="score">${p.score}</span></div>`).join('');
}
function enterRoom(data){state.me=data.playerId;state.token=data.token;state.profileId=data.profileId;state.invite=data.invite||`${location.origin}?room=${data.code}`;localStorage.setItem('gmd-token',state.token);localStorage.setItem('gmd-profile',state.profileId);history.replaceState({},'',`?room=${data.code}`);show('lobby');toast(`You're in! Room code: ${data.code}`);}
socket.on('connect',()=>{$('connection').textContent='● Connected';$('connection').className='connection online';if(state.token&&!state.room)call('rejoin-room',{token:state.token});});
socket.on('disconnect',()=>{$('connection').textContent='● Reconnecting';$('connection').className='connection offline';});
socket.on('connect_error',()=>toast('Connection trouble. Check your network and try again.'));
socket.on('room-created',enterRoom);socket.on('joined-room',enterRoom);socket.on('rejoined',d=>{toast('Reconnected to your room!');});
socket.on('private-state',d=>{state.me=d.playerId;state.token=d.token;state.profileId=d.profileId;state.isDrawer=d.isDrawer;state.secret=d.word;state.choices=d.choices||[];state.canDraw=d.isDrawer&&state.room?.status==='drawing';state.strokes=d.canvas||state.strokes;state.oneLineUsed=false;if(d.hidden&&d.isDrawer)$('blindOverlay').classList.remove('hidden');else $('blindOverlay').classList.add('hidden');renderCanvas();renderChoices();});
socket.on('room-state',r=>{state.room=r;state.mode=r.config.mode;renderRoom();if(['choosing','drawing'].includes(r.status)){show('game');$('roundLabel').textContent=`ROUND ${r.round} / ${r.totalRounds}`;}else if(r.status==='lobby')show('lobby');else if(r.status==='finished')show('results');});
socket.on('notice',d=>toast(d.message));
socket.on('round-start',d=>{state.roundData=d;state.strokes=[];state.redo=[];state.myVote=null;$('voteDrawing').disabled=false;$('voteDrawing').textContent='🏆 Vote for this drawing';$('roundLabel').textContent=`ROUND ${d.round} / ${d.total}`;$('chatLog').innerHTML='';$('timer').textContent=d.chooseSeconds;$('gameStatus').textContent='Choosing a secret word…';show('game');renderCanvas();});
function renderChoices(){const list=$('choicesList');list.innerHTML=state.choices.map(c=>`<button class="word-choice" data-word="${escapeHtml(c.word)}">${escapeHtml(c.word)} <small>· ${escapeHtml(c.difficulty)}</small></button>`).join('');list.querySelectorAll('button').forEach(b=>b.onclick=()=>call('choose-word',{word:b.dataset.word}));$('wordChoices').classList.toggle('hidden',!(state.room?.status==='choosing'&&state.isDrawer&&state.choices.length));}
socket.on('word-chosen',d=>{$('wordChoices').classList.add('hidden');$('gameStatus').textContent=d.drawerId===state.me?'You are drawing!':'Guess the word!';$('drawerWord').textContent=d.drawerId===state.me?`✎ ${state.secret||'Your secret word'}`:'_ _ _ _ _';$('canvasTip').textContent=d.drawerId===state.me?'Draw only what you see in your secret word.':'Type guesses in chat. Faster guesses earn more!';});
socket.on('tick',d=>{$('timer').textContent=d.left;$('drawerWord').textContent=state.isDrawer?`✎ ${state.secret||'Your word'}`:(d.hint||'Guess the drawing');if(d.left<=10)$('timer').style.color='#ef476f';else $('timer').style.color='';});
socket.on('hint',d=>{if(!state.isDrawer)$('drawerWord').textContent=d.hint;});
socket.on('draw-update',d=>{if(d.type==='stroke')state.strokes.push(d.stroke);else if(d.type==='clear')state.strokes=[];else if(d.type==='restore')state.strokes=d.strokes||[];renderCanvas();});
socket.on('correct-guess',d=>{addChat('System',`${d.nickname} guessed correctly! +${d.points} points 🎉`,true);});
socket.on('chat-message',d=>addChat(d.nickname,d.text,d.system));
socket.on('reaction',d=>{const el=document.createElement('div');el.className='floating-reaction';el.textContent=`${d.emoji} ${d.nickname}`;el.style.cssText='position:fixed;right:18px;top:22%;z-index:20;background:#fff;padding:10px 14px;border-radius:20px;box-shadow:0 4px 20px #0001;font-size:13px';document.body.appendChild(el);setTimeout(()=>el.remove(),1800);});
function addChat(name,text,system=false){const el=document.createElement('div');el.className='chat-line'+(system?' system':'');const b=document.createElement('b');b.textContent=name;const span=document.createElement('span');span.textContent=text;el.append(b,span);$('chatLog').appendChild(el);$('chatLog').scrollTop=$('chatLog').scrollHeight;}
function drawStroke(c,s){if(!s?.points?.length)return;if(s.bg){c.fillStyle=s.bg;c.fillRect(0,0,c.canvas.width,c.canvas.height);return;}const pts=s.points.map(p=>({x:p.x*c.canvas.width,y:p.y*c.canvas.height}));c.save();c.lineWidth=s.size;c.lineCap='round';c.lineJoin='round';c.strokeStyle=s.tool==='eraser'?'#ffffff':s.color;c.fillStyle=s.color;if(s.tool==='fill'){c.fillStyle=s.color;c.fillRect(0,0,c.canvas.width,c.canvas.height);}else if(s.tool==='line'||s.tool==='rect'||s.tool==='circle'){const a=pts[0],b=pts[pts.length-1];c.beginPath();if(s.tool==='line'){c.moveTo(a.x,a.y);c.lineTo(b.x,b.y);}if(s.tool==='rect')c.rect(a.x,a.y,b.x-a.x,b.y-a.y);if(s.tool==='circle'){const dx=b.x-a.x,dy=b.y-a.y;c.ellipse(a.x,a.y,Math.abs(dx),Math.abs(dy),0,0,Math.PI*2);}c.stroke();}else{c.beginPath();c.moveTo(pts[0].x,pts[0].y);for(let i=1;i<pts.length;i++)c.lineTo(pts[i].x,pts[i].y);if(pts.length===1)c.lineTo(pts[0].x+.1,pts[0].y+.1);c.stroke();}c.restore();}
function renderCanvas(){ctx.clearRect(0,0,canvas.width,canvas.height);ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);state.strokes.forEach(s=>drawStroke(ctx,s));if(state.preview)drawStroke(ctx,state.preview);}
function pos(e){const r=canvas.getBoundingClientRect();return{x:Math.max(0,Math.min(1,(e.clientX-r.left)/r.width)),y:Math.max(0,Math.min(1,(e.clientY-r.top)/r.height))};}
canvas.addEventListener('pointerdown',e=>{if(!state.canDraw||state.room?.status!=='drawing')return;if(state.mode==='one-line'&&state.oneLineUsed)return;canvas.setPointerCapture(e.pointerId);state.painting=true;const p=pos(e);state.currentStroke={tool:$('tool').value,color:$('color').value,size:+$('brushSize').value,points:[p]};state.preview=state.currentStroke;});
canvas.addEventListener('pointermove',e=>{if(!state.painting||!state.currentStroke)return;state.currentStroke.points.push(pos(e));if(state.currentStroke.points.length>120)state.currentStroke.points=state.currentStroke.points.filter((_,i)=>i%2===0);renderCanvas();});
canvas.addEventListener('pointerup',()=>{if(!state.painting||!state.currentStroke)return;state.painting=false;const s=state.currentStroke;state.currentStroke=null;state.preview=null;state.strokes.push(s);state.redo=[];if(state.mode==='one-line')state.oneLineUsed=true;call('draw',{type:'stroke',stroke:s});renderCanvas();});
canvas.addEventListener('pointercancel',()=>{state.painting=false;state.currentStroke=null;state.preview=null;renderCanvas();});
socket.on('round-ended',d=>{state.canDraw=false;state.lastRound=d;state.activeGallery=d.galleryId;state.strokes=d.strokes||[];show('gallery');$('revealWord').textContent=`The word was “${d.answer}”`; $('gallerySubtitle').textContent=`${d.drawerName} drew round ${d.round}. ${d.reason==='all-guessed'?'Everyone got it!':'Time to admire the art.'}`;drawGallery();$('roundPoints').innerHTML=Object.entries(d.points||{}).map(([id,pts])=>{const p=state.room?.players.find(x=>x.id===id);return `<span class="point-chip">${escapeHtml(p?.nickname||'Player')}: +${pts}</span>`;}).join('');$('nextRoundText').textContent='Next round in a few seconds…';$('voteDrawing').disabled=false;$('voteDrawing').textContent='🏆 Vote for this drawing';});
function drawGallery(){gctx.clearRect(0,0,gcanvas.width,gcanvas.height);gctx.fillStyle='#fff';gctx.fillRect(0,0,gcanvas.width,gcanvas.height);state.strokes.forEach(s=>drawStroke(gctx,s));}
socket.on('vote-update',d=>{if(d.galleryId===state.activeGallery)$('voteDrawing').textContent=`🏆 Vote submitted · ${d.votes} votes`;});
socket.on('game-finished',d=>{show('results');$('finalRanks').innerHTML=d.rankings.map(p=>`<div class="final-row"><span class="rank">${p.rank===1?'🏆':`#${p.rank}`}</span><span class="avatar">${escapeHtml(p.nickname[0].toUpperCase())}</span><b>${escapeHtml(p.nickname)}</b><span class="final-score">${p.score} pts</span></div>`).join('');refreshBoard();});
socket.on('profile-result',p=>{});
socket.on('report',r=>toast(`Report received: ${r.target} — ${r.reason||'No reason supplied'}`));
function init(){refreshBoard();updateJoinFromUrl();if(state.token){/* socket reconnect event attempts secure token rejoin */}}
init();
})();