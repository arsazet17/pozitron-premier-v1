// Позитрон Премьер — движок AI-ставки для лотереи «Премьер» (4 из 20 + 4 из 20).
// Один и тот же код работает в браузере и в GitHub Actions (Node 22).
//
// Как устроено обучение:
//  • 8 «методов» (экспертов) на каждое поле оценивают числа 1–20 по-своему.
//  • После каждого тиража у каждого метода считается, сколько из его 4 чисел выпало.
//    Обычный (случайный) результат — 0,8 числа из 4. Кто выше — набирает очки, кто ниже — теряет.
//  • Очки затухают (память ≈ 33 тиража), поэтому веса подстраиваются под свежую игру.
//  • Итоговая ставка — 4 числа с наибольшей суммой «голосов» методов с учётом весов.
// Всё считается строго «вперёд»: прогноз на тираж N строится только по тиражам до N.

export const MODEL_VERSION = 'premier-ai-1.0';
export const NUMS = 20;
export const PICK = 4;
export const BASE_HITS = PICK * PICK / NUMS; // 0,8 — ожидание случайной ставки

export const PARAMS = {
  hotWindow: 24,     // окно «горячих»
  transDecay: 0.9995,// память переходов ≈ 2000 тиражей
  perfDecay: 0.97,   // память обучения ≈ 33 тиража
  eta: 0.6,          // насколько резко веса реагируют на очки
  warmup: 50         // первые тиражи только копят статистику
};

export const EXPERTS = [
  {key:'hot',    icon:'🔥', name:'Горячие',   note:'чаще всех за последние 24 тиража'},
  {key:'cold',   icon:'🧊', name:'Холодные',  note:'дольше всех не выпадали'},
  {key:'rep',    icon:'🔁', name:'Повторы',   note:'выпали в прошлых тиражах'},
  {key:'nbr',    icon:'↔️', name:'Соседи',    note:'±1 от чисел прошлого тиража'},
  {key:'trans',  icon:'🧭', name:'Переходы',  note:'что обычно выпадает после прошлого тиража'},
  {key:'cross',  icon:'🔀', name:'Перекрёст', note:'что выпадает после чисел другого поля'},
  {key:'mirror', icon:'🪞', name:'Зеркало',   note:'21 − числа прошлого тиража'},
  {key:'rhythm', icon:'🎵', name:'Ритм',      note:'число «созрело» по своему промежутку'}
];
const E = EXPERTS.length;

// ---------- Правила и выплаты ----------
export const PRIZES = {
  '4+3':50000,'3+4':50000,'4+2':10000,'2+4':10000,'4+1':5000,'1+4':5000,
  '4+0':1000,'0+4':1000,'3+3':750,'3+2':500,'2+3':500,'3+1':500,'1+3':500,
  '3+0':500,'0+3':500,'2+2':500
};
export const TICKET = 50;
export const PRIZE_ORDER = ['4+4','4+3','3+4','4+2','2+4','4+1','1+4','4+0','0+4','3+3','3+2','2+3','3+1','1+3','3+0','0+3','2+2'];

const C = (n,k) => { if(k<0||k>n) return 0; let r=1; for(let i=0;i<k;i++) r=r*(n-i)/(i+1); return r; };
// Шанс угадать k из 4 в одном поле
export const FIELD_P = [0,1,2,3,4].map(k => C(4,k)*C(16,4-k)/C(20,4));
export const catChance = key => { const [a,b] = key.split('+').map(Number); return FIELD_P[a]*FIELD_P[b]; };
export const prizeOf = (h1,h2) => PRIZES[`${h1}+${h2}`] || 0;
export const isJackpot = (h1,h2) => h1===4 && h2===4;
export const WIN_CHANCE = PRIZE_ORDER.reduce((a,k)=>a+catChance(k),0);
export const FIXED_EV = Object.entries(PRIZES).reduce((a,[k,v])=>a+catChance(k)*v,0); // ≈ 26,2 ₽ из 50 ₽

// ---------- Архив ----------
// Строка Lucky-numbers: 030487,30.10.26, 07:38,1,6,18,8,+,8,10,1,6
export function parseArchive(text){
  const out=[];
  for(const raw of String(text).replace(/^﻿/,'').split(/\r?\n/)){
    const p=raw.split(',').map(s=>s.trim());
    if(p.length<12 || !/^\d+$/.test(p[0]) || p[7]!=='+') continue;
    const [dd,mm,yy]=p[1].split('.');
    const f1=p.slice(3,7).map(Number), f2=p.slice(8,12).map(Number);
    if([...f1,...f2].some(x=>!Number.isInteger(x)||x<1||x>NUMS)) continue;
    out.push({no:Number(p[0]), at:`20${yy}-${mm}-${dd}T${p[2]}`, f:[f1,f2]});
  }
  out.sort((a,b)=>a.no-b.no);
  // убираем возможные дубли номера
  return out.filter((d,i)=>i===0||d.no!==out[i-1].no);
}

