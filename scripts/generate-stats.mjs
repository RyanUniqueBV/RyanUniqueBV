import { writeFileSync } from "fs";

const USERNAME = "RyanUniqueBV";
const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;

// --- Theme ---
const theme = {
  bg: "#0d1117",
  cardBg: "#161b22",
  border: "#30363d",
  text: "#e6edf3",
  textSecondary: "#7d8590",
  accent: "#58a6ff",
  green: ["#161b22", "#0e4429", "#006d32", "#26a641", "#39d353"],
};

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

async function fetchContributions() {
  const query = `
    query($login: String!) {
      user(login: $login) {
        contributionsCollection {
          totalCommitContributions
          totalPullRequestContributions
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
        }
      }
    }
  `;

  const json = await graphql(query, { login: USERNAME });

  if (json.errors) {
    console.warn("Contributions query failed:", JSON.stringify(json.errors));
    return null;
  }

  return json.data.user.contributionsCollection;
}

async function fetchRepos() {
  // Try GraphQL first for richer data
  const query = `
    query($login: String!) {
      user(login: $login) {
        repositories(first: 100, ownerAffiliations: OWNER, orderBy: { field: UPDATED_AT, direction: DESC }) {
          totalCount
          nodes {
            name
            stargazerCount
            languages(first: 10, orderBy: { field: SIZE, direction: DESC }) {
              edges {
                size
                node { name color }
              }
            }
          }
        }
      }
    }
  `;

  const json = await graphql(query, { login: USERNAME });

  if (json.errors) {
    console.warn("Repos GraphQL failed, falling back to REST...");
    const repos = await rest(`/users/${USERNAME}/repos?per_page=100&sort=updated`);
    return {
      totalCount: repos.length,
      nodes: repos.map((r) => ({
        name: r.name,
        stargazerCount: r.stargazers_count,
        languages: { edges: [] },
      })),
    };
  }

  return json.data.user.repositories;
}

