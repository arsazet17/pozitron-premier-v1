// Цикл обновления «Позитрон Премьер» (запускается в GitHub Actions каждые 15 минут через cron-job.org).
// 1) Добавить новые тиражи со страницы Lucky-numbers в архив.
// 2) Проверить зафиксированные прогнозы (попал / мимо, выплата).
// 3) Прогнать AI по архиву «вперёд» и зафиксировать ставку на следующий тираж (только заранее, задним числом — никогда).
// 4) Собрать data/app-state.json — всё, что показывает приложение.
import fs from 'node:fs';
import path from 'node:path';
import {
  parseArchive, pad6, nextDrawOf, replay, predict, summarize,
  EXPERTS, MODEL_VERSION, hitsOf, prizeOf, isJackpot,
  FIXED_EV, WIN_CHANCE, TICKET, BASE_HITS, NUMS, PARAMS
} from '../engine.js';

export const APP_VERSION = '1.0.0';

const ROOT = path.resolve(process.argv[2] || process.cwd());
const DATA = path.join(ROOT, 'data');
const ARCHIVE = path.join(DATA, 'premier-archive.csv');
const HISTORY = path.join(DATA, 'forecast-history.json');
const CURRENT = path.join(DATA, 'current-forecast.json');
const META = path.join(DATA, 'lottery-meta.json');
const STATE = path.join(DATA, 'app-state.json');
const LUCKY_PAGE = process.env.LUCKY_PAGE_FILE || '/tmp/premier-page1.json';

const readJson = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return structuredClone(fallback); }
};
const writeJson = (file, value, pretty = true) =>
  fs.writeFileSync(file, (pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value)) + '\n', 'utf8');
const nowDate = () => process.env.NOW_ISO ? new Date(process.env.NOW_ISO) : new Date();
const atToDate = at => new Date(`${at}:00+03:00`);

function moscowParts(iso) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Moscow', year: '2-digit', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(new Date(iso));
  const get = t => parts.find(p => p.type === t)?.value;
  return {date: `${get('day')}.${get('month')}.${get('year')}`, time: `${get('hour')}:${get('minute')}`};
}

function fieldsOf(doc) {
  const by = new Map((doc.played || []).map(x => [Number(x.lototronId), (x.balls || []).map(Number)]));
  return [by.get(0), by.get(1)];
}

function mergeLuckyPage() {
  if (!fs.existsSync(LUCKY_PAGE)) {
    console.log('Lucky page file not present: archive merge skipped');
    return;
  }
  const lines = fs.readFileSync(ARCHIVE, 'utf8').replace(/^﻿/, '').split(/\r?\n/).filter(Boolean);
  const header = lines.shift() || 'Номер тиража,Дата,Шары';
  const byNo = new Map();
  for (const line of lines) {
    if (line === 'lucky-numbers.ru') continue;
    const raw = line.split(',')[0]?.trim();
    if (/^\d+$/.test(raw)) byNo.set(Number(raw), line);
  }
  const data = readJson(LUCKY_PAGE, {});
  if (!Array.isArray(data.docs)) throw new Error('Lucky page 1: docs[] missing');
  let added = 0;
  for (const doc of data.docs) {
    const no = Number(doc.number);
    if (!Number.isInteger(no) || no <= 0) continue;
    const [f1, f2] = fieldsOf(doc);
    const ok = f => Array.isArray(f) && f.length === 4 && new Set(f).size === 4 && f.every(x => Number.isInteger(x) && x >= 1 && x <= NUMS);
    if (!ok(f1) || !ok(f2)) throw new Error(`Draw ${doc.number}: invalid 4+4 result`);
    const {date, time} = moscowParts(doc.date);
    const row = `${pad6(no)},${date}, ${time},${f1.join(',')},+,${f2.join(',')}`;
    if (!byNo.has(no)) added++;
    byNo.set(no, row);
  }
  const sorted = [...byNo.entries()].sort((a, b) => b[0] - a[0]).map(([, l]) => l);
  fs.writeFileSync(ARCHIVE, '﻿' + [header, ...sorted, 'lucky-numbers.ru', ''].join('\n'), 'utf8');

  // Джекпот и цена билета — с самого свежего тиража.
  const top = [...data.docs].sort((a, b) => Number(b.number) - Number(a.number))[0];
  if (top) {
    const meta = readJson(META, {});
    meta.jackpot = Number(top.jackpot) || meta.jackpot || null;
    meta.ticketPrice = Number(top.ticketPrice) || TICKET;
    meta.ticketCount = Number(top.ticketCount) || null;
    meta.fromDraw = Number(top.number);
    meta.updatedAt = nowDate().toISOString();
    writeJson(META, meta);
  }
  console.log(`Lucky docs checked: ${data.docs.length} · new draws: ${added} · archive rows: ${sorted.length}`);
}

mergeLuckyPage();

const draws = parseArchive(fs.readFileSync(ARCHIVE, 'utf8'));
if (!draws.length) throw new Error('Архив пуст');
const byNo = new Map(draws.map(d => [d.no, d]));
const last = draws.at(-1);
const target = nextDrawOf(last);
const now = nowDate();
const meta = readJson(META, {jackpot: null, ticketPrice: TICKET});
const history = readJson(HISTORY, []);
let current = readJson(CURRENT, null);

