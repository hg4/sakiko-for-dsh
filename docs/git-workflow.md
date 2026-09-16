# Git 线性开发流程（本项目规范）

> 适用范围：本 workspace 下纳入 git 管理的项目，**首先指 `sakiko-for-dsh` 插件仓库**
> （开发仓库根：`H:\sakiko-for-dsh`，远端 `https://github.com/hg4/sakiko-for-dsh.git`）。
> 由用户 2026-09-13 明确要求：**改功能或修 bug 都必须走分支 → rebase → 合主干 → push，全程线性**。
>
> **开发仓库 ≠ 安装副本**：`H:\sakiko-for-dsh` 是开发仓库（含 `.git`），本文所有 `git -C $repo` 都指它；`%USERPROFILE%\.dsh\profiles\web\node_modules\sakiko-for-dsh` 是 **dsh 实际加载的安装副本**（pnpm 按 `github:hg4/sakiko-for-dsh` 装出来的目录，**不含 `.git`**，不能当 git 仓库用）。
> 改开发仓库的代码**必须同步到安装副本并重启 DSH** 才会生效（见 §11 第 3 条）。

## 0. 一句话流程

```
main（保持最新） ──分支──▶ <type>/<topic> ──rebase origin/main──▶ 验收 ──ff-only 合入 main──▶ push
```

**主干只接受快进合并**：历史是一条直线，没有 merge commit，不做 force push。

## 1. 分支命名

| 前缀 | 用途 | 例 |
| --- | --- | --- |
| `feat/` | 新功能 | `feat/voice-autostart` |
| `fix/` | 缺陷修复 | `fix/publish-bundle-decl` |
| `chore/` | 构建/文档/杂项 | `chore/build-validate` |
| `refactor/` | 不改行为的重构 | `refactor/narration-label` |

一个分支只做一件事，便于回退与复审。

## 2. 起手式：永远从**最新** main 开分支

```powershell
$repo = 'H:\sakiko-for-dsh'   # 本机实测值：开发仓库根，含 .git（安装副本不含 .git，不能当仓库用）
git -C $repo -c http.proxy= -c https.proxy= fetch origin
git -C $repo switch main
git -C $repo -c http.proxy= -c https.proxy= pull --ff-only          # 或等价：git merge --ff-only origin/main
git -C $repo switch -c fix/<topic>
```

> **代理注意**：本机 `git config` 给 github.com 配了 `http://127.0.0.1:7897`，而该端口**经常没在监听**
> ⇒ 直接 `git fetch/push` 会失败。统一用 `-c http.proxy= -c https.proxy= -c http.https://github.com/.proxy=`
> 清掉代理走直连（实测直连可达 GitHub），推送走 SSH（已认证 `hg4`）。

**并行做事时用 worktree**，不要在同一棵树上同时改：

```powershell
# 工作树放哪随机器而定：下面是占位值，按自己的目录替换（占位值不指向任何真实目录）：
$workspace = '<工作区根>'
git -C $repo worktree add "$workspace\<topic>" -b fix/<topic>
# 干完、合并后清理：
git -C $repo worktree remove "$workspace\<topic>"
```

## 3. 分支内开发

- 改动尽量小而聚焦；**每完成一个有意义的单元就提交一次**（提交信息写"为什么"，不是"改了什么"）。
- 提交前跑项目自己的闸门（见 §5），**不要带着坏状态往下走**。
- 允许在本分支内 `git commit --amend` / 交互式 rebase 整理历史；**不要**改写已推送的 `main`。

## 4. 合入主干前：先 rebase 到最新

```powershell
git -C $repo -c http.proxy= -c https.proxy= fetch origin
git -C $repo rebase origin/main          # 在分支上执行；冲突就地解决后 git rebase --continue
```

rebase 之后**必须重跑验收**（§5）—— 基线变了，之前的绿灯不作数。

## 5. 验收闸门（按改动风险触发，不按交付物形态）

| 闸门 | 何时必须 | 判据 |
| --- | --- | --- |
| 语法检查 | 改 JS/Python | `node --check host.mjs`；`python -m py_compile` |
| 打包自检 | 改包内容/manifest/路径 | 打包后逐项对账 `package.json` 的 `files` / `config/manifest.json`：**必需项缺失=0**，且不夹带**未跟踪**文件（后者只警告） |
| 隔离安装验证 | 改发布形态/入口 | 装进**全新隔离 profile** ⇒ 成为 bundle 层、路由 200、BOOT 注册客户端插件 |
| 真机验收 | 改语音链路/服务生命周期 | `owner=plugin`、父进程=DSH、合成 32000Hz，并有**反例对照**（500 应被拒） |
| **独立复审** | 任何能决定结论真假的改动 | 由**非作者**的子代理实测后给结论（作者不自审）；复审点出阻塞项就**先修再合** |

