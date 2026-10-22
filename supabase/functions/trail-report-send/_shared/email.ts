// Trail Report — email rendering (shared by trail-report-send).
// Visual language per spec §2.3: night background, gold headlines, dim body.
// Table-based HTML for email clients. NO tracking pixels, NO open/click
// tracking — this is a static document with the user's own numbers.

export interface WeekStats {
  trackers: number;
  ads: number;
  fingerprinting?: number;
  httpsUpgrades?: number;
  bytesSaved?: number; // bytes
  msSaved?: number; // milliseconds
  days?: Array<{ date: string; trackers: number; ads: number }>;
  topDomains?: Array<{ domain: string; count: number }>;
}

export interface RenderInput {
  stats: WeekStats;
  email: string;
  trailToken: string;
  functionBase: string; // e.g. https://<ref>.supabase.co/functions/v1
  sample?: boolean;
}

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

function fmtBytes(bytes: number): string {
  if (bytes >= 1e9) return `≈${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `≈${(bytes / 1e6).toFixed(0)} MB`;
  if (bytes >= 1e3) return `≈${(bytes / 1e3).toFixed(0)} KB`;
  return `${bytes} B`;
}

function fmtTime(ms: number): string {
  const min = Math.round(ms / 60000);
  if (min >= 60) return `≈${(min / 60).toFixed(1)} hr`;
  return `≈${min} min`;
}

const NIGHT = "#0E0A1A";
const DEEP = "#160F2B";
const GOLD = "#E8C266";
const DIM = "#A79DC4";
const BODY = "#EDE9F7";

export function renderSubject(stats: WeekStats, sample = false): string {
  const t = fmt(stats.trackers || 0);
  return sample
    ? `Your week in StarBrook ✨ (sample)`
    : `Your week in StarBrook ✨`;
}

export function renderPreheader(stats: WeekStats): string {
  return `${fmt(stats.trackers || 0)} trackers blocked. Zero followed you home.`;
}

export function renderHtml(input: RenderInput): string {
  const { stats, email, trailToken, functionBase, sample } = input;
  const trackers = stats.trackers || 0;
  const ads = stats.ads || 0;
  const bytesSaved = stats.bytesSaved || 0;
  const msSaved = stats.msSaved || 0;
  const days = (stats.days || []).slice(0, 7);
  const topDomains = (stats.topDomains || []).slice(0, 5);
  const unsub = `${functionBase}/trail-report-subscribe/unsubscribe?token=${trailToken}`;

  // 7-day bars as a table (email-safe). Scale to the max day.
  const maxDay = Math.max(1, ...days.map((d) => d.trackers + d.ads));
  const bars = days
    .map((d) => {
      const total = d.trackers + d.ads;
      const h = Math.max(4, Math.round((total / maxDay) * 96));
      const label = d.date.slice(5).replace("-", "/");
      return `<td align="center" valign="bottom" style="padding:0 4px;">
        <div style="width:28px;height:${h}px;background:${GOLD};border-radius:3px 3px 0 0;"></div>
        <div style="font-size:10px;color:${DIM};padding-top:4px;">${label}</div>
      </td>`;
    })
    .join("");

  const domains = topDomains.length
    ? topDomains
        .map(
          (d) => `<tr>
        <td style="padding:8px 0;border-bottom:1px solid #2A2145;color:${BODY};">${esc(d.domain)}</td>
        <td align="right" style="padding:8px 0;border-bottom:1px solid #2A2145;color:${GOLD};font-weight:bold;">${fmt(d.count)}</td>
      </tr>`,
        )
        .join("")
    : `<tr><td style="padding:8px 0;color:${DIM};">No repeat offenders this week.</td></tr>`;

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>${renderSubject(stats, sample)}</title></head>
<body style="margin:0;padding:0;background:${NIGHT};color:${BODY};font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${renderPreheader(stats)}</div>
<table width="100%" cellpadding="0" cellspacing="0" style="background:${NIGHT};padding:32px 16px;">
<tr><td align="center">
<table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;">
<tr><td align="center" style="padding-bottom:24px;">
<div style="font-size:28px;">⭐</div>
<div style="color:${GOLD};font-size:13px;letter-spacing:3px;text-transform:uppercase;">StarBrook Trail Report</div>
${sample ? `<div style="color:${DIM};font-size:12px;padding-top:8px;">Sample — your real report arrives Sunday evening.</div>` : ""}
</td></tr>
<tr><td style="background:${DEEP};border-radius:12px;padding:32px 24px;">
<table width="100%" cellpadding="0" cellspacing="0"><tr>
<td align="center" style="padding:8px;">
<div style="font-size:40px;font-weight:800;color:${GOLD};">${fmt(trackers)}</div>
<div style="font-size:12px;color:${DIM};text-transform:uppercase;letter-spacing:1px;">Trackers blocked</div>
</td>
<td align="center" style="padding:8px;">
<div style="font-size:40px;font-weight:800;color:${GOLD};">${fmt(ads)}</div>
<div style="font-size:12px;color:${DIM};text-transform:uppercase;letter-spacing:1px;">Ads blocked</div>
</td>
</tr><tr>
<td align="center" style="padding:8px;">
<div style="font-size:28px;font-weight:700;color:${BODY};">${fmtBytes(bytesSaved)}</div>
<div style="font-size:12px;color:${DIM};text-transform:uppercase;letter-spacing:1px;">Data saved (est.)</div>
</td>
<td align="center" style="padding:8px;">
<div style="font-size:28px;font-weight:700;color:${BODY};">${fmtTime(msSaved)}</div>
<div style="font-size:12px;color:${DIM};text-transform:uppercase;letter-spacing:1px;">Time saved (est.)</div>
</td>
</tr></table>
</td></tr>
${days.length ? `<tr><td style="padding-top:24px;">
<div style="color:${GOLD};font-size:13px;letter-spacing:2px;text-transform:uppercase;padding-bottom:12px;">Your week, day by day</div>
<table cellpadding="0" cellspacing="0" align="center"><tr>${bars}</tr></table>
</td></tr>` : ""}
<tr><td style="padding-top:24px;">
<div style="color:${GOLD};font-size:13px;letter-spacing:2px;text-transform:uppercase;padding-bottom:4px;">Most-blocked this week</div>
<table width="100%" cellpadding="0" cellspacing="0">${domains}</table>
</td></tr>
<tr><td align="center" style="padding:32px 0 8px;">
<div style="color:${DIM};font-size:14px;font-style:italic;">"Follow the star. Leave no trail — here's the proof."</div>
</td></tr>
<tr><td style="padding-top:16px;border-top:1px solid #2A2145;">
<p style="font-size:12px;color:${DIM};line-height:1.6;">
You're getting this because you asked for it in StarBrook's Trail Report settings.
<a href="${unsub}" style="color:${GOLD};">Unsubscribe anytime</a> — one click, no login.<br>
This email contains only your own numbers. No tracking pixels, no open or click tracking, ever.
</p>
</td></tr>
</table>
</td></tr></table>
</body></html>`;
}

