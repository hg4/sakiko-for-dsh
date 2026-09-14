---
name: sakiko-voice-setup
description: Use when installing, moving or repairing the sakiko-for-dsh voice stack (aqua / GPT-SoVITS channel) — the panel is silent or shows "aqua: empty audio", the bridge or api is not running, setting up on a new machine, or switching voice models/weights.
---

# SAKIKO 语音一键安装与配置

把插件（`provider=aqua`）接到本机 GPT-SoVITS 上，让她用「祥子」的音色说话：

```
DSH 插件 ──POST {aquaUrl}/tts/file?…──▶ 桥 bridge_tts.py :8000 ──▶ GPT-SoVITS api :9880 ──▶ 权重 + 参考音频
```

插件说的是 **Aqua 私有协议**（`/tts/file?text=…&voice=…&ref_audio_path=…`），GPT-SoVITS 自己的 api
在根路径用另一套参数名，两者不通用 —— 所以中间**必须有一个桥**。本 skill 附带写好并实测过的桥
（纯标准库、零依赖、配置驱动、会自动 `set_model`），不要自己另写。

## 开工前先读这三条（否则一定踩）

1. **改插件配置必须在 DSH 停止状态下改**。`%DSH_HOME%\sakiko\config\sakiko.json` 只在启动时读一次，
   之后面板上任何一次改动都会把内存里那份**整份回写**，覆盖掉你的手工修改。
2. **api 重启后音色注册表会清空**，必须重新发 `/set_model`，否则报错/空音频。本 skill 的桥会在首次
   用到某音色时自动补这一步（旧版手写桥不会，所以换音色必须重启 api）。
3. **含拉丁字母的文本走英语 G2P**：缺 NLTK 数据时它会联网下载并**卡死约 2 分钟**，表现为
   「纯假名正常、含 `DSH`/`GPT` 的句子必失败」。第 4 步必须先补数据。

## 资源清单（网盘）

| 资源 | 链接 | 说明 |
| --- | --- | --- |
| GPT-SoVITS 本体 | **〈待填：网盘链接 + 提取码〉** | 解压后应有 `api.py`（main 分支快照即可） |
| 祥子音色权重 | **〈待填：网盘链接 + 提取码〉** | **`.ckpt` 与 `.pth` 必须成对**，且版本与训练时一致 |
| 参考音频 | **插件包内已自带**（`assets/ref/`） | 7.6 秒 / 24 kHz 单声道干声 + 逐字日文文稿，配置留空即自动使用；想换音色再自备 |

**动手前必须向用户问清**（答案决定后面每一步）：
① 权重是哪个版本（v2 / v2Pro / v2ProPlus / v3 / v4）？v3/v4 才需要 BigVGAN 声码器与 `sample_steps`；
② 要不要换参考音频？**不换就用包内自带的那份**（`assets/ref/sakiko_ref.wav` + `sakiko_ref.prompt.txt`，
   文稿与音频逐字一致，已实测可用）；要换的话得同时给出**逐字文稿**（文稿与音频不一致会明显跑音）；
③ 目标机有没有 N 卡、驱动版本多少？没有就走 `-d cpu`（很慢）。本机实测：RTX 3060 12GB / driver 591.86，
   api 常驻约 3.5–5GB 显存，冷启峰值可到 9GB+。

## 落点（默认布局；换盘就把 `VOICE_ROOT` 整体替换）

```
VOICE_ROOT = %USERPROFILE%\.dsh\sakiko\voice      # 放 DSH 数据目录里，重装插件不丢
```

| 内容 | 路径 |
| --- | --- |
| GPT-SoVITS 源码 | `VOICE_ROOT\GPT-SoVITS-main\`（**api 必须以它为 cwd 启动**，模型路径都相对 cwd） |
| Python 环境 | `VOICE_ROOT\env\`（venv，3.10.x） |
| 基础模型 | `VOICE_ROOT\GPT-SoVITS-main\GPT_SoVITS\pretrained_models\` |
| 音色权重 | `VOICE_ROOT\weights\`（`.ckpt` + `.pth`） |
| 参考音频 | `VOICE_ROOT\ref\sakiko_ref.wav`（也可直接留空用**插件包内自带**的 `assets/ref/sakiko_ref.wav`） |
| 桥（本 skill 附带） | `VOICE_ROOT\bridge_tts.py` + `bridge.config.json` |
| 插件运行时配置 | `%DSH_HOME%\sakiko\config\sakiko.json` |

## 更省事：让插件自己拉起服务（第 6/7 步可跳过）

插件内置了「语音服务自管理」：只要在 `%DSH_HOME%\sakiko\config\sakiko.json` 里配好
（**改配置前先停 DSH**），`dsh web` 一启动就会自动探测并拉起 api 与桥，连 `/set_model` 都替你做了：

```jsonc
"voiceAutoStart":    true,                 // 默认开
"voiceRoot":         "D:\\sakiko-voice",   // 前面的 VOICE_ROOT
"voiceDevice":       "cuda",
"voiceGptWeights":   "D:\\...\\x.ckpt",    // 留空 = 零样本克隆
"voiceSovitsWeights":"D:\\...\\x.pth",
"voiceApiPort":      9880,
"voiceBridgePort":   8000
```

- 端口已在监听 → 判定为「外部服务」，插件只读状态、不接管、也不会停它。
- 插件拉起的服务**随 DSH 退出一起结束**（不留后台孤儿）；插件卸载延时 8 秒才停，热重载会取消。
- 查状态：`curl.exe -sS http://127.0.0.1:3080/sakiko/voice`；手动启停：`?action=start` / `?action=stop`。