**"跑完了/无报错/有产物"不算通过**；每一步都要有已知答案的对照。

> 上表只写**判据**，不写具体脚本：本仓库**不自带**打包自检 / 隔离安装验证 / 真机验收的验证程序，
> 它们由本机另行落成脚本或人工执行。所以照上表执行时，先自备一个能给出该判据的入口（脚本或手工步骤），
> **别把某台机器上的私有路径当成本仓库的组成部分**。

## 6. 合入主干（只允许快进）

```powershell
git -C $repo switch main
git -C $repo -c http.proxy= -c https.proxy= merge --ff-only fix/<topic>
```

- 若 `--ff-only` 失败（说明 main 又有新提交）⇒ 回到 §4 重新 rebase，**不要**改用普通 merge 或 force。
- 合完删分支：`git -C $repo branch -d fix/<topic>`；用了 worktree 的一并 `worktree remove`。

## 7. 推送

```powershell
git -C $repo -c http.proxy= -c https.proxy= -c http.https://github.com/.proxy= push origin main
git -C $repo -c http.proxy= ls-remote origin refs/heads/main    # 核对远端 == 本地 HEAD
```

推送后**核对远端 ref 与本地 HEAD 一致**，再对外宣称"已发布"。

## 8. 发布（插件仓库专属）

- 发 Release / 改仓库可见性属于"**元操作**"：本仓库**不自带**发布脚本 ⇒ 由**人**在网页操作，或用**临时** token 走 GitHub API。
  无论走哪条路，发布前都必须**工作树干净**（这是安全闸，别绕过）。
- 验收/复审未过之前，仓库保持 **private**；全过之后再转 public。

### 8.1 凭据：**日常提交不需要 token**

| 操作 | 需要 token？ | 说明 |
| --- | --- | --- |
| fetch / branch / rebase / **merge --ff-only** / **push** | ❌ | 走 **SSH**（本机 `id_ed25519` 已对 `hg4` 认证通过） |
| 推 tag（`git push origin v2.0.1`） | ❌ | 同上 |
| **建仓库** | ✅ | HTTPS API 独有；也可由人在网页 New repository |
| **改仓库可见性** | ✅ | 也可由人在 Settings 里点 |
| **发 Release + 上传资产** | ✅ | 也可由人在网页 Draft a new release 上传 tgz |

⇒ **token 用完立刻撤销**（GitHub → Settings → Developer settings → Personal access tokens → Delete），
下次要发版再临时建一个（勾 `repo` 即可）；或改由人在网页完成这三件"元操作"。
若想长期免 token 发 Release，可装 `gh` CLI 登录一次（凭据进系统凭据库）——属长期凭据，需权衡。


## 9. 禁止事项

- ❌ 直接在 `main` 上改代码并提交（哪怕只有一个字符）。
- ❌ 用普通 `merge` 制造 merge commit（破坏线性）。
- ❌ `push --force` 到 `main`。
- ❌ 在有未提交改动时发布（发布前工作树必须干净，**别绕过**这道安全闸；见 §8）。
- ❌ 改历史提交来"修正"已推送的说明 —— 用**新提交**更正（例：`cdb3e83` 更正了 `31a4a57` 里自相矛盾的描述）。

## 10. 回滚

- 撤销某次已合入的改动：`git revert --no-edit <sha>`（**保持线性**），然后按 §6/§7 合入并推送。
- 不要 `reset --hard` 已推送的 `main`。

## 11. 踩坑记录（供参考）

1. **PS 5.1 + 原生命令 stderr**：脚本里 `$ErrorActionPreference='Stop'` 时，`git push` 的进度输出走 stderr
   会被当成致命错误中断（实测推送已成功、脚本却退出，没走到发 Release）。⇒ 调原生命令时临时切回 `Continue`，用 `$LASTEXITCODE` 判成败。
2. **`Start-Process` 杀不干净**：它起的是 `dsh.CMD`（cmd shim），杀 shim 不会带走 node 子进程 ⇒ 端口一直被占。
   ⇒ 停实例要按端口兜底杀 listener。
