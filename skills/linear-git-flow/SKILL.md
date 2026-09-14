---
name: linear-git-flow
description: Use when changing or fixing code in the sakiko-for-dsh plugin repo (or any git repo with a GitHub remote in this workspace) — before editing on the trunk, when merging work back, or before pushing to GitHub.
---

# 线性 Git 开发流程

主干 `main` **只接受快进合并**：历史是一条直线，没有 merge commit，不 force push。

详细规范（含每条命令与踩坑记录）：`G:\workspace\docs\git-workflow.md`。

## 流程（每一步都别跳）

```
main 最新 ──分支──▶ <type>/<topic> ──rebase origin/main──▶ 验收 ──ff-only 合入──▶ push
```

```powershell
$repo = 'C:\Users\Admin\.dsh\profiles\node_modules\sakiko-for-dsh'
$git  = { param($a) git -C $repo -c http.proxy= -c https.proxy= -c http.https://github.com/.proxy= @a }

# 1) 从最新 main 开分支（并行干活就换成 worktree add）
& $git @('fetch','origin'); & $git @('switch','main'); & $git @('pull','--ff-only')
& $git @('switch','-c','fix/<topic>')
# 2) 改 + 提交（为什么改，不是改了什么）
# 3) 合入前先 rebase 到最新，然后**重跑验收**（基线变了，旧绿灯不算）
& $git @('fetch','origin'); & $git @('rebase','origin/main')
# 4) 只允许快进合并；失败说明 main 又动了 ⇒ 回第 3 步，别改成普通 merge
& $git @('switch','main'); & $git @('merge','--ff-only','fix/<topic>')
# 5) 推送并核对远端 == 本地 HEAD
& $git @('push','origin','main'); & $git @('ls-remote','origin','refs/heads/main')
```

分支前缀：`feat/` `fix/` `chore/` `refactor/`，一个分支一件事。

## 验收闸门（按风险触发，不看交付物形态）

| 改了什么 | 必须验 |
| --- | --- |
| JS / Python | `node --check host.mjs`、`python -m py_compile` |
| 包内容 / manifest / 路径 | `python G:\workspace\sakiko-plugin-dist\build_dist.py` 自检全过 |
| 发布形态 / 入口 | `verify-github-install.ps1`（全新隔离 profile ⇒ 成为 bundle 层、路由 200） |
| 语音链路 / 服务生命周期 | `verify-voice-autostart.ps1`（`owner=plugin`、父进程=DSH、合成 32000Hz、反例 500） |
| **任何能决定结论真假的改动** | **独立复审**（非作者的子代理实测 + 结论）；有阻塞项先修再合 |

**"跑完了 / 无报错 / 有产物"不算通过** —— 每步都要有已知答案的对照（正例 + 反例）。

## 禁止

- ❌ 直接在 `main` 上改并提交（哪怕一个字符）
- ❌ 普通 `merge` 造 merge commit、`push --force` 到 `main`
- ❌ 工作树有未提交改动就发布（`publish-github.ps1` 会拒绝，别绕过）
- ❌ 改历史提交来"更正"已推送的说明 —— 用**新提交**更正

## 凭据

日常流程（fetch / 分支 / rebase / **merge --ff-only** / **push** / 推 tag）**走 SSH，不需要 GitHub token**。
只有三类"元操作"要 token（HTTPS API 独有，SSH 无对应能力）：**建仓库、改仓库可见性、发 Release（含上传资产）**——
用 `publish-github.ps1 -Token <临时 token>` 做，**用完立刻撤销**；或让人在网页上点，完全不用交出凭据。

## 本机特有的坑

- github.com 配了 `http://127.0.0.1:7897` 代理而该端口常没在监听 ⇒ 一律用上面 `-c http.proxy=` 那串清掉代理；推送走 SSH（已认证 `hg4`）。
- PS 5.1 里 `$ErrorActionPreference='Stop'` 时，`git` 的进度输出走 stderr 会被当致命错误中断（推送其实已成功）⇒ 调原生命令时临时切回 `Continue`，用 `$LASTEXITCODE` 判成败。
- `Start-Process` 起的是 `dsh.CMD`（cmd shim），杀它不带走 node 子进程 ⇒ 停实例要按端口兜底杀 listener。