export const pad6 = n => String(n).padStart(6,'0');

// Следующий тираж: номер +1, время +15 минут (по Москве).
export function nextDrawOf(last){
  const t=new Date(`${last.at}:00+03:00`).getTime()+15*60000;
  const m=new Date(t+3*3600000).toISOString().slice(0,16);
  return {no:last.no+1, at:m};
}

// ---------- Состояние ----------
function zeros(n){ return new Float64Array(n); }
function matrix(){ return Array.from({length:NUMS+1},()=>zeros(NUMS+1)); }

export function createState(params=PARAMS){
  const field = () => ({
    lastSeen: new Int32Array(NUMS+1).fill(-1),
    hist: [],                       // последние hotWindow тиражей этого поля
    hotCount: new Int32Array(NUMS+1),
    trans: matrix(),                // a в поле (t) → b в поле (t+1)
    cross: matrix(),                // a в другом поле (t) → b в этом поле (t+1)
    gapMean: zeros(NUMS+1).fill(20/PICK),
    perf: zeros(E),                 // очки методов (затухающие)
    tot: zeros(E),                  // все попадания метода
    cnt: 0
  });
  return {params, t:0, prev:null, prev2:null, fields:[field(),field()]};
}

// Порядок при равенстве: детерминированный, зависит от номера тиража,
// чтобы не тянуть всегда маленькие числа.
function tieKey(n, seed){ return ((n*37 + seed*11) % 101); }

function rankOrder(score, seed){
  const idx=[]; for(let n=1;n<=NUMS;n++) idx.push(n);
  idx.sort((a,b)=> (score[b]-score[a]) || (tieKey(a,seed)-tieKey(b,seed)));
  return idx;
}

function expertScores(st, fi){
  const F=st.fields[fi], O=st.fields[1-fi], t=st.t;
  const last=st.prev?st.prev.f[fi]:[], last2=st.prev2?st.prev2.f[fi]:[];
  const other=st.prev?st.prev.f[1-fi]:[];
  const S=[];
  // hot
  const hot=zeros(NUMS+1); for(let n=1;n<=NUMS;n++) hot[n]=F.hotCount[n]; S.push(hot);
  // cold: задержка
  const cold=zeros(NUMS+1); for(let n=1;n<=NUMS;n++) cold[n]=F.lastSeen[n]<0?t+1:t-F.lastSeen[n]; S.push(cold);
  // повторы
  const rep=zeros(NUMS+1); for(const a of last) rep[a]+=1; for(const a of last2) rep[a]+=0.5; S.push(rep);
  // соседи
  const nbr=zeros(NUMS+1); for(const a of last){ if(a>1) nbr[a-1]+=1; if(a<NUMS) nbr[a+1]+=1; } S.push(nbr);
  // переходы
  const tr=zeros(NUMS+1);
  for(const a of last){ const row=F.trans[a]; let s=0; for(let b=1;b<=NUMS;b++) s+=row[b]; if(s>0) for(let b=1;b<=NUMS;b++) tr[b]+=row[b]/s; }
  S.push(tr);
  // перекрёст
  const cr=zeros(NUMS+1);
  for(const a of other){ const row=F.cross[a]; let s=0; for(let b=1;b<=NUMS;b++) s+=row[b]; if(s>0) for(let b=1;b<=NUMS;b++) cr[b]+=row[b]/s; }
  S.push(cr);
  // зеркало
  const mir=zeros(NUMS+1); for(const a of last) mir[NUMS+1-a]+=1; S.push(mir);
  // ритм: задержка близка к своему среднему промежутку
  const rh=zeros(NUMS+1);
  for(let n=1;n<=NUMS;n++){ const d=F.lastSeen[n]<0?t+1:t-F.lastSeen[n]; rh[n]=-Math.abs(d-F.gapMean[n]); }
  S.push(rh);
  return S;
}

export function weightsOf(st, fi){
  const F=st.fields[fi], eta=st.params.eta;
  let mx=-Infinity; for(let e=0;e<E;e++) mx=Math.max(mx,F.perf[e]);
  const w=[]; let s=0; for(let e=0;e<E;e++){ const v=Math.exp(eta*(F.perf[e]-mx)); w.push(v); s+=v; }
  return w.map(v=>v/s);
}

