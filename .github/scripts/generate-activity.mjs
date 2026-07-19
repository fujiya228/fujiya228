#!/usr/bin/env node
// Self-generated activity card: per-period bars + cumulative line, at daily / weekly / monthly
// granularity, rendered to a committed activity.svg. Source is the contribution calendar (the
// green-squares data) via one light GraphQL query — no per-repo commit scan, so it never trips
// the RESOURCE_LIMITS_EXCEEDED that heavier cards hit on this account. No third-party live service.
//
// Usage:  GITHUB_TOKEN=<pat> node generate-activity.mjs <login> [outfile]
//         node generate-activity.mjs --selftest      # offline render check, no network

const C = {
  bg: '#0d1117', border: '#30363d', title: '#58a6ff',
  label: '#8b949e', value: '#c9d1d9', bar: '#39d353', line: '#58a6ff', base: '#21262d',
};
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmt = (n) => (n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : String(n));
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

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

// The full-year contributionCalendar trips RESOURCE_LIMITS_EXCEEDED on this account, so pull it
// in ~monthly windows (from/to) and stitch. Each window is cheap; a failed window is skipped
// rather than failing the card. `now` is passed in so the render stays deterministic per run.
async function fetchDays(login, token, now) {
  const Q = `query($login:String!,$from:DateTime!,$to:DateTime!){user(login:$login){
    contributionsCollection(from:$from,to:$to){ contributionCalendar{ weeks{ contributionDays{ date contributionCount } } } }}}`;
  // adaptive: fetch a window; if it trips RESOURCE_LIMITS_EXCEEDED, split it in half and retry
  // each half (down to ~a few days) so heavy windows still yield data. Sequential to avoid the
  // concurrency that was getting whole windows throttled.
  const fetchWindow = async (from, to, depth = 0) => {
    try {
      const d = await gql(token, Q, { login, from: from.toISOString(), to: to.toISOString() });
      return d.user.contributionsCollection.contributionCalendar.weeks.flatMap((w) => w.contributionDays);
    } catch (e) {
      if (depth < 4 && (to - from) > 3 * 864e5) {
        const mid = new Date((+from + +to) / 2);
        return [...await fetchWindow(from, mid, depth + 1), ...await fetchWindow(mid, to, depth + 1)];
      }
      console.warn(`skip ${from.toISOString().slice(0, 10)}..${to.toISOString().slice(0, 10)}: ${e.message.slice(0, 60)}`);
      return [];
    }
  };
  const map = new Map(); // dedupe overlapping month boundaries by date
  for (let i = 0; i < 13; i++) {
    const to = new Date(now); to.setUTCMonth(to.getUTCMonth() - i);
    const from = new Date(to); from.setUTCMonth(from.getUTCMonth() - 1);
    for (const d of await fetchWindow(from, to)) map.set(d.date, d.contributionCount);
  }
  return [...map.entries()].map(([date, count]) => ({ date, count })).sort((a, b) => a.date.localeCompare(b.date));
}

// days: [{date:'YYYY-MM-DD', count}] sorted asc -> three {label,values} series
function buildSeries(days) {
  // daily: last 30 days
  const d = days.slice(-30);
  const daily = { values: d.map((x) => x.count), labels: endLabels(d.map((x) => mmdd(x.date))) };

  // weekly: last 13 calendar weeks (7-day chunks aligned to the calendar)
  const weeks = [];
  for (let i = 0; i < days.length; i += 7) {
    const chunk = days.slice(i, i + 7);
    weeks.push({ sum: chunk.reduce((s, x) => s + x.count, 0), start: chunk[0].date });
  }
  const w = weeks.slice(-13);
  const weekly = { values: w.map((x) => x.sum), labels: endLabels(w.map((x) => mmdd(x.start))) };

  // monthly: last 12 months
  const byMonth = new Map();
  for (const x of days) {
    const k = x.date.slice(0, 7); // YYYY-MM
    byMonth.set(k, (byMonth.get(k) || 0) + x.count);
  }
  const m = [...byMonth.entries()].sort((a, b) => a[0].localeCompare(b[0])).slice(-12);
  const monthly = { values: m.map((x) => x[1]), labels: m.map((x) => MONTHS[+x[0].slice(5, 7) - 1]) };

  return { daily, weekly, monthly };
}

const mmdd = (iso) => `${+iso.slice(5, 7)}/${+iso.slice(8, 10)}`;
const endLabels = (arr) => arr.map((v, i) => (i === 0 || i === arr.length - 1 ? v : ''));
const cumsum = (a) => a.reduce((acc, v) => (acc.push((acc.at(-1) || 0) + v), acc), []);

