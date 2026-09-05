# SAKIKO Reskin — Amadeus 插件改造设计文档

> 日期：2026-09-06 · 状态：待用户复审
> 目标：把 DSH 的 amadeus-for-dsh 陪伴插件（牧濑红莉栖）就地改造为「丰川祥子」（BanG Dream! MyGO!!!!! / Ave Mujica）版本
> 流程：superpowers（brainstorming → writing-plans → 实施）；全程 git 管理

## 1. 背景与目标

- 插件现状：三层结构 —— host.mjs（宿主：TTS/聊天/记忆/来电/播报/路由）、client.js（DSH Web 侧栏注册 + 全局主题）、plugin/web/panel.*（翻盖手机 UI + Live2D）。
- 用户需求：界面与人格换成丰川祥子；形象使用 `F:\claudepet\claudepet\public\models\Sakiko\` 现成的 Cubism2 Live2D 模型（29 表情 / 60+ 动作 / 物理 / 双贴图）。
- 成功标准（验收）：
  1. DSH 重启后侧栏/右栏显示 SAKIKO 面板，无 Amadeus/红莉栖残留；
  2. Live2D 祥子模型加载、待机/说话/情绪表情/触摸反应正常；
  3. 聊天（JP 朗读 + CN 文字）、来电、空闲闲聊、完成播报全部按祥子人格发声；
  4. 记忆从零开始且持久化正常；
  5. git 历史完整，可回滚到基线 `d31cbcd`。

## 2. 已确认决策（与用户 grill 结论）

| 项 | 决定 |
|---|---|
| 角色 | 丰川祥子（BanG Dream!），**CRYCHIC 时期「白祥」**：阳光温暖、天然温柔、上品礼貌；体贴照顾为主，少量害羞/小别扭桥段增加真实感（被夸奖会脸红摆手等） |
| 存在方式 | **白祥本人**（CRYCHIC 时期的丰川祥子）：不设 AI/复制体解释包装，桌宠式自然在场，对话中不解释自己如何存在 |
| 称呼 | 祥子以明亮温柔的语气、中性礼貌地称呼用户（あなた/你）；不设固定亲密称谓 |
| 台词准确性 | 人设与台词**必须以动画考据为准**（CRYCHIC 时期的白祥）；经典台词使用**动画原文**（标注场景出处）；**禁止自行编造台词/人设**。实施前先产出《白祥台词考据表》交用户确认，确认后方可写入 persona 与台词池 |
| 界面名 | SAKIKO（罗马字品牌）；中文正文称「祥子」 |
| 语言 | 日文朗读 + 中文文字（host 格式约束 JP:/CN: 流水线不变） |
| 音色 | 默认 Edge `ja-JP-NanamiNeural`（温柔系）；**预留 aqua 克隆音色通道**（aquaUrl/aquaRefAudio/aquaPromptText 配置 + 接入文档），不改变默认 provider |
| UI | **iPhone 15 直板机骨架**（弃翻盖）；深蓝×月白×金配色；**上模型（约55%）下消息（45%）分屏**；iOS 风状态条+灵动岛装饰；CSS 开机动画（弃 39 帧 logo 序列） |
| 来电 | iOS 全屏来电样式；直接用 Live2D 模型显示（按情绪切表情），不依赖静态立绘 PNG |
| 头像/占位 | SAKIKO 首字母圆形徽标 + 蓝发少女 SVG 剪影占位 |
| 铃声 | 用户自供音频 → 固定槽位 `assets/audio/ring.mp3`（待用户提供文件/路径；旧 Gate of Steiner 文件删除） |
| 素材来源 | claudepet `public/models/Sakiko/`（Cubism2: model.json + data/**）；版权归 Bushiroad/BanG Dream! 项目，仅供个人学习，注明于 UI 脚注与人设卡 |
| 部署 | **就地改造**（路径/包名/路由前缀不变），改造前数据目录 `~/.dsh/amadeus` 移走搁置（祥子记忆从零开始） |
| 版本管理 | 插件目录 git 仓库：基线 `d31cbcd` 已提交；后续按逻辑提交；回滚 = git |

## 3. 现状事实清单（改动依据）

### 3.1 host.mjs（~1984 行）
- 常量区：DEFAULT_PERSONA / DEFAULT_CHAT_PERSONA（L132-134）、CHAT_FORMAT_RULES（L136，JP/CN+情绪标签格式，**保留**）、CALL_SYSTEM（L138）、CALL_CANNED（L140-144）、IDLE_SYSTEM（L146）、VOICES（L82，ja-JP 列表，保留）、EMOTIONS/EMOTION_EXPR（L85-86，f01-f04 表情 id —— 与新模型表情名体系需重映射）。
- 记忆标签写死「紅莉栖」（L1245/L1270 事实抽取与历史压缩提示词）；播报文案（L993 notifyComplete、L1923/1929-1930/1936/1943 事件播报）全部红莉栖口吻。
- 数据目录 DATA_DIR=`%DSH_HOME%/amadeus`（L32-36），配置/manifest/persona 路径常量（L37-47）。
- RPC 与路由（/amadeus/*）**保持前缀不变**。

### 3.2 client.js（~488 行，bundled；源为 client.mjs）
- AMADEUS_TOKENS 全局主题（L65-79，暗红系）→ 深蓝系；applyTheme 层名 `amade-theme`（L85）。
- 侧栏按钮 `Amadeus`/`A`（L456）、设置区标题/文案（L385-440：语音朗读/AI 聊天/主动来电/红莉栖人格注入/Amadeus 全局主题…）、版权脚注（L440）、VOICES 列表（L320-328，保留）。
- 测试按钮默认台词「アマデウス、準備完了。」（L415）。
- **同步双文件**：client.mjs 与 client.js 内容等价但格式不同（client.js 为 __ModuleLoader__ 打包版）。本目录无构建工具（tools/build_client.mjs 在上游仓库）。策略：以 client.mjs 为主编辑，随后把同改动手工同步到 client.js（或整段复制生成），保持二者一致。

### 3.3 plugin/web/panel.html（99 行）
- 结构：#phone > #screen(canvas#amadeus-canvas,img#amadeus-img,#amadeus-placeholder,#screen-clock,#close-btn,#calib-btn,#boot,#unlock,#call-overlay,#errline,#status-chip) + #hinge + #keypad(#history + #chat-row[#chat-mic,#chat-lang,#chat-input,#chat-send])。
- 文案热点：L6 title、L13 alt、L14-31 占位 SVG（红发女孩）、L42 boot-title、L48-49 Loading/版本、L53 解锁、L58-64 来电立绘/姓名/接拒（日文「着信中/応答/拒否」）、L85 placeholder、L91-94 铃声源（Gate of Steiner.ogg/ring.mp3）。
- **iPhone 直板改造**：保留全部元素 id（JS 零改动布局侧），删 #hinge；翻盖相关 CSS 类弃用；状态条/灵动岛装饰由 CSS 伪元素或新增少量静态 DOM 实现（放 #screen 顶部，用纯 CSS 装饰避免改 JS 逻辑）。

### 3.4 plugin/web/panel.js（~1929 行）
- 布局无关，全部 id 引用保留即可适配新布局；需改：
  - L119-123 开机打字三行（AMADEUS SYSTEM v1.048596 / memory database / Makise Kurisu - ready.）→ SAKIKO 化；
  - L133/174/177 logo1-39 帧引用 → CSS 启动屏（删除帧逻辑或改为单帧文字徽标动画）；L1469 聊天头像 logo39 → 字母徽标（CSS 圆徽/SVG data URI）；
  - L366-374 浏览器 TTS 兜底 ja-JP（保留）；
  - L429 解锁问候（ふふっ、呼んだ？）→ 祥子台词；
  - L448-461 情绪→立绘映射（kurisu PNG）→ **来电改显示模型**：来电浮层显示模型画布或放大模型截图不可行 → 方案：来电时不隐藏 canvas，改为在 model 上叠加来电 UI（模糊遮罩边缘 + 姓名 + 按钮）；删除 img 依赖；
  - L1253-1266 触摸台词池 TAP_LINES（日文 kurisu 风）→ 祥子台词；
  - L1540 空历史文案（中性，可微调）；
  - L1690 语言轮换（保留）。
- 表情：L201-202 EXPR 内联回退；L1092-1111 EMOTION_FACE（平滑混脸表，参数按 kurisu/shizuku 命名）→ 按 Sakiko 模型参数重写；EXPR f01-f04 → 祥子表情名体系（见 §4.3）。
- 动作：model.motion('flick_head'/'tap_body')（L1268 附近）→ 映射 nod01/或 surprise 动作。

### 3.5 emotion.js（105 行）
- EXPR（情绪→f01-f04）/ EXPR_TO_EMO / FACE（C4 参数）/ C2_FACE（C2 参数）/ GESTURE（幅度表）。
- C2_FACE 与 FACE 中的参数（PARAM_EYE_SMILE、CHEEK、MOUTH_FORM…）基于 kurisu/shizuku 骨架 → 按 Sakiko exp 文件实测参数重写；GESTURE 幅度表保留（泛用）。

### 3.6 CSS（panel.css，671 行）
- 外壳红渐变（L12-26/L392-609 v11 覆盖块）→ iPhone 直板深蓝机身；屏幕边框/背景/气泡/按钮/开机终端配色整组替换；字体栈保留。
- 需删：#hinge、翻盖姿态、键盘实体键外观；新增：灵动岛、状态条、圆角输入条、消息气泡新配色。

### 3.7 persona / config / assets
- persona/prompt.txt（中文注入人格）、chat-persona.txt（日文聊天人格+台词范例，114 行红莉栖规则）、kurisu.md（人设卡）→ sakiko 版本（新文件 sakiko.md，删除 kurisu.md 或保留作参考移入 docs/backup）。
- config/manifest.json：models[0] → /amadeus/assets/live2d/sakiko/model.json（cubism2；scale/layout 用校准功能预调一次后写回默认）。
- config/amadeus.json：默认配置（运行时以 ~/.dsh/amadeus/config/amadeus.json 为准；数据目录整体搬迁后插件默认值生效——voiceName 已是 Nanami，保留）。
- assets/live2d/kurisu → 删除（备份在 git 基线）；assets/img/kurisu → 删除；assets/img/boot/* → 删除；assets/audio/ringtone_gate_of_steiner.ogg → 删除；amadeus-logo.webp → 删除（宿主外层若引用需同步检查——已确认 panel 不引用，client 未引用，宿主未引用）。

## 4. 目标设计

### 4.1 视觉（iPhone 15 直板 · 深蓝×月白×金）
- 机身：圆角直板 #phone（约 宽390×高780 比例缩放），边框钛蓝金属感（渐变+高光描边），右侧电源键/左侧静音键装饰（CSS）。
- 屏幕区（机身内圆角屏）：顶部状态条（时钟·灵动岛胶囊·状态点）；Live2D 画布占上部 55%，底部 45% 为消息列表+输入条；消息气泡样式改 iOS 风格（对方=白/月白浅底，用户=蓝色渐变，圆角大）。
- 开机：深蓝启动屏——"SAKIKO" 字标（金描边）+ 打字行（SAKIKO SYSTEM / memory database … connect OK / 豊川祥子 - ready.）+ 深蓝进度条；纯 CSS+文字（保留 .boot 浮层与 hideBootWhenReady 逻辑，去掉 39 帧 img）。
- 来电：深蓝模糊全屏遮罩 + 模型直出（按情绪切表情/动作）+ "SAKIKO" 大字 + 月白接听/拒接圆钮（保留 #call-overlay 逻辑，重写视觉与内容）。
- 解锁：保留"点击启用语音"浮层，深蓝化。
- 全局 GUI 主题（client）：暗红令牌 → 深蓝令牌（bg #0a1220 系 / brand 金蓝 / 文字月白），层名 amade-theme → sakiko-theme。

### 4.2 人格与内容（host + persona）
> 本章全部文本内容以《白祥台词考据表》（§4.6）为唯一事实来源，未经考据确认的内容不得写入。
- persona/prompt.txt：祥子（CRYCHIC 时期・白祥）中文人格——以考据为准（月之森女子学园大小姐、钢琴/作曲、CRYCHIC 发起人与键盘手；性格阳光天然、温柔明亮、行动力强；关心人不留痕迹、上品但不摆架子；被夸奖会害羞否认，认真时坚定）；"白祥本人"、桌宠式自然在场、不解释存在方式；仍是全能助手口吻（先结论后解释，不写小作文）。
- persona/chat-persona.txt：日文人设 + 台词范例——**白祥经典台词用动画原文并标注场景**；日常语气以考据的性格特征写作（笑颜系、上品礼貌、天然冒失补救等）；禁止：黑祥式沉重/疏离、高高在上、过度卖萌、长篇念设定。
- host 常量：DEFAULT_PERSONA/CHAT_PERSONA/CALL_SYSTEM/CALL_CANNED（白祥式开场，用语与性格以考据为准）/IDLE_SYSTEM/notifyComplete 台词/事件播报/「紅莉栖」标签→「祥子」/空记忆就绪语（repeat 兜底 L1815）等全部替换；CHAT_FORMAT_RULES 结构保留。
- 版权脚注（client L440）与 sakiko.md 人设卡注明：BanG Dream! © Bushiroad / 动画 © BanG Dream! Project；Live2D 素材来源 claudepet 自定义改造，粉丝制作、仅供个人学习。

### 4.3 表情与动作映射（Sakiko 模型）
- 候选映射（实施时以模型实际表现为准微调）：
  happy/elated→smile02/03；excited→smile05；soft→smile01；blush→shame01/02；sad/disappointed→sad01/02；angry→angry01/02；furious→angry07；annoyed→sigh02/angry03；question/thinking→thinking01/02；surprised→surprised01/02；eyes_closed→idle01；cry(新情绪位：如 emotionFor 追加)→cry02；neutral→default。
- 优先级：a) 若 pixi-live2d-display C2 运行时支持 `model.expression(name)` → 走真表情文件；b) 否则将每个 exp.json 的参数清单转为静态 C2 参数驱动表（键名已从 exp 文件确认，如 PARAM_EYE_R_SMILE/PARAM_BROW_*_FORM/PARAM_MOUTH_FORM_01…），实现同等级表情。
- 触摸/点按动作：flick_head→nod01 或 surprised01 动作；tap_body→kime01/odoodo01；动作组名以 model.json motions 表为准（已在案：nod01/bye/kime/odoodo…）。
- panel.js 平滑混脸表 EMOTION_FACE、emotion.js C2_FACE 使用上面同一套参数 id；GESTURE 幅度表微调（**白祥系**：整体幅度略上调、微笑/害羞表情频率更高，说话动作更活泼明亮）。

### 4.4 语音
- 默认 provider=edge、voiceName=ja-JP-NanamiNeural（配置默认值不动）。
- 预留克隆音色：设置页已有 aqua 分组；交付文档（docs/aqua-voice-setup.md）写明：本地 Aqua-TTS/GPT-SoVITS（http://127.0.0.1:8000）→ 填 aquaVoice / aquaRefAudio（5-30s 干声 WAV/MP3 路径）+ aquaPromptText（音频日文文稿）→ 设 provider=aqua。UI 若允许也可直接把开关链到该组。

### 4.5 数据与部署
1. `~/.dsh/amadeus` → 改名 `~/.dsh/amadeus-kurisu-20260906`（保留原配置与记忆，插件会以默认配置/空记忆重建）。
2. 全部改动按逻辑提交 git；删除资产前先确认已入基线。
3. 完成后用户重启 DSH Web（restart-dsh.bat / `dsh web`）生效；本会话内不重启宿主。
4. 铃声：待用户提供音频文件/路径 → 拷贝为 `assets/audio/ring.mp3`（panel.html audio 源同步改，删除 ogg）。

### 4.6 白祥台词考据要求（不编造原则）
- **范围**：人设事实、经典台词、口癖、称呼习惯。CRYCHIC 时期白祥主要考据源：
  - TV 动画《BanG Dream! It's MyGO!!!!!》（2023）第 1-3 话（CRYCHIC 结成/练习/初演与解散回忆场景）
  - TV 动画《BanG Dream! Ave Mujica》（2025）中对 CRYCHIC 时期祥子的补充回忆
  - 官方角色资料（Bushiroad 官网 / 游戏《BanG Dream! 少女乐团派对!》角色介绍）——注意游戏与动画的时期差异
  - 考据辅助：萌娘百科、BanG Dream! 中文/日文 Wiki、Fandom 的词条与分集台词记录、字幕组翻译对照
- **交付物**：《白祥台词考据表》（docs/sakiko-quotes.md）每条含：日文原句（尽量含出处集数/场景）、中文翻译（参考官方/字幕组）、适用槽位（来电开场/空闲闲聊/完成播报/触摸反应/经典台词彩蛋等）、置信度（动画原文=高；二次整理=注明）。
- **红线**：查不到出处的内容不得当作"经典台词"写入；性格描写只写考据结论；存疑内容标记待确认并询问用户；不引用无授权全文搬运（只引用台词原句属合理引用）。

## 5. 测试与验收

- 静态检查：grep 全包确认无 `Amadeus|AMADEUS|红莉栖|kurisu|Makise|Gate of Steiner|アマデウス` 残留（docs/backup 与 git 历史除外；manifest/路径前缀 /amadeus/* 属协议保留）。
- 手工验收（重启后，用户在场）：
  1. 面板出现祥子模型；待机眨眼/呼吸正常；说话口型与情绪表情切换正确；
  2. 开机动画 SAKIKO 化；来电（设置里"测试来电"）→ 全屏来电+模型+接听出声；
  3. 聊天区发消息 → JP 语音（Nanami）+ CN 文字气泡；记忆文件生成于新数据目录；
  4. 完成播报/空闲闲聊各触发一次（可用 testCall/短 idleChatMs 验证）；
  5. GUI 全局主题深蓝、无暗红残留；侧栏按钮 SAKIKO；
  6. 设置页各开关/音色/节奏项仍工作。
- 回归注意：路由/RPC 前缀不改 → 旧 amadeus 与新的并存时会冲突，但数据搬迁后旧插件已无数据；如用户想保留旧插件并排运行需走独立包方案（已否决，文档记录备查）。

## 6. 实施顺序（writing-plans 会细化任务）

1. **台词考据调研**：产出《白祥台词考据表》→ 用户确认（未确认不进下一步人格写作）
2. 数据目录搬迁（~/.dsh/amadeus → 存档名）
3. 资产：拷入 Sakiko 模型 → assets/live2d/sakiko；删 kurisu/boot/kurisu 立绘/旧铃声（git 提交：assets）
4. persona 三件套重写（内容取自考据表）+ host 文案常量替换（提交：persona+host 内容）
5. manifest 指向 + 表情/动作映射（emotion.js、panel.js 表情区）（提交：model+emotion）
6. panel.html/css/js：iPhone 直板骨架 + 深蓝×月白×金换皮 + CSS 开机 + 来电改模型 + 徽标头像（提交：panel-ui）
7. client.js/mjs：主题令牌与全部文案（提交：client）
8. 铃声接入（等用户文件）
9. 静态检查 + 交付文档（aqua 接入说明、回滚说明）→ 用户重启验收

## 7. 备注与风险

- client.js 为打包产物：改 client.mjs 后需手工同步；遗漏会导致 GUI 层不生效（验收项 5 覆盖）。
- pixi-live2d-display C2 expression() 支持度未验证 → 方案 b 兜底已设计；实施时先快速验证（临时在 panel 中 console 测试或读 vendor 源码），决定表情实现路径。
- 白祥人设需防"单薄化"：台词池保留害羞脸红、被夸奖慌乱摆手、天然冒失后补救等小桥段，同时避免傻白甜化（她仍是聪明、有决断力的月之森大小姐）。
- 就地改造会被上游重装覆盖 → git 基线+提交可重建；若用户日后需要升级，可基于 git 补丁迁移（文档注明）。
