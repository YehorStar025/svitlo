// Світло — віджет графіка відключень для Scriptable (iPhone)
// Розміри: екран блокування (прямокутний, круглий, рядок над годинником), малий і середній на робочому столі.
// Натискання на віджет відкриває повний графік на сьогодні й завтра.

// ===== НАЛАШТУВАННЯ =====
const GITHUB_USER = 'YehorStar025';      // логін на GitHub
const REPO = 'svitlo';
const GROUP = '7.1';
const PLACE = 'Оболонь';
const WARN_MIN = 20;                     // за скільки хвилин попереджати про відключення
const RETURN_WARN_MIN = 30;              // за скільки хвилин попереджати, що дадуть світло (0 = вимкнути)
const NOTIFY_ON_RETURN = true;           // сповіщення в момент, коли за графіком мають дати світло
const AUTO_UPDATE = true;                // скрипт сам підтягує нову версію з GitHub
// ========================

const URL = `https://raw.githubusercontent.com/${GITHUB_USER}/${REPO}/main/data/${GROUP}.json`;
const C = {
  on: new Color('#6EE7B7'), onDim: new Color('#3E7F6E'),
  off: new Color('#F7969A'), offDim: new Color('#8A5560'),
  maybe: new Color('#F5C969'), maybeDim: new Color('#8C7A45'),
  text: new Color('#F4F5FA'), sub: new Color('#A9AEC2'), mark: Color.white(),
};
const LABEL = { 1: 'Є світло', 0: 'Немає світла', 2: 'Можливе відключення' };

// ---------- дані ----------
const fm = FileManager.local();
const cachePath = fm.joinPath(fm.documentsDirectory(), `svitlo-${GROUP}.json`);

async function loadData() {
  try {
    const r = new Request(`${URL}?t=${Math.floor(Date.now() / 300000)}`); // обхід кешу раз на 5 хв
    r.timeoutInterval = 10;
    const d = await r.loadJSON();
    if (!d?.days) throw new Error('bad');
    d.fetchedAt = Date.now();
    fm.writeString(cachePath, JSON.stringify(d));
    return d;
  } catch (e) {
    if (fm.fileExists(cachePath)) { const d = JSON.parse(fm.readString(cachePath)); d.offline = true; return d; }
    return null;
  }
}

const pad = (n) => String(n).padStart(2, '0');
const hm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const parseDtek = (s) => { // "17:36 06.11.2026"
  const m = s?.match(/(\d\d):(\d\d) (\d\d)\.(\d\d)\.(\d{4})/);
  return m ? new Date(+m[5], +m[4] - 1, +m[3], +m[1], +m[2]) : null;
};

// Перетворює дані в слоти по 30 хв і злиті відрізки {start, end, v}.
function buildTimeline(data) {
  const slots = [];
  for (const day of data.days) {
    const [y, mo, d] = day.date.split('-').map(Number);
    for (let i = 0; i < 48; i++) {
      slots.push({ t: new Date(y, mo - 1, d, 0, i * 30), v: Number(day.s[i]) });
    }
  }
  slots.sort((a, b) => a.t - b.t);
  // Фактичне відключення по будинку важливіше за графік
  const now = data.now;
  if (now?.off) {
    const from = parseDtek(now.from), to = parseDtek(now.to);
    if (from && to) for (const s of slots) {
      const e = new Date(s.t.getTime() + 30 * 60000);
      if (e > from && s.t < to) s.v = 0;
    }
  }
  const segs = [];
  for (const s of slots) {
    const end = new Date(s.t.getTime() + 30 * 60000);
    const last = segs[segs.length - 1];
    if (last && last.v === s.v && last.end.getTime() === s.t.getTime()) last.end = end;
    else segs.push({ start: s.t, end, v: s.v });
  }
  return { slots, segs };
}

