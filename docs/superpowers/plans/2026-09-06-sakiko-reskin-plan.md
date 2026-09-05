# SAKIKO Reskin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development 或 executing-plans 按任务执行。并行轨道按文件隔离，同一文件不得双写。

**Goal:** 把 amadeus-for-dsh 插件就地改造为「CRYCHIC 时期白祥（丰川祥子）· SAKIKO」版本：iPhone 15 直板 UI + Sakiko Cubism2 Live2D + 白祥人格（台词全部出自动画考据）。

**Architecture:** 三层结构保持不变（host.mjs 宿主 / client 注册与主题 / plugin/web 面板）。视觉层重做 panel.html/css/js 的骨架与主题，模型层换 claudepet 的 Sakiko Cubism2 模型并重建情绪映射，内容层（persona + host 文案 + 台词槽）全部以《白祥台词考据表》为准。

**Tech Stack:** Cordis 插件 / host.mjs (ESM) / client.js (__ModuleLoader__ 打包) / 原生 DOM+CSS / PixiJS+Live2D Cubism2 / edge-tts 等（不变）。

**Spec:** `docs/superpowers/specs/2026-09-06-sakiko-reskin-design.md`

## Global Constraints

- **台词真实性**：任何台词/人设内容只能来自 Task 0 考据表（docs/sakiko-quotes.md）并标注槽位；未过用户确认不得写入。工程性内容（品牌名 SAKIKO/祥子、系统文案）除外。
- 路由前缀 `/amadeus/*`、RPC 名、postMessage 消息名、DOM id、localStorage key 全部保留（JS 逻辑兼容）。
- client.mjs 与 client.js 必须同步同一改动（client.js 是打包版）。
- 配色唯一来源（本计划 §调色板）；字体栈保留系统栈。
- 所有文本 UTF-8 无 BOM；换行风格跟随所在文件（js/mjs 为 LF，混用 CRLF 文件保持原状）。
- git：每 Task 一个 commit（或 Task 内逻辑小步多个 commit）；基线 d31cbcd 之上工作；删除文件前确认已入 git。
- 测试方式：无自动化测试基建 —— 采用「静态检查 + 用户重启后手工验收」（spec §5 验收单）；每个 Task 结束做一次 grep/结构自检。

## 调色板（唯一来源，所有文件统一取值）

深蓝×月白×金 —— panel/css 与 client token 共用语义：
- 机身/主背景：`#0b1224`；更深 `#070d1a`；机身边框高光 `rgba(143,179,255,.35)`
- 屏幕内渐变：`#101a33 → #0b1224`；模型区氛围光 `radial-gradient(#1d2f57,#0b1224)`
- 主文字/月白：`#eef2fb`；次级文字：`#a8b6d8`
- 品牌金：`#c9a86a`（描边/字标/点缀）；金弱 `rgba(201,168,106,.45)`
- 品牌蓝（气泡/按钮主色）：`#3b6fd4 → #1e3f8f`；蓝色文字 `#8fb3ff`
- 用户气泡：蓝渐变同上；AI 气泡：`rgba(238,242,251,.09)` + 白描边 `rgba(238,242,251,.25)`
- 接听：`#2f8f4e`；拒接：`#b53a2e`；错误：`#ff7b6b`；开机进度/终端：`#8fb3ff`/`#c9a86a`
- client 全局 token（键名同旧 AMADEUS_TOKENS 结构）：
  `--dsw-alias-bg-base:#0a1020; bg-layer-1:#0f1830; bg-layer-2:#141f3a; bg-overlay:#1a2747; border-l1:#26365c; border-l2:#3a4f7f; brand-primary:#8fb3ff; label-primary:#eef2fb; label-secondary:#a8b6d8; state-error:#ff7b6b; state-success:#7fd47f; state-warn:#e0a06a; specific-sidebar-fill:#080d1a`

---

## Task 0（门禁·进行中）: 白祥台词考据表

**Files:** 产出 `docs/sakiko-quotes.md`（考据表）

- [x] 派 2 个后台考据子代理（性格 / 台词原文）
- [ ] 子代理结果回收 → 汇总考据表（含出处/置信度/槽位建议）
- [ ] 用户确认（哪些台词进哪些槽位）
- **Gate：Task 7 及一切台词/人设写入必须在 Task 0 通过后执行。**

## Task 1: 数据目录搬迁 + 工作区基线

**Files:** 运行数据 `~/.dsh/amadeus`（不在 git 内）

- [ ] 确认插件目录 `git status` 干净
- [ ] `Rename-Item ~/.dsh/amadeus ~/.dsh/amadeus-kurisu-20260906`（如已存在同名则加序号）
- [ ] 确认新目录不存在（下次插件启动以空记忆/默认配置重建）
- [ ] 验证插件目录未被触碰（git status 仍干净）