**注意**：`voiceAutoStart` 只在插件加载时触发一次。若你刚改完配置，重启 DSH 或调一次
`?action=start` 让它生效。

## 步骤（判据不成立就别往下走）

**1. 建 Python 环境**（3.10.x；**先装 torch 再装 requirements**，否则会装成 CPU 版）
```powershell
py -3.10 -m venv "$env:USERPROFILE\.dsh\sakiko\voice\env"
$py = "$env:USERPROFILE\.dsh\sakiko\voice\env\Scripts\python.exe"
& $py -m pip install -U pip
& $py -m pip install torch==2.5.1 torchaudio==2.5.1 --index-url https://mirrors.nju.edu.cn/pytorch/whl/cu121/
# requirements.txt 第 1 行 --no-binary=opencc 在 Windows 上编不过：删掉它，改装 opencc-python-reimplemented
& $py -m pip install -r "<repo>\requirements.txt" opencc-python-reimplemented -i https://pypi.tuna.tsinghua.edu.cn/simple
& $py -m pip install "transformers==4.51.3" "numpy==1.26.4"
```
判据：`& $py -c "import torch,transformers;print(torch.__version__,torch.cuda.is_available(),transformers.__version__)"`
→ `2.5.1+cu121 True 4.51.3`。**transformers ≥4.57 会强制 torch≥2.6，必须钉住 4.51.3。**

**2. 下基础模型**（v2ProPlus 推理必需四件；缺任一项启动或推理就失败）
`chinese-hubert-base`(188MB)、`chinese-roberta-wwm-ext-large`(651MB)、
`sv\pretrained_eres2netv2w24s4ep4.ckpt`(107MB)、`fast_langdetect\lid.176.ftz`(0.9MB)
→ 放进 `GPT_SoVITS\pretrained_models\` 对应子目录。国内走 **modelscope**（HF 不通）。
判据：四个路径都存在且非 0 字节。（BigVGAN 只有 v3 用得到，v2ProPlus 不必下。）

**3. 放权重与参考音频**：`.ckpt` + `.pth` 放 `weights\`。参考音频**可以不放**——
插件包内已自带一份可用的（`<插件目录>\assets\ref\sakiko_ref.wav` + 逐字文稿 `sakiko_ref.prompt.txt`），
配置里 `aquaRefAudio` / `aquaPromptText` 留空时插件会自动用它（日志会写一行「未配置 aquaRefAudio ⇒ 使用包内参考音频」）。
要换成自己的素材就放进 `ref\` 并把绝对路径填进配置，同时**必须**填与之一致的逐字文稿。

**4. 补 NLTK 数据（★ 最容易漏）** —— 放进 `%USERPROFILE%\nltk_data\`：
```
corpora\cmudict.zip        和  corpora\cmudict\
taggers\averaged_perceptron_tagger.zip      （NLTK 3.10 还要 _eng 变体）
taggers\averaged_perceptron_tagger_eng.zip
```
**必须是 `.zip` 文件本身**（`english.py` 找的是 zip，不是解压目录）。
判据（免重启）：`& $py -c "import time;from g2p_en import G2p;t=time.time();g=G2p();print(g('DSH'),time.time()-t)"`
→ **<5 秒**且不打印 `[nltk_data] Error loading`；卡 90 秒以上就是没修好。**改完必须重启 api。**

**5. 配桥**：把本 skill 的 `bridge_tts.py` 复制到 `VOICE_ROOT\`，同目录复制一份
`bridge.config.example.json` 改名 `bridge.config.json`，填 `gpt_api` / `bridge_port` / 各音色的
`gpt`+`sovits` 绝对路径。（没有训练权重也能用：`voices` 里只留一个空对象 = 零样本克隆。）

**6. 起 api**（cwd 必须是 repo 根，端口被占就换 9880 → 记得同步改桥的 `gpt_api`）
```powershell
cd "<repo>"
& $py -u api.py -a 127.0.0.1 -p 9880 -d cuda -g "<weights>\x.ckpt" -s "<weights>\x.pth"
```
判据：9880 在监听，且日志出现 `模型版本: v2ProPlus`。（`-u` 保证日志实时；不加会长时间 0 字节。）

**7. 起桥**：`& $py -u "<VOICE_ROOT>\bridge_tts.py"`（用**任意** python 都行，桥不依赖 GPT-SoVITS 环境）
判据：`curl -sS http://127.0.0.1:8000/health` → `{"ok":true,"api":true,…}`

