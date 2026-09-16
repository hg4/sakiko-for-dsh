#!/usr/bin/env node
// ============================================================
// SAKIKO for DSH — 语音关（voiceOn=false）时 speakSynced 只出气泡、不进播放队列
// ============================================================
//
// 【作用域声明 · 先读这一节（独立复审 Critical-3 的修法）】
//   本测试**只覆盖 `speakSynced` 这一条路径**，以及它推给面板的条目在**真实** panel.js
//   路由/闸门下的后果。它**不是**产品级命题「语音关 ⇒ 用户听不到声音」的判据 —— 产品里
//   至少还有三条"语音关也会出声"的 force 入队通道，**不在本测试作用域**（另案）：
//     · host.mjs:4717  say    RPC → pushUtterances(sentences, true, …)   无 voiceOn 判定
//     · host.mjs:4729  repeat RPC → pushUtterances(sentences, true, …)   无 voiceOn 判定
//     · host.mjs:4020  pushHum 条目 {kind:'hum', force:true, url}（testHum:4744 → playHum）；
//       panel.js:2326-2329 的 hum 分支**连空文本都播**（force=true 绕过 panel.js:462 的闸门）
//   另有一条非交互例外：气泡上的 🔊 手动重播按钮（panel.js:1994-2003 → attachReplay）走独立音源，
//   用户点击即出声，与主队列无关 —— 所以本测试的"不会出声"隐含"用户不点重播"。
//   §6 会在运行时**现算**并打印「speakSynced 之外仍会入队/出声的 push* 站点」，避免作用域再次被读宽。
//   ⇒「say/repeat/testHum 语音关时到底应不应该出声」是产品意图问题，本文件不判定。
//
// 本测试判定的是（由**生产代码**求值，不手抄模型）：
//   A. 不出声：synthesize() 零调用；时间线只有 synth_skip（无 synth_done/synth_fail）；
//   B. 气泡照出：真实 pushCn 造的条目，经**真实 poll 路由**落到 revealHistory，文本 = (cn || jp)；
//   C. 这条路径推出来的条目**一条都不会进入面板播放队列** —— 由真实 enqueue 的闸门
//      （panel.js:462 `if (!force && cfg.voiceOn !== true) return`）判定；
//      即不得改走 pushUtterances / pushCall（它们的 force 条目会绕过该闸门）。
//
// 为什么"面板侧"不再是手抄模型（复审 C1/C2/I3 的修法）：
//   `enqueue`、`handleCallItem`、以及 poll 回调里的**四分支路由**全部按花括号配对从
//   plugin/web/panel.js **原样切出来**求值；host 侧的 `pushCn`/`pushCall`/`pushUtterances`
//   也从 host.mjs 原样切出来 ⇒ **条目形状由生产代码决定**，替身只负责"记账"与"喂依赖"，
//   不再决定形状。因此 C2 那类"改条目形状仍全绿"的假绿通道被结构性消掉。
//   §5 有一条**元自检**：把 2026-09-15 那次真实回归注入**内存切片**，同一套判据必须报红 ——
//   以证明判据本身不是恒真式（"N 通过"因此不再是唯一证据）。
//
// 为什么用源码抽取而不是 import：
//   host.mjs 是 Cordis 插件（逻辑都在 apply 闭包内）、panel.js 是浏览器 IIFE（依赖 DOM/Audio），
//   而重启 DSH 会杀掉当前会话宿主。切片 != 复述：切出来的是同一段生产代码。
//   切片守卫：签名锚点 + voiceOff 锚点 + 长度**上下界** + 尾锚点 + "恰好一个收尾花括号"
//   （复审 Important-2：只防太短不防太长 ⇒ 加下界的反面，防切片"跑过头"仍全绿）。
//   注入**接缝**（改名会让测试响亮报错，需同步本文件）：cfg/EXPR/queue/lastQueued/pump/
//   prefetchNext/revealHistory/report/startCall + poll 回调的若干 UI 依赖。
//   ⚠️ 复审实测（2026-09-15）：两类接缝的失败方式**不一样**，"改名会响亮报错"原先只对第一类成立 ——
//     · 带参调用（startCall(item) / revealHistory(text, id) / report(msg) …）改名 ⇒ 新名字既不是
//       注入形参、也进不了 no-op 桶（bareCallNames 只认零参调用）⇒ new Function 体里成了未声明
//       标识符 ⇒ **ReferenceError**（响亮）。实测 panel.js 里 startCall → ringCall 即如此。
//     · **零参**调用（pump() / prefetchNext()）改名 ⇒ 新名字被 bareCallNames 收进 PANEL_NOOP 桶、
//       拿到一个 no-op ⇒ **静默 75/0 全绿**（复审实测 pump → pumpQueue / prefetchNext → prefetchFollowing）。
//   本文件选择"给接缝加存在性自检"而不是"把措辞降级"：文件头的承诺（接缝改名响亮报错）是可以
//   用两行代码兑现的，而降级措辞会把这个静默通道永久留在测试里。§0-3 就是那条自检。
//   而 push* 里那个"预热合成"调用是**现算名字**注入的（复审 Minor-1：纯改名不许误红）。
//
// 跑法：node --test test/voiceoff-no-audio.test.mjs   （或 node test/voiceoff-no-audio.test.mjs）
// 零新依赖：只用 node: 内置模块，不联网、不开端口。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const HOST = join(HERE, '..', 'host.mjs')
const PANEL = join(HERE, '..', 'plugin', 'web', 'panel.js')
const src = readFileSync(HOST, 'utf8')
const panelSrc = readFileSync(PANEL, 'utf8')

let pass = 0
let fail = 0
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  [PASS] ' + name) }
  else { fail++; console.log('  [FAIL] ' + name + (extra === undefined ? '' : '  ← ' + extra)) }
}
function fatal(msg) {
  console.error('[FATAL] ' + msg)
  process.exit(2)
}

// ------------------------------------------------------------
// 切片器（花括号配对；跳过注释与字符串字面量）
// ------------------------------------------------------------
function matchBraces(source, open) {
  let depth = 0
  let mode = null   // null | "'" | '"' | '`' | 'line' | 'block'
  for (let k = open; k < source.length; k++) {
    const c = source[k]
    const n = source[k + 1]
    if (mode === 'line') { if (c === '\n') mode = null; continue }
    if (mode === 'block') { if (c === '*' && n === '/') { mode = null; k++ } continue }
    if (mode !== null) {
      if (c === '\\') { k++; continue }
      if (c === mode) mode = null
      continue
    }
    if (c === '/' && n === '/') { mode = 'line'; k++; continue }
    if (c === '/' && n === '*') { mode = 'block'; k++; continue }
    if (c === "'" || c === '"' || c === '`') { mode = c; continue }
    if (c === '{') depth++
    else if (c === '}') { depth--; if (depth === 0) return k }
  }
  return -1
}

