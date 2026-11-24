// 把 run_command 与生成型工具映射为“读/写资源集合”，供并发调度与验证调度使用。
// 路径全部是工作区相对路径（正斜杠）；绝对路径或越界路径视为无法确定作用域，退回工作区全局锁。

import path from 'node:path';

const MAX_SCOPE_PATHS = 20;
const SHELL_OPERATORS = new Set([';', '|', '&', '&&', '||']);
const FLAGS_WITH_VALUE = new Set([
  '-k', '-m', '--maxfail', '-p', '--project', '--config', '--reporter',
  '--test-reporter', '--test-reporter-destination', '--test-name-pattern', '--timeout'
]);
const UNKNOWN_SCOPE = { known: false, source: 'fallback', reads: [], writes: [], key: '' };

function cleanRel(value) {
  return String(value ?? '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

function isAbsoluteLike(value) {
  return /^[a-zA-Z]:/.test(value) || value.startsWith('/') || value.startsWith('..') || value.includes('/../');
}

function joinRel(cwd, token) {
  const base = cleanRel(cwd || '.') || '.';
  const rel = cleanRel(token);
  if (!rel || rel === '.') return base;
  if (isAbsoluteLike(rel)) throw new Error(`作用域路径越界：${token}`);
  return base === '.' ? rel : cleanRel(`${base}/${rel}`);
}

function isGlob(token) {
  return /[*?[\]{}]/.test(token);
}

function globRoot(token) {
  const text = cleanRel(token);
  const index = text.search(/[*?[\]{}]/);
  if (index < 0) return text || '.';
  const head = text.slice(0, index).replace(/\/+$/, '');
  return head || '.';
}

// 朴素分词：保留引号内空格，把 shell 操作符切成独立 token（只分析第一条命令）。
export function tokenizeCommand(command) {
  const text = String(command || '');
  const tokens = [];
  let current = '';
  let quote = null;
  const flush = () => {
    if (current) tokens.push(current);
    current = '';
  };
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      flush();
      continue;
    }
    if (SHELL_OPERATORS.has(char)) {
      // 只分析第一条命令；后续管道/串行命令的读写由工作区全局锁兜底。
      flush();
      return tokens;
    }
    current += char;
  }
  flush();
  return tokens;
}

function firstSegment(tokens) {
  const index = tokens.findIndex((token) => SHELL_OPERATORS.has(token));
  return index < 0 ? tokens : tokens.slice(0, index);
}

function takePaths(tokens, start, probe) {
  const paths = [];
  for (let index = start; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    if (token.startsWith('-')) {
      if (FLAGS_WITH_VALUE.has(token)) index += 1;
      continue;
    }
    if (SHELL_OPERATORS.has(token)) break;
    paths.push(token);
    if (paths.length >= MAX_SCOPE_PATHS) break;
  }
  return paths;
}

function toResource(rel, probe) {
  const text = cleanRel(rel);
  if (!text || text === '.') return { kind: 'dir', path: '.' };
  if (isAbsoluteLike(text)) throw new Error(`作用域路径越界：${rel}`);
  if (isGlob(text)) return { kind: 'dir', path: globRoot(text) };
  return { kind: probe(text) === 'dir' ? 'dir' : 'file', path: text };
}

function firstExistingDir(candidates, probe) {
  for (const candidate of candidates) {
    if (probe(candidate) === 'dir') return candidate;
  }
  return '.';
}

function normalizeList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((item) => typeof item === 'string' && item.trim())
    .map((item) => cleanRel(item))
    .filter(Boolean))].slice(0, MAX_SCOPE_PATHS);
}

function explicitScope(scope, probe) {
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) return null;
  const paths = normalizeList(scope.paths);
  const dirs = normalizeList(scope.dirs);
  const outputs = normalizeList(scope.outputs);
  if (!paths.length && !dirs.length && !outputs.length) return null;
  const reads = [
    ...paths.map((rel) => ({ kind: 'file', path: toResource(rel, probe).path })),
    ...dirs.map((rel) => ({ kind: 'dir', path: toResource(rel, probe).path }))
  ];
  const writes = outputs.map((rel) => toResource(rel, probe));
  return { known: true, source: 'explicit', reads, writes };
}

