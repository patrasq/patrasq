import { readFile, writeFile } from "node:fs/promises";

const LOGIN = process.env.GH_LOGIN ?? "patrasq";
const OUT_DIR = process.env.OUT_DIR ?? ".";
const OPEN_SOURCE_SHOWN = 12;

const THEMES = {
  light: { bg: "#ffffff", border: "#d1d9e0", text: "#1f2328", muted: "#59636e", accent: "#1a7f37", empty: "#eff2f5" },
  dark: { bg: "#0d1117", border: "#3d444d", text: "#f0f6fc", muted: "#9198a1", accent: "#3fb950", empty: "#151b23" },
};

async function gql(query, variables) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { Authorization: `bearer ${process.env.GH_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const text = await res.text();
  const body = JSON.parse(text || "{}");
  if (!res.ok || body.errors) throw new Error(`GraphQL ${res.status}: ${JSON.stringify(body.errors ?? body.message ?? text)}`);
  return { data: body.data, scopes: res.headers.get("x-oauth-scopes") ?? "" };
}

const LIST_TOPIC = /^(awesome(-.+)?|.+-list|lists?|.*directory|resources)$/;
const LIST_DESCRIPTION = /\b(curated|directory|list of|collection of|collective list|collaborative list)\b/i;
const isList = (r) =>
  !r.primaryLanguage ||
  r.repositoryTopics.nodes.some(({ topic }) => LIST_TOPIC.test(topic.name)) ||
  LIST_DESCRIPTION.test(r.description ?? "");

const contributionRank = (r) => (r.merged ? 2 : r.open ? 1 : 0);

async function dataUri(url) {
  const res = await fetch(url);
  const type = res.headers.get("content-type") ?? "image/png";
  return `data:${type};base64,${Buffer.from(await res.arrayBuffer()).toString("base64")}`;
}

async function fetchData() {
  const { data, scopes } = await gql(
    `query($login: String!) {
      user(login: $login) {
        createdAt
        followers { totalCount }
        pullRequests(states: MERGED) { totalCount }
        issues { totalCount }
        repositoriesContributedTo(first: 100, includeUserRepositories: true, contributionTypes: [COMMIT, PULL_REQUEST, ISSUE, REPOSITORY]) {
          totalCount
          nodes { languages(first: 10, orderBy: { field: SIZE, direction: DESC }) { totalSize edges { size node { name color } } } }
        }
        repositories(ownerAffiliations: OWNER, isFork: false, first: 100) { nodes { stargazerCount } }
        contributionsCollection {
          totalCommitContributions
          totalIssueContributions
          totalPullRequestContributions
          totalPullRequestReviewContributions
          restrictedContributionsCount
          contributionCalendar { totalContributions weeks { contributionDays { contributionCount } } }
        }
      }
    }`,
    { login: LOGIN },
  );
  const u = data.user;
  const c = u.contributionsCollection;

  const from = new Date(Date.now() - 365 * 864e5).toISOString().slice(0, 10);
  const searched = { commits: 0, prs: 0, issues: 0, reviews: 0 };
  try {
    const { data: counted } = await gql(
      `query($prs: String!, $issues: String!, $reviews: String!) {
        prs: search(query: $prs, type: ISSUE, first: 1) { issueCount }
        issues: search(query: $issues, type: ISSUE, first: 1) { issueCount }
        reviews: search(query: $reviews, type: ISSUE, first: 1) { issueCount }
      }`,
      {
        prs: `author:${LOGIN} is:pr created:>=${from}`,
        issues: `author:${LOGIN} is:issue created:>=${from}`,
        reviews: `reviewed-by:${LOGIN} -author:${LOGIN} is:pr updated:>=${from}`,
      },
    );
    searched.prs = counted.prs.issueCount;
    searched.issues = counted.issues.issueCount;
    searched.reviews = counted.reviews.issueCount;
    const commits = await fetch(
      `https://api.github.com/search/commits?per_page=1&q=${encodeURIComponent(`author:${LOGIN} committer-date:>=${from}`)}`,
      { headers: { Authorization: `bearer ${process.env.GH_TOKEN}`, Accept: "application/vnd.github+json" } },
    ).then((r) => r.json());
    searched.commits = commits.total_count ?? 0;
  } catch (err) {
    console.log(`::warning::Search counts failed, using the contribution graph only: ${err.message}`);
  }

  const days = c.contributionCalendar.weeks.flatMap((w) => w.contributionDays.map((d) => d.contributionCount));
  let longest = 0;
  let run = 0;
  for (const n of days) {
    run = n ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  let i = days[days.length - 1] ? days.length - 1 : days.length - 2;
  let current = 0;
  while (i >= 0 && days[i] > 0) {
    current++;
    i--;
  }

  const langs = new Map();
  for (const { languages } of u.repositoriesContributedTo.nodes) {
    if (!languages.totalSize) continue;
    for (const { size, node } of languages.edges) {
      const l = langs.get(node.name) ?? { name: node.name, color: node.color, weight: 0 };
      l.weight += size / languages.totalSize;
      langs.set(node.name, l);
    }
  }
  const langTotal = [...langs.values()].reduce((sum, l) => sum + l.weight, 0) || 1;
  const languages = [...langs.values()]
    .map((l) => ({ name: l.name, color: l.color, pct: (100 * l.weight) / langTotal }))
    .filter((l) => l.pct >= 1)
    .sort((a, b) => b.pct - a.pct)
    .slice(0, 8);

  const ownOwners = new Set([LOGIN, ...(process.env.EXCLUDE_OWNERS ?? "").split(",")].map((o) => o.trim().toLowerCase()));
  const repos = new Map();
  try {
    const { data: found } = await gql(
      `query($q: String!) {
        search(query: $q, type: ISSUE, first: 100) {
          nodes {
            __typename
            ... on PullRequest { merged state repository { ...repo } }
            ... on Issue { repository { ...repo } }
          }
        }
      }
      fragment repo on Repository {
        nameWithOwner stargazerCount description
        primaryLanguage { name }
        repositoryTopics(first: 20) { nodes { topic { name } } }
        owner { login avatarUrl(size: 48) }
      }`,
      { q: `author:${LOGIN} is:public sort:created-desc` },
    );
    for (const node of found.search.nodes) {
      const r = node.repository;
      if (!r || ownOwners.has(r.owner.login.toLowerCase()) || !r.stargazerCount || isList(r)) continue;
      const kind = node.__typename === "Issue" ? "issues" : node.merged ? "merged" : node.state === "OPEN" ? "open" : null;
      if (!kind) continue;
      const entry = repos.get(r.nameWithOwner) ?? { name: r.nameWithOwner, stars: r.stargazerCount, avatarUrl: r.owner.avatarUrl, merged: 0, open: 0, issues: 0 };
      entry[kind]++;
      repos.set(r.nameWithOwner, entry);
    }
  } catch (err) {
    console.log(`::warning::Open source lookup failed, rendering without it: ${err.message}`);
  }

  console.log(
    `::notice::Token scopes: ${scopes || "none"}. Private contributions not broken down by type: ${c.restrictedContributionsCount}. ` +
      `12 months, graph vs search: commits ${c.totalCommitContributions}/${searched.commits}, PRs ${c.totalPullRequestContributions}/${searched.prs}, ` +
      `issues ${c.totalIssueContributions}/${searched.issues}, reviews ${c.totalPullRequestReviewContributions}/${searched.reviews}.`,
  );
  if (!scopes.split(/,\s*/).includes("repo")) {
    console.log("::warning::Give METRICS_TOKEN the repo scope so private commits, PRs, issues and reviews are counted.");
  }

  return {
    total: c.contributionCalendar.totalContributions,
    weeks: c.contributionCalendar.weeks.map((w) => w.contributionDays.reduce((sum, d) => sum + d.contributionCount, 0)),
    since: new Date(u.createdAt).getUTCFullYear(),
    year: {
      commits: Math.max(c.totalCommitContributions, searched.commits),
      pullRequests: Math.max(c.totalPullRequestContributions, searched.prs),
      reviews: Math.max(c.totalPullRequestReviewContributions, searched.reviews),
      issues: Math.max(c.totalIssueContributions, searched.issues),
      repos: u.repositoriesContributedTo.totalCount,
      currentStreak: current,
      longestStreak: longest,
      bestDay: Math.max(0, ...days),
    },
    allTime: {
      mergedPrs: u.pullRequests.totalCount,
      issues: u.issues.totalCount,
      stars: u.repositories.nodes.reduce((sum, r) => sum + r.stargazerCount, 0),
      followers: u.followers.totalCount,
    },
    languages,
    openSource: [...repos.values()].sort(
      (a, b) =>
        Math.floor(Math.log10(b.stars)) - Math.floor(Math.log10(a.stars)) ||
        contributionRank(b) - contributionRank(a) ||
        b.stars - a.stars,
    ),
  };
}

