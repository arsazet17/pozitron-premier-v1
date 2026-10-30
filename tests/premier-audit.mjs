// Проверка цикла «Позитрон Премьер» на копии данных:
//  • ставка фиксируется только до тиража и потом не меняется;
//  • задним числом ставка не создаётся;
//  • попадания и выплаты считаются верно;
//  • ставка совпадает с прогоном AI «вперёд» по архиву (без подглядывания).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {parseArchive, replay, prizeOf, hitsOf, pad6, nextDrawOf, PRIZES, FIELD_P, WIN_CHANCE, FIXED_EV} from '../engine.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fails = 0;
const ok = (cond, msg) => { console.log((cond ? '✓ ' : '✗ ') + msg); if (!cond) fails++; };

// --- Правила
ok(Math.abs(FIELD_P.reduce((a, b) => a + b, 0) - 1) < 1e-12, 'шансы одного поля дают 100%');
ok(Math.abs(WIN_CHANCE - 0.04874) < 1e-4, `шанс выигрыша ≈ 4,87% (${(WIN_CHANCE * 100).toFixed(3)}%)`);
ok(Math.abs(FIXED_EV - 26.2005) < 1e-3, `средний фиксированный выигрыш ≈ 26,20 ₽ (${FIXED_EV.toFixed(4)})`);
ok(prizeOf(2, 2) === 500 && prizeOf(3, 3) === 750 && prizeOf(4, 3) === 50000 && prizeOf(1, 1) === 0 && prizeOf(2, 1) === 0, 'таблица выплат');
ok(Object.keys(PRIZES).length === 16, '16 фиксированных категорий');

// --- Копия данных без последних 3 тиражей
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'premier-audit-'));
fs.cpSync(path.join(ROOT, 'engine.js'), path.join(tmp, 'engine.js'));
fs.mkdirSync(path.join(tmp, 'scripts'));
fs.cpSync(path.join(ROOT, 'scripts', 'premier-cycle.mjs'), path.join(tmp, 'scripts', 'premier-cycle.mjs'));
fs.writeFileSync(path.join(tmp, 'package.json'), '{"type":"module"}');
fs.mkdirSync(path.join(tmp, 'data'));

const fullText = fs.readFileSync(path.join(ROOT, 'data', 'premier-archive.csv'), 'utf8');
const all = parseArchive(fullText);
const hold = all.slice(-3);              // эти тиражи «придут» позже
const lines = fullText.replace(/^﻿/, '').split(/\r?\n/);
const holdNos = new Set(hold.map(d => pad6(d.no)));
fs.writeFileSync(path.join(tmp, 'data', 'premier-archive.csv'),
  '﻿' + lines.filter(l => !holdNos.has(l.split(',')[0])).join('\n'));

const isoUtc = at => new Date(`${at}:00+03:00`).toISOString();
const page = draws => ({docs: draws.slice().reverse().map(d => ({
  number: pad6(d.no), date: isoUtc(d.at), jackpot: 23000000, ticketPrice: 50, ticketCount: 300,
  played: [{lototronId: 0, balls: d.f[0]}, {lototronId: 1, balls: d.f[1]}]
}))});
const PAGE = path.join(tmp, 'page.json');

function run(nowAt, draws) {
  if (draws) fs.writeFileSync(PAGE, JSON.stringify(page(draws))); else fs.rmSync(PAGE, {force: true});
  return execFileSync(process.execPath, [path.join(tmp, 'scripts', 'premier-cycle.mjs'), tmp], {
    env: {...process.env, NOW_ISO: isoUtc(nowAt), LUCKY_PAGE_FILE: PAGE}, encoding: 'utf8'
  });
}
const readJ = f => JSON.parse(fs.readFileSync(path.join(tmp, 'data', f), 'utf8'));
const minus = (at, min) => new Date(new Date(`${at}:00+03:00`).getTime() - min * 60000 + 3 * 3600000).toISOString().slice(0, 16);

const base = all.slice(0, -3);
const lastBase = base.at(-1);
const t1 = nextDrawOf(lastBase);
ok(t1.no === hold[0].no, `следующий тираж — №${pad6(t1.no)}`);

// 1) За 10 минут до тиража — ставка фиксируется
let out = run(minus(t1.at, 10));
let cur = readJ('current-forecast.json');
ok(cur && cur.no === t1.no && cur.locked, 'ставка зафиксирована до тиража');
const expected = replay(base).state;
const {predict} = await import(path.join(tmp, 'engine.js'));
const p = predict(expected);
ok(JSON.stringify(cur.fields.map(f => f.pick)) === JSON.stringify(p.fields.map(f => f.pick)), 'ставка совпадает с прогоном AI по архиву');

// 2) Повторный запуск — ставка не меняется
const fixedAt = cur.fixedAt;
run(minus(t1.at, 5));
cur = readJ('current-forecast.json');
ok(cur.fixedAt === fixedAt, 'повторный запуск не меняет ставку');
ok(readJ('forecast-history.json').length === 1, 'в истории одна ставка');

// 3) Пришёл тираж 1 — проверка; следующая ставка фиксируется заранее
out = run(minus(hold[1].at, 12), [hold[0]]);
let hist = readJ('forecast-history.json');
const e1 = hist.find(e => e.no === hold[0].no);
const h = [hitsOf(e1.p[0], hold[0].f[0]), hitsOf(e1.p[1], hold[0].f[1])];
ok(e1.res && e1.res.h[0] === h[0] && e1.res.h[1] === h[1], `попадания посчитаны верно (${h[0]}+${h[1]})`);
ok(e1.res.pay === prizeOf(h[0], h[1]), `выплата посчитана верно (${e1.res.pay} ₽)`);
cur = readJ('current-forecast.json');
ok(cur.no === hold[1].no, `новая ставка на №${pad6(hold[1].no)}`);

// 4) Тираж 2 пришёл, но запуск опоздал (после времени тиража 3) — задним числом не создаём
out = run(minus(hold[2].at, -2), [hold[0], hold[1]]);
ok(/LATE/.test(out), 'опоздавший запуск не создаёт ставку задним числом');
cur = readJ('current-forecast.json');
ok(cur === null, 'текущей ставки нет');
hist = readJ('forecast-history.json');
ok(hist.length === 2 && hist.every(e => e.res), 'обе ставки проверены, лишних нет');

// 5) Состояние приложения
const st = readJ('app-state.json');
ok(st.live.summary.n === 2, 'живой счёт: 2 ставки');
ok(st.recent[0].live && st.recent[0].no === hold[1].no, 'последний тираж помечен как живой');
ok(st.numbers[0].length === 20 && st.numbers[1].length === 20, 'статистика чисел по обоим полям');
ok(st.backtest.all.n > 30000, `проверка по архиву: ${st.backtest.all.n} ставок`);
const meta = readJ('lottery-meta.json');
ok(meta.jackpot === 23000000, 'джекпот взят со страницы Lucky');

if (process.env.KEEP_DIR) console.log('Данные теста: ' + tmp); else fs.rmSync(tmp, {recursive: true, force: true});
console.log(fails ? `\nОШИБОК: ${fails}` : '\nВсе проверки пройдены');
process.exit(fails ? 1 : 0);