function inferScope(input, probe) {
  const command = String(input?.command || '');
  const cwd = cleanRel(input?.cwd || '.') || '.';
  const tokens = firstSegment(tokenizeCommand(command));
  if (!tokens.length) return UNKNOWN_SCOPE;
  const head = tokens[0].toLowerCase();

  if (head === 'node' && tokens.includes('--test')) {
    const index = tokens.indexOf('--test');
    const paths = takePaths(tokens, index + 1, probe);
    const reads = paths.length
      ? paths.map((token) => toResource(joinRel(cwd, token), probe))
      : [{ kind: 'dir', path: firstExistingDir([joinRel(cwd, 'test'), joinRel(cwd, 'tests')], probe) }];
    return { known: true, source: 'inferred', reads, writes: [] };
  }

  const pytestAt = head === 'pytest' ? 0 : ((head === 'python' || head === 'python3' || head === 'py') && tokens[1] === '-m' && tokens[2] === 'pytest' ? 2 : -1);
  if (pytestAt >= 0) {
    const paths = takePaths(tokens, pytestAt + 1, probe);
    const reads = paths.length
      ? paths.map((token) => toResource(joinRel(cwd, token), probe))
      : [{ kind: 'dir', path: firstExistingDir([joinRel(cwd, 'tests'), joinRel(cwd, 'test')], probe) }];
    return { known: true, source: 'inferred', reads, writes: [] };
  }

  if (head === 'go' && tokens[1] === 'test') {
    const paths = takePaths(tokens, 2, probe);
    const reads = paths.length
      ? paths.map((token) => ({ ...toResource(joinRel(cwd, token.replace(/\/\.\.\.$/, '')), probe), kind: 'dir' }))
      : [{ kind: 'dir', path: cwd }];
    return { known: true, source: 'inferred', reads, writes: [] };
  }

  const tscAt = head === 'tsc' ? 0 : (head === 'npx' && tokens[1] === 'tsc' ? 1 : -1);
  if (tscAt >= 0) {
    const projectAt = tokens.findIndex((token) => token === '-p' || token === '--project');
    if (projectAt >= 0 && tokens[projectAt + 1]) {
      return { known: true, source: 'inferred', reads: [toResource(joinRel(cwd, tokens[projectAt + 1]), probe)], writes: [] };
    }
    const srcDir = joinRel(cwd, 'src');
    const dir = probe(srcDir) === 'dir' ? srcDir : cwd;
    return { known: true, source: 'inferred', reads: [{ kind: 'dir', path: dir }], writes: [] };
  }

  return UNKNOWN_SCOPE;
}

function scopeKey(cwd, command, reads, writes) {
  const readKeys = reads.map((item) => `${item.kind}:${item.path}`).sort().join(',');
  const writeKeys = writes.map((item) => `${item.kind}:${item.path}`).sort().join(',');
  return `${cwd}|${command}|${readKeys}|${writeKeys}`;
}

/**
 * 解析命令作用域。
 * @param {object} input run_command 参数（command/cwd/scope）
 * @param {{ probe?: (rel:string)=>'file'|'dir'|false }} options
 */
export function resolveCommandScope(input = {}, { probe = () => false } = {}) {
  const command = String(input?.command || '');
  const cwd = cleanRel(input?.cwd || '.') || '.';
  try {
    const explicit = explicitScope(input?.scope, probe);
    const scope = explicit || inferScope(input, probe);
    if (!scope.known) return UNKNOWN_SCOPE;
    return { ...scope, cwd, command, key: scopeKey(cwd, command, scope.reads, scope.writes) };
  } catch {
    return UNKNOWN_SCOPE;
  }
}

/**
 * 规划一次工具调用的资源锁。
 * helpers: { workspace, outputRel, resolveInput(rel), resolveOutput(rel), probe(rel) }
 * 返回 null 表示不加锁；verify 存在时表示这是可并发的验证命令。
 */
export function planToolLocks(name, input = {}, helpers = {}) {
  const {
    workspace,
    outputRel = 'outputs',
    resolveInput = (rel) => rel,
    resolveOutput = (rel) => rel,
    probe = () => false
  } = helpers;
  if (!workspace) return null;

  const asFile = (rel) => ({ kind: 'file', path: resolveInput(rel), scope: 'file' });
  const asDir = (rel) => ({ kind: 'dir', path: resolveInput(rel), scope: 'dir' });
  const keyOf = (item) => `${item.scope}:${item.path}`;

  const plan = (reads, writes, verify = null) => ({
    reads: reads.map(keyOf),
    writes: writes.map(keyOf),
    verify
  });

  const current = String(name || '');
  if (current === 'read_file' && input.path) return plan([asFile(input.path)], []);
  if ((current === 'list_files' || current === 'search_files')) {
    return plan([asDir(input.path || '.')], []);
  }
  if ((current === 'write_file' || current === 'edit_file' || current === 'delete_file') && input.path) {
    return plan([], [{ kind: 'file', path: resolveOutput(input.path), scope: 'file' }]);
  }
  if (current === 'ppt_analyze' && input.path) return plan([asFile(input.path)], []);
  if (current === 'ppt_optimize' && input.path) {
    return plan([asFile(input.path)], [{ kind: 'dir', path: resolveInput(outputRel), scope: 'dir' }]);
  }
  if ((current === 'extract_text' || current === 'pdf_to_xlsx') && input.path) {
    const base = path.basename(String(input.path), path.extname(String(input.path)));
    const fallback = current === 'extract_text' ? `${outputRel}/${base}.md` : `${outputRel}/${base}.xlsx`;
    return plan([asFile(input.path)], [{ kind: 'file', path: resolveOutput(input.output || fallback), scope: 'file' }]);
  }
  if (current !== 'run_command') return null;

  const scope = resolveCommandScope(input, { probe });
  if (!scope.known) {
    return plan([], [{ kind: 'dir', path: workspace, scope: 'ws' }]);
  }
  const readItems = scope.reads.map((item) => (item.kind === 'dir' ? asDir(item.path) : asFile(item.path)));
  const writeItems = scope.writes.map((item) => (item.kind === 'dir' ? asDir(item.path) : asFile(item.path)));
  const inputFiles = readItems.filter((item) => item.kind === 'file').map((item) => item.path);
  const outputFiles = writeItems.filter((item) => item.kind === 'file').map((item) => item.path);
  return plan(readItems, writeItems, {
    key: `verify:${scope.key}`,
    inputFiles,
    outputFiles,
    // 只有显式 scope 才能保证输入集合完整；推断的输入可能漏掉被 import 的源码，缓存会误报。
    cacheable: scope.source === 'explicit'
  });
}