function panel(x, y, w, h, title, series) {
  const { values, labels } = series;
  const n = values.length || 1;
  const total = values.reduce((s, v) => s + v, 0);
  const cum = cumsum(values);
  const maxV = Math.max(...values, 1);
  const maxC = Math.max(cum.at(-1) || 1, 1);
  const chartTop = y + 26, baseline = y + h - 18, chartH = baseline - chartTop;
  const slot = w / n;
  const barW = Math.min(slot * 0.62, 26);

  const bars = values.map((v, i) => {
    const bh = (v / maxV) * chartH;
    const bx = x + i * slot + (slot - barW) / 2;
    return `<rect x="${bx.toFixed(1)}" y="${(baseline - bh).toFixed(1)}" width="${barW.toFixed(1)}" height="${bh.toFixed(1)}" rx="2" fill="${C.bar}"/>`;
  }).join('');

  const pts = cum.map((v, i) => `${(x + i * slot + slot / 2).toFixed(1)},${(baseline - (v / maxC) * chartH).toFixed(1)}`);
  const line = `<polyline points="${pts.join(' ')}" fill="none" stroke="${C.line}" stroke-width="2" stroke-linejoin="round"/>`;
  const [ex, ey] = pts.at(-1).split(',');
  const endDot = `<circle cx="${ex}" cy="${ey}" r="3" fill="${C.line}"/>
    <text x="${(+ex - 6).toFixed(1)}" y="${(+ey - 7).toFixed(1)}" fill="${C.line}" font-size="11" font-weight="600" text-anchor="end">${fmt(total)}</text>`;

  const xlabels = labels.map((l, i) =>
    l ? `<text x="${(x + i * slot + slot / 2).toFixed(1)}" y="${baseline + 13}" fill="${C.label}" font-size="9" text-anchor="middle">${esc(l)}</text>` : '').join('');

  return `<g>
    <text x="${x}" y="${y + 14}" fill="${C.value}" font-size="13" font-weight="600">${esc(title)}</text>
    <text x="${x + w}" y="${y + 14}" fill="${C.label}" font-size="11" text-anchor="end">期間別 ▮  累計 ―  (計 ${fmt(total)})</text>
    <line x1="${x}" y1="${baseline}" x2="${x + w}" y2="${baseline}" stroke="${C.base}"/>
    ${bars}${line}${endDot}${xlabels}
  </g>`;
}

function renderSVG(name, yearTotal, series) {
  const W = 840, PAD = 40, pw = W - PAD * 2, ph = 150, top = 66;
  const H = top + ph * 3 + 16;
  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" fill="none" xmlns="http://www.w3.org/2000/svg" font-family="Segoe UI, Ubuntu, sans-serif">
  <rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="10" fill="${C.bg}" stroke="${C.border}"/>
  <text x="${PAD}" y="38" fill="${C.title}" font-size="18" font-weight="700">${esc(name)} · GitHub Activity</text>
  <text x="${W - PAD}" y="38" fill="${C.label}" font-size="12" text-anchor="end">past year: ${fmt(yearTotal)} contributions</text>
  ${panel(PAD, top, pw, ph, 'Daily · last 30 days', series.daily)}
  ${panel(PAD, top + ph, pw, ph, 'Weekly · last 13 weeks', series.weekly)}
  ${panel(PAD, top + ph * 2, pw, ph, 'Monthly · last 12 months', series.monthly)}
</svg>`;
}

// ---- self-test: offline render with synthetic data ----
if (process.argv.includes('--selftest')) {
  const days = [];
  let dt = new Date('2025-07-01'); // fixed date; selftest only, never runs in prod
  for (let i = 0; i < 370; i++) {
    days.push({ date: dt.toISOString().slice(0, 10), count: (i * 7) % 11 });
    dt = new Date(dt.getTime() + 864e5);
  }
  const s = buildSeries(days);
  const svg = renderSVG('Test', 1234, s);
  const ok = s.daily.values.length === 30 && s.weekly.values.length === 13 &&
    s.monthly.values.length === 12 && svg.includes('GitHub Activity') && svg.includes('<polyline');
  console.log(ok ? 'selftest OK' : 'selftest FAILED', {
    daily: s.daily.values.length, weekly: s.weekly.values.length, monthly: s.monthly.values.length,
  });
  process.exit(ok ? 0 : 1);
}

const [login, outfile = 'activity.svg'] = process.argv.slice(2);
const token = process.env.GITHUB_TOKEN;
if (!login || !token) {
  console.error('usage: GITHUB_TOKEN=<pat> node generate-activity.mjs <login> [outfile]');
  process.exit(1);
}
const days = await fetchDays(login, token, new Date());
const yearTotal = days.reduce((s, x) => s + x.count, 0);
const svg = renderSVG(login, yearTotal, buildSeries(days));
const { writeFileSync } = await import('node:fs');
writeFileSync(outfile, svg);
console.log(`wrote ${outfile}: ${days.length} days, ${yearTotal} contributions`);
