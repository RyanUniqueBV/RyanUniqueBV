import { writeFileSync, readFileSync, existsSync } from "fs";

const USERNAME = "RyanUniqueBV";
const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;

// --- Theme ---
const theme = {
  bg: "#0d1117",
  border: "#30363d",
  text: "#e6edf3",
  textSecondary: "#7d8590",
  accent: "#58a6ff",
  green: ["#161b22", "#0e4429", "#006d32", "#26a641", "#39d353"],
};

const font = `-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif`;

// --- GitHub API ---
async function graphql(query, variables = {}) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `bearer ${TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": "github-stats-generator",
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GraphQL HTTP ${res.status}: ${text}`);
  }

  return res.json();
}

async function rest(endpoint) {
  const res = await fetch(`https://api.github.com${endpoint}`, {
    headers: {
      Authorization: `bearer ${TOKEN}`,
      "User-Agent": "github-stats-generator",
      Accept: "application/vnd.github+json",
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`REST HTTP ${res.status}: ${text}`);
  }

  return res.json();
}

// --- Fetch user profile + repos + organizations + contributed repos ---
async function fetchProfile() {
  const repoFields = `
    name
    stargazerCount
    languages(first: 10, orderBy: { field: SIZE, direction: DESC }) {
      edges {
        size
        node { name color }
      }
    }
  `;

  const query = `
    query($login: String!) {
      user(login: $login) {
        createdAt
        repositories(first: 100, ownerAffiliations: OWNER, orderBy: { field: UPDATED_AT, direction: DESC }) {
          totalCount
          nodes { ${repoFields} }
        }
        repositoriesContributedTo(first: 100, contributionTypes: [COMMIT], orderBy: { field: PUSHED_AT, direction: DESC }) {
          totalCount
          nodes {
            ${repoFields}
            owner { login }
          }
        }
        organizations(first: 20) {
          totalCount
          nodes {
            id
            login
            name
          }
        }
      }
    }
  `;

  const json = await graphql(query, { login: USERNAME });
  if (json.errors) {
    console.warn("Profile query errors:", JSON.stringify(json.errors));
    return null;
  }
  return json.data.user;
}

// --- Fetch per-organization contributions (commits, PRs, issues) ---
async function fetchOrgContributions(orgs, createdAt) {
  if (!orgs || orgs.length === 0) return [];

  const startYear = new Date(createdAt).getFullYear();
  const now = new Date();
  const currentYear = now.getFullYear();

  const fragment = `
    totalCommitContributions
    totalPullRequestContributions
    totalIssueContributions
    restrictedContributionsCount
  `;

  let aliases = "";
  for (const org of orgs) {
    const safe = org.login.replace(/[^a-zA-Z0-9]/g, "_");
    for (let year = startYear; year <= currentYear; year++) {
      const from = `${year}-01-01T00:00:00Z`;
      const to =
        year === currentYear
          ? now.toISOString()
          : `${year + 1}-01-01T00:00:00Z`;
      aliases += `${safe}_${year}: contributionsCollection(organizationID: "${org.id}", from: "${from}", to: "${to}") { ${fragment} }\n`;
    }
  }

  const query = `query($login: String!) { user(login: $login) { ${aliases} } }`;

  try {
    const json = await graphql(query, { login: USERNAME });
    if (json.errors) {
      console.warn("Org contributions query errors:", JSON.stringify(json.errors));
      return [];
    }

    const result = [];
    for (const org of orgs) {
      const safe = org.login.replace(/[^a-zA-Z0-9]/g, "_");
      let commits = 0, prs = 0, issues = 0, restricted = 0;
      for (let year = startYear; year <= currentYear; year++) {
        const data = json.data.user[`${safe}_${year}`];
        if (!data) continue;
        commits += data.totalCommitContributions;
        prs += data.totalPullRequestContributions;
        issues += data.totalIssueContributions;
        restricted += data.restrictedContributionsCount;
      }
      const total = commits + prs + issues + restricted;
      if (total > 0) {
        result.push({
          login: org.login,
          name: org.name || org.login,
          commits,
          prs,
          issues,
          restricted,
          total,
        });
      }
    }

    result.sort((a, b) => b.total - a.total);
    return result;
  } catch (err) {
    console.warn("Org contributions fetch failed:", err.message);
    return [];
  }
}

// --- Fetch ALL-TIME contributions using aliased year queries ---
async function fetchAllContributions(createdAt) {
  const startYear = new Date(createdAt).getFullYear();
  const now = new Date();
  const currentYear = now.getFullYear();

  // Build one GraphQL query with an alias per year
  const contribFragment = `
    totalCommitContributions
    totalPullRequestContributions
    totalIssueContributions
    restrictedContributionsCount
    contributionCalendar {
      totalContributions
      weeks {
        contributionDays {
          contributionCount
          date
          weekday
        }
      }
    }
  `;

  let yearAliases = "";
  for (let year = startYear; year <= currentYear; year++) {
    const from = `${year}-01-01T00:00:00Z`;
    const to =
      year === currentYear
        ? now.toISOString()
        : `${year + 1}-01-01T00:00:00Z`;
    yearAliases += `y${year}: contributionsCollection(from: "${from}", to: "${to}") { ${contribFragment} }\n`;
  }

  const query = `query($login: String!) { user(login: $login) { ${yearAliases} } }`;
  const json = await graphql(query, { login: USERNAME });

  if (json.errors) {
    console.warn("Contributions query failed:", JSON.stringify(json.errors));
    return null;
  }

  // Aggregate all years
  const userData = json.data.user;
  let totalCommits = 0;
  let totalPRs = 0;
  let totalIssues = 0;
  let totalContributions = 0;
  let totalRestricted = 0;
  let allWeeks = [];

  for (let year = startYear; year <= currentYear; year++) {
    const yearData = userData[`y${year}`];
    if (!yearData) continue;

    totalCommits += yearData.totalCommitContributions;
    totalPRs += yearData.totalPullRequestContributions;
    totalIssues += yearData.totalIssueContributions;
    totalContributions += yearData.contributionCalendar.totalContributions;
    totalRestricted += yearData.restrictedContributionsCount;

    // Collect all calendar weeks
    allWeeks.push(...yearData.contributionCalendar.weeks);
  }

  // Include restricted (private) contributions that the calendar doesn't expose
  totalContributions += totalRestricted;

  console.log(`  Years queried: ${startYear}-${currentYear} (${currentYear - startYear + 1} years)`);
  console.log(`  All-time commits: ${totalCommits}`);
  console.log(`  All-time contributions: ${totalContributions} (incl. ${totalRestricted} restricted)`);

  return {
    totalCommits,
    totalPRs,
    totalIssues,
    totalContributions,
    totalRestricted,
    allWeeks,
    startYear,
    yearCount: currentYear - startYear + 1,
  };
}

// --- Fallback: REST API for languages ---
async function fetchLanguagesREST(repos) {
  const langMap = {};
  for (const repo of repos.slice(0, 20)) {
    try {
      const langs = await rest(`/repos/${USERNAME}/${repo.name}/languages`);
      for (const [name, bytes] of Object.entries(langs)) {
        if (!langMap[name]) langMap[name] = { size: 0, color: "#8b949e" };
        langMap[name].size += bytes;
      }
    } catch {
      // Skip inaccessible repos
    }
  }
  return langMap;
}

// --- Data Processing ---
function processLanguages(repos) {
  const langMap = {};
  for (const repo of repos) {
    for (const edge of repo.languages.edges) {
      const name = edge.node.name;
      if (!langMap[name]) {
        langMap[name] = { size: 0, color: edge.node.color || "#8b949e" };
      }
      langMap[name].size += edge.size;
    }
  }

  const sorted = Object.entries(langMap)
    .sort((a, b) => b[1].size - a[1].size)
    .slice(0, 6);

  const total = sorted.reduce((sum, [, v]) => sum + v.size, 0);
  if (total === 0) return [];

  return sorted.map(([name, { size, color }]) => ({
    name,
    color,
    percent: Math.round((size / total) * 100),
  }));
}

function processLanguagesFromMap(langMap) {
  const colors = {
    PHP: "#4F5D95", JavaScript: "#f1e05a", TypeScript: "#3178c6",
    HTML: "#e34c26", CSS: "#563d7c", SCSS: "#c6538c", Shell: "#89e051",
    Python: "#3572A5", Vue: "#41b883", Blade: "#f7523f", Twig: "#c1d026",
  };

  const sorted = Object.entries(langMap)
    .sort((a, b) => b[1].size - a[1].size)
    .slice(0, 6);

  const total = sorted.reduce((sum, [, v]) => sum + v.size, 0);
  if (total === 0) return [];

  return sorted.map(([name, { size }]) => ({
    name,
    color: colors[name] || "#8b949e",
    percent: Math.round((size / total) * 100),
  }));
}

function getPeakDays(weeks) {
  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const days = [0, 0, 0, 0, 0, 0, 0];
  // Use all available weeks for day-of-week pattern
  for (const week of weeks) {
    for (const day of week.contributionDays) {
      days[day.weekday] += day.contributionCount;
    }
  }
  const max = Math.max(...days);
  return days.map((count, i) => ({
    day: dayNames[i],
    count,
    ratio: max > 0 ? count / max : 0,
  }));
}

// --- SVG Generation ---
function generateSVG({ contributions, repos, languages, orgContribs = [] }) {
  const hasContribs = contributions !== null;
  const totalContributions = hasContribs ? contributions.totalContributions : 0;
  const totalCommits = hasContribs ? contributions.totalCommits : 0;
  const totalRepos = repos.totalCount;
  const totalStars = repos.nodes.reduce((s, r) => s + r.stargazerCount, 0);
  const allWeeks = hasContribs ? contributions.allWeeks : [];

  const orgTotalCommits = orgContribs.reduce((s, o) => s + o.commits, 0);
  const hasOrgActivity = orgContribs.length > 0 && orgContribs.some((o) => o.total > 0);

  // Determine if we have enough data for the full two-column layout
  const isSparse = (totalContributions < 50 || languages.length <= 1) && !hasOrgActivity;

  const width = 840;

  const timestamp = new Date().toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });

  const memberSince = hasContribs ? `Member since ${contributions.startYear}` : "";

  // --- Metrics row ---
  const metrics = [
    { label: "Contributions", value: totalContributions },
    { label: "Commits", value: totalCommits },
    { label: "Repositories", value: totalRepos },
    { label: "Stars", value: totalStars },
  ].filter((m) => hasContribs || m.label === "Repositories" || m.label === "Stars");

  const metricSpacing = width / metrics.length;
  const metricsSVG = metrics
    .map((m, i) => {
      const x = i * metricSpacing + metricSpacing / 2;
      return `
      <text x="${x}" y="88" fill="${theme.accent}" font-size="28" font-weight="700" text-anchor="middle" font-family="${font}">${m.value.toLocaleString()}</text>
      <text x="${x}" y="108" fill="${theme.textSecondary}" font-size="11" text-anchor="middle" font-family="${font}">${m.label}</text>`;
    })
    .join("\n");

  // =============================================
  // COMPACT LAYOUT (sparse data)
  // Single column: heatmap full-width, then languages + weekly side by side below
  // =============================================
  if (isSparse) {
    const height = 310;

    // Compact heatmap — full width, last 26 weeks
    const heatmapWeeks = allWeeks.slice(-26);
    const cellSize = 11;
    const cellGap = 2;
    const heatmapX = 50;
    const heatmapY = 160;

    let maxC = 0;
    for (const w of heatmapWeeks)
      for (const d of w.contributionDays)
        if (d.contributionCount > maxC) maxC = d.contributionCount;

    function getColor(count) {
      if (count === 0 || maxC === 0) return theme.green[0];
      const r = count / maxC;
      if (r < 0.25) return theme.green[1];
      if (r < 0.5) return theme.green[2];
      if (r < 0.75) return theme.green[3];
      return theme.green[4];
    }

    let cells = "";
    for (let w = 0; w < heatmapWeeks.length; w++) {
      for (const day of heatmapWeeks[w].contributionDays) {
        const x = heatmapX + w * (cellSize + cellGap);
        const y = heatmapY + day.weekday * (cellSize + cellGap);
        cells += `<rect x="${x}" y="${y}" width="${cellSize}" height="${cellSize}" rx="2" fill="${getColor(day.contributionCount)}"><title>${day.date}: ${day.contributionCount}</title></rect>\n`;
      }
    }

    const dayLabels = ["", "Mon", "", "Wed", "", "Fri", ""];
    const dayLabelsSVG = dayLabels
      .map((label, i) => {
        if (!label) return "";
        const y = heatmapY + i * (cellSize + cellGap) + cellSize / 2 + 3;
        return `<text x="${heatmapX - 8}" y="${y}" fill="${theme.textSecondary}" font-size="9" text-anchor="end" font-family="${font}">${label}</text>`;
      })
      .join("\n");

    // Languages as inline dots + labels on the right
    const langY = heatmapY + 2;
    const langX = 420;
    const langBarW = width - langX - 30;
    const languageSVG = languages
      .map((lang, i) => {
        const y = langY + i * 26;
        const w = (lang.percent / 100) * langBarW;
        return `
        <circle cx="${langX}" cy="${y - 3}" r="4" fill="${lang.color}" />
        <text x="${langX + 12}" y="${y}" fill="${theme.text}" font-size="11" font-family="${font}">${lang.name}</text>
        <text x="${width - 30}" y="${y}" fill="${theme.textSecondary}" font-size="10" text-anchor="end" font-family="${font}">${lang.percent}%</text>
        <rect x="${langX}" y="${y + 5}" width="${langBarW}" height="6" rx="3" fill="${theme.border}" />
        <rect x="${langX}" y="${y + 5}" width="${w}" height="6" rx="3" fill="${lang.color}" />`;
      })
      .join("\n");

    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" fill="none">
  <rect width="${width}" height="${height}" rx="12" fill="${theme.bg}" />
  <rect width="${width}" height="${height}" rx="12" fill="none" stroke="${theme.border}" stroke-width="1" />

  <text x="30" y="42" fill="${theme.text}" font-size="16" font-weight="600" font-family="${font}">GitHub Activity</text>
  <text x="${width - 30}" y="32" fill="${theme.textSecondary}" font-size="11" text-anchor="end" font-family="${font}">${memberSince}</text>
  <text x="${width - 30}" y="48" fill="${theme.textSecondary}" font-size="10" text-anchor="end" font-family="${font}">Updated ${timestamp}</text>
  <line x1="30" y1="55" x2="${width - 30}" y2="55" stroke="${theme.border}" stroke-width="1" />

  ${metricsSVG}

  <line x1="30" y1="130" x2="${width - 30}" y2="130" stroke="${theme.border}" stroke-width="1" />

  <text x="30" y="152" fill="${theme.text}" font-size="12" font-weight="600" font-family="${font}">Recent Activity</text>
  ${dayLabelsSVG}
  ${cells}

  ${languages.length > 0 ? `<text x="${langX}" y="152" fill="${theme.text}" font-size="12" font-weight="600" font-family="${font}">Languages</text>` : ""}
  ${languageSVG}

  <line x1="30" y1="${height - 35}" x2="${width - 30}" y2="${height - 35}" stroke="${theme.border}" stroke-width="1" />
  <text x="${width / 2}" y="${height - 14}" fill="${theme.textSecondary}" font-size="10" text-anchor="middle" font-family="${font}">Generated with a custom GitHub Action</text>
</svg>`;
  }

  // =============================================
  // FULL LAYOUT (enough data for two-column)
  // =============================================
  const orgsToShow = orgContribs.slice(0, 5);
  const orgHasData = orgsToShow.length > 0;
  const orgRowHeight = 30;
  const orgSectionStart = 500;
  const orgRowsStart = orgSectionStart + 40;
  const orgRowsEnd = orgRowsStart + orgsToShow.length * orgRowHeight;
  const height = orgHasData ? orgRowsEnd + 50 : 520;

  const heatmapWeeks = allWeeks.slice(-26);
  const dayActivity = getPeakDays(allWeeks);

  const cellSize = 14;
  const cellGap = 3;
  const heatmapX = 50;
  const heatmapY = 220;

  let maxContrib = 0;
  for (const week of heatmapWeeks)
    for (const day of week.contributionDays)
      if (day.contributionCount > maxContrib) maxContrib = day.contributionCount;

  function getColor(count) {
    if (count === 0 || maxContrib === 0) return theme.green[0];
    const ratio = count / maxContrib;
    if (ratio < 0.25) return theme.green[1];
    if (ratio < 0.5) return theme.green[2];
    if (ratio < 0.75) return theme.green[3];
    return theme.green[4];
  }

  // Month labels above the heatmap — only when a month changes and prior label is far enough away
  const monthLabelsList = [];
  let lastLabeledWeek = -10;
  let lastMonth = -1;
  for (let w = 0; w < heatmapWeeks.length; w++) {
    const days = heatmapWeeks[w].contributionDays;
    if (!days || days.length === 0) continue;
    const date = new Date(days[0].date);
    const month = date.getMonth();
    if (month !== lastMonth && w - lastLabeledWeek >= 3 && w < heatmapWeeks.length - 1) {
      const x = heatmapX + w * (cellSize + cellGap);
      const monthName = date.toLocaleDateString("en-US", { month: "short" });
      monthLabelsList.push(`<text x="${x}" y="${heatmapY - 8}" fill="${theme.textSecondary}" font-size="10" font-family="${font}">${monthName}</text>`);
      lastMonth = month;
      lastLabeledWeek = w;
    }
  }
  const monthLabelsSVG = monthLabelsList.join("\n  ");

  let heatmapCells = "";
  for (let w = 0; w < heatmapWeeks.length; w++) {
    for (const day of heatmapWeeks[w].contributionDays) {
      const x = heatmapX + w * (cellSize + cellGap);
      const y = heatmapY + day.weekday * (cellSize + cellGap);
      heatmapCells += `<rect x="${x}" y="${y}" width="${cellSize}" height="${cellSize}" rx="3" fill="${getColor(day.contributionCount)}"><title>${day.date}: ${day.contributionCount}</title></rect>\n`;
    }
  }

  const dayLabels = ["", "Mon", "", "Wed", "", "Fri", ""];
  const dayLabelsSVG = dayLabels
    .map((label, i) => {
      if (!label) return "";
      const y = heatmapY + i * (cellSize + cellGap) + cellSize / 2 + 4;
      return `<text x="${heatmapX - 10}" y="${y}" fill="${theme.textSecondary}" font-size="11" text-anchor="end" font-family="${font}">${label}</text>`;
    })
    .join("\n");

  const legendY = heatmapY + 7 * (cellSize + cellGap) + 10;
  const legendSVG = theme.green
    .map((c, i) => `<rect x="${heatmapX + 30 + i * 18}" y="${legendY}" width="12" height="12" rx="2" fill="${c}" />`)
    .join("\n  ");

  const langX = 510;
  const langY = 200;
  const barWidth = 280;
  const barHeight = 10;
  const languageSVG = languages
    .map((lang, i) => {
      const y = langY + i * 34;
      const w = (lang.percent / 100) * barWidth;
      return `
      <text x="${langX}" y="${y - 4}" fill="${theme.text}" font-size="12" font-family="${font}">${lang.name}</text>
      <text x="${langX + barWidth}" y="${y - 4}" fill="${theme.textSecondary}" font-size="11" text-anchor="end" font-family="${font}">${lang.percent}%</text>
      <rect x="${langX}" y="${y + 2}" width="${barWidth}" height="${barHeight}" rx="5" fill="${theme.border}" />
      <rect x="${langX}" y="${y + 2}" width="${w}" height="${barHeight}" rx="5" fill="${lang.color}" />`;
    })
    .join("\n");

  const actX = 510;
  const actY = 430;
  const activitySVG = dayActivity
    .map((d, i) => {
      const x = actX + i * 41;
      const maxBarH = 50;
      const barH = Math.max(2, d.ratio * maxBarH);
      const barY = actY - barH;
      return `
      <rect x="${x}" y="${barY}" width="28" height="${barH}" rx="4" fill="${d.ratio > 0.6 ? theme.accent : theme.border}" opacity="${Math.max(0.3, d.ratio)}" />
      <text x="${x + 14}" y="${actY + 16}" fill="${theme.textSecondary}" font-size="10" text-anchor="middle" font-family="${font}">${d.day}</text>`;
    })
    .join("\n");

  // Organizations section (only when data is available)
  let orgSectionSVG = "";
  if (orgHasData) {
    const maxOrgCommits = Math.max(...orgsToShow.map((o) => o.commits), 1);
    const orgBarX = 240;
    const orgBarWidth = 340;
    const orgMetaX = width - 30;

    const rowsSVG = orgsToShow
      .map((org, i) => {
        const rowY = orgRowsStart + i * orgRowHeight;
        const ratio = org.commits / maxOrgCommits;
        const barW = ratio * orgBarWidth;
        const meta = `${org.commits.toLocaleString()} commits · ${org.prs} PRs · ${org.issues} issues`;
        return `
      <text x="30" y="${rowY + 12}" fill="${theme.text}" font-size="12" font-weight="500" font-family="${font}">${escapeXml(org.name)}</text>
      <rect x="${orgBarX}" y="${rowY + 4}" width="${orgBarWidth}" height="10" rx="5" fill="${theme.border}" />
      <rect x="${orgBarX}" y="${rowY + 4}" width="${barW}" height="10" rx="5" fill="${theme.accent}" />
      <text x="${orgMetaX}" y="${rowY + 12}" fill="${theme.textSecondary}" font-size="10" text-anchor="end" font-family="${font}">${meta}</text>`;
      })
      .join("\n");

    orgSectionSVG = `
  <line x1="30" y1="${orgSectionStart - 15}" x2="${width - 30}" y2="${orgSectionStart - 15}" stroke="${theme.border}" stroke-width="1" />
  <text x="30" y="${orgSectionStart + 5}" fill="${theme.text}" font-size="13" font-weight="600" font-family="${font}">Organizations</text>
  <text x="30" y="${orgSectionStart + 22}" fill="${theme.textSecondary}" font-size="11" font-family="${font}">Contributions across ${orgContribs.length} organization${orgContribs.length === 1 ? "" : "s"}${orgTotalCommits ? ` · ${orgTotalCommits.toLocaleString()} total commits` : ""}</text>
  ${rowsSVG}`;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" fill="none">
  <rect width="${width}" height="${height}" rx="12" fill="${theme.bg}" />
  <rect width="${width}" height="${height}" rx="12" fill="none" stroke="${theme.border}" stroke-width="1" />

  <text x="30" y="42" fill="${theme.text}" font-size="16" font-weight="600" font-family="${font}">GitHub Activity</text>
  <text x="${width - 30}" y="32" fill="${theme.textSecondary}" font-size="11" text-anchor="end" font-family="${font}">${memberSince}</text>
  <text x="${width - 30}" y="48" fill="${theme.textSecondary}" font-size="10" text-anchor="end" font-family="${font}">Updated ${timestamp}</text>
  <line x1="30" y1="55" x2="${width - 30}" y2="55" stroke="${theme.border}" stroke-width="1" />

  ${metricsSVG}

  <line x1="30" y1="130" x2="${width - 30}" y2="130" stroke="${theme.border}" stroke-width="1" />

  <text x="30" y="170" fill="${theme.text}" font-size="13" font-weight="600" font-family="${font}">Contribution Activity</text>
  <text x="30" y="188" fill="${theme.textSecondary}" font-size="11" font-family="${font}">Last 26 weeks</text>
  ${monthLabelsSVG}
  ${dayLabelsSVG}
  ${heatmapCells}
  <text x="${heatmapX}" y="${legendY + 10}" fill="${theme.textSecondary}" font-size="10" font-family="${font}">Less</text>
  ${legendSVG}
  <text x="${heatmapX + 30 + 5 * 18 + 4}" y="${legendY + 10}" fill="${theme.textSecondary}" font-size="10" font-family="${font}">More</text>

  <text x="${langX}" y="170" fill="${theme.text}" font-size="13" font-weight="600" font-family="${font}">Top Languages</text>
  <text x="${langX}" y="188" fill="${theme.textSecondary}" font-size="11" font-family="${font}">By repository size</text>
  ${languageSVG}

  <text x="${actX}" y="${actY - 70}" fill="${theme.text}" font-size="13" font-weight="600" font-family="${font}">Weekly Pattern</text>
  <text x="${actX}" y="${actY - 55}" fill="${theme.textSecondary}" font-size="11" font-family="${font}">All-time commits by day</text>
  ${activitySVG}
  ${orgSectionSVG}

  <line x1="30" y1="${height - 35}" x2="${width - 30}" y2="${height - 35}" stroke="${theme.border}" stroke-width="1" />
  <text x="${width / 2}" y="${height - 14}" fill="${theme.textSecondary}" font-size="10" text-anchor="middle" font-family="${font}">Generated with a custom GitHub Action</text>
</svg>`;
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// --- README updater: refreshes the stats block between STATS markers ---
function buildReadmeStatsBlock(startYear) {
  const currentYear = new Date().getFullYear();
  const base = `https://github.com/${USERNAME}`;
  const yearLink = (y) =>
    `<a href="${base}?tab=overview&from=${y}-01-01&to=${y}-12-31">${y}</a>`;

  const years = [];
  for (let y = currentYear; y >= startYear; y--) years.push(yearLink(y));

  return `<!-- STATS:START -->
<div align="center">
  <a href="${base}">
    <img src="stats.svg" alt="GitHub Activity Stats" width="840" />
  </a>
</div>

<div align="center">
  <sub>View period · ${years.join(" · ")}</sub>
</div>
<!-- STATS:END -->`;
}

function updateReadme(startYear) {
  const readmePath = "README.md";
  if (!existsSync(readmePath)) {
    console.log("No README.md found — skipping README update.");
    return;
  }

  const original = readFileSync(readmePath, "utf8");
  const block = buildReadmeStatsBlock(startYear);
  const markerPattern = /<!-- STATS:START -->[\s\S]*?<!-- STATS:END -->/;

  let updated;
  if (markerPattern.test(original)) {
    updated = original.replace(markerPattern, block);
  } else {
    // First run: replace an existing stats image div with the marked block
    const imgDivPattern =
      /<div align="center">\s*<img src="stats\.svg"[^>]*\/?>\s*<\/div>/;
    if (imgDivPattern.test(original)) {
      updated = original.replace(imgDivPattern, block);
    } else {
      console.warn(
        "Could not find stats section or markers in README — skipping update."
      );
      return;
    }
  }

  if (updated !== original) {
    writeFileSync(readmePath, updated);
    console.log("README.md updated with stats block.");
  } else {
    console.log("README.md already up to date.");
  }
}

// --- Main ---
async function main() {
  if (!TOKEN) {
    console.error("ERROR: No GitHub token found.");
    console.error("Set GH_TOKEN as a repository secret (Settings > Secrets > Actions).");
    console.error("Create a classic PAT at: https://github.com/settings/tokens");
    console.error("Required scopes:");
    console.error("  - read:user       (public contributions)");
    console.error("  - read:org        (organization memberships + org contributions)");
    console.error("  - repo            (private repo contributions)");
    console.error("Also enable: Profile > 'Include private contributions on my profile'");
    process.exit(1);
  }

  console.log(`Token present: ${TOKEN.slice(0, 4)}...${TOKEN.slice(-4)}`);

  // 1. Fetch profile + repos
  console.log("Fetching profile and repositories...");
  const profile = await fetchProfile();
  if (!profile) {
    console.error("Could not fetch profile data.");
    process.exit(1);
  }
  console.log(`  Repos: ${profile.repositories.totalCount}`);
  console.log(`  Account created: ${profile.createdAt}`);

  // 2. Process languages — combine owned + contributed repos for fuller picture
  const contributedRepos = profile.repositoriesContributedTo?.nodes || [];
  console.log(`  Contributed repos: ${contributedRepos.length}`);
  const allRepos = [...profile.repositories.nodes, ...contributedRepos];
  let languages = processLanguages(allRepos);
  if (languages.length === 0) {
    console.log("  No languages from GraphQL, trying REST fallback...");
    const langMap = await fetchLanguagesREST(profile.repositories.nodes);
    languages = processLanguagesFromMap(langMap);
  }
  console.log(`  Languages: ${languages.map((l) => `${l.name} ${l.percent}%`).join(", ")}`);

  // 3. Fetch ALL-TIME contributions (year by year)
  console.log("Fetching all-time contributions...");
  const contributions = await fetchAllContributions(profile.createdAt);

  // 4. Fetch per-organization contributions (commits, PRs, issues)
  const orgs = profile.organizations?.nodes || [];
  console.log(`Fetching contributions for ${orgs.length} organization(s)...`);
  const orgContribs = await fetchOrgContributions(orgs, profile.createdAt);
  if (orgContribs.length > 0) {
    console.log(`  Active orgs: ${orgContribs.map((o) => `${o.login} (${o.commits}c/${o.prs}p/${o.issues}i)`).join(", ")}`);
  }

  // 5. Generate SVG
  console.log("Generating SVG...");
  const svg = generateSVG({
    contributions,
    repos: profile.repositories,
    languages,
    orgContribs,
  });

  writeFileSync("stats.svg", svg);
  console.log("stats.svg written successfully.");

  // 6. Refresh README stats block with fresh year links
  const startYear = contributions?.startYear || new Date(profile.createdAt).getFullYear();
  updateReadme(startYear);
}

main().catch((err) => {
  console.error("Fatal error:", err.message);
  process.exit(1);
});
