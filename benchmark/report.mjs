// 汇总 benchmark/data 下的分组测试结果，生成移动端单页报告（曲线 + 明细合并在一张图里）。
// 用法：node benchmark/report.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEEPSEEK_OFFICIAL_PRICING, deepSeekOfficialPricing } from '../server/benchmark-metrics.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const inputDir = path.join(ROOT, 'benchmark', 'data');
const outputDir = path.join(ROOT, 'benchmark', 'output');
fs.mkdirSync(outputDir, { recursive: true });

const GROUPS = [
  { id: 'tiny', label: '极短对话', turns: 10 },
  { id: 'short', label: '短对话', turns: 20 },
  { id: 'medium', label: '中对话', turns: 50 },
  { id: 'long', label: '长对话', turns: 70 },
  { id: 'xlong', label: '超长对话', turns: 100 }
];
const VARIANTS = {
  opt: { label: 'AgentProject 优化版（PTC + 上下文引擎）', short: '优化版', color: '#2563eb' },
  base: { label: '传统框架（原生工具调用 + 全量历史）', short: '传统版', color: '#ef4444' }
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
    // 官方峰谷价按每次运行开始时间锁定，同一运行内不混算两个档位。
    const at = Date.parse(run.startedAt || data.startedAt || '') || Date.now();
    const pricing = deepSeekOfficialPricing(at);
    pricingTiers.add(pricing.label);
    const totals = run.totals;
    const cost = (Number(totals.cacheHitTokens) || 0) * pricing.cacheHitPrice
      + (Number(totals.cacheMissTokens) || 0) * pricing.cacheMissPrice
      + (Number(totals.completionTokens) || 0) * pricing.outputPrice;
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
  if (seconds >= 60) return `${(seconds / 60).toFixed(1)}分`;
  return `${seconds.toFixed(1)}s`;
};
const fmtPct = (value) => (value == null ? '--' : `${(value * 100).toFixed(1)}%`);
const fmtPctRound = (value) => (value == null ? '--' : `${Math.round(value * 100)}%`);
const fmtCny = (value) => {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return '--';
  if (amount >= 1) return `¥${amount.toFixed(2)}`;
  if (amount >= 0.01) return `¥${amount.toFixed(4)}`;
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
      else if (metric === 'cost') value = data.avgCostCny;
      points.push({ x: group.turns, y: value });
    }
    return { variant, label: VARIANTS[variant].short, color: VARIANTS[variant].color, points };
  });
}

function lineChart({ title, unit, metric, formatter }) {
  // viewBox 收窄到 300，同样宽度下字号折算更大（约 1.26 倍），手机上更清晰。
  const width = 300;
  const height = 190;
  const padding = { top: 30, right: 10, bottom: 32, left: 40 };
  const innerW = width - padding.left - padding.right;
  const innerH = height - padding.top - padding.bottom;
  const series = seriesFor(metric).filter((item) => item.points.length);
  const allValues = series.flatMap((item) => item.points.map((point) => point.y));
  const maxValue = Math.max(1, ...allValues);
  const niceMax = metric === 'accuracy' ? 100 : maxValue * 1.15;
  const xTicks = GROUPS.map((group) => group.turns);
  // 等距排布（分类轴），避免 8/20 轮在比例轴上挤在一起导致标签重叠。
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
  const xLabels = xTicks.map((value, index) => `<text x="${xFor(value) + (index === xTicks.length - 1 ? -2 : 0)}" y="${height - 10}" text-anchor="${index === xTicks.length - 1 ? 'end' : index === 0 ? 'start' : 'middle'}" font-size="10.5" fill="#4b5563">${value}轮</text>`).join('');
  const paths = series.map((item) => {
    const points = item.points.map((point) => [xFor(point.x), yFor(point.y)]);
    const pathD = points.map((point, index) => `${index ? 'L' : 'M'}${point[0].toFixed(1)},${point[1].toFixed(1)}`).join(' ');
    const dots = points.map((point) => `<circle cx="${point[0].toFixed(1)}" cy="${point[1].toFixed(1)}" r="2.8" fill="${item.color}"/>`).join('');
    // 准确率图两条线几乎重合，优化版用虚线，保证两条都能看见。
    const dash = metric === 'accuracy' && item.variant === 'opt' ? ' stroke-dasharray="5 3"' : '';
    return `<path d="${pathD}" fill="none" stroke="${item.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"${dash}/>${dots}`;
  }).join('');
  // 数值标签：同一横坐标上两条线的值靠近时，上面一条标在点上方、下面一条标在点下方，避免互相压字。
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
      // 优化版固定标在点下方、传统版标在点上方；越界时翻到另一侧再夹紧。
      let y = item.variant === 'opt' ? item.y + 13 : item.y - 9;
      if (y > bottomLimit || y < topLimit) y = item.variant === 'opt' ? item.y - 9 : item.y + 13;
      return { ...item, ly: clamp(y) };
    });
    // 两条标签过近时，把上面那条再抬高，避免白描边互相盖住。
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
      : `<i>多${(Math.abs(value)).toFixed(1)}%</i>`;
  };
  return `<div class="group">
    <div class="group-top"><b>${group.label}</b><span>${group.turns} 轮 · 准确率 ${fmtPctRound(opt?.accuracy)}/${fmtPctRound(base?.accuracy)}</span></div>
    <div class="group-line">tokens <b>${opt ? fmtTokens(opt.avgTokens) : '--'}</b> · <b>${base ? fmtTokens(base.avgTokens) : '--'}</b> ${tag(tokenDelta, '少')}</div>
    <div class="group-line">耗时 <b>${opt ? fmtTime(opt.avgDurationMs) : '--'}</b> · <b>${base ? fmtTime(base.avgDurationMs) : '--'}</b> ${tag(timeDelta, '快')}</div>
    <div class="group-sub">缓存 ${fmtPct(opt?.cacheHitRate)} · 未命中 ${opt ? fmtTokens(opt.avgMissTokens) : '--'} / ${base ? fmtTokens(base.avgMissTokens) : '--'}</div>
    <div class="group-sub">费用 ${opt ? fmtCny(opt.avgCostCny) : '--'} / ${base ? fmtCny(base.avgCostCny) : '--'} · 工具 ${opt?.avgToolCalls ?? '--'}/${base?.avgToolCalls ?? '--'} 次 · 运行 ${opt?.runs ?? 0} 次</div>
  </div>`;
}).filter(Boolean).join('');