**8. 写插件配置**（**先停 DSH**）——`%DSH_HOME%\sakiko\config\sakiko.json`：
```jsonc
"provider": "aqua",
"aquaUrl": "http://127.0.0.1:8000",        // 桥地址
"aquaVoice": "sakiko",                     // bridge.config.json 里的键名
"aquaRefAudio": "",                        // 留空 = 用插件包内自带的 assets/ref/sakiko_ref.wav
"aquaPromptText": "",                      // 留空 = 用包内自带的 sakiko_ref.prompt.txt
// 要换素材才填这两项：服务端可读的绝对路径 + 与它逐字一致的日文文稿
"aquaTextLanguage": "日文", "aquaPromptLanguage": "日文",
"aquaPreset": "fast",
"voiceStability": true                     // 失败宁可不发声，也别偷偷换成 Windows 日语女声
```
面板**只暴露** provider / preset / 语速 / 音高，`aquaUrl/aquaVoice/aquaRefAudio/aquaPromptText` 没有 UI，
只能手改 JSON。

**9. 体检 + 端到端验证**：先 `python preflight.py --voice-root "<VOICE_ROOT>"`（退出码 0 才继续），
再照下面的验证阶梯做。

## 验证阶梯（L1/L2 不算通过）

| 层 | 做什么 | 判据 |
| --- | --- | --- |
| L1 | 端口在听 | **不算通过** |
| L2 | 环境自检（torch/cuda/transformers/g2p 计时） | **不算通过** |
| L3 | `curl :8000/health` | `ok=true` |
| L4 | **真合成**（用**含拉丁字母**的日文句，历史故障就是这类句子） | 200 + RIFF/WAVE + **32000Hz** + 时长与字数成比例 + 耗时 <35s |
| L5 | **反例对照**：参考音频路径写错必须 500；缺 `text` 必须 400 | 拿不到 500 就说明 L4 的 200 没有鉴别力 |
| L6 | 插件级 `curl "http://127.0.0.1:3080/sakiko/tts?text=…"` + 人耳试听 | 200 `audio/wav`；与参考音频 A/B 比音色 |

**32000Hz 是关键判据**：Edge 回退给的是 MP3、VOICEVOX 是 24kHz —— 拿到 32k WAV 才能排除
「浏览器偷偷降级成 Windows 日语女声」这类静默失败。

```powershell
# L4/L5 一条命令（把 <…> 换成实际值）
$e=[uri]::EscapeDataString
$u="http://127.0.0.1:8000/tts/file?text=$($e.Invoke('DSHのプラグイン、テスト中ですわ。'))&voice=sakiko&ref_audio_path=$($e.Invoke('<ref wav>'))&prompt_text=$($e.Invoke('<逐字文稿>'))&text_language=$($e.Invoke('日文'))&prompt_language=$($e.Invoke('日文'))&preset=fast"
curl.exe -sS -m 60 -X POST $u -o "$env:TEMP\v.wav" -w "code=%{http_code} bytes=%{size_download} t=%{time_total}`n"
```

## 故障速查

| 现象 | 根因 | 修法 |
| --- | --- | --- |
| 纯假名正常，含英文/拉丁词的句子必失败或卡 2 分钟 | 缺 NLTK 数据 | 第 4 步；补完**重启 api** |
| `aqua: empty audio` / 500 `IncompleteRead` | api 没起、权重没注册、或参考音频路径错 | 看 api 的 stderr（桥的 500 body 里带 api 原始错误）；重发 `/set_model` |
| 换音色没反应 | 旧版桥把权重路径解包后没用、真正载入的是 api 启动时那对权重 | 用本 skill 的桥（会自动 set_model），或重启 api 换 `-g/-s` |
| 明明改了配置却不生效 | DSH 运行时只读一次 + 面板整份回写覆盖 | 停 DSH 再改 |
| 端口 8000 被别的程序占了 | 8000 是常见端口 | 桥设 `BRIDGE_PORT`，插件 `aquaUrl` 同步改 |
| 合成很慢 / 显存不够 | 没走 CUDA，或与别的 GPU 任务抢卡 | 确认 `-d cuda` 与 `torch.cuda.is_available()`；错开重负载 |
| 音色不像/时好时坏 | 参考音频有 BGM/噪音，或文稿与音频不一致 | 换 5~30s 干声；文稿逐字对齐；开 `voiceStability` |

## 本 skill 的文件

| 文件 | 用途 |
| --- | --- |
| `bridge_tts.py` | 已实测的桥（配置驱动、自动 `set_model`、把 api 的原始错误带进 500 body） |
| `bridge.config.example.json` | 桥的配置模板 |
| `preflight.py` | 一键体检：环境/依赖/GPU/NLTK/基础模型/权重/参考音频/端口/服务/插件配置；`--json` 给 agent 用，退出码 0=关键项全过 |