function analyze(data) {
  const { slots, segs } = buildTimeline(data);
  const now = new Date();
  const i = segs.findIndex((s) => s.start <= now && now < s.end);
  if (i < 0) return { unknown: true, slots, segs };
  const cur = segs[i];
  const after = segs.slice(i + 1);
  // кінець «темного» періоду: зливаємо підряд 0 і 2
  const offRunEnd = (k) => { let e = segs[k].end; for (let j = k + 1; j < segs.length && segs[j].v !== 1; j++) e = segs[j].end; return e; };
  let headline;
  if (cur.v === 1) {
    const k = segs.findIndex((s, j) => j > i && s.v === 0);
    headline = k > 0
      ? { label: 'Наступне відключення', big: hm(segs[k].start), small: `до ${hm(offRunEnd(k))}`, at: segs[k].start }
      : { label: 'Відключень не заплановано', big: '—', small: '', at: null };
  } else if (cur.v === 0) {
    const nxt = after[0];
    headline = { label: 'Світло дадуть', big: hm(cur.end), at: cur.end,
      small: nxt?.v === 2 ? `точно з ${hm(nxt.end)}` : '' };
  } else {
    headline = { label: 'Можливе відключення', big: `до ${hm(cur.end)}`, small: '', at: cur.end };
  }
  const maybeNext = after.find((s) => s.v === 2 && s.start.toDateString() === now.toDateString());
  return { cur, headline, maybeNext, slots, segs, now };
}

// ---------- малювання смуги ----------
function drawBar(slots, day, w, h, mono) {
  const ctx = new DrawContext();
  ctx.size = new Size(w, h + 6);
  ctx.opaque = false;
  ctx.respectScreenScale = true;
  const now = new Date();
  const daySlots = slots.filter((s) => s.t.toDateString() === day.toDateString());
  const sw = w / 48, gap = 1.2;
  daySlots.forEach((s) => {
    const idx = s.t.getHours() * 2 + (s.t.getMinutes() >= 30 ? 1 : 0);
    const past = new Date(s.t.getTime() + 30 * 60000) <= now;
    let col;
    if (mono) col = new Color('#FFFFFF', s.v === 1 ? 1 : s.v === 2 ? 0.5 : 0.18);
    else col = s.v === 1 ? (past ? C.onDim : C.on) : s.v === 0 ? (past ? C.offDim : C.off) : (past ? C.maybeDim : C.maybe);
    const p = new Path();
    const narrow = s.v === 2 && !mono; // «можливо» — тонкі смужки, як на макеті
    const x = idx * sw + gap / 2, bw = narrow ? Math.max(sw * 0.45, 1.5) : sw - gap;
    p.addRoundedRect(new Rect(narrow ? x + (sw - gap - bw) / 2 : x, 3, bw, h), 1.5, 1.5);
    ctx.addPath(p); ctx.setFillColor(col); ctx.fillPath();
  });
  if (day.toDateString() === now.toDateString()) {
    const x = ((now.getHours() * 60 + now.getMinutes()) / 1440) * w;
    const p = new Path();
    p.addRoundedRect(new Rect(x - 1, 0, 2, h + 6), 1, 1);
    ctx.addPath(p); ctx.setFillColor(C.mark); ctx.fillPath();
  }
  return ctx.getImage();
}

// ---------- віджети ----------
function txt(stack, s, size, color, weight = 'medium') {
  const fonts = { regular: Font.regularRoundedSystemFont, medium: Font.mediumRoundedSystemFont,
    semibold: Font.semiboldRoundedSystemFont, bold: Font.boldRoundedSystemFont };
  const t = stack.addText(s);
  t.font = fonts[weight](size); t.textColor = color; t.lineLimit = 1; t.minimumScaleFactor = 0.6;
  return t;
}

function bg(w) {
  const g = new LinearGradient();
  g.colors = [new Color('#1E2436'), new Color('#2B3150')];
  g.locations = [0, 1];
  g.startPoint = new Point(0, 0); g.endPoint = new Point(1, 1);
  w.backgroundGradient = g;
}

function footerLeft(a, data) {
  if (a.maybeNext) return `${hm(a.maybeNext.start)}–${hm(a.maybeNext.end)} · можливе відключення`;
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
  const t = data.days.find((d) => { const [y, m, dd] = d.date.split('-').map(Number); return new Date(y, m - 1, dd).toDateString() === tomorrow.toDateString(); });
  if (!t) return 'Графіка на завтра ще немає';
  const offH = [...t.s].filter((c) => c === '0').length / 2;
  return offH ? `Завтра без світла ${String(offH).replace('.', ',')} год` : 'Завтра без відключень';
}
const checkedText = (data) => `${data.offline ? '⚠︎ офлайн · ' : 'Оновлено '}${hm(new Date(data.fetchedAt))}`;

