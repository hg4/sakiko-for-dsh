// 里程碑「周期播报」行为测试（Task 10）
//
// 用户现场（2026-09-16 原话）：「我目前在跑两个工作区的不同会话，另一个工作区的排查主角实时跟随
//   补光机制的会话，跑了十多分钟聊天记录里已经很久没有里程碑播报了，而我设置的间隔目前是 2 分钟」。
// 运行态对照（GET /sakiko/rpc?m=narratorStatus）：该会话 turnActive=true、stepCount=90、
//   milestoneCount=1；timeline.jsonl 里该 sid 只有 1 条 narrate=milestone（17:30:29），此后 16+ 分钟
//   没有第 2 条 —— 而那次触发是**步数**（回合 17:29:43 起、17:30:29 播，46 秒 < 120 秒），
//   所以「时间型间隔」在这条会话上从头到尾只生效过一次。
//
// 根因（**这批「改前」行号的坐标 = `983251e`，即 rebase 前的 main**；本文件不写 `983251e:` 前缀的行号一律取自
//   本文件所在的那次提交 —— 与 docs/narrator-milestone.md「本页行号取自本页所在的那次提交」同一口径）：
//   该版 maybeMilestone 在 `983251e`:3586-3602，用「本回合一次性」标志 st.milestoneSpoken 当闸门
//   （`983251e`:3590 `if (st.milestoneSpoken) return` / `983251e`:3598 `st.milestoneSpoken = true`），而该标志
//   只在回合开始（`983251e`:3179，在 resetTurn 内）与结束（`983251e`:3627，在 handleTurnEnd 内）复位
//   ⇒ 一个回合最多播一条；narratorMilestoneMs / narratorMilestoneSteps 事实上只是「这一条什么时候播」的阈值，
//   不是周期。
//   同一批位置在当前 main（`c87d8a8`）上的值 —— 偏移**不是统一的 +4**：maybeMilestone 3603-3645、闸门那行
//   已删除（无对应行）、置位 3621、resetTurn 内的复位 3183（+4）、handleTurnEnd 内的复位 3670（+43）。
//
// 本测试钉住的行为契约（改后）：
//   · 同一回合内，距上次里程碑满 narratorMilestoneMs（或步数增量满 narratorMilestoneSteps）**再播一条**；
//   · 不到间隔**不播**（不许退化成「每 tick 都播」，也不许同一时刻连播）；
//   · narratorOn / turnActive / blocking / stepCount<1 四道门照旧；
//   · 回合起点即基准（回合刚起不算「距上次」已过）；回合结束后基准清零；
//   · 同 tick 里输给更高优先级（BLOCK40/FAIL30/DONE20/SPECIAL15）的那次里程碑**不永久丢失**
//     —— 基准回滚，下一次巡检/下一个周期重试。三条回滚路径各有守卫：
//     批次优先级（§7b）、回合边界（§7d）、narrate() 自己的同意图 8s 预筛（§7e）。
//   · `milestoneCount` 的口径是「**触发**次数」，不是「播出条数」（§7g 量化：0.5s/步跑 40 步
//     ⇒ bump 13 次而只播 2 条；1s/步 ⇒ 4/4）—— 任何断言都不得把它当成播出条数。
//   · 边角新行为（§7f）：去掉 tool/call 的一次性预筛后，静默长回合的第一个工具调用会让
//     START(5) 与 MILESTONE(10) 同 tick 入批 ⇒ 里程碑赢、START 被吞。
//
// 手法（沿用 test/narrator-multisession.test.mjs §5 与 test/voiceoff-no-audio.test.mjs）：
//   按**函数名**把生产代码原样切出来求值（不改写、不复制、不重排版），依赖用 new Function 参数注入。
//   播报链路用**真实的** maybeMilestone + narrate + flushNarrBatch 串起来，
//   deliverNarration 只把「首个 await 之前的同步门」按行原样切出（门是真的），门后的实际发声由测试记录
//   ⇒ 断言落在真实链路的可观测后果（某个 sid 到底播了几条）上，而不是断言某个内部标志被置位。
//
// 运行：node --test test/narr-milestone-periodic.test.mjs

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const HOST = new URL('../host.mjs', import.meta.url)
const SRC = readFileSync(HOST, 'utf8')

let pass = 0
let fail = 0
// 第三个形参是可选诊断串（同 test/narrator-multisession.test.mjs 的约定）：
// 切片/变异没命中时，失败信息里要能看见实况，而不是只剩一个断言名。
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  [PASS] ' + name) }
  else { fail++; console.log('  [FAIL] ' + name + (extra === undefined ? '' : '  ← ' + extra)) }
}

// ------------------------------------------------------------
// 切片器（与 test/narrator-multisession.test.mjs 同一套手法）：花括号配对，**原样**切出生产代码。
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

// ---- 从源码里取出真实常量（不硬编码副本：常量被人改坏时本测试要跟着动） ----
function numConst(name) {
  const m = new RegExp('const ' + name + ' = (\\d+)').exec(SRC)
  return m ? Number(m[1]) : NaN
}
function strListConst(name) {
  const m = new RegExp('const ' + name + ' = \\[([^\\]]*)\\]').exec(SRC)
  return m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : null
}
function objNumConst(name) {
  const m = new RegExp('const ' + name + ' = \\{([^}]*)\\}').exec(SRC)
  if (m === null) return null
  const out = {}
  for (const kv of m[1].matchAll(/([A-Za-z_$][\w$]*)\s*:\s*(\d+)/g)) out[kv[1]] = Number(kv[2])
  return out
}

