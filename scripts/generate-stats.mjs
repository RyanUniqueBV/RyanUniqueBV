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

// --- GitHub GraphQL ---
async function fetchGitHubData() {
  const query = `
    query($login: String!) {
      user(login: $login) {
        contributionsCollection {
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
        }
        repositories(first: 100, ownerAffiliations: OWNER, orderBy: { field: UPDATED_AT, direction: DESC }) {
          totalCount
          nodes {
            name
            stargazerCount
            primaryLanguage {
              name
              color
            }
            languages(first: 10, orderBy: { field: SIZE, direction: DESC }) {
              edges {
                size
                node {
                  name
                  color
                }
              }
            }
          }
        }
      }
    }
  `;

  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables: { login: USERNAME } }),
  });

  const json = await res.json();
  if (json.errors) {
    console.error("GraphQL errors:", JSON.stringify(json.errors, null, 2));
    process.exit(1);
  }
  return json.data.user;
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
  return sorted.map(([name, { size, color }]) => ({
    name,
    color,
    percent: Math.round((size / total) * 100),
  }));
}

function getHeatmapData(weeks) {
  // Last 26 weeks
  const recent = weeks.slice(-26);
  return recent;
}

function getActivityByDay(weeks) {
  const days = [0, 0, 0, 0, 0, 0, 0]; // Sun-Sat
  const allWeeks = weeks.slice(-52);
  for (const week of allWeeks) {
    for (const day of week.contributionDays) {
      days[day.weekday] += day.contributionCount;
    }
  }
  return days;
}

function getPeakHours(weeks) {
  // We can't get hour data from GraphQL, so we'll show day-of-week distribution instead
  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const days = getActivityByDay(weeks);
  const max = Math.max(...days);
  return days.map((count, i) => ({
    day: dayNames[i],
    count,
    ratio: max > 0 ? count / max : 0,
  }));
}