3. **⚠️ 改了 `host.mjs` 的代码，必须重启 DSH 才生效 —— profile patch 重载不会重新 import 模块**
   （2026-09-13 实测，代价是一次白跑的验证）：

   - 改 `~/.dsh/profiles/web/cordis.patch.yml` 里**已有 entry 的 `config`**（insert 新 entry **不触发**）
     确实会创建**新的插件实例**：`/sakiko/voice` 的 `epoch` 自增、日志出现
     「插件卸载：8s 后停止…」→「插件重载：已取消待执行的停止动作」→「重复 start…忽略且不重复 spawn」，
     服务 PID 不变（D9 生效）。
   - **但 ESM 模块按 URL 缓存，Cordis 只是重新 `apply()` 同一个已加载模块** ⇒ 磁盘上新写的代码**不会生效**。
   - 判据：在 `host.mjs` 里加一条必定落盘的诊断（`tlLog({ev:'diag_xxx'})`），重载后触发对应事件 ——
     **诊断行没有出现**；而同一文件在磁盘上确实含该诊断，且 mtime 早于重载时间。
   - ⇒ **验证 `host.mjs`（或 `client.js`/`panel.js`）的代码改动，必须重启 DSH**；
     profile 重载只能用来验证**配置/接线**层面的改动（以及实例生命周期语义，如 D9/X4）。
4. **⚠️ 重启前必须先确认旧 DSH 真的退出了，否则新实例起不来（`EADDRINUSE 127.0.0.1:3080`）**
   （2026-09-13 用户实测卡住一次）：
   - `dsh web` 是**独占端口**的：旧进程没死时直接起新的，会立刻
     `listen EADDRINUSE: address already in use 127.0.0.1:3080` 退出，看起来像"启动器坏了"，
     实际是"上一个还活着"。
   - ⇒ 启动脚本**必须先探测 3080**，占用时打印持有进程与可选项后 `exit 1`（`start-dsh-direct.ps1`
     已实现）；不要盲起。
   - ⇒ **停止方式决定语音服务是否被回收**：在 DSH 窗口 **Ctrl+C** = 优雅退出，DSH 的 subprocess 服务
     会 `process.on('exit')` 回收插件托管的 python 子进程，插件自身也会在 dispose 时排 8s 停止；
     **点窗口 X / 强杀进程** = 两者都不执行 ⇒ GPT-SoVITS api(9880)/bridge(8100) 残留成孤儿。
     这种残留只能用 `stop-all.bat`（按端口 `Stop-Process -Force`）清。
   - ⇒ 语音服务的归属是**插件**（`sakiko-for-dsh` 的 autostart 拉起），所以"是哪个插件没清理"的答案
     永远是它；但**没清理的前提是 DSH 没优雅退出**——DSH 活着的时候它本来也不该清理。
   - ⚠️ **别再用"日志里没有『插件卸载』行"反推 dispose 没跑**：那个日志文件是插件**内存环形缓冲的整份覆写**
     （每次启动清空重写），新实例一起来，上一代的记录就没了 ⇒ 事后取证无效。
     要判 dispose 是否执行，看**当次运行期间**的日志或 timeline（append-only），不要事后翻文件。
5. **⚠️ 本机（Windows PowerShell 5.1）下，凡是带引号 / `$` / 中文 / 行号统计的命令，不要走 PowerShell 内联**
   （2026-09-16 实测，三条都真的翻过车）：
   - **`Get-Content` 默认按 ANSI 读 UTF-8** ⇒ **行数读错**（实测 `watchdog.mjs` 733 行读成 671 行）、
     行号随之漂移 ⇒ 会把"文件根本没被改过"误判成"被改过"。
   - **`>` 重定向是 UTF-16LE** ⇒ 把原生命令的输出写成 UTF-16（下游按 UTF-8 读会看到乱码/空行），
     落盘取证一律别用它。
   - **内联 `node -e` 里的 `$` 会被 PowerShell 先展开成空串**（于是算出/matched 到的是别的东西 ⇒ 得出**假阳性**结论）；
     **`||` 会被当作 PowerShell 语句分隔符** ⇒ 整段 `node -e` 根本不执行，看起来却"没报错"。
   - ⇒ 读写用 `read` / `edit` / `write` 工具或 **node 脚本**；要落盘输出就让脚本自己写文件（别用 `>`）。
   - ⇒ 改写文件时注意本仓库 **`core.autocrlf=true`**（系统级）：**blob 是 LF、工作树曾被写成 CRLF**。
     因此**比较"工作树文件"与"git blob"不能比原始字节 sha256** —— 纯文本必然对不上；用 **`git hash-object`**
     （它按属性规范化），或先把两侧行尾统一再比。