function homeWidget(a, data, family) {
  const w = new ListWidget();
  bg(w);
  w.setPadding(14, 16, 12, 16);
  const medium = family !== 'small';

  const top = w.addStack(); top.centerAlignContent();
  txt(top, medium ? `${PLACE} · ${GROUP}` : GROUP, 13, C.sub);
  top.addSpacer();
  const dotCol = a.cur.v === 1 ? C.on : a.cur.v === 0 ? C.off : C.maybe;
  txt(top, '● ', 10, dotCol);
  txt(top, medium ? LABEL[a.cur.v] : (a.cur.v === 1 ? 'Є' : a.cur.v === 0 ? 'Немає' : '?'), 13, C.text);

  w.addSpacer(medium ? 6 : 4);
  txt(w, a.headline.label, medium ? 13 : 11, C.sub);
  const row = w.addStack(); row.bottomAlignContent();
  txt(row, a.headline.big, medium ? 40 : 30, C.text, 'bold');
  if (a.headline.small && medium) { row.addSpacer(8); const s = row.addStack(); s.setPadding(0, 0, 6, 0); txt(s, a.headline.small, 18, C.sub); }
  if (!medium && a.headline.small) txt(w, a.headline.small, 12, C.sub);

  w.addSpacer();
  const W = medium ? 306 : 128;
  const img = w.addImage(drawBar(a.slots, new Date(), W, medium ? 9 : 8, false));
  img.imageSize = new Size(W, medium ? 15 : 14);
  if (medium) {
    const ax = w.addStack();
    ['00', '06', '12', '18', '24'].forEach((h, k) => { if (k) ax.addSpacer(); txt(ax, h, 11, C.sub, 'regular'); });
    w.addSpacer(3);
    const f = w.addStack();
    txt(f, footerLeft(a, data), 11, C.sub, 'regular');
    f.addSpacer();
    txt(f, checkedText(data), 11, C.sub, 'regular');
  }
  return w;
}

function lockRect(a) {
  const w = new ListWidget();
  w.addAccessoryWidgetBackground = false;
  const r1 = w.addStack(); r1.centerAlignContent();
  txt(r1, a.cur.v === 1 ? '⚡︎ Є світло' : a.cur.v === 0 ? '◌ Без світла' : '◐ Можливе відкл.', 14, Color.white(), 'bold');
  const r2 = w.addStack(); r2.centerAlignContent();
  if (a.headline.at) {
    txt(r2, a.cur.v === 1 ? `вимкнуть о ${a.headline.big} · ` : `дадуть о ${hm(a.headline.at)} · `, 12, Color.white(), 'medium');
    const d = r2.addDate(a.headline.at);
    d.applyTimerStyle(); d.font = Font.mediumRoundedSystemFont(12); d.textColor = Color.white(); d.lineLimit = 1;
  } else txt(r2, 'відключень не заплановано', 12, Color.white());
  w.addSpacer(4);
  const img = w.addImage(drawBar(a.slots, new Date(), 150, 7, true));
  img.imageSize = new Size(150, 13);
  return w;
}

function lockCircular(a) {
  const w = new ListWidget();
  w.addAccessoryWidgetBackground = true;
  const s = w.addStack(); s.layoutVertically(); s.centerAlignContent();
  txt(s, a.cur.v === 1 ? 'вимк.' : a.cur.v === 0 ? 'дадуть' : 'можл.', 10, Color.white());
  txt(s, a.headline.at ? hm(a.headline.at) : '—', 15, Color.white(), 'bold');
  return w;
}

function lockInline(a) {
  const w = new ListWidget();
  const t = a.cur.v === 1 ? (a.headline.at ? `⚡︎ світло до ${hm(a.headline.at)}` : '⚡︎ світло є')
    : a.cur.v === 0 ? `◌ світло о ${hm(a.headline.at)}` : `◐ можливе до ${hm(a.headline.at)}`;
  w.addText(t);
  return w;
}