// --- SVG Generation ---
function generateSVG(data) {
  const { contributionsCollection, repositories } = data;
  const calendar = contributionsCollection.contributionCalendar;
  const weeks = calendar.weeks;
  const totalContributions = calendar.totalContributions;
  const totalCommits = contributionsCollection.totalCommitContributions;
  const totalPRs = contributionsCollection.totalPullRequestContributions;
  const totalRepos = repositories.totalCount;
  const totalStars = repositories.nodes.reduce((s, r) => s + r.stargazerCount, 0);
  const languages = processLanguages(repositories.nodes);
  const heatmapWeeks = getHeatmapData(weeks);
  const dayActivity = getPeakHours(weeks);

  const width = 840;
  const height = 520;

  // Heatmap params
  const cellSize = 14;
  const cellGap = 3;
  const heatmapX = 50;
  const heatmapY = 200;
  const dayLabels = ["", "Mon", "", "Wed", "", "Fri", ""];

  // Get max contribution for color scaling
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

  // Build heatmap cells
  let heatmapCells = "";
  for (let w = 0; w < heatmapWeeks.length; w++) {
    const week = heatmapWeeks[w];
    for (const day of week.contributionDays) {
      const x = heatmapX + w * (cellSize + cellGap);
      const y = heatmapY + day.weekday * (cellSize + cellGap);
      const color = getColor(day.contributionCount);
      heatmapCells += `<rect x="${x}" y="${y}" width="${cellSize}" height="${cellSize}" rx="3" fill="${color}">
        <title>${day.date}: ${day.contributionCount} contributions</title>
      </rect>\n`;
    }
  }

  // Day labels for heatmap
  let dayLabelsSVG = "";
  for (let i = 0; i < dayLabels.length; i++) {
    if (dayLabels[i]) {
      const y = heatmapY + i * (cellSize + cellGap) + cellSize / 2 + 4;
      dayLabelsSVG += `<text x="${heatmapX - 10}" y="${y}" fill="${theme.textSecondary}" font-size="11" text-anchor="end" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif">${dayLabels[i]}</text>\n`;
    }
  }

  // Language bars
  const langX = 510;
  const langY = 200;
  const barWidth = 280;
  const barHeight = 10;
  let languageSVG = "";
  languages.forEach((lang, i) => {
    const y = langY + i * 34;
    const w = (lang.percent / 100) * barWidth;
    languageSVG += `
      <text x="${langX}" y="${y - 4}" fill="${theme.text}" font-size="12" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif">${lang.name}</text>
      <text x="${langX + barWidth}" y="${y - 4}" fill="${theme.textSecondary}" font-size="11" text-anchor="end" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif">${lang.percent}%</text>
      <rect x="${langX}" y="${y + 2}" width="${barWidth}" height="${barHeight}" rx="5" fill="${theme.border}" />
      <rect x="${langX}" y="${y + 2}" width="${w}" height="${barHeight}" rx="5" fill="${lang.color}" />
    `;
  });

  // Day-of-week activity bars
  const actX = 510;
  const actY = 430;
  const actBarWidth = 280;
  let activitySVG = "";
  dayActivity.forEach((d, i) => {
    const x = actX + i * 41;
    const maxBarH = 50;
    const barH = Math.max(2, d.ratio * maxBarH);
    const barY = actY - barH;
    activitySVG += `
      <rect x="${x}" y="${barY}" width="28" height="${barH}" rx="4" fill="${d.ratio > 0.6 ? theme.accent : theme.border}" opacity="${Math.max(0.3, d.ratio)}" />
      <text x="${x + 14}" y="${actY + 16}" fill="${theme.textSecondary}" font-size="10" text-anchor="middle" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif">${d.day}</text>
    `;
  });

  // Metric cards
  const metrics = [
    { label: "Contributions", value: totalContributions, icon: "M7.5 3.5a2 2 0 1 1 0 4 2 2 0 0 1 0-4Zm4.5 0a2 2 0 1 1 0 4 2 2 0 0 1 0-4ZM5.5 9.5a2 2 0 0 0-2 2v1h9v-1a2 2 0 0 0-2-2h-5Z" },
    { label: "Commits", value: totalCommits, icon: "M1.643 3.143.427 1.927A.25.25 0 0 1 .604 1.5h2.792a.25.25 0 0 1 .177.427L2.357 3.143a.25.25 0 0 1-.354 0ZM4 6.75a.75.75 0 0 1 .75-.75h6.5a.75.75 0 0 1 0 1.5h-6.5A.75.75 0 0 1 4 6.75Z" },
    { label: "Repositories", value: totalRepos, icon: "M2 2.5A2.5 2.5 0 0 1 4.5 0h8.75a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1 0-1.5h1.75v-2h-8a1 1 0 0 0-.714 1.7.75.75 0 1 1-1.072 1.05A2.495 2.495 0 0 1 2 11.5Z" },
    { label: "Stars", value: totalStars, icon: "M8 .25a.75.75 0 0 1 .673.418l1.882 3.815 4.21.612a.75.75 0 0 1 .416 1.279l-3.046 2.97.719 4.192a.751.751 0 0 1-1.088.791L8 12.347l-3.766 1.98a.75.75 0 0 1-1.088-.79l.72-4.194L.818 6.374a.75.75 0 0 1 .416-1.28l4.21-.611L7.327.668A.75.75 0 0 1 8 .25Z" },
  ];

  let metricsSVG = "";
  const metricSpacing = width / metrics.length;
  metrics.forEach((m, i) => {
    const x = i * metricSpacing + metricSpacing / 2;
    metricsSVG += `
      <text x="${x}" y="90" fill="${theme.accent}" font-size="28" font-weight="700" text-anchor="middle" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif">${m.value.toLocaleString()}</text>
      <text x="${x}" y="112" fill="${theme.textSecondary}" font-size="12" text-anchor="middle" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif">${m.label}</text>
    `;
  });

  // Timestamp
  const now = new Date();
  const timestamp = now.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" fill="none">
  <style>
    @media (prefers-color-scheme: light) {
      .bg { fill: #ffffff; }
      .card { fill: #f6f8fa; stroke: #d0d7de; }
      .text-primary { fill: #1f2328; }
      .text-secondary { fill: #656d76; }
      .accent { fill: #0969da; }
    }
  </style>

  <!-- Background -->
  <rect class="bg" width="${width}" height="${height}" rx="12" fill="${theme.bg}" />
  <rect width="${width}" height="${height}" rx="12" fill="none" stroke="${theme.border}" stroke-width="1" />

  <!-- Header -->
  <text x="30" y="42" fill="${theme.text}" font-size="16" font-weight="600" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif">GitHub Activity</text>
  <text x="${width - 30}" y="42" fill="${theme.textSecondary}" font-size="11" text-anchor="end" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif">Updated ${timestamp}</text>
  <line x1="30" y1="55" x2="${width - 30}" y2="55" stroke="${theme.border}" stroke-width="1" />

  <!-- Metrics -->
  ${metricsSVG}

  <!-- Divider -->
  <line x1="30" y1="135" x2="${width - 30}" y2="135" stroke="${theme.border}" stroke-width="1" />

  <!-- Heatmap Section -->
  <text x="30" y="170" fill="${theme.text}" font-size="13" font-weight="600" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif">Contribution Activity</text>
  <text x="30" y="188" fill="${theme.textSecondary}" font-size="11" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif">Last 26 weeks</text>

  ${dayLabelsSVG}
  ${heatmapCells}

  <!-- Heatmap Legend -->
  <text x="${heatmapX}" y="${heatmapY + 7 * (cellSize + cellGap) + 20}" fill="${theme.textSecondary}" font-size="10" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif">Less</text>
  ${theme.green
    .map(
      (c, i) =>
        `<rect x="${heatmapX + 30 + i * 18}" y="${heatmapY + 7 * (cellSize + cellGap) + 10}" width="12" height="12" rx="2" fill="${c}" />`
    )
    .join("\n  ")}
  <text x="${heatmapX + 30 + 5 * 18 + 4}" y="${heatmapY + 7 * (cellSize + cellGap) + 20}" fill="${theme.textSecondary}" font-size="10" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif">More</text>

  <!-- Languages Section -->
  <text x="${langX}" y="170" fill="${theme.text}" font-size="13" font-weight="600" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif">Top Languages</text>
  <text x="${langX}" y="188" fill="${theme.textSecondary}" font-size="11" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif">By repository size</text>
  ${languageSVG}

  <!-- Weekly Activity Section -->
  <text x="${actX}" y="${actY - 70}" fill="${theme.text}" font-size="13" font-weight="600" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif">Weekly Pattern</text>
  <text x="${actX}" y="${actY - 55}" fill="${theme.textSecondary}" font-size="11" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif">Commits by day of week</text>
  ${activitySVG}

  <!-- Footer -->
  <line x1="30" y1="${height - 35}" x2="${width - 30}" y2="${height - 35}" stroke="${theme.border}" stroke-width="1" />
  <text x="${width / 2}" y="${height - 14}" fill="${theme.textSecondary}" font-size="10" text-anchor="middle" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif">Generated with a custom GitHub Action</text>
</svg>`;

  return svg;
}

// --- Main ---
async function main() {
  if (!TOKEN) {
    console.error("No GitHub token found. Set GH_TOKEN or GITHUB_TOKEN.");
    process.exit(1);
  }

  console.log("Fetching GitHub data...");
  const data = await fetchGitHubData();

  console.log("Generating SVG...");
  const svg = generateSVG(data);

  writeFileSync("stats.svg", svg);
  console.log("stats.svg written successfully.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
