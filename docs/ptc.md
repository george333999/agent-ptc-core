# PTC 程序化工具调用

## 为什么需要 PTC

传统工具调用是一次一个：列目录、读文件、再读一个、再搜索。每一步都要把完整结果回灌给模型，模型再决定下一步。文件一多就会出现两个问题：轮次线性增长，上下文被原始内容挤满。

PTC 换了一个思路：让模型写一段短程序，在沙箱里批量完成只读操作，只把聚合后的结果返回。模型从“逐个操作”变成“描述操作”，往返次数从文件数量级降到任务数量级。

## 调用链

```text
模型输出 ptc_run({ code })
        |
        v
AST 静态校验（语法层）
        |
        v
worker 线程 + vm 沙箱（执行层）
        |
        v
类型化只读工具（接口层）
        |
        v
返回 JSON 结果，追加到历史
```

## 三层安全设计

### 语法层

基于 acorn 解析，校验代码规模与禁用能力：

- 禁止 `new`、`class`、`import`、`this`、`process`
- 禁止动态属性访问，例如 `res[i]`，数组遍历必须用 `for...of`
- 限制代码长度 40000 字符、1200 行、5000 个 AST 节点、嵌套深度 48
- 限制循环数量 50、调用点数量 40、实际工具调用 30 次

校验失败会返回带行号的诊断信息，模型按提示修正，不需要重新执行。

### 执行层

- 独立 worker 线程，运行在 `node:vm` 上下文
- 无网络、无文件写入、无 shell、无子进程
- 单次执行默认 8 秒超时，超时直接终止
- 返回结果上限 24000 字符，超出截断
- 命名空间默认最多 16 个，空闲 10 分钟回收

### 接口层

只暴露五个只读方法，参数逐个校验类型、范围、未知键与路径穿越：

| 方法 | 返回 |
| --- | --- |
| `files.list({ path, depth })` | 目录项、类型、大小、是否截断 |
| `files.read({ path, startLine, endLine })` | 总行数、区间、内容、是否截断 |
| `files.search({ query, path, glob, target, caseSensitive })` | 匹配行、数量、是否截断 |
| `knowledge.search({ query, topK, docName, collection, fileType })` | 命中片段与分数 |
| `skills.read({ name })` | 技能正文与附件列表 |

写文件、编辑、执行命令、MCP 与子 Agent 不进入 PTC，仍由主循环直连执行并走审批。

## 状态复用

同一任务内的多次 `ptc_run` 共享一个 `state` 对象和顶层变量、函数。适合分阶段扫描：第一次建立索引，第二次基于索引筛选。

需要丢弃状态时传 `reset: true`。任务结束时按作用域释放，避免并行 worker 互相污染。

## 示例

```js
const files = await api.files.list({ path: 'src', depth: 3 });
const targets = files.entries.filter((item) => item.type === 'file' && item.path.endsWith('.js'));
const hits = [];
for (const item of targets) {
  const content = await api.files.read({ path: item.path });
  for (const line of content.content.split('\n')) {
    if (line.includes('TODO')) hits.push({ path: item.path, line: line.trim() });
  }
}
return { count: hits.length, sample: hits.slice(0, 20) };
```

要点是：循环在沙箱内完成，只把计数和样本返回，而不是把每个文件的内容都带回历史。

## 适用边界

适合：大范围扫代码、批量筛选、跨目录聚合、按关键词定位后汇总。

不适合：需要逐行核对全文的任务、需要写操作的改造、依赖网络的检索。

已知限制：批量代码质量依赖模型能力。一次读取文件过多时，小模型容易漏读或串值。实践建议是按模型能力限制单次批量规模，小模型每次 3 到 5 个文件，能力较强的模型再放宽。