export function renderText(input: RenderInput): string {
  const { stats, trailToken, functionBase, sample } = input;
  const trackers = stats.trackers || 0;
  const ads = stats.ads || 0;
  const unsub = `${functionBase}/trail-report-subscribe/unsubscribe?token=${trailToken}`;
  const lines = [
    `STARBOOK TRAIL REPORT${sample ? " (SAMPLE)" : ""}`,
    `==============================`,
    ``,
    `Trackers blocked: ${fmt(trackers)}`,
    `Ads blocked:      ${fmt(ads)}`,
    `Data saved:       ${fmtBytes(stats.bytesSaved || 0)} (est.)`,
    `Time saved:       ${fmtTime(stats.msSaved || 0)} (est.)`,
    ``,
  ];
  const top = (stats.topDomains || []).slice(0, 5);
  if (top.length) {
    lines.push(`Most-blocked this week:`);
    for (const d of top) lines.push(`  ${d.domain}: ${fmt(d.count)}`);
    lines.push(``);
  }
  lines.push(`"Follow the star. Leave no trail — here's the proof."`);
  lines.push(``);
  lines.push(`Unsubscribe anytime (one click, no login): ${unsub}`);
  lines.push(`No tracking pixels, no open or click tracking, ever.`);
  return lines.join("\n");
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