// tool/call 分支（事件分发里那段）：按行锚 `if (t === 'tool/call') {` + 花括号配对切出。
// 「START 与里程碑同 tick 入批」的真实顺序只在这段里 —— §7f 的判据不能靠手工重演那几行
// （手工重演会绕开生产里真正变过的那一步：旧代码的「本回合一次性」预筛就在这段内）。
function sliceToolCallBranch(hostSrc) {
  const m = /^ {8}if \(t === 'tool\/call'\) \{$/m.exec(hostSrc)
  if (m === null) return null
  const open = hostSrc.indexOf('{', m.index)
  const end = matchBraces(hostSrc, open)
  return end < 0 ? null : hostSrc.slice(m.index, end + 1)
}

// deliverNarration 的**同步门**（首个 await 之前那段）：按行原样切出。
// 起点 = `const now = Date.now()`（紧邻 `const force = opts.force === true` 之前那一行）
// 终点 = 同意图占位登记 `mySameAt = now` 所在的那个 `if (!force) { … }` 块的**闭括号**。
// 这段是「一条播报到底有没有被受理」的唯一判定处。
function sliceDeliverGate(hostSrc) {
  const lines = hostSrc.split('\n')
  const fi = lines.findIndex((l) => /^ {6}const force = opts\.force === true\r?$/.test(l))
  const g0 = lines.findIndex((l) => /^ {8}mySameAt = now\r?$/.test(l))
  const gi = fi - 1
  if (!(fi >= 1 && g0 > fi && (g0 - fi) <= 20 && /const now = Date\.now\(\)/.test(lines[gi]))) return null
  // mySameAt 那行还在 `if (!force) {` 里面，必须往后补到花括号配平，否则切出来的是残缺块。
  // （本区域的字符串/注释里没有花括号，朴素计数在这里是准的。）
  let depth = 0
  let gj = -1
  for (let k = gi; k < lines.length && k <= g0 + 6; k++) {
    for (const c of lines[k]) { if (c === '{') depth++; else if (c === '}') depth-- }
    if (k >= g0 && depth === 0) { gj = k; break }
  }
  if (gj < 0) return null
  return lines.slice(gi, gj + 1).join('\n').split('\r').join('')
}

// ------------------------------------------------------------
// 测试台：真实的 maybeMilestone + resetTurn + handleTurnEnd + narrate + flushNarrBatch
//        + deliverNarration 的同步门切片（只有门后的实际发声换成了「记录一条」）
// ------------------------------------------------------------
function makeRig(hostSrc) {
  const hs = typeof hostSrc === 'string' ? hostSrc : SRC
  const mmSrc = sliceFunction(hs, 'maybeMilestone')
  const narrateSrc = sliceFunction(hs, 'narrate')
  const flushSrc = sliceFunction(hs, 'flushNarrBatch')
  const mkSrc = sliceFunction(hs, 'makeTurnState')
  const resetSrc = sliceFunction(hs, 'resetTurn')
  const endSrc = sliceFunction(hs, 'handleTurnEnd')
  const gateSrc = sliceDeliverGate(hs)
  const toolCallSrc = sliceToolCallBranch(hs)
  if ([mmSrc, narrateSrc, flushSrc, mkSrc, resetSrc, endSrc, gateSrc, toolCallSrc].some((s) => typeof s !== 'string')) return null

  const clock = { t: 0 }                       // 受控时钟（毫秒）：生产代码里的 Date.now() 全走它
  const FakeDate = { now: () => clock.t }

  const config = {
    narratorOn: true,
    narratorDone: false,
    multiSession: true,
    narratorMilestoneMs: 120000,
    narratorMilestoneSteps: 10,
  }
  const NARR_PRIORITY = objNumConst('NARR_PRIORITY')
  const NARR_INTENTS = strListConst('NARR_INTENTS')
  const GAP = numConst('NARR_INTENT_GAP_MS')
  const WARN = numConst('NARR_TICK_DELIVER_WARN')
  if (NARR_PRIORITY === null || NARR_INTENTS === null || !isFinite(GAP) || !isFinite(WARN)) return null

  const makeTurnState = new Function(mkSrc + '\nreturn makeTurnState')()
  const stateMap = new Map()
  const stateFor = (sid) => {
    const k = (typeof sid === 'string' && sid.length > 0) ? sid : ''
    let s = stateMap.get(k)
    if (s === undefined) { s = makeTurnState(k); stateMap.set(k, s) }
    return s
  }

  const pending = []      // narrPendingBatch 的替身：真 narrate / 真 flushNarrBatch 逐字使用它
  const delivered = []    // 走完同步门、被受理的播报（{intent, sid, at}）
  const progress = []     // recordProgress 调用留痕（milestoneCount 语义）
  const recordProgress = (sid, patch) => { progress.push({ sid: sid, patch: patch }) }

  const mkDeliver = new Function(
    'intent', 'opts', 'stateFor', 'NARR_INTENT_GAP_MS', 'Date', 'out', 'clock',
    gateSrc + '\n  out.push({ intent: intent, sid: (opts && typeof opts.sid === "string") ? opts.sid : "", at: clock.t })')
  const deliverNarration = (intent, opts) => {
    mkDeliver(intent, opts, stateFor, GAP, FakeDate, delivered, clock)
    return Promise.resolve()   // flushNarrBatch 对返回值调 .catch
  }

  const flushNarrBatch = new Function(
    'narrPendingBatch', 'NARR_PRIORITY', 'NARR_TICK_DELIVER_WARN', 'deliverNarration', 'console',
    flushSrc + '\nreturn flushNarrBatch')(pending, NARR_PRIORITY, WARN, deliverNarration, console)

  const narrate = new Function(
    'config', 'stateFor', 'NARR_INTENTS', 'NARR_INTENT_GAP_MS', 'bubblePrefixFor',
    'narrPendingBatch', 'narrBatchScheduled', 'flushNarrBatch', 'Date',
    narrateSrc + '\nreturn narrate')(config, stateFor, NARR_INTENTS, GAP, () => '', pending, false, flushNarrBatch, FakeDate)

  const maybeMilestone = new Function(
    'config', 'recordProgress', 'narrate', 'Date',
    mmSrc + '\nreturn maybeMilestone')(config, recordProgress, narrate, FakeDate)

  const resetTurn = new Function('Date', resetSrc + '\nreturn resetTurn')(FakeDate)
  const handleTurnEnd = new Function(
    'config', 'recordProgress', 'narrate', 'Date',
    endSrc + '\nreturn handleTurnEnd')(config, recordProgress, narrate, FakeDate)

  // tool/call 分支的逐字执行器：形参与生产同名（t / st / d / sid / config / narrate / maybeMilestone）
  const toolCallFn = new Function('t', 'st', 'd', 'sid', 'config', 'narrate', 'maybeMilestone',
    toolCallSrc + '\nreturn null')
  const toolCall = (st, sid, name) => toolCallFn('tool/call', st, { name: name }, sid, config, narrate, maybeMilestone)

  return {
    hostSrc: hs, mmSrc, gateSrc, toolCallSrc, clock, config, stateFor, maybeMilestone, narrate, resetTurn, handleTurnEnd,
    toolCall, pending, delivered, progress, makeTurnState,
    // 清空微任务队列：narrate 用 queueMicrotask 排 flushNarrBatch，里程碑的「交付确认」回调排在它之后
    drain: () => new Promise((resolve) => setTimeout(resolve, 0)),
  }
}

// 某个 sid 实际播出的里程碑时刻（毫秒，受控时钟）
const msAt = (R, sid) => R.delivered.filter((d) => d.intent === 'milestone' && d.sid === sid).map((d) => d.at)
const msCount = (R, sid) => msAt(R, sid).length
const bumpCount = (R) => R.progress.filter((p) => p.patch && p.patch.milestoneBump === true).length

// 起一个回合：clock 先拨到 at，再走生产的 resetTurn（回合起点 = at）
function startTurn(R, sid, at) {
  R.clock.t = at
  const st = R.stateFor(sid)
  R.resetTurn(st)
  return st
}
// 一次巡检 tick：拨钟 dt 毫秒 → 调 maybeMilestone → 清微任务
async function tick(R, st, dt) {
  R.clock.t += dt
  R.maybeMilestone(st)
  await R.drain()
}

const T0 = 1700000000000
const MIN_MS = 60000      // narratorMilestoneMs 的 sanitize 下限（host.mjs:660）
const MAX_MS = 1800000    // 上限

test('里程碑按周期播报（长回合里每满间隔再播一条），且被优先级吞掉的那次不永久丢失', async () => {
  // ============================================================
  console.log('\n== 0) 切片健全性（切不到就报红，后面的断言也要看到实况）==')
  // ============================================================
  const R0 = makeRig()
  check('maybeMilestone / narrate / flushNarrBatch / makeTurnState / resetTurn / handleTurnEnd / 同步门 / tool/call 分支 全部切到',
    R0 !== null, 'R0=' + (R0 === null ? 'null' : 'ok'))
  if (R0 === null) {
    console.log('\n[OK] ' + pass + ' 通过 / ' + fail + ' 失败')
    assert.equal(fail, 0, '有 ' + fail + ' 项断言失败')
    return
  }
  check('切出的 maybeMilestone 含四道既有门（narratorOn / turnActive / blocking / stepCount<1）',
    /config\.narratorOn !== true/.test(R0.mmSrc) && /st\.turnActive !== true/.test(R0.mmSrc) &&
    /if \(st\.blocking\) return/.test(R0.mmSrc) && /if \(st\.stepCount < 1\) return/.test(R0.mmSrc))
  check('同步门切片含同意图 8s 合并与占位登记（deliverNarration 的受理判据）',
    /NARR_INTENT_GAP_MS/.test(R0.gateSrc) && /st\.lastSpokeByIntent\.set\(intent, now\)/.test(R0.gateSrc))

  // ============================================================
  console.log('\n== 1) 同一回合内：时间推进到 2×/3× 间隔会重复播报（本条的「前」= 每回合只播一次）==')
  // ============================================================
  {
    const R = makeRig()
    R.config.narratorMilestoneMs = 120000   // 用户的现场设置：2 分钟
    R.config.narratorMilestoneSteps = 10
    const st = startTurn(R, 'sidA', T0)
    st.stepCount = 3                        // stepCount 是纯计数器，生产里由 tool/call 分支 +1
    const marks = []
    // 30s 一巡（与生产的 30s tick 同粒度），共 12 巡 = 6 分钟
    for (let i = 0; i < 12; i++) {
      await tick(R, st, 30000)
      marks.push({ t: R.clock.t - T0, n: msCount(R, 'sidA') })
    }
    const at = msAt(R, 'sidA').map((t) => t - T0)
    check('第 1 条在第 1 个间隔（120s）时播出', at[0] === 120000, 'at=' + JSON.stringify(at))
    check('第 2 条在第 2 个间隔（240s）时播出 —— 长回合里「再播一条」',
      at[1] === 240000, 'at=' + JSON.stringify(at) + ' marks=' + JSON.stringify(marks))
    check('第 3 条在第 3 个间隔（360s）时播出 —— 周期成立（不是只有前两条）',
      at[2] === 360000, 'at=' + JSON.stringify(at))
    check('6 分钟里恰好 3 条（120/240/360s 各一条，没有多播）',
      at.length === 3 && msCount(R, 'sidA') === 3, 'at=' + JSON.stringify(at))
    // 口径说明：bumpCount 统计的是「**触发**时 +1」，不是「播出一条 +1」——被同 tick 优先级吞掉、
    // 或被 narrate() 的同意图 8s 合并窗挡回时都会 +1 而不发声（见 §7b；量级见 §7g：
    // 步数型 0.5s/次工具调用跑 40 步时 bump 13 次而只播 2 条）。本段没有吞/合并发生，
    // 所以「3 次触发 = 3 次 bump」成立；不得据此声称「每播一次 +1」。
    check('§1 这段没有吞/合并 ⇒ 3 次触发 = 3 次 bump（口径 = 触发时 +1，不等价于播出条数）',
      bumpCount(R) === 3, 'bump=' + bumpCount(R))
  }

  // ============================================================
  console.log('\n== 2) 同一回合内：步数增量到 2×/3× 阈值也会重复播报 ==')
  // ============================================================
  {
    const R = makeRig()
    R.config.narratorMilestoneMs = MAX_MS    // 让时间型在本次观测窗内不可能触发
    R.config.narratorMilestoneSteps = 10
    const st = startTurn(R, 'sidB', T0)
    const seen = []                          // [{step, count}]
    for (let i = 1; i <= 30; i++) {
      st.stepCount = i                     // 生产里由 tool/call 分支 st.stepCount += 1
      await tick(R, st, 1000)
      const n = msCount(R, 'sidB')
      if (n !== (seen.length === 0 ? 0 : seen[seen.length - 1].count)) seen.push({ step: i, count: n })
    }
    const stepAt = msAt(R, 'sidB').map((t) => (t - T0) / 1000)   // 1 tick = 1 秒 ⇒ 秒数即步数时刻
    check('步数型也是周期：第 10 / 20 / 30 步各播一条',
      stepAt.length === 3 && stepAt[0] === 10 && stepAt[1] === 20 && stepAt[2] === 30,
      'stepAt=' + JSON.stringify(stepAt) + ' changes=' + JSON.stringify(seen))
    check('步数型不会每步都播（30 步只播 3 条）', msCount(R, 'sidB') === 3, 'n=' + msCount(R, 'sidB'))
  }

  // ============================================================
  console.log('\n== 3) 反向：没到间隔不播（不许退化成「每 tick 都播」/同一时刻连播）==')
  // ============================================================
  {
    const R = makeRig()
    R.config.narratorMilestoneMs = MIN_MS     // 60s（sanitize 下限）
    R.config.narratorMilestoneSteps = 50      // 步数门在本节不参与
    const st = startTurn(R, 'sidC', T0)
    st.stepCount = 5
    const series = []
    for (let i = 0; i < 10; i++) { await tick(R, st, 30000); series.push(msCount(R, 'sidC')) }
    // 巡检时刻 30/60/90/…/300s，间隔 60s ⇒ 到点的只有 60/120/180/240/300s 五次，其余五巡不播
    check('10 次 30s 巡检（共 300s、间隔 60s）⇒ 恰好 5 条（每两巡一条），不是 10 条',
      msCount(R, 'sidC') === 5 && JSON.stringify(series) === JSON.stringify([0, 1, 1, 2, 2, 3, 3, 4, 4, 5]),
      'series=' + JSON.stringify(series))
    check('前 30s 内一次都不播（间隔未到）', series[0] === 0, 'series=' + JSON.stringify(series))
    // 同一时刻连调 100 次：基准已推进 ⇒ 一次都不该再播（时间差 0、步数增量 0）
    const before = msCount(R, 'sidC')
    for (let i = 0; i < 100; i++) { R.maybeMilestone(st) }
    await R.drain()
    check('同一时刻连调 100 次不产生额外播报（幂等，不会因「同 tick」而连播）',
      msCount(R, 'sidC') === before, 'before=' + before + ' after=' + msCount(R, 'sidC'))
  }

  // ============================================================
  console.log('\n== 4) 反向：四道既有门照旧（narratorOn / turnActive / blocking / stepCount<1）==')
  // ============================================================
  {
    // 4a narratorOn=false
    const Ra = makeRig()
    const sa = startTurn(Ra, 'sidD', T0); sa.stepCount = 5
    Ra.clock.t = T0 + 10 * MIN_MS
    Ra.config.narratorOn = false
    Ra.maybeMilestone(sa); await Ra.drain()
    check('narratorOn=false ⇒ 不播（哪怕早已超过间隔）', msCount(Ra, 'sidD') === 0, 'n=' + msCount(Ra, 'sidD'))
    Ra.config.narratorOn = true
    Ra.maybeMilestone(sa); await Ra.drain()
    check('（对照）同一个 st 把开关打开后立刻照播 ⇒ 上一条不是恒真式',
      msCount(Ra, 'sidD') === 1, 'n=' + msCount(Ra, 'sidD'))

    // 4b turnActive=false
    const Rb = makeRig()
    const sb = startTurn(Rb, 'sidE', T0); sb.stepCount = 5
    sb.turnActive = false
    Rb.clock.t = T0 + 10 * MIN_MS
    Rb.maybeMilestone(sb); await Rb.drain()
    check('turnActive=false ⇒ 不播（回合已结束/空闲会话）', msCount(Rb, 'sidE') === 0, 'n=' + msCount(Rb, 'sidE'))

    // 4c blocking
    const Rc = makeRig()
    const sc = startTurn(Rc, 'sidF', T0); sc.stepCount = 5
    sc.blocking = 'b1'
    Rc.clock.t = T0 + 10 * MIN_MS
    Rc.maybeMilestone(sc); await Rc.drain()
    check('blocking=b1 ⇒ 不播（审批等待中不报进度）', msCount(Rc, 'sidF') === 0, 'n=' + msCount(Rc, 'sidF'))

    // 4d stepCount < 1
    const Rd = makeRig()
    const sd = startTurn(Rd, 'sidG', T0)
    Rd.clock.t = T0 + 10 * MIN_MS
    Rd.maybeMilestone(sd); await Rd.drain()
    check('stepCount<1 ⇒ 不播（还没「有据开工」）', msCount(Rd, 'sidG') === 0, 'n=' + msCount(Rd, 'sidG'))
  }

  // ============================================================
  console.log('\n== 5) 回合边界：起点即基准；回合结束后清零，新回合重新计时 ==')
  // ============================================================
  {
    const R = makeRig()
    R.config.narratorMilestoneMs = MIN_MS
    R.config.narratorMilestoneSteps = 50
    const st = startTurn(R, 'sidH', T0)
    check('resetTurn 后基准 = 回合起点（回合刚起不算「距上次」已过）',
      typeof st.lastMilestoneAt === 'number' && st.lastMilestoneAt === T0 && st.lastMilestoneStep === 0,
      'lastMilestoneAt=' + String(st.lastMilestoneAt) + ' lastMilestoneStep=' + String(st.lastMilestoneStep))
    st.stepCount = 4
    await tick(R, st, MIN_MS - 1)
    check('新回合内差 1ms 到间隔 ⇒ 不播（基准确实是本回合起点，没沿用上回合的旧时刻）',
      msCount(R, 'sidH') === 0, 'n=' + msCount(R, 'sidH'))
    await tick(R, st, 1)
    check('到间隔 ⇒ 播第 1 条', msCount(R, 'sidH') === 1, 'n=' + msCount(R, 'sidH'))

    // 回合结束（正常完成路径；narratorDone=false ⇒ 不该有 done 播报干扰计数）
    R.handleTurnEnd({ reason: undefined }, st)
    await R.drain()
    check('handleTurnEnd 后基准清零', st.lastMilestoneAt === 0 && st.lastMilestoneStep === 0,
      'lastMilestoneAt=' + String(st.lastMilestoneAt) + ' lastMilestoneStep=' + String(st.lastMilestoneStep))
    await tick(R, st, MIN_MS * 3)
    check('回合结束后不再播（turnActive 门）', msCount(R, 'sidH') === 1, 'n=' + msCount(R, 'sidH'))

    // 新回合：从自己的起点重新计时
    const T1 = R.clock.t + 1000
    const st2 = startTurn(R, 'sidH', T1)
    st2.stepCount = 4
    check('第二个回合的基准 = 第二个回合的起点', st2.lastMilestoneAt === T1 && st2.lastMilestoneStep === 0,
      'lastMilestoneAt=' + String(st2.lastMilestoneAt) + ' T1=' + T1)
    await tick(R, st2, MIN_MS - 1)
    check('新回合差 1ms ⇒ 不播', msCount(R, 'sidH') === 1, 'n=' + msCount(R, 'sidH'))
    await tick(R, st2, 1)
    check('新回合到间隔 ⇒ 播（本回合的第 1 条；上回合播过不抑制本回合）',
      msCount(R, 'sidH') === 2, 'n=' + msCount(R, 'sidH') + ' at=' + JSON.stringify(msAt(R, 'sidH').map((t) => t - T1)))
  }

  // ============================================================
  console.log('\n== 6) 多会话隔离：一个会话的里程碑不影响另一个（st 是 per-session 的）==')
  // ============================================================
  {
    const R = makeRig()
    R.config.narratorMilestoneMs = 120000
    R.config.narratorMilestoneSteps = 50
    const sA = startTurn(R, 'wsA', T0)
    const sB = startTurn(R, 'wsB', T0 + 60000)   // B 的回合晚 60s 起
    sA.stepCount = 2; sB.stepCount = 7
    R.clock.t = T0                                // startTurn(B) 把钟拨到了 T0+60000，拉回观测起点
    for (let i = 0; i < 12; i++) {                // 360s，30s 一巡
      R.clock.t += 30000
      R.maybeMilestone(sA); R.maybeMilestone(sB)
      await R.drain()
    }
    const aAt = msAt(R, 'wsA').map((t) => t - T0)
    const bAt = msAt(R, 'wsB').map((t) => t - T0)
    check('A 按自己的回合起点播（120s / 240s / 360s）',
      JSON.stringify(aAt) === JSON.stringify([120000, 240000, 360000]), 'aAt=' + JSON.stringify(aAt))
    check('B 按自己的回合起点播（180s / 300s，= 自己的 60s 起 + 间隔），不被 A 的节奏带偏',
      JSON.stringify(bAt) === JSON.stringify([180000, 300000]), 'bAt=' + JSON.stringify(bAt))
    check('A、B 的基准互不覆盖（各自独立计数）',
      R.stateFor('wsA').lastMilestoneAt === T0 + 360000 && R.stateFor('wsB').lastMilestoneAt === T0 + 300000,
      'A=' + String(R.stateFor('wsA').lastMilestoneAt) + ' B=' + String(R.stateFor('wsB').lastMilestoneAt))
    // A 阻塞 → 只抑制 A：480s 这一巡两者都到点，A 静默、B 照播
    R.stateFor('wsA').blocking = 'b1'
    R.clock.t = T0 + 480000
    R.maybeMilestone(sA); R.maybeMilestone(sB)
    await R.drain()
    check('同一巡里 A 阻塞 ⇒ A 不播、B 照播（本会话阻塞不抑制别的会话）',
      msCount(R, 'wsA') === 3 && JSON.stringify(msAt(R, 'wsB').map((t) => t - T0)) === JSON.stringify([180000, 300000, 480000]),
      'a=' + msCount(R, 'wsA') + ' bAt=' + JSON.stringify(msAt(R, 'wsB').map((t) => t - T0)))
  }

  // ============================================================
  console.log('\n== 7) 同 tick 输给更高优先级的那次里程碑不永久丢失（真 narrate + 真 flushNarrBatch）==')
  // ============================================================
  {
    // 7a 先证明「正常交付」这条路：基准留在交付时刻，不会马上重播
    const R = makeRig()
    R.config.narratorMilestoneMs = 120000
    R.config.narratorMilestoneSteps = 50
    const st = startTurn(R, 'sidI', T0)
    st.stepCount = 3
    await tick(R, st, 120000)
    check('7a 到间隔 ⇒ 批次里只有它 ⇒ 被交付', msCount(R, 'sidI') === 1, 'n=' + msCount(R, 'sidI'))
    check('7a 交付后基准 = 交付时刻（不是回滚到回合起点）',
      st.lastMilestoneAt === T0 + 120000, 'lastMilestoneAt=' + String(st.lastMilestoneAt))
    await tick(R, st, 30000)
    check('7a 交付后的下一巡不重播（确认机制不会反过来造成重复播报）', msCount(R, 'sidI') === 1, 'n=' + msCount(R, 'sidI'))

    // 7b 同一同步 tick 里再塞一条 BLOCK（BLOCK40 > MILESTONE10）⇒ 里程碑被批次取优先级吞掉
    const R2 = makeRig()
    R2.config.narratorMilestoneMs = 120000
    R2.config.narratorMilestoneSteps = 50
    const st2 = startTurn(R2, 'sidJ', T0)
    st2.stepCount = 3
    R2.clock.t = T0 + 120000
    const before = st2.lastMilestoneAt
    R2.maybeMilestone(st2)                              // 里程碑入批（排 flush 微任务 + 交付确认微任务）
    R2.narrate('block', { sid: 'sidJ' })                // 同 tick 的更高优先级事件（真 narrate）
    await R2.drain()
    check('7b 同批按 sid 只取最高优先级 ⇒ 这一巡 BLOCK 赢、里程碑没播（真 flushNarrBatch 的判定）',
      msCount(R2, 'sidJ') === 0 &&
      R2.delivered.some((d) => d.intent === 'block' && d.sid === 'sidJ'),
      'delivered=' + JSON.stringify(R2.delivered.map((d) => d.intent + '@' + d.sid)))
    check('7b 被吞掉后基准回滚到「这次尝试之前」（不是被永久消耗掉）',
      typeof before === 'number' && before > 0 && st2.lastMilestoneAt === before,
      'before=' + String(before) + ' now=' + String(st2.lastMilestoneAt))
    await tick(R2, st2, 30000)                          // 下一次 30s 巡检：BLOCK 那批已经过去
    check('7b 下一次巡检就重试成功（不用等满第二个 2 分钟周期，更不是永远不播）',
      msCount(R2, 'sidJ') === 1, 'n=' + msCount(R2, 'sidJ'))
    await tick(R2, st2, 30000)
    check('7b 重试成功之后按新基准正常节流（下一巡不重复播）',
      msCount(R2, 'sidJ') === 1, 'n=' + msCount(R2, 'sidJ'))
    await tick(R2, st2, 90000)                          // 距上次交付满 120s
    check('7b 重试成功后仍按周期继续（交付时刻 + 间隔再播一条）',
      msCount(R2, 'sidJ') === 2 && R2.delivered.filter((d) => d.intent === 'milestone').map((d) => d.at - T0).join(',') === '150000,270000',
      'at=' + JSON.stringify(R2.delivered.filter((d) => d.intent === 'milestone').map((d) => d.at - T0)))

    // 7d 反向：同 tick 里这次里程碑被吞掉、且回合紧接着就结束了
    //    ⇒ 交付确认回调**不能**把旧基准写回去，否则 §5 的「回合结束后基准清零」就有例外。
    const R3 = makeRig()
    R3.config.narratorMilestoneMs = 120000
    R3.config.narratorMilestoneSteps = 50
    const st3 = startTurn(R3, 'sidK', T0)
    st3.stepCount = 3
    R3.clock.t = T0 + 120000
    R3.maybeMilestone(st3)                          // 里程碑入批（基准被推进到 T0+120000）
    R3.narrate('block', { sid: 'sidK' })            // 同 tick 更高优先级 ⇒ 这次里程碑会被吞
    R3.handleTurnEnd({ reason: undefined }, st3)    // 同 tick 回合结束（基准清零、turnActive=false）
    await R3.drain()
    check('7d 同 tick 里回合结束 ⇒ 基准保持 handleTurnEnd 清出的 0（确认回调不把旧基准写回）',
      st3.turnActive === false && st3.lastMilestoneAt === 0 && st3.lastMilestoneStep === 0,
      'turnActive=' + String(st3.turnActive) + ' lastMilestoneAt=' + String(st3.lastMilestoneAt) + ' lastMilestoneStep=' + String(st3.lastMilestoneStep))

    // 7e 第三条回滚路径：narrate() **自己的**同意图 8s 预筛（host.mjs 3436~3440）在**入批之前**就把这次
    //    尝试挡回（reason='merged-same-intent'，连批都进不去）⇒ 槽不变 ⇒ 回滚 ⇒ 窗口一过就补播。
    //    这是 §7b（批次优先级）与 §7d（回合边界）之外的第三条路径，必须单独有守卫。
    const R4 = makeRig()
    R4.config.narratorMilestoneMs = MAX_MS      // 时间型不参与，只看步数周期
    R4.config.narratorMilestoneSteps = 3
    const st4 = startTurn(R4, 'sidL', T0)
    for (let i = 1; i <= 14; i++) {             // 1 巡 = 1 步 = 1000ms
      st4.stepCount = i
      await tick(R4, st4, 1000)
    }
    const at4 = msAt(R4, 'sidL').map((t) => t - T0)
    // 第 3 步（t=3000）播第 1 条；此后每步都「距上次里程碑满 3 步」，但 8s 窗内会被挡回：
    // 补播时刻 = max(6000, 3000 + ceil(GAP/1000)*1000)（GAP = NARR_INTENT_GAP_MS；8000 ⇒ 11000）
    const GAP = numConst('NARR_INTENT_GAP_MS')
    const expectRetry4 = Math.max(6000, 3000 + Math.ceil(GAP / 1000) * 1000)
    check('7e narrate 的 8s 预筛挡回 ⇒ 不丢也不重：窗口一过补上第 2 条（回滚让重试落在最早可能的一巡）',
      JSON.stringify(at4) === JSON.stringify([3000, expectRetry4]),
      'at=' + JSON.stringify(at4) + ' expect=' + JSON.stringify([3000, expectRetry4]))

    // 7f 边角新行为：静默长回合（已过一个周期、期间没有任何工具调用）的**第一个**工具调用会让
    //    START(5) 与 MILESTONE(10) 在**同一 tick** 入批 ⇒ 里程碑赢、START 被吞。
    //    改动前这条路径只播 START（旧预筛 `st.stepCount >= steps` 在 stepCount===1 时不成立）。
    //    用户仍能听到一条，且那种场景下 START（「开工了」）本就陈旧 —— 记为可接受的新行为。
    const R5 = makeRig()
    R5.config.narratorMilestoneMs = MIN_MS       // 60s
    R5.config.narratorMilestoneSteps = 50
    const st5 = startTurn(R5, 'sidM', T0)
    R5.clock.t = T0 + MIN_MS + 1000             // 静默已超过一个周期（期间无工具调用 ⇒ 巡检被 stepCount<1 挡住）
    R5.toolCall(st5, 'sidM', 'Read')            // 逐字跑生产里 tool/call 分支那一整段（含它的 START 与里程碑次序）
    await R5.drain()
    check('7f 静默长回合的第一个工具调用 ⇒ 里程碑(10) 挤掉 START(5)（同 tick、按 sid 只取最高优先级；旧码此处只播 START）',
      JSON.stringify(R5.delivered.map((d) => d.intent)) === JSON.stringify(['milestone']) &&
      msCount(R5, 'sidM') === 1,
      'spoken=' + JSON.stringify(R5.delivered.map((d) => d.intent)))
    check('7f 源码锚点：tool/call 分支已无「本回合一次性」预筛（旧写法必须消失），且 NARR_PRIORITY.milestone > .start',
      !/!st\.milestoneSpoken && st\.stepCount >= steps/.test(SRC) &&
      (objNumConst('NARR_PRIORITY') || {}).milestone > (objNumConst('NARR_PRIORITY') || {}).start)

    // 7g milestoneCount 的真实口径 = 「**触发**次数」，不是「播出条数」：
    //    回滚 + narrate() 的 8s 合并窗 ⇒ 每次被挡回的重试都白记一次 ⇒ 密集工具调用下会放大。
    //    （数字与独立验证 `real-chain.mjs` S8 一致：0.5s/步 13 次/2 条、对照组 4/2、1s/步 4/4）
    const bumpRun = async (rig, perStepMs, steps) => {
      rig.config.narratorMilestoneMs = MAX_MS
      rig.config.narratorMilestoneSteps = 10
      const st = startTurn(rig, 'sidN', T0)
      for (let i = 1; i <= steps; i++) { st.stepCount = i; await tick(rig, st, perStepMs) }
      return { bump: bumpCount(rig), spoken: msCount(rig, 'sidN'), at: msAt(rig, 'sidN').map((t) => t - T0) }
    }
    const dense = await bumpRun(makeRig(), 500, 40)      // 0.5s/步：窗口内被挡回的重试每次白记一次
    const slow = await bumpRun(makeRig(), 1000, 40)      // 1s/步：每次到点都真发声
    const noRbSrc = R0.mmSrc.replace(/if \(st\.lastSpokeByIntent\.get\('milestone'\) === beforeSameAt\) \{/, 'if (false) {')
    const noRbRig = noRbSrc !== R0.mmSrc ? makeRig(R0.hostSrc.replace(R0.mmSrc, noRbSrc)) : null
    const denseNoRb = noRbRig === null ? null : await bumpRun(noRbRig, 500, 40)
    console.log('  [info] 7g 40 步 @0.5s：带回滚 bump=' + dense.bump + ' / spoken=' + dense.spoken + ' at=' + JSON.stringify(dense.at) +
      '；去掉回滚 bump=' + (denseNoRb === null ? 'n/a' : denseNoRb.bump) + ' / spoken=' + (denseNoRb === null ? 'n/a' : denseNoRb.spoken))
    console.log('  [info] 7g 40 步 @1.0s：带回滚 bump=' + slow.bump + ' / spoken=' + slow.spoken + ' at=' + JSON.stringify(slow.at))
    check('7g 计数口径 = 触发次数：密集节奏下 bump 多于播出条数，慢节奏下两者相等',
      dense.bump > dense.spoken && slow.bump === slow.spoken && dense.bump > slow.bump,
      'dense=' + dense.bump + '/' + dense.spoken + ' slow=' + slow.bump + '/' + slow.spoken)
    check('7g 对照组（去掉回滚）同场景 bump 更少、播出条数相同 ⇒ 放大确实来自回滚',
      denseNoRb !== null && denseNoRb.bump < dense.bump && denseNoRb.spoken === dense.spoken,
      'noRollback=' + (denseNoRb === null ? 'null' : denseNoRb.bump + '/' + denseNoRb.spoken) +
      ' rollback=' + dense.bump + '/' + dense.spoken)
  }

  // ============================================================
  console.log('\n== 8) 元自检：把三处变异注入**内存切片**，本测试的判据必须报红（判据非恒真）==')
  // ============================================================
  {
    // ---- 变异 1：退回「本回合一次性」（就是本次修掉的那个 bug：加回 milestoneSpoken 闸门） ----
    const oneShot = R0.mmSrc.replace('if (st.blocking) return',
      'if (st.blocking) return\n      if (st.milestoneSpoken) return')
    const hit1 = oneShot !== R0.mmSrc
    const Rm1 = hit1 ? makeRig(R0.hostSrc.replace(R0.mmSrc, oneShot)) : null
    let m1At = null
    if (Rm1 !== null) {
      Rm1.config.narratorMilestoneMs = 120000
      Rm1.config.narratorMilestoneSteps = 10
      const st = startTurn(Rm1, 'sidA', T0); st.stepCount = 3
      for (let i = 0; i < 12; i++) await tick(Rm1, st, 30000)
      m1At = msAt(Rm1, 'sidA').map((t) => t - T0)
    }
    check('元自检：加回「本回合只播一次」后，§1 的「2×/3× 间隔再播」必须报红（实际只剩 1 条）',
      hit1 && Rm1 !== null && JSON.stringify(m1At) === JSON.stringify([120000]),
      'mutated=' + hit1 + ' at=' + JSON.stringify(m1At))

    // ---- 变异 2：忽略间隔（ms 恒为 0）⇒ §3 的「没到间隔不播」必须报红 ----
    const zeroMs = R0.mmSrc.replace(/const ms = typeof config\.narratorMilestoneMs === 'number' \? config\.narratorMilestoneMs : \d+/,
      'const ms = 0')
    const hit2 = zeroMs !== R0.mmSrc
    const Rm2 = hit2 ? makeRig(R0.hostSrc.replace(R0.mmSrc, zeroMs)) : null
    let m2N = null
    if (Rm2 !== null) {
      Rm2.config.narratorMilestoneSteps = 50
      const st = startTurn(Rm2, 'sidC', T0); st.stepCount = 5
      for (let i = 0; i < 10; i++) await tick(Rm2, st, 30000)
      m2N = msCount(Rm2, 'sidC')
    }
    check('元自检：间隔被忽略后，§3 的「10 巡只播 2 条」必须报红（实际变成每巡都播）',
      hit2 && Rm2 !== null && m2N === 10, 'mutated=' + hit2 + ' n=' + String(m2N))

    // ---- 变异 3：去掉「被吞掉 ⇒ 回滚基准」⇒ §7b 的「下一次巡检（+30s）就重试」必须报红 ----
    // 注意判据的形态：周期制本身已经保证「不会永久丢失」（最迟下一个周期 +120s 会重试），
    // 回滚买到的是**快一个周期**（+30s 就重试）。所以这里钉的是重试时刻，不是「有没有重试」。
    const noRollback = R0.mmSrc.replace(/if \(st\.lastSpokeByIntent\.get\('milestone'\) === beforeSameAt\) \{/,
      'if (false) {')
    const hit3 = noRollback !== R0.mmSrc
    const Rm3 = hit3 ? makeRig(R0.hostSrc.replace(R0.mmSrc, noRollback)) : null
    let m3At = null
    if (Rm3 !== null) {
      Rm3.config.narratorMilestoneMs = 120000
      Rm3.config.narratorMilestoneSteps = 50
      const st = startTurn(Rm3, 'sidJ', T0); st.stepCount = 3
      Rm3.clock.t = T0 + 120000
      Rm3.maybeMilestone(st)
      Rm3.narrate('block', { sid: 'sidJ' })
      await Rm3.drain()
      for (let i = 0; i < 4; i++) await tick(Rm3, st, 30000)   // 被吞掉之后的 4 次巡检（150/180/210/240s）
      m3At = msAt(Rm3, 'sidJ').map((t) => t - T0)
    }
    check('元自检：去掉回滚后，§7b 的「+30s 就重试」必须报红（实际等满下一个周期 +120s 才重试）',
      hit3 && Rm3 !== null && JSON.stringify(m3At) === JSON.stringify([240000]),
      'mutated=' + hit3 + ' at=' + JSON.stringify(m3At))
  }

  console.log('\n[OK] ' + pass + ' 通过 / ' + fail + ' 失败')
  assert.equal(fail, 0, '有 ' + fail + ' 项断言失败')
})
