// Aggregate grouped test results under benchmark/data into a mobile single-page report (curves + details merged into one view).
// Usage: node benchmark/report.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEEPSEEK_OFFICIAL_PRICING } from '../server/benchmark-metrics.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const inputDir = path.join(ROOT, 'benchmark', 'data');
const outputDir = path.join(ROOT, 'benchmark', 'output');
fs.mkdirSync(outputDir, { recursive: true });

const GROUPS = [
  { id: 'tiny', label: 'Very short conversation', turns: 10 },
  { id: 'short', label: 'Short conversation', turns: 20 },
  { id: 'medium', label: 'Medium conversation', turns: 50 },
  { id: 'long', label: 'Long conversation', turns: 70 },
  { id: 'xlong', label: 'Very long conversation', turns: 100 }
];
const VARIANTS = {
  opt: { label: 'Cache-stable optimized (PTC + context engine)', short: 'Optimized', color: '#2563eb' },
  base: { label: 'Traditional framework (native tool calling + full history)', short: 'Traditional', color: '#ef4444' }
};

const files = fs.existsSync(inputDir)
  ? fs.readdirSync(inputDir).filter((name) => name.endsWith('.json') && !name.startsWith('smoke'))
  : [];

const buckets = new Map();
let modelName = '';
const pricingTiers = new Set();
for (const name of files) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(path.join(inputDir, name), 'utf8'));
  } catch {
    continue;
  }
  if (!data?.group || !data?.variant || !Array.isArray(data.results)) continue;
  modelName = modelName || data.model || '';
  const key = `${data.group}:${data.variant}`;
  if (!buckets.has(key)) buckets.set(key, []);
  for (const run of data.results) {
    if (!run?.totals) continue;
    // The two groups may span peak and off-peak periods; recompute at the off-peak price to avoid mistaking the 2× tier difference for an optimization difference.
    const pricing = DEEPSEEK_OFFICIAL_PRICING.offPeak;
    pricingTiers.add('same off-peak tier');
    const totals = run.totals;
    const cost = (Number(totals.cacheHitTokens) || 0) * pricing.cacheHit / 1e6
      + (Number(totals.cacheMissTokens) || 0) * pricing.cacheMiss / 1e6
      + (Number(totals.completionTokens) || 0) * pricing.output / 1e6;
    buckets.get(key).push({
      ...totals,
      officialCostCny: Number(cost.toFixed(6)),
      pricingTier: pricing.tier
    });
  }
}

