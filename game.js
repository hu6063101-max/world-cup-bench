/* ============================================================
 * 《世界杯替补席》 World Cup Bench
 * 原生 Canvas 像素游戏：坐在替补席上偷偷搞事，帮己方赢球。
 * 无外部依赖，所有素材代码绘制，音效由 WebAudio 合成。
 * ============================================================ */
(function () {
'use strict';

// ---------- 基础常量 ----------
const W = 480, H = 320;
const PITCH = { x: 8, y: 30, w: 464, h: 168 };       // 球场区域
const MATCH_REAL_SECONDS = 120;                       // 90 分钟压缩为 120 秒
const MATCH_MINUTES = 90;
const TEAM_HOME = '香蕉共和国';                        // 己方（红）
const TEAM_AWAY = '严谨王国';                          // 对方（蓝）

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
ctx.imageSmoothingEnabled = false;

// ---------- 工具 ----------
const rnd = (a, b) => a + Math.random() * (b - a);
const ri = (a, b) => Math.floor(rnd(a, b + 1));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const pick = arr => arr[Math.floor(Math.random() * arr.length)];

// ---------- 音效（WebAudio 合成） ----------
const SFX = (() => {
  let ac = null;
  function ensure() {
    if (!ac) {
      try { ac = new (window.AudioContext || window.webkitAudioContext)(); }
      catch (e) { return null; }
    }
    if (ac.state === 'suspended') ac.resume();
    return ac;
  }
  function tone(freq, dur, type, vol, when, slideTo) {
    const a = ensure(); if (!a) return;
    const t0 = a.currentTime + (when || 0);
    const o = a.createOscillator(), g = a.createGain();
    o.type = type || 'square';
    o.frequency.setValueAtTime(freq, t0);
    if (slideTo) o.frequency.linearRampToValueAtTime(slideTo, t0 + dur);
    g.gain.setValueAtTime(vol || 0.08, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(a.destination);
    o.start(t0); o.stop(t0 + dur + 0.02);
  }
  function noise(dur, vol, when) {
    const a = ensure(); if (!a) return;
    const t0 = a.currentTime + (when || 0);
    const len = Math.floor(a.sampleRate * dur);
    const buf = a.createBuffer(1, len, a.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = a.createBufferSource(); src.buffer = buf;
    const g = a.createGain();
    g.gain.setValueAtTime(vol || 0.12, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(g).connect(a.destination);
    src.start(t0);
  }
  return {
    unlock: ensure,
    whistle()  { tone(2200, .12, 'square', .07); tone(2200, .25, 'square', .07, .16); },
    goalHome() { [523, 659, 784, 1046].forEach((f, i) => tone(f, .14, 'square', .09, i * .09)); noise(.5, .10, .1); },
    goalAway() { [400, 330, 262].forEach((f, i) => tone(f, .18, 'square', .07, i * .12)); },
    warning()  { tone(1500, .09, 'square', .10); tone(1500, .09, 'square', .10, .15); },
    caught()   { tone(180, .4, 'sawtooth', .14, 0, 90); noise(.18, .08); },
    swoosh()   { tone(900, .12, 'triangle', .07, 0, 300); },
    drink()    { tone(700, .07, 'square', .07); tone(950, .09, 'square', .07, .08); },
    shout()    { tone(260, .16, 'sawtooth', .09, 0, 380); },
    slip()     { tone(1200, .15, 'triangle', .08, 0, 200); },
    click()    { tone(800, .05, 'square', .06); },
    over()     { tone(880, .14, 'square', .08); tone(880, .14, 'square', .08, .18); tone(660, .4, 'square', .08, .36); },
    busted()   { [330, 262, 196, 130].forEach((f, i) => tone(f, .22, 'sawtooth', .1, i * .16)); }
  };
})();

// ---------- 全局游戏状态 ----------
let state = 'title';          // title | playing | over
let overReason = '';          // fulltime | busted
let lastTs = 0;
let elapsed = 0;              // 比赛已进行的真实秒数
let suspicion = 0;            // 怀疑值 0~100
let mischief = 0;             // 搞事成功次数
let caughtCount = 0;          // 被抓次数
let shake = { t: 0, mag: 0 };
let flash = { t: 0, color: '' };
let toasts = [];              // 飘字 {text,x,y,t,color}
let particles = [];
let newsTimer = 0;            // 新闻弹窗的延迟句柄（重开时需取消）

// ---------- 比赛模拟 ----------
const match = {
  scoreHome: 0, scoreAway: 0,
  phase: 'kickoff',           // kickoff | midfield | homeAttack | awayAttack | goalPause
  phaseT: 0,
  buffs: { banana: 0, drink: 0, keeper: 0 },
  ball: { x: W / 2, y: PITCH.y + PITCH.h / 2, tx: W / 2, ty: PITCH.y + PITCH.h / 2 },
  goalFlash: 0, lastGoalSide: ''
};

// 球场上的球员（己方红向右进攻，对方蓝向左进攻）
let pitchPlayers = [];
function makePitchPlayers() {
  pitchPlayers = [];
  const rows = [0.25, 0.5, 0.75];
  for (let side = 0; side < 2; side++) {
    for (let i = 0; i < 6; i++) {
      const col = (i % 2 === 0) ? 0.28 : 0.12;
      const fx = side === 0 ? PITCH.x + PITCH.w * (0.18 + col) : PITCH.x + PITCH.w * (0.82 - col);
      const fy = PITCH.y + PITCH.h * rows[i % 3] + rnd(-10, 10);
      pitchPlayers.push({ side, x: fx, y: fy, fx, fy, frame: rnd(0, 2), slip: 0, boost: 0 });
    }
  }
}

// ---------- 教练 ----------
const coach = {
  state: 'pitch',             // pitch | warning | watching
  t: rnd(5, 9),
  x: 52, y: 218
};

// ---------- 替补席玩家 ----------
const player = {
  x: 250, y: 252,
  pose: 'idle',               // idle | acting | warmup | caught
  poseT: 0,
  action: '',                 // banana | drink | keeper
  warmKeys: 0                 // 按住空格/按钮的计数（键盘+指针可同时按）
};

// 三种操作配置
const ACTIONS = {
  banana: { cd: 7,  cdLeft: 0, dur: 1.0, buff: 8,  label: '香蕉皮' },
  drink:  { cd: 9,  cdLeft: 0, dur: 1.0, buff: 10, label: '能量饮料' },
  keeper: { cd: 11, cdLeft: 0, dur: 1.1, buff: 8,  label: '干扰门将' }
};

// 投掷物（香蕉/饮料飞行动画）
let projectiles = [];

// ---------- DOM ----------
const newsOverlay = document.getElementById('news-overlay');
const newsHeadline = document.getElementById('news-headline');
const newsBody = document.getElementById('news-body');
const newsStats = document.getElementById('news-stats');
const btnRestart = document.getElementById('btn-restart');
const btnWarmup = document.getElementById('btn-warmup');
const actBtns = Array.from(document.querySelectorAll('.act-btn'));

// ---------- 重置 / 开始 ----------
function resetGame() {
  state = 'playing';
  overReason = '';
  elapsed = 0; suspicion = 0; mischief = 0; caughtCount = 0;
  match.scoreHome = 0; match.scoreAway = 0;
  match.phase = 'kickoff'; match.phaseT = 1.2;
  match.buffs = { banana: 0, drink: 0, keeper: 0 };
  match.ball.x = match.ball.tx = W / 2;
  match.ball.y = match.ball.ty = PITCH.y + PITCH.h / 2;
  match.goalFlash = 0;
  coach.state = 'pitch'; coach.t = rnd(5, 9);
  player.pose = 'idle'; player.poseT = 0; player.action = ''; player.warmKeys = 0;
  for (const k in ACTIONS) ACTIONS[k].cdLeft = 0;
  makePitchPlayers();
  projectiles = []; particles = []; toasts = [];
  shake = { t: 0, mag: 0 }; flash = { t: 0, color: '' };
  clearTimeout(newsTimer);
  newsOverlay.classList.add('hidden');
  SFX.whistle();
  toast('比赛开始！', W / 2, 120, '#ffcd75');
}

// ---------- 飘字 / 粒子 / 震动 ----------
function toast(text, x, y, color, big) { toasts.push({ text, x, y, t: big ? 2.2 : 1.6, color: color || '#fff', big: !!big }); }
function addShake(mag, t) { shake.mag = Math.max(shake.mag, mag); shake.t = Math.max(shake.t, t); }
function addFlash(color, t) { flash.color = color; flash.t = t; }
function burst(x, y, colors, n, speed, life) {
  for (let i = 0; i < n; i++) {
    const a = rnd(0, Math.PI * 2), s = rnd(speed * 0.3, speed);
    particles.push({
      x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - speed * 0.4,
      life: rnd(life * 0.5, life), maxLife: life,
      color: pick(colors), size: ri(2, 4), grav: 60
    });
  }
}

// ---------- 操作逻辑 ----------
function tryAction(name) {
  if (state !== 'playing') return;
  const act = ACTIONS[name];
  if (act.cdLeft > 0 || player.pose === 'acting') return;
  SFX.click();
  // 教练正盯着时仍执意操作 → 直接被抓
  player.pose = 'acting';
  player.poseT = act.dur;
  player.action = name;
  act.cdLeft = act.cd;
  if (coach.state === 'watching') { onCaught(); return; }
  // 起手动画 + 投掷物
  if (name === 'banana') {
    SFX.swoosh();
    projectiles.push({ kind: 'banana', x: player.x, y: player.y - 10, t: 0, dur: 0.8,
      tx: rnd(PITCH.x + PITCH.w * 0.45, PITCH.x + PITCH.w * 0.7), ty: rnd(PITCH.y + 40, PITCH.y + PITCH.h - 30) });
  } else if (name === 'drink') {
    SFX.drink();
    projectiles.push({ kind: 'drink', x: player.x, y: player.y - 10, t: 0, dur: 0.7,
      tx: rnd(PITCH.x + PITCH.w * 0.3, PITCH.x + PITCH.w * 0.5), ty: rnd(PITCH.y + 40, PITCH.y + PITCH.h - 30) });
  } else if (name === 'keeper') {
    SFX.shout();
  }
}

// 操作动画结束 → 生效
function finishAction() {
  const name = player.action;
  player.action = '';
  if (state !== 'playing') return;
  mischief++;
  const act = ACTIONS[name];
  match.buffs[name] = act.buff;
  if (name === 'banana') {
    // 对方一名球员滑倒
    const victims = pitchPlayers.filter(p => p.side === 1);
    const v = pick(victims);
    if (v) { v.slip = 1.6; burst(v.x, v.y, ['#ffe762', '#fff'], 10, 50, 0.7); }
    SFX.slip();
    toast('🍌 对方滑倒了！', W / 2, 100, '#ffe762');
    // 若对方正在进攻，直接化解
    if (match.phase === 'awayAttack') { match.phase = 'midfield'; match.phaseT = rnd(2, 3); }
  } else if (name === 'drink') {
    pitchPlayers.forEach(p => { if (p.side === 0) p.boost = act.buff; });
    toast('🥤 队友喝了猛料，速度起飞！', W / 2, 100, '#41a6f6');
  } else if (name === 'keeper') {
    toast('📢 对方门将被吵得心神不宁！', W / 2, 100, '#ff8866');
    burst(PITCH.x + PITCH.w - 14, PITCH.y + PITCH.h / 2, ['#ff8866', '#fff'], 8, 40, 0.6);
  }
}

// 被教练抓到
function onCaught() {
  caughtCount++;
  const add = ri(26, 34);
  suspicion = clamp(suspicion + add, 0, 100);
  player.pose = 'caught';
  player.poseT = 1.2;
  player.action = '';
  SFX.caught();
  addShake(5, 0.45);
  addFlash('rgba(255,40,40,0.35)', 0.4);
  toast(`被教练发现了！怀疑 +${add}`, W / 2, 230, '#ff5555');
  burst(player.x, player.y - 20, ['#ff5555', '#ffaa00'], 12, 60, 0.8);
  if (suspicion >= 100) endGame('busted');
}

// ---------- 教练逻辑 ----------
function updateCoach(dt) {
  coach.t -= dt;
  if (coach.state === 'pitch' && coach.t <= 0) {
    coach.state = 'warning'; coach.t = 1.8;
    SFX.warning();
  } else if (coach.state === 'warning' && coach.t <= 0) {
    coach.state = 'watching'; coach.t = rnd(2.4, 4.2);
    // 转头瞬间正在搞事 → 被抓
    if (player.pose === 'acting') onCaught();
  } else if (coach.state === 'watching' && coach.t <= 0) {
    coach.state = 'pitch'; coach.t = rnd(5.5, 11);
    toast('教练转回去了，安全！', coach.x + 60, coach.y - 30, '#38b764');
  }
  // 被盯着且没在热身 → 怀疑值缓涨
  if (coach.state === 'watching' && state === 'playing') {
    if (player.pose === 'acting') {
      onCaught();
    } else if (player.pose !== 'warmup' && player.pose !== 'caught') {
      suspicion = clamp(suspicion + 7 * dt, 0, 100);
      if (suspicion >= 100) endGame('busted');
    }
  }
  // 没被盯着时怀疑值缓慢回落
  if (coach.state === 'pitch') suspicion = clamp(suspicion - 1.2 * dt, 0, 100);
}

// ---------- 玩家姿态 ----------
function updatePlayer(dt) {
  if (player.pose === 'acting') {
    player.poseT -= dt;
    if (player.poseT <= 0) { finishAction(); player.pose = 'idle'; }
  } else if (player.pose === 'caught') {
    player.poseT -= dt;
    if (player.poseT <= 0) player.pose = 'idle';
  } else {
    player.pose = player.warmKeys > 0 ? 'warmup' : 'idle';
  }
  for (const k in ACTIONS) ACTIONS[k].cdLeft = Math.max(0, ACTIONS[k].cdLeft - dt);
}

// ---------- 比赛模拟 ----------
function updateMatch(dt) {
  elapsed += dt;
  if (elapsed >= MATCH_REAL_SECONDS) { endGame('fulltime'); return; }

  for (const k in match.buffs) match.buffs[k] = Math.max(0, match.buffs[k] - dt);
  match.goalFlash = Math.max(0, match.goalFlash - dt);

  match.phaseT -= dt;
  if (match.phaseT <= 0) nextPhase();

  // 球向目标点移动
  const b = match.ball;
  const spd = 3.2 * dt;
  b.x += (b.tx - b.x) * spd; b.y += (b.ty - b.y) * spd;
  if (Math.abs(b.tx - b.x) < 6 && Math.abs(b.ty - b.y) < 6) {
    // 小范围游走
    b.tx = clamp(b.tx + rnd(-30, 30), PITCH.x + 16, PITCH.x + PITCH.w - 16);
    b.ty = clamp(b.ty + rnd(-20, 20), PITCH.y + 14, PITCH.y + PITCH.h - 14);
  }

  // 球员跟球跑动
  for (const p of pitchPlayers) {
    p.frame += dt * (p.boost > 0 ? 10 : 6);
    p.boost = Math.max(0, p.boost - dt);
    if (p.slip > 0) { p.slip -= dt; continue; }
    const chase = 0.45;
    const tx = p.fx + (b.x - p.fx) * chase + Math.sin(p.frame * 0.7 + p.fy) * 8;
    const ty = p.fy + (b.y - p.fy) * chase + Math.cos(p.frame * 0.5 + p.fx) * 6;
    const sp = (p.boost > 0 ? 46 : 30) * dt;
    const dx = tx - p.x, dy = ty - p.y, d = Math.hypot(dx, dy) || 1;
    p.x += dx / d * Math.min(sp, d);
    p.y += dy / d * Math.min(sp, d);
  }
}

function nextPhase() {
  const m = match, B = m.buffs;
  if (m.phase === 'kickoff' || m.phase === 'goalPause') {
    m.phase = 'midfield'; m.phaseT = rnd(2, 3.5);
    m.ball.tx = W / 2 + rnd(-40, 40); m.ball.ty = PITCH.y + PITCH.h / 2 + rnd(-30, 30);
    return;
  }
  if (m.phase === 'midfield') {
    // 决定哪边发起进攻：饮料/香蕉提高己方拿球率
    let pHome = 0.5 + (B.drink > 0 ? 0.18 : 0) + (B.banana > 0 ? 0.14 : 0);
    if (Math.random() < pHome) {
      m.phase = 'homeAttack'; m.ball.tx = PITCH.x + PITCH.w - 26; m.ball.ty = PITCH.y + PITCH.h / 2 + rnd(-40, 40);
    } else {
      m.phase = 'awayAttack'; m.ball.tx = PITCH.x + 26; m.ball.ty = PITCH.y + PITCH.h / 2 + rnd(-40, 40);
    }
    m.phaseT = rnd(2.4, 3.6);
    return;
  }
  if (m.phase === 'homeAttack') {
    // 射门：干扰门将大幅提高命中
    let p = 0.30 + (B.keeper > 0 ? 0.38 : 0) + (B.drink > 0 ? 0.10 : 0);
    if (Math.random() < p) goal('home'); else missChance('home');
    return;
  }
  if (m.phase === 'awayAttack') {
    let p = 0.28 - (B.banana > 0 ? 0.18 : 0);
    if (Math.random() < Math.max(0.06, p)) goal('away'); else missChance('away');
    return;
  }
}

function missChance(side) {
  match.phase = 'midfield'; match.phaseT = rnd(1.8, 3);
  toast(side === 'home' ? '射门偏了！' : '对方射偏了！', match.ball.x, match.ball.y - 14,
        side === 'home' ? '#ffcd75' : '#9ad1ff');
  match.ball.tx = W / 2 + rnd(-50, 50); match.ball.ty = PITCH.y + PITCH.h / 2 + rnd(-30, 30);
}

function goal(side) {
  if (side === 'home') {
    match.scoreHome++; SFX.goalHome();
    addShake(6, 0.5); addFlash('rgba(255,230,100,0.3)', 0.45);
    toast('⚽ GOAL!! 香蕉共和国进球！', W / 2, 90, '#ffe762', true);
    burst(PITCH.x + PITCH.w - 14, PITCH.y + PITCH.h / 2, ['#ffe762', '#ff5555', '#41a6f6', '#38b764'], 26, 80, 1.2);
    match.ball.x = PITCH.x + PITCH.w - 10;
  } else {
    match.scoreAway++; SFX.goalAway();
    addShake(3, 0.3); addFlash('rgba(80,120,255,0.25)', 0.35);
    toast('对方进球了……', W / 2, 90, '#9ad1ff');
    burst(PITCH.x + 14, PITCH.y + PITCH.h / 2, ['#41a6f6', '#fff'], 16, 60, 0.9);
    match.ball.x = PITCH.x + 10;
  }
  match.lastGoalSide = side;
  match.goalFlash = 1.4;
  match.phase = 'goalPause'; match.phaseT = 1.6;
  match.ball.tx = W / 2; match.ball.ty = PITCH.y + PITCH.h / 2;
}

// ---------- 结束 & 新闻 ----------
function endGame(reason) {
  if (state !== 'playing') return;
  state = 'over';
  overReason = reason;
  player.warmKeys = 0;
  if (reason === 'busted') { SFX.busted(); addShake(8, 0.7); addFlash('rgba(255,0,0,0.4)', 0.8); }
  else SFX.over();
  clearTimeout(newsTimer);
  newsTimer = setTimeout(showNews, reason === 'busted' ? 1100 : 900);
}

function showNews() {
  if (state !== 'over') return;          // 弹窗前已重开则作废
  const sh = match.scoreHome, sa = match.scoreAway;
  const min = Math.min(MATCH_MINUTES, Math.floor(elapsed / MATCH_REAL_SECONDS * MATCH_MINUTES));
  let headline, body;

  if (overReason === 'busted') {
    headline = pick([
      `【独家】替补球员第${min}分钟被保安抬出球场，全场欢送`,
      `震惊！${TEAM_HOME}替补席惊现"搞事大师"，教练当场气到摔战术板`,
      `本届世界杯最大丑闻：替补球员场边搞事${mischief}次，终于翻车`
    ]);
    body = pick([
      `目击者称，该替补球员全场"热身"姿势僵硬得像门框，教练第${Math.max(1, caughtCount)}次回头时终于忍无可忍。`,
      `主教练赛后表示："我执教三十年，第一次见到有人往场里扔香蕉皮还冲我傻笑。"`,
      `据悉该球员被抬出场时仍高喊"我只是在热身"，目前已被罚去洗一个月球袜。`
    ]);
    body += `\n离场时比分定格在 ${sh} : ${sa}，他的世界杯之旅到此结束。`;
  } else {
    const res = sh > sa ? 'win' : (sh === sa ? 'draw' : 'lose');
    const sneaky = suspicion < 30;
    if (res === 'win') {
      headline = sneaky ? pick([
        `${TEAM_HOME} ${sh}:${sa} 力克${TEAM_AWAY}！玄学加成来自何方？专家：查查替补席`,
        `${sh}:${sa}！${TEAM_HOME}爆冷取胜，对方门将赛后称"总听到奇怪的喊声"`
      ]) : pick([
        `${TEAM_HOME} ${sh}:${sa} 获胜，但替补席的香蕉皮库存引发足协关注`,
        `赢了！${sh}:${sa}！不过主教练表示要给某位替补"单独谈谈心"`
      ]);
      body = mischief >= 5
        ? `数据网站统计，本场${TEAM_AWAY}球员共滑倒、分神、被吵${mischief}次，概率学家称"纯属巧合的可能性约等于中彩票"。`
        : (mischief === 0
          ? `值得一提的是，${TEAM_HOME}替补席全场安分守己，这场胜利完全凭实力——真没意思。`
          : `场边摄像机拍到${mischief}次"不明物体"飞入场内，裁判表示风太大，看不清。`);
    } else if (res === 'draw') {
      headline = pick([
        `${sh}:${sa} 平局收场，${TEAM_HOME}替补席的努力还差一瓶饮料的距离`,
        `握手言和 ${sh}:${sa}！双方球迷一致认为本场最佳是那块香蕉皮`
      ]);
      body = mischief > 0
        ? `尽管替补席贡献了${mischief}次"幕后助攻"，球队仍未能拿下比赛。该替补赛后沉痛表示：下次带一整串香蕉。`
        : `替补席全场纹丝不动，被网友评为"本届世界杯最敬业雕塑"。`;
    } else {
      headline = pick([
        `${sh}:${sa} 告负！${TEAM_HOME}替补被曝全场搞事${mischief}次仍无力回天`,
        `输了 ${sh}:${sa}……${TEAM_HOME}替补席："我已经尽力了，香蕉皮不够用"`
      ]);
      body = mischief >= 5
        ? `${mischief}次搞事换来一场失利，评论员锐评："建议下次直接把替补换上去，至少他扔东西挺准。"`
        : `球迷质问：替补席在干什么？知情人士透露：他大部分时间都在假装热身，演技倒是值一座小金人。`;
    }
    if (suspicion >= 70) body += `\n另据更衣室消息，主教练已对某替补的"热身频率"展开内部调查（怀疑值 ${Math.round(suspicion)}%）。`;
    else if (sneaky && mischief > 0) body += `\n截至发稿，没有任何证据指向替补席。完美犯罪（怀疑值仅 ${Math.round(suspicion)}%）。`;
  }

  newsHeadline.textContent = headline;
  newsBody.textContent = body;
  newsStats.innerHTML =
    `📊 终场比分：${TEAM_HOME} <b>${sh} : ${sa}</b> ${TEAM_AWAY}` +
    (overReason === 'busted' ? `（第 ${min} 分钟被驱逐）` : '') +
    `<br>🕵️ 最终怀疑值：${Math.round(suspicion)}%　🎭 搞事成功：${mischief} 次　🚨 被抓：${caughtCount} 次`;
  newsOverlay.classList.remove('hidden');
}

// ============================================================
// 渲染
// ============================================================
function px(x, y, w, h, c) { ctx.fillStyle = c; ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h)); }

function drawPitch() {
  // 草地条纹
  for (let i = 0; i < 8; i++) {
    px(PITCH.x, PITCH.y + i * PITCH.h / 8, PITCH.w, PITCH.h / 8, i % 2 ? '#2e9e50' : '#38b764');
  }
  ctx.strokeStyle = '#d8f5e0'; ctx.lineWidth = 2;
  ctx.strokeRect(PITCH.x + 4, PITCH.y + 4, PITCH.w - 8, PITCH.h - 8);
  // 中线中圈
  ctx.beginPath(); ctx.moveTo(W / 2, PITCH.y + 4); ctx.lineTo(W / 2, PITCH.y + PITCH.h - 4); ctx.stroke();
  ctx.beginPath(); ctx.arc(W / 2, PITCH.y + PITCH.h / 2, 22, 0, Math.PI * 2); ctx.stroke();
  // 禁区
  ctx.strokeRect(PITCH.x + 4, PITCH.y + PITCH.h / 2 - 34, 30, 68);
  ctx.strokeRect(PITCH.x + PITCH.w - 34, PITCH.y + PITCH.h / 2 - 34, 30, 68);
  // 球门
  px(PITCH.x - 2, PITCH.y + PITCH.h / 2 - 20, 6, 40, '#f4f4f4');
  px(PITCH.x + PITCH.w - 4, PITCH.y + PITCH.h / 2 - 20, 6, 40, '#f4f4f4');
  // 门将（蓝方门将在右侧，被干扰时发抖）
  drawTinyKeeper(PITCH.x + 12, PITCH.y + PITCH.h / 2, '#ffcd75', false);
  drawTinyKeeper(PITCH.x + PITCH.w - 12, PITCH.y + PITCH.h / 2, '#5d6df0', match.buffs.keeper > 0);
  // 进球时球门闪光
  if (match.goalFlash > 0 && Math.floor(match.goalFlash * 10) % 2 === 0) {
    const gx = match.lastGoalSide === 'home' ? PITCH.x + PITCH.w - 8 : PITCH.x + 2;
    px(gx - 4, PITCH.y + PITCH.h / 2 - 24, 14, 48, 'rgba(255,255,160,0.7)');
  }
}

function drawTinyKeeper(x, y, color, panicking) {
  const wob = panicking ? Math.sin(performance.now() / 40) * 3 : Math.sin(performance.now() / 400) * 1.5;
  px(x - 3, y - 10 + wob * 0.3, 6, 5, '#ffd9b3');           // 头
  px(x - 4, y - 5, 8, 7, color);                             // 身
  px(x - 4 + wob, y + 2, 3, 5, '#222'); px(x + 1 - wob, y + 2, 3, 5, '#222'); // 腿
  if (panicking) {
    ctx.fillStyle = '#ff5555'; ctx.font = 'bold 10px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('?!', x, y - 14);
  }
}

function drawPitchPlayers() {
  for (const p of pitchPlayers) {
    const c = p.side === 0 ? '#e23b46' : '#4161e2';
    const c2 = p.side === 0 ? '#8f1f27' : '#27358f';
    if (p.slip > 0) {
      // 滑倒：躺平 + 星星
      px(p.x - 6, p.y + 2, 12, 4, c);
      px(p.x + 5, p.y + 1, 4, 4, '#ffd9b3');
      ctx.fillStyle = '#ffe762'; ctx.font = '8px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText('✶', p.x + Math.sin(performance.now() / 90) * 6, p.y - 6);
      continue;
    }
    const run = Math.floor(p.frame) % 2;
    px(p.x - 2, p.y - 9, 5, 4, '#ffd9b3');                   // 头
    px(p.x - 3, p.y - 5, 7, 6, c);                           // 球衣
    px(p.x - 3, p.y + 1, 7, 2, '#fff');                      // 短裤
    px(p.x - 3 + (run ? 0 : 2), p.y + 3, 2, 4, c2);          // 腿
    px(p.x + 2 - (run ? 0 : 2), p.y + 3, 2, 4, c2);
    if (p.boost > 0) {                                       // 饮料加速线
      px(p.x - 7, p.y - 3, 3, 1, '#9ad1ff'); px(p.x - 6, p.y, 2, 1, '#9ad1ff');
    }
  }
}

function drawBall() {
  const b = match.ball;
  px(b.x - 2, b.y - 2, 4, 4, '#fff');
  px(b.x - 1, b.y - 1, 2, 2, '#999');
  // 影子
  ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.fillRect(Math.round(b.x - 2), Math.round(b.y + 3), 4, 1);
}

// 替补席区域
function drawBenchArea() {
  px(0, 198, W, H - 198, '#3a3f5e');                          // 场边地面
  px(0, 198, W, 4, '#23284a');
  // 广告牌
  ctx.font = 'bold 9px sans-serif'; ctx.textAlign = 'left';
  ctx.fillStyle = '#23284a';
  for (let i = 0; i < 6; i++) px(8 + i * 80, 203, 72, 10, i % 2 ? '#1d2240' : '#252c52');
  ctx.fillStyle = '#5a6391';
  ctx.fillText('香蕉牌香蕉', 16, 211); ctx.fillText('喝了就跑', 98, 211);
  ctx.fillText('禁止搞事', 176, 211); ctx.fillText('世界杯™', 258, 211);
  ctx.fillText('滑倒险', 338, 211); ctx.fillText('热身用品', 416, 211);
  // 替补席长凳
  px(180, 262, 240, 8, '#7a4a23'); px(184, 270, 6, 16, '#5b3517'); px(410, 270, 6, 16, '#5b3517');
  px(180, 234, 240, 6, '#5b3517');                            // 顶棚杆
  px(176, 228, 248, 8, '#b13e53');                            // 顶棚
  // 其他替补（呆坐）
  drawSubstitute(300, 252, '#e23b46', 0);
  drawSubstitute(340, 252, '#e23b46', 1);
  drawSubstitute(380, 252, '#e23b46', 2);
}

function drawSubstitute(x, y, c, seed) {
  const bob = Math.sin(performance.now() / 600 + seed * 2) * 1;
  px(x - 4, y - 16 + bob, 8, 7, '#ffd9b3');
  px(x - 5, y - 9 + bob, 10, 10, c);
  px(x - 5, y + 1, 10, 4, '#3b3b4d');
  px(x - 5, y + 5, 3, 6, '#222'); px(x + 2, y + 5, 3, 6, '#222');
}

// 玩家角色（替补席上的你）
function drawPlayer() {
  const x = player.x, y = player.y;
  const t = performance.now();
  ctx.textAlign = 'center';

  if (player.pose === 'warmup') {
    // 站着做开合跳
    const up = Math.floor(t / 180) % 2 === 0;
    const yy = y - 6;
    px(x - 4, yy - 22, 8, 7, '#ffd9b3');                      // 头
    px(x - 6, yy - 24, 12, 3, '#222');                        // 头发
    px(x - 5, yy - 15, 10, 11, '#e23b46');                    // 身
    if (up) { px(x - 9, yy - 22, 4, 8, '#e23b46'); px(x + 5, yy - 22, 4, 8, '#e23b46'); }
    else { px(x - 9, yy - 10, 4, 8, '#e23b46'); px(x + 5, yy - 10, 4, 8, '#e23b46'); }
    px(x - 5, yy - 4, 10, 4, '#3b3b4d');
    px(x - 5 - (up ? 2 : 0), yy, 4, 8, '#222'); px(x + 1 + (up ? 2 : 0), yy, 4, 8, '#222');
    if (Math.floor(t / 300) % 3 === 0) { ctx.fillStyle = '#9ad1ff'; ctx.font = '8px sans-serif'; ctx.fillText('💦', x + 12, yy - 18); }
    ctx.fillStyle = '#38b764'; ctx.font = 'bold 9px sans-serif';
    ctx.fillText('我在热身！', x, yy - 30);
  } else if (player.pose === 'acting') {
    // 起身搞事：手伸向球场
    px(x - 4, y - 24, 8, 7, '#ffd9b3');
    px(x - 6, y - 26, 12, 3, '#222');
    px(x - 5, y - 17, 10, 11, '#e23b46');
    px(x + 4, y - 20, 8, 4, '#ffd9b3');                       // 伸出的手
    const icon = player.action === 'banana' ? '🍌' : player.action === 'drink' ? '🥤' : '📢';
    ctx.font = '10px sans-serif'; ctx.fillText(icon, x + 16, y - 18);
    px(x - 5, y - 6, 10, 4, '#3b3b4d');
    px(x - 5, y - 2, 4, 8, '#222'); px(x + 1, y - 2, 4, 8, '#222');
    if (player.action === 'keeper') {                          // 喊话声波
      ctx.strokeStyle = '#ff8866'; ctx.lineWidth = 1;
      const r = (t / 60) % 14;
      ctx.beginPath(); ctx.arc(x + 18, y - 18, 4 + r, -0.6, 0.6); ctx.stroke();
    }
  } else if (player.pose === 'caught') {
    // 被抓：手背后装无辜，满头大汗
    const shiver = Math.sin(t / 50) * 1.2;
    px(x - 4 + shiver, y - 20, 8, 7, '#ffd9b3');
    px(x - 6 + shiver, y - 22, 12, 3, '#222');
    px(x - 5, y - 13, 10, 9, '#e23b46');
    px(x - 5, y - 4, 10, 4, '#3b3b4d');
    px(x - 5, y, 4, 8, '#222'); px(x + 1, y, 4, 8, '#222');
    ctx.fillStyle = '#9ad1ff'; ctx.font = '9px sans-serif';
    ctx.fillText('💧', x - 10, y - 20); ctx.fillText('💧', x + 10, y - 16);
    ctx.fillStyle = '#ff5555'; ctx.font = 'bold 9px sans-serif';
    ctx.fillText('完蛋…', x, y - 28);
  } else {
    // 坐姿待机，贼眉鼠眼左右看
    const look = Math.floor(t / 900) % 2 ? 1 : -1;
    px(x - 4, y - 16, 8, 7, '#ffd9b3');
    px(x - 6, y - 18, 12, 3, '#222');
    px(x - 2 + look * 2, y - 13, 2, 2, '#222');                // 眼珠
    px(x - 5, y - 9, 10, 10, '#e23b46');
    px(x - 5, y + 1, 10, 4, '#3b3b4d');
    px(x - 5, y + 5, 3, 6, '#222'); px(x + 2, y + 5, 3, 6, '#222');
  }
  // 名牌
  ctx.fillStyle = '#ffcd75'; ctx.font = '8px sans-serif';
  ctx.fillText('你', x, y + 20);
  // 被盯着却没热身 → 醒目提示（闪烁）
  if (state === 'playing' && coach.state === 'watching' && player.pose === 'idle'
      && Math.floor(t / 220) % 2 === 0) {
    ctx.font = 'bold 12px sans-serif';
    ctx.fillStyle = '#000'; ctx.fillText('快按住空格假装热身！', x + 1, y - 31);
    ctx.fillStyle = '#ff5555'; ctx.fillText('快按住空格假装热身！', x, y - 32);
  }
}

// 教练
function drawCoach() {
  const x = coach.x, y = coach.y;
  const t = performance.now();
  ctx.textAlign = 'center';
  const watching = coach.state === 'watching';
  const warning = coach.state === 'warning';

  // 身体（西装）
  px(x - 7, y - 8, 14, 22, '#2b2b3a');
  px(x - 7, y + 14, 5, 12, '#1a1a24'); px(x + 2, y + 14, 5, 12, '#1a1a24');
  if (watching) {
    // 正面：脸朝替补席
    px(x - 5, y - 22, 10, 12, '#ffd9b3');
    px(x - 6, y - 24, 12, 4, '#555');                          // 帽檐
    px(x - 4, y - 18, 3, 2, '#fff'); px(x + 1, y - 18, 3, 2, '#fff'); // 眼白
    px(x - 3, y - 18, 1, 2, '#222'); px(x + 2, y - 18, 1, 2, '#222'); // 瞪眼
    px(x - 2, y - 13, 4, 1, '#a33');                            // 抿嘴
    px(x - 5, y - 6, 4, 3, '#ffd9b3'); px(x + 1, y - 6, 4, 3, '#ffd9b3'); // 抱胸的手
    // 视线
    ctx.strokeStyle = 'rgba(255,80,80,0.5)'; ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(x + 6, y - 17); ctx.lineTo(player.x - 10, player.y - 14); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#ff5555'; ctx.font = 'bold 10px sans-serif';
    ctx.fillText('👀 盯——', x + 40, y - 26);
  } else if (warning) {
    // 半转身 + 大警告
    const turn = Math.sin(t / 90) * 2;
    px(x - 5 + turn, y - 22, 10, 12, '#ffd9b3');
    px(x - 6 + turn, y - 24, 12, 4, '#555');
    px(x + 2 + turn, y - 18, 2, 2, '#222');
    const blink = Math.floor(t / 130) % 2 === 0;
    if (blink) {
      ctx.fillStyle = '#ff3333'; ctx.font = 'bold 13px sans-serif';
      ctx.fillText('⚠ 教练要回头了！', x + 86, y - 30);
      px(x - 12, y - 44, 24, 14, '#ff3333');
      ctx.fillStyle = '#fff'; ctx.font = 'bold 11px sans-serif';
      ctx.fillText('!', x, y - 33);
    }
  } else {
    // 背面看球
    px(x - 5, y - 22, 10, 12, '#e8b88f');                       // 后脑勺
    px(x - 6, y - 24, 12, 4, '#555');
    px(x - 6, y - 19, 12, 6, '#555');                           // 帽子后沿
    const nod = Math.floor(t / 700) % 2 ? 1 : 0;
    px(x - 8, y - 4 + nod, 3, 8, '#2b2b3a');                    // 背手
  }
  ctx.fillStyle = '#ffcd75'; ctx.font = '8px sans-serif';
  ctx.fillText('教练', x, y + 36);
}

// 投掷物
function drawProjectiles(dt) {
  for (let i = projectiles.length - 1; i >= 0; i--) {
    const p = projectiles[i];
    p.t += dt;
    const k = Math.min(1, p.t / p.dur);
    const x = p.x + (p.tx - p.x) * k;
    const y = p.y + (p.ty - p.y) * k - Math.sin(k * Math.PI) * 60;   // 抛物线
    ctx.font = '10px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(p.kind === 'banana' ? '🍌' : '🥤', x, y);
    if (k >= 1) {
      burst(p.tx, p.ty, p.kind === 'banana' ? ['#ffe762', '#fff'] : ['#41a6f6', '#9ad1ff'], 6, 40, 0.5);
      projectiles.splice(i, 1);
    }
  }
}

// HUD：比分、倒计时、怀疑值、增益
function drawHUD() {
  px(0, 0, W, 26, '#16213e');
  px(0, 26, W, 2, '#000');
  const min = Math.min(MATCH_MINUTES, Math.floor(elapsed / MATCH_REAL_SECONDS * MATCH_MINUTES));
  const left = Math.max(0, MATCH_MINUTES - min);
  ctx.textAlign = 'left'; ctx.font = 'bold 11px sans-serif';
  ctx.fillStyle = '#ff7782'; ctx.fillText(TEAM_HOME, 8, 17);
  ctx.fillStyle = '#fff'; ctx.font = 'bold 14px sans-serif';
  ctx.fillText(`${match.scoreHome} : ${match.scoreAway}`, 96, 18);
  ctx.fillStyle = '#9ad1ff'; ctx.font = 'bold 11px sans-serif';
  ctx.fillText(TEAM_AWAY, 140, 17);
  // 比赛计时 + 倒计时
  ctx.fillStyle = '#ffcd75';
  ctx.fillText(`⏱ 第 ${min}'`, 218, 17);
  ctx.fillStyle = left <= 15 ? '#ff5555' : '#cdd4f0';
  ctx.fillText(`倒计时 ${left}'`, 278, 17);
  // 怀疑值条
  ctx.fillStyle = '#cdd4f0'; ctx.fillText('怀疑', 352, 17);
  px(380, 8, 92, 12, '#000');
  const sw = Math.round(88 * suspicion / 100);
  const sc = suspicion < 40 ? '#38b764' : suspicion < 70 ? '#ffcd75' : '#ff5555';
  if (sw > 0) px(382, 10, sw, 8, sc);
  if (suspicion >= 70 && Math.floor(performance.now() / 200) % 2 === 0) {
    ctx.fillStyle = '#ff5555'; ctx.fillText('!', 472, 18);
  }
  // 当前增益图标
  let bx = 8, by = 222;
  ctx.font = '9px sans-serif';
  const buffNames = { banana: '🍌滑倒', drink: '🥤加速', keeper: '📢慌乱' };
  for (const k in match.buffs) {
    if (match.buffs[k] > 0) {
      px(bx - 2, by - 9, 46, 12, 'rgba(0,0,0,0.45)');
      ctx.fillStyle = '#ffe762'; ctx.textAlign = 'left';
      ctx.fillText(`${buffNames[k]}${Math.ceil(match.buffs[k])}s`, bx, by);
      bx += 52;
    }
  }
}

function drawParticles(dt) {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.life -= dt;
    if (p.life <= 0) { particles.splice(i, 1); continue; }
    p.vy += p.grav * dt;
    p.x += p.vx * dt; p.y += p.vy * dt;
    ctx.globalAlpha = clamp(p.life / p.maxLife, 0, 1);
    px(p.x, p.y, p.size, p.size, p.color);
  }
  ctx.globalAlpha = 1;
}

function drawToasts(dt) {
  ctx.textAlign = 'center';
  for (let i = toasts.length - 1; i >= 0; i--) {
    const t = toasts[i];
    t.t -= dt; t.y -= 14 * dt;
    if (t.t <= 0) { toasts.splice(i, 1); continue; }
    ctx.globalAlpha = clamp(t.t / 0.5, 0, 1);
    ctx.font = t.big ? 'bold 20px sans-serif' : 'bold 12px sans-serif';
    ctx.fillStyle = '#000';
    ctx.fillText(t.text, t.x + 1, t.y + 1);
    ctx.fillStyle = t.color;
    ctx.fillText(t.text, t.x, t.y);
  }
  ctx.globalAlpha = 1;
}

function drawTitle() {
  px(0, 0, W, H, '#1a1c2c');
  // 装饰球场底
  for (let i = 0; i < 8; i++) px(0, 220 + i * 12, W, 12, i % 2 ? '#234d2c' : '#1d4026');
  const t = performance.now();
  ctx.textAlign = 'center';
  // 大标题
  ctx.font = 'bold 34px sans-serif';
  ctx.fillStyle = '#000'; ctx.fillText('世界杯替补席', W / 2 + 3, 86 + 3);
  ctx.fillStyle = '#ffcd75'; ctx.fillText('世界杯替补席', W / 2, 86);
  ctx.font = 'bold 12px sans-serif'; ctx.fillStyle = '#9ad1ff';
  ctx.fillText('—— 一个替补能为球队做的，远比你想象的多 ——', W / 2, 110);
  // 弹跳的像素球
  const by = 150 + Math.abs(Math.sin(t / 350)) * -18;
  px(W / 2 - 5, by, 10, 10, '#fff'); px(W / 2 - 2, by + 3, 4, 4, '#999');
  // 操作说明
  ctx.font = '12px sans-serif'; ctx.fillStyle = '#f4f4f4'; ctx.textAlign = 'center';
  const lines = [
    '【1】🍌 扔香蕉皮：滑倒对手，化解进攻',
    '【2】🥤 递能量饮料：队友加速，更易拿球',
    '【3】📢 干扰门将：对方门将慌乱，射门更易进',
    '【空格 / 按钮】🏃 教练盯人时按住假装热身',
    '看到 ⚠ 红色警告 = 教练要回头，立刻收手！'
  ];
  lines.forEach((s, i) => ctx.fillText(s, W / 2, 178 + i * 17));
  if (Math.floor(t / 500) % 2 === 0) {
    ctx.font = 'bold 14px sans-serif'; ctx.fillStyle = '#38b764';
    ctx.fillText('▶ 点击屏幕 或 按任意键 开始比赛', W / 2, 290);
  }
}

// ---------- 主循环 ----------
function step(dt) {
  if (state === 'playing') {
    updateMatch(dt);
    if (state === 'playing') {           // updateMatch 可能触发结束
      updateCoach(dt);
      updatePlayer(dt);
    }
  }

  // 渲染
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, W, H);
  if (state === 'title') {
    drawTitle();
  } else {
    // 屏幕震动
    if (shake.t > 0) {
      shake.t -= dt;
      ctx.translate(rnd(-shake.mag, shake.mag), rnd(-shake.mag, shake.mag));
      if (shake.t <= 0) shake.mag = 0;
    }
    px(-10, -10, W + 20, H + 20, '#1a1c2c');
    drawPitch();
    drawPitchPlayers();
    drawBall();
    drawBenchArea();
    drawCoach();
    drawPlayer();
    drawProjectiles(dt);
    drawParticles(dt);
    drawToasts(dt);
    drawHUD();
    // 红屏闪
    if (flash.t > 0) {
      flash.t -= dt;
      ctx.fillStyle = flash.color;
      ctx.fillRect(-10, -10, W + 20, H + 20);
    }
    // 终场遮罩文字（新闻弹窗出现前的过渡）
    if (state === 'over' && newsOverlay.classList.contains('hidden')) {
      ctx.fillStyle = 'rgba(0,0,0,0.45)'; ctx.fillRect(-10, -10, W + 20, H + 20);
      ctx.textAlign = 'center'; ctx.font = 'bold 26px sans-serif';
      ctx.fillStyle = overReason === 'busted' ? '#ff5555' : '#ffcd75';
      ctx.fillText(overReason === 'busted' ? '你被赶出球场了！' : '终场哨响！', W / 2, H / 2);
    }
  }

  updateButtons();
}

function frame(ts) {
  const dt = Math.min(0.05, (ts - lastTs) / 1000 || 0);
  lastTs = ts;
  step(dt);
  requestAnimationFrame(frame);
}

// ---------- 按钮冷却 UI ----------
function updateButtons() {
  for (const btn of actBtns) {
    const act = ACTIONS[btn.dataset.action];
    const mask = btn.querySelector('.cd-mask');
    const ratio = act.cdLeft / act.cd;
    mask.style.width = (ratio * 100) + '%';
    btn.disabled = state !== 'playing';
  }
  btnWarmup.disabled = state !== 'playing';
  btnWarmup.classList.toggle('holding', player.warmKeys > 0);
}

// ---------- 输入 ----------
function startFromTitle() {
  if (state === 'title') { SFX.unlock(); resetGame(); return true; }
  return false;
}

document.addEventListener('keydown', e => {
  if (e.repeat) return;
  // 不拦截浏览器快捷键（F5、Ctrl+R 等）
  if (e.ctrlKey || e.metaKey || e.altKey || /^F\d+$/.test(e.key)) return;
  if (e.code === 'Space') e.preventDefault();
  if (startFromTitle()) return;
  if (state === 'over' && (e.key === 'r' || e.key === 'R')) { resetGame(); return; }
  if (state !== 'playing') return;
  if (e.key === '1') tryAction('banana');
  else if (e.key === '2') tryAction('drink');
  else if (e.key === '3') tryAction('keeper');
  else if (e.code === 'Space') player.warmKeys |= 1;
});
document.addEventListener('keyup', e => {
  if (e.code === 'Space') { e.preventDefault(); player.warmKeys &= ~1; }
});

canvas.addEventListener('pointerdown', () => { startFromTitle(); });

for (const btn of actBtns) {
  btn.addEventListener('click', () => { SFX.unlock(); tryAction(btn.dataset.action); });
}
// 热身按钮：按住生效（指针按下/抬起）
btnWarmup.addEventListener('pointerdown', e => { e.preventDefault(); SFX.unlock(); if (state === 'playing') player.warmKeys |= 2; });
const releaseWarm = () => { player.warmKeys &= ~2; };
btnWarmup.addEventListener('pointerup', releaseWarm);
btnWarmup.addEventListener('pointerleave', releaseWarm);
btnWarmup.addEventListener('pointercancel', releaseWarm);
window.addEventListener('blur', () => { player.warmKeys = 0; });

btnRestart.addEventListener('click', () => { SFX.unlock(); resetGame(); });

// ---------- 调试钩子（自动化测试用，不影响游戏） ----------
window.__game = {
  get state() { return state; },
  get score() { return [match.scoreHome, match.scoreAway]; },
  get suspicion() { return suspicion; },
  get mischief() { return mischief; },
  get coach() { return coach.state; },
  get player() { return player.pose; },
  get elapsed() { return elapsed; },
  start: () => { if (state !== 'playing') resetGame(); },
  fastForward(sec) {                       // 快进比赛（仅推进比赛与教练计时）
    const step = 1 / 30;
    for (let t = 0; t < sec && state === 'playing'; t += step) {
      updateMatch(step);
      if (state === 'playing') { updateCoach(step); updatePlayer(step); }
    }
  },
  setSuspicion(v) { suspicion = clamp(v, 0, 100); },
  act: tryAction,
  forceCoach(s) { coach.state = s; coach.t = 3; },
  renderOnce(dt) { step(dt == null ? 1 / 60 : dt); }   // 隐藏标签页下手动驱动一帧
};

// ---------- 启动 ----------
makePitchPlayers();
requestAnimationFrame(frame);
})();