function errorWidget(msg) {
  const w = new ListWidget(); bg(w);
  txt(w, 'Світло', 13, C.sub); w.addSpacer(4); txt(w, msg, 13, C.text);
  return w;
}

// ---------- сповіщення ----------
async function scheduleNotifications(a) {
  try {
    const pending = await Notification.allPending();
    const old = pending.filter((n) => (n.identifier || '').startsWith('svitlo-')).map((n) => n.identifier);
    if (old.length) Notification.removePending(old);
    const now = Date.now();
    for (let k = 1; k < a.segs.length; k++) {
      const s = a.segs[k], prev = a.segs[k - 1];
      if (s.start - now > 36 * 3600e3) break;
      if (s.v === 0 && prev.v !== 0) {
        let end = s.end; for (let j = k + 1; j < a.segs.length && a.segs[j].v !== 1; j++) end = a.segs[j].end;
        const at = new Date(s.start.getTime() - WARN_MIN * 60000);
        if (at.getTime() <= now) continue;
        const n = new Notification();
        n.identifier = `svitlo-off-${s.start.getTime()}`;
        n.threadIdentifier = 'svitlo';
        n.title = `Через ${WARN_MIN} хв вимкнуть світло`;
        n.body = `За графіком ${hm(s.start)}–${hm(end)} · черга ${GROUP}`;
        n.setTriggerDate(at);
        await n.schedule();
      }
      if (RETURN_WARN_MIN > 0 && s.v === 1 && prev.v !== 1) {
        const at = new Date(s.start.getTime() - RETURN_WARN_MIN * 60000);
        if (at.getTime() > now) {
          const n = new Notification();
          n.identifier = `svitlo-soon-${s.start.getTime()}`;
          n.threadIdentifier = 'svitlo';
          n.title = `Через ${RETURN_WARN_MIN} хв мають дати світло`;
          n.body = `За графіком о ${hm(s.start)} · черга ${GROUP}`;
          n.setTriggerDate(at);
          await n.schedule();
        }
      }
      if (NOTIFY_ON_RETURN && s.v === 1 && prev.v !== 1 && s.start.getTime() > now) {
        const n = new Notification();
        n.identifier = `svitlo-on-${s.start.getTime()}`;
        n.threadIdentifier = 'svitlo';
        n.title = 'За графіком світло вже мають дати';
        n.body = `Повернення о ${hm(s.start)} · черга ${GROUP}`;
        n.setTriggerDate(s.start);
        await n.schedule();
      }
    }
  } catch (e) { console.warn('Сповіщення: ' + e); }
}

