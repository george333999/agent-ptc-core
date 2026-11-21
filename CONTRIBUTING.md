# Contributing

感谢关注。这个仓库优先接受小而可验证的改动，尤其是能改善缓存稳定性、降低工具往返次数或补充基准数据的提交。

## 开发环境

- Node.js 20 及以上
- 不依赖数据库与外部服务
- PTC 相关代码需要 `acorn`

```bash
npm install
npm test
npm run example:minimal
npm run example:ptc
```

## 发布到 Gitee

完整的发布前检查、仓库创建、远程关联和版本标签步骤见 [docs/release-gitee.md](docs/release-gitee.md)。

## 提交前检查

1. `npm test` 必须全部通过。
2. 涉及前缀或窗口逻辑的改动，需要说明对“请求前缀是否只追加”的影响。
3. 涉及工具结果的改动，需要说明脱敏、路径约束和失败回退是否仍然成立。
4. 涉及基准的改动，请附上运行环境、模型、轮次和原始结果文件。

## 代码约定

- 统一使用 ESM，保持 `type: module`。
- 不引入新的运行时依赖，除非它能明显降低复杂度并在说明中给出理由。
- 注释只解释“为什么”，不重复代码表面含义。
- 新增行为必须有对应测试；修复缺陷优先补一个能复现问题的测试。

## 提交信息

采用简洁的前缀风格：

- `feat:` 新能力
- `fix:` 缺陷修复
- `perf:` 性能或 token 优化
- `docs:` 文档
- `test:` 测试

示例：`perf: keep tool schema order stable to avoid prefix drift`

## 分支与合并

- 从 `main` 拉出功能分支。
- 一个提交只做一件事。
- 合并前确保测试通过，并在描述中写明验证方式。

## 行为准则

讨论聚焦技术事实，不针对个人。涉及未公开安全问题的内容请不要发在公开 issue 中。