function average(values) {
  if (!values.length) return null;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

const summary = { generatedAt: new Date().toISOString(), model: modelName, groups: [] };
for (const group of GROUPS) {
  const entry = { id: group.id, label: group.label, turns: group.turns, variants: {} };
  for (const variant of Object.keys(VARIANTS)) {
    const runs = buckets.get(`${group.id}:${variant}`) || [];
    if (!runs.length) continue;
    const turns = runs.map((item) => item.completedTurns || 0);
    const tokens = runs.map((item) => item.totalTokens || 0);
    const durations = runs.map((item) => item.durationMs || 0);
    const accuracies = runs.map((item) => item.accuracy || 0);
    const caches = runs.map((item) => item.cacheHitRate).filter((value) => value != null);
    entry.variants[variant] = {
      runs: runs.length,
      avgTurns: Number(average(turns)?.toFixed(1)),
      avgTokens: Math.round(average(tokens) || 0),
      tokensPerTurn: Math.round((average(tokens) || 0) / Math.max(1, average(turns) || 1)),
      avgDurationMs: Math.round(average(durations) || 0),
      msPerTurn: Math.round((average(durations) || 0) / Math.max(1, average(turns) || 1)),
      accuracy: Number((average(accuracies) || 0).toFixed(4)),
      cacheHitRate: caches.length ? Number((average(caches) || 0).toFixed(4)) : null,
      avgHitTokens: Math.round(average(runs.map((item) => item.cacheHitTokens || 0)) || 0),
      avgMissTokens: Math.round(average(runs.map((item) => item.cacheMissTokens || 0)) || 0),
      avgCostCny: Number((average(runs.map((item) => item.officialCostCny)) || 0).toFixed(4)),
      // Same basis as the README table: total group cost divided by turns gives the estimated cost per turn.
      costPerTurn: Number(((average(runs.map((item) => item.officialCostCny)) || 0)
        / Math.max(1, average(turns) || 1)).toFixed(6)),
      avgToolCalls: Math.round(average(runs.map((item) => item.toolCalls || 0)) || 0),
      totalTurns: turns.reduce((total, value) => total + value, 0)
    };
  }
  summary.groups.push(entry);
}

const fmtTokens = (value) => {
  const number = Number(value) || 0;
  if (number >= 1e6) return `${(number / 1e6).toFixed(2)}M`;
  if (number >= 1e3) return `${(number / 1e3).toFixed(1)}k`;
  return String(number);
};
const fmtTime = (ms) => {
  const seconds = (Number(ms) || 0) / 1000;
  if (seconds >= 60) return `${(seconds / 60).toFixed(1)}m`;
  return `${seconds.toFixed(1)}s`;
};
const fmtPct = (value) => (value == null ? '--' : `${(value * 100).toFixed(1)}%`);
const fmtPctRound = (value) => (value == null ? '--' : `${Math.round(value * 100)}%`);
const fmtCny = (value) => {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return '--';
  if (amount === 0) return '¥0';
  if (amount >= 1) return `¥${amount.toFixed(2)}`;
  if (amount >= 0.001) return `¥${amount.toFixed(4)}`;
  return `¥${amount.toFixed(6)}`;
};

function seriesFor(metric) {
  return Object.keys(VARIANTS).map((variant) => {
    const points = [];
    for (const group of summary.groups) {
      const data = group.variants[variant];
      if (!data) continue;
      let value;
      if (metric === 'tokens') value = data.avgTokens;
      else if (metric === 'tokensPerTurn') value = data.tokensPerTurn;
      else if (metric === 'duration') value = data.avgDurationMs / 1000;
      else if (metric === 'accuracy') value = data.accuracy * 100;
      else if (metric === 'missTokens') value = data.avgMissTokens;
      else if (metric === 'cost') value = data.costPerTurn;
      points.push({ x: group.turns, y: value });
    }
    return { variant, label: VARIANTS[variant].short, color: VARIANTS[variant].color, points };
  });
}

function lineChart({ title, unit, metric, formatter }) {
  // Narrow the viewBox to 300 so the same width scales the font up (about 1.26×), clearer on phones.
  const width = 300;
  const height = 190;
  const padding = { top: 30, right: 10, bottom: 32, left: 40 };
  const innerW = width - padding.left - padding.right;
  const innerH = height - padding.top - padding.bottom;
  const series = seriesFor(metric).filter((item) => item.points.length);
  const allValues = series.flatMap((item) => item.points.map((point) => point.y));
  // Cost is a decimal (about ¥0.01 per turn) and must not have its lower bound raised to 1 like tokens/duration, or the curve is flattened into a straight line.
  const maxValue = Math.max(...allValues, 0);
  const niceMax = metric === 'accuracy' ? 100 : maxValue > 0 ? maxValue * 1.15 : 1;
  const xTicks = GROUPS.map((group) => group.turns);
  // Evenly spaced (categorical axis), preventing 8/20-turn points from crowding together on a proportional axis and overlapping labels.
  const xFor = (value) => {
    const index = Math.max(0, xTicks.indexOf(value));
    return padding.left + (index / Math.max(1, xTicks.length - 1)) * innerW;
  };
  const yFor = (value) => padding.top + innerH - (value / niceMax) * innerH;
  const grids = [0, 0.5, 1].map((ratio) => {
    const y = padding.top + innerH - ratio * innerH;
    const value = niceMax * ratio;
    return `<line x1="${padding.left}" y1="${y}" x2="${width - padding.right}" y2="${y}" stroke="#e5e7eb" stroke-width="1"/>
      <text x="${padding.left - 5}" y="${y + 4}" text-anchor="end" font-size="10.5" fill="#6b7280">${formatter(value)}</text>`;
  }).join('');
  const xLabels = xTicks.map((value, index) => `<text x="${xFor(value) + (index === xTicks.length - 1 ? -2 : 0)}" y="${height - 10}" text-anchor="${index === xTicks.length - 1 ? 'end' : index === 0 ? 'start' : 'middle'}" font-size="10.5" fill="#4b5563">${value} turns</text>`).join('');
  const paths = series.map((item) => {
    const points = item.points.map((point) => [xFor(point.x), yFor(point.y)]);
    const pathD = points.map((point, index) => `${index ? 'L' : 'M'}${point[0].toFixed(1)},${point[1].toFixed(1)}`).join(' ');
    const dots = points.map((point) => `<circle cx="${point[0].toFixed(1)}" cy="${point[1].toFixed(1)}" r="2.8" fill="${item.color}"/>`).join('');
    // The two accuracy lines almost overlap; use a dashed line for the optimized variant so both stay visible.
    const dash = metric === 'accuracy' && item.variant === 'opt' ? ' stroke-dasharray="5 3"' : '';
    return `<path d="${pathD}" fill="none" stroke="${item.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"${dash}/>${dots}`;
  }).join('');
  // Value labels: when the two lines at the same x are close, label the upper one above the point and the lower one below, avoiding overlap.
  const labelGroups = new Map();
  if (metric !== 'accuracy') {
    for (const item of series) {
      item.points.forEach((point, index) => {
        const list = labelGroups.get(index) || [];
        list.push({ x: xFor(point.x), y: yFor(point.y), color: item.color, variant: item.variant, text: formatter(point.y) });
        labelGroups.set(index, list);
      });
    }
  }
  const labels = [...labelGroups.entries()].map(([index, list]) => {
    list.sort((a, b) => a.y - b.y);
    const anchor = index === 0 ? 'start' : index === xTicks.length - 1 ? 'end' : 'middle';
    const dx = index === 0 ? 5 : index === xTicks.length - 1 ? -5 : 0;
    const topLimit = padding.top + 11;
    const bottomLimit = padding.top + innerH - 3;
    const clamp = (value) => Math.min(Math.max(value, topLimit), bottomLimit);
    const placed = list.map((item) => {
      // The optimized variant is always labeled below the point and the traditional one above; flip to the other side and clamp when out of bounds.
      let y = item.variant === 'opt' ? item.y + 13 : item.y - 9;
      if (y > bottomLimit || y < topLimit) y = item.variant === 'opt' ? item.y - 9 : item.y + 13;
      return { ...item, ly: clamp(y) };
    });
    // When the two labels are too close, raise the upper one further so their white outlines do not cover each other.
    if (placed.length === 2 && Math.abs(placed[0].ly - placed[1].ly) < 14) {
      placed[0].ly = clamp(placed[0].ly - 15);
      if (Math.abs(placed[0].ly - placed[1].ly) < 12) placed[0].ly = clamp(placed[1].ly - 22);
    }
    return placed.map((item) => `<text x="${(item.x + dx).toFixed(1)}" y="${item.ly.toFixed(1)}" text-anchor="${anchor}" font-size="10.5" font-weight="600" fill="${item.color}" stroke="#ffffff" stroke-width="3" stroke-linejoin="round" paint-order="stroke">${item.text}</text>`).join('');
  }).join('');
  const legend = series.map((item, index) => `<g transform="translate(${padding.left + index * 132}, 12)">
      <circle cx="4" cy="0" r="3.5" fill="${item.color}"/>
      <text x="11" y="3.5" font-size="10.5" fill="#374151">${item.label}</text>
    </g>`).join('');
  return `<div class="chart-card">
    <h3>${title}<span>${unit}</span></h3>
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${title}">
      ${grids}${xLabels}${paths}${labels}${legend}
      <line x1="${padding.left}" y1="${padding.top}" x2="${padding.left}" y2="${height - padding.bottom}" stroke="#9ca3af" stroke-width="1"/>
      <line x1="${padding.left}" y1="${height - padding.bottom}" x2="${width - padding.right}" y2="${height - padding.bottom}" stroke="#9ca3af" stroke-width="1"/>
    </svg>
  </div>`;
}

function delta(optValue, baseValue) {
  if (!optValue || !baseValue) return null;
  return (1 - optValue / baseValue) * 100;
}

const groupCards = summary.groups.map((group) => {
  const opt = group.variants.opt;
  const base = group.variants.base;
  if (!opt && !base) return '';
  const tokenDelta = delta(opt?.avgTokens, base?.avgTokens);
  const timeDelta = delta(opt?.avgDurationMs, base?.avgDurationMs);
  const tag = (value, goodWord) => {
    if (value == null) return '';
    return value >= 0
      ? `<em>${goodWord}${value.toFixed(1)}%</em>`
      : `<i>+${(Math.abs(value)).toFixed(1)}%</i>`;
  };
  return `<div class="group">
    <div class="group-top"><b>${group.label}</b><span>${group.turns} turns · accuracy ${fmtPctRound(opt?.accuracy)}/${fmtPctRound(base?.accuracy)}</span></div>
    <div class="group-line">tokens <b>${opt ? fmtTokens(opt.avgTokens) : '--'}</b> · <b>${base ? fmtTokens(base.avgTokens) : '--'}</b> ${tag(tokenDelta, 'less ')}</div>
    <div class="group-line">time <b>${opt ? fmtTime(opt.avgDurationMs) : '--'}</b> · <b>${base ? fmtTime(base.avgDurationMs) : '--'}</b> ${tag(timeDelta, 'faster ')}</div>
    <div class="group-sub">cache hits ${fmtPct(opt?.cacheHitRate)} · misses ${opt ? fmtTokens(opt.avgMissTokens) : '--'} / ${base ? fmtTokens(base.avgMissTokens) : '--'}</div>
    <div class="group-sub">cost per turn ${opt ? fmtCny(opt.costPerTurn) : '--'} / ${base ? fmtCny(base.costPerTurn) : '--'} · tools ${opt?.avgToolCalls ?? '--'}/${base?.avgToolCalls ?? '--'} calls · runs ${opt?.runs ?? 0}</div>
  </div>`;
}).filter(Boolean).join('');

const optGroups = summary.groups.filter((group) => group.variants.opt);
const optCacheRates = optGroups.map((group) => group.variants.opt.cacheHitRate).filter((value) => value != null);
const optCacheAverage = optCacheRates.length ? optCacheRates.reduce((total, value) => total + value, 0) / optCacheRates.length : null;
const optAccuracyAverage = optGroups.length ? average(optGroups.map((group) => group.variants.opt.accuracy)) : null;
const optMissAverage = optGroups.length ? average(optGroups.map((group) => group.variants.opt.avgMissTokens)) : null;
const optCostPerTurn = optGroups.length
  ? optGroups.reduce((sum, group) => sum + group.variants.opt.avgCostCny, 0)
    / Math.max(1, optGroups.reduce((sum, group) => sum + group.variants.opt.avgTurns, 0))
  : null;
const totalTurns = summary.groups.reduce((total, group) => total + Object.values(group.variants).reduce((sum, item) => sum + item.totalTurns, 0), 0);

const groupSummary = summary.groups.map((group) => {
  const opt = group.variants.opt;
  const base = group.variants.base;
  if (!opt || !base) return '';
  const tokenDelta = delta(opt.avgTokens, base.avgTokens) || 0;
  const timeDelta = delta(opt.avgDurationMs, base.avgDurationMs) || 0;
  const tokenText = tokenDelta >= 0
    ? `consumed <b>${tokenDelta.toFixed(1)}%</b> fewer`
    : `consumed <b>${Math.abs(tokenDelta).toFixed(1)}%</b> more`;
  const timeText = timeDelta >= 0
    ? `took <b>${timeDelta.toFixed(1)}%</b> less time`
    : `took <b>${Math.abs(timeDelta).toFixed(1)}%</b> more time`;
  return `<li><b>${group.label} (${group.turns} turns)</b>: the optimized variant ${tokenText} tokens, ${timeText}, cache misses ${fmtTokens(opt.avgMissTokens)} vs ${fmtTokens(base.avgMissTokens)}, estimated cost per turn ${fmtCny(opt.costPerTurn)} vs ${fmtCny(base.costPerTurn)}, accuracy ${fmtPct(opt.accuracy)} vs ${fmtPct(base.accuracy)}.</li>`;
}).filter(Boolean).join('');

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AgentProject Core grouped performance comparison</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 16px 12px 30px; background: #f5f7fb; color: #111827;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    -webkit-font-smoothing: antialiased; }
  main { max-width: 430px; margin: 0 auto; }
  header { margin-bottom: 14px; }
  header h1 { margin: 0 0 8px; font-size: 26px; letter-spacing: -0.4px; line-height: 1.25; }
  header p { margin: 0 0 5px; font-size: 14px; line-height: 1.65; color: #4b5563; }
  .kpi { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin: 14px 0; }
  .kpi div { background: #fff; border: 1px solid #e5e7eb; border-radius: 14px; padding: 11px 13px; }
  .kpi span { display: block; font-size: 13px; color: #6b7280; }
  .kpi strong { display: block; margin-top: 4px; font-size: 21px; }
  .block { background: #fff; border: 1px solid #e5e7eb; border-radius: 16px; padding: 14px 12px; margin-bottom: 13px; }
  .block > h2 { margin: 0 0 10px; font-size: 19px; }
  .chart-card { margin-bottom: 14px; }
  .chart-card:last-child { margin-bottom: 0; }
  .chart-card h3 { margin: 0 2px 3px; font-size: 16px; display: flex; justify-content: space-between; align-items: baseline; }
  .chart-card h3 span { font-size: 12.5px; color: #9ca3af; font-weight: 400; }
  .chart-card svg { width: 100%; height: auto; display: block; }
  .group { border: 1px solid #eef2f7; border-radius: 12px; padding: 10px 12px; margin-bottom: 10px; background: #fbfcfe; }
  .group:last-child { margin-bottom: 0; }
  .group-top { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 5px; }
  .group-top b { font-size: 16px; }
  .group-top span { font-size: 13px; color: #6b7280; }
  .group-line { font-size: 14.5px; line-height: 1.6; color: #1f2937; }
  .group-line b { font-variant-numeric: tabular-nums; }
  .group-line em { font-style: normal; color: #2563eb; font-weight: 600; }
  .group-line i { font-style: normal; color: #dc2626; font-weight: 600; }
  .group-sub { margin-top: 4px; font-size: 13px; color: #6b7280; }
  ul.tips { margin: 0; padding-left: 20px; }
  ul.tips li { font-size: 14.5px; line-height: 1.7; color: #374151; margin-bottom: 7px; }
  ul.tips li:last-child { margin-bottom: 0; }
  .note { background: #fff7ed; border: 1px solid #fed7aa; border-radius: 16px; padding: 13px 14px; margin-bottom: 13px; }
  .note h3 { margin: 0 0 6px; font-size: 16px; color: #9a3412; }
  .note p { margin: 0 0 4px; font-size: 13.5px; line-height: 1.7; color: #7c2d12; }
  .note p:last-child { margin-bottom: 0; }
  footer { text-align: center; font-size: 12.5px; color: #9ca3af; margin-top: 14px; line-height: 1.7; }
</style>
</head>
<body>
<main>
  <header>
    <h1>Cache-stable Agent Core grouped performance comparison</h1>
    <p>Real model ${modelName || 'unknown'} · Agent mode · real tool calls; a fresh workspace per group, answers verified against artifacts, averaged over multiple rounds.</p>
    <p>Comparison basis: same model, same tasks, same prompts. The optimized variant enables PTC programmatic tool calling, the single-turn context engine, model-window-derived history budgets and tool-result distillation; the traditional variant uses native function calling, full history and a single-loop ReAct, with prefetch, cold facts, artifact index, turn policy, plan inlining and task memo disabled.</p>
    <p><b>Pricing basis:</b> DeepSeek official peak/off-peak price (CNY / 1M tokens). Off-peak hit ¥${DEEPSEEK_OFFICIAL_PRICING.offPeak.cacheHit} / miss ¥${DEEPSEEK_OFFICIAL_PRICING.offPeak.cacheMiss} / output ¥${DEEPSEEK_OFFICIAL_PRICING.offPeak.output}; peak hit ¥${DEEPSEEK_OFFICIAL_PRICING.peak.cacheHit} / miss ¥${DEEPSEEK_OFFICIAL_PRICING.peak.cacheMiss} / output ¥${DEEPSEEK_OFFICIAL_PRICING.peak.output}. The 500 raw runs here all fell in peak hours; the per-turn costCny in the data has been normalized to the off-peak price, with the original peak cost kept in the peakCostCny field; for actual billing, recompute by the real send time.</p>
  </header>
  <div class="kpi">
    <div><span>Test groups</span><strong>${summary.groups.length} groups</strong></div>
    <div><span>Completed turns (both variants)</span><strong>${totalTurns} turns</strong></div>
    <div><span>Optimized cache hits</span><strong>${fmtPct(optCacheAverage)}</strong></div>
    <div><span>Optimized accuracy</span><strong>${fmtPct(optAccuracyAverage)}</strong></div>
    <div><span>Optimized misses</span><strong>${optMissAverage == null ? '--' : fmtTokens(optMissAverage)}</strong></div>
    <div><span>Optimized cost per turn</span><strong>${fmtCny(optCostPerTurn)}</strong></div>
  </div>
  <section class="block" id="pricing">
    <h2>Why price only with DeepSeek</h2>
    <p style="margin:0;font-size:13.5px;line-height:1.75;color:#374151;">DeepSeek usage reliably returns <code>prompt_cache_hit_tokens</code> and <code>prompt_cache_miss_tokens</code>, so hits and misses can be billed separately at the hit and miss prices and mapped one-to-one to the official peak/off-peak price. Other providers either do not return cache fields or define them differently, so the same basis is impossible; therefore cost and cache metrics use DeepSeek only. Amounts are estimates based on official unit prices; refer to the provider for actual billing.</p>
  </section>
  <section class="block" id="charts">
    <h2>Six core curves</h2>
    ${lineChart({ title: 'Total token consumption', unit: 'lower is better', metric: 'tokens', formatter: fmtTokens })}
    ${lineChart({ title: 'Average tokens per turn', unit: 'lower is better', metric: 'tokensPerTurn', formatter: fmtTokens })}
    ${lineChart({ title: 'Cache miss tokens', unit: 'lower is better', metric: 'missTokens', formatter: fmtTokens })}
    ${lineChart({ title: 'Estimated cost per turn', unit: 'lower is better', metric: 'cost', formatter: fmtCny })}
    ${lineChart({ title: 'Total time', unit: 'lower is better', metric: 'duration', formatter: (value) => `${value.toFixed(0)}s` })}
    ${lineChart({ title: 'Answer accuracy', unit: 'artifact verification', metric: 'accuracy', formatter: (value) => `${value.toFixed(0)}%` })}
  </section>
  <section class="block" id="details">
    <h2>Group details</h2>
    ${groupCards}
    <p style="margin:10px 4px 0;font-size:12.5px;color:#9ca3af;line-height:1.6;">Each row shows: AgentProject optimized · traditional framework.</p>
  </section>
  <section class="block">
    <h2>Key takeaways</h2>
    <ul class="tips">${groupSummary || '<li>No complete comparison data yet.</li>'}</ul>
  </section>
  <section class="block">
    <h2>Suggested next optimizations</h2>
    <ul class="tips">
      <li><b>Cache prefix stability</b>: keep freezing the bytes of system and tool schemas, and avoid inserting dynamic context mid-task. This is currently the most certain gain.</li>
      <li><b>Batch read-back</b>: long conversations still make several read_tool_result round trips. Next, read slices of multiple result_ids in one pass to reduce model round trips, rather than compressing harder.</li>
      <li><b>Tool result budget</b>: adapt the budget to the context window, and constrain read-back count with P90 duration; do not look only at token reduction.</li>
      <li><b>Suitable scenarios</b>: multi-file read-only analysis on a long-lived shared context, cross-file refactoring, long reports and knowledge-base Q&A benefit most; one-off short Q&A, small single-file edits, latency-critical interaction and high-risk writes that cannot be approved benefit little.</li>
      <li><b>Accuracy regression</b>: wire the artifact verification script into CI, run 10, 20, 50, 70 and 100-turn regressions on every optimization change, and prefer reverting over continuing to tune when accuracy drops.</li>
    </ul>
  </section>
  <footer>Generated at: ${new Date().toLocaleString('en-US')}<br>Data directory benchmark/data<br>Pricing: DeepSeek official peak/off-peak price (CNY / 1M tokens), off-peak ${DEEPSEEK_OFFICIAL_PRICING.offPeak.cacheHit}/${DEEPSEEK_OFFICIAL_PRICING.offPeak.cacheMiss}/${DEEPSEEK_OFFICIAL_PRICING.offPeak.output}, peak ${DEEPSEEK_OFFICIAL_PRICING.peak.cacheHit}/${DEEPSEEK_OFFICIAL_PRICING.peak.cacheMiss}/${DEEPSEEK_OFFICIAL_PRICING.peak.output}</footer>
</main>
</body>
</html>`;

const htmlFile = path.join(outputDir, 'benchmark-report.html');
fs.writeFileSync(htmlFile, html);
fs.writeFileSync(path.join(outputDir, 'benchmark-summary.json'), JSON.stringify(summary, null, 2));
console.log(`[report] html=${htmlFile}`);
console.log(`[report] summary=${JSON.stringify(summary).slice(0, 500)}...`);
