#!/usr/bin/env node
// Self-generated GitHub stats card. One cheap GraphQL query -> SVG -> committed to the repo.
// No third-party live service (nothing to get paused/rate-limited), and the query is light
// enough to avoid the "Resource limits for this query exceeded" that killed summary-cards.
//
// Usage:  GITHUB_TOKEN=<pat> node generate-stats.mjs <login> [outfile]
//         node generate-stats.mjs --selftest        # offline render check, no network

const THEME = {
  bg: '#0d1117', border: '#30363d', title: '#58a6ff',
  label: '#8b949e', value: '#c9d1d9', track: '#21262d',
};

const fmt = (n) => (n == null ? '—' : n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : String(n));
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

// This account is large enough that pullRequests/issues/contributions totalCounts are each
// expensive — combined in one query they trip GitHub's RESOURCE_LIMITS_EXCEEDED. So every
// metric is its own small query and any single failure degrades to null (rendered as "—")
// instead of failing the whole card.
async function safe(token, field, query, pick) {
  try {
    return pick(await gql(token, query, { login: LOGIN }));
  } catch (e) {
    console.warn(`skip ${field}: ${e.message.slice(0, 120)}`);
    return null;
  }
}

let LOGIN;
async function fetchStats(login, token) {
  LOGIN = login;
  // core query: name + followers + repo nodes for stars & languages (bounded at 100 repos)
  const core = await gql(token, `query($login:String!){user(login:$login){
      name login followers{totalCount}
      repositories(first:100, ownerAffiliations:OWNER, isFork:false, orderBy:{field:STARGAZERS,direction:DESC}){
        totalCount nodes{ stargazerCount languages(first:8, orderBy:{field:SIZE,direction:DESC}){ edges{ size node{ name color } } } } }
    }}`, { login });
  const u = core.user;
  const repos = u.repositories.nodes;
  // ponytail: stars/langs aggregate the top-100 repos by stars; >100 repos slightly undercounts
  // the long tail — fine for a profile card, bump `first:` if it ever matters.
  const stars = repos.reduce((s, r) => s + r.stargazerCount, 0);
  const langBytes = {};
  for (const r of repos)
    for (const e of r.languages.edges) {
      const k = e.node.name;
      langBytes[k] = langBytes[k] || { size: 0, color: e.node.color || '#888' };
      langBytes[k].size += e.size;
    }
  const total = Object.values(langBytes).reduce((s, l) => s + l.size, 0) || 1;
  const langs = Object.entries(langBytes)
    .sort((a, b) => b[1].size - a[1].size)
    .slice(0, 6)
    .map(([name, l]) => ({ name, color: l.color, pct: (l.size / total) * 100 }));

  const [commits, prs, issues] = await Promise.all([
    safe(token, 'commits', `query($login:String!){user(login:$login){contributionsCollection{totalCommitContributions}}}`, (d) => d.user.contributionsCollection.totalCommitContributions),
    safe(token, 'prs', `query($login:String!){user(login:$login){pullRequests{totalCount}}}`, (d) => d.user.pullRequests.totalCount),
    safe(token, 'issues', `query($login:String!){user(login:$login){issues{totalCount}}}`, (d) => d.user.issues.totalCount),
  ]);

  return {
    name: u.name || u.login,
    stars, commits, prs, issues,
    followers: u.followers.totalCount,
    repos: u.repositories.totalCount,
    langs,
  };
}

function renderSVG(s) {
  const W = 500, H = 210;
  const rows = [
    ['Total Stars Earned', s.stars],
    ['Total Commits (1y)', s.commits],
    ['Total PRs', s.prs],
  ];
  const rows2 = [
    ['Followers', s.followers],
    ['Public Repos', s.repos],
    ['Total Issues', s.issues],
  ];
  const statRow = (x, [label, val], i) => `
    <text x="${x}" y="${86 + i * 26}" fill="${THEME.label}" font-size="13">${label}</text>
    <text x="${x + 200}" y="${86 + i * 26}" fill="${THEME.value}" font-size="14" font-weight="600" text-anchor="end">${fmt(val)}</text>`;

  // stacked language bar
  const barX = 30, barW = W - 60, barY = 178;
  let acc = 0;
  const segs = s.langs.map((l) => {
    const w = (l.pct / 100) * barW;
    const seg = `<rect x="${barX + acc}" y="${barY}" width="${w.toFixed(1)}" height="8" fill="${l.color}"/>`;
    acc += w;
    return seg;
  }).join('');
  const legend = s.langs.map((l, i) => {
    const lx = barX + i * 78;
    return `<circle cx="${lx + 4}" cy="${barY + 24}" r="4" fill="${l.color}"/>
      <text x="${lx + 13}" y="${barY + 28}" fill="${THEME.label}" font-size="10">${esc(l.name)} ${l.pct.toFixed(1)}%</text>`;
  }).join('');

  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" fill="none" xmlns="http://www.w3.org/2000/svg" font-family="Segoe UI, Ubuntu, sans-serif">
  <rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="10" fill="${THEME.bg}" stroke="${THEME.border}"/>
  <text x="30" y="42" fill="${THEME.title}" font-size="18" font-weight="700">${esc(s.name)}'s GitHub stats</text>
  ${rows.map((r, i) => statRow(30, r, i)).join('')}
  ${rows2.map((r, i) => statRow(265, r, i)).join('')}
  <rect x="${barX}" y="${barY}" width="${barW}" height="8" rx="4" fill="${THEME.track}"/>
  ${segs}
  ${legend}
</svg>`;
}

// ---- self-test: offline render, no network ----
if (process.argv.includes('--selftest')) {
  const svg = renderSVG({
    name: 'Test', stars: 1234, commits: 5678, prs: 90, issues: 12, followers: 345, repos: 67,
    langs: [{ name: 'Go', color: '#00ADD8', pct: 60 }, { name: 'TypeScript', color: '#3178c6', pct: 40 }],
  });
  const ok = svg.includes("Test's GitHub stats") && svg.includes('1.2k') && svg.includes('#00ADD8');
  console.log(ok ? 'selftest OK' : 'selftest FAILED');
  process.exit(ok ? 0 : 1);
}

const [login, outfile = 'stats.svg'] = process.argv.slice(2);
const token = process.env.GITHUB_TOKEN;
if (!login || !token) {
  console.error('usage: GITHUB_TOKEN=<pat> node generate-stats.mjs <login> [outfile]');
  process.exit(1);
}
const stats = await fetchStats(login, token);
const { writeFileSync } = await import('node:fs');
writeFileSync(outfile, renderSVG(stats));
console.log(`wrote ${outfile}:`, JSON.stringify({ ...stats, langs: stats.langs.map((l) => l.name) }));
