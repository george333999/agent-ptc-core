# 发布到 Gitee

这份文档给出从本地目录到 Gitee 公开仓库的完整步骤。命令以 PowerShell 为例，其他终端把路径换成对应写法即可。

## 1. 发布前检查

在 `local-first-agent-workbench` 目录执行：

```powershell
npm install
npm test
npm run example:minimal
npm run example:context
npm run example:ptc
npm run benchmark:report
```

确认：

- 测试全部通过。
- 两个示例都能正常输出。
- `benchmark/output/benchmark-report.html` 能打开，图表和汇总完整。
- `git status` 中没有 `.env`、API Key、个人路径、日志和临时文件。
- `README.md`、`LICENSE`、`CHANGELOG.md`、`CONTRIBUTING.md`、`SECURITY.md`、`CODE_OF_CONDUCT.md` 都存在。

## 2. 创建 Gitee 仓库

1. 打开 https://gitee.com/projects/new 。
2. 仓库名称建议填 `cache-stable-agent-core`（项目实际是内核库，不是 Web 工作台）。
3. 仓库路径会自动生成，保持同名。
4. 选择公开。
5. 不要勾选“使用 Readme 初始化仓库”，也不要添加 .gitignore 或开源许可证，本地已经有这些文件。
6. 创建后复制仓库地址，HTTPS 形式类似 `https://gitee.com/<你的账号>/cache-stable-agent-core.git`。当前公开仓库路径仍为 `https://gitee.com/george333999/local-first-agent-workbench`，为兼容历史链接暂时保留；如已在 Gitee 设置中改名，请同步更新 `package.json`、README 与本文档中的 URL。

## 3. 初始化本地仓库

```powershell
cd local-first-agent-workbench
git init
git add .
git status
git commit -m "feat: initial open-source core"
git branch -M main
```

提交前再检查一次 `git status`，确认没有把 `benchmark/output/`、`node_modules/`、日志或本地数据带进去。

## 4. 关联远程并推送

HTTPS：

```powershell
git remote add origin https://gitee.com/<你的账号>/local-first-agent-workbench.git
git push -u origin main
```

如果使用 SSH：

```powershell
git remote add origin git@gitee.com:<你的账号>/local-first-agent-workbench.git
git push -u origin main
```

首次使用 SSH 需要先在 Gitee 的“设置 -> SSH 公钥”里添加本机公钥。

## 5. 完善仓库信息

推送成功后，在 Gitee 仓库页面补充：

- 仓库描述：缓存稳定的 AI Agent 内核：长对话前缀缓存、按模型窗口推导的历史预算、单轮上下文引擎、工具结果蒸馏、PTC 沙箱、任务契约、并发写锁与验证调度。
- 主题标签：`ai-agent`、`coding-agent`、`cache-stable`、`ptc`、`prompt-cache`、`long-context`、`context-engine`、`agent-scheduler`、`resource-lock`、`verification-scheduling`。
- 开源许可证：MIT。
- 首页 README 会直接显示。
- 如果有截图或报告，可在 README 中放 `benchmark/report-preview.html` 的说明，或把报告截图放进 `docs/`。

## 6. 创建版本标签

```powershell
git tag -a v0.5.0 -m "v0.5.0: model-window history budget, short-session context budget and five-group benchmark"
git push origin v0.5.0
```

然后在 Gitee 的“发行版”页面基于 `v0.5.0` 创建 Release，附上 `CHANGELOG.md` 中的 0.5.0 内容。0.1.0 到 0.4.0 的标签和源码保留在历史记录中，便于对照旧版本。

## 7. 分支保护与协作

建议在仓库设置中：

- 保护 `main`，禁止直接推送。
- 要求 pull request 至少 1 人 review。
- 要求 `npm test` 通过后再合并。
- 开启 issue 模板和 pull request 模板，仓库已经提供 `.gitee/` 下的模板文件。

## 8. 可选：Gitee Pages

如果希望在线查看基准报告，可以尝试 Gitee Pages：

1. 在仓库设置中开启 Pages。
2. 选择部署分支与目录。
3. 把 `benchmark/report-preview.html` 复制为根目录的 `index.html`，或单独建一个 `docs/` 站点。

Gitee Pages 需要实名认证，且不同账号的可用能力可能不同；如果无法开启，直接把 `benchmark/report-preview.html` 作为附件或在 README 中说明本地打开方式即可。

## 9. 后续发布流程

```powershell
git checkout -b feat/your-change
# 修改并补充测试
npm test
git add .
git commit -m "feat: describe the change"
git push -u origin feat/your-change
```

在 Gitee 发起 pull request，描述中写明动机、改动范围、验证方式和是否影响前缀稳定性。合并后按需打新的版本标签。

## 10. 不要提交的内容

- `.env`、API Key、访问令牌、私钥。
- `node_modules/`、`benchmark/output/`、日志、临时截图。
- 真实的用户代码、内部地址、个人绝对路径。
- 未脱敏的基准提示词与工具结果。

仓库的 `.gitignore` 已经覆盖常见项，但提交前仍建议用 `git status` 和 `git diff --cached` 再检查一次。