// ---------- повний графік (при натисканні) ----------
async function showDetails(a, data) {
  const days = data.days.map((d) => { const [y, m, dd] = d.date.split('-').map(Number); return new Date(y, m - 1, dd); });
  const now = new Date();
  const colour = { 1: '#6EE7B7', 0: '#F7969A', 2: '#F5C969' };
  const name = { 1: 'світло є', 0: 'немає світла', 2: 'можливе відключення' };
  const sections = days.map((day) => {
    const segs = a.segs.filter((s) => s.start.toDateString() === day.toDateString());
    const title = day.toDateString() === now.toDateString() ? 'Сьогодні' : 'Завтра';
    const bar = segs.map((s) => `<i style="flex:${(s.end - s.start) / 1800000};background:${colour[s.v]};opacity:${s.end <= now ? .45 : 1}"></i>`).join('');
    const nowPct = title === 'Сьогодні' ? (now.getHours() * 60 + now.getMinutes()) / 14.4 : -1;
    const list = segs.map((s) => `<li class="${s.end <= now ? 'past' : ''}${s.start <= now && now < s.end ? ' cur' : ''}"><b style="background:${colour[s.v]}"></b>${hm(s.start)}–${s.end.getHours() === 0 && s.end.getMinutes() === 0 ? '24:00' : hm(s.end)}<span>${name[s.v]}</span></li>`).join('');
    return `<h2>${title}, ${pad(day.getDate())}.${pad(day.getMonth() + 1)}</h2>
      <div class="bar">${bar}${nowPct >= 0 ? `<em style="left:${nowPct}%"></em>` : ''}</div>
      <div class="ax"><span>00</span><span>06</span><span>12</span><span>18</span><span>24</span></div><ul>${list}</ul>`;
  }).join('');
  const html = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    body{margin:0;padding:20px 18px 40px;background:#1E2436;color:#F4F5FA;font:16px -apple-system,system-ui;}
    h1{font-size:15px;color:#A9AEC2;font-weight:500;margin:0 0 4px} .big{font-size:30px;font-weight:700;margin:0 0 6px}
    h2{font-size:17px;margin:26px 0 10px} .bar{position:relative;display:flex;gap:2px;height:16px}
    .bar i{border-radius:4px} .bar em{position:absolute;top:-4px;bottom:-4px;width:2px;background:#fff;border-radius:1px}
    .ax{display:flex;justify-content:space-between;color:#A9AEC2;font-size:12px;margin-top:6px}
    ul{list-style:none;padding:0;margin:12px 0 0} li{display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid #ffffff12;font-variant-numeric:tabular-nums}
    li b{width:10px;height:10px;border-radius:50%} li span{margin-left:auto;color:#A9AEC2;font-size:14px}
    li.past{opacity:.45} li.cur{font-weight:700} .foot{color:#A9AEC2;font-size:13px;margin-top:22px}
  </style>
  <h1>${PLACE} · черга ${GROUP} · ${LABEL[a.cur.v].toLowerCase()}</h1>
  <div class="big">${a.headline.label}: ${a.headline.big} ${a.headline.small}</div>
  ${sections}
  <div class="foot">${checkedText(data)} · джерело: ${data.source === 'dtek' ? 'ДТЕК' : 'YASNO'}${data.sourceUpdated ? ', графік від ' + data.sourceUpdated : ''}${data.now?.reason && data.now.off ? '<br>' + data.now.reason : ''}<br>Сповіщення: за ${WARN_MIN} хв до відключення</div>`;
  const wv = new WebView();
  await wv.loadHTML(html);
  await wv.present(true);
}

// ---------- самооновлення (раз на 6 год) ----------
async function selfUpdate() {
  try {
    const stamp = fm.joinPath(fm.documentsDirectory(), 'svitlo-update-check');
    const last = fm.fileExists(stamp) ? Number(fm.readString(stamp)) : 0;
    if (Date.now() - last < 6 * 3600e3) return;
    fm.writeString(stamp, String(Date.now()));
    const r = new Request(`https://raw.githubusercontent.com/${GITHUB_USER}/${REPO}/main/${encodeURIComponent('Світло.js')}?t=${Date.now()}`);
    r.timeoutInterval = 10;
    const code = await r.loadString();
    if (code.length < 2000 || !code.startsWith('// Світло — віджет')) return;
    const own = module.filename;
    const ownFm = own.includes('iCloud') || own.includes('Mobile Documents') ? FileManager.iCloud() : fm;
    if (ownFm.readString(own) !== code) ownFm.writeString(own, code);
  } catch (e) { console.warn('Самооновлення: ' + e); }
}

// ---------- запуск ----------
if (AUTO_UPDATE) await selfUpdate();
const data = await loadData();
const family = config.widgetFamily || 'medium';
let widget, shown = false;
if (!data) widget = errorWidget('Немає даних. Перевір інтернет або логін GitHub у налаштуваннях скрипта.');
else {
  const a = analyze(data);
  if (a.unknown) widget = errorWidget('Графік на сьогодні ще не опубліковано.');
  else {
    await scheduleNotifications(a);
    widget = family === 'accessoryRectangular' ? lockRect(a)
      : family === 'accessoryCircular' ? lockCircular(a)
      : family === 'accessoryInline' ? lockInline(a)
      : homeWidget(a, data, family);
    // оновитися на найближчій зміні стану або через 15 хв
    const nextChange = a.cur.end.getTime();
    widget.refreshAfterDate = new Date(Math.min(nextChange + 30000, Date.now() + 15 * 60000));
    if (config.runsInApp) { await showDetails(a, data); shown = true; }
  }
}
widget.url = URLScheme.forRunningScript();
if (config.runsInWidget) Script.setWidget(widget);
else if (!shown) await widget.presentMedium();
Script.complete();