function sliceFunction(source, name) {
  const head = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(').exec(source)
  if (!head) return null
  let paren = 0
  let j = source.indexOf('(', head.index)
  for (; j < source.length; j++) {
    const c = source[j]
    if (c === '(') paren++
    else if (c === ')') { paren--; if (paren === 0) { j++; break } }
  }
  const open = source.indexOf('{', j)
  if (open < 0) return null
  const end = matchBraces(source, open)
  return end < 0 ? null : source.slice(head.index, end + 1)
}

// 面板 poll 回调是个匿名 function 表达式：从 /sakiko/poll 的 fetch 往后找 `.then(function (data) {`
function slicePollCallback(source) {
  const anchor = '/sakiko/poll?after='
  if (source.split(anchor).length - 1 !== 1) return null
  const from = source.indexOf(anchor)
  const thenIdx = source.indexOf('.then(function (data) {', from)
  if (thenIdx < 0) return null
  const fnStart = source.indexOf('function (data)', thenIdx)
  const open = source.indexOf('{', fnStart)
  const end = matchBraces(source, open)
  return end < 0 ? null : source.slice(fnStart, end + 1)
}

// 切片健全性（复审 Important-2）：长度上下界 + 尾锚点 + 恰好一个"该层缩进的收尾花括号"
function sliceCheck(label, sliced, minLen, maxLen, indent) {
  if (!sliced) fatal(label + '：切片失败（返回 null）—— 锚点已失效，请同步更新本测试')
  const closeRe = new RegExp('\\n' + indent + '\\}', 'g')
  const closes = (sliced.match(closeRe) || []).length
  if (sliced.length < minLen || sliced.length > maxLen) {
    fatal(label + '：切片长度 ' + sliced.length + ' 不在 ' + minLen + '~' + maxLen +
      ' —— 切片器可能跑过头（吞掉别的函数）或被截断。**拒绝在可疑切片上跑断言**')
  }
  if (!new RegExp('\\n' + indent + '\\}$').test(sliced)) {
    fatal(label + '：切片尾部不是「\\n' + indent + '}」—— 切片器跑过头了')
  }
  if (closes !== 1) {
    fatal(label + '：切片里出现 ' + closes + ' 个「' + indent + '}」收尾（应为 1）—— 切片器吞掉了别的函数')
  }
}

// 从源码里取一个扁平的字面量常量（EMOTIONS / EMOTION_EXPR / QUEUE_TAG_KEYS）
function extractConst(source, name) {
  const m = new RegExp('const ' + name + ' = (\\[[^\\]]*\\]|\\{[^}]*\\})').exec(source)
  if (!m) fatal('在源里找不到 const ' + name + ' = [...] / {...}')
  try { return new Function('return ' + m[1])() } catch (e) { fatal(name + ' 字面量无法求值：' + e.message) }
}

// 切片里出现的"裸调用名"（形如 `foo()`，不含 `x.foo()`）——用来**现算**注入名，
// 这样生产里给那个预热函数改名不会让本测试误红（复审 Minor-1 的误伤点）。
// 先剥掉注释：注释里出现的 `play()` 之类不是代码。
function bareCallNames(sliced) {
  const code = sliced.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  const out = []
  const re = /(^|[^.\w$])([A-Za-z_$][\w$]*)\(\)/g
  let m
  while ((m = re.exec(code)) !== null) if (out.indexOf(m[2]) < 0) out.push(m[2])
  return out
}

// 剥掉注释（保长度、保行号）：调用方锚点必须在**代码**上判定 ——
// 否则注释里出现的 `function xxx(` 会切出错的分区、注释里出现的 `voiceOn` 也会满足锚点。
// 与切片器同一套状态机（同样不解析正则字面量里的引号；本文件用"checkCalls/checkIdle 必须被找到"
// 作为正向对照，扫描器失真会立刻报红）。
function stripComments(source) {
  const out = source.split('')
  let mode = null
  for (let k = 0; k < source.length; k++) {
    const c = source[k]
    const n = source[k + 1]
    if (mode === 'line') { if (c === '\n') mode = null; else out[k] = ' '; continue }
    if (mode === 'block') {
      if (c === '*' && n === '/') { out[k] = ' '; out[k + 1] = ' '; mode = null; k++; continue }
      if (c !== '\n') out[k] = ' '
      continue
    }
    if (mode !== null) {
      if (c === '\\') { k++; continue }
      if (c === mode) mode = null
      continue
    }
    if (c === '/' && n === '/') { mode = 'line'; out[k] = ' '; out[k + 1] = ' '; k++; continue }
    if (c === '/' && n === '*') { mode = 'block'; out[k] = ' '; out[k + 1] = ' '; k++; continue }
    if (c === "'" || c === '"' || c === '`') mode = c
  }
  return out.join('')
}

// 收集"条件早退"的条件文本（复审 A1）：**不认字面写法**，只要 `if (<条件>) return` /
// `if (<条件>) { return }` 都收，条件里出现 `voiceOn` 即视为一道语音守卫。
// 这样 `if (config.voiceOn !== true) return`、`if (!config.voiceOn) return`、
// `if (config.voiceOn === false) return` 等等价写法都能抓到（字面匹配会漏掉后两种 ⇒ 假绿）。
// 条件里显式排除 `\n`：否则 `[^{};]*` 会跨行吞掉后面整段语句（实测会把
// `if (config.voiceOn !== true) return` 与下一条 `if (items.length === 0) return` 粘成一条
// "条件"，既污染 [INFO] 输出、也让面板闸门那条锚点可能靠**别的语句**里的 force/voiceOn 蒙对）。
// 排除 `{};` 则不跨块、不跨语句；条件里带嵌套括号（`if (isOff(cfg)) return`）仍能匹配。
// 已知残余盲区（静态文本匹配的能力边界，写在这里以免误会）：
//   ① 把 `config.voiceOn` 先赋给局部变量再判（`const vo = config.voiceOn; if (!vo) return`）；
//   ② 条件**跨行**书写（`if (config.voiceOn !== true &&\n    cfg.x) return`）—— 本仓库语句普遍不写
//      分号，一旦允许跨行就无法与"两条相邻语句"区分（实测会误判），故此处选择"宁可漏多行、
//      不可误报"，代价是②这类写法需要人工在复审里留意。
function guardedReturns(code) {
  const out = []
  const re = /if\s*\(([^{};\n]{0,200})\)\s*\{?\s*return/g
  let m
  while ((m = re.exec(code)) !== null) out.push(m[1].trim())
  return out
}
const voiceGuardsIn = (code) => guardedReturns(code).filter((c) => /voiceOn/.test(c))

// ============================================================
console.log('== 0) 抽取自查：切到的确实是生产代码（含上下界与尾锚点）==')
// ============================================================

const speakSrc = sliceFunction(src, 'speakSynced')
if (!/async\s+function\s+speakSynced\s*\(\s*jp\s*,\s*cn\s*,\s*emotion\s*,\s*kind\s*,\s*tags\s*\)/.test(String(speakSrc))) {
  fatal('speakSynced 的签名变了（期望 async function speakSynced(jp, cn, emotion, kind, tags)）—— 替身注入顺序会失效')
}
if (!/voiceOff/.test(String(speakSrc))) {
  fatal('speakSynced 切片里没有 voiceOff —— 本测试守的正是这条分支，请同步更新')
}
sliceCheck('speakSynced', speakSrc, 400, 8000, '    ')

const pushCnSrc = sliceFunction(src, 'pushCn')
const pushCallSrc = sliceFunction(src, 'pushCall')
const pushUtterancesSrc = sliceFunction(src, 'pushUtterances')
sliceCheck('host.pushCn', pushCnSrc, 150, 1500, '    ')
sliceCheck('host.pushCall', pushCallSrc, 150, 2000, '    ')
sliceCheck('host.pushUtterances', pushUtterancesSrc, 400, 4000, '    ')

const enqueueSrc = sliceFunction(panelSrc, 'enqueue')
const handleCallSrc = sliceFunction(panelSrc, 'handleCallItem')
const pollCbSrc = slicePollCallback(panelSrc)
sliceCheck('panel.enqueue', enqueueSrc, 300, 4000, '  ')
sliceCheck('panel.handleCallItem', handleCallSrc, 60, 1200, '  ')
sliceCheck('panel.pollCallback', pollCbSrc, 600, 6000, '    ')

// 时间线 tags 白名单（push 与 synth_start 两条事件都用它）——也取真源，别手抄白名单。
const tlTagFieldsSrc = sliceFunction(src, 'tlTagFields')
sliceCheck('host.tlTagFields', tlTagFieldsSrc, 150, 1200, '    ')

const EMOTIONS = extractConst(src, 'EMOTIONS')
const EMOTION_EXPR = extractConst(src, 'EMOTION_EXPR')
const QUEUE_TAG_KEYS = extractConst(src, 'QUEUE_TAG_KEYS')
if (!Array.isArray(EMOTIONS) || EMOTIONS.indexOf('happy') < 0 || EMOTIONS.indexOf('neutral') < 0) fatal('EMOTIONS 抽取异常')
if (!Array.isArray(QUEUE_TAG_KEYS) || QUEUE_TAG_KEYS.indexOf('sid') < 0) fatal('QUEUE_TAG_KEYS 抽取异常')

// 条目构造行锚点（复审 Critical-2 的第二个根因）：只取 `const item = {...}` 那一行，
// 不让同一个函数里恰好也含这些子串的**别的行**（例如 tlLog 行）来满足锚点。
function itemLiteralOf(fnSrc, label) {
  const m = /const item = \{[^}]*\}/.exec(fnSrc)
  if (!m) fatal(label + ' 里找不到 `const item = {...}` 条目构造行 —— 锚点已失效，请同步更新本测试')
  return m[0]
}
const pushCnItem = itemLiteralOf(pushCnSrc, 'pushCn')
const pushCallItem = itemLiteralOf(pushCallSrc, 'pushCall')
const pushUtterancesItem = itemLiteralOf(pushUtterancesSrc, 'pushUtterances')

function buildSpeak(source, label) {
  try {
    const f = new Function(
      'config', 'tlLog', 'waitVoiceReady', 'synthesize', 'pushCn', 'pushCall', 'pushUtterances',
      'EMOTIONS', 'tlTrunc', 'tlTagFields', 'console',
      source + '\nreturn speakSynced'
    )
    if (typeof f !== 'function') fatal(label + '：new Function 未返回构造函数')
    return f
  } catch (e) {
    fatal(label + '：抽取出来的代码无法构造（语法错误？）：' + e.message)
  }
}
const makeSpeak = buildSpeak(speakSrc, 'speakSynced')

// ---------- host 侧：真实的 pushCn / pushCall / pushUtterances ----------
// tlTrunc 用替身（真源走 truncCps 按码点截断；只影响日志里的截断长度，不影响任何判定）
const tlTruncStub = (s, n) => String(s === undefined || s === null ? '' : s).slice(0, n)
const tlTagFields = new Function('tlTrunc', tlTagFieldsSrc + '\nreturn tlTagFields')(tlTruncStub)

const HOST_PUSH_DEPS = []
for (const n of bareCallNames(pushCnSrc).concat(bareCallNames(pushCallSrc), bareCallNames(pushUtterancesSrc))) {
  if (HOST_PUSH_DEPS.indexOf(n) < 0) HOST_PUSH_DEPS.push(n)
}
const HOST_PUSH_KNOWN = ['EMOTIONS', 'EMOTION_EXPR', 'QUEUE_TAG_KEYS', 'emotionFor', 'tlLog', 'tlTrunc', 'tlTagFields']
const HOST_PUSH_EXTRA = HOST_PUSH_DEPS.filter((n) => HOST_PUSH_KNOWN.indexOf(n) < 0)
const makePushes = new Function(
  'EMOTIONS', 'EMOTION_EXPR', 'QUEUE_TAG_KEYS', 'emotionFor', 'tlLog', 'tlTrunc', 'tlTagFields',
  HOST_PUSH_EXTRA.join(', '),
  'let nextId = 1\n' +
  'let maxIssuedId = 0\n' +
  'let callPending = false\n' +
  'const queue = []\n' +
  pushCnSrc + '\n\n' + pushCallSrc + '\n\n' + pushUtterancesSrc + '\n' +
  'return { pushCn: pushCn, pushCall: pushCall, pushUtterances: pushUtterances,' +
  ' items: function () { return queue },' +
  ' state: function () { return { nextId: nextId, maxIssuedId: maxIssuedId, callPending: callPending } } }'
)

// ---------- panel 侧：真实的 enqueue / handleCallItem / poll 四分支路由 ----------
const panelBare = []
for (const n of bareCallNames(enqueueSrc).concat(bareCallNames(handleCallSrc), bareCallNames(pollCbSrc))) {
  if (panelBare.indexOf(n) < 0) panelBare.push(n)
}
// 这些是**观测接缝**（本测试要记账的），由本文件显式提供；其余裸调用给 no-op
const PANEL_SEAM = ['pump', 'prefetchNext', 'startCall']
const PANEL_NOOP = panelBare.filter((n) => PANEL_SEAM.indexOf(n) < 0)
const makePanel = new Function(
  'cfg', 'EXPR', 'queue', 'lastQueued',                                   // enqueue 依赖
  'revealHistory', 'report', 'applyChatVisibility', 'themeSig', 'applyTheme', 'lastThemeSig',
  'pollFailures', 'cursor', 'pollReported', 'model', 'updateChip',        // poll 回调依赖
  PANEL_SEAM.join(', '),
  PANEL_NOOP.join(', '),
  enqueueSrc + '\n\n' + handleCallSrc + '\n\n' +
  'var __poll = ' + pollCbSrc + '\n' +
  'return { poll: __poll, enqueue: enqueue, handleCallItem: handleCallItem }'
)

// EXPR 只影响条目的 expr 字段（路由/闸门不读它），故用最小替身；其余依赖都是真源切片。
const EXPR_STUB = { happy: 'smile03', excited: 'smile05', soft: 'smile01', neutral: 'default' }
const HUM_URL = 'http://127.0.0.1:1/sakiko-hum-test.wav'
const JP = 'こんにちは、お嬢様。今日もいい天気ですね。'
const CN = '你好，大小姐。今天天气真好呢。'

console.log('  [INFO] 切片长度：speakSynced=' + speakSrc.length + ' pushCn=' + pushCnSrc.length +
  ' pushCall=' + pushCallSrc.length + ' pushUtterances=' + pushUtterancesSrc.length +
  ' enqueue=' + enqueueSrc.length + ' handleCallItem=' + handleCallSrc.length + ' pollCallback=' + pollCbSrc.length)
console.log('  [INFO] push* 切片里现算出的注入名：' + (HOST_PUSH_EXTRA.length ? HOST_PUSH_EXTRA.join(',') : '(无)'))
console.log('  [INFO] 面板路由注入：观测接缝=' + PANEL_SEAM.join(',') + '；其余裸调用（给 no-op）=' +
  (PANEL_NOOP.length ? PANEL_NOOP.join(',') : '(无)'))
ok('0-1 三处切片都非空且通过上下界/尾锚点/单收尾花括号检查', !!speakSrc && !!pushCnSrc && !!enqueueSrc && !!pollCbSrc)
// 注意：这里**不用 FATAL**判 synth_start —— 删掉 synth_skip 分支的变异不该让测试"中止"，
// 而该让 §1 的行为断言逐条报红（FATAL 会吞掉后面的报告）。
ok('0-2 切片含 synth_start（确认切到的是发声路径，而不是别的同名函数）', /synth_start/.test(speakSrc))
// 0-3 观测接缝存在性自检（复审实测的静默通道）：零参接缝 pump()/prefetchNext() 改名后会被
// panelBare 收进 PANEL_NOOP 桶拿到 no-op ⇒ 测试照旧 75/0 全绿，接缝静默失效而无人知道。
// 这里按"名字仍作为调用出现在面板切片里"统一判红（不区分零参/带参），于是文件头那句
// 「接缝改名会让测试响亮报错」对两类都成立。
{
  const panelCode = enqueueSrc + '\n' + handleCallSrc + '\n' + pollCbSrc
  const seamGone = PANEL_SEAM.filter((n) => !new RegExp('(?:^|[^.\\w$])' + n + '\\s*\\(').test(panelCode))
  ok('0-3 panel.js 切片里三个观测接缝仍被调用（pump / prefetchNext / startCall 改名必须响亮报错，' +
    '不许静默落进 no-op 桶）', seamGone.length === 0, '已消失的接缝：' + (seamGone.join(',') || '(无)'))
}

// ------------------------------------------------------------
// 面板侧执行：把 host 真实推出来的条目喂给**真实 poll 路由 + 真实 enqueue**
// playable = 进入播放队列的条目数 + 响铃次数（≡ 用户会听到声音）
// ------------------------------------------------------------
function feedPanel(voiceOn, items) {
  const cfg = { voiceOn }         // 不传 data.config ⇒ poll 回调不会改写 cfg
  const queue = []
  const rec = { rings: [], bubbles: [], pump: 0 }
  const panel = makePanel(
    cfg, EXPR_STUB, queue, '',
    (text, id) => { rec.bubbles.push(String(text)) },
    () => {},
    () => {}, () => '', () => {}, false,
    0, -1, false, null, () => {},
    () => { rec.pump++ },            // pump：被 enqueue 调用 ⇒ 该条目已进播放队列
    () => {},                        // prefetchNext
    (item) => { rec.rings.push(item && item.text) },  // startCall：响铃（pushCall/handleCallItem 的结果）
    ...PANEL_NOOP.map(() => () => {})                  // 其余裸调用（只在 data.config 分支里用得到）
  )
  panel.poll({ utterances: items, cursor: 0, tts: 'edge' })
  return {
    queue, bubbles: rec.bubbles, rings: rec.rings, pump: rec.pump,
    playable: queue.length + rec.rings.length
  }
}

// ------------------------------------------------------------
// host 侧执行：真实 speakSynced + 真实 push*
// ------------------------------------------------------------
function makeHostSide(tlLog) {
  const pushes = makePushes(
    EMOTIONS, EMOTION_EXPR, QUEUE_TAG_KEYS,
    () => 'neutral',                 // emotionFor：单条文本时生产代码不会调用它（i>0 才用）
    tlLog,
    tlTruncStub,
    tlTagFields,
    ...HOST_PUSH_EXTRA.map(() => () => {})
  )
  const count = { pushCn: 0, pushCall: 0, pushUtterances: 0 }
  return {
    count,
    pushCn: (...a) => { count.pushCn++; return pushes.pushCn(...a) },
    pushCall: (...a) => { count.pushCall++; return pushes.pushCall(...a) },
    pushUtterances: (...a) => { count.pushUtterances++; return pushes.pushUtterances(...a) },
    items: pushes.items,
    state: pushes.state
  }
}

// 语音关：判据全部由生产代码决定（条目形状来自真实 push*，是否可播来自真实 enqueue+路由）
async function voiceOffCase(kind, opts) {
  opts = opts || {}
  const make = opts.speakSrc ? buildSpeak(opts.speakSrc, '内存变异切片') : makeSpeak
  const tl = []
  const tlLog = (e) => tl.push(e)
  const host = makeHostSide(tlLog)
  const calls = { synthesize: 0, waitVoiceReady: 0 }
  const config = { voiceOn: false, voiceName: 'sakiko', rate: 1, pitch: 1, provider: 'edge' }
  const waitVoiceReady = async () => {
    calls.waitVoiceReady++
    // 替身如实模拟 waitVoiceReady 的**契约**：语音关时立即放行（ready=false/ms=0/skipped），
    // 所以"短路写在 speakSynced 还是写在闸门里"这种等价重构不会让本测试误红（复审 Minor-1）。
    return config.voiceOn === true
      ? { ready: true, waitedMs: 0, why: '就绪（替身）', timeout: false, skipped: false }
      : { ready: false, waitedMs: 0, why: 'voiceOn=false（语音关，替身按生产语义立即放行）', timeout: false, skipped: true }
  }
  const speakSynced = make(
    config, tlLog, waitVoiceReady,
    async () => { calls.synthesize++ },
    host.pushCn, host.pushCall, host.pushUtterances,
    EMOTIONS, tlTruncStub, tlTagFields,
    { warn: () => {}, log: () => {}, error: () => {} }
  )
  const cnArg = 'cn' in opts ? opts.cn : CN      // 显式传 {cn: undefined} 时才是真的 undefined
  const emotion = opts.emotion === undefined ? 'happy' : opts.emotion
  await speakSynced(JP, cnArg, emotion, kind, { sid: 'abcdef1234567890', narrate: kind })

  const items = host.items()
  const panel = feedPanel(false, items)
  const evs = tl.map((e) => e.ev)
  const pushEvents = tl.filter((e) => e.ev === 'push')
  const expectCn = cnArg ? cnArg : JP      // 生产契约：pushCn(cn || jp, emo)

  const checks = [
    { id: 'synth-zero', name: 'synthesize 零调用（语音关**不得**合成）',
      ok: calls.synthesize === 0, extra: 'calls=' + calls.synthesize },
    { id: 'tl-synth-skip', name: '时间线有 synth_skip 且 why=voiceOn=false',
      ok: tl.some((e) => e.ev === 'synth_skip' && e.why === 'voiceOn=false'),
      extra: JSON.stringify(tl.filter((e) => e.ev === 'synth_skip')) },
    { id: 'tl-no-synth-done', name: '时间线无 synth_done / synth_fail（语音关不产生合成结论）',
      ok: evs.indexOf('synth_done') < 0 && evs.indexOf('synth_fail') < 0, extra: evs.join(',') },
    { id: 'tl-synth-start', name: '时间线有 synth_start（这句话确实来过，没被提前 return 吞掉）',
      ok: evs.indexOf('synth_start') >= 0, extra: evs.join(',') },
    { id: 'voice-wait-immediate', name: 'voice_wait 立即放行：ready=false / ms=0 / why 指明语音关（**不判分支写在哪**）',
      ok: tl.some((e) => e.ev === 'voice_wait' && e.ready === false && e.ms === 0 && /voiceOn=false/.test(String(e.why))),
      extra: JSON.stringify(tl.find((e) => e.ev === 'voice_wait')) },
    { id: 'pushCn-once', name: '真实 pushCn 被调用恰好 1 次（气泡通道）',
      ok: host.count.pushCn === 1, extra: 'calls=' + host.count.pushCn },
    { id: 'pushUtterances-zero', name: '真实 pushUtterances 零调用（它的 say 条目带 force，会绕过 panel.js:462 闸门）',
      ok: host.count.pushUtterances === 0, extra: 'calls=' + host.count.pushUtterances },
    { id: 'pushCall-zero', name: '真实 pushCall 零调用（call 条目 force:true，会响铃/进播放链路）',
      ok: host.count.pushCall === 0, extra: 'calls=' + host.count.pushCall },
    { id: 'single-channel', name: '三个 push 通道合计只用 1 次（就是那 1 个气泡）',
      ok: host.count.pushCn + host.count.pushCall + host.count.pushUtterances === 1 },
    { id: 'entry-shape-cn', name: '真实 pushCn 造的条目 + 时间线 push 事件都是 kind:cn（气泡条目）',
      // 只钉 kind：面板按 kind 优先路由（panel.js:2330），cn 条目上的 force 是**惰性字段**
      // （独立复审 Minor-4 已撤回把它当缺陷），钉它属过度约束。
      ok: items.length === 1 && items[0].kind === 'cn' &&
        pushEvents.length === 1 && pushEvents[0].kind === 'cn',
      extra: 'items=' + JSON.stringify(items) + ' pushEvents=' + JSON.stringify(pushEvents) },
    { id: 'bubble-text', name: '真实 poll 路由把它落给 revealHistory（气泡），文本 = (cn || jp)',
      ok: panel.bubbles.length === 1 && panel.bubbles[0] === expectCn, extra: JSON.stringify(panel.bubbles) },
    { id: 'enqueue-empty', name: '真实 enqueue 判定：本条路径没有任何条目进入面板播放队列（playable=0）',
      ok: panel.playable === 0,
      extra: 'queue=' + JSON.stringify(panel.queue) + ' rings=' + JSON.stringify(panel.rings) }
  ]
  return { checks, tl, calls, host, panel, items }
}

function reportChecks(prefix, checks) {
  for (const c of checks) ok(prefix + c.name, c.ok, c.extra)
}

// ============================================================
console.log('')
console.log('== 1) 契约：voiceOn=false 时只出气泡、不进播放队列 ==')
console.log('    kind 取生产里的调用点取值：force（announce/narrate）/ call（来电 triggerCall）/ idle（空闲 idleChatter）')
console.log('    注：voiceOn=false 时 call/idle 在**调用方**就被挡住（checkCalls:3939 / checkIdle 里的 voiceOn 提前 return，')
console.log('        所以 triggerCall / idleChatter 根本不会被走到），这里喂给 speakSynced 属**反事实输入**，')
console.log('        只用来钉住"万一到达也必须只出气泡"。')
// ============================================================
for (const kind of ['force', 'call', 'idle']) {
  console.log('  -- kind=' + kind + ' --')
  const r = await voiceOffCase(kind)
  reportChecks('[' + kind + '] ', r.checks)
}

// ============================================================
console.log('')
console.log('== 2) 边界：cn 缺失 → 气泡回退 jp；未知情绪 → 归一 neutral ==')
// ============================================================
{
  const r1 = await voiceOffCase('force', { cn: '' })
  reportChecks('[cn=空串] ', r1.checks.filter((c) => c.id === 'pushCn-once' || c.id === 'bubble-text' || c.id === 'enqueue-empty'))
  const r2 = await voiceOffCase('force', { cn: undefined, emotion: 'no-such-emotion' })
  ok('[cn=undefined] 真实 pushCn 的条目 cn 回退为 jp（语音关也不能把话吞掉）',
    r2.items.length === 1 && r2.items[0].cn === JP, JSON.stringify(r2.items))
  ok('[cn=undefined] 未知情绪归一为 neutral（生产 EMOTIONS 归一分支）',
    r2.items.length === 1 && r2.items[0].emotion === 'neutral', JSON.stringify(r2.items))
}

// ============================================================
console.log('')
console.log('== 3) 反向：voiceOn=true 时照常出声（证明上面的"零调用/空队列"不是恒真）==')
// ============================================================
{
  const r = await voiceOffCase('force', { cn: CN })
  // 用同一套 harness，但把 config.voiceOn 设为 true 重跑一次
  const tl = []
  const host = makeHostSide((e) => tl.push(e))
  const calls = { synthesize: 0 }
  const config = { voiceOn: true, voiceName: 'sakiko', rate: 1, pitch: 1, provider: 'edge' }
  const speak = makeSpeak(config, (e) => tl.push(e),
    async () => ({ ready: true, waitedMs: 0, why: '就绪（替身）', timeout: false, skipped: false }),
    async () => { calls.synthesize++ },
    host.pushCn, host.pushCall, host.pushUtterances, EMOTIONS,
    tlTruncStub, tlTagFields,
    { warn: () => {}, log: () => {}, error: () => {} })
  await speak(JP, CN, 'happy', 'force', { announce: true })
  const items = host.items()
  const panel = feedPanel(true, items)
  const evs = tl.map((e) => e.ev)
  ok('[voiceOn=true/force] synthesize 1 次', calls.synthesize === 1, 'calls=' + calls.synthesize)
  ok('[voiceOn=true/force] 走真实 pushUtterances：条目 kind:say / force:true / text=jp',
    host.count.pushUtterances === 1 && items.length === 1 && items[0].kind === 'say' && items[0].force === true && items[0].text === JP,
    JSON.stringify(items) + ' counts=' + JSON.stringify(host.count))
  ok('[voiceOn=true/force] pushCn / pushCall 零调用',
    host.count.pushCn === 0 && host.count.pushCall === 0, JSON.stringify(host.count))
  ok('[voiceOn=true/force] 时间线 synth_start→synth_done 且无 synth_skip',
    evs.indexOf('synth_done') >= 0 && evs.indexOf('synth_skip') < 0, evs.join(','))
  ok('[voiceOn=true/force] 真实面板：这条**确实**进播放队列（模型非恒真）',
    panel.playable === 1 && panel.queue.length === 1, JSON.stringify(panel.queue))
  ok('[voiceOn=true/force] 参照组：同一个 harness 在 voiceOn=false 下 playable=0',
    r.panel.playable === 0 && r.host.count.pushUtterances === 0)

  const tl2 = []
  const host2 = makeHostSide((e) => tl2.push(e))
  const config2 = { voiceOn: true, voiceName: 'sakiko', rate: 1, pitch: 1, provider: 'edge' }
  const speak2 = makeSpeak(config2, (e) => tl2.push(e),
    async () => ({ ready: true, waitedMs: 0, why: '就绪（替身）', timeout: false, skipped: false }),
    async () => {}, host2.pushCn, host2.pushCall, host2.pushUtterances, EMOTIONS,
    tlTruncStub, tlTagFields,
    { warn: () => {}, log: () => {}, error: () => {} })
  await speak2(JP, CN, 'soft', 'call', undefined)
  const items2 = host2.items()
  const panel2 = feedPanel(true, items2)
  ok('[voiceOn=true/call] 走真实 pushCall：条目 kind:call / force:true',
    host2.count.pushCall === 1 && items2.length === 1 && items2[0].kind === 'call' && items2[0].force === true,
    JSON.stringify(items2) + ' counts=' + JSON.stringify(host2.count))
  ok('[voiceOn=true/call] pushCn / pushUtterances 零调用 + 面板会响铃（startCall）',
    host2.count.pushCn === 0 && host2.count.pushUtterances === 0 && panel2.rings.length === 1,
    JSON.stringify(host2.count) + ' rings=' + JSON.stringify(panel2.rings))

  await speak2(JP, CN, 'neutral', 'idle', { idle: true })
  ok('[voiceOn=true/idle] 走真实 pushUtterances 且 force=false（非 force 条目在语音关下会被闸门挡）',
    host2.count.pushUtterances === 1 && host2.items().length === 2 && host2.items()[1].force === false,
    JSON.stringify(host2.items()))
}

// ============================================================
console.log('')
console.log('== 4) 面板路由自检：真的是 panel.js 的四分支路由，且闸门只挡非 force ==')
console.log('    （这组同时证明 C1 修法有效：判定来自生产代码，不是手抄模型）')
// ============================================================
{
  const pSayForce = feedPanel(false, [{ id: 1, kind: 'say', text: JP, cn: CN, force: true, emotion: 'happy' }])
  ok('路由自检：kind:say + force:true 在语音关下**照样入队播放**（panel.js:462 只挡非 force）——这正是历史回归的机制',
    pSayForce.playable === 1 && pSayForce.queue.length === 1 && pSayForce.queue[0].text === JP, JSON.stringify(pSayForce.queue))
  const pSayPlain = feedPanel(false, [{ id: 2, kind: 'say', text: JP, cn: CN, force: false, emotion: 'happy' }])
  ok('路由自检：kind:say + force:false 在语音关下被闸门丢弃（⇒ 判据能区分 force）',
    pSayPlain.playable === 0 && pSayPlain.queue.length === 0, JSON.stringify(pSayPlain.queue))
  const pCn = feedPanel(false, [{ id: 3, kind: 'cn', text: '', cn: CN, force: false, emotion: 'happy' }])
  ok('路由自检：kind:cn 只落 revealHistory、不进播放队列',
    pCn.bubbles.length === 1 && pCn.bubbles[0] === CN && pCn.playable === 0, JSON.stringify(pCn))
  const pCall = feedPanel(false, [{ id: 4, kind: 'call', text: JP, cn: CN, force: true, emotion: 'soft' }])
  ok('路由自检：kind:call → handleCallItem → startCall（响铃；force:true 绕开闸门）',
    pCall.rings.length === 1, JSON.stringify(pCall.rings))
  const pHum = feedPanel(false, [{ id: 5, kind: 'hum', text: '', cn: '♪ ♪ ♪', force: true, emotion: 'happy', url: HUM_URL }])
  ok('路由自检：kind:hum 走 hum 分支（空文本也入队，靠 url 播）—— 这条是**产品级现存行为**，属另案（见文件头 C3）',
    pHum.queue.length === 1 && pHum.queue[0].url === HUM_URL, JSON.stringify(pHum.queue))
}

// ============================================================
console.log('')
console.log('== 5) 元自检：把 2026-09-15 那次真实回归注入**内存切片**，同一套判据必须报红 ==')
console.log('    （复审 Minor-3：没有这条，"N 通过"就不能当作判据强度的证据）')
// ============================================================
{
  const MUT_FROM = '        pushCn(cn || jp, emo)'
  const MUT_TO = "        pushUtterances([jp], kind === 'force', emo, cn || '', tags || {})"
  const hits = speakSrc.split(MUT_FROM).length - 1
  if (hits !== 1) {
    // 锚点丢失（例如有人重写了 voiceOff 的收尾那一行）⇒ 元自检无法执行。
    // 这里**必须报红而不是 FATAL**：FATAL 会中止整个文件、吞掉 §1 的行为报告，
    // 而此刻恰恰最需要看到那些行为断言的结果。
    ok('元自检：历史回归锚点仍在切片里（丢了就必须同步本元自检）', false, 'hits=' + hits)
    ok('元自检：注入历史回归后同一套判据**必须报红**', false, 'skipped: anchor lost')
    ok('元自检：报红必须包含 pushCn-once / pushUtterances-zero / enqueue-empty', false, 'skipped: anchor lost')
  } else {
    const mutated = speakSrc.replace(MUT_FROM, MUT_TO)
    const before = await voiceOffCase('force')
    const after = await voiceOffCase('force', { speakSrc: mutated })
    const badBefore = before.checks.filter((c) => !c.ok).map((c) => c.id)
    const badAfter = after.checks.filter((c) => !c.ok).map((c) => c.id)
    ok('元自检：真实切片下同一套判据 0 失败（对照基线）', badBefore.length === 0, 'failing=' + badBefore.join(','))
    ok('元自检：注入历史回归后同一套判据**必须报红**', badAfter.length > 0, 'failing=' + badAfter.join(','))
    ok('元自检：报红必须包含 pushCn-once / pushUtterances-zero / enqueue-empty（⇒ 这三条判据非恒真）',
      ['pushCn-once', 'pushUtterances-zero', 'enqueue-empty'].every((id) => badAfter.indexOf(id) >= 0),
      'failing=' + badAfter.join(','))
    console.log('  [INFO] 元自检明细：真实切片 failing=[' + badBefore.join(',') + ']  注入回归后 failing=[' + badAfter.join(',') + ']')
  }
}

// ============================================================
console.log('')
console.log('== 6) 静态锚点：条目形状 / 调用方 / 作用域披露 ==')
console.log('    （调用方**只做静态锚点**，没有行为覆盖 —— 本文件直接调 speakSynced）')
// ============================================================
{
  ok('[锚点] pushCn 的**条目构造行**（不是 tlLog 行）仍是 kind:\'cn\'（气泡条目的载体）',
    /kind: 'cn'/.test(pushCnItem) && !/kind: 'say'/.test(pushCnItem), pushCnItem)
  // 不钉 cn 条目上的 force：面板按 kind 优先路由（panel.js:2330），该字段对是否出声无影响
  // （独立复审 Minor-4 主动撤回了把它当缺陷的指控），钉它属过度约束。
  ok('[锚点] pushCall 的条目构造行仍是 kind:\'call\' + force:true',
    /kind: 'call'/.test(pushCallItem) && /force: true/.test(pushCallItem), pushCallItem)
  ok('[锚点] pushUtterances 的条目构造行仍把形参 force 透传（force: !!force ⇒ force:true 会绕开闸门）',
    /force: !!force/.test(pushUtterancesItem), pushUtterancesItem)
  ok('[锚点] pushUtterances 的条目构造行仍是 kind:\'say\'（⇒ 会被面板送给 enqueue）',
    /kind: 'say'/.test(pushUtterancesItem), pushUtterancesItem)
  ok('[锚点] panel.js enqueue 里仍有一道「force + voiceOn」的早退闸门（**写法可等价改写、语义不可丢**）',
    guardedReturns(enqueueSrc).some((c) => /voiceOn/.test(c) && /\bforce\b/.test(c)),
    guardedReturns(enqueueSrc).join(' | ') || '(enqueue 里没有条件早退)')
  ok('[锚点] panel.js poll 路由四分支齐全（call / hum / cn / else→enqueue）',
    /u\.kind === 'call'/.test(pollCbSrc) && /u\.kind === 'hum'/.test(pollCbSrc) &&
    /u\.kind === 'cn'/.test(pollCbSrc) && /revealHistory\(u\.cn/.test(pollCbSrc) &&
    /enqueue\(u\.text, u\.force === true/.test(pollCbSrc))

  // --- 调用方锚点（复审 Important-1）---
  // 用「4 空格缩进的函数声明」切分 host.mjs 的 apply 体，比 600 字符回看窗口稳；
  // 在**剥掉注释**的源码上判定，避免注释里的 `function xxx(` / `voiceOn` 干扰。
  const srcCode = stripComments(src)
  const fnHits = []
  {
    const re = /\n {4}(?:async\s+)?function\s+(\w+)\s*\(/g
    let m
    while ((m = re.exec(srcCode)) !== null) fnHits.push({ name: m[1], start: m.index })
  }
  const regions = fnHits.map((h, i) => ({
    name: h.name,
    start: h.start,
    text: srcCode.slice(h.start, i + 1 < fnHits.length ? fnHits[i + 1].start : srcCode.length)
  }))
  const lineOf = (i) => srcCode.slice(0, i).split('\n').length
  const enclosingRegion = (idx) => {
    let best = { name: '?', start: 0 }
    for (const r of regions) if (r.start < idx) best = r
    return best
  }
  // 真正的回归面：**调用点之前**若有一道 voiceOn 提前 return，气泡会被一起吞掉（host:2413-2417 记的就是它）。
  // 逐调用点现算"所在函数 + 之前有没有守卫"，比硬编码函数名稳（call/idle 的实际调用点在
  // triggerCall:3930 / idleChatter:3962，而守卫在 checkCalls:3939 / checkIdle 里 —— 名字容易记错）。
  const sites = []
  {
    const re = /await speakSynced\(/g
    let m
    while ((m = re.exec(srcCode)) !== null) {
      const region = enclosingRegion(m.index)
      sites.push({
        fn: region.name,
        line: lineOf(m.index),
        guardedBefore: voiceGuardsIn(srcCode.slice(region.start, m.index)).length > 0
      })
    }
  }
  const guardFns = regions.filter((r) => voiceGuardsIn(r.text).length > 0).map((r) => r.name)
  const guardConds = []
  for (const r of regions) for (const c of voiceGuardsIn(r.text)) guardConds.push(r.name + ': if (' + c + ') return')
  console.log('  [INFO] 机械扫到的「含 voiceOn 的条件早退」（不认字面写法）：' +
    (guardConds.length ? guardConds.join(' ; ') : '(无)'))
  console.log('  [INFO] speakSynced 调用点（调用点所在函数@行，之前有 voiceOn 守卫？）：' +
    sites.map((s) => s.fn + '@' + s.line + (s.guardedBefore ? '[GUARDED!]' : '')).join(', '))
  ok('[调用方锚点] speakSynced 的每个调用点**之前**都没有 voiceOn 提前 return（有的话气泡会被一起吞掉）' +
    '——**不认字面写法**：`if (!config.voiceOn) return` / `if (config.voiceOn === false) return` 同样会被抓到',
    sites.length > 0 && sites.every((s) => !s.guardedBefore),
    JSON.stringify(sites))
  ok('[调用方锚点] announce 与 narrate 里都没有 voiceOn 提前 return（历史回归就在 announce；同上不认字面写法）',
    guardFns.indexOf('announce') < 0 && guardFns.indexOf('narrate') < 0, 'guardFns=' + guardFns.join(','))
  ok('[调用方锚点] announce 确实是 speakSynced 的调用方之一',
    sites.some((s) => s.fn === 'announce'), sites.map((s) => s.fn).join(','))
  ok('[调用方锚点] call/idle 两条路径的调用方守卫仍在（checkCalls / checkIdle ⇒ 语音关时到不了 speakSynced）',
    guardFns.indexOf('checkCalls') >= 0 && guardFns.indexOf('checkIdle') >= 0, 'guardFns=' + guardFns.join(','))
  ok('[调用方锚点] speakSynced 的调用点 >= 4（四条宿主固定话语路径都还在）', sites.length >= 4, 'n=' + sites.length)

  // --- 入队通道清单：把"还有没有别的匿名 queue.push 站点"变成机械可查（复审 §6 未检查项 7）---
  const pushSites = []
  {
    const re = /queue\.push\(/g
    let m
    while ((m = re.exec(srcCode)) !== null) pushSites.push(enclosingRegion(m.index).name)
  }
  console.log('  [INFO] host.mjs 里 queue.push( 的归属函数：' + pushSites.join(','))
  {
    const want = ['pushCn', 'pushCall', 'pushHum', 'pushUtterances']
    const uniq = []
    for (const n of pushSites) if (uniq.indexOf(n) < 0) uniq.push(n)
    ok('[锚点] host 的入队通道恰好是这 4 个具名函数（pushCn / pushCall / pushHum / pushUtterances）各 1 处' +
      '—— 新增/改名入队通道必须同步本文件的**作用域声明**（这是有意的红，不是误报）',
      pushSites.length === 4 && uniq.length === 4 && want.every((n) => uniq.indexOf(n) >= 0), pushSites.join(','))
  }

  // --- 作用域披露（复审 Critical-3）：现算"speakSynced 之外仍会出声的 push* 站点" ---
  const speakStartLine = src.slice(0, src.indexOf(speakSrc)).split('\n').length
  const speakEndLine = speakStartLine + speakSrc.split('\n').length - 1
  const outside = []
  {
    const re = /(?:^|[^\w.$])(pushHum|pushUtterances|pushCall)\s*\(/g
    let m
    while ((m = re.exec(srcCode)) !== null) {
      const line = srcCode.slice(0, m.index).split('\n').length
      if (line >= speakStartLine && line <= speakEndLine) continue
      const text = srcCode.split('\n')[line - 1].trim()
      if (/^function /.test(text)) continue
      outside.push('host.mjs:' + line + '  ' + text.slice(0, 110))
    }
  }
  console.log('  [INFO] 本测试作用域 = speakSynced 一条路径（见文件头 C3 声明）。')
  console.log('  [INFO] 以下「speakSynced 之外」的 push* 站点**不在本测试覆盖内**（语音关是否该出声属产品意图，另案）：')
  for (const line of outside) console.log('         ' + line)
  if (outside.length === 0) console.log('         (无 —— 已无其它 push* 站点)')
}

// ============================================================
console.log('')
console.log('== 7) Minor-7：气泡通道 pushCn 的队列上限（本分支把语音关的**全部**播报流量改走它之后才需要）==')
console.log('    （面板是拉取式的：条目只在 /sakiko/poll 取走时才出队 ⇒ 面板不轮询时队列必须有界）')
// ============================================================
{
  const host = makeHostSide(() => {})
  for (let i = 0; i < 100; i++) host.pushCn('第' + (i + 1) + '条中文气泡', 'happy')
  const items = host.items()
  ok('[pushCn] 连续推 100 条 → queue.length 不超过 60（有界，淘汰最老者）',
    items.length === 60, 'queue.length=' + items.length)
  ok('[pushCn] 留下的是**最新**的 60 条（第 41 条在队首、第 100 条在队尾）',
    items.length === 60 && items[0].cn === '第41条中文气泡' && items[items.length - 1].cn === '第100条中文气泡',
    'first=' + (items[0] && items[0].cn) + ' last=' + (items[items.length - 1] && items[items.length - 1].cn))
  // 对照：pushUtterances 是同一套上限语义（pushCn 只是补平，不是新策略）
  const host2 = makeHostSide(() => {})
  for (let i = 0; i < 100; i++) host2.pushUtterances(['u' + (i + 1)], true, 'happy')
  ok('[对照] pushUtterances 同样封顶 60（⇒ 两条通道上限语义一致）',
    host2.items().length === 60, 'queue.length=' + host2.items().length)
}

console.log('')
console.log((fail === 0 ? '[OK] ' : '[FAILED] ') + pass + ' 通过 / ' + fail + ' 失败')
process.exit(fail === 0 ? 0 : 1)
