import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deliverableExtensions,
  extractDeliverablePath,
  requiredDeliverableKinds,
  requiresWorkspaceDeliverable
} from '../server/deliverable.js';

test('识别目标交付物类型，不把输入文件当成交付物', () => {
  assert.deepEqual(requiredDeliverableKinds('将这个扫描件转换为excel文件'), ['xlsx']);
  assert.deepEqual(requiredDeliverableKinds('把 a.xlsx 转成 csv'), ['csv']);
  assert.deepEqual(requiredDeliverableKinds('读取 a.xlsx 并生成 b.xlsx'), ['xlsx']);
  assert.deepEqual(requiredDeliverableKinds('生成一份 PPT 演示文稿'), ['pptx']);
  assert.deepEqual(requiredDeliverableKinds('写一份 word 文档'), ['docx']);
  assert.deepEqual(requiredDeliverableKinds('导出成 .xlsx 表格和 csv 明细'), ['xlsx', 'csv']);
  assert.deepEqual(requiredDeliverableKinds('解释一下 excel 公式的用法'), []);
  assert.deepEqual(requiredDeliverableKinds('生成一份分析报告'), []);
  assert.deepEqual(requiredDeliverableKinds(''), []);
});

test('交付物扩展名包含 html 的两种写法', () => {
  assert.deepEqual(deliverableExtensions(['xlsx', 'html']), ['.xlsx', '.html', '.htm']);
  assert.deepEqual(deliverableExtensions(), []);
});

test('明确要求写入 outputs 路径时触发', () => {
  assert.equal(requiresWorkspaceDeliverable('把结果写入 outputs/corpus-report.md'), true);
  assert.equal(requiresWorkspaceDeliverable('请输出到 outputs/ 目录'), true);
});

test('要求生成文件或报告时触发', () => {
  assert.equal(requiresWorkspaceDeliverable('生成一份分析报告'), true);
  assert.equal(requiresWorkspaceDeliverable('把明细保存到 result.csv'), true);
  assert.equal(requiresWorkspaceDeliverable('导出成 .xlsx 表格'), true);
});

test('普通问答或只读任务不触发', () => {
  assert.equal(requiresWorkspaceDeliverable('解释一下这个函数的作用'), false);
  assert.equal(requiresWorkspaceDeliverable('统计每个文件的行数并告诉我'), false);
  assert.equal(requiresWorkspaceDeliverable(''), false);
  assert.equal(requiresWorkspaceDeliverable(null), false);
});

test('提取用户指定输出路径', () => {
  assert.equal(extractDeliverablePath('把结果写入 outputs/corpus2-report.md'), 'outputs/corpus2-report.md');
  assert.equal(extractDeliverablePath('保存到 result.csv，然后告诉我'), 'result.csv');
  assert.equal(extractDeliverablePath('生成一份分析报告'), '');
  assert.equal(extractDeliverablePath(''), '');
  assert.equal(
    extractDeliverablePath('读取 corpus-001.txt 到 corpus-096.txt，把明细写入 outputs/corpus2-report.md'),
    'outputs/corpus2-report.md'
  );
});