async function fetchLanguagesREST(repos) {
  // Fallback: fetch languages per repo via REST
  const langMap = {};
  for (const repo of repos.slice(0, 20)) {
    try {
      const langs = await rest(`/repos/${USERNAME}/${repo.name}/languages`);
      for (const [name, bytes] of Object.entries(langs)) {
        if (!langMap[name]) langMap[name] = { size: 0, color: "#8b949e" };
        langMap[name].size += bytes;
      }
    } catch {
      // Skip repos we can't access
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
  const sorted = Object.entries(langMap)
    .sort((a, b) => b[1].size - a[1].size)
    .slice(0, 6);

  const total = sorted.reduce((sum, [, v]) => sum + v.size, 0);
  if (total === 0) return [];

  // Language colors lookup
  const colors = {
    PHP: "#4F5D95", JavaScript: "#f1e05a", TypeScript: "#3178c6",
    HTML: "#e34c26", CSS: "#563d7c", SCSS: "#c6538c", Shell: "#89e051",
    Python: "#3572A5", Vue: "#41b883", Blade: "#f7523f", Twig: "#c1d026",
  };

  return sorted.map(([name, { size }]) => ({
    name,
    color: colors[name] || "#8b949e",
    percent: Math.round((size / total) * 100),
  }));
}

function getPeakDays(weeks) {
  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const days = [0, 0, 0, 0, 0, 0, 0];
  for (const week of weeks.slice(-52)) {
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
function generateSVG({ contributions, repos, languages }) {
  const hasContribs = contributions !== null;
  const calendar = hasContribs ? contributions.contributionCalendar : null;
  const weeks = calendar ? calendar.weeks : [];
  const totalContributions = calendar ? calendar.totalContributions : 0;
  const totalCommits = hasContribs ? contributions.totalCommitContributions : 0;
  const totalPRs = hasContribs ? contributions.totalPullRequestContributions : 0;
  const totalRepos = repos.totalCount;
  const totalStars = repos.nodes.reduce((s, r) => s + r.stargazerCount, 0);
  const heatmapWeeks = weeks.slice(-26);
  const dayActivity = hasContribs ? getPeakDays(weeks) : [];

  const font = `-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif`;
  const width = 840;
  const height = hasContribs ? 520 : 340;

  // --- Metric cards ---
  const metrics = hasContribs
    ? [
        { label: "Contributions", value: totalContributions },
        { label: "Commits", value: totalCommits },
        { label: "Repositories", value: totalRepos },
        { label: "Stars", value: totalStars },
      ]
    : [
        { label: "Repositories", value: totalRepos },
        { label: "Stars", value: totalStars },
        { label: "Languages", value: languages.length },
      ];

  const metricSpacing = width / metrics.length;
  const metricsSVG = metrics
    .map((m, i) => {
      const x = i * metricSpacing + metricSpacing / 2;
      return `
      <text x="${x}" y="90" fill="${theme.accent}" font-size="28" font-weight="700" text-anchor="middle" font-family="${font}">${m.value.toLocaleString()}</text>
      <text x="${x}" y="112" fill="${theme.textSecondary}" font-size="12" text-anchor="middle" font-family="${font}">${m.label}</text>`;
    })
    .join("\n");

  // --- Heatmap ---
  const cellSize = 14;
  const cellGap = 3;
  const heatmapX = 50;
  const heatmapY = 200;

  let maxContrib = 0;
  for (const week of heatmapWeeks) {
    for (const day of week.contributionDays) {
      if (day.contributionCount > maxContrib) maxContrib = day.contributionCount;
    }
  }

  function getColor(count) {
    if (count === 0) return theme.green[0];
    if (maxContrib === 0) return theme.green[0];
    const ratio = count / maxContrib;
    if (ratio < 0.25) return theme.green[1];
    if (ratio < 0.5) return theme.green[2];
    if (ratio < 0.75) return theme.green[3];
    return theme.green[4];
  }

  let heatmapCells = "";
  for (let w = 0; w < heatmapWeeks.length; w++) {
    for (const day of heatmapWeeks[w].contributionDays) {
      const x = heatmapX + w * (cellSize + cellGap);
      const y = heatmapY + day.weekday * (cellSize + cellGap);
      heatmapCells += `<rect x="${x}" y="${y}" width="${cellSize}" height="${cellSize}" rx="3" fill="${getColor(day.contributionCount)}"><title>${day.date}: ${day.contributionCount} contributions</title></rect>\n`;
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

  // --- Languages ---
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

  // --- Weekly activity bars ---
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

  // --- Timestamp ---
  const timestamp = new Date().toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });

  // --- Compose SVG ---
  let contribSection = "";
  if (hasContribs) {
    contribSection = `
  <!-- Heatmap Section -->
  <text x="30" y="170" fill="${theme.text}" font-size="13" font-weight="600" font-family="${font}">Contribution Activity</text>
  <text x="30" y="188" fill="${theme.textSecondary}" font-size="11" font-family="${font}">Last 26 weeks</text>
  ${dayLabelsSVG}
  ${heatmapCells}
  <text x="${heatmapX}" y="${legendY + 10}" fill="${theme.textSecondary}" font-size="10" font-family="${font}">Less</text>
  ${legendSVG}
  <text x="${heatmapX + 30 + 5 * 18 + 4}" y="${legendY + 10}" fill="${theme.textSecondary}" font-size="10" font-family="${font}">More</text>

  <!-- Languages Section -->
  <text x="${langX}" y="170" fill="${theme.text}" font-size="13" font-weight="600" font-family="${font}">Top Languages</text>
  <text x="${langX}" y="188" fill="${theme.textSecondary}" font-size="11" font-family="${font}">By repository size</text>
  ${languageSVG}

  <!-- Weekly Activity Section -->
  <text x="${actX}" y="${actY - 70}" fill="${theme.text}" font-size="13" font-weight="600" font-family="${font}">Weekly Pattern</text>
  <text x="${actX}" y="${actY - 55}" fill="${theme.textSecondary}" font-size="11" font-family="${font}">Commits by day of week</text>
  ${activitySVG}`;
  } else {
    // Fallback: just show languages below metrics
    const fallbackLangX = 30;
    const fallbackLangY = 170;
    contribSection = `
  <text x="30" y="155" fill="${theme.text}" font-size="13" font-weight="600" font-family="${font}">Top Languages</text>
  ${languages
    .map((lang, i) => {
      const y = fallbackLangY + i * 28;
      const w = (lang.percent / 100) * (width - 60);
      return `
      <text x="${fallbackLangX}" y="${y}" fill="${theme.text}" font-size="12" font-family="${font}">${lang.name}</text>
      <text x="${width - 30}" y="${y}" fill="${theme.textSecondary}" font-size="11" text-anchor="end" font-family="${font}">${lang.percent}%</text>
      <rect x="${fallbackLangX}" y="${y + 4}" width="${width - 60}" height="8" rx="4" fill="${theme.border}" />
      <rect x="${fallbackLangX}" y="${y + 4}" width="${w}" height="8" rx="4" fill="${lang.color}" />`;
    })
    .join("\n")}`;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" fill="none">
  <!-- Background -->
  <rect width="${width}" height="${height}" rx="12" fill="${theme.bg}" />
  <rect width="${width}" height="${height}" rx="12" fill="none" stroke="${theme.border}" stroke-width="1" />

  <!-- Header -->
  <text x="30" y="42" fill="${theme.text}" font-size="16" font-weight="600" font-family="${font}">GitHub Activity</text>
  <text x="${width - 30}" y="42" fill="${theme.textSecondary}" font-size="11" text-anchor="end" font-family="${font}">Updated ${timestamp}</text>
  <line x1="30" y1="55" x2="${width - 30}" y2="55" stroke="${theme.border}" stroke-width="1" />

  <!-- Metrics -->
  ${metricsSVG}

  <!-- Divider -->
  <line x1="30" y1="135" x2="${width - 30}" y2="135" stroke="${theme.border}" stroke-width="1" />

  ${contribSection}

  <!-- Footer -->
  <line x1="30" y1="${height - 35}" x2="${width - 30}" y2="${height - 35}" stroke="${theme.border}" stroke-width="1" />
  <text x="${width / 2}" y="${height - 14}" fill="${theme.textSecondary}" font-size="10" text-anchor="middle" font-family="${font}">Generated with a custom GitHub Action</text>
</svg>`;
}

// --- Main ---
async function main() {
  if (!TOKEN) {
    console.error("ERROR: No GitHub token found.");
    console.error("Set GH_TOKEN as a repository secret (Settings > Secrets > Actions).");
    console.error("Create a PAT at: https://github.com/settings/tokens?type=beta");
    console.error("Required scope: read:user (for contribution data)");
    process.exit(1);
  }

  console.log(`Token present: ${TOKEN.slice(0, 4)}...${TOKEN.slice(-4)}`);

  // Fetch repos (should always work)
  console.log("Fetching repositories...");
  const repos = await fetchRepos();
  console.log(`Found ${repos.totalCount} repositories.`);

  // Process languages
  let languages = processLanguages(repos.nodes);
  if (languages.length === 0) {
    console.log("No languages from GraphQL, trying REST fallback...");
    const langMap = await fetchLanguagesREST(repos.nodes);
    languages = processLanguagesFromMap(langMap);
  }
  console.log(`Languages: ${languages.map((l) => l.name).join(", ")}`);

  // Fetch contributions (might fail without PAT)
  console.log("Fetching contributions...");
  const contributions = await fetchContributions();
  if (contributions) {
    console.log(`Total contributions: ${contributions.contributionCalendar.totalContributions}`);
  } else {
    console.warn("Could not fetch contribution data. Add a PAT with read:user scope as GH_TOKEN secret for full stats.");
  }

  // Generate SVG
  console.log("Generating SVG...");
  const svg = generateSVG({ contributions, repos, languages });

  writeFileSync("stats.svg", svg);
  console.log("stats.svg written successfully.");
}

main().catch((err) => {
  console.error("Fatal error:", err.message);
  process.exit(1);
});
