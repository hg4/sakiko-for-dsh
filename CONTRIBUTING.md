# 贡献与提交流程（线性开发）

本仓库的 `main` **只接受快进合并**：历史是一条直线，没有 merge commit，不做 force push。
改功能或修 bug 都必须走「分支 → rebase → 合主干 → push」。

```
main（保持最新） ──分支──▶ <type>/<topic> ──rebase origin/main──▶ 验收 ──ff-only 合入 main──▶ push
```

## 1. 开分支（永远从最新 main）

```powershell
git fetch origin
git switch main
git merge --ff-only origin/main        # 或 git pull --ff-only
git switch -c fix/<topic>
```

| 前缀 | 用途 | 例 |
| --- | --- | --- |
| `feat/` | 新功能 | `feat/voice-autostart` |
| `fix/` | 缺陷修复 | `fix/watchdog-ownership-gates` |
| `chore/` | 构建 / 文档 / 杂项 | `chore/contributing-flow` |
| `refactor/` | 不改行为的重构 | `refactor/narration-label` |

一个分支只做一件事。要并行干活就开 worktree（`git worktree add <dir> -b <branch>`），别在同一棵树上同时改。

## 2. 提交（写"为什么"）

每完成一个有意义的单元就提交一次；提交信息用中文 + conventional 风格，正文说清**为什么**改、以及**验证了什么**（附关键数字/命令）。

## 3. 合入前：rebase 到最新

```powershell
git fetch origin
git rebase origin/main        # 冲突就地解决后 git rebase --continue
```

rebase 之后**必须重跑验收** —— 基线变了，之前的绿灯不作数。

## 4. 验收闸门（按风险触发，不按交付物形态）

| 闸门 | 何时必须 | 判据 |
| --- | --- | --- |
| 语法检查 | 改 JS / Python | `node --check <file>`；`python -m py_compile <file>` |
| 包内容自检 | 改 `package.json` / manifest / 路径 / 新增文件 | 打出的 tarball 里**确实有**该文件；`files` 与 `dsh.bundle.patch` 声明与实际一致 |
| 隔离安装 | 改发布形态 / 入口 | 装进**全新隔离 profile** ⇒ 成为 bundle 层、路由 200、客户端插件被注册 |
| 真机验收 | 改语音链路 / 服务生命周期 | `owner=plugin`、服务父进程 = DSH、合成音频采样率与格式正确、**反例**返回错误 |
| 独立复审 | 任何能决定结论真假的改动 | 由**非作者**的人/子代理独立实测后给结论；点出阻塞项就**先修再合** |

**「跑完了 / 无报错 / 有产物」不算通过**：每一步都要有**已知答案的对照**（正例 + 反例；改 bug 时对照"未修版本必须失败"）。

## 5. 合入并推送

```powershell
git switch main
git merge --ff-only <type>/<topic>     # 失败说明 main 又动了 ⇒ 回第 3 步重新 rebase，别改用普通 merge
git push origin main
git ls-remote origin refs/heads/main   # 核对远端 ref == 本地 HEAD
git branch -d <type>/<topic>           # 合并后清理分支（用了 worktree 的一并 worktree remove）
```

推送后**核对远端 ref 与本地 HEAD 一致**，再对外宣称"已发布"。

## 6. 禁止事项

- ❌ 直接在 `main` 上改并提交（哪怕一个字符）
- ❌ 普通 `merge` 造 merge commit、`push --force` 到 `main`
- ❌ 工作树有未提交改动就发布
- ❌ 改历史提交来"更正"已推送的说明 —— 用**新提交**更正

回滚：`git revert --no-edit <sha>`（保持线性），再按第 4~5 步走一遍；不要 `reset --hard` 已推送的 `main`。

## 7. 本机 / 环境注意事项

- **代理**：本机 `git config` 给 github.com 配了 `http://127.0.0.1:7897`，该端口经常没在监听。直连可达，所以命令里统一清掉代理：
  `git -c http.proxy= -c https.proxy= -c http.https://github.com/.proxy= <cmd>`；推送走 SSH。
- **凭据**：日常 `fetch / 分支 / rebase / merge --ff-only / push` 走 SSH，**不需要 token**；
  只有"建仓库、改可见性、发 Release（含上传资产）"这类 HTTPS API 独有操作才需要，用完立刻撤销。
- **Windows 脚本编码**：`.ps1` 含中文必须存为 **UTF-8 带 BOM**（PS 5.1 否则按 GBK 解析）；
  `.bat/.cmd` 一律**纯 ASCII + CRLF** 且只做一行转发（cmd.exe 对 UTF-8/LF 的批处理会解析错、把后续命令吞掉）。
- **改了 `host.mjs` 必须重启 DSH 才生效**：插件热重载只重新 `apply()` 已加载的 ESM 模块，不会重新 import 文件。
- **端口独占**：`dsh web` 独占 3080，旧实例没退时直接起新的会 `EADDRINUSE` 崩；停实例按端口定位 listener（`Start-Process` 起的是 cmd shim，杀它不带走 node 子进程）。
