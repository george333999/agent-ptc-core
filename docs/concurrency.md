# 并发写锁与验证调度

这份文档说明 `resource-locks.js`、`command-scope.js` 与 `verify-scheduler.js` 的职责、语义和接入方式。

## 要解决的问题

Agent 在一次任务里会并发触发多个工具：

- 两个 `write_file` 同时改同一个文件，后完成的那次会覆盖先完成的内容。
- 一个 `read_file` 与一个 `write_file` 同时发生，可能读到写了一半的文件。
- 三处修改都触发同一个 `node --test`，同一份验证被重复执行三次。
- 验证刚跑完，另一个工具又改了被测试的源码，结论立刻过期。

锁负责互斥，版本登记负责发现变化，验证调度负责合并与重跑。三者组合起来，才能让“改完再验”在并发下仍然可信。

## 一、资源锁

`createResourceLocks()` 返回一个进程内锁管理器，核心方法是 `acquire({ reads, writes }, { signal, timeoutMs, owner })`。

锁键有三种粒度：

- `file:/abs/path`：单个文件。
- `dir:/abs/path`：目录及其全部子孙。
- `ws:/abs/path`：整个工作区。

语义：

- 读读兼容，读写冲突，写写互斥。
- 祖先与后代视为相关：锁目录会挡住目录内的文件锁。
- 写者优先：读者不会越过队列中更早的冲突写者。
- 但无关资源可以跳过被挡住的请求，避免一个慢写操作阻塞整个队列。
- 不可重入：同一个 `owner` 已在持有冲突锁时再次申请，会返回 `LOCK_REENTRANT`，避免自锁。
- 同一个请求里对同一路径同时申请读和写，会自动升级为写锁，而不是报错：批量原地修改目录时经常出现这种自重叠请求。
- 超时返回 `LOCK_TIMEOUT`，取消返回 `LOCK_ABORTED`，错误对象带 `holders` 便于定位占用者。

Windows 下路径大小写不敏感，锁键会统一转小写，避免同一文件被当成两个资源。

`acquire` 成功返回 `{ keys, waitMs, release }`，必须在 `finally` 里调用 `release()`。

## 二、版本登记

`VersionStore` 记录每个文件的版本、大小、修改时间与短哈希：

- `bump(path)` 或 `bumpKeys(keys)`：工具写入成功后调用，版本加一。
- `snapshot(paths)`：验证开始前记录输入指纹。
- `changed(snapshot)`：验证结束后返回发生变化的路径。
- `versionMap(paths)`：输出验证基于哪一版输入。

指纹由版本、大小、修改时间与短哈希组成。短哈希只在文件不超过 2 MB 时计算；外部工具改写内容但保留 mtime 与大小的情况也能被检出。超过上限的大文件只比较元数据，避免每次验证都同步读取整份文件。

## 三、命令作用域

`planToolLocks(name, input, helpers)` 为一次工具调用生成锁计划：

```js
{
  reads: ['file:/abs/src/calc.js'],
  writes: [],
  verify: null | { key, inputFiles, outputFiles, cacheable }
}
```

- `read_file`、`list_files`、`search_files`、`ppt_analyze` 等只读工具生成读锁，`ptc_run` 不生成锁。
- `write_file`、`edit_file`、`delete_file`、文档转换类工具生成写锁。
- `run_command` 通过 `resolveCommandScope` 解析作用域。

作用域有两种来源：

- 显式：`scope.paths`、`scope.dirs`、`scope.outputs` 由调用方给出，视为输入集合完整，`cacheable` 为 true。
- 推断：识别 `node --test`、`pytest`、`python -m pytest`、`go test ./pkg/...`、`tsc -p` 等命令，推断读写目录或文件，`cacheable` 为 false。

无法判断作用域时回退到工作区全局写锁，保证正确性优先。

推断作用域不可缓存的原因很具体：`node --test tests/calc.test.js` 实际会 import `src/calc.js` 以及更深的依赖，仅从命令参数无法枚举完整输入。一旦把推断结果缓存下来，改了源码也可能命中旧结论，把失败误报成通过。

## 四、验证调度

`createVerifyScheduler({ versions })` 接收上文的版本登记器，核心方法是 `run()`。

- 合并：相同 `key` 的并发请求复用同一个 Promise，不重复执行命令。
- 排队：同一工作区默认 1 个验证并发；作用域不相交时可以并行到 `hardMax`，默认 2。
- 防抖：请求到达后等待 `debounceMs`，默认 80 毫秒，最多压到 2000 毫秒，给同一批写操作留出合并窗口。
- stale 重跑：执行前快照输入；执行后发现输入变化，标记 `stale` 并重跑，最多 `maxReruns` 次，默认 2。
- 缓存：只有 `cacheable` 为 true 且本次结果不 stale 时才写入缓存；缓存最多 200 条，按插入顺序淘汰。
- 返回值：`{ result, stale, runs, cached, verifiedVersions, waitMs }`，其中 `waitMs` 是等待验证槽位的时间，可直接归因到单轮延迟。

