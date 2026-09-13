# sakiko-for-dsh（SAKIKO）

把 **豊川祥子（とがわ さきこ /《BanG Dream! It's MyGO!!!!!》《BanG Dream! Ave Mujica》）** 请进
DeepSeek Harness：iPhone 风格的浮窗面板 + Live2D 立绘 + 日语语音 + 长期记忆 + 多会话播报。

> **本项目是基于上游插件的二次开发**（见「一、二次开发声明」），且是**非官方二创作品**，
> 与 BanG Dream! Project、株式会社ブシロード、Craft Egg Inc.、Ave Mujica 及相关权利方
> **没有任何关联**，未获其授权或认可。仅供个人学习与技术交流，**不得用于任何商业用途**。

---

## 一、二次开发声明

本项目的架构与绝大部分基础实现来自上游项目：

| | 项目 | 说明 |
| --- | --- | --- |
| 上游 | [**yyxcnasd/amadeus-for-dsh**](https://github.com/yyxcnasd/amadeus-for-dsh) | 《命运石之门 0》Amadeus —— 牧濑红莉栖智能助手（MIT） |
| 本项目 | [**hg4/sakiko-for-dsh**](https://github.com/hg4/sakiko-for-dsh) | 在上游基础上改为《BanG Dream!》豊川祥子（CRYCHIC 期「白祥」）版本 |

**沿用上游的部分**：Cordis 插件架构与 RPC 桥、Live2D 面板骨架、多 TTS 通道
（Edge TTS / VOICEVOX / Aqua-TTS(GPT-SoVITS) / OpenAI 兼容）、长期记忆、事件播报、
词级口型同步等机制的设计与主体实现。

**本项目所做的主要改造**：
- 角色、人格与全部台词（`persona/`，台词经动画考据）替换为豊川祥子
- 美术与主题：iPhone 直板面板、深蓝 × 月白 × 金色主题、祥子 Live2D 模型与表情/动作表
- 语音：接入自训练音色（GPT-SoVITS `aqua` 通道）
- 新增：多工作区播报（多个会话共用一个她、按会话分别记录进度、串行排队）、
  助手文本预算、哼唱彩蛋（`assets/audio/hum-*.wav`）
- 命名统一：包名 / 路由前缀 / DOM id / localStorage 键 / 数据目录由 `amadeus` 改为 `sakiko`
  （旧数据的一次性迁移说明见 `host.mjs` 头部注释）
- 分发方式：上游用 `install.ps1` / `Amadeus-OneClick.bat` 手工安装，
  本项目改用**标准 npm 包 + DSH bundle 层**，安装后随 `dsh web` 自动加载
- 新增语音安装 skill（`skills/sakiko-voice-setup/`，见「四」）

本项目与上游作者无隶属或合作关系；上游著作权归其作者 yyxcnasd 所有。

## 二、安装

### 方式一（推荐，已实测）：Release tarball

从 [Releases](https://github.com/hg4/sakiko-for-dsh/releases) 下载 `sakiko-for-dsh-<版本>.tgz`，然后：

```powershell
dsh plugin --profile web add file:<下载目录>\sakiko-for-dsh-2.0.0.tgz
```

要换版本：**先 `remove` 再 `add`**（pnpm 不会重装同一路径的 `file:` 依赖）：

```powershell
dsh plugin --profile web remove sakiko-for-dsh
dsh plugin --profile web add file:<新路径>\sakiko-for-dsh-<新版本>.tgz
```

**装完即生效，不需要手工改任何配置文件、也不需要跑任何 .bat / .ps1。** 本包在
`package.json` 里声明了 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`，
且这个声明**就在仓库里、随包一起分发**；安装时它会被登记为 profile 的一个 bundle 层
（`dsh.profile.bundles`），以后每次 `dsh web` 启动都会自动加载本插件的面板与后端。

装完可以这样自查（应当能看到 `sakiko-for-dsh`）：

```powershell
# 1) bundle 层登记
(Get-Content "$env:USERPROFILE\.dsh\profiles\web\package.json" -Raw | ConvertFrom-Json).dsh.profile.bundles
# 2) 插件文件在
Test-Path "$env:USERPROFILE\.dsh\profiles\web\node_modules\sakiko-for-dsh\cordis.patch.yml"
# 3) 起一个实例后查状态（phase=ready / owner=plugin 才算链路通了）
curl.exe -sS http://127.0.0.1:3080/sakiko/voice
# 4) 核对 pnpm 解析到的提交（应等于你期望的 HEAD）
Select-String -Path "$env:USERPROFILE\.dsh\profiles\web\pnpm-lock.yaml" -Pattern 'commit:'
```

### 方式二：`github:` 直装（已实测可用）

```powershell
dsh plugin --profile web add github:hg4/sakiko-for-dsh
```

不需要先下载 tarball，装完**同样装完即生效**：本包在 `package.json` 里声明了
`"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`，而且这份声明**就在仓库里**
（`cordis.patch.yml` 与 `package.json` 都受 git 跟踪）——所以从 GitHub 源码装下来也会被登记为
profile 的 bundle 层（`dsh.profile.bundles`）。打包脚本在打包前会校验这份声明，缺了直接 `exit 1`。

两点注意：

- pnpm 会把 git 依赖按**解析到的 commit** 缓存。正常情况每次都会重新解析默认分支的 HEAD；
  若你怀疑拿到的是旧副本，用上面「装完自查」的 1)、2) 确认一下，或在 spec 上钉死提交：
  `dsh plugin --profile web add github:hg4/sakiko-for-dsh#<commit>`。
- 仓库公开时该命令无需任何凭据；私有仓库则需要本机已配好可访问它的 SSH key。
- 罕见情况：若 pnpm 提示 git-hosted 依赖的构建脚本被拦（DSH 会给出提示），把 pnpm 打印的键名写进
  `%DSH_HOME%\profiles\<profile>\pnpm-workspace.yaml` 的 `allowBuilds:` 列表即可。
  **本包没有 `prepare`/构建脚本，正常情况下不会触发这一条。**

> 若你之前用上游 `install.ps1` 装过、或手工在 profile 的 `cordis.patch.yml` 里写过
> `id: amadeus` / `id: sakiko`，请把**手工那份删掉**，否则同一个 id 会出现两次。

重启 DSH 后，Web 界面右侧就会出现祥子的浮窗面板。


## 三、语音：先能出声，再谈像不像

面板「设置」里可切换语音通道，**默认走 Edge TTS**：

| 通道 | 需要准备什么 | 说明 |
| --- | --- | --- |
| `edge`（默认） | Python 3 + `pip install edge-tts`，且能连通微软语音端点 | 日语女声，默认 `ja-JP-NanamiNeural` |
| `aqua` | 自备 GPT-SoVITS 服务（见「五」） | **祥子本人音色** |
| `voicevox` | 自备 VOICEVOX 服务（默认 `http://127.0.0.1:50021`） | 日语，多说话人 |
| `openai` | 任意 OpenAI 兼容 TTS 端点 + Key | 云 TTS |

**音色模型与运行环境（约 9 GB）不随包分发**，需自行准备；本项目的安装 skill 会指导 agent
完成全部安装与配置（见「四」）。

### 让 DSH 自己拉起语音服务（不再需要 .bat）

插件可以自己把 **GPT-SoVITS api + 协议桥**拉起来 —— 直接 `dsh web` 就有声音，
不需要先跑 `start-voice-core.ps1` 之类的启动脚本。在
`%DSH_HOME%\sakiko\config\sakiko.json` 里配置（**改之前先停 DSH**）：

```jsonc
"voiceAutoStart":    true,                              // 默认开；关掉后插件完全不碰语音服务
"voiceRoot":         "D:\\sakiko-voice",                // 语音根目录：含 env\、GPT-SoVITS-main\、bridge_tts.py
"voiceDevice":       "cuda",                            // cuda | cpu
"voiceGptWeights":   "D:\\...\\sakiko.ckpt",            // 留空 = 用 api 启动时的默认模型（零样本克隆）
"voiceSovitsWeights":"D:\\...\\sakiko.pth",
"voiceApiPort":      9880,
"voiceBridgePort":   8000
```

行为约定（都是刻意设计的）：

- **只探测、不硬来**：端口已经在监听就判定为「外部服务」，插件只读状态，不接管、**也不会停它**
  （你自己用脚本起的服务不会被插件弄死）。
- **服务随 DSH 一起收摊**：插件自己拉起的进程归 DSH 托管，**DSH 正常退出（Ctrl+C / 卸载 / 热重载）
  时会一并结束**；**非正常退出**（点窗口 X、`taskkill /F`、DSH 崩溃）由下一小节的**看门狗**兜住。
- **热重载不误杀**：插件卸载时**延时 8 秒**才停服务，配置热重载会取消这个动作 ——
  避免改一次配置就把要 30~60 秒加载的模型杀掉重启。
  （2026-09-13 端到端实测：改 profile 的 `cordis.patch.yml` 触发重载后 `epoch` 1→2、
  api/桥 PID 与端口**全不变**，日志出现「插件重载：已取消待执行的停止动作」，
  且新一代实例仍认得上一代拉起的服务、`?action=stop` 能真把它们停掉。）

### 退出自清理：看门狗（v2.1.0）

`ctx.subprocess` 的回收**只挂在 JS 的退出钩子上** —— 点控制台窗口的 X、`taskkill /F`、DSH 崩溃时
钩子根本不跑，插件拉起的 python 服务会变成**孤儿**：端口（默认 9880/8000）一直被占，
下次启动被插件判成「外部服务、不接管」，于是必须先跑 `stop-all.bat` 才有声音。v2.1.0 用一个
独立进程兜住这三种情况：

- **看门狗进程**（包内 `watchdog.mjs`，零新依赖）：插件用 `node:child_process.spawn` 以 `detached`
  方式把自己的 node 拉起来跑它 —— **不是** `ctx.subprocess`，因为那一套恰好会被 DSH 的退出钩子回收。
- **主信号 = stdin 管道 EOF**：DSH 进程一消失，管道写端被系统关闭 ⇒ 看门狗读到 EOF 立刻开始回收
  （不依赖 pid 还能不能查到）；兜底每 2.5s 加一次 `process.kill(dshPid, 0)`。
- **所有权靠令牌文件**（`%DSH_HOME%\sakiko\run\voice-watchdog.json`，原子写）：里面是本代的 `token`
  与插件**自己拉起**的服务清单 `{key,pid,port}`（api 成功后再写一次、桥成功后再写一次）。
  看门狗触发回收时**重新读**这个文件：**`token` 不匹配、或文件不在，就什么都不杀**
  （宁可漏杀，绝不误杀新一代/外来服务）。正常停止或卸载时插件先把该文件写成 `{"token":null}`，
  于是任何残留看门狗醒来也会立刻收工。
- **回收动作是进程树强杀**（Windows：`taskkill /PID <pid> /T /F`）：GPT-SoVITS 的启动器下面还有
  worker 子进程，只杀启动器会留下占着端口的孤儿；杀完复核端口，若仍在监听且令牌仍匹配，
  才按端口找持有者、并且**只杀本代服务进程树里的**进程。
- **日志**与语音自启动同一份文件、**append 语义**：`%DSH_HOME%\sakiko\logs\voice-autostart.log`，
  看门狗的行带 `[watchdog]` 标记。该文件超过 1 MB 才轮转成 `.1`
  （旧版本是「新实例一起来就把上一代记录整份覆写掉」，重启后没法事后取证 —— 已修）。

实测范围（2026-09-13，脚本 `tools/test-watchdog.mjs`：真插件 + 假 DSH 进程 + 两代 dummy 服务）：

| 场景 | 实测结果 |
| --- | --- |
| `taskkill /F` 强杀 DSH（关窗/崩溃同路） | 两个端口 **+2.5s** 空闲；两代 dummy（启动器 + worker）全灭；看门狗 **+3.1s** 自行退出 |
| 令牌已被新一代改写 | 服务**一个都没被杀**，看门狗读出「token 不匹配 ⇒ 不做任何操作」后退出 |
| 端口被外来服务占着（external 分支） | 不生成看门狗、不碰任何进程（强杀 DSH 后外来服务仍然活着） |
| 正常 `?action=stop` / 插件卸载 | 服务被杀、看门狗收摊、令牌置为失效态、无孤儿 |

复跑：`node tools/test-watchdog.mjs`（加 `--plugin <另一份插件副本>` 可对比未修版本；只用临时端口）。

**别当成「任何情况都不会残留」**：清理的前提是看门狗已经活着 —— 在它启动前的一瞬、
或令牌文件写不进去（磁盘满/权限）时 DSH 被强杀，仍可能留下孤儿。
这时按端口查一下（`netstat -ano | findstr :9880`）手动结束即可。

状态查询与手动控制（面板所在端口，默认 3080）：

```powershell
curl.exe -sS http://127.0.0.1:3080/sakiko/voice                  # phase / owner / 端口 / pid / 最近日志
curl.exe -sS "http://127.0.0.1:3080/sakiko/voice?action=start"   # 手动拉起
curl.exe -sS "http://127.0.0.1:3080/sakiko/voice?action=stop"    # 只停插件拉起的那些
```

## 四、用 AI agent 一键安装祥子语音（skill）

本包自带安装 skill：`skills/sakiko-voice-setup/`。它**不是插件运行时的一部分**，
而是给 **AI agent 看的操作手册** —— 由 agent 把一个全新的语音环境装好、配好、启动并验证。

| 文件 | 用途 |
| --- | --- |
| `SKILL.md` | 安装顺序（9 步，每步带判据）、验证阶梯（含反例对照）、故障速查 |
| `bridge_tts.py` | 已实测的协议桥：把插件的 `/tts/file` 翻译成 GPT-SoVITS 请求。纯标准库零依赖、配置驱动、自动 `set_model`、把 api 的原始错误带进错误响应 |
| `bridge.config.example.json` | 桥的配置模板 |
| `preflight.py` | 一键体检：Python/torch/CUDA、NLTK 数据、基础模型、权重、参考音频、端口、服务、插件配置；`--json` 给 agent 用，退出码 0 = 关键项全过 |

**安装 skill**（放进 DSH 的 skills 目录，重启 DSH 后生效）：

```powershell
# <插件安装目录> 一般是 ~\.dsh\profiles\node_modules\sakiko-for-dsh
$src = "$env:USERPROFILE\.dsh\profiles\node_modules\sakiko-for-dsh\skills\sakiko-voice-setup"
$dst = "$env:USERPROFILE\.dsh\skills\sakiko-voice-setup"
New-Item -ItemType Directory -Force -Path $dst | Out-Null
Copy-Item "$src\*" $dst -Recurse -Force
```

**使用**：装好后直接跟 agent 说「帮我装祥子语音」或「祥子插件不出声了」，
agent 会加载这个 skill 并按其中步骤执行。也可以先自己体检：

```powershell
python "$env:USERPROFILE\.dsh\skills\sakiko-voice-setup\preflight.py" --voice-root "D:\sakiko-voice"
```

## 五、手动安装祥子语音（不想用 agent 的话）

需要自备三样（本包不附带）：**GPT-SoVITS 本体**、**祥子音色权重**（`.ckpt` + `.pth` 成对）、
**参考音频**（5~30 秒单人干声 + 与之一致的逐字日文文稿）。国内走 modelscope / 镜像。

**落点**（`VOICE_ROOT` 建议放 DSH 数据目录内，重装插件不丢）：

| 内容 | 路径 |
| --- | --- |
| GPT-SoVITS 源码 | `VOICE_ROOT\GPT-SoVITS-main\`（**api 必须以它为 cwd 启动**） |
| Python 环境 | `VOICE_ROOT\env\`（venv，3.10.x） |
| 基础模型 | `VOICE_ROOT\GPT-SoVITS-main\GPT_SoVITS\pretrained_models\` |
| 音色权重 | `VOICE_ROOT\weights\`（`.ckpt` + `.pth`） |
| 参考音频 | `VOICE_ROOT\ref\sakiko_ref.wav` |
| 桥（本包附带） | `VOICE_ROOT\bridge_tts.py` + `bridge.config.json` |
| 插件运行时配置 | `%DSH_HOME%\sakiko\config\sakiko.json` |

**路线 A · 零样本克隆（最省事）**：不下训练权重，只给参考音频。桥的 `bridge.config.json` 里
`voices` 留一个空对象即可，GPT-SoVITS api 用它启动时载入的基础模型 + 参考音频即时克隆。

**路线 B · 已训练权重（最像）**：`.ckpt` + `.pth` 放 `weights\`，在 `bridge.config.json` 里登记，
桥会在首次用到该音色时自动向 api 注册（api 重启后注册表会清空，这步必须做）。

**关键一步别漏 —— 补 NLTK 数据**：含拉丁字母的文本走英语 G2P，缺数据时它会联网下载并
**卡死约 2 分钟**（表现为「纯假名正常、含 `DSH`/`GPT` 的句子必失败」）。把
`cmudict.zip`、`averaged_perceptron_tagger.zip`（**必须是 zip 本身**，NLTK 3.10 还要 `_eng` 变体）
放进 `%USERPROFILE%\nltk_data\`，判据：

```powershell
& $py -c "import time;from g2p_en import G2p;t=time.time();g=G2p();print(g('DSH'),time.time()-t)"
# 应为 <5 秒；卡 90 秒以上就是没修好。补完必须重启 api
```

**插件配置**（`%DSH_HOME%\sakiko\config\sakiko.json`，**改之前先停 DSH** —— 运行时只读一次，
面板上任何改动都会把内存里那份整份回写，覆盖你的手工修改）：

```jsonc
"provider": "aqua",
"aquaUrl": "http://127.0.0.1:8000",        // 桥地址
"aquaVoice": "sakiko",                     // bridge.config.json 里的键名
"aquaRefAudio": "…\\ref\\sakiko_ref.wav",  // 服务端可读的绝对路径
"aquaPromptText": "<与参考音频逐字一致的日文>",
"aquaTextLanguage": "日文", "aquaPromptLanguage": "日文",
"aquaPreset": "fast",
"voiceStability": true                     // 失败宁可不发声，也别偷偷换成系统日语女声
```

面板**只暴露** provider / preset / 语速 / 音高；`aquaUrl`/`aquaVoice`/`aquaRefAudio`/`aquaPromptText`
没有 UI，只能手改 JSON。

**验证（关键判据）**：拿到的音频必须是 **32000Hz 的 RIFF/WAVE** —— Edge 回退给的是 MP3、
VOICEVOX 是 24kHz，32k WAV 才能排除「静默降级成系统日语女声」。同时要做**反例对照**：
参考音频路径故意写错必须返回 500，否则这个 200 没有鉴别力。

> 完整的分步命令、判据、故障速查见 [`skills/sakiko-voice-setup/SKILL.md`](./skills/sakiko-voice-setup/SKILL.md)。

## 六、主要功能

- **面板**：iPhone 直板风格浮窗，Live2D 立绘、表情与动作（表情由文本情绪驱动，
  另有标定模式可微调模型位置与缩放）
- **语音**：edge / aqua(GPT-SoVITS) / VOICEVOX / OpenAI-TTS 多通道，可重播
- **人格**：`persona/prompt.txt` 与 `persona/chat-persona.txt` 可自行修改
- **长期记忆**：对话要点本地落盘（`~/.dsh/sakiko/`）
- **多工作区播报**：多个会话共用一个祥子，按会话分别记录进度，串行排队播报
- **彩蛋**：偶尔会哼一段歌

## 七、目录结构

| 路径 | 说明 |
| --- | --- |
| `host.mjs` | 插件后端（Cordis 服务、HTTP 路由、配置与记忆） |
| `watchdog.mjs` | 退出看门狗：非优雅退出（关窗/强杀/崩溃）时回收插件拉起的语音服务（见「三」） |
| `index.js` | 静态版入口 |
| `client.js` `client.mjs` | Web 客户端注入（浮窗壳、设置区） |
| `cordis.patch.yml` | bundle 层补丁（安装即生效的关键） |
| `plugin/web/` | 面板前端（HTML/CSS/JS + vendor 运行时） |
| `assets/` | Live2D 模型、音频素材（铃声、哼唱彩蛋） |
| `persona/` | 人格提示词与人设卡 |
| `tools/` | 本地 Python 小工具（TTS 常驻进程、STT、LLM 直连、记忆落盘） |
| `skills/` | 语音安装 skill（给 agent 的操作手册 + 桥 + 体检脚本，见「四」） |
| `config/` | 清单文件（运行时配置在 `~/.dsh/sakiko/config/`） |

## 八、卸载

```bash
dsh plugin --profile web remove sakiko-for-dsh
```

运行时数据（配置、记忆、日志）在 `~/.dsh/sakiko/`，如需彻底清理请手动删除该目录。

---

## 九、版权与免责声明

1. **角色与作品版权**：《BanG Dream!》系列及角色「豊川祥子」的著作权、商标权及相关权利，
   归 © BanG Dream! Project / 株式会社ブシロード / Craft Egg Inc. 等权利方所有。
2. **本项目性质**：本项目是由爱好者制作的**非官方、非营利二次创作**，与上述权利方无任何隶属、
   赞助、授权或认可关系。项目名称、角色名称的使用仅用于说明与指代。
3. **上游项目**：本项目基于 [yyxcnasd/amadeus-for-dsh](https://github.com/yyxcnasd/amadeus-for-dsh)
   二次开发，上游著作权归其作者所有；上游的角色素材（《命运石之门》）权利归 MAGES./Nitroplus。
4. **使用限制**：仅供**个人学习、研究与技术交流**。**禁止任何形式的商业使用**
   （包括但不限于售卖、付费分发、植入广告、以本插件作为付费服务的一部分）。
5. **语音模型**：本项目的音色模型由公开动画音源训练而成，仅供个人试听与研究，**不随包分发**。
   若权利方对相关内容提出异议，将立即删除相关素材与模型。
6. **第三方组件与素材**：面板立绘（Live2D 模型）来自**网络公开的粉丝制作资源**，版权归原作者；
   pixi.js 等第三方组件为 MIT 许可。各第三方内容的版权、来源与许可详见
   [`THIRD-PARTY.md`](./THIRD-PARTY.md)。
7. **无担保**：本软件按「原样」提供，不附带任何明示或默示的担保。使用本插件所产生的一切后果
   由使用者自行承担。

## 十、许可

本项目的**自有代码**以 MIT 许可发布（见 [`LICENSE`](./LICENSE)，其中保留上游
`Copyright (c) 2025 yyxcnasd` 的版权声明）；第三方组件遵循其各自许可（见 `THIRD-PARTY.md`）。
角色形象、语音素材等**不适用** MIT 许可，其权利归原作者所有。
