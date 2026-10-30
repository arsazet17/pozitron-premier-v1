import {EXPERTS,PRIZES,PRIZE_ORDER,catChance,TICKET,FIXED_EV,WIN_CHANCE,pad6} from './engine.js';

const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
const nf=new Intl.NumberFormat('ru-RU');
const rub=n=>nf.format(Math.round(n||0))+' ₽';
const dec=(x,d=2)=>(+x).toFixed(d).replace('.',',');
const pct=x=>dec(x*100,1)+'%';
const oneIn=p=>p>0?'1 из '+nf.format(p<0.01?Math.round(1/p):+(1/p).toFixed(1)):'—';
const esc=s=>String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
const fmtAt=at=>{if(!at) return '—';const [d,t]=at.split('T');const [,m,dd]=d.split('-');return `${dd}.${m} ${t}`};
const EX=Object.fromEntries(EXPERTS.map(e=>[e.key,e]));

let S=null, aiField=0, scoreKey='d', tblField=0, tblRows=30;

async function load(){
  const r=await fetch('./data/app-state.json?v='+Date.now(),{cache:'no-store'});
  if(!r.ok) throw new Error('app-state HTTP '+r.status);
  return r.json();
}

const ball=(n,f,cls='')=>`<span class="ball f${f+1} ${cls}">${n}</span>`;

// Шары тиража с отметками AI-ставки
function drawBalls(actual,pick,f){
  return `<div class="balls">${[...actual].sort((a,b)=>a-b).map(n=>ball(n,f,pick?.includes(n)?'hitb':'')).join('')}</div>`;
}

function renderHome(){
  const L=S.last, T=S.target, F=S.forecast;
  $('#lastDraw').textContent=`№${pad6(L.no)} · ${fmtAt(L.at)}`;
  $('#lastBalls').innerHTML=L.f.map((x,f)=>`<div class="balls">${[...x].sort((a,b)=>a-b).map(n=>ball(n,f)).join('')}</div>`).join('');
  $('#nextDraw').textContent=`№${pad6(T.no)} · ${T.at.slice(11,16)}`;
  $('#betTarget').textContent=`№${pad6(F.no)} · ${F.at.slice(11,16)}`;
  $('#fixedNote').textContent=F.locked&&F.fixedAt
    ?`🔒 Ставка зафиксирована в ${new Date(F.fixedAt).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit',timeZone:'Europe/Moscow'})}`
    :'⏳ Ставка ещё не зафиксирована — это предварительный расчёт';
  tick();
  $('#pick1').innerHTML=F.fields[0].pick.map(n=>ball(n,0)).join('');
  $('#pick2').innerHTML=F.fields[1].pick.map(n=>ball(n,1)).join('');
  const chips=a=>a.map(n=>`<span class="chip">${n}</span>`).join('');
  $('#reserve').innerHTML=F.fields.map((x,i)=>`<div>Запасные П${i+1}: ${chips(x.rank8.slice(4))}</div>`).join('');
  const jp=S.meta.jackpot;
  const lead=F.fields.map(x=>EX[x.lead]);
  $('#betInfo').innerHTML=`Билет <b>${rub(S.meta.ticketPrice||TICKET)}</b> · выигрыш примерно <b>${oneIn(WIN_CHANCE)}</b> тиражей (${pct(WIN_CHANCE)})`+
    (jp?`<br>Суперприз 4+4: <b>${rub(jp)}</b>`:'')+
    `<br>Ведут: ${lead[0].icon} ${lead[0].name} (поле 1) · ${lead[1].icon} ${lead[1].name} (поле 2)`;
  renderAI(); renderScore(); renderLast();
}

function tick(){
  if(!S) return;
  const ms=new Date(`${S.target.at}:00+03:00`)-Date.now();
  const m=Math.round(ms/60000);
  $('#countdown').textContent=ms>0?`⏱ через ${m<1?'меньше минуты':m+' мин'}`:'⏱ тираж идёт — ждём результат';
}