## Task 2: Sakiko 模型资产导入 + manifest 指向 + 清理旧资产

**Files:**
- 导入: 源 `F:\claudepet\claudepet\public\models\Sakiko\{model.json, data\**}` → `assets/live2d/sakiko/`（保持 model.json+data/ 结构；model.json 内相对路径 data/... 不变）
- 删除: `assets/live2d/kurisu/`、`assets/img/kurisu/`、`assets/img/boot/`、`assets/img/amadeus-logo.webp`、`assets/audio/ringtone_gate_of_steiner.ogg`
- Modify: `config/manifest.json` —— models[0] 改为 `{"url":"/amadeus/assets/live2d/sakiko/model.json","format":"cubism2","scale":1,"layout":{"scale":1,"x":0,"y":0,"yRatio":0.62}}`，删除 kurisu 注释
- 保留: `assets/audio/ring.mp3`（铃声槽位，等待用户文件替换）

- [ ] 拷贝模型（PowerShell Copy-Item 保留字节；统计文件数与大小）
- [ ] 删除旧资产
- [ ] 改写 manifest.json（如上）
- [ ] grep 确认全包不再引用 `kurisu|assets/img/boot|amadeus-logo|gate_of_steiner`（git 历史除外）
- [ ] 自检：模型目录结构与 model.json 相对引用一致（model.json 引用 data/sakiko_casual-2023.moc、data/textures/texture_00/01.png）
- [ ] `git add -A && git commit -m "feat(assets): import Sakiko Cubism2 model, retarget manifest, drop Kurisu assets"`

## Task 3 [P·并行]: client 主题与品牌（client.mjs + client.js 双文件同步）

**Files:** Modify `client.mjs`、`client.js`

内容（两文件逐项同步）：
1. `AMADEUS_TOKENS` → `SAKIKO_TOKENS`（键不变、值用 §调色板 client 行）；applyTheme 层名 `amade-theme` → `sakiko-theme`
2. 侧栏按钮：label `Amadeus` → `SAKIKO`，窄按钮 `A` → `S`；title "打开 Amadeus 右侧栏" → "打开 SAKIKO 右侧栏"
3. iframe title `Amadeus Live2D` → `Sakiko Live2D`
4. 设置页文案：标题 `Amadeus` → `SAKIKO`；「语音朗读」desc "助手回复自动由 Amadeus 朗读" → 由 SAKIKO 朗读；「AI 聊天」desc 中 Amadeus → SAKIKO；「红莉栖人格注入」→「祥子人格注入」（desc: 让 Agent 以祥子口吻回答，作用于所有会话）；「Amadeus 全局主题」→「SAKIKO 全局主题」（desc 暗红→深蓝）；页脚版权行改为：`注意：右侧栏为 SAKIKO（丰川祥子）专用…… 角色版权归 Bushiroad/BanG Dream! 项目；Live2D 模型为粉丝制作，仅供个人学习。`
5. group 标题色 `#d98a7d` → `#c9a86a`（金）；其它散落硬编码辅助色 `#9a8f8b/#b49a93/#8d8380` → `#a8b6d8/#8fa0c4/#7688ad`
6. 测试语音默认句：rpcSay 的 `アマデウス、準備完了。` → `祥子、準備完了。`（机械品牌替换；正式就绪语待 Task 7 用考据台词换）
7. group("基本开关")下无其它角色词则不动

- [ ] 改 client.mjs（主源）
- [ ] 用同一改动同步 client.js（打包版，保持格式风格）
- [ ] 自检：两文件 diff 语义一致（分别 grep `SAKIKO|祥子|sakiko-theme|Amadeus|红莉栖|アマデウス`）
- [ ] commit `feat(client): Sakiko branding & deep-blue global theme`

## Task 4 [P·并行]: panel 骨架与视觉（panel.html + panel.css）

**Files:** Modify `plugin/web/panel.html`、`plugin/web/panel.css`

规则：**所有 DOM id 保留**；#hinge 删除（其元素在 html 中移除，css 中相关规则删除）；翻盖/键盘实体样式清除；新增直板结构仅用 CSS + 少量静态装饰 DOM。

