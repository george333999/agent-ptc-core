# Publishing to Gitee

This document gives the complete steps from a local directory to a public Gitee repository. The commands use PowerShell as an example; for other terminals, adapt the paths accordingly.

Note: GitHub hosts the English edition of this project, and Gitee hosts the Chinese edition.

## 1. Pre-Publish Checks

Run in the `local-first-agent-workbench` directory:

```powershell
npm install
npm test
npm run example:minimal
npm run example:context
npm run example:ptc
npm run benchmark:report
```

Confirm:

- All tests pass.
- Both examples produce output normally.
- `benchmark/output/benchmark-report.html` opens, with complete charts and summary.
- `git status` shows no `.env`, API keys, personal paths, logs, or temporary files.
- `README.md`, `LICENSE`, `CHANGELOG.md`, `CONTRIBUTING.md`, `SECURITY.md`, and `CODE_OF_CONDUCT.md` all exist.

## 2. Create the Gitee Repository

1. Open https://gitee.com/projects/new .
2. The suggested repository name is `cache-stable-agent-core` (the project is actually a kernel library, not a web workbench).
3. The repository path is generated automatically; keep it identical to the name.
4. Choose public.
5. Do not check "Initialize repository with README", and do not add a .gitignore or an open-source license; these files already exist locally.
6. After creation, copy the repository address, which in HTTPS form looks like `https://gitee.com/<your-account>/cache-stable-agent-core.git`. The current public repository path is still `https://gitee.com/george333999/local-first-agent-workbench`, kept temporarily for compatibility with historical links; if you have already renamed it in Gitee settings, update the URLs in `package.json`, the README, and this document accordingly.

## 3. Initialize the Local Repository

```powershell
cd local-first-agent-workbench
git init
git add .
git status
git commit -m "feat: initial open-source core"
git branch -M main
```

Check `git status` once more before committing to confirm that `benchmark/output/`, `node_modules/`, logs, or local data are not included.

## 4. Add the Remote and Push

HTTPS:

```powershell
git remote add origin https://gitee.com/<your-account>/local-first-agent-workbench.git
git push -u origin main
```

If you use SSH:

```powershell
git remote add origin git@gitee.com:<your-account>/local-first-agent-workbench.git
git push -u origin main
```

The first time you use SSH, add your local public key in Gitee under "Settings -> SSH Public Keys".

## 5. Complete the Repository Information

After a successful push, fill in the following on the Gitee repository page:

- Repository description: a cache-stable AI agent kernel: long-conversation prefix cache, history budget derived from the model window, single-turn context engine, tool result distillation, PTC sandbox, task contract, concurrent write locks, and verification scheduling.
- Topic tags: `ai-agent`, `coding-agent`, `cache-stable`, `ptc`, `prompt-cache`, `long-context`, `context-engine`, `agent-scheduler`, `resource-lock`, `verification-scheduling`.
- Open-source license: MIT.
- The README on the home page is displayed directly.
- If you have screenshots or reports, you can reference `benchmark/report-preview.html` in the README, or place report screenshots in `docs/`.

## 6. Create the Version Tag

```powershell
git tag -a v0.5.5 -m "v0.5.5: predictive compaction, guards and gates, same-window ABBA benchmark"
git push origin v0.5.5
```

Then create a Release based on `v0.5.5` on the Gitee "Releases" page, attaching the 0.5.5 content from `CHANGELOG.md`. The tags and source for 0.1.0–0.5.4 remain in the history for comparison with older versions.

## 7. Branch Protection and Collaboration

Recommended in the repository settings:

- Protect `main` and disallow direct pushes.
- Require at least 1 reviewer for pull requests.
- Require `npm test` to pass before merging.
- Enable issue templates and pull request templates; the repository already provides template files under `.gitee/`.

## 8. Optional: Gitee Pages

If you want to view the benchmark report online, you can try Gitee Pages:

1. Enable Pages in the repository settings.
2. Choose the deployment branch and directory.
3. Copy `benchmark/report-preview.html` to `index.html` at the repository root, or create a separate `docs/` site.

Gitee Pages requires real-name verification, and the available capabilities may differ between accounts; if you cannot enable it, attach `benchmark/report-preview.html` or describe in the README how to open it locally.

## 9. Subsequent Release Workflow

```powershell
git checkout -b feat/your-change
# Make changes and add tests
npm test
git add .
git commit -m "feat: describe the change"
git push -u origin feat/your-change
```

Open a pull request on Gitee and state the motivation, the scope of changes, the verification approach, and whether prefix stability is affected. After merging, create a new version tag as needed.

## 10. What Not to Commit

- `.env`, API keys, access tokens, private keys.
- `node_modules/`, `benchmark/output/`, logs, temporary screenshots.
- Real user code, internal addresses, personal absolute paths.
- Unredacted benchmark prompts and tool results.

The repository's `.gitignore` already covers common items, but it is still advisable to check again with `git status` and `git diff --cached` before committing.
