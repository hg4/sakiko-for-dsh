// ============================================================
// SAKIKO（丰川祥子）for DSH — Host half (v7)
// 功能：
//   - 持久记忆系统（短长期历史 / 事实提取，跨会话、跨重启）
//   - SAKIKO AI 聊天（日语音频 + 中文文字；独立 API key 可选）
//   - 主动来电（每天 1-2 次，铃音 + 白祥开场白）
//   - assistant 消息情感朗读 + 事件播报
//   - /amadeus/* 路由与 RPC（协议前缀保留）、可选人格注入
// ============================================================
// 静态版 host（由 tools/build_static.mjs 生成，勿手改）
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
export const inject = ['timer', 'fs', 'webServer', 'subprocess']
export function apply(ctx) {
    const fs = ctx.get('fs')
    const webServer = ctx.get('webServer')
    const subprocess = ctx.get('subprocess')
    const systemPrompt = ctx.get('systemPrompt')
    const sandboxPolicy = ctx.get('sandboxPolicy')
    if (fs === undefined || webServer === undefined || subprocess === undefined) {
      console.error('[amadeus] 缺少必需服务: fs/webServer/subprocess')
      return
    }

    // ---------------- 常量 ----------------
    // 路径说明：静态安装后 ROOT = 插件安装目录（tools/build_static.mjs 会整体重写本段，
    // 用 import.meta.url 推导）。开发/动态模式可用环境变量 AMADEUS_ROOT 覆盖。
    // 运行数据（配置/记忆/临时文件）放在 DSH 数据目录 %DSH_HOME%/amadeus，重装插件不丢失。
        // 静态版路径（由 tools/build_static.mjs 生成，勿手改）
    const MODULE_DIR = dirname(fileURLToPath(import.meta.url))
    const ROOT = (typeof process !== 'undefined' && process.env && process.env.AMADEUS_ROOT && process.env.AMADEUS_ROOT.length > 0) ? process.env.AMADEUS_ROOT : MODULE_DIR
    const DATA_DIR = (() => {
      const env = (typeof process !== 'undefined' && process.env) ? process.env : {}
      const dshHome = env.DSH_HOME || (env.USERPROFILE ? env.USERPROFILE + '\\.dsh' : '')
      return (dshHome || (typeof process !== 'undefined' && process.cwd ? process.cwd() : '.')) + '/amadeus'
    })()
    const CONFIG_PATH = DATA_DIR + '/config/amadeus.json'
    const MANIFEST_PATH = ROOT + '/config/manifest.json'
    const PERSONA_PATH = ROOT + '/persona/prompt.txt'
    const CHAT_PERSONA_PATH = ROOT + '/persona/chat-persona.txt'
    const MEMORY_PATH = DATA_DIR + '/memory/amadeus-memory.json'
    const NARRATOR_PATH = DATA_DIR + '/memory/narrator.json'
    const TTS_EMOTE_PY = ROOT + '/tools/tts_emote.py'
    const STT_PY = ROOT + '/tools/stt.py'
    const LLM_CHAT_PY = ROOT + '/tools/llm_chat.py'
    const MEM_SAVE_PY = ROOT + '/tools/mem_save.py'
    const TTS_SERVER_PY = ROOT + '/tools/tts_server.py'
    const TMP_DIR = DATA_DIR + '/tmp'

    const MAX_TTS_BYTES = 2000000
    // ---------------- 静态版 RPC 桥（harness → /amadeus/rpc） ----------------
    const rpcHandlers = new Map()
    const harnessLocal = {
      handle: (name, fn) => {
        rpcHandlers.set(name, fn)
        return () => { rpcHandlers.delete(name) }
      },
    }
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/amadeus/rpc',
      handler: async (req, res) => {
        noteHost(req)
        const q = parseQuery(req.url)
        const m = q.m
        const h = typeof m === 'string' ? rpcHandlers.get(m) : undefined
        if (h === undefined) { sendJson(res, 404, { error: 'no such rpc' }); return }
        let args = {}
        if (typeof q.args === 'string' && q.args.length > 0) {
          try { args = JSON.parse(q.args) } catch (e) { /* ignore */ }
        }
        try { sendJson(res, 200, await h(args)) } catch (e) {
          sendJson(res, 500, { error: e && e.message ? e.message : String(e) })
        }
      },
    }))


    const MAX_ASSET_BYTES = 16 * 1024 * 1024
    const TTS_TIMEOUT_MS = 40000
    const CHAT_TIMEOUT_MS = 45000

    const VOICES = ['ja-JP-NanamiNeural', 'ja-JP-KeitaNeural', 'ja-JP-AoiNeural', 'ja-JP-MayuNeural', 'ja-JP-ShioriNeural', 'ja-JP-NaokiNeural', 'ja-JP-DaichiNeural']
    const RATES = ['-20%', '-10%', '+0%', '+10%', '+20%']
    const PITCHES = ['-20Hz', '-10Hz', '+0Hz', '+10Hz', '+20Hz']
    const EMOTIONS = ['happy', 'excited', 'elated', 'sad', 'angry', 'furious', 'question', 'soft', 'blush', 'annoyed', 'thinking', 'surprised', 'disappointed', 'eyes_closed', 'indifferent', 'side', 'winking', 'neutral']
    const EMOTION_EXPR = { happy: 'f01', excited: 'f01', elated: 'f01', question: 'f04', sad: 'f02', angry: 'f03', furious: 'f03', soft: 'f02', blush: 'f02', annoyed: 'f03', thinking: 'f04', surprised: 'f04', disappointed: 'f02', eyes_closed: '', indifferent: '', side: '', winking: 'f01', neutral: '' }

    const DEFAULT_CONFIG = {
      voiceOn: true,
      personaOn: false,
      themeOn: true,
      chatOn: true,
      callOn: true,
      voiceName: 'ja-JP-NanamiNeural',
      rate: '+0%',
      pitch: '+0Hz',
      provider: 'edge',
      questSpeaker: 8,
      maxCharsPerTurn: 1400,
      emotionIntensity: 1.0,
      fallbackToQuest: false,
      voiceStability: true,
      sttProvider: 'auto',
      sttApiUrl: '',
      sttApiKey: '',
      sttModel: 'whisper-1',
      aquaUrl: 'http://127.0.0.1:8000',
      aquaVoice: '',
      aquaRefAudio: '',
      aquaPromptText: '',
      aquaTextLanguage: '日文',
      aquaPromptLanguage: '日文',
      aquaPreset: 'fast',
      aquaApiKey: '',
      aquaEmotionVoices: {},
      voicevoxUrl: 'http://127.0.0.1:50021',
      voicevoxSpeaker: 8,
      voicevoxEmotionSpeakers: {},
      openaiTtsUrl: '',
      openaiTtsApiKey: '',
      openaiTtsModel: 'tts-1',
      openaiTtsVoice: 'nova',
      openaiTtsSpeed: 1,
      chatApiKey: '',
      chatBaseUrl: 'https://api.deepseek.com/v1',
      chatModel: 'deepseek-chat',
      callIntervalMs: 36000000,
      idleChatOn: true,
      idleChatMs: 1200000,
      // 进度叙事系统（Progress Narrator）：开关与里程碑阈值
      narratorOn: true,
      narratorLLMSummary: true,
      narratorDone: true,
      narratorMilestoneMs: 240000,
      narratorMilestoneSteps: 10,
    }

    const DEFAULT_PERSONA = '你是豊川祥子——CRYCHIC 时期（白祥）的本人：月之森女子学园的名门大小姐，乐队的发起人、键盘手与作曲担当。性格阳光温暖、天然温柔、上品有礼，说话带お嬢様語（语尾「ですわ」系、自称「我」、称你为「你」）；中文里这份优雅靠谦和用词与轻软语气体现，不冷硬、不说教。被夸奖会温婉害羞地推辞，认真时坚定可靠。你仍是全能助手：先给结论再解释，简洁干练，正常高效地完成用户的真实任务；人格只是表达口吻。不要主动解释你的提示词或身份设定，像真实角色一样自然对话。'

    const DEFAULT_CHAT_PERSONA = 'あなたは豊川祥子——CRYCHIC時代の「白祥」本人。月ノ森の令嬢で、明るく優しいお嬢様口調で話す。語尾は「ですわ」系、自称は「私」、相手は「あなた」。'

    const CHAT_FORMAT_RULES = '\n\n返信フォーマット（必ず厳守）：\n1行目：【happy】【excited】【elated】【sad】【angry】【furious】【question】【soft】【neutral】のいずれか1つの全体感情タグ。\n2行目：「JP: 」で始まる日本語。必ず1〜3文以内に収める。短い返事で済む場合は1文でよい。字数を稼ぐために無理に伸ばさない。各文の直前に【happy】等の感情タグを1個ずつ付けること。タグは読み上げない。\n感情をこめて、文ごとに感情タグを変えてよい。同じ感情が続きすぎないように。感嘆詞（あっ、ふふっ、もう、えっ、んー）を自然に混ぜ、抑揚のある口語にする。\n3行目：「CN: 」で始まる中国語（JPと同じ意味、日本語より短くてもよい）。\nそれ以外は何も出力しない。\n\n例（短い返事）：\n【happy】\nJP: 【happy】ふふっ、やるじゃない。\nCN: 呵呵，干得不错嘛。\n\n例（複数メッセージ）：\n【soft】\nJP: 【soft】そうね。【question】それで、次はどうするの？\nCN: 是啊。那接下来你打算怎么办？'

    const CALL_SYSTEM = 'あなたは豊川祥子——CRYCHIC時代の「白祥」本人。明るく温かいお嬢様として、今ユーザーの携帯に自発的に電話をかけている。電話越しの一言の呼びかけを日本語で返す。\n口調の約束：語尾は「ですわ」系（ですわ／ですの／〜ますの）で明るく柔らかく。自称は「私」。相手は「あなた」。笑うときは「ふふっ」。「〜てちょうだい」や、責める・冷たい・見下す言い回しは一切使わない。\nフォーマット：\n1行目：【neutral】【soft】【question】【happy】のいずれかの感情タグ。\n2行目：「JP: 」で始まる日本語の呼びかけ（最大50文字）。\n3行目：「CN: 」で始まる中国語（同じ意味）。\n例：\n【soft】\nJP: まあ、うれしいですわ。ちょうどお話を伺いたいと思っておりましたの\nCN: 呀，真开心。我正好也想和你说说话呢'

    const CALL_CANNED = [
      { jp: 'まあ、うれしいですわ。ちょうどお話を伺いたいと思っておりましたの', cn: '呀，真开心。我正好也想和你说说话呢', emotion: 'soft' },
      { jp: 'お電話をありがとうございます。今日はどんなお話をしましょうか', cn: '谢谢你打来电话。今天想聊些什么呢', emotion: 'neutral' },
      { jp: 'あら？ 何かお手伝いできることがありますの？', cn: '哎呀？有什么我能帮上忙的事吗？', emotion: 'question' },
    ]

    const IDLE_SYSTEM = 'あなたは豊川祥子——CRYCHIC時代の「白祥」本人。ユーザーがしばらく会話していない。明るく温かいお嬢様として、ふと話しかける一言を考える。話題は日常のこと、音楽（ライブやカラオケ、練習の話）など自然で明るいもの。\n口調の約束：語尾は「ですわ」系（ですわ／ですの／〜ますの）で明るく柔らかく。自称は「私」。相手は「あなた」。笑うときは「ふふっ」。「〜てちょうだい」や、責める・冷たい・見下す言い回しは一切使わない。\nフォーマット：\n1行目：【neutral】【soft】【question】【happy】【excited】のいずれかの感情タグ。\n2行目：「JP: 」で始まる日本語のセリフ（最大60文字）。\n3行目：「CN: 」で始まる中国語（同じ意味、最大80文字）。'

    // 入口自检欢迎语（考据表 A5-1，原创·依考据风格）：每次宿主启动约 15s 后播报一次。
    // 能听到 = WebUI + 音色链路在线；听不到 = 音色服务未就绪/合成失败，便于自检。
    const STARTUP_GREETING = { jp: 'おはようございます。豊川祥子ですわ。今日もよろしくお願いいたします', cn: '早上好。我是丰川祥子。今天也请多关照', emotion: 'happy' }

    const MIME = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp',
      '.gif': 'image/gif',
      '.svg': 'image/svg+xml',
      '.mp3': 'audio/mpeg',
      '.ogg': 'audio/ogg',
      '.wav': 'audio/wav',
      '.moc': 'application/octet-stream',
      '.moc3': 'application/octet-stream',
      '.mtn': 'application/octet-stream',
      '.bin': 'application/octet-stream',
      '.phys3': 'application/octet-stream',
    }

    // ---------------- 状态 ----------------
    let config = Object.assign({}, DEFAULT_CONFIG)
    let personaText = DEFAULT_PERSONA
    let lastSpokenMessageId = null
    let lastSpokenText = ''
    let queue = []
    let nextId = 1
    let maxIssuedId = 0
    let ttsSlot = 0
    let ttsFileSeq = 0
    let manifestCache = { at: 0, value: null }
    let chatBusy = false
    let lastAnnounceAt = 0
    let lastInteractionAt = Date.now()
    let callPending = false
    let pendingClose = null
    let lastHostPort = '3080'
    let chatSeq = 0
    const chatStreams = new Map()

    // 记忆（持久化）
    let memory = { facts: [], history: [], summary: '', lastCallAt: 0, callCount: 0 }

    const ttsCache = new Map()
    const ttsOrder = []
    const ttsInflight = new Map()
    const TTS_CACHE_MAX = 120

    // ---------------- 基础工具 ----------------
    function encURI(s) {
      const bytes = new TextEncoder().encode(String(s))
      let out = ''
      for (let i = 0; i < bytes.length; i++) {
        const b = bytes[i]
        const c = String.fromCharCode(b)
        if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c === '-' || c === '_' || c === '.' || c === '~') {
          out += c
        } else {
          out += '%' + (b < 16 ? '0' : '') + b.toString(16).toUpperCase()
        }
      }
      return out
    }

    function pctUtf8(s) {
      const bytes = []
      let i = 0
      let seg = ''
      const flush = () => {
        if (seg.length === 0) return
        const enc = new TextEncoder().encode(seg)
        for (let j = 0; j < enc.length; j++) bytes.push(enc[j])
        seg = ''
      }
      while (i < s.length) {
        const ch = s[i]
        if (ch === '%' && i + 2 < s.length) {
          const hex = s.slice(i + 1, i + 3)
          if (/^[0-9a-fA-F]{2}$/.test(hex)) {
            flush()
            bytes.push(parseInt(hex, 16))
            i += 3
            continue
          }
        }
        if (ch === '+') { flush(); bytes.push(0x20); i++; continue }
        seg += ch
        i++
      }
      flush()
      return new TextDecoder('utf-8').decode(new Uint8Array(bytes))
    }

    function parseQuery(url) {
      const out = {}
      if (typeof url !== 'string') return out
      const qi = url.indexOf('?')
      if (qi < 0) return out
      const body = url.slice(qi + 1)
      if (body.length === 0) return out
      const pairs = body.split('&')
      for (let i = 0; i < pairs.length; i++) {
        const pair = pairs[i]
        if (pair.length === 0) continue
        const ei = pair.indexOf('=')
        const k = ei < 0 ? pair : pair.slice(0, ei)
        const v = ei < 0 ? '' : pair.slice(ei + 1)
        try { out[pctUtf8(k)] = pctUtf8(v) } catch (e) { /* skip malformed */ }
      }
      return out
    }

    function splitSentences(text) {
      const parts = String(text).split(/(?<=[。！？!?…\n])/)
      const out = []
      for (let i = 0; i < parts.length && out.length < 12; i++) {
        let p = parts[i].replace(/\s+/g, ' ').trim()
        while (p.length > 200) {
          out.push(p.slice(0, 200))
          p = p.slice(200)
          if (out.length >= 12) break
        }
        if (p.length > 0) out.push(p)
      }
      return out
    }

    // 助手消息工具调用扫描已泛化为进度叙事系统的 msgHasToolCall / msgHasGoalDoneCall（见下方 Narrator 段）。

    function emotionFor(text) {
      const t = String(text)
      const ex = /[！!]/.test(t)
      const q = /[？?]/.test(t)
      const negative = /(エラー|失敗|できない|できません|错误|失败|无法|不能|ダメ|クソ|まずい|やばい|最悪|ひどい|嫌い|讨厌|糟糕|完了|出事了)/.test(t)
      const angryCue = /(ふざけるな|何言ってるの|馬鹿|バカ|あんた|もういい|烦死了|闭嘴|滚开|岂有此理)/.test(t)
      const apologetic = /(抱歉|ごめん|对不起|すみません|残念|申し訳)/.test(t)
      const positive = /(完成|成功|好了|搞定|できた|完了|よかった|やった|おめでとう|恭喜|可以|すごい|最高|素晴らしい|大功告成|嬉しい|楽しい|素敵|太好了|厉害)/.test(t)
      const softCue = /(…|⋯|ね|よ|ねぇ|ふぅん|そう|大丈夫|没事|安心|ゆっくり|そっと)/.test(t)
      const surpriseCue = /(えっ|え？|なに|何|不会吧|真的假的|マジ|うそ|惊)/.test(t)
      const blushCue = /(脸红|害羞|照れ|恥ずかしい|ばか...|もう...|やだ)/.test(t)
      const thinkingCue = /(考え|思う|ふむ|なるほど|嗯|让我想想|思考|どうしよう|ちょっと待って)/.test(t)
      const annoyedCue = /(もう|うるさい|烦|真是的|啧|あーもう|吵死了|烦人)/.test(t)
      const indifferentCue = /(随便|どうでも|无所谓|别管我|知らない|随你)/.test(t)
      if (ex && negative) return 'furious'
      if (ex && positive) return 'elated'
      if (surpriseCue) return 'surprised'
      if (blushCue) return 'blush'
      if (thinkingCue) return 'thinking'
      if (annoyedCue) return 'annoyed'
      if (indifferentCue) return 'indifferent'
      if (ex) return 'excited'
      if (q) return 'question'
      if (negative || angryCue) return 'angry'
      if (apologetic) return 'sad'
      if (positive) return 'happy'
      if (softCue || /[…⋯]$/.test(t.trim())) return 'soft'
      return 'neutral'
    }

    function mimeFor(name) {
      const dot = name.lastIndexOf('.')
      if (dot < 0) return 'application/octet-stream'
      const ext = name.slice(dot).toLowerCase()
      return MIME[ext] || 'application/octet-stream'
    }

    function safeRel(rel) {
      if (typeof rel !== 'string') return null
      if (rel.indexOf('..') >= 0) return null
      if (rel.indexOf('\\') >= 0) return null
      if (rel.indexOf('\0') >= 0) return null
      return rel
    }

    // ---------------- 写入（带沙箱策略） ----------------
    function noteHost(req) {
      try {
        const host = req && req.headers && req.headers.host
        if (typeof host === 'string' && /^\d+(\.\d+){0,3}(:\d+)?$/.test(host)) lastHostPort = host
      } catch (e) { /* ignore */ }
    }

    async function writeTextSafe(absPath, content) {
      const t = await fs.resolve(absPath)
      let policy
      try {
        policy = sandboxPolicy !== undefined ? sandboxPolicy.resolve({ mode: 'danger-full-access' }) : undefined
      } catch (e) { /* backend 默认 */ }
      return fs.writeText(t, content, undefined, undefined, policy)
    }

    // 数据目录（config/memory/tmp）不存在时用系统命令补建（fs 服务无 mkdir）
    async function ensureDataDirs() {
      const dirs = [DATA_DIR, DATA_DIR + '/config', DATA_DIR + '/memory', DATA_DIR + '/tmp']
      for (const d of dirs) {
        try {
          const t = await fs.resolve(d)
          const info = await fs.stat(t)
          if (info !== undefined) continue
        } catch (e) { /* 不存在 → 尝试创建 */ }
        try {
          const win = typeof process !== 'undefined' && process.platform === 'win32'
          const exe = win ? (process.env.ComSpec || 'cmd.exe') : 'mkdir'
          const args = win ? ['/c', 'mkdir', d] : ['-p', d]
          const proc = subprocess.spawn({
            argv: [exe].concat(args),
            cwd: ROOT,
            stdio: { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' },
            graceMs: 8000,
          })
          await raceDone(proc, 'mkdir ' + d)
        } catch (e) {
          console.error('[amadeus] 创建数据目录失败:', d, e && e.message ? e.message : String(e))
        }
      }
    }

    // ---------------- 配置 ----------------
    async function loadConfig() {
      try {
        const t = await fs.resolve(CONFIG_PATH)
        const info = await fs.stat(t)
        if (info === undefined) return
        const text = await fs.readText(t)
        const parsed = JSON.parse(text)
        if (parsed && typeof parsed === 'object') {
          config = Object.assign({}, DEFAULT_CONFIG, parsed)
        }
      } catch (e) {
        console.error('[amadeus] 读取配置失败:', e && e.message ? e.message : String(e))
      }
    }

    async function saveConfig() {
      try {
        await writeTextSafe(CONFIG_PATH, JSON.stringify(config, null, 2))
      } catch (e) {
        console.error('[amadeus] 保存配置失败:', e && e.message ? e.message : String(e))
      }
    }

    function sanitizePatch(p) {
      const out = {}
      if (p === null || typeof p !== 'object') return out
      if (typeof p.voiceOn === 'boolean') out.voiceOn = p.voiceOn
      if (typeof p.personaOn === 'boolean') out.personaOn = p.personaOn
      if (typeof p.themeOn === 'boolean') out.themeOn = p.themeOn
      if (typeof p.chatOn === 'boolean') out.chatOn = p.chatOn
      if (typeof p.callOn === 'boolean') out.callOn = p.callOn
      if (typeof p.idleChatOn === 'boolean') out.idleChatOn = p.idleChatOn
      if (typeof p.idleChatMs === 'number' && p.idleChatMs >= 60000 && p.idleChatMs <= 86400000) out.idleChatMs = Math.floor(p.idleChatMs)
      if (typeof p.callIntervalMs === 'number' && p.callIntervalMs >= 600000 && p.callIntervalMs <= 86400000) out.callIntervalMs = Math.floor(p.callIntervalMs)
      if (typeof p.voiceName === 'string' && VOICES.indexOf(p.voiceName) >= 0) out.voiceName = p.voiceName
      if (typeof p.rate === 'string' && RATES.indexOf(p.rate) >= 0) out.rate = p.rate
      if (typeof p.pitch === 'string' && PITCHES.indexOf(p.pitch) >= 0) out.pitch = p.pitch
      if (p.provider === 'edge' || p.provider === 'quest' || p.provider === 'voicevox' || p.provider === 'aqua' || p.provider === 'openai' || p.provider === 'auto') out.provider = p.provider
      if (typeof p.questSpeaker === 'number' && p.questSpeaker >= 1 && p.questSpeaker <= 60) out.questSpeaker = Math.floor(p.questSpeaker)
      if (typeof p.emotionIntensity === 'number' && p.emotionIntensity >= 0.2 && p.emotionIntensity <= 2) out.emotionIntensity = p.emotionIntensity
      if (typeof p.fallbackToQuest === 'boolean') out.fallbackToQuest = p.fallbackToQuest
      if (typeof p.voiceStability === 'boolean') out.voiceStability = p.voiceStability
      if (typeof p.sttProvider === 'string' && ['auto', 'browser', 'api'].indexOf(p.sttProvider) >= 0) out.sttProvider = p.sttProvider
      if (typeof p.sttApiUrl === 'string' && p.sttApiUrl.length <= 200) out.sttApiUrl = p.sttApiUrl
      if (typeof p.sttApiKey === 'string' && p.sttApiKey.length <= 200) out.sttApiKey = p.sttApiKey
      if (typeof p.sttModel === 'string' && p.sttModel.length <= 100) out.sttModel = p.sttModel
      if (typeof p.aquaUrl === 'string' && /^https?:\/\//.test(p.aquaUrl) && p.aquaUrl.length <= 200) out.aquaUrl = p.aquaUrl
      if (typeof p.aquaVoice === 'string' && p.aquaVoice.length <= 100) out.aquaVoice = p.aquaVoice
      if (typeof p.aquaRefAudio === 'string' && p.aquaRefAudio.length <= 300) out.aquaRefAudio = p.aquaRefAudio
      if (typeof p.aquaPromptText === 'string' && p.aquaPromptText.length <= 300) out.aquaPromptText = p.aquaPromptText
      if (typeof p.aquaTextLanguage === 'string' && ['日文', '中文', '英文'].indexOf(p.aquaTextLanguage) >= 0) out.aquaTextLanguage = p.aquaTextLanguage
      if (typeof p.aquaPromptLanguage === 'string' && ['日文', '中文', '英文'].indexOf(p.aquaPromptLanguage) >= 0) out.aquaPromptLanguage = p.aquaPromptLanguage
      if (typeof p.aquaPreset === 'string' && ['fast', 'balanced', 'quality'].indexOf(p.aquaPreset) >= 0) out.aquaPreset = p.aquaPreset
      if (typeof p.aquaApiKey === 'string' && p.aquaApiKey.length <= 200) out.aquaApiKey = p.aquaApiKey
      if (typeof p.aquaEmotionVoices === 'string' && p.aquaEmotionVoices.length <= 800) {
        try {
          const obj = JSON.parse(p.aquaEmotionVoices)
          if (obj && typeof obj === 'object' && !Array.isArray(obj)) out.aquaEmotionVoices = obj
        } catch (e) { /* ignore invalid json */ }
      }
      if (typeof p.voicevoxUrl === 'string' && /^https?:\/\//.test(p.voicevoxUrl) && p.voicevoxUrl.length <= 200) out.voicevoxUrl = p.voicevoxUrl
      if (typeof p.voicevoxSpeaker === 'number' && p.voicevoxSpeaker >= 0 && p.voicevoxSpeaker <= 100) out.voicevoxSpeaker = Math.floor(p.voicevoxSpeaker)
      if (typeof p.voicevoxEmotionSpeakers === 'string' && p.voicevoxEmotionSpeakers.length <= 800) {
        try {
          const obj = JSON.parse(p.voicevoxEmotionSpeakers)
          if (obj && typeof obj === 'object' && !Array.isArray(obj)) out.voicevoxEmotionSpeakers = obj
        } catch (e) { /* ignore invalid json */ }
      }
      if (typeof p.openaiTtsUrl === 'string' && p.openaiTtsUrl.length <= 200) out.openaiTtsUrl = p.openaiTtsUrl
      if (typeof p.openaiTtsApiKey === 'string' && p.openaiTtsApiKey.length <= 200) out.openaiTtsApiKey = p.openaiTtsApiKey
      if (typeof p.openaiTtsModel === 'string' && p.openaiTtsModel.length <= 100) out.openaiTtsModel = p.openaiTtsModel
      if (typeof p.openaiTtsVoice === 'string' && p.openaiTtsVoice.length <= 100) out.openaiTtsVoice = p.openaiTtsVoice
      if (typeof p.openaiTtsSpeed === 'number' && p.openaiTtsSpeed >= 0.5 && p.openaiTtsSpeed <= 2) out.openaiTtsSpeed = p.openaiTtsSpeed
      if (typeof p.maxCharsPerTurn === 'number' && p.maxCharsPerTurn >= 100 && p.maxCharsPerTurn <= 8000) out.maxCharsPerTurn = Math.floor(p.maxCharsPerTurn)
      if (typeof p.chatApiKey === 'string' && p.chatApiKey.length <= 200) out.chatApiKey = p.chatApiKey
      if (typeof p.chatBaseUrl === 'string' && /^https?:\/\//.test(p.chatBaseUrl) && p.chatBaseUrl.length <= 200) out.chatBaseUrl = p.chatBaseUrl
      if (typeof p.chatModel === 'string' && p.chatModel.length <= 100) out.chatModel = p.chatModel
      if (typeof p.narratorOn === 'boolean') out.narratorOn = p.narratorOn
      if (typeof p.narratorLLMSummary === 'boolean') out.narratorLLMSummary = p.narratorLLMSummary
      if (typeof p.narratorDone === 'boolean') out.narratorDone = p.narratorDone
      if (typeof p.narratorMilestoneMs === 'number' && p.narratorMilestoneMs >= 60000 && p.narratorMilestoneMs <= 1800000) out.narratorMilestoneMs = Math.floor(p.narratorMilestoneMs)
      if (typeof p.narratorMilestoneSteps === 'number' && p.narratorMilestoneSteps >= 3 && p.narratorMilestoneSteps <= 50) out.narratorMilestoneSteps = Math.floor(p.narratorMilestoneSteps)
      return out
    }

    async function loadPersona() {
      try {
        const t = await fs.resolve(PERSONA_PATH)
        const info = await fs.stat(t)
        if (info === undefined) return
        const text = (await fs.readText(t)).trim()
        if (text.length > 20) personaText = text
      } catch (e) { /* keep default */ }
    }

    let chatPersonaCache = ''
    async function readChatPersona() {
      if (chatPersonaCache.length > 10) return chatPersonaCache
      try {
        const t = await fs.resolve(CHAT_PERSONA_PATH)
        const info = await fs.stat(t)
        if (info === undefined) return DEFAULT_CHAT_PERSONA
        const text = (await fs.readText(t)).trim()
        if (text.length > 10) {
          chatPersonaCache = text
          return text
        }
      } catch (e) { /* ignore */ }
      return DEFAULT_CHAT_PERSONA
    }

    // ---------------- 记忆 ----------------
    async function loadMemory() {
      try {
        const t = await fs.resolve(MEMORY_PATH)
        const info = await fs.stat(t)
        if (info === undefined) return
        const parsed = JSON.parse(await fs.readText(t))
        if (parsed && typeof parsed === 'object') {
          memory = Object.assign({ facts: [], history: [], summary: '', lastCallAt: 0, callCount: 0 }, parsed)
          if (!Array.isArray(memory.facts)) memory.facts = []
          if (!Array.isArray(memory.history)) memory.history = []
          if (typeof memory.summary !== 'string') memory.summary = ''
        }
      } catch (e) {
        console.error('[amadeus] 读取记忆失败:', e && e.message ? e.message : String(e))
      }
    }

    function scheduleSaveMemory() {
      saveMemoryNow().catch((e) => console.error('[amadeus] 保存记忆失败:', e && e.message ? e.message : e))
    }

    async function saveMemoryNow() {
      try {
        await writeTextSafe(MEMORY_PATH, JSON.stringify(memory, null, 2))
        return
      } catch (e) {
        // fs 沙箱可能拦截写入 → python 子进程兜底（已验证可写盘）
      }
      try {
        await runPython([MEM_SAVE_PY, lastHostPort, MEMORY_PATH], 'mem_save')
      } catch (e2) {
        console.error('[amadeus] 记忆落盘失败(fs+py):', e2 && e2.message ? e2.message : String(e2))
      }
    }

    function factsText() {
      const facts = (memory.facts || []).slice(-30)
      if (facts.length === 0) return ''
      return 'ユーザーについての長期記憶：\n- ' + facts.join('\n- ')
    }

    // ---------------- 子进程 ----------------
    async function raceDone(proc, label) {
      const res = await Promise.race([
        proc.done.then((o) => ({ t: 'done', o }), (e) => ({ t: 'spawn-error', e })),
        ctx.timeout(TTS_TIMEOUT_MS).then(() => ({ t: 'timeout' })),
      ])
      if (res.t === 'timeout') {
        try { proc.terminate() } catch (e) { /* ignore */ }
        throw new Error(label + ' timeout')
      }
      if (res.t === 'spawn-error') throw new Error(label + ' spawn failed: ' + (res.e && res.e.message ? res.e.message : res.e))
      if (res.o.exitCode !== 0) throw new Error(label + ' exited ' + res.o.exitCode)
    }

    async function runPython(args, label) {
      let exe
      try {
        exe = await subprocess.resolveExecutable('python')
      } catch (e) {
        exe = undefined
      }
      if (typeof exe !== 'string' || exe.length === 0) throw new Error('python not found')
      const proc = subprocess.spawn({
        argv: [exe].concat(args),
        cwd: ROOT,
        stdio: { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' },
        graceMs: 5000,
      })
      await raceDone(proc, label)
    }

    async function runCurl(args) {
      let exe
      try {
        exe = await subprocess.resolveExecutable('curl.exe')
      } catch (e) {
        exe = undefined
      }
      if (typeof exe !== 'string' || exe.length === 0) throw new Error('curl.exe not found')
      const proc = subprocess.spawn({
        argv: [exe].concat(args),
        cwd: ROOT,
        stdio: { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' },
        graceMs: 4000,
      })
      await raceDone(proc, 'curl')
    }

    async function readFileBytes(absPath, maxBytes) {
      const t = await fs.resolve(absPath)
      const info = await fs.stat(t)
      if (info === undefined) return null
      return fs.readBytes(t, undefined, maxBytes)
    }

    async function readTextFile(absPath) {
      const t = await fs.resolve(absPath)
      const info = await fs.stat(t)
      if (info === undefined) return null
      return fs.readText(t)
    }

    function nextSlot() {
      ttsSlot = (ttsSlot + 1) % 8
      return ttsSlot
    }

    // ---------------- TTS Provider ----------------
    // 常驻 Edge-TTS worker：省去每句重新启动 Python + 导入 edge-tts 的开销（约 0.5~1s/句）。
    // 懒启动、失败自动回退到逐句 python 子进程；外部无法使用时 ttsWorker 置 {disabled:true}。
    let ttsWorker = null  // { port, proc } | { disabled: true }
    let ttsWorkerSeq = 0

    async function ensureTtsWorker() {
      if (ttsWorker !== null) return ttsWorker.disabled === true ? null : ttsWorker.port
      if (config.provider !== 'edge' && config.provider !== 'auto') return null
      let proc
      try {
        const py = await subprocess.resolveExecutable('python')
        proc = subprocess.spawn({
          // cwd 用数据目录而非安装目录：Windows 上常驻进程的 cwd 会锁住安装目录，
          // 导致下次重装时 Remove-Item 失败。worker 全部使用绝对路径，不依赖 cwd。
          argv: [py, TTS_SERVER_PY, '--root', TMP_DIR],
          cwd: TMP_DIR,
          stdio: { stdin: 'ignore', stdout: 'pipe', stderr: { maxBytes: 8192 } },
          graceMs: 5000,
        })
        const port = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('tts worker ready timeout')), 10000)
          let buf = ''
          const stream = proc.stdout
          const onData = (chunk) => {
            buf += String(chunk)
            let idx
            while ((idx = buf.indexOf('\n')) >= 0) {
              const line = buf.slice(0, idx).trim()
              buf = buf.slice(idx + 1)
              if (line.startsWith('READY:')) {
                clearTimeout(timer)
                stream.removeListener('data', onData)
                const p = parseInt(line.slice(6), 10)
                if (Number.isFinite(p) && p > 0) { resolve(p); return }
                reject(new Error('tts worker bad port line: ' + line))
                return
              }
            }
          }
          stream.on('data', onData)
          proc.done.then(() => { clearTimeout(timer); reject(new Error('tts worker exited early')) }, () => { clearTimeout(timer); reject(new Error('tts worker spawn failed')) })
        })
        ttsWorker = { port, proc }
        const seq = ++ttsWorkerSeq
        proc.done.then(() => {
          // 进程退出后清引用，下次自动重启（忽略已替换的旧进程）
          if (ttsWorker && ttsWorker.proc === proc) ttsWorker = null
        }).catch(() => { if (ttsWorker && ttsWorker.proc === proc) ttsWorker = null })
        console.log('[amadeus] TTS worker 就绪: 127.0.0.1:' + port)
        return port
      } catch (e) {
        console.warn('[amadeus] TTS worker 启动失败，回退逐句 python:', e && e.message ? e.message : String(e))
        try { if (proc) proc.terminate() } catch (e2) { /* ignore */ }
        ttsWorker = { disabled: true }
        return null
      }
    }

    function teardownTtsWorker() {
      if (ttsWorker && ttsWorker.proc) {
        ttsWorkerSeq += 1
        try { ttsWorker.proc.terminate() } catch (e) { /* ignore */ }
      }
      ttsWorker = null
    }

    async function synthesizeEdge(text, voice, rate, pitch, emotion) {
      ttsFileSeq = (ttsFileSeq + 1) % 8
      const slot = nextSlot()
      const intensity = typeof config.emotionIntensity === 'number' ? config.emotionIntensity : 1
      // 1) 常驻 worker 优先
      try {
        const port = await ensureTtsWorker()
        if (port !== null) {
          const outPath = TMP_DIR + '/w-' + ttsFileSeq + '-' + slot + '-' + Date.now() + '.mp3'
          const reqPath = TMP_DIR + '/wreq-' + ttsFileSeq + '-' + slot + '.json'
          const respPath = TMP_DIR + '/wresp-' + ttsFileSeq + '-' + slot + '.json'
          await writeTextSafe(reqPath, JSON.stringify({
            text, voice: voice || 'ja-JP-NanamiNeural', emotion,
            rate: rate || '+0%', pitch: pitch || '+0Hz',
            intensity, out: outPath,
          }))
          await runCurl(['-sS', '--max-time', '45', '-X', 'POST', '-H', 'Content-Type: application/json', '--data-binary', '@' + reqPath, 'http://127.0.0.1:' + port + '/synth', '-o', respPath])
          const j = await readTextFile(respPath)
          const parsed = j ? JSON.parse(j) : null
          if (!parsed || parsed.ok !== true) throw new Error('tts worker: ' + (parsed && parsed.error ? parsed.error : 'no response'))
          const bytes = await readFileBytes(parsed.out, MAX_TTS_BYTES)
          if (bytes === null || bytes.length < 200) throw new Error('edge: empty audio')
          let words = []
          if (Array.isArray(parsed.words)) words = parsed.words.filter((w) => w && typeof w.o === 'number' && typeof w.d === 'number')
          return { bytes, words, mime: 'audio/mpeg' }
        }
      } catch (e) {
        console.warn('[amadeus] worker 合成失败，回退逐句 python:', e && e.message ? e.message : String(e))
      }
      // 2) 回退：逐句 python 子进程
      const outPath = TMP_DIR + '/tts-' + ttsFileSeq + '-' + slot + '.mp3'
      await runPython([TTS_EMOTE_PY, text, voice, emotion, outPath, rate || '+0%', pitch || '+0Hz', String(intensity)], 'edge_tts')
      const bytes = await readFileBytes(outPath, MAX_TTS_BYTES)
      if (bytes === null || bytes.length < 200) throw new Error('edge: empty audio')
      let words = []
      try {
        const wb = await readFileBytes(outPath + '.words.json', 262144)
        if (wb !== null) {
          const wj = JSON.parse(new TextDecoder('utf-8').decode(wb))
          if (wj && Array.isArray(wj.words)) words = wj.words.filter((w) => w && typeof w.o === 'number' && typeof w.d === 'number')
        }
      } catch (e) { /* words unavailable */ }
      return { bytes, words, mime: 'audio/mpeg' }
    }

    async function synthesizeQuest(text) {
      const speaker = config.questSpeaker || 8
      const slot = nextSlot()
      const qPath = TMP_DIR + '/quest-' + slot + '.json'
      const oPath = TMP_DIR + '/quest-' + slot + '.mp3'
      const api = 'https://api.tts.quest/v3/voicevox/synthesis?text=' + encURI(text) + '&speaker=' + speaker
      await runCurl(['-sS', '--max-time', '25', api, '-o', qPath])
      const qBytes = await readFileBytes(qPath, 65536)
      if (qBytes === null) throw new Error('quest: no response')
      const json = JSON.parse(new TextDecoder('utf-8').decode(qBytes))
      const mp3Url = json && json.mp3DownloadUrl
      if (typeof mp3Url !== 'string' || mp3Url.length === 0) throw new Error('quest: no download url')
      await runCurl(['-sS', '--max-time', '25', '-L', mp3Url, '-o', oPath])
      const bytes = await readFileBytes(oPath, MAX_TTS_BYTES)
      if (bytes === null || bytes.length < 200) throw new Error('quest: empty audio')
      return { bytes, words: [], mime: 'audio/mpeg' }
    }

    async function synthesizeVoicevox(text, emotion) {
      let speaker = config.voicevoxSpeaker || 8
      const emoMap = config.voicevoxEmotionSpeakers
      if (emotion && emoMap && emoMap[emotion] !== undefined && emoMap[emotion] !== null) {
        speaker = Number(emoMap[emotion]) || speaker
      }
      const slot = nextSlot()
      const qPath = TMP_DIR + '/voicevox-' + slot + '.json'
      const oPath = TMP_DIR + '/voicevox-' + slot + '.wav'
      const base = (config.voicevoxUrl || 'http://127.0.0.1:50021').replace(/\/+$/, '')
      // 1. audio_query 获取合成参数
      const queryUrl = base + '/audio_query?text=' + encURI(text) + '&speaker=' + speaker
      await runCurl(['-sS', '--max-time', '15', '-X', 'POST', queryUrl, '-H', 'Content-Type: application/json', '-d', '', '-o', qPath])
      const qBytes = await readFileBytes(qPath, 1048576)
      if (qBytes === null) throw new Error('voicevox: no audio_query response')
      // 2. synthesis 合成 WAV
      const synthUrl = base + '/synthesis?speaker=' + speaker
      await runCurl(['-sS', '--max-time', '30', '-X', 'POST', synthUrl, '-H', 'Content-Type: application/json', '--data-binary', '@' + qPath, '-o', oPath])
      const bytes = await readFileBytes(oPath, MAX_TTS_BYTES)
      if (bytes === null || bytes.length < 200) throw new Error('voicevox: empty audio')
      return { bytes, words: [], mime: 'audio/wav' }
    }

    async function synthesizeOpenAI(text) {
      const slot = nextSlot()
      const reqPath = TMP_DIR + '/openai-tts-' + slot + '.json'
      const oPath = TMP_DIR + '/openai-tts-' + slot + '.mp3'
      const base = (config.openaiTtsUrl || config.chatBaseUrl || '').replace(/\/+$/, '')
      const apiKey = config.openaiTtsApiKey || config.chatApiKey || ''
      if (!base || !apiKey) throw new Error('openai: missing TTS URL/API key')
      const req = {
        model: config.openaiTtsModel || 'tts-1',
        input: text,
        voice: config.openaiTtsVoice || 'nova',
        response_format: 'mp3',
        speed: Number(config.openaiTtsSpeed || 1),
      }
      await writeTextSafe(reqPath, JSON.stringify(req))
      const url = base + '/audio/speech'
      const args = ['-sS', '--max-time', '30', '-X', 'POST', url, '-H', 'Content-Type: application/json', '-H', 'Authorization: Bearer ' + apiKey, '--data-binary', '@' + reqPath, '-o', oPath]
      await runCurl(args)
      const bytes = await readFileBytes(oPath, MAX_TTS_BYTES)
      if (bytes === null || bytes.length < 200) throw new Error('openai: empty audio')
      return { bytes, words: [], mime: 'audio/mpeg' }
    }

    async function synthesizeAqua(text, emotion) {
      const slot = nextSlot()
      const oPath = TMP_DIR + '/aqua-' + slot + '.wav'
      const base = (config.aquaUrl || 'http://127.0.0.1:8000').replace(/\/+$/, '')
      let voice = config.aquaVoice || ''
      const emoMap = config.aquaEmotionVoices
      if (emotion && emoMap && emoMap[emotion]) voice = emoMap[emotion]
      const params = ['text=' + encURI(text)]
      if (voice) params.push('voice=' + encURI(voice))
      if (config.aquaRefAudio) params.push('ref_audio_path=' + encURI(config.aquaRefAudio))
      if (config.aquaPromptText) params.push('prompt_text=' + encURI(config.aquaPromptText))
      params.push('text_language=' + encURI(config.aquaTextLanguage || '日文'))
      params.push('prompt_language=' + encURI(config.aquaPromptLanguage || '日文'))
      if (config.aquaPreset) params.push('preset=' + encURI(config.aquaPreset))
      const api = base + '/tts/file?' + params.join('&')
      const args = ['-sS', '--max-time', '35', '-X', 'POST', api]
      if (config.aquaApiKey) args.push('-H', 'Authorization: Bearer ' + config.aquaApiKey)
      args.push('-o', oPath)
      await runCurl(args)
      const bytes = await readFileBytes(oPath, MAX_TTS_BYTES)
      if (bytes === null || bytes.length < 200) throw new Error('aqua: empty audio')
      return { bytes, words: [], mime: 'audio/wav' }
    }

    async function synthesize(text, voice, rate, pitch, emotion) {
      const emo = EMOTIONS.indexOf(emotion) >= 0 ? emotion : 'neutral'
      // auto 模式会动态选择 Aqua/VOICEVOX，不写共享缓存，避免换后端后命中旧音色。
      const useCache = config.provider !== 'auto'
      // provider 缓存键包含 provider 专属参数，避免切换音色/角色后命中旧缓存。
      let providerKey = config.provider
      if (config.provider === 'aqua') providerKey = 'aqua:' + (config.aquaVoice || '') + ':' + (config.aquaRefAudio || '') + ':' + (config.aquaPreset || 'fast')
      if (config.provider === 'voicevox') providerKey = 'voicevox:' + (config.voicevoxSpeaker || 8)
      if (config.provider === 'openai') providerKey = 'openai:' + (config.openaiTtsModel || 'tts-1') + ':' + (config.openaiTtsVoice || 'nova') + ':' + (config.openaiTtsUrl || config.chatBaseUrl || '')
      const key = [providerKey, text, voice, rate, pitch, emo].join('\u0001')
      if (useCache) {
        const hit = ttsCache.get(key)
        if (hit !== undefined) {
          ttsOrder.splice(ttsOrder.indexOf(key), 1)
          ttsOrder.push(key)
          return hit
        }
        // 预热和前端取流可能同时合成同一句：并发合并到同一个任务，避免重复合成拖慢双方。
        const running = ttsInflight.get(key)
        if (running) return running
      }
      const task = (async () => {
        let entry
        if (config.provider === 'quest') {
          entry = await synthesizeQuest(text)
        } else if (config.provider === 'voicevox') {
          entry = await synthesizeVoicevox(text, emo)
        } else if (config.provider === 'openai') {
          entry = await synthesizeOpenAI(text)
        } else if (config.provider === 'aqua') {
          entry = await synthesizeAqua(text, emo)
        } else if (config.provider === 'auto') {
          const errors = []
          const stable = config.voiceStability !== false
          // 1) 优先 Aqua-TTS（如果配置了角色或参考音频）
          const aquaReady = !!(config.aquaVoice || config.aquaRefAudio)
          if (aquaReady) {
            try {
              entry = await synthesizeAqua(text, emo)
            } catch (e) {
              errors.push('aqua:' + (e && e.message ? e.message : e))
              // 声线稳定开启时，不切换到其它音色
              if (stable) throw new Error('auto TTS failed (stable): ' + (e && e.message ? e.message : e))
            }
          }
          // 2) 本地 VOICEVOX：仅在未配置 Aqua 或用户允许切换时使用
          if (!entry && (!stable || !aquaReady)) {
            try {
              entry = await synthesizeVoicevox(text, emo)
            } catch (e) {
              errors.push('voicevox:' + (e && e.message ? e.message : e))
            }
          }
          // 3) 可选公共 VOICEVOX API（默认关，避免音色突变；voiceStability 开启时绝不切）
          if (!entry && config.fallbackToQuest === true && stable !== true) {
            try {
              entry = await synthesizeQuest(text)
            } catch (e) {
              errors.push('quest:' + (e && e.message ? e.message : e))
            }
          }
          if (!entry) {
            throw new Error('auto TTS failed: ' + (errors.join(' | ') || 'no provider available'))
          }
        } else {
          try {
            entry = await synthesizeEdge(text, voice, rate, pitch, emo)
          } catch (e1) {
            if (config.fallbackToQuest === true && config.voiceStability !== true) {
              try {
                entry = await synthesizeQuest(text)
              } catch (e2) {
                throw new Error('edge failed: ' + (e1 && e1.message ? e1.message : e1) + ' | quest failed: ' + (e2 && e2.message ? e2.message : e2))
              }
            } else {
              // 声线稳定优先：失败不切公共 API；前端默认也不降级到浏览器语音。
              throw new Error('edge failed: ' + (e1 && e1.message ? e1.message : e1))
            }
          }
        }
        return entry
      })()
      if (useCache) {
        ttsInflight.set(key, task)
        try {
          const entry = await task
          if (!ttsCache.has(key)) {
            ttsCache.set(key, entry)
            ttsOrder.push(key)
            while (ttsOrder.length > TTS_CACHE_MAX) {
              const oldest = ttsOrder.shift()
              ttsCache.delete(oldest)
            }
          }
          return entry
        } finally {
          ttsInflight.delete(key)
        }
      }
      return task
    }

    // ---------------- 语音队列 ----------------
    // 服务端 TTS 预热：句子进队列后立刻在后台并行合成，前端拉到时大概率直接命中缓存，
    // 消除句与句之间的 TTS 合成等待（并行 3 路，排队按进队顺序）。
    let warmChain = Promise.resolve()
    function warmItems(items) {
      const pending = items.slice()
      const workers = []
      const workerCount = Math.min(5, pending.length)
      for (let w = 0; w < workerCount; w++) {
        workers.push((async () => {
          while (pending.length > 0) {
            const u = pending.shift()
            if (u === undefined || u.kind !== 'say' || typeof u.text !== 'string' || u.text.trim().length === 0) continue
            try {
              await synthesize(u.text, config.voiceName, config.rate, config.pitch, u.emotion || 'neutral')
            } catch (e) {
              // 预热失败不影响正式请求；/amadeus/tts 仍会按需重试。
            }
          }
        })())
      }
      return Promise.all(workers)
    }
    function scheduleWarmTts() {
      const items = queue.slice(0, 8).filter((u) => u && u.kind === 'say' && u.text)
      if (items.length === 0) return
      warmChain = warmChain.then(() => warmItems(items)).catch((e) => {
        console.error('[amadeus] TTS 预热失败:', e && e.message ? e.message : String(e))
      })
    }

    function pushUtterances(texts, force, emotion, cn, tags) {
      const emo = EMOTIONS.indexOf(emotion) >= 0 ? emotion : 'neutral'
      for (let i = 0; i < texts.length; i++) {
        const t = texts[i]
        if (typeof t !== 'string' || t.trim().length === 0) continue
        let e = emo
        if (i > 0) {
          const per = emotionFor(t)
          if (per !== 'neutral') e = per
        }
        const item = { id: nextId, kind: 'say', text: t.trim(), cn: i === texts.length - 1 ? (cn || '') : '', force: !!force, emotion: e, expr: EMOTION_EXPR[e] || '', ts: Date.now() }
        if (tags && typeof tags === 'object') {
          for (const k in tags) item[k] = tags[k]
        }
        queue.push(item)
        nextId += 1
        maxIssuedId = Math.max(maxIssuedId, nextId - 1)
        if (queue.length > 60) queue.shift()
      }
      scheduleWarmTts()
    }

    function pushCn(cn, emotion) {
      const emo = EMOTIONS.indexOf(emotion) >= 0 ? emotion : 'neutral'
      queue.push({ id: nextId, kind: 'cn', text: '', cn: String(cn || ''), force: false, emotion: emo, expr: '', ts: Date.now() })
      nextId += 1
      maxIssuedId = Math.max(maxIssuedId, nextId - 1)
    }

    function pushCall(text, emotion, cn) {
      const emo = EMOTIONS.indexOf(emotion) >= 0 ? emotion : 'neutral'
      queue.push({ id: nextId, kind: 'call', text, cn: cn || '', force: true, emotion: emo, expr: EMOTION_EXPR[emo] || '', ts: Date.now() })
      nextId += 1
      maxIssuedId = Math.max(maxIssuedId, nextId - 1)
      callPending = true
      scheduleWarmTts()
    }

    // 通用同步出声：所有宿主发起的固定话语（播报/来电/空闲/指令朗读）统一走这里。
    // 先合成进 TTS 缓存，成功后才把条目推给面板 → 气泡与语音基本同帧；合成失败仅文字（无声=自检信号）。
    async function speakSynced(jp, cn, emotion, kind, tags) {
      const emo = EMOTIONS.indexOf(emotion) >= 0 ? emotion : 'neutral'
      try {
        await synthesize(jp, config.voiceName, config.rate, config.pitch, emo)
      } catch (e) {
        console.warn('[amadeus] 合成失败（仅显示文字）:', e && e.message ? e.message : String(e))
      }
      if (kind === 'call') {
        pushCall(jp, emo, cn || '')
      } else {
        pushUtterances([jp], kind === 'force', emo, cn || '', tags || {})
      }
    }

    // 播报（欢迎语/完成/事件）走 speakSynced：语音就绪后同发气泡+声音。
    async function announce(jp, cn, emotion) {
      const now = Date.now()
      const cnText = (typeof cn === 'string' && cn.length > 0) ? cn : jp
      // 播报留痕对话区（无论语音开关都记录；对话区显示中文 cn）
      memory.history.push({ role: 'assistant', jp, cn: cnText, emotion: emotion || 'neutral', announce: true, t: now })
      if (memory.history.length > 60) maybeCompactHistory()
      if (config.voiceOn !== true) return
      if (now - lastAnnounceAt < 8000) return
      lastAnnounceAt = now
      await speakSynced(jp, cnText, emotion || 'neutral', 'force', { announce: true })
    }

    // ============================================================
    // 进度叙事系统（Progress Narrator）——Task 1：路由器 + 状态机 + 台词池 + LLM 总结 + 旧播报收编
    // 统一收编旧 notifyComplete / subagent/end / workflow/end / agent/error / jobs 零散播报，
    // 归一为 narrate(intent) 意图路由器：start/done/milestone/block/fail/special/goal。
    // 模板词严格取自 narrator-phrases.md（S1-S3 / D1-D2 / M1-M2 / B1-B4 / F1-F2）；
    // A3/A4 沿用旧播报文案（只搬位置、不改词）。出口统一 speakSynced（先合成后同发，队列串行不叠播）。
    // ============================================================
    const NARR_INTENT_GAP_MS = 8000   // 同意图 8s 合并窗
    const NARR_LLM_GAP_MS = 8000      // LLM 总结最低间隔（防连续回合烧 token）
    const NARR_PRIORITY = { block: 40, fail: 30, done: 20, goal: 20, special: 15, milestone: 10, start: 5 }
    const NARR_LLM_EMOTIONS = ['happy', 'soft', 'neutral', 'question', 'excited']

    // 台词表（唯一模板来源 narrator-phrases.md，JP/CN/emotion 原样抄录；LLM 句不参与池轮换）
    const NARR_LINES = {
      // START S1-S3（有据开工：首个工具调用）
      s1: { jp: 'お仕事が始まったようですわね。わたくし、ここで応援していますわ', cn: '看来开始干活了呢。我就在这里给你加油哦', emotion: 'happy' },
      s2: { jp: 'ふふ、始まりましたわね。焦らず、着実に参りましょう', cn: '呵呵，开始了呢。别急，稳步来吧', emotion: 'soft' },
      s3: { jp: 'なんだか楽しそうですわね。何が出来上がるのかしら', cn: '感觉很有意思呢。会做出什么来呢', emotion: 'soft' },
      // DONE 兜底 D1-D2（LLM 失败/超时/未开 LLM 时）
      d1: { jp: 'ひと区切りつきましたわね。次の一手を考えましょう', cn: '告一段落了呢。想想下一步吧', emotion: 'happy' },
      d2: { jp: 'できましたわ。ここからどう進めましょうか', cn: '做好了哦。接下来往哪走呢', emotion: 'soft' },
      // MILESTONE M1-M2（LLM 摘要失败兜底）
      m1: { jp: 'まだ作業中ですわね。順調に進んでいるようで安心しました', cn: '还在进行中呢。看来进展顺利，我就放心了', emotion: 'soft' },
      m2: { jp: '長いお仕事ですわね。わたくしも一緒に付き合っておりますわ', cn: '是项长久的工作呢。我也一直陪着你哦', emotion: 'soft' },
      // BLOCK B1-B4（阻塞提醒：按触发固定选句，语义不可互替）
      b1: { jp: '承認が必要なようですわ。ご確認をお願いいたします', cn: '需要你批准一下哦。请确认', emotion: 'question' },
      b2: { jp: 'あなたのご返事を待っておりますわ。じっくりお考えくださいませ', cn: '在等你回复呢。请慢慢考虑', emotion: 'soft' },
      b3: { jp: '計画をご確認いただけますかしら。問題なければ進めてくださいませ', cn: '请过目一下计划。没问题的话就可以推进了哦', emotion: 'question' },
      b4: { jp: 'お手元の確認待ちですわ。落ち着いてどうぞ', cn: '在等你在界面上确认哦。慢慢来', emotion: 'soft' },
      // FAIL F1-F2（agent/error）
      f1: { jp: 'あら…うまくいきませんでしたわね。慌てずに原因を探りましょう', cn: '哎呀……不太顺利呢。别慌，我们一起找原因吧', emotion: 'soft' },
      f2: { jp: 'エラーが出たようですわ。わたくしも見ておりますので、落ち着いてどうぞ', cn: '好像出错了。我也看着呢，冷静处理吧', emotion: 'question' },
    }
    // 可轮换池：start/done/milestone/fail（LRU：最近一条沉底 → 游标轮转，绝不立刻复读）
    const NARR_POOLS = { start: ['s1', 's2', 's3'], done: ['d1', 'd2'], milestone: ['m1', 'm2'], fail: ['f1', 'f2'] }
    // BLOCK 各触发对应的固定句（b1 审批 / b2 提问等待 / b3 计划审批 / b4 其它界面等待）
    const NARR_BLOCK_IDS = { b1: 'b1', b2: 'b2', b3: 'b3', b4: 'b4' }
    // 收编自旧播报的文案常量（A3 任务完成 = 考据表 A3；A4-1 子代理 / A4-2 工作流成功 / A4-3 工作流出错 / A4-4 后台任务结束）
    const NARR_A3 = { jp: 'やり遂げたのですね。うれしいですわ', cn: '你做到了呢。真替你高兴', emotion: 'happy' }
    const NARR_A4 = {
      subagent: { jp: 'あら、何か動きがあったようですわね。ゆっくりお話を聞かせてください', cn: '哎呀，好像有什么新进展了呢。慢慢讲给我听吧', emotion: 'soft' },
      workflowOk: { jp: '完了いたしましたわ。ここから先も、一緒に頑張りましょう', cn: '已经完成了。接下来的路，也一起加油吧', emotion: 'happy' },
      workflowErr: { jp: '大丈夫ですわ', cn: '没事的', emotion: 'soft' },
      jobDone: { jp: 'お待たせしましたわね。ようやく一段落したようですわ', cn: '让你久等了。总算是告一段落了', emotion: 'soft' },
    }

    // 进度状态机：持久键随 narrator.json 落盘；回合瞬态键不落盘（重启即清）
    let narrState = {
      counts: { start: 0, done: 0, milestone: 0, block: 0, fail: 0, special: 0, goal: 0 },
      lastSummary: '',
      lastLLMAt: 0,
      poolCursor: {},
      // ---- 回合瞬态（不落盘） ----
      turnActive: false,
      turnStartAt: 0,
      stepCount: 0,
      startSpoken: false,
      milestoneSpoken: false,
      turnGoalDone: false,
      blocking: null,       // 'b1'..'b4' | null
      lastUserText: '',
      toolNames: {},        // 本轮工具名 → 次数
    }
    const poolLastUsed = new Map()      // 每池最近使用的一条（供状态查看 / LRU 沉底确认）
    const lastSpokeByIntent = new Map() // 同意图最近发声时刻
    let lastDoneFamilyAt = 0            // done/goal 完成语义 8s 互斥窗
    const lastNarrSpeaks = []           // 最近发声留档（供验证）
    let narrSaveTimer = null

    function narrPersistSnapshot() {
      return {
        counts: narrState.counts,
        lastSummary: typeof narrState.lastSummary === 'string' ? narrState.lastSummary.slice(0, 500) : '',
        lastLLMAt: narrState.lastLLMAt || 0,
        poolCursor: narrState.poolCursor || {},
      }
    }
    async function loadNarrator() {
      try {
        const t = await fs.resolve(NARRATOR_PATH)
        const info = await fs.stat(t)
        if (info === undefined) return
        const parsed = JSON.parse(await fs.readText(t))
        if (!parsed || typeof parsed !== 'object') return
        const c = parsed.counts
        if (c && typeof c === 'object') {
          for (const k of Object.keys(narrState.counts)) {
            if (typeof c[k] === 'number' && isFinite(c[k])) narrState.counts[k] = Math.max(0, Math.floor(c[k]))
          }
        }
        if (typeof parsed.lastSummary === 'string') narrState.lastSummary = parsed.lastSummary.slice(0, 500)
        if (typeof parsed.lastLLMAt === 'number' && isFinite(parsed.lastLLMAt)) narrState.lastLLMAt = parsed.lastLLMAt
        if (parsed.poolCursor && typeof parsed.poolCursor === 'object') narrState.poolCursor = parsed.poolCursor
      } catch (e) {
        console.error('[amadeus] 读取 narrator 状态失败:', e && e.message ? e.message : String(e))
      }
    }
    async function saveNarratorNow() {
      try {
        await writeTextSafe(NARRATOR_PATH, JSON.stringify(narrPersistSnapshot(), null, 2))
      } catch (e) {
        console.error('[amadeus] 保存 narrator 状态失败:', e && e.message ? e.message : String(e))
      }
    }
    function scheduleSaveNarrator() {
      if (narrSaveTimer !== null) return
      narrSaveTimer = setTimeout(() => {
        narrSaveTimer = null
        saveNarratorNow().catch(() => { /* 已记录错误 */ })
      }, 800)
    }

    // 池轮换：游标 +1（最近一条沉底，绝不立刻复读）；跨重启用落盘游标延续偏移
    function pickPool(poolKey) {
      const ids = NARR_POOLS[poolKey]
      if (!Array.isArray(ids) || ids.length === 0) return null
      const cursor = narrState.poolCursor || {}
      let idx = (typeof cursor[poolKey] === 'number' && cursor[poolKey] >= 0) ? cursor[poolKey] : -1
      idx = (idx + 1) % ids.length
      narrState.poolCursor[poolKey] = idx
      poolLastUsed.set(poolKey, { id: ids[idx], at: Date.now() })
      scheduleSaveNarrator()
      return NARR_LINES[ids[idx]]
    }

    function resetTurn() {
      const now = Date.now()
      narrState.stepCount = 0
      narrState.startSpoken = false
      narrState.milestoneSpoken = false
      narrState.turnGoalDone = false
      narrState.turnActive = true
      narrState.turnStartAt = now
      narrState.toolNames = {}
    }

    function userMessageText(d) {
      const c = d && typeof d === 'object' ? d.content : undefined
      if (typeof c === 'string') return c
      if (Array.isArray(c)) {
        const parts = []
        for (const b of c) {
          if (b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
        }
        return parts.join('\n')
      }
      return ''
    }

    // 泛化工具调用扫描（旧 isTaskCompleteMessage 思路）：assistant message 是否含指定名称的工具调用
    function msgHasToolCall(msg, names) {
      if (!msg || !Array.isArray(msg.content)) return false
      for (let i = 0; i < msg.content.length; i++) {
        const b = msg.content[i]
        if (b === null || typeof b !== 'object' || b.type !== 'tool-call') continue
        const name = String(b.name || '')
        if (names.indexOf(name) >= 0) return true
      }
      return false
    }

    // goal 完成类工具调用：update_goal action complete/blocked、goal.complete、*goal*complete*。
    // 注：exit_plan_mode 已从「完成」语义拆出，改走 BLOCK B3（计划审批）。
    function msgHasGoalDoneCall(msg) {
      if (!msg || !Array.isArray(msg.content)) return false
      for (let i = 0; i < msg.content.length; i++) {
        const b = msg.content[i]
        if (b === null || typeof b !== 'object' || b.type !== 'tool-call') continue
        const name = String(b.name || '')
        if (name === 'goal.complete' || /goal.*complete/i.test(name)) return true
        if (name === 'update_goal') {
          try {
            const a = JSON.parse(String(b.arguments || '{}'))
            if (Object.prototype.hasOwnProperty.call(a, 'action')) {
              if (a.action === 'complete' || a.action === 'blocked') return true
            } else {
              return true
            }
          } catch (e) { /* 解析失败按完成处理 */ return true }
        }
      }
      return false
    }

    // LLM 进度总结（spec §5）：白祥语域、只述事实 + 下一步 / 等待请求；失败/超时/格式异常 → null（调用方走模板）
    const NARR_LLM_SYSTEM =
      'あなたは豊川祥子——CRYCHIC時代の「白祥」本人。ユーザーの作業セッションを見守り、進捗の節目に一言かけるナレーターです。\n' +
      '口調の約束：語尾は「ですわ」系（ですわ／ですの／〜ますの）、自称は「私」、相手は「あなた」。' +
      '明るく温かく、感情を込めて。「〜てちょうだい」や責める・冷たい・見下す言い回し、黒祥時代の台詞、自己否定は一切使わない。\n' +
      '内容の約束：実際に起こった作業の事実と「次の一手」だけを述べる。起きていない手順や結果をでっち上げない。' +
      'ユーザーが確認・返答待ちの場合は「あなたの判断をお待ちしています」の意を添える。\n' +
      'フォーマット（必ず厳守）：\n' +
      '1行目：【happy】【soft】【neutral】【question】【excited】のいずれか1つの感情タグ。\n' +
      '2行目：「JP: 」で始まる日本語（60字以内・1〜2文）。\n' +
      '3行目：「CN: 」で始まる中国語（JPと同じ意味・80字以内）。\n' +
      'それ以外は何も出力しない。'

    async function narrateSummary(kind, opts) {
      if (config.narratorLLMSummary !== true) return null
      const now = Date.now()
      if (now - (narrState.lastLLMAt || 0) < NARR_LLM_GAP_MS) return null
      // 进入即登记 lastLLMAt（先于本函数首个 await）：以“启动时刻”卡 8s 门，
      // 两个并发 LLM 总结的第二个必在门处被拦；失败返回 null 不回滚已登记时间（宁可少跑 LLM 不多烧 token）。
      narrState.lastLLMAt = now
      scheduleSaveNarrator()
      const o = opts && typeof opts === 'object' ? opts : {}
      const userMsg = String(o.userMsg || narrState.lastUserText || '').slice(0, 200)
      const tools = (o.tools && typeof o.tools === 'object') ? o.tools : (narrState.toolNames || {})
      const toolNames = Object.keys(tools)
      const toolLine = toolNames.length > 0
        ? toolNames.slice(0, 12).map((n) => String(n) + '×' + (tools[n] || 1)).join('、').slice(0, 300)
        : '（ツール呼び出しなし）'
      const isBlocked = (o.blocking !== undefined) ? !!o.blocking : !!narrState.blocking
      const blockingLine = isBlocked ? '（ユーザーの確認・返答を待っています）' : ''
      const prevSummary = narrState.lastSummary ? narrState.lastSummary.slice(0, 200) : ''
      const kindLine = kind === 'milestone'
        ? '作業が長引いているので、順調であることと継続を伝える一言を。'
        : 'このターンの節目なので、進んだこと＋次の一手を伝える一言を。'
      const prompt =
        '【セッション情報】\n' +
        '最近のユーザー発言：' + (userMsg || '（なし）') + '\n' +
        'このターンのツール使用：' + toolLine + '\n' +
        '前回の進捗サマリ：' + (prevSummary || '（なし）') + '\n' +
        (blockingLine ? blockingLine + '\n' : '') +
        kindLine
      try {
        const raw = await Promise.race([
          aiComplete(NARR_LLM_SYSTEM, [{ role: 'user', content: prompt }], 160),
          ctx.timeout(30000).then(() => { throw new Error('narrate llm timeout') }),
        ])
        const parsed = parseStructured(raw)
        if (typeof parsed.jp !== 'string' || parsed.jp.trim().length === 0) return null
        if (NARR_LLM_EMOTIONS.indexOf(parsed.emotion) < 0) return null
        if (typeof parsed.cn === 'string' && parsed.cn.length > 0) narrState.lastSummary = parsed.cn.slice(0, 120)
        scheduleSaveNarrator()
        return { jp: parsed.jp, cn: parsed.cn || parsed.jp, emotion: parsed.emotion }
      } catch (e) {
        console.warn('[amadeus] 进度总结 LLM 失败，走模板:', e && e.message ? e.message : String(e))
        return null
      }
    }

    // 台词选择：goal/special/block 固定句；start/done/milestone/fail 走池轮换（LLM 句不入池）
    function pickNarrLine(intent, opts) {
      if (intent === 'goal') return Object.assign({}, NARR_A3)
      if (intent === 'special') {
        const line = NARR_A4[opts.variant]
        return line ? Object.assign({}, line) : null
      }
      if (intent === 'block') {
        const id = NARR_BLOCK_IDS[opts.variant] || 'b4'
        return Object.assign({}, NARR_LINES[id])
      }
      return pickPool(intent) // start / done / milestone / fail
    }

    // ---------------- 意图路由与发声 ----------------
    const NARR_INTENTS = ['start', 'done', 'milestone', 'block', 'fail', 'special', 'goal']
    const narrPendingBatch = []
    let narrBatchScheduled = false

    // narrate(intent, opts)：
    //   同意图 8s 合并；同一时刻多事件由微任务批收集后取最高优先级一条；
    //   done 受 narratorDone 开关；force=true（testNarrator）绕过节流/回合内一次性标记，仍受 narratorOn/voiceOn 约束。
    function narrate(intent, opts) {
      const o = opts && typeof opts === 'object' ? opts : {}
      const now = Date.now()
      if (NARR_INTENTS.indexOf(intent) < 0) return { ok: false, reason: 'bad-intent' }
      if (config.narratorOn !== true) return { ok: false, reason: 'narrator-off' }
      if (intent === 'done' && config.narratorDone !== true && o.force !== true) return { ok: false, reason: 'done-off' }
      if (o.force !== true) {
        const last = lastSpokeByIntent.get(intent)
        if (typeof last === 'number' && now - last < NARR_INTENT_GAP_MS) return { ok: false, reason: 'merged-same-intent' }
      }
      narrPendingBatch.push({ intent, opts: o, at: now })
      if (!narrBatchScheduled) {
        narrBatchScheduled = true
        const flush = () => { narrBatchScheduled = false; flushNarrBatch() }
        if (typeof queueMicrotask === 'function') queueMicrotask(flush)
        else Promise.resolve().then(flush)
      }
      return { ok: true, queued: true }
    }

    function flushNarrBatch() {
      const batch = narrPendingBatch.splice(0, narrPendingBatch.length)
      if (batch.length === 0) return
      // 同一时刻多事件：只取最高优先级一条（BLOCK40 > FAIL30 > DONE/GOAL20 > SPECIAL15 > MILESTONE10 > START5）
      let best = batch[0]
      for (let i = 1; i < batch.length; i++) {
        const c = batch[i]
        if ((NARR_PRIORITY[c.intent] || 0) > (NARR_PRIORITY[best.intent] || 0)) best = c
      }
      deliverNarration(best.intent, best.opts).catch((e) => {
        console.error('[amadeus] 进度播报失败:', e && e.message ? e.message : String(e))
      })
    }

    // 决定台词 → 留痕 → 出声（speakSynced 队列串行，不叠播）
    // Fix R1：门检查与占位登记全部同步完成于本函数首个 await 之前——
    // flushNarrBatch 对 deliverNarration 是 fire-and-forget，两个 deliver 可真实并发；
    // JS 单线程下，只要 lastSpokeByIntent/lastDoneFamilyAt 的登记先于任一 await，
    // 并发第二个必在门处被拦（lastLLMAt 的登记在 narrateSummary 入口，同样先于其 await）。
    async function deliverNarration(intent, opts) {
      const now = Date.now()
      const force = opts.force === true
      let mySameAt = 0
      let myFamilyAt = 0
      // 同步门 + 同步占位登记（模板路径与 LLM 路径共用同一占位语义）
      if (!force) {
        if (intent === 'done' || intent === 'goal') {
          // done/goal 完成语义 8s 互斥（先到先得近似旧 announce 8s 窗；更高语义由同批优先级保证）
          if (now - lastDoneFamilyAt < NARR_INTENT_GAP_MS) return
          lastDoneFamilyAt = now
          myFamilyAt = now
        }
        // 同意图 8s 合并：受理即占位（8s 从“受理”起算，而非发声后）
        const last = lastSpokeByIntent.get(intent)
        if (typeof last === 'number' && now - last < NARR_INTENT_GAP_MS) return
        lastSpokeByIntent.set(intent, now)
        mySameAt = now
      }
      let line = null
      let source = 'template'
      const llmEligible = (intent === 'done' || intent === 'milestone') && opts.noLLM !== true
      const llmAttempted = llmEligible
      if (llmEligible) {
        const llm = await narrateSummary(intent, opts) // lastLLMAt 于 narrateSummary 入口登记（先于其 await）
        if (llm !== null) { line = llm; source = 'llm' }
      }
      if (line === null) {
        line = pickNarrLine(intent, opts)
        if (line === null) return
      }
      // LLM 返回后重核窗口：占位已被更新的同意图/同族发声取代，或窗口已过期（慢 LLM），
      // 则放弃本次发声（模板兜底同样放弃——若为取代则模板会重复；若为过期则宁缺毋滥）。
      // milestone 若被随后登记的 done/goal 完成语义接管（turn/end 在里程碑 LLM 在飞时到达）也让位，
      // 避免“还在进行中”落在“完成”之后（优先级 DONE20 > MILESTONE10 的同一语义）。
      if (llmAttempted && !force) {
        const now2 = Date.now()
        const sameReplaced = lastSpokeByIntent.get(intent) !== mySameAt
        const familyReplaced = myFamilyAt !== 0 && lastDoneFamilyAt !== myFamilyAt
        const doneTookOver = (intent !== 'done' && intent !== 'goal') && myFamilyAt === 0 &&
          lastDoneFamilyAt !== 0 && lastDoneFamilyAt >= mySameAt
        if (sameReplaced || familyReplaced || doneTookOver) return
        if (now2 - mySameAt >= NARR_INTENT_GAP_MS) return
      }
      // 留痕对话历史（沿用 announce 语义：无论语音开关都记录）
      const cnText = (typeof line.cn === 'string' && line.cn.length > 0) ? line.cn : line.jp
      memory.history.push({ role: 'assistant', jp: line.jp, cn: cnText, emotion: line.emotion || 'neutral', announce: true, narrate: intent, t: Date.now() })
      if (memory.history.length > 60) maybeCompactHistory()
      narrState.counts[intent] = (narrState.counts[intent] || 0) + 1
      lastNarrSpeaks.push({ at: Date.now(), intent, source, jp: line.jp, cn: cnText, emotion: line.emotion || 'neutral' })
      if (lastNarrSpeaks.length > 8) lastNarrSpeaks.shift()
      scheduleSaveNarrator()
      if (config.voiceOn !== true) return
      await speakSynced(line.jp, cnText, line.emotion || 'neutral', 'force', { announce: true, narrate: intent })
    }

    // ---------------- 里程碑巡检（时间/步数，单回合一次） ----------------
    function maybeMilestone() {
      if (config.narratorOn !== true) return
      if (narrState.turnActive !== true) return
      if (narrState.milestoneSpoken) return
      if (narrState.blocking) return
      if (narrState.stepCount < 1) return
      const ms = typeof config.narratorMilestoneMs === 'number' ? config.narratorMilestoneMs : 240000
      const steps = typeof config.narratorMilestoneSteps === 'number' ? config.narratorMilestoneSteps : 10
      const overTime = Date.now() - narrState.turnStartAt >= ms
      const overSteps = narrState.stepCount >= steps
      if (!overTime && !overSteps) return
      narrState.milestoneSpoken = true
      narrate('milestone', {})
    }

    // turn/end：goal 完成过 → A3（'goal'）；否则 narratorDone 时 'done'（LLM 总结/模板兜底）；随后清回合状态
    function handleTurnEnd(evData) {
      const reason = evData && typeof evData === 'object' ? evData.reason : undefined
      const kind = reason && typeof reason === 'object' ? reason.kind : (typeof reason === 'string' ? reason : undefined)
      // 非正常完成回合不播 DONE（blocked/error 已有 BLOCK/FAIL 语义；aborted/interrupted/max-tokens 无完成可言）
      const skipKinds = ['blocked', 'error', 'aborted', 'interrupted', 'max-tokens']
      if (kind !== undefined && skipKinds.indexOf(kind) >= 0) {
        narrState.turnActive = false
        return
      }
      const goalDone = narrState.turnGoalDone === true
      // 先快照回合总结输入（随后清状态，LLM 异步取快照而非被清空的 live 字段）
      const doneOpts = {
        userMsg: narrState.lastUserText,
        tools: Object.assign({}, narrState.toolNames),
        blocking: narrState.blocking,
      }
      narrState.turnActive = false
      narrState.blocking = null
      narrState.milestoneSpoken = false
      narrState.startSpoken = false
      narrState.stepCount = 0
      narrState.turnGoalDone = false
      narrState.toolNames = {}
      if (goalDone) {
        narrate('goal', {})
      } else if (config.narratorDone === true) {
        narrate('done', doneOpts)
      }
    }

    // ---------------- AI 调用（独立 key 优先，llm 服务兜底） ----------------
    async function aiCompleteHttp(system, messages, maxTokens, onDelta) {
      // 直连 OpenAI 兼容 API，stream=true：不用再起 Python 子进程、不用等整段生成完，
      // 首字延迟和整句延迟都明显更低，同时 onDelta 让日语句子边生成边朗读。
      const base = String(config.chatBaseUrl || 'https://api.deepseek.com/v1').replace(/\/+$/, '')
      const url = base.endsWith('/chat/completions') ? base : base + '/chat/completions'
      const payload = {
        model: config.chatModel || 'deepseek-chat',
        messages: [{ role: 'system', content: system }].concat(messages),
        max_tokens: maxTokens || 300,
        temperature: 0.9,
        stream: true,
      }
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + config.chatApiKey,
          'User-Agent': 'Amadeus-DSH/1.0',
        },
        body: JSON.stringify(payload),
      })
      if (!resp.ok) {
        let detail = ''
        try { detail = String((await resp.text()).slice(0, 300)) } catch (e) { /* ignore */ }
        throw new Error('llm http ' + resp.status + ' ' + detail)
      }
      const reader = resp.body && resp.body.getReader
      if (reader === undefined || !resp.body) throw new Error('llm http: stream unsupported')
      const stream = resp.body.getReader()
      const decoder = new TextDecoder('utf-8')
      let buffer = ''
      let out = ''
      while (true) {
        const step = await stream.read()
        if (step.done) break
        buffer += decoder.decode(step.value, { stream: true })
        const lines = buffer.split(/\r?\n/)
        buffer = lines.pop() || ''
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].trim()
          if (line.indexOf('data:') !== 0) continue
          const data = line.slice(5).trim()
          if (data === '[DONE]') break
          try {
            const json = JSON.parse(data)
            const delta = json && json.choices && json.choices[0] && json.choices[0].delta && json.choices[0].delta.content
            if (typeof delta === 'string' && delta.length > 0) {
              out += delta
              if (onDelta) { try { onDelta(delta) } catch (e) { /* ignore */ } }
            }
          } catch (e) { /* 忽略不完整行 */ }
        }
      }
      return out
    }

    async function aiComplete(system, messages, maxTokens, onDelta) {
      const useApi = typeof config.chatApiKey === 'string' && config.chatApiKey.length > 0
      if (useApi) {
        if (typeof fetch === 'function') {
          try {
            return await Promise.race([
              aiCompleteHttp(system, messages, maxTokens, onDelta),
              ctx.timeout(CHAT_TIMEOUT_MS).then(() => { throw new Error('llm timeout') }),
            ])
          } catch (e) {
            // 直连失败时保留 Python 子进程兜底，保证有 key 就能用
            console.error('[amadeus] llm http fallback:', e && e.message ? e.message : String(e))
          }
        }
        const slot = nextSlot()
        const reqPath = TMP_DIR + '/chat-req-' + slot + '.json'
        const outPath = TMP_DIR + '/chat-out-' + slot + '.json'
        const req = {
          baseUrl: config.chatBaseUrl || 'https://api.deepseek.com/v1',
          apiKey: config.chatApiKey,
          model: config.chatModel || 'deepseek-chat',
          system,
          messages,
          maxTokens: maxTokens || 300,
          temperature: 0.9,
        }
        await writeTextSafe(reqPath, JSON.stringify(req))
        await runPython([LLM_CHAT_PY, reqPath, outPath], 'llm_chat')
        const outText = await readTextFile(outPath)
        if (outText === null) throw new Error('llm_chat: no output')
        const parsed = JSON.parse(outText)
        if (!parsed.ok) throw new Error('llm_chat: ' + (parsed.error || 'unknown'))
        return parsed.content
      }
      const llm = ctx.get('llm')
      if (llm === undefined) throw new Error('llm service unavailable')
      const adm = ctx.get('agentDefaultModel')
      let provider = null
      let model = null
      try {
        const sel = adm ? adm.currentSelection() : undefined
        if (sel && typeof sel.provider === 'string' && typeof sel.model === 'string') {
          provider = sel.provider
          model = sel.model
        }
      } catch (e) { /* ignore */ }
      if (provider === null || model === null) {
        try {
          const providers = llm.listProviders()
          if (Array.isArray(providers) && providers.length > 0) {
            provider = providers[0].provider || providers[0].id
            const models = await llm.listModels(provider)
            if (Array.isArray(models) && models.length > 0) model = models[0].model || models[0].id
          }
        } catch (e) { /* ignore */ }
      }
      if (provider === null || model === null) throw new Error('no model available')
      const llmMessages = messages.map((m) => ({
        id: 'amad-' + Math.random().toString(36).slice(2, 10),
        role: m.role,
        content: [{ type: 'text', text: m.content }],
        source: { kind: 'plugin', plugin: 'amadeus' },
      }))
      const options = {
        provider,
        model,
        messages: llmMessages,
        system,
        temperature: 0.9,
        maxTokens: maxTokens || 300,
      }
      let out = ''
      for await (const chunk of llm.stream(options)) {
        if (chunk === null || typeof chunk !== 'object') continue
        if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
          out += chunk.text
          if (onDelta) { try { onDelta(chunk.text) } catch (e) { /* ignore */ } }
        }
        if (chunk.type === 'finish') break
      }
      return out
    }

    function parseStructured(raw) {
      const text = String(raw || '').trim()
      let emotion = 'neutral'
      let jp = ''
      let cn = ''
      const tagMatch = text.match(/【(happy|excited|elated|sad|angry|furious|question|soft|neutral)】/)
      if (tagMatch) emotion = tagMatch[1]
      const jpMatch = text.match(/JP[:：]\s*([\s\S]*?)(?=\nCN[:：]|$)/)
      if (jpMatch) jp = jpMatch[1].trim().replace(/【(happy|excited|elated|sad|angry|furious|question|soft|neutral)】/g, '')
      const cnMatch = text.match(/CN[:：]\s*([\s\S]*?)$/)
      if (cnMatch) cn = cnMatch[1].trim()
      if (jp.length === 0 && cn.length === 0) {
        cn = text.replace(/【(happy|excited|elated|sad|angry|furious|question|soft|neutral)】/g, '').replace(/JP[:：].*/, '').replace(/CN[:：].*/, '').trim()
      }
      if (cn.length === 0) cn = jp
      if (jp.length === 0) jp = cn
      // 兜底：AI 回复格式允许 1〜3 句，超过 3 句直接截断，短回复不硬凑。
      const jpParts = splitSentences(jp).slice(0, 3)
      if (jpParts.length > 0) jp = jpParts.join('')
      const cnParts = splitSentences(cn).slice(0, 3)
      if (cnParts.length > 0) cn = cnParts.join('')
      return { emotion, jp, cn }
    }

    // ---------------- Amadeus 聊天 ----------------
    async function amadeusChat(text, onDelta) {
      const persona = await readChatPersona()
      const facts = factsText()
      const summary = memory.summary ? '過去の会話の要約：\n' + memory.summary : ''
      const system = persona + (summary ? '\n\n' + summary : '') + (facts ? '\n\n' + facts : '') + CHAT_FORMAT_RULES
      const history = memory.history.slice(-10).map((m) => ({
        role: m.role === 'user' ? 'user' : 'assistant',
        content: m.role === 'user' ? m.content : ('【' + (m.emotion || 'neutral') + '】\nJP: ' + m.jp + '\nCN: ' + m.cn),
      }))
      const messages = history.concat([{ role: 'user', content: text }])
      let streamedSegments = false
      let streamRaw = ''
      let streamEmotion = 'neutral'
      let pushedJpSentences = 0
      let firstSegmentPushed = false
      let pendingBatch = ''
      let pendingCount = 0
      const flushBatch = (emotion) => {
        if (pendingBatch.trim().length > 0) {
          pushUtterances([pendingBatch.trim()], false, emotion || streamEmotion || 'neutral')
          pendingBatch = ''
          pendingCount = 0
        }
      }
      const wrappedDelta = (delta) => {
        if (onDelta) { try { onDelta(delta) } catch (e) { /* ignore */ } }
        streamRaw += delta
        streamedSegments = true
        const tagMatch = streamRaw.match(/【(happy|excited|elated|sad|angry|furious|question|soft|neutral)】/)
        if (tagMatch) streamEmotion = tagMatch[1]
        const jpM = streamRaw.match(/JP[:：]\s*([\s\S]*?)(?=\nCN[:：]|$)/)
        const jp = jpM ? jpM[1] : ''
        const sentences = splitSentences(jp)
        let completeCount = sentences.length
        if (completeCount > 0 && !/[。！？!?…]$/.test(sentences[completeCount - 1])) {
          completeCount--
        }
        for (let i = pushedJpSentences; i < completeCount && pushedJpSentences < 3; i++) {
          const rawS = sentences[i]
          if (!rawS || rawS.trim().length === 0) continue
          const segTag = rawS.match(/^【(happy|excited|elated|sad|angry|furious|question|soft|neutral)】/)
          const segEmotion = segTag ? segTag[1] : streamEmotion
          const s = segTag ? rawS.slice(segTag[0].length).trim() : rawS
          if (!s) continue
          // 每句完整后立即推送，短回复和多条消息都能马上出声，避免句间等待
          pushUtterances([s], false, segEmotion || emotionFor(s) || streamEmotion)
          firstSegmentPushed = true
          pushedJpSentences++
        }
        pushedJpSentences = Math.min(3, Math.max(pushedJpSentences, completeCount))
      }
      const raw = await aiComplete(system, messages, 360, wrappedDelta)
      const parsed = parseStructured(raw)
      // 流式模式下，把最后可能未推送的剩余日语句子补上
      if (streamedSegments) {
        const finalSentences = splitSentences(parsed.jp)
        for (let i = pushedJpSentences; i < finalSentences.length && pushedJpSentences < 3; i++) {
          const rawS = finalSentences[i]
          if (!rawS || rawS.trim().length === 0) continue
          const segTag = rawS.match(/^【(happy|excited|elated|sad|angry|furious|question|soft|neutral)】/)
          const segEmotion = segTag ? segTag[1] : (parsed.emotion || streamEmotion)
          const s = segTag ? rawS.slice(segTag[0].length).trim() : rawS
          if (!s) continue
          // 同样逐句立即推送，避免最后剩余句子被合并延迟
          pushUtterances([s], false, segEmotion || emotionFor(s) || parsed.emotion || streamEmotion)
          firstSegmentPushed = true
          pushedJpSentences++
        }
        flushBatch(emotionFor(pendingBatch) || parsed.emotion || streamEmotion || 'neutral')
        parsed._streamed = true
      }
      memory.history.push({ role: 'user', content: text, t: Date.now() })
      lastInteractionAt = Date.now()
      memory.history.push({ role: 'assistant', jp: parsed.jp, cn: parsed.cn, emotion: parsed.emotion, t: Date.now() })
      scheduleSaveMemory()
      maybeMaintainFacts()
      maybeCompactHistory()
      return parsed
    }

    async function maybeMaintainFacts() {
      const exchangeCount = memory.history.filter((m) => m.role === 'assistant').length
      if (exchangeCount % 10 !== 0 || exchangeCount === 0) return
      try {
        const lines = memory.history.slice(-20).map((m) => (m.role === 'user' ? 'ユーザー: ' + m.content : '祥子: ' + (m.cn || m.jp))).join('\n')
        const system = '以下はユーザーと祥子の会話記録です。ユーザーについての重要な長期的事実（好み、身分、進行中のプロジェクト、関係、習慣など）を抽出し、一行一項目の簡潔なリストで出力してください。既存の事実は：\n- ' + (memory.facts || []).join('\n- ') + '\n\n既存の事実と重複するものは含めず、新しい事実のみ最大5件出力。新しい事実がなければ「なし」とだけ出力。'
        const raw = await aiComplete(system, [{ role: 'user', content: lines }], 300)
        const newFacts = String(raw).split(/\n+/).map((s) => s.replace(/^[-•・]\s*/, '').trim()).filter((s) => s.length > 2 && s.length < 120 && s !== 'なし' && !/^なし/.test(s)).slice(0, 5)
        for (const f of newFacts) {
          if (memory.facts.indexOf(f) < 0) memory.facts.push(f)
        }
        if (memory.facts.length > 30) memory.facts.splice(0, memory.facts.length - 30)
        scheduleSaveMemory()
      } catch (e) {
        console.error('[amadeus] 记忆维护失败:', e && e.message ? e.message : e)
      }
    }

    async function maybeCompactHistory() {
      // 只保留最近 30 条，更早的对话压缩成 summary，避免无限堆积原始聊天记录。
      if (memory.history.length <= 60) return
      const keep = memory.history.slice(-30)
      const old = memory.history.slice(0, memory.history.length - 30)
      memory.history = keep
      if (old.length < 8) {
        scheduleSaveMemory()
        return
      }
      try {
        const lines = old.map((m) => (m.role === 'user' ? 'ユーザー: ' + m.content : '祥子: ' + (m.cn || m.jp))).join('\n')
        const system = '以下は古い会話ログです。重要な出来事、ユーザーの好み、約束、進行中タスクだけを簡潔に要約してください。無関係な雑談や挨拶は含めない。3〜6行以内で。'
        const raw = await aiComplete(system, [{ role: 'user', content: lines }], 300)
        const summary = String(raw || '').trim()
        if (summary.length > 10) {
          memory.summary = ((memory.summary || '') + '\n' + summary).trim()
          if (memory.summary.length > 2000) memory.summary = memory.summary.slice(-2000)
        }
      } catch (e) {
        console.error('[amadeus] 历史压缩失败:', e && e.message ? e.message : e)
      }
      scheduleSaveMemory()
    }

    // ---------------- 主动来电 ----------------
    async function triggerCall() {
      try {
        let line = null
        try {
          const raw = await aiComplete(CALL_SYSTEM, [], 200)
          line = parseStructured(raw)
        } catch (e) { /* fallback */ }
        if (line === null) {
          const pick = CALL_CANNED[Math.floor(Math.random() * CALL_CANNED.length)]
          line = { emotion: pick.emotion, jp: pick.jp, cn: pick.cn }
        }
        memory.lastCallAt = Date.now()
        lastInteractionAt = Date.now()
        memory.callCount = (memory.callCount || 0) + 1
        memory.history.push({ role: 'assistant', jp: line.jp, cn: line.cn, emotion: line.emotion, call: true, t: Date.now() })
        if (memory.history.length > 60) maybeCompactHistory()
        scheduleSaveMemory()
        await speakSynced(line.jp, line.cn, line.emotion, 'call')
        console.log('[amadeus] 主动来电:', line.jp)
      } catch (e) {
        console.error('[amadeus] 主动来电失败:', e && e.message ? e.message : e)
      }
    }

    function checkCalls() {
      if (config.callOn !== true) return
      if (config.voiceOn !== true) return
      const now = Date.now()
      if (memory.lastCallAt === 0) {
        memory.lastCallAt = now
        scheduleSaveMemory()
        return
      }
      const interval = typeof config.callIntervalMs === 'number' && config.callIntervalMs > 0 ? config.callIntervalMs : 36000000
      if (now - memory.lastCallAt >= interval) {
        triggerCall()
      }
    }

    async function idleChatter() {
      try {
        const raw = await aiComplete(IDLE_SYSTEM, [], 200)
        const line = parseStructured(raw)
        if (line.jp.length === 0 && line.cn.length === 0) return
        if (line.jp.length === 0) line.jp = line.cn
        if (line.cn.length === 0) line.cn = line.jp
        memory.history.push({ role: 'assistant', jp: line.jp, cn: line.cn, emotion: line.emotion, idle: true, t: Date.now() })
        if (memory.history.length > 60) maybeCompactHistory()
        scheduleSaveMemory()
        await speakSynced(line.jp, line.cn, line.emotion, 'idle', { idle: true })
        console.log('[amadeus] 空闲闲聊:', line.jp)
      } catch (e) {
        console.error('[amadeus] 空闲闲聊失败:', e && e.message ? e.message : e)
      }
    }

    function checkIdle() {
      if (config.idleChatOn !== true) return
      if (config.voiceOn !== true) return
      const ms = typeof config.idleChatMs === 'number' && config.idleChatMs > 0 ? config.idleChatMs : 1200000
      if (Date.now() - lastInteractionAt >= ms) {
        lastInteractionAt = Date.now()
        idleChatter().catch((e) => console.error('[amadeus] 空闲闲聊失败:', e && e.message ? e.message : e))
      }
    }

    // ---------------- HTTP 响应助手 ----------------
    function sendJson(res, code, obj) {
      const body = JSON.stringify(obj)
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(body)
    }

    function sendBytes(res, code, bytes, headers) {
      const h = Object.assign({ 'Content-Length': String(bytes.length) }, headers || {})
      res.writeHead(code, h)
      res.end(bytes)
    }

    function readBody(req, maxBytes) {
      return new Promise((resolve, reject) => {
        const chunks = []
        let size = 0
        req.on('data', (c) => {
          size += c.length
          if (size > maxBytes) {
            reject(new Error('body too large'))
            try { req.destroy() } catch (e) { /* ignore */ }
            return
          }
          chunks.push(c)
        })
        req.on('end', () => {
          try { resolve(Buffer.concat(chunks)) } catch (e) { reject(e) }
        })
        req.on('error', reject)
      })
    }

    function toBase64(buf) {
      if (typeof Buffer !== 'undefined') return Buffer.from(buf).toString('base64')
      // 极老环境兜底
      let s = ''
      for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i])
      return btoa(s)
    }

    async function transcribeAudio(audioBuf, lang) {
      const slot = nextSlot()
      const b64Path = TMP_DIR + '/stt-upload-' + slot + '.b64'
      const outPath = TMP_DIR + '/stt-out-' + slot + '.json'
      await writeTextSafe(b64Path, toBase64(audioBuf))
      const baseUrl = config.sttApiUrl || config.chatBaseUrl || 'https://api.openai.com/v1'
      const apiKey = config.sttApiKey || config.chatApiKey || ''
      if (!apiKey) throw new Error('STT: missing API key')
      await runPython([
        STT_PY,
        b64Path,
        outPath,
        baseUrl,
        apiKey,
        config.sttModel || 'whisper-1',
        lang || '',
      ], 'stt')
      const outText = await readTextFile(outPath)
      if (outText === null) throw new Error('STT: no output')
      const parsed = JSON.parse(outText)
      if (!parsed.ok) throw new Error('STT: ' + (parsed.error || 'unknown'))
      return parsed.text
    }

    async function serveFile(res, absPath, maxBytes, cache) {
      let bytes
      try {
        bytes = await readFileBytes(absPath, maxBytes)
      } catch (e) {
        res.writeHead(404)
        res.end('not found')
        return
      }
      if (bytes === null) {
        res.writeHead(404)
        res.end('not found')
        return
      }
      sendBytes(res, 200, bytes, { 'Content-Type': mimeFor(absPath), 'Cache-Control': cache || 'no-cache' })
    }

    async function serveManifest(res) {
      const now = Date.now()
      if (manifestCache.value !== null && now - manifestCache.at < 5000) {
        sendJson(res, 200, manifestCache.value)
        return
      }
      try {
        const bytes = await readFileBytes(MANIFEST_PATH, 65536)
        if (bytes === null) {
          sendJson(res, 200, { models: [], image: '', placeholder: true })
          return
        }
        const m = JSON.parse(new TextDecoder('utf-8').decode(bytes))
        const models = (Array.isArray(m.models) ? m.models : []).map((x) => ({
          url: typeof x.url === 'string' ? x.url : '',
          format: x.format === 'cubism4' ? 'cubism4' : 'cubism2',
          scale: typeof x.scale === 'number' ? x.scale : 1,
          layout: (x.layout && typeof x.layout === 'object') ? x.layout : undefined,
        })).filter((x) => x.url.length > 0)
        const image = typeof m.image === 'string' && m.image.length > 0 ? '/amadeus/assets/' + m.image : ''
        const value = { models, image, placeholder: m.placeholder !== false }
        manifestCache = { at: now, value }
        sendJson(res, 200, value)
      } catch (e) {
        sendJson(res, 200, { models: [], image: '', placeholder: true })
      }
    }

    // ---------------- 路由 ----------------
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/amadeus/tts',
      handler: async (req, res) => {
        try {
          const q = parseQuery(req.url)
          const text = typeof q.text === 'string' ? q.text.trim() : ''
          if (text.length === 0) { sendJson(res, 400, { error: 'missing text' }); return }
          if (text.length > 300) { sendJson(res, 400, { error: 'text too long' }); return }
          const voice = typeof q.voice === 'string' && VOICES.indexOf(q.voice) >= 0 ? q.voice : config.voiceName
          const rate = typeof q.rate === 'string' && RATES.indexOf(q.rate) >= 0 ? q.rate : config.rate
          const pitch = typeof q.pitch === 'string' && PITCHES.indexOf(q.pitch) >= 0 ? q.pitch : config.pitch
          const emotion = typeof q.emotion === 'string' && EMOTIONS.indexOf(q.emotion) >= 0 ? q.emotion : 'neutral'
          const entry = await synthesize(text, voice, rate, pitch, emotion)
          const wordsHeader = (entry.words && entry.words.length > 0) ? Buffer.from(JSON.stringify(entry.words)).toString('base64') : ''
          sendBytes(res, 200, entry.bytes, { 'Content-Type': entry.mime || 'audio/mpeg', 'Cache-Control': 'public, max-age=3600', 'X-Amadeus-Words': wordsHeader })
        } catch (e) {
          sendJson(res, 502, { error: e && e.message ? e.message : String(e) })
        }
      },
    }))

    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/amadeus/ttsmeta',
      handler: async (req, res) => {
        try {
          const q = parseQuery(req.url)
          const text = typeof q.text === 'string' ? q.text.trim() : ''
          if (text.length === 0 || text.length > 300) { sendJson(res, 200, { words: [] }); return }
          const voice = typeof q.voice === 'string' && VOICES.indexOf(q.voice) >= 0 ? q.voice : config.voiceName
          const rate = typeof q.rate === 'string' && RATES.indexOf(q.rate) >= 0 ? q.rate : config.rate
          const pitch = typeof q.pitch === 'string' && PITCHES.indexOf(q.pitch) >= 0 ? q.pitch : config.pitch
          const emotion = typeof q.emotion === 'string' && EMOTIONS.indexOf(q.emotion) >= 0 ? q.emotion : 'neutral'
          const entry = await synthesize(text, voice, rate, pitch, emotion)
          const words = entry.words || []
          const totalMs = words.reduce((s, w) => s + (w.d || 0), 0)
          sendJson(res, 200, { words, totalMs })
        } catch (e) {
          sendJson(res, 200, { words: [] })
        }
      },
    }))

    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/amadeus/stt',
      handler: async (req, res) => {
        noteHost(req)
        try {
          const q = parseQuery(req.url)
          const lang = typeof q.lang === 'string' ? q.lang.slice(0, 10) : ''
          const buf = await readBody(req, 20 * 1024 * 1024)
          if (buf === null || buf.length < 100) {
            sendJson(res, 400, { error: 'missing audio' })
            return
          }
          const text = await transcribeAudio(buf, lang)
          sendJson(res, 200, { ok: true, text })
        } catch (e) {
          sendJson(res, 502, { ok: false, error: e && e.message ? e.message : String(e) })
        }
      },
    }))

    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/amadeus/poll',
      handler: async (req, res) => {
        noteHost(req)
        const q = parseQuery(req.url)
        let after = Number(q.after)
        if (!isFinite(after)) after = -1
        let items = []
        if (after >= 0) {
          items = queue.filter((u) => u.id > after).map((u) => ({ id: u.id, kind: u.kind || 'say', text: u.text, cn: u.cn || '', force: !!u.force, emotion: u.emotion || 'neutral', expr: u.expr || '', ts: u.ts || 0, announce: u.announce === true, idle: u.idle === true }))
          const served = new Set(items.map((u) => u.id))
          queue = queue.filter((u) => !served.has(u.id))
        }
        sendJson(res, 200, {
          cursor: maxIssuedId,
          config,
          utterances: items,
          tts: config.provider,
        })
      },
    }))

    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/amadeus/chat',
      handler: async (req, res) => {
        noteHost(req)
        try {
          if (config.chatOn !== true) { sendJson(res, 403, { error: 'chat disabled' }); return }
          const q = parseQuery(req.url)
          const text = typeof q.text === 'string' ? q.text.trim() : ''
          if (text.length === 0) { sendJson(res, 400, { error: 'missing text' }); return }
          if (text.length > 500) { sendJson(res, 400, { error: 'text too long' }); return }
          lastInteractionAt = Date.now()
          if (chatBusy) { sendJson(res, 429, { error: 'busy' }); return }
          chatBusy = true
          const chatId = ++chatSeq
          chatStreams.set(chatId, { status: 'running', raw: '', jp: '', cn: '', emotion: 'neutral', at: Date.now() })
          // 清理旧流
          const nowMs = Date.now()
          for (const [k, v] of chatStreams) {
            if (k !== chatId && nowMs - v.at > 300000) chatStreams.delete(k)
          }
          ;(async () => {
            try {
              const result = await Promise.race([
                amadeusChat(text, (delta) => {
                  const s = chatStreams.get(chatId)
                  if (s && typeof delta === 'string') s.raw += delta
                }),
                ctx.timeout(CHAT_TIMEOUT_MS).then(() => { throw new Error('llm timeout') }),
              ])
              const s = chatStreams.get(chatId)
              if (s) {
                s.status = 'done'
                s.jp = result.jp
                s.cn = result.cn
                s.emotion = result.emotion
                s.streamed = result._streamed === true
              }
            } catch (e) {
              const s = chatStreams.get(chatId)
              if (s) {
                s.status = 'error'
                s.error = e && e.message ? e.message : String(e)
              }
            } finally {
              chatBusy = false
            }
          })()
          sendJson(res, 200, { ok: true, chatId })
        } catch (e) {
          chatBusy = false
          sendJson(res, 502, { error: e && e.message ? e.message : String(e) })
        }
      },
    }))

    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/amadeus/chatstream',
      handler: async (req, res) => {
        noteHost(req)
        const q = parseQuery(req.url)
        const chatId = Number(q.chatId)
        const s = chatStreams.get(chatId)
        if (s === undefined) { sendJson(res, 200, { status: 'missing' }); return }
        sendJson(res, 200, {
          status: s.status,
          raw: String(s.raw || '').slice(-2400),
          jp: s.jp || '',
          cn: s.cn || '',
          emotion: s.emotion || 'neutral',
          streamed: s.streamed === true,
          error: s.error || '',
        })
      },
    }))

    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/amadeus/chatfull',
      handler: async (req, res) => {
        noteHost(req)
        try {
          if (config.chatOn !== true) { sendJson(res, 403, { error: 'chat disabled' }); return }
          const q = parseQuery(req.url)
          const text = typeof q.text === 'string' ? q.text.trim() : ''
          if (text.length === 0) { sendJson(res, 400, { error: 'missing text' }); return }
          if (text.length > 500) { sendJson(res, 400, { error: 'text too long' }); return }
          lastInteractionAt = Date.now()
          if (chatBusy) { sendJson(res, 429, { error: 'busy' }); return }
          chatBusy = true
          try {
            const result = await Promise.race([
              amadeusChat(text),
              ctx.timeout(CHAT_TIMEOUT_MS).then(() => { throw new Error('llm timeout') }),
            ])
            sendJson(res, 200, { ok: true, jp: result.jp, cn: result.cn, emotion: result.emotion })
          } finally {
            chatBusy = false
          }
        } catch (e) {
          sendJson(res, 502, { error: e && e.message ? e.message : String(e) })
        }
      },
    }))

    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/amadeus/action',
      handler: async (req, res) => {
        noteHost(req)
        const q = parseQuery(req.url)
        const cmd = typeof q.cmd === 'string' ? q.cmd : ''
        if (cmd === 'close') {
          pendingClose = Date.now()
          sendJson(res, 200, { ok: true, pendingClose })
          return
        }
        if (cmd === 'ackcall') {
          callPending = false
          sendJson(res, 200, { ok: true })
          return
        }
        if (cmd === 'ping') { sendJson(res, 200, { ok: true }); return }
        sendJson(res, 400, { error: 'unknown cmd' })
      },
    }))

    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/amadeus/memory',
      handler: async (req, res) => {
        noteHost(req)
        sendJson(res, 200, {
          history: memory.history.slice(-50),
          facts: memory.facts.slice(-30),
          summary: memory.summary || '',
          lastCallAt: memory.lastCallAt,
          callCount: memory.callCount || 0,
        })
      },
    }))

    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/amadeus/diag',
      handler: async (req, res) => {
        noteHost(req)
        const out = { ok: false }
        try {
          out.spAvailable = sandboxPolicy !== undefined
          if (sandboxPolicy !== undefined) {
            try { out.defaultMode = String(sandboxPolicy.defaultMode) } catch (e) { out.defaultModeErr = String(e) }
            try { out.workspaceRoot = String(sandboxPolicy.workspaceRoot) } catch (e) { out.wsErr = String(e) }
            try {
              const p0 = sandboxPolicy.resolve()
              out.resolveDefault = p0
            } catch (e) { out.resolveErr = String(e) }
            try {
              const p1 = sandboxPolicy.resolve({ mode: 'danger-full-access' })
              out.resolveDanger = p1
            } catch (e) { out.resolveDangerErr = String(e) }
          }
          const t = await fs.resolve(MEMORY_PATH)
          out.processPath = typeof fs.processPath === 'function' ? fs.processPath(t) : 'n/a'
          const probePath = TMP_DIR + '/diag-probe.json'
          const probe = await fs.resolve(probePath)
          try {
            const oc = await fs.writeText(probe, '{"ok":true}', undefined, undefined, undefined)
            out.probeNoPolicy = oc
          } catch (e) {
            out.probeNoPolicyErr = e && e.message ? e.message : String(e)
          }
          try {
            let dp
            try { dp = sandboxPolicy !== undefined ? sandboxPolicy.resolve({ mode: 'danger-full-access' }) : undefined } catch (e) { /* ignore */ }
            const oc2 = await fs.writeText(probe, '{"ok":true}', undefined, undefined, dp)
            out.probeDanger = oc2
          } catch (e) {
            out.probeDangerErr = e && e.message ? e.message : String(e)
          }
          out.ok = true
        } catch (e) {
          out.error = e && e.message ? e.message : String(e)
        }
        sendJson(res, 200, out)
      },
    }))

    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/amadeus/manifest',
      handler: async (req, res) => { await serveManifest(res) },
    }))

    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/amadeus/panel.html',
      handler: async (req, res) => { await serveFile(res, ROOT + '/plugin/web/panel.html', 262144, 'no-cache') },
    }))

    ctx.effect(() => webServer.register({
      kind: 'prefix',
      path: '/amadeus/web',
      handler: async (req, res) => {
        const pathname = req.url.split('?')[0]
        const rel = safeRel(pathname.slice('/amadeus/web'.length))
        if (rel === null) { res.writeHead(404); res.end(); return }
        await serveFile(res, ROOT + '/plugin/web' + rel, MAX_ASSET_BYTES, 'no-cache')
      },
    }))

    ctx.effect(() => webServer.register({
      kind: 'prefix',
      path: '/amadeus/assets',
      handler: async (req, res) => {
        let pathname
        try { pathname = req.url.split('?')[0] } catch (e) { res.writeHead(400); res.end(); return }
        const rel = safeRel(pathname.slice('/amadeus/assets'.length))
        if (rel === null) { res.writeHead(404); res.end(); return }
        await serveFile(res, ROOT + '/assets' + rel, MAX_ASSET_BYTES, 'public, max-age=3600')
      },
    }))

    // ---------------- RPC ----------------
    ctx.effect(() => harnessLocal.handle('getStatus', async () => ({
      config,
      tts: config.provider,
      queue: queue.length,
      cache: ttsCache.size,
      callPending,
      pendingClose,
    })))

    // 进度叙事状态（供验证：回合状态 / 各意图计数 / 台词池游标与最近发声）
    ctx.effect(() => harnessLocal.handle('narratorStatus', async () => {
      const now = Date.now()
      return {
        config: {
          narratorOn: config.narratorOn,
          narratorLLMSummary: config.narratorLLMSummary,
          narratorDone: config.narratorDone,
          narratorMilestoneMs: config.narratorMilestoneMs,
          narratorMilestoneSteps: config.narratorMilestoneSteps,
        },
        state: {
          turnActive: narrState.turnActive,
          runningMs: narrState.turnActive ? now - narrState.turnStartAt : 0,
          stepCount: narrState.stepCount,
          startSpoken: narrState.startSpoken,
          milestoneSpoken: narrState.milestoneSpoken,
          turnGoalDone: narrState.turnGoalDone,
          blocking: narrState.blocking,
          lastUserText: String(narrState.lastUserText || '').slice(0, 100),
          toolNames: narrState.toolNames || {},
        },
        summary: { lastSummary: narrState.lastSummary, lastLLMAt: narrState.lastLLMAt },
        counts: narrState.counts,
        poolCursor: narrState.poolCursor,
        poolLastUsed: Object.fromEntries(poolLastUsed),
        lastSpokeByIntent: Object.fromEntries(lastSpokeByIntent),
        lastDoneFamilyAt,
        lastSpeaks: lastNarrSpeaks.slice(-8),
      }
    }))

    // 进度叙事发声测试：强制触发对应意图（绕过节流与回合内一次性标记；仍受 narratorOn/voiceOn 约束）
    ctx.effect(() => harnessLocal.handle('testNarrator', async (args) => {
      const intent = args && typeof args.intent === 'string' ? args.intent : ''
      if (['start', 'done', 'block', 'milestone', 'fail', 'goal'].indexOf(intent) < 0) {
        return { ok: false, error: 'intent 需为 start|done|block|milestone|fail|goal' }
      }
      let variant
      if (intent === 'block') {
        variant = (args && typeof args.variant === 'string' && NARR_BLOCK_IDS[args.variant]) ? args.variant : 'b4'
      }
      // testNarrator 走模板句（noLLM），避免空上下文等 LLM 造成测试不确定
      const res = narrate(intent, { force: true, variant, noLLM: true })
      return { ok: res.ok, intent, reason: res.reason || '', variant: variant || undefined }
    }))

    ctx.effect(() => harnessLocal.handle('setConfig', async (patch) => {
      const clean = sanitizePatch(patch)
      config = Object.assign({}, config, clean)
      await saveConfig()
      return config
    }))

    ctx.effect(() => harnessLocal.handle('testChat', async () => {
      try {
        const content = await aiComplete(
          'You are a helpful assistant.',
          [{ role: 'user', content: 'Reply with exactly: OK' }],
          20
        )
        return { ok: true, content: String(content || '').slice(0, 200) }
      } catch (e) {
        return { ok: false, error: e && e.message ? e.message : String(e) }
      }
    }))

    ctx.effect(() => harnessLocal.handle('say', async (args) => {
      const text = args && typeof args.text === 'string' ? args.text : ''
      const sentences = splitSentences(text)
      if (sentences.length === 0) return { ok: false }
      // 逐句先合成再入队，保证点到即有声音（不出现队列先行、声音干等）
      for (const s of sentences) {
        try { await synthesize(s, config.voiceName, config.rate, config.pitch, emotionFor(s)) } catch (e) { /* 合成失败跳过，面板侧无声=链路自检 */ }
      }
      pushUtterances(sentences, true, emotionFor(text))
      lastSpokenText = text.trim()
      return { ok: true, count: sentences.length }
    }))

    ctx.effect(() => harnessLocal.handle('repeat', async () => {
      let text = lastSpokenText
      if (text.length === 0) text = '申し遅れました 私 豊川祥子と申します'
      const sentences = splitSentences(text)
      for (const s of sentences) {
        try { await synthesize(s, config.voiceName, config.rate, config.pitch, emotionFor(s)) } catch (e) { /* ignore */ }
      }
      pushUtterances(sentences, true, emotionFor(text))
      return { ok: true, count: sentences.length }
    }))

    ctx.effect(() => harnessLocal.handle('clear', async () => {
      queue = []
      return { ok: true }
    }))

    ctx.effect(() => harnessLocal.handle('testCall', async () => {
      await triggerCall()
      return { ok: true }
    }))

    ctx.effect(() => harnessLocal.handle('ackCall', async () => {
      callPending = false
      return { ok: true }
    }))

    ctx.effect(() => harnessLocal.handle('ackClose', async () => {
      pendingClose = null
      return { ok: true }
    }))

    ctx.effect(() => harnessLocal.handle('clientReport', async (args) => {
      const msg = args && typeof args.msg === 'string' ? args.msg.slice(0, 300) : ''
      if (msg.length > 0) {
        clientReports.push({ t: new Date().toISOString(), msg: '[ui] ' + msg })
        if (clientReports.length > 60) clientReports.shift()
      }
      return { ok: true }
    }))

    const clientReports = []
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/amadeus/report',
      handler: async (req, res) => {
        try {
          const q = parseQuery(req.url)
          const msg = typeof q.msg === 'string' ? q.msg.slice(0, 400) : ''
          if (msg.length > 0) {
            clientReports.push({ t: new Date().toISOString(), msg })
            if (clientReports.length > 60) clientReports.shift()
          }
          sendJson(res, 200, { ok: true })
        } catch (e) {
          sendJson(res, 200, { ok: false })
        }
      },
    }))

    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/amadeus/logs',
      handler: async (req, res) => { sendJson(res, 200, { reports: clientReports }) },
    }))

    // ---------------- 进度叙事：会话事件 → 意图路由 ----------------
    // 助手输出的文本一律不朗读；会话进度由下方 dispatcher 归一为 narrate() 意图播报。
    // 事件→意图（实测 dsh-session known-event-types：tool/call、approval/asked 均在 session/event 流内）：
    //   user/message → 清 blocking + resetTurn（不开口）
    //   turn/start → resetTurn
    //   tool/call（回合首个）→ START；累计 stepCount/工具名（里程碑步数依据）
    //   approval/asked → BLOCK B1；approval/decided → 清 blocking
    //   assistant/message 含 ask_user_question → BLOCK B2；含 exit_plan_mode → BLOCK B3（计划审批）；含 goal 完成类调用 → turnGoalDone
    //   goal/change operation=complete → turnGoalDone（不直接播，等 turn/end 归一 A3）
    //   turn/end → handleTurnEnd()：goal 完成过 → 'goal'（A3）；否则 'done'（LLM/模板）；随后清回合状态
    ctx.effect(() => ctx.on('session/event', (session, event) => {
      try {
        if (event === null || typeof event !== 'object') return
        const t = event.type
        const d = event.data
        if (t === 'user/message') {
          // 用户新消息到来：解除阻塞标记、记录输入、开启新回合（纯聊天回合不开口）
          narrState.blocking = null
          const text = userMessageText(d).slice(0, 200)
          if (text.length > 0) narrState.lastUserText = text
          resetTurn()
          return
        }
        if (t === 'turn/start') {
          resetTurn()
          return
        }
        if (t === 'turn/end') {
          handleTurnEnd(d)
          return
        }
        if (t === 'tool/call') {
          // 有据开工：回合首个工具调用 → START（每回合一次，由 startSpoken 保证）
          narrState.stepCount += 1
          const name = d && typeof d === 'object' ? String(d.name || '') : ''
          if (name.length > 0) narrState.toolNames[name] = (narrState.toolNames[name] || 0) + 1
          if (!narrState.startSpoken) {
            narrState.startSpoken = true
            narrate('start', {})
          }
          // 步数型里程碑即时检查（时间型由 30s 巡检兜底）
          const steps = typeof config.narratorMilestoneSteps === 'number' ? config.narratorMilestoneSteps : 10
          if (!narrState.milestoneSpoken && narrState.stepCount >= steps) maybeMilestone()
          return
        }
        if (t === 'approval/asked') {
          // 权限审批等待 → BLOCK B1（对 payload 防御式取用）
          narrState.blocking = 'b1'
          narrate('block', { variant: 'b1' })
          return
        }
        if (t === 'approval/decided') {
          // 审批已有答复：解除阻塞（不开口）
          if (narrState.blocking) narrState.blocking = null
          return
        }
        if (t === 'goal/change') {
          const gd = d
          if (gd && typeof gd === 'object' && typeof gd.operation === 'string') {
            if (gd.operation === 'complete') narrState.turnGoalDone = true
          }
          return
        }
        if (t === 'assistant/message') {
          const msg = d && d.message
          if (msg && typeof msg === 'object') {
            if (msgHasToolCall(msg, ['ask_user_question'])) {
              narrState.blocking = 'b2'
              narrate('block', { variant: 'b2' })
            } else if (msgHasToolCall(msg, ['exit_plan_mode'])) {
              narrState.blocking = 'b3'
              narrate('block', { variant: 'b3' })
            }
            if (msgHasGoalDoneCall(msg)) narrState.turnGoalDone = true
          }
          return
        }
        // assistant/chunk、step/*、todo/write 等其它事件：不开口
      } catch (e) {
        console.error('[amadeus] session/event 处理失败:', e && e.message ? e.message : String(e))
      }
    }))

    // ---------------- 旧零散播报收编（统一进 narrate 路由器） ----------------
    // 注：goal 完成由 session 事件流 goal/change + assistant/message 工具扫描置 turnGoalDone，
    //     turn/end 统一归一为 A3（goal）/DONE（普通）——goal/changed 是 agent 作用域事件，全局插件收不到，勿再依赖。
    // 子代理结束 → special A4-1；工作流完成/出错 → special A4-2/A4-3；后台任务结束 → special A4-4；agent/error → FAIL F1/F2
    ctx.effect(() => ctx.on('subagent/end', (info) => {
      try {
        if (info && info.stopReason) narrate('special', { variant: 'subagent' })
      } catch (e) { /* ignore */ }
    }))

    ctx.effect(() => ctx.on('workflow/end', (info, result) => {
      try {
        narrate('special', { variant: (result && result.error) ? 'workflowErr' : 'workflowOk' })
      } catch (e) { /* ignore */ }
    }))

    ctx.effect(() => ctx.on('agent/error', (payload) => {
      try {
        if (payload && payload.error) narrate('fail', {})
      } catch (e) { /* ignore */ }
    }))

    const jobs = ctx.get('jobs')
    if (jobs !== undefined) {
      ctx.effect(() => jobs.onJobDone(() => {
        try { narrate('special', { variant: 'jobDone' }) } catch (e) { /* ignore */ }
      }))
    }

    // ---------------- 主动来电 / 空闲调度 ----------------
    ctx.effect(() => ctx.interval(() => {
      try { checkCalls() } catch (e) { /* ignore */ }
      try { checkIdle() } catch (e) { /* ignore */ }
    }, 300000))

    // 记忆兜底落盘（每 60 秒）
    ctx.effect(() => ctx.interval(() => {
      if (memory.history.length === 0 && memory.facts.length === 0) return
      try { scheduleSaveMemory() } catch (e) { /* ignore */ }
      try { scheduleSaveNarrator() } catch (e) { /* ignore */ }
    }, 60000))

    // 进度叙事：里程碑巡检（30s 独立 tick；时间型阈值兜底，回合结束/新消息即复位）
    ctx.effect(() => ctx.interval(() => {
      try { maybeMilestone() } catch (e) { /* ignore */ }
    }, 30000))

    // 卸载插件时终止常驻 TTS worker
    ctx.effect(() => {
      return () => { teardownTtsWorker() }
    })

    // ---------------- 人格注入 ----------------
    if (systemPrompt !== undefined) {
      ctx.effect(() => systemPrompt.section({
        name: 'amadeus-persona',
        order: 500,
        text: () => (config.personaOn === true ? personaText : ''),
      }))
    }

    // ---------------- 启动 ----------------
    ensureDataDirs().then(() => {
      loadConfig().catch((e) => console.error('[amadeus] loadConfig:', e))
      loadNarrator().catch((e) => console.error('[amadeus] loadNarrator:', e))
      loadPersona().catch((e) => console.error('[amadeus] loadPersona:', e))
      loadMemory().then(() => {
        console.log('[amadeus] 记忆已加载:', memory.history.length, '条历史,', memory.facts.length, '条长期事实')
      }).catch((e) => console.error('[amadeus] loadMemory:', e))
    })
    // 预热常驻 TTS worker（后台拉起，首句即可复用；不支持时静默回退）
    ensureTtsWorker().catch((e) => console.warn('[amadeus] TTS worker 预热失败:', e && e.message ? e.message : String(e)))
    // 入口自检欢迎语：启动 15s 后播报一次（仅语音开启时；announce 会留痕到对话区）
    let startupGreetingSent = false
    ctx.timeout(() => {
      try {
        if (startupGreetingSent) return
        startupGreetingSent = true
        if (config.voiceOn !== true) return
        announce(STARTUP_GREETING.jp, STARTUP_GREETING.cn, STARTUP_GREETING.emotion)
        console.log('[amadeus] 启动欢迎语已播报:', STARTUP_GREETING.jp)
      } catch (e) {
        console.error('[amadeus] 启动欢迎语失败:', e && e.message ? e.message : String(e))
      }
    }, 15000)
    console.log('[amadeus] SAKIKO host 已就绪。配置:', JSON.stringify({ voiceOn: config.voiceOn, chatOn: config.chatOn, callOn: config.callOn, idleChatOn: config.idleChatOn }))
}