`status` 不在这里维护，调用方根据 `result` 判断通过或失败；调度器只保证“结论对应当前输入版本”。

## 五、同轮工具并发调度

同一轮模型返回多个工具调用时，`createToolScheduler` 按“路径依赖 + 屏障”决定哪些可以同时执行：

- `write_file`、`edit_file`、`delete_file`、`write_xlsx` 按规范化路径生成写依赖，不同路径可并发。
- `read_file` 与同路径或祖先路径的写保持先后；`list_files` / `search_files` 按目录祖先关系排序。
- `run_command` 带确定 scope 时是 verify 节点；未知命令、需要审批的调用、未知工具都是屏障，前后串行。
- `_v43.py` 这类同脚本多版本写入强制走屏障，避免预执行绕过版本爆炸守卫。
- 并发上限默认 4，`AGENT_TOOL_CONCURRENCY=0` 可退回“仅连续只读并发”的旧行为。

调度器只决定执行顺序，不改变工具语义；真正的互斥仍由资源锁保证。Chat 与 Agent 共用同一套路径解析：Chat 的 `outputs/report.md` 会映射到 `outputs/chat/report.md`，因此同一次调用里读写同一个交付文件会落到同一个锁键。

轻量场景可以只用 `KeyedMutex`：同一 key 串行、不同 key 并行，适合给单个文件或单个任务加互斥，不需要完整的读写锁。

## 六、接入示例

```js
import path from 'node:path';
import {
  createResourceLocks,
  planToolLocks,
  createVerifyScheduler
} from 'cache-stable-agent-core';

const locks = createResourceLocks();
const verify = createVerifyScheduler({ versions: locks.versions });
const helpers = {
  workspace,
  resolveInput: (rel) => path.join(workspace, rel),
  resolveOutput: (rel) => path.join(workspace, rel)
};

const writePlan = planToolLocks('write_file', { path: 'src/calc.js' }, helpers);
const lease = await locks.acquire(
  { reads: writePlan.reads, writes: writePlan.writes },
  { timeoutMs: 30000, signal }
);
try {
  await writeFile(path.join(workspace, 'src/calc.js'), next);
  locks.versions.bumpKeys(writePlan.writes);
} finally {
  lease.release();
}

const verifyPlan = planToolLocks('run_command', {
  command: 'node --test tests/calc.test.js'
}, helpers);
const outcome = await verify.run({
  key: verifyPlan.verify.key,
  workspace,
  inputFiles: verifyPlan.verify.inputFiles,
  outputFiles: verifyPlan.verify.outputFiles,
  cacheable: verifyPlan.verify.cacheable,
  execute: () => runCommand('node --test tests/calc.test.js')
});
```

如果任务自己知道完整输入，可以在 `run_command` 参数里显式传 `scope`：

```js
{
  command: 'node --test tests/calc.test.js',
  scope: {
    paths: ['tests/calc.test.js', 'src/calc.js'],
    outputs: ['reports/calc.json']
  }
}
```

此时 `cacheable` 为 true，重复验证在输入未变时可以直接命中缓存。

## 七、观测指标

`locks.stats` 记录 `acquired`、`waits`、`waitMs`、`maxWaitMs`、`timeouts`、`aborts`、`queued`、`active`。

`verify.snapshot()` 记录 `runs`、`stale`、`cached`、`merged`、`waitMs`、`maxWaitMs`、`queued`、`active`。

建议在工具返回值里带上 `lockWaitMs`、`verifyRuns`、`verifyCached`、`stale`，长尾和重复执行可以按单次工具调用归因。

## 八、测试

```bash
node --test test/resource-locks.test.js test/command-scope.test.js test/verify-scheduler.test.js test/tool-scheduler.test.js test/locks.test.js
```

覆盖范围：

- 读并发、写互斥、祖先目录冲突、写者优先、队头跳过。
- 超时、取消、不可重入、自重叠读写自动升级为写锁。
- 版本 bump、快照、changed、同大小同 mtime 的内容变化由哈希检出。
- 显式与推断作用域、未知命令回退、推断作用域不可缓存。
- 相同 key 合并、stale 重跑、缓存命中、不同作用域并行、每工作区并发上限、排队等待可归因。
- 同轮并发调度、写后读顺序、版本脚本屏障、Chat 输出路径重定向、并发开关。

## 九、边界

- 锁只在当前进程有效，不跨进程、跨机器；多实例部署需要换成文件锁、数据库锁或协调服务。
- PTC 是只读沙箱，不参与写锁；它读到的内容可能与并发写存在时间差，关键验证仍应在写锁之后执行。
- 版本登记使用路径字符串，不解析符号链接；同一真实文件经不同软链路径访问时会被视为不同资源。
- 验证缓存保存在内存中，进程重启后清空；这是有意的，避免把上一次进程的结论当成当前结论。