const optGroups = summary.groups.filter((group) => group.variants.opt);
const optCacheRates = optGroups.map((group) => group.variants.opt.cacheHitRate).filter((value) => value != null);
const optCacheAverage = optCacheRates.length ? optCacheRates.reduce((total, value) => total + value, 0) / optCacheRates.length : null;
const optAccuracyAverage = optGroups.length ? average(optGroups.map((group) => group.variants.opt.accuracy)) : null;
const optMissAverage = optGroups.length ? average(optGroups.map((group) => group.variants.opt.avgMissTokens)) : null;
const optCostAverage = optGroups.length ? average(optGroups.map((group) => group.variants.opt.avgCostCny)) : null;
const totalTurns = summary.groups.reduce((total, group) => total + Object.values(group.variants).reduce((sum, item) => sum + item.totalTurns, 0), 0);

const groupSummary = summary.groups.map((group) => {
  const opt = group.variants.opt;
  const base = group.variants.base;
  if (!opt || !base) return '';
  const tokenDelta = delta(opt.avgTokens, base.avgTokens) || 0;
  const timeDelta = delta(opt.avgDurationMs, base.avgDurationMs) || 0;
  const tokenText = tokenDelta >= 0
    ? `少消耗 <b>${tokenDelta.toFixed(1)}%</b>`
    : `多消耗 <b>${Math.abs(tokenDelta).toFixed(1)}%</b>`;
  const timeText = timeDelta >= 0
    ? `耗时少 <b>${timeDelta.toFixed(1)}%</b>`
    : `耗时多 <b>${Math.abs(timeDelta).toFixed(1)}%</b>`;
  return `<li><b>${group.label}（${group.turns} 轮）</b>：优化版${tokenText} tokens，${timeText}，缓存未命中 ${fmtTokens(opt.avgMissTokens)} 对 ${fmtTokens(base.avgMissTokens)}，估算费用 ${fmtCny(opt.avgCostCny)} 对 ${fmtCny(base.avgCostCny)}，准确率 ${fmtPct(opt.accuracy)} 对 ${fmtPct(base.accuracy)}。</li>`;
}).filter(Boolean).join('');

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AgentProject 内核分组性能对比</title>
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
    <h1>AgentProject 内核分组性能对比</h1>
    <p>真实模型 ${modelName || '未知'} · Agent 模式 · 真实工具调用；每组全新工作区，答案按产物校验，多轮取平均。</p>
    <p>对照口径：同模型、同任务、同提示词。优化版启用 PTC 程序化工具调用、单轮上下文引擎、滞后裁剪与工具结果蒸馏；传统版使用原生 function calling、全量历史与单循环 ReAct，关闭预取、冷事实、产出索引、轮次策略、计划内联与任务备忘。</p>
    <p><b>计价基准：</b>DeepSeek 官方峰谷价（CNY / 100 万 tokens）。空闲 命中 ¥${DEEPSEEK_OFFICIAL_PRICING.offPeak.cacheHit} / 未命中 ¥${DEEPSEEK_OFFICIAL_PRICING.offPeak.cacheMiss} / 输出 ¥${DEEPSEEK_OFFICIAL_PRICING.offPeak.output}；高峰 命中 ¥${DEEPSEEK_OFFICIAL_PRICING.peak.cacheHit} / 未命中 ¥${DEEPSEEK_OFFICIAL_PRICING.peak.cacheMiss} / 输出 ¥${DEEPSEEK_OFFICIAL_PRICING.peak.output}。按每次运行开始时间锁定档位，本次数据使用${[...pricingTiers].join('、') || '空闲价'}。</p>
  </header>
  <div class="kpi">
    <div><span>测试分组</span><strong>${summary.groups.length} 组</strong></div>
    <div><span>完成轮次（两变体合计）</span><strong>${totalTurns} 轮</strong></div>
    <div><span>优化版缓存命中</span><strong>${fmtPct(optCacheAverage)}</strong></div>
    <div><span>优化版准确率</span><strong>${fmtPct(optAccuracyAverage)}</strong></div>
    <div><span>优化版未命中</span><strong>${optMissAverage == null ? '--' : fmtTokens(optMissAverage)}</strong></div>
    <div><span>优化版估算费用</span><strong>${fmtCny(optCostAverage)}</strong></div>
  </div>
  <section class="block" id="pricing">
    <h2>为什么只以 DeepSeek 计价</h2>
    <p style="margin:0;font-size:13.5px;line-height:1.75;color:#374151;">DeepSeek 的 usage 稳定返回 <code>prompt_cache_hit_tokens</code> 与 <code>prompt_cache_miss_tokens</code>，可以分别按命中价与未命中价计费，并能与官方峰谷价一一对应。其他供应商要么不返回缓存字段，要么字段含义不同，无法做到同口径，因此费用与缓存指标只用 DeepSeek。金额为按官方单价的估算值，实际账单以供应商为准。</p>
  </section>
  <section class="block" id="charts">
    <h2>六项核心曲线</h2>
    ${lineChart({ title: '总 token 消耗', unit: '越低越好', metric: 'tokens', formatter: fmtTokens })}
    ${lineChart({ title: '每轮平均 tokens', unit: '越低越好', metric: 'tokensPerTurn', formatter: fmtTokens })}
    ${lineChart({ title: '缓存未命中 tokens', unit: '越低越好', metric: 'missTokens', formatter: fmtTokens })}
    ${lineChart({ title: '估算费用', unit: '越低越好', metric: 'cost', formatter: fmtCny })}
    ${lineChart({ title: '总耗时', unit: '越低越好', metric: 'duration', formatter: (value) => `${value.toFixed(0)}s` })}
    ${lineChart({ title: '答案准确率', unit: '产物校验', metric: 'accuracy', formatter: (value) => `${value.toFixed(0)}%` })}
  </section>
  <section class="block" id="details">
    <h2>分组明细</h2>
    ${groupCards}
    <p style="margin:10px 4px 0;font-size:12.5px;color:#9ca3af;line-height:1.6;">每行依次为：AgentProject 优化版 · 传统框架。</p>
  </section>
  <section class="block">
    <h2>关键结论</h2>
    <ul class="tips">${groupSummary || '<li>暂无完整对比数据。</li>'}</ul>
  </section>
  <section class="block">
    <h2>下一步优化建议</h2>
    <ul class="tips">
      <li><b>缓存前缀稳定性</b>：继续冻结 system 与工具 schema 字节，避免任务中途插入动态上下文。这是当前收益最确定的一项。</li>
      <li><b>批量回读</b>：长对话里仍有多次 read_tool_result 往返。下一步做一次读取多个 result_id 的片段，减少模型往返次数，而不是继续加大压缩。</li>
      <li><b>工具结果预算</b>：按上下文窗口自适应调整预算，并用 P90 耗时约束回读次数，不能只看 token 下降。</li>
      <li><b>适合场景</b>：长期保持同一套上下文的多文件只读分析、跨文件重构、长报告与知识库问答收益最大；一次性短问答、单文件小改、强实时交互和无法审批的高风险写操作收益有限。</li>
      <li><b>准确性回归</b>：把产物校验脚本接入 CI，任何优化改动都跑 10、20、50、70、100 轮回归，准确率下降时优先回退而不是继续调参。</li>
    </ul>
  </section>
  <footer>生成时间：${new Date().toLocaleString('zh-CN')}<br>数据目录 benchmark/data<br>计价：DeepSeek 官方峰谷价（CNY / 100 万 tokens），空闲 ${DEEPSEEK_OFFICIAL_PRICING.offPeak.cacheHit}/${DEEPSEEK_OFFICIAL_PRICING.offPeak.cacheMiss}/${DEEPSEEK_OFFICIAL_PRICING.offPeak.output}，高峰 ${DEEPSEEK_OFFICIAL_PRICING.peak.cacheHit}/${DEEPSEEK_OFFICIAL_PRICING.peak.cacheMiss}/${DEEPSEEK_OFFICIAL_PRICING.peak.output}</footer>
</main>
</body>
</html>`;

const htmlFile = path.join(outputDir, 'benchmark-report.html');
fs.writeFileSync(htmlFile, html);
fs.writeFileSync(path.join(outputDir, 'benchmark-summary.json'), JSON.stringify(summary, null, 2));
console.log(`[report] html=${htmlFile}`);
console.log(`[report] summary=${JSON.stringify(summary).slice(0, 500)}...`);
