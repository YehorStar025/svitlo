// Посередник: забирає графік відключень для однієї черги й пише крихітний JSON.
// Запускається в GitHub Actions кожні 15 хв. Без залежностей (Node 20+).
//
// Формат виходу data/<черга>.json:
// { group, source, sourceUpdated, checked,
//   days: [{ date: "YYYY-MM-DD", s: "48 символів" }],   // кожен символ = 30 хв
//   now: { off, from, to, reason } | null }               // фактичний стан будинку (якщо задана адреса)
// Символи: 1 = світло є, 0 = світла немає, 2 = можливе відключення.

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';

const GROUP = process.env.GROUP || '7.1';
const STREET = process.env.STREET || '';   // з GitHub Secrets, щоб адреса не світилась у репозиторії
const HOUSE = process.env.HOUSE || '';
const OUT = `data/${GROUP}.json`;
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

const kyivDate = (unixSec) =>
  new Date(unixSec * 1000).toLocaleDateString('sv-SE', { timeZone: 'Europe/Kyiv' }); // YYYY-MM-DD

// Витягує JSON-об'єкт, що йде після `marker`, підрахунком дужок (надійніше за regex).
function extractObject(html, marker) {
  const i = html.indexOf(marker);
  if (i < 0) return null;
  const start = html.indexOf('{', i);
  let depth = 0, inStr = false, esc = false;
  for (let j = start; j < html.length; j++) {
    const c = html[j];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return JSON.parse(html.slice(start, j + 1));
  }
  return null;
}

// Значення ДТЕК по годинах → дві половинки години.
const DTEK_MAP = {
  yes: '11', no: '00', first: '01', second: '10',
  maybe: '22', mfirst: '21', msecond: '12',
};

async function fromDtek() {
  const res = await fetch('https://www.dtek-kem.com.ua/ua/shutdowns', {
    headers: { 'User-Agent': UA, 'Accept-Language': 'uk-UA,uk;q=0.9' },
  });
  const html = await res.text();
  const fact = extractObject(html, 'DisconSchedule.fact');
  if (!fact?.data) throw new Error(`ДТЕК: графік не знайдено (HTTP ${res.status}, ${html.length} байт)`);

  const key = `GPV${GROUP}`;
  const days = Object.keys(fact.data).sort().map((ts) => {
    const hours = fact.data[ts][key];
    if (!hours) return null;
    let s = '';
    for (let h = 1; h <= 24; h++) s += DTEK_MAP[hours[h]] ?? '22';
    return { date: kyivDate(Number(ts)), s };
  }).filter(Boolean);
  if (!days.length) throw new Error(`ДТЕК: немає черги ${key}`);

  let now = null;
  if (STREET && HOUSE) now = await houseStatus(html, res).catch((e) => (console.warn('Статус будинку:', e.message), null));
  return { source: 'dtek', sourceUpdated: fact.update || null, days, now };
}

// Фактичний стан конкретного будинку (той самий запит, що робить сайт після вибору адреси).
async function houseStatus(html, pageRes) {
  const csrf = html.match(/<meta name="csrf-token" content="([^"]+)"/)?.[1];
  const cookies = (pageRes.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');
  const body = new URLSearchParams({
    method: 'getHomeNum',
    'data[0][name]': 'street', 'data[0][value]': STREET,
  });
  const r = await fetch('https://www.dtek-kem.com.ua/ua/ajax', {
    method: 'POST',
    headers: {
      'User-Agent': UA, 'X-Requested-With': 'XMLHttpRequest', 'X-CSRF-Token': csrf || '',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', Cookie: cookies,
      Referer: 'https://www.dtek-kem.com.ua/ua/shutdowns',
    },
    body,
  });
  const j = await r.json();
  const h = j?.data?.[HOUSE];
  if (!h) return null;
  const off = Boolean(h.start_date && h.end_date);
  return { off, from: h.start_date || null, to: h.end_date || null, reason: h.sub_type || null };
}

async function fromYasno() {
  const r = await fetch('https://app.yasno.ua/api/blackout-service/public/shutdowns/regions/25/dsos/902/planned-outages', {
    headers: { 'User-Agent': UA },
  });
  const j = await r.json();
  const g = j[GROUP];
  if (!g) throw new Error('YASNO: немає черги');
  const days = ['today', 'tomorrow'].map((k) => g[k]).filter((d) => d?.slots?.length).map((d) => {
    const arr = Array(48).fill('1');
    for (const sl of d.slots) {
      const v = sl.type === 'NotPlanned' ? '1' : sl.type === 'Definite' ? '0' : '2';
      for (let m = sl.start; m < sl.end; m += 30) arr[Math.floor(m / 30)] = v;
    }
    return { date: d.date.slice(0, 10), s: arr.join('') };
  });
  if (!days.length) throw new Error(`YASNO: графік порожній (${g.today?.status})`);
  return { source: 'yasno', sourceUpdated: g.updatedOn || null, days, now: null };
}

let result = null;
for (const fn of [fromDtek, fromYasno]) {
  try { result = await fn(); break; } catch (e) { console.warn(e.message); }
}
if (!result) { console.error('Жодне джерело не відповіло, лишаю старий файл.'); process.exit(0); }

const out = { group: GROUP, ...result, checked: new Date().toISOString() };

// Пишемо файл лише коли змінився зміст (без поля checked), щоб не плодити коміти.
const strip = (o) => JSON.stringify({ ...o, checked: undefined });
if (existsSync(OUT)) {
  try { if (strip(JSON.parse(readFileSync(OUT, 'utf8'))) === strip(out)) { console.log('Без змін.'); process.exit(0); } } catch {}
}
mkdirSync('data', { recursive: true });
writeFileSync(OUT, JSON.stringify(out));
console.log('Оновлено:', out.source, out.sourceUpdated, out.days.map((d) => d.date).join(', '));