function renderAI(){
  const rows=S.experts[aiField];
  const w=S.forecast.fields[aiField].weights;
  const maxW=Math.max(...w);
  const base=S.baseline.hits;
  const cls=x=>x>base+0.005?'up':x<base-0.005?'down':'';
  $('#aiList').innerHTML=rows.map((r,i)=>{
    const e=EX[r.key], lead=w[i]===maxW;
    return `<div class="ai-row${lead?' lead':''}">
      <div class="nm"><b>${e.icon} ${esc(e.name)}${lead?' 👑':''}</b><span>${esc(e.note)}</span></div>
      <div class="wcell"><div class="wbar"><i style="width:${Math.max(3,w[i]/maxW*100)}%"></i></div><span>${dec(w[i]*100,0)}%</span></div>
      <div class="num ${cls(r.d)}">${dec(r.d)}</div>
      <div class="num ${cls(r.w7)}">${dec(r.w7)}</div>
    </div>`;
  }).join('');
  $('#aiNote').innerHTML=`Цифры — сколько чисел из 4 угадывает метод в среднем за тираж. Случайная ставка угадывает <b>${dec(base)}</b>. После каждого тиража методы, угадавшие больше, получают больший вес, слабые — меньший. Память — около 33 последних тиражей.`;
}

function renderScore(){
  const s=S.backtest[scoreKey];
  if(!s||!s.n){$('#score').innerHTML='<div class="small">Пока нет данных</div>';return}
  const net=s.pay-s.spent;
  const cats=PRIZE_ORDER.filter(k=>s.cats[k]).map(k=>`<span class="cat">${k} <b>×${s.cats[k]}</b></span>`).join('');
  $('#score').innerHTML=`
    <div class="score-row"><span>Ставок по 50 ₽<span class="small">потрачено ${rub(s.spent)}</span></span><b>${nf.format(s.n)}</b></div>
    <div class="score-row"><span>Выигрышей<span class="small">у случайной ставки было бы ≈ ${nf.format(Math.round(s.expWins))}</span></span><b class="${s.wins>=s.expWins?'ok':''}">${nf.format(s.wins)}</b></div>
    <div class="score-row"><span>Выплачено<span class="small">в среднем у случайной ≈ ${rub(s.expPay)}</span></span><b class="gold">${rub(s.pay)}</b></div>
    <div class="score-row"><span>Итог<span class="small">возврат ${pct(s.pay/s.spent)} (норма лотереи ≈ ${pct(FIXED_EV/TICKET)})</span></span><b class="${net>=0?'ok':'red'}">${net>=0?'+':''}${rub(net)}</b></div>
    <div class="score-row"><span>Угадано чисел в среднем<span class="small">случайная ставка — ${dec(S.baseline.hits)} в каждом поле</span></span><b>${dec(s.avgHits[0])} / ${dec(s.avgHits[1])}</b></div>
    ${cats?`<div class="cats">${cats}</div>`:''}
    ${s.jp?`<div class="small gold" style="margin-top:6px">🏆 Суперприз 4+4: ${s.jp}</div>`:''}
    <div class="small" style="margin-top:8px">Проверка по архиву: перед каждым тиражом AI видел только прошлые тиражи.</div>`;
  const L=S.live.summary;
  $('#liveScore').innerHTML=L.n
    ?`🔒 <b>Живой счёт</b> (ставки зафиксированы до тиража): ${nf.format(L.n)} ставок · выигрышей <b class="ok">${L.wins}</b> · выплачено <b class="gold">${rub(L.pay)}</b> из ${rub(L.spent)}`
    :'🔒 <b>Живой счёт</b> начнётся после первой проверенной ставки.';
}