1. `panel.html`：
   - `<html lang="zh-CN">` 保留；`<title>SAKIKO</title>`；boot-title `AMADEUS` → `SAKIKO`
   - 占位 SVG（L14-31）换成蓝发少女剪影（深蓝发 `#2b3a67`、月白裙/淡金点缀、蓝眼 `#4a6fa5`→ 用 `#8fb3ff`），保持 placeholder 语义
   - `#amadeus-img` alt/title → `Sakiko`；来电 img（#call-portrait）→ 移除 img 标签，来电改用模型（代码在 Task 5 处理；html 保留容器 `#call-portrait-wrap` 供 CSS/JS 复用或改为挂 canvas 用容器）
   - 状态条装饰：在 `#screen` 顶部插入静态 DOM：`.sb-left`（时钟容器已存在则仅 CSS）、`.sb-island`（灵动岛胶囊 div）、`.sb-right`（状态点 div）；新增三个 div，id 前缀 `sb-`（不与 JS 冲突）
   - 铃声 `<audio>` sources：删除 ogg 源，保留 `ring.mp3`（占位文件），并保留第二个 source 待用户文件
   - 文案槽（考据门禁）：L53 解锁、L60-64 来电姓名/接拒文案、L85 placeholder —— 姓名/机械词本轮改（SAKIKO/祥子），情绪化台词留 Task 7
2. `panel.css`：
   - 按 §调色板整体换色；删除 `#hinge`、`.hinge-l/.hinge-r`、翻盖开合/键盘实体键/拨号盘样式；`#phone` 为直板圆角机身（aspect 约 0.5，圆角 36px，金属深蓝边框+侧键用 ::before/::after 装饰）
   - `#screen` 占机身内屏（inset 8px，圆角 24px）：顶部分配状态条高度（约 36px），`.sb-island` 居中胶囊（黑 #000 18×6px 圆角），时钟/状态点两端
   - 布局分屏：模型区（`#amadeus-canvas/img/placeholder` 所在上区，占 55%）与聊天区（`#keypad` 视觉变为屏内底部面板：不再有键盘质感，`#history` 消息滚动 + `#chat-row` 圆角输入条）——通过给 #keypad 设置高度 45%、去掉机械键盘样式实现；若原布局是 flex 结构则保持 flex 改比例
   - 开机浮层：`.boot` 深蓝启动屏样式（bg 渐变+柔光），`.boot-logo` 改为隐藏 img 显示文本字标（新 span 或直接样式化 .boot-title 大字 SAKIKO 金色描边）；打字行/进度条按月白蓝配色；具体文字内容见 Task 5（panel.js 打字行数据）与 Task 7
   - 来电浮层：`.call-overlay` 全屏深蓝模糊（backdrop-filter blur）+ 金/月白按钮（接听/拒接圆钮）；姓名大字号
   - 聊天气泡：AI 气泡月白半透明圆角（16px，左对齐带首字母头像圆徽 .msg-avatar：新样式 圆形 金边深蓝底 白色 S），用户气泡蓝色渐变右对齐；时间戳小字
   - 字体栈保留；所有旧红色值（`#d63c2e/#a91f14/#6e130c/#e54838/#57100b/#200f13/#2a1419…`）清零（grep 核对）
- [ ] 改 html + css
- [ ] 自检：`grep -iE "d63c2e|a91f14|6e130c|57100b|e548|2a1419|hinge"` 无命中；所有 JS 引用的 id 仍存在
- [ ] commit `feat(panel-ui): iPhone-style shell, Sakiko palette (html/css)`

## Task 5 [P·并行·主笔]: panel.js + emotion.js 逻辑改造

**Files:** Modify `plugin/web/panel.js`、`plugin/web/emotion.js`、`config/manifest.json`(已 Task 2 改)

1. **开机动画去帧化**（L118-198 区）：boot 打字行数据（L119-123）改为：`SAKIKO SYSTEM` / `memory database ... connect OK` / `豊川祥子 - ready.`（机械词，正式版可按 Task 0 表微调）；logo 帧循环逻辑（L133/174/177 引用 logo1/logoN/logo39）删除，改为单帧静态字标（img#boot-logo-img 隐藏或 data-URI 空），保留 startBootAnimation→hideBootWhenReady 时序与 .boot 显示逻辑
2. **聊天头像**（L1469）：img src `assets/img/boot/logo39.png` → 移除图片引用，`.msg-avatar` 显示首字母 `S`（样式在 Task 4；JS 只去掉 src 或置空并给容器加类）
3. **解锁问候**（L429 `ふふっ、呼んだ？`）→ 占位留空字符串变量 + TODO 注释指向 Task 0 表（不写自编台词）
4. **来电改模型模式**（L436-495/startCall L448-461）：删除情绪→kurisu PNG 映射；来电时不再切 img，改为：隐藏 `#call-portrait-wrap` img（或整体隐藏该容器），确保 `#amadeus-canvas` 在来电时可见（原逻辑可能隐藏模型/切图——需读 L436-495 后按实际实现：来电 overlay 保持半透明（便于看到背后模型）且不隐藏 canvas；按下情绪 emotion 驱动表情（setExpression + 若动作存在则播对应动作，动作名映射见下）
5. **触摸动作映射**（playTap L1268 附近）：`flick_head` → `nod01`；`tap_body` → `kime01`（Sakiko model.json 内实际动作名：nod01/kime01/odoodo01/surprised01 等，先在 vendor/模型确认 motion 名存在再定）
6. **TAP_LINES 台词池**（L1253-1266）→ 内容留空数组 + TODO 指向 Task 0 表
7. **表情体系**：
   - emotion.js：EXPR 表（f01-f04）→ 情绪→Sakiko 表情名映射；保留 EXPR_TO_EMO 结构（值改新名）；C2_FACE 保留但值按 Sakiko 参数名修正（从 `assets/live2d/sakiko/data/expressions/*.exp.json` 的 params 清单取真实 id，如 PARAM_EYE_R_SMILE/PARAM_BROW_R_FORM/PARAM_MOUTH_FORM_01…，删除 shizuku 特有键如 CHEEK/EYE_SMILE 需先核对该模型是否有）；FACE(C4) 表保留结构（本模型 C2 用不到但保留兼容）；GESTURE 幅度按白祥微调（整体 +5~10%）
   - 情绪→表情名映射（候选，随考据微调）：happy→smile03、excited→smile05、elated→smile06、sad→sad01、angry→angry01、furious→angry07、question→thinking01、soft→smile01、blush→shame01、annoyed→sigh01、thinking→thinking02、surprised→surprised01、disappointed→sad02、eyes_closed→idle01、indifferent→serious01、side→kime01、winking→smile04、neutral→default
   - **实现方式验证**：读 `plugin/web/vendor/pld-cubism2.min.js` 与 live2d21 运行时，确认 C2 模型是否支持 `model.expression(name)`；支持→走该 API（顺带重写 panel.js setExpression 分支让 C2 也走 expression）；不支持→在 panel.js 中把映射表展开为参数驱动（读对应 exp.json 参数组）