// Прогноз на следующий тираж по текущему состоянию.
export function predict(st){
  const seed=st.t;
  const out={fields:[]};
  for(let fi=0;fi<2;fi++){
    const S=expertScores(st,fi);
    const w=weightsOf(st,fi);
    const comb=zeros(NUMS+1);
    const expertPicks=[];
    for(let e=0;e<E;e++){
      const ord=rankOrder(S[e],seed+e);
      expertPicks.push(ord.slice(0,PICK));
      ord.forEach((n,r)=>{ comb[n]+=w[e]*(NUMS-1-r)/(NUMS-1); });
    }
    const ord=rankOrder(comb,seed);
    out.fields.push({
      pick: ord.slice(0,PICK).sort((a,b)=>a-b),
      rank: ord,
      score: Array.from(comb).slice(1).map(v=>+v.toFixed(4)),
      weights: w.map(v=>+v.toFixed(4)),
      expertPicks
    });
  }
  return out;
}

const hitsOf=(pick,actual)=>pick.reduce((a,n)=>a+(actual.includes(n)?1:0),0);

// Учёт фактического тиража: сначала оцениваем методы по их прогнозу, потом копим статистику.
export function update(st, draw, pred){
  const P=st.params;
  if(!pred) pred=predict(st);
  for(let fi=0;fi<2;fi++){
    const F=st.fields[fi], act=draw.f[fi];
    if(st.t>=P.warmup){
      for(let e=0;e<E;e++){
        const h=hitsOf(pred.fields[fi].expertPicks[e],act);
        F.perf[e]=F.perf[e]*P.perfDecay+(h-BASE_HITS);
        F.tot[e]+=h;
      }
      F.cnt++;
    }
  }
  // статистика
  for(let fi=0;fi<2;fi++){
    const F=st.fields[fi], act=draw.f[fi], O=draw.f[1-fi];
    // затухание переходов
    const d=P.transDecay;
    if(st.prev){
      for(let a=1;a<=NUMS;a++){ const r1=F.trans[a], r2=F.cross[a]; for(let b=1;b<=NUMS;b++){ r1[b]*=d; r2[b]*=d; } }
      for(const a of st.prev.f[fi]) for(const b of act) F.trans[a][b]+=1;
      for(const a of st.prev.f[1-fi]) for(const b of act) F.cross[a][b]+=1;
    }
    for(const n of act){
      if(F.lastSeen[n]>=0){ const g=st.t-F.lastSeen[n]; F.gapMean[n]=F.gapMean[n]*0.9+g*0.1; }
      F.lastSeen[n]=st.t;
    }
    F.hist.push(act); for(const n of act) F.hotCount[n]++;
    if(F.hist.length>P.hotWindow){ const old=F.hist.shift(); for(const n of old) F.hotCount[n]--; }
  }
  st.prev2=st.prev; st.prev=draw; st.t++;
}

// Прогон по архиву «вперёд». Возвращает состояние после последнего тиража и
// журнал ставок, которые алгоритм сделал бы на каждый тираж.
export function replay(draws, params=PARAMS, onStep){
  const st=createState(params);
  const log=[];
  for(const d of draws){
    const pred=predict(st);
    if(st.t>=params.warmup){
      const p1=pred.fields[0].pick, p2=pred.fields[1].pick;
      const h1=hitsOf(p1,d.f[0]), h2=hitsOf(p2,d.f[1]);
      const row={no:d.no, at:d.at, p:[p1,p2], h:[h1,h2], pay:prizeOf(h1,h2), jp:isJackpot(h1,h2)};
      log.push(row);
      if(onStep) onStep(row,pred,st,d);
    }
    update(st,d,pred);
  }
  return {state:st, log};
}

// Сводка по ставкам (одна ставка 4+4 = 50 ₽ на тираж).
export function summarize(rows){
  const n=rows.length, cats={}; let pay=0, wins=0, jp=0, hitSum=[0,0];
  for(const r of rows){
    hitSum[0]+=r.h[0]; hitSum[1]+=r.h[1];
    const key=`${r.h[0]}+${r.h[1]}`;
    if(r.jp){ jp++; wins++; cats['4+4']=(cats['4+4']||0)+1; continue; }
    if(r.pay>0){ wins++; pay+=r.pay; cats[key]=(cats[key]||0)+1; }
  }
  return {
    n, wins, jp, pay, spent:n*TICKET, cats,
    avgHits:n?[hitSum[0]/n,hitSum[1]/n]:[0,0],
    expWins:n*WIN_CHANCE, expPay:n*FIXED_EV
  };
}

export {hitsOf};