function renderLast(){
  $('#lastRows').innerHTML=S.recent.slice(0,20).map(r=>{
    const win=r.pay>0||(r.h[0]===4&&r.h[1]===4);
    return `<div class="lrow">
      <div class="no"><b>${fmtAt(r.at).slice(6)}</b>№${String(r.no).slice(-3)}${r.live?' 🔒':''}</div>
      <div class="fields-mini">${r.f.map((x,f)=>drawBalls(x,r.p[f],f)).join('')}</div>
      <div class="res-badge ${win?'win':'lose'}">${r.h[0]}+${r.h[1]}<span class="small">${win?'+'+rub(r.pay):'мимо'}</span></div>
    </div>`;
  }).join('');
}

function renderTable(){
  const f=tblField, rows=S.recent.slice(0,tblRows);
  const g=$('#grid'); g.className='grid f'+(f+1);
  let h='<div class="h"></div>';
  for(let n=1;n<=20;n++) h+=`<div class="h">${n}</div>`;
  // строка AI на следующий тираж
  const F=S.forecast.fields[f];
  h+=`<div class="row ai"><div class="lab gold">AI</div>`;
  for(let n=1;n<=20;n++){const p=F.pick.includes(n),r=F.rank8.slice(4).includes(n);h+=`<div class="c${p?' pick':r?' res':''}">${p||r?n:''}</div>`}
  h+='</div><div class="sep"></div>';
  rows.forEach((r,i)=>{
    h+=`<div class="lab">${r.at.slice(11,16)}</div>`;
    for(let n=1;n<=20;n++){
      const d=r.f[f].includes(n),a=r.p[f].includes(n);
      let c='c';
      if(d&&a) c+=' hit'; else if(d) c+=' drawn';
      if(a&&!d) c+=' aim';
      if(d&&rows[i-1]?.f[f].includes(n)) c+=' rep';
      h+=`<div class="${c}">${d?n:''}</div>`;
    }
  });
  // низ: задержка и частота за сутки
  const nums=S.numbers[f];
  const maxD=Math.max(...nums.map(x=>x.delay)), maxC=Math.max(...nums.map(x=>x.c96)), minC=Math.min(...nums.map(x=>x.c96));
  h+='<div class="sep"></div><div class="lab">ждёт</div>';
  for(const x of nums) h+=`<div class="foot${x.delay===maxD?' cold':''}">${x.delay}</div>`;
  h+='<div class="lab">сутки</div>';
  for(const x of nums) h+=`<div class="foot${x.c96===maxC?' hot':x.c96===minC?' cold':''}">${x.c96}</div>`;
  g.innerHTML=h;
}

function renderResults(){
  const L=S.live.summary;
  $('#liveSummary').innerHTML=L.n
    ?`<div class="sec-title">🔒 Живой счёт</div>
      <div>Проверено ставок: <b>${nf.format(L.n)}</b> · выигрышей: <b class="ok">${L.wins}</b> (у случайной ≈ ${dec(L.expWins,1)})</div>
      <div>Выплачено <b class="gold">${rub(L.pay)}</b> из ${rub(L.spent)} · итог <b class="${L.pay-L.spent>=0?'ok':'red'}">${L.pay-L.spent>=0?'+':''}${rub(L.pay-L.spent)}</b></div>
      <div class="small">Угадано в среднем: ${dec(L.avgHits[0])} / ${dec(L.avgHits[1])} (случайно ${dec(S.baseline.hits)})</div>`
    :`<div class="sec-title">🔒 Живой счёт</div><div class="small">Ставки фиксируются перед каждым тиражом. Как только пройдёт первый тираж со ставкой — здесь появится результат.</div>`;
  const rows=S.live.rows;
  if(!rows.length){$('#resultsList').innerHTML='';return}
  $('#resultsList').innerHTML=rows.map(e=>{
    const fixed=new Date(e.fixedAt).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit',timeZone:'Europe/Moscow'});
    if(!e.res){
      return `<div class="res-card wait"><div class="res-top"><b>№${pad6(e.no)} · ${fmtAt(e.at)}</b><span class="res-tag">⏳ ждём тираж</span></div>
        ${e.p.map((p,f)=>`<div class="res-line"><span class="bet-label">Поле ${f+1}</span><div class="balls">${p.map(n=>ball(n,f)).join('')}</div></div>`).join('')}
        <div class="res-fact">Зафиксировано в ${fixed}</div></div>`;
    }
    const R=e.res, win=R.pay>0||R.jp;
    return `<div class="res-card ${win?'win':'lose'}">
      <div class="res-top"><b>№${pad6(e.no)} · ${fmtAt(e.at)}</b><span class="res-tag">${win?(R.jp?'🏆 СУПЕРПРИЗ':'✅ +'+rub(R.pay)):'мимо'} · ${R.h[0]}+${R.h[1]}</span></div>
      ${e.p.map((p,f)=>`<div class="res-line"><span class="bet-label">Поле ${f+1}</span><div class="balls">${p.map(n=>ball(n,f,R.f[f].includes(n)?'hitb':'miss-aim')).join('')}</div></div>`).join('')}
      <div class="res-fact">Выпало: ${R.f.map(x=>[...x].sort((a,b)=>a-b).join(' ')).join(' + ')} · зафиксировано в ${fixed}</div>
    </div>`;
  }).join('');
}

