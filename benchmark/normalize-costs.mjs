// 把 benchmark/data 顶层的运行成本统一归一化为 DeepSeek 官方空闲价。
// 原始高峰成本保留在 peakCostCny 字段，脚本可重复执行；legacy 目录不在处理范围内。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEEPSEEK_OFFICIAL_PRICING } from '../server/benchmark-metrics.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.join(ROOT, 'benchmark', 'data');
const pricing = DEEPSEEK_OFFICIAL_PRICING.offPeak;
const normalizedAt = new Date().toISOString();

const round6 = (value) => Math.round(value * 1e6) / 1e6;
const costOf = (tokens) => round6(
  (Number(tokens.cacheHitTokens) || 0) * pricing.cacheHit / 1e6
  + (Number(tokens.cacheMissTokens) || 0) * pricing.cacheMiss / 1e6
  + (Number(tokens.completionTokens) || 0) * pricing.output / 1e6
);

function normalizeBlock(block, turns) {
  if (!block) return;
  if (block.peakCostCny == null && block.costCny != null) block.peakCostCny = block.costCny;
  block.costCny = costOf(block);
  block.avgCostCny = round6(block.costCny / Math.max(1, turns));
}

const files = fs.readdirSync(dataDir)
  .filter((name) => name.endsWith('.json') && !name.startsWith('smoke'))
  .sort();

let totalTurns = 0;
let normalizedPeakTurns = 0;
let normalizedCost = 0;
let peakCost = 0;

for (const file of files) {
  const filePath = path.join(dataDir, file);
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  let peakTurns = 0;
  let offTurns = 0;

  for (const result of data.results || []) {
    for (const turn of result.turns || []) {
      totalTurns += 1;
      if (turn.pricing === '高峰价') {
        if (turn.peakCostCny == null) turn.peakCostCny = turn.costCny;
        turn.pricing = '空闲价';
        peakTurns += 1;
        normalizedPeakTurns += 1;
      } else if (turn.pricing === '空闲价') {
        offTurns += 1;
      }
      turn.costCny = costOf(turn);
    }
    normalizeBlock(result.totals, result.totals?.completedTurns || result.turns?.length || 1);
    normalizeBlock(result.summary, result.summary?.turns || result.turns?.length || 1);
  }

  data.costBasis = 'offPeak';
  data.costNormalizedAt = data.costNormalizedAt || normalizedAt;
  data.costNote = '原始运行均为高峰价；costCny 已按 DeepSeek 官方空闲价统一归一化，原始高峰成本保留在 peakCostCny。';
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);

  for (const result of data.results || []) {
    normalizedCost += result.totals?.costCny || 0;
    peakCost += result.totals?.peakCostCny || 0;
  }
  console.log(`${file}: 高峰轮次=${peakTurns} 空闲轮次=${offTurns} 归一化费用=¥${(resultCost(data) || 0).toFixed(6)}`);
}

function resultCost(data) {
  return (data.results || []).reduce((sum, result) => sum + (result.totals?.costCny || 0), 0);
}

console.log('');
console.log(`处理文件：${files.length} 个`);
console.log(`处理轮次：${totalTurns} 轮（本次从高峰价归一化 ${normalizedPeakTurns} 轮）`);
console.log(`归一化后总费用：¥${round6(normalizedCost)}`);
console.log(`原始高峰总费用：¥${round6(peakCost)}`);