// 1) Проверка зафиксированных прогнозов.
for (const e of history) {
  if (!e || e.res) continue;
  const d = byNo.get(e.no);
  if (!d) continue;
  const h = [hitsOf(e.p[0], d.f[0]), hitsOf(e.p[1], d.f[1])];
  e.res = {f: d.f, h, pay: prizeOf(h[0], h[1]), jp: isJackpot(h[0], h[1]), at: d.at};
  console.log(`CHECKED №${pad6(e.no)}: ${h[0]}+${h[1]} · ${e.res.pay ? 'выигрыш ' + e.res.pay + ' ₽' : 'мимо'}`);
}

// 2) Прогон AI по всему архиву «вперёд» + статистика методов.
const E = EXPERTS.length;
const expHits = [[], []].map(() => Array.from({length: E}, () => []));
const t0 = Date.now();
const {state, log} = replay(draws, PARAMS, (row, pred, st, d) => {
  for (let fi = 0; fi < 2; fi++)
    for (let e = 0; e < E; e++) expHits[fi][e].push(hitsOf(pred.fields[fi].expertPicks[e], d.f[fi]));
});
const pred = predict(state);
console.log(`Replay: ${log.length} ставок за ${Date.now() - t0} мс`);

const leadOf = w => EXPERTS[w.indexOf(Math.max(...w))].key;
const packForecast = p => p.fields.map(f => ({
  pick: f.pick, rank8: f.rank.slice(0, 8), weights: f.weights, lead: leadOf(f.weights),
  expertPicks: f.expertPicks.map(x => [...x].sort((a, b) => a - b))
}));

// 3) Текущая ставка.
if (current && current.no <= last.no) {
  console.log(`CURRENT_CLOSED №${pad6(current.no)}`);
  current = null;
}
if (current && current.no === target.no) {
  console.log(`Ставка на №${pad6(target.no)} уже зафиксирована ${current.fixedAt} — не меняем`);
} else if (now < atToDate(target.at)) {
  current = {
    no: target.no, at: target.at, fixedAt: now.toISOString(), model: MODEL_VERSION,
    locked: true, fields: packForecast(pred)
  };
  history.push({
    no: target.no, at: target.at, fixedAt: current.fixedAt,
    p: current.fields.map(f => f.pick), lead: current.fields.map(f => f.lead)
  });
  console.log(`FORECAST_FIXED №${pad6(target.no)} ${target.at}: ${current.fields[0].pick.join('-')} + ${current.fields[1].pick.join('-')}`);
} else {
  console.log(`LATE: тираж №${pad6(target.no)} (${target.at}) уже должен был пройти — ставку задним числом не создаём`);
}

// 4) Состояние для приложения.
const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
const tail = (a, n) => n ? a.slice(-n) : a;
const r4 = x => +x.toFixed(4);
const periods = {d: 96, w: 672, m: 2880, all: 0};

const backtest = {};
for (const [k, n] of Object.entries(periods)) backtest[k] = summarize(tail(log, n));

const experts = [0, 1].map(fi => EXPERTS.map((x, e) => ({
  key: x.key,
  w: r4(pred.fields[fi].weights[e]),
  d: r4(avg(tail(expHits[fi][e], 96))),
  w7: r4(avg(tail(expHits[fi][e], 672))),
  all: r4(avg(expHits[fi][e]))
})));

const numbers = [0, 1].map(fi => {
  const rank = pred.fields[fi].rank;
  const out = [];
  for (let n = 1; n <= NUMS; n++) {
    let delay = 0;
    for (let i = draws.length - 1; i >= 0 && !draws[i].f[fi].includes(n); i--) delay++;
    const c96 = tail(draws, 96).filter(d => d.f[fi].includes(n)).length;
    const c672 = tail(draws, 672).filter(d => d.f[fi].includes(n)).length;
    out.push({n, delay, c96, c672, rank: rank.indexOf(n) + 1});
  }
  return out;
});

const liveDone = history.filter(e => e?.res);
const liveSummary = summarize(liveDone.map(e => ({h: e.res.h, pay: e.res.pay, jp: e.res.jp})));
const liveSet = new Set(history.map(e => e.no));
const liveByNo = new Map(history.map(e => [e.no, e]));

const recent = tail(log, 120).reverse().map(r => {
  const live = liveByNo.get(r.no);
  const p = live ? live.p : r.p;
  const d = byNo.get(r.no);
  const h = live ? [hitsOf(p[0], d.f[0]), hitsOf(p[1], d.f[1])] : r.h;
  return {no: r.no, at: r.at, f: d.f, p, h, pay: prizeOf(h[0], h[1]), live: liveSet.has(r.no)};
});

const shown = (current && current.no === target.no) ? current : {
  no: target.no, at: target.at, fixedAt: null, model: MODEL_VERSION, locked: false, fields: packForecast(pred)
};

const appState = {
  version: APP_VERSION,
  model: MODEL_VERSION,
  generatedAt: now.toISOString(),
  meta: {jackpot: meta.jackpot ?? null, ticketPrice: meta.ticketPrice || TICKET},
  baseline: {hits: BASE_HITS, winChance: WIN_CHANCE, fixedEv: FIXED_EV},
  archive: {count: draws.length, first: {no: draws[0].no, at: draws[0].at}},
  last: {no: last.no, at: last.at, f: last.f},
  target,
  forecast: shown,
  experts,
  backtest,
  live: {summary: liveSummary, fixed: history.length, rows: tail(history, 150).reverse()},
  recent,
  numbers
};

writeJson(HISTORY, history, false);
writeJson(CURRENT, current);
writeJson(STATE, appState, false);

console.log(`Last draw: №${pad6(last.no)} ${last.at} · ${last.f[0].join('-')} + ${last.f[1].join('-')}`);
console.log(`Next draw: №${pad6(target.no)} ${target.at}`);
console.log(`History: ${history.length} (проверено ${liveDone.length})`);
