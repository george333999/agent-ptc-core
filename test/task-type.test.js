import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CATEGORY_VERSION,
  attachmentKindFromFiles,
  createTaskTypeTracker,
  pendingTaskType,
  toolCategory
} from '../server/task-type.js';

test('工具类别映射：内置、MCP 与未知工具的稳定归类', () => {
  assert.equal(toolCategory('read_file'), 'read');
  assert.equal(toolCategory('read_tool_result'), 'read');
  assert.equal(toolCategory('write_file'), 'edit');
  assert.equal(toolCategory('write_xlsx'), 'edit');
  assert.equal(toolCategory('run_command'), 'command');
  assert.equal(toolCategory('web_search'), 'web');
  assert.equal(toolCategory('mcp__github__search'), 'mcp');
  assert.equal(toolCategory('unknown_tool'), 'other');
  assert.equal(toolCategory(''), '');
});

test('taskType 在第 3 个不同类别首次出现时冻结，之前为 pending', () => {
  const tracker = createTaskTypeTracker({ mode: 'agent', entryTag: 'web', attachmentKind: 'none' });
  assert.equal(tracker.current(), pendingTaskType());
  tracker.recordTool('read_file');
  tracker.recordTool('read_file');
  assert.equal(tracker.current(), 'pending');
  tracker.recordTool('write_file');
  assert.equal(tracker.current(), 'pending');
  const frozen = tracker.recordTool('run_command');
  assert.ok(frozen);
  assert.equal(tracker.current(), frozen);
  // 冻结后不再变化
  tracker.recordTool('fetch_url');
  assert.equal(tracker.current(), frozen);
  assert.equal(tracker.frozen(), frozen);
});

test('taskType 与工具记录顺序无关，但受 mode/附件/入口影响', () => {
  const first = createTaskTypeTracker({ mode: 'agent', entryTag: 'web', attachmentKind: 'pdf' });
  first.recordTool('read_file');
  first.recordTool('write_file');
  first.recordTool('ptc_run');
  first.recordTool('run_command');
  const second = createTaskTypeTracker({ mode: 'agent', entryTag: 'web', attachmentKind: 'pdf' });
  second.recordTool('ptc_run');
  second.recordTool('write_file');
  second.recordTool('run_command');
  second.recordTool('read_file');
  assert.equal(first.current(), second.current());

  const otherMode = createTaskTypeTracker({ mode: 'chat', entryTag: 'web', attachmentKind: 'pdf' });
  for (const name of ['read_file', 'write_file', 'ptc_run', 'run_command']) otherMode.recordTool(name);
  assert.notEqual(first.current(), otherMode.current());

  const otherAttachment = createTaskTypeTracker({ mode: 'agent', entryTag: 'web', attachmentKind: 'sheet' });
  for (const name of ['read_file', 'write_file', 'ptc_run', 'run_command']) otherAttachment.recordTool(name);
  assert.notEqual(first.current(), otherAttachment.current());
});

test('附件类型按固定优先级取值，与文件顺序无关', () => {
  assert.equal(attachmentKindFromFiles([]), 'none');
  assert.equal(attachmentKindFromFiles(['a.png', 'b.pdf']), 'pdf');
  assert.equal(attachmentKindFromFiles(['b.pdf', 'a.png']), 'pdf');
  assert.equal(attachmentKindFromFiles(['x.xlsx', 'y.docx']), 'document');
  assert.equal(attachmentKindFromFiles(['x.pptx', 'y.csv']), 'sheet');
  assert.equal(attachmentKindFromFiles(['only.bin']), 'none');
});

test('snapshot 暴露 categoryVersion 与冻结状态，便于基线归因', () => {
  const tracker = createTaskTypeTracker({ mode: 'agent', entryTag: 'remote', attachmentKind: 'image' });
  tracker.recordTool('read_file');
  const snapshot = tracker.snapshot();
  assert.equal(snapshot.categoryVersion, CATEGORY_VERSION);
  assert.equal(snapshot.frozen, false);
  assert.equal(snapshot.taskType, 'pending');
  assert.equal(snapshot.entryTag, 'remote');
  assert.equal(snapshot.attachmentKind, 'image');
});
