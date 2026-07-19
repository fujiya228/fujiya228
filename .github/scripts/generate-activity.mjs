#!/usr/bin/env node
// Self-generated activity cards from the GitHub contribution calendar (green-squares data).
// Daily contribution counts are cached in a committed JSON file so old (immutable) history is
// fetched once and later runs only pull the recent window. Renders two static SVGs:
//   activity.svg      last-year view: daily(30d) / weekly(13w) / monthly(12m)
//   activity-all.svg  all-time view:  monthly(all) / yearly
// The full-year (and even single-month) calendar query trips RESOURCE_LIMITS_EXCEEDED on large
// accounts, so ranges are fetched in month windows and any window that still fails is split in
// half recursively. No third-party live service — output is committed SVG + JSON.
//
// Usage:  GITHUB_TOKEN=<pat> node generate-activity.mjs <login> [cacheFile]
//         node generate-activity.mjs --selftest      # offline render check, no network

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';

const C = {
  bg: '#0d1117', border: '#30363d', title: '#58a6ff',
  label: '#8b949e', value: '#c9d1d9', bar: '#39d353', line: '#58a6ff', base: '#21262d',
};
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmt = (n) => (n == null ? '—' : n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : String(n));
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const cumsum = (a) => a.reduce((acc, v) => (acc.push((acc.at(-1) || 0) + v), acc), []);