8. **panel.js 内联 EXPR 回退**（L201-202）与 EMOTION_FACE（L1092-1111）同步新映射/参数
9. 语言轮换/时钟/poll/其它逻辑一律不动

- [ ] 读 pld-cubism2 源码确认 expression 支持度，决定实现路径
- [ ] 完成 1-8 改动
- [ ] 自检：grep `logo\d|kurisu|f01|f02|f03|f04|Makise|アマデウス` 面板相关无残留（git 历史除外）
- [ ] commit `feat(panel-js): Sakiko expression/motion mapping, frame-less boot, model-based call UI`

## Task 6 [P·并行]: host.mjs 机械/工程改动

**Files:** Modify `host.mjs`

仅工程性改动（台词/人格一律 Task 7）：
- 注释与日志品牌词（`[amadeus]` 前缀日志保留？→ 保留日志前缀不变以免与宿主日志习惯冲突；仅改用户可见文案）
- DEFAULT_CONFIG 不变；VOICES/RATES/EMOTIONS 不变
- 不需要动的先不动；本条如无工程改动则跳过（标记 no-op 提交可选）

- [ ] 复核 host.mjs 是否仅剩内容性改动 → 是则本任务标记 no-op，内容并入 Task 7

## Task 7（门禁）: persona 三件套 + host 文案常量 + 全部台词槽

**Files:** persona/prompt.txt、persona/chat-persona.txt、persona/kurisu.md（→ 新建 sakiko.md 并删除 kurisu.md 或移 docs/backup）、host.mjs 常量区、panel.js 台词槽（Task 5 留的 TODO）、client 文案槽

- 仅允许使用 Task 0 考据表已确认内容；每条标注来源行
- [ ] prompt.txt（中文人格：白祥，先结论后解释的助手式，禁止内容见 spec §4.2）
- [ ] chat-persona.txt（日文人设+考据台词范例，格式规则 JP/CN 保留）
- [ ] sakiko.md 人设卡（档案按考据填写；版权注：Bushiroad/BanG Dream! Project + 素材来源）
- [ ] host.mjs：DEFAULT_PERSONA/CHAT_PERSONA/CALL_SYSTEM/CALL_CANNED/IDLE_SYSTEM/播报台词/「紅莉栖」标签→「祥子」/repeat 兜底
- [ ] panel.js/client 台词槽填充
- [ ] grep 全包无 `Amadeus|红莉栖|kurisu|Makise|アマデウス|Gate of Steiner`（除 git 历史与 docs/backup 与协议前缀）
- [ ] commit `feat(persona): White Sakiko persona & quotes (canon-verified)`

## Task 8: 铃声接入（等用户文件）

- [ ] 用户提供音频 → 拷贝 `assets/audio/ring.mp3`（替换占位）；panel.html 已只留 ring.mp3 源
- [ ] commit

## Task 9: 交付与验收

- [ ] docs/aqua-voice-setup.md（克隆音色接入步骤）
- [ ] docs/rollback.md（git 回滚/恢复数据目录说明）
- [ ] 完整静态检查（§5 清单）
- [ ] 用户重启 DSH Web → 手工验收（spec §5）→ 修复闭环