const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]);
const fmt = (n) => n.toLocaleString("en-US");
const compact = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : String(n));
const plural = (n, word) => `${fmt(n)} ${word}${n === 1 ? "" : "s"}`;
const streak = (n) => `${fmt(n)}<tspan class="unit"> ${n === 1 ? "day" : "days"}</tspan>`;

function render(d, t) {
  const W = 840;
  const P = 28;
  const X = P + 150;
  const colW = (W - P - X) / 4;
  const parts = [];
  const rule = (y) => parts.push(`<line x1="${P}" x2="${W - P}" y1="${y}" y2="${y}" class="rule"/>`);
  const section = (y, label) => parts.push(`<text x="${P}" y="${y}" class="section">${label}</text>`);
  const statRow = (y, stats) =>
    stats.forEach(([label, value], i) => {
      parts.push(`<text x="${X + i * colW}" y="${y}" class="stat">${value}</text>`);
      parts.push(`<text x="${X + i * colW}" y="${y + 18}" class="label">${label}</text>`);
    });

  parts.push(`<text x="${P}" y="66" class="big">${fmt(d.total)}</text>`);
  parts.push(`<text x="${P}" y="92" class="label">contributions in the last 12 months  ·  on GitHub since ${d.since}</text>`);
  const max = Math.max(1, ...d.weeks);
  const barW = 5;
  const gap = 2;
  const chartX = W - P - d.weeks.length * (barW + gap) + gap;
  d.weeks.forEach((v, i) => {
    const h = v ? Math.max(3, (v / max) * 48) : 2;
    const fill = v ? `fill="${t.accent}" fill-opacity="${(0.35 + (0.65 * v) / max).toFixed(2)}"` : `fill="${t.empty}"`;
    parts.push(`<rect x="${chartX + i * (barW + gap)}" y="${(92 - h).toFixed(1)}" width="${barW}" height="${h.toFixed(1)}" rx="1" ${fill}/>`);
  });

  const y1 = d.year;
  rule(120);
  section(158, "Last 12 months");
  statRow(158, [
    ["Commits", fmt(y1.commits)],
    ["Pull requests", fmt(y1.pullRequests)],
    ["Code reviews", fmt(y1.reviews)],
    ["Issues opened", fmt(y1.issues)],
  ]);
  statRow(212, [
    ["Repos contributed to", fmt(y1.repos)],
    ["Current streak", streak(y1.currentStreak)],
    ["Longest streak", streak(y1.longestStreak)],
    ["Best day", fmt(y1.bestDay)],
  ]);

  const a = d.allTime;
  rule(254);
  section(292, "All time");
  statRow(292, [
    ["Merged PRs", fmt(a.mergedPrs)],
    ["Issues opened", fmt(a.issues)],
    ["Stars earned", fmt(a.stars)],
    ["Followers", fmt(a.followers)],
  ]);
  let y = 334;

  if (d.languages.length) {
    rule(y);
    section(y + 34, "Languages");
    const barX = X;
    const barWidth = W - P - X;
    parts.push(`<clipPath id="langs"><rect x="${barX}" y="${y + 26}" width="${barWidth}" height="8" rx="4"/></clipPath>`);
    parts.push(`<g clip-path="url(#langs)"><rect x="${barX}" y="${y + 26}" width="${barWidth}" height="8" fill="${t.empty}"/>`);
    let x = barX;
    for (const l of d.languages) {
      const w = (barWidth * l.pct) / 100;
      parts.push(`<rect x="${x.toFixed(1)}" y="${y + 26}" width="${w.toFixed(1)}" height="8" fill="${l.color ?? t.muted}"/>`);
      x += w;
    }
    parts.push(`</g>`);
    d.languages.forEach((l, i) => {
      const lx = X + (i % 4) * colW;
      const ly = y + 60 + Math.floor(i / 4) * 22;
      parts.push(`<circle cx="${lx + 4}" cy="${ly - 4}" r="4" fill="${l.color ?? t.muted}"/>`);
      parts.push(`<text x="${lx + 14}" y="${ly}" class="lang">${esc(l.name)}<tspan dx="6" class="unit">${l.pct.toFixed(1)}%</tspan></text>`);
    });
    y += 60 + (Math.ceil(d.languages.length / 4) - 1) * 22 + 22;
  }

  if (d.openSource.length) {
    rule(y);
    const all = d.openSource;
    section(y + 36, "Open source");
    const totals = all.reduce((s, r) => ({ merged: s.merged + r.merged, open: s.open + r.open, issues: s.issues + r.issues }), { merged: 0, open: 0, issues: 0 });
    const summary = [plural(all.length, "repo"), plural(totals.merged, "merged PR"), plural(totals.open, "open PR"), plural(totals.issues, "issue")];
    summary.forEach((line, i) => parts.push(`<text x="${P}" y="${y + 60 + i * 18}" class="label">${line}</text>`));

    const shown = all.slice(0, OPEN_SOURCE_SHOWN);
    const cellW = (W - P - X) / 2;
    shown.forEach((r, i) => {
      const rows = Math.ceil(shown.length / 2);
      const cx = X + Math.floor(i / rows) * cellW;
      const cy = y + 36 + (i % rows) * 46;
      parts.push(`<clipPath id="av${i}"><rect x="${cx}" y="${cy - 12}" width="28" height="28" rx="6"/></clipPath>`);
      parts.push(`<image href="${r.avatar}" x="${cx}" y="${cy - 12}" width="28" height="28" clip-path="url(#av${i})"/>`);
      parts.push(`<rect x="${cx}" y="${cy - 12}" width="28" height="28" rx="6" fill="none" class="rule"/>`);
      const name = r.name.length > 38 ? `${r.name.slice(0, 37)}…` : r.name;
      const meta = [
        `★ ${compact(r.stars)}`,
        r.merged && plural(r.merged, "merged PR"),
        r.open && plural(r.open, "open PR"),
        r.issues && plural(r.issues, "issue"),
      ].filter(Boolean);
      parts.push(`<text x="${cx + 38}" y="${cy}" class="repo">${esc(name)}</text>`);
      parts.push(`<text x="${cx + 38}" y="${cy + 17}" class="meta">${meta.join("  ·  ")}</text>`);
    });
    const gridBottom = y + 36 + (Math.ceil(shown.length / 2) - 1) * 46 + 17;
    const summaryBottom = y + 60 + (summary.length - 1) * 18;
    y = Math.max(gridBottom, summaryBottom) + 26;
  } else {
    y += 8;
  }

  const H = y;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="title">
<title id="title">${fmt(d.total)} GitHub contributions in the last 12 months</title>
<style>
  text { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif; fill: ${t.text}; font-variant-numeric: tabular-nums; }
  .big { font-size: 40px; font-weight: 600; letter-spacing: -0.5px; }
  .section { font-size: 13px; font-weight: 600; }
  .stat { font-size: 20px; font-weight: 600; }
  .label { font-size: 12px; fill: ${t.muted}; }
  .unit { font-size: 12px; font-weight: 400; fill: ${t.muted}; }
  .lang { font-size: 12px; }
  .repo { font-size: 13px; font-weight: 600; }
  .meta { font-size: 12px; font-weight: 400; fill: ${t.muted}; }
  .rule { stroke: ${t.border}; stroke-width: 1; }
</style>
<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="6" fill="${t.bg}" stroke="${t.border}"/>
${parts.join("\n")}
</svg>
`;
}

try {
  const data = process.env.MOCK ? JSON.parse(await readFile(process.env.MOCK, "utf8")) : await fetchData();
  for (const r of data.openSource.slice(0, OPEN_SOURCE_SHOWN)) r.avatar = await dataUri(r.avatarUrl);
  console.log(JSON.stringify({ ...data, weeks: undefined, openSource: data.openSource.map((r) => `${r.name} (${r.merged}/${r.open}/${r.issues})`) }));
  for (const [name, theme] of Object.entries(THEMES)) {
    await writeFile(`${OUT_DIR}/card-${name}.svg`, render(data, theme));
  }
} catch (err) {
  console.log(`::error::${err.message}`);
  process.exitCode = 1;
}