// ---------- fetch ----------
async function gql(token, query, variables) {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { Authorization: `bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  const json = await res.json();
  if (json.errors) throw new Error('GraphQL: ' + JSON.stringify(json.errors));
  return json.data;
}

const CAL_Q = `query($login:String!,$from:DateTime!,$to:DateTime!){user(login:$login){
  contributionsCollection(from:$from,to:$to){ contributionCalendar{ weeks{ contributionDays{ date contributionCount } } } }}}`;

// fetch one range; on RESOURCE_LIMITS_EXCEEDED split in half until ~3 days, skip if still failing
async function fetchWindow(login, token, from, to, depth = 0) {
  try {
    const d = await gql(token, CAL_Q, { login, from: from.toISOString(), to: to.toISOString() });
    return d.user.contributionsCollection.contributionCalendar.weeks.flatMap((w) => w.contributionDays);
  } catch (e) {
    if (depth < 5 && (to - from) > 3 * 864e5) {
      const mid = new Date((+from + +to) / 2);
      return [...await fetchWindow(login, token, from, mid, depth + 1),
              ...await fetchWindow(login, token, mid, to, depth + 1)];
    }
    console.warn(`skip ${from.toISOString().slice(0, 10)}..${to.toISOString().slice(0, 10)}: ${e.message.slice(0, 60)}`);
    return [];
  }
}

// fetch [fromDate, toDate] as month windows (contributionsCollection caps ranges at 1 year)
async function fetchRange(login, token, fromDate, toDate) {
  const out = new Map();
  let cur = new Date(Date.UTC(fromDate.getUTCFullYear(), fromDate.getUTCMonth(), 1));
  while (cur <= toDate) {
    const next = new Date(cur); next.setUTCMonth(next.getUTCMonth() + 1);
    const from = cur < fromDate ? fromDate : cur;
    const to = next > toDate ? toDate : next;
    for (const d of await fetchWindow(login, token, from, to)) out.set(d.date, d.contributionCount);
    cur = next;
  }
  return out;
}

const createdAt = async (login, token) =>
  new Date((await gql(token, `query($login:String!){user(login:$login){createdAt}}`, { login })).user.createdAt);

// ---------- series ----------
const mmdd = (iso) => `${+iso.slice(5, 7)}/${+iso.slice(8, 10)}`;
const endLabels = (arr) => arr.map((v, i) => (i === 0 || i === arr.length - 1 ? v : ''));

// days: sorted [{date,count}]
function lastYearSeries(days) {
  const d = days.slice(-30);
  const daily = { values: d.map((x) => x.count), labels: endLabels(d.map((x) => mmdd(x.date))) };
  const weeks = [];
  for (let i = 0; i < days.length; i += 7) {
    const chunk = days.slice(i, i + 7);
    if (chunk.length) weeks.push({ sum: chunk.reduce((s, x) => s + x.count, 0), start: chunk[0].date });
  }
  const w = weeks.slice(-13);
  const weekly = { values: w.map((x) => x.sum), labels: endLabels(w.map((x) => mmdd(x.start))) };
  const byMonth = monthTotals(days);
  const m = byMonth.slice(-12);
  const monthly = { values: m.map((x) => x[1]), labels: m.map((x) => MONTHS[+x[0].slice(5, 7) - 1]) };
  return { daily, weekly, monthly };
}

function monthTotals(days) {
  const map = new Map();
  for (const x of days) { const k = x.date.slice(0, 7); map.set(k, (map.get(k) || 0) + x.count); }
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}
function yearTotals(days) {
  const map = new Map();
  for (const x of days) { const k = x.date.slice(0, 4); map.set(k, (map.get(k) || 0) + x.count); }
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

function allTimeSeries(days) {
  const m = monthTotals(days);
  // label only January of each year to mark year boundaries
  const monthly = { values: m.map((x) => x[1]), labels: m.map((x) => (x[0].endsWith('-01') ? x[0].slice(0, 4) : '')) };
  const y = yearTotals(days);
  const yearly = { values: y.map((x) => x[1]), labels: y.map((x) => x[0]) };
  return { monthly, yearly };
}

// ---------- render ----------
function panel(x, y, w, h, title, series) {
  const { values, labels } = series;
  const n = values.length || 1;
  const total = values.reduce((s, v) => s + v, 0);
  const cum = cumsum(values);
  const maxV = Math.max(...values, 1);
  const maxC = Math.max(cum.at(-1) || 1, 1);
  const chartTop = y + 36, baseline = y + h - 20, chartH = baseline - chartTop; // more top room -> no legend overlap
  const slot = w / n;
  const barW = Math.min(slot * 0.62, 26);

  const bars = values.map((v, i) => {
    const bh = (v / maxV) * chartH * 0.92;
    const bx = x + i * slot + (slot - barW) / 2;
    const delay = Math.min(i * 0.012, 1).toFixed(2);
    return `<rect class="bar" style="animation-delay:${delay}s" x="${bx.toFixed(1)}" y="${(baseline - bh).toFixed(1)}" width="${barW.toFixed(1)}" height="${bh.toFixed(1)}" rx="1.5" fill="${C.bar}"/>`;
  }).join('');

  const pts = cum.map((v, i) => `${(x + i * slot + slot / 2).toFixed(1)},${(baseline - (v / maxC) * chartH * 0.85).toFixed(1)}`);
  const line = `<polyline class="cum" pathLength="1" points="${pts.join(' ')}" fill="none" stroke="${C.line}" stroke-width="2" stroke-linejoin="round"/>`;
  const [ex, ey] = pts.at(-1).split(',');
  const endDot = `<g class="end"><circle cx="${ex}" cy="${ey}" r="3" fill="${C.line}"/>
    <text x="${(+ex - 6).toFixed(1)}" y="${(+ey - 7).toFixed(1)}" fill="${C.line}" font-size="11" font-weight="600" text-anchor="end">${fmt(total)}</text></g>`;

  const xlabels = labels.map((l, i) =>
    l ? `<text x="${(x + i * slot + slot / 2).toFixed(1)}" y="${baseline + 13}" fill="${C.label}" font-size="9" text-anchor="middle">${esc(l)}</text>` : '').join('');

  return `<g>
    <text x="${x}" y="${y + 15}" fill="${C.value}" font-size="13" font-weight="600">${esc(title)}</text>
    <text x="${x + w}" y="${y + 15}" fill="${C.label}" font-size="11" text-anchor="end">期間別 ▮   累計 ―</text>
    <line x1="${x}" y1="${baseline}" x2="${x + w}" y2="${baseline}" stroke="${C.base}"/>
    ${bars}${line}${endDot}${xlabels}
  </g>`;
}

function card(name, subtitle, panels) {
  const W = 840, PAD = 40, pw = W - PAD * 2, ph = 156, top = 70;
  const H = top + ph * panels.length + 14;
  const body = panels.map((p, i) => panel(PAD, top + ph * i, pw, ph, p.title, p.series)).join('\n  ');
  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" fill="none" xmlns="http://www.w3.org/2000/svg" font-family="Segoe UI, Ubuntu, sans-serif">
  <style>
    /* auto-play on render — GitHub's img-embedded SVG runs CSS animation but not :hover/JS.
       base state = final, so if animation is unsupported the finished card still shows. */
    .bar{transform-box:fill-box;transform-origin:bottom;animation:grow .9s ease-out backwards}
    .cum{stroke-dasharray:1;animation:draw 1.4s ease-out .25s backwards}
    .end{animation:fade .6s ease-out 1.25s backwards}
    @keyframes grow{from{transform:scaleY(0)}}
    @keyframes draw{from{stroke-dashoffset:1}to{stroke-dashoffset:0}}
    @keyframes fade{from{opacity:0}}
    @media (prefers-reduced-motion:reduce){.bar,.cum,.end{animation:none}}
  </style>
  <rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="10" fill="${C.bg}" stroke="${C.border}"/>
  <text x="${PAD}" y="40" fill="${C.title}" font-size="18" font-weight="700">${esc(name)} · GitHub Activity</text>
  <text x="${W - PAD}" y="40" fill="${C.label}" font-size="12" text-anchor="end">${esc(subtitle)}</text>
  ${body}
</svg>`;
}

const renderYear = (name, total, s) => card(name, `past year: ${fmt(total)} contributions`, [
  { title: 'Daily · last 30 days', series: s.daily },
  { title: 'Weekly · last 13 weeks', series: s.weekly },
  { title: 'Monthly · last 12 months', series: s.monthly },
]);

const renderAll = (name, total, since, s) => card(name, `all time: ${fmt(total)} contributions since ${since}`, [
  { title: 'Monthly · all time', series: s.monthly },
  { title: 'Yearly', series: s.yearly },
]);

// ---------- self-test ----------
if (process.argv.includes('--selftest')) {
  const days = [];
  let dt = new Date('2019-01-01');
  for (let i = 0; i < 2400; i++) { days.push({ date: dt.toISOString().slice(0, 10), count: (i * 7) % 11 }); dt = new Date(+dt + 864e5); }
  const total = days.reduce((s, x) => s + x.count, 0);
  const yr = lastYearSeries(days), all = allTimeSeries(days);
  const a = renderYear('Test', total, yr), b = renderAll('Test', total, '2019', all);
  const ok = yr.daily.values.length === 30 && yr.weekly.values.length === 13 && yr.monthly.values.length === 12 &&
    all.yearly.values.length >= 6 && a.includes('<polyline') && b.includes('all time') && !a.includes('undefined');
  console.log(ok ? 'selftest OK' : 'selftest FAILED', { years: all.yearly.values.length, months: all.monthly.values.length });
  process.exit(ok ? 0 : 1);
}

// ---------- cache: one JSON file per year (past years are immutable -> stable diffs) ----------
function loadCache(dir) {
  const days = {};
  if (existsSync(dir))
    for (const f of readdirSync(dir))
      if (/^\d{4}\.json$/.test(f)) Object.assign(days, JSON.parse(readFileSync(`${dir}/${f}`, 'utf8')).days);
  return days;
}
function saveCache(dir, daysMap) {
  mkdirSync(dir, { recursive: true });
  const byYear = {};
  for (const [date, count] of Object.entries(daysMap)) (byYear[date.slice(0, 4)] ??= {})[date] = count;
  for (const [year, days] of Object.entries(byYear)) {
    const sorted = Object.fromEntries(Object.entries(days).sort((a, b) => a[0].localeCompare(b[0])));
    const body = JSON.stringify({ year, days: sorted }, null, 0);
    const path = `${dir}/${year}.json`;
    if (!existsSync(path) || readFileSync(path, 'utf8') !== body) writeFileSync(path, body); // write only if changed
  }
}

// ---------- main ----------
const [login, cacheDir = '.github/data/contributions'] = process.argv.slice(2);
const token = process.env.GITHUB_TOKEN;
if (!login || !token) { console.error('usage: GITHUB_TOKEN=<pat> node generate-activity.mjs <login> [cacheDir]'); process.exit(1); }

const daysMap = loadCache(cacheDir);
const cachedDates = Object.keys(daysMap).sort();
const now = new Date();
// backfill from account creation on first run; else refetch only the last ~10 days (corrections)
const from = cachedDates.length
  ? new Date(Math.max(+new Date(cachedDates.at(-1)) - 10 * 864e5, +new Date(cachedDates[0])))
  : await createdAt(login, token);
console.log(`fetching ${from.toISOString().slice(0, 10)}..${now.toISOString().slice(0, 10)} (cache: ${cachedDates.length} days)`);
const fresh = await fetchRange(login, token, from, now);
for (const [date, count] of fresh) daysMap[date] = count;

const days = Object.entries(daysMap).map(([date, count]) => ({ date, count })).sort((a, b) => a.date.localeCompare(b.date));
const total = days.reduce((s, x) => s + x.count, 0);
const since = days[0]?.date.slice(0, 4) || '';
const lastYearTotal = days.slice(-365).reduce((s, x) => s + x.count, 0);

saveCache(cacheDir, daysMap);
writeFileSync('activity.svg', renderYear(login, lastYearTotal, lastYearSeries(days)));
writeFileSync('activity-all.svg', renderAll(login, total, since, allTimeSeries(days)));
console.log(`wrote activity.svg + activity-all.svg + ${cacheDir}/*.json: ${days.length} days, ${total} total since ${since}`);