function renderRules(){
  $('#prizeRows').innerHTML=PRIZE_ORDER.map(k=>{
    const v=k==='4+4'?(S?.meta?.jackpot?'от '+rub(S.meta.jackpot):'суперприз'):rub(PRIZES[k]);
    return `<tr class="${k==='4+4'?'jprow':''}"><td>${k.replace('+',' + ')}</td><td>${oneIn(catChance(k))}</td><td>${v}</td></tr>`;
  }).join('');
  $('#rulesNote').innerHTML=`Выиграть хоть что-то: <b class="gold">${oneIn(WIN_CHANCE)}</b> (${pct(WIN_CHANCE)}). Чаще всего — 2 + 2 (${oneIn(catChance('2+2'))}).<br>
    В среднем билет за 50 ₽ возвращает ≈ <b>${rub(FIXED_EV)}</b> фиксированными выигрышами (${pct(FIXED_EV/TICKET)}) плюс небольшая доля суперприза.<br>
    Можно отметить больше 4 чисел в поле — это системная ставка: каждая комбинация 4+4 стоит 50 ₽, средний возврат тот же.`;
}

function bindSeg(sel,attr,fn){
  $$(sel+' button').forEach(b=>b.addEventListener('click',()=>{
    $$(sel+' button').forEach(x=>x.classList.toggle('on',x===b));fn(b.dataset[attr]);
  }));
}

function bindNav(){
  $$('.nav button').forEach(b=>b.addEventListener('click',()=>{
    $$('.nav button').forEach(x=>x.classList.toggle('active',x===b));
    $$('.page').forEach(p=>p.classList.toggle('active',p.id===b.dataset.page));
    scrollTo({top:0});
  }));
}

function renderAll(){renderHome();renderTable();renderResults();renderRules()}

async function refresh(){
  try{
    const s=await load();
    if(!S||s.generatedAt!==S.generatedAt){S=s;renderAll()}
  }catch(err){
    console.error(err);
    if(!S) $('#home').insertAdjacentHTML('afterbegin',`<div class="card err">Не удалось загрузить данные: ${esc(err.message)}</div>`);
  }
}

bindNav();
bindSeg('#aiSeg','f',v=>{aiField=+v;renderAI()});
bindSeg('#scoreSeg','k',v=>{scoreKey=v;renderScore()});
bindSeg('#tblField','f',v=>{tblField=+v;renderTable()});
bindSeg('#tblRows','n',v=>{tblRows=+v;renderTable()});
renderRules();
refresh();
setInterval(tick,30000);
setInterval(()=>{if(document.visibilityState==='visible') refresh()},60000);
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible') refresh()});
