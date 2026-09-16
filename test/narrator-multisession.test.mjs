// 多会话播报串台回归测试
//
// 用户实测（2026-09-15）：qnmobile_artist 工作区里两个会话的进度播报串台 ——
//   A 会话「Max减面合图后缀错误」首次触发 milestone 时，播出了
//   「QnMobile_Artistの最終確認、続けて見守っていますわ」，而那其实是
//   B 会话「特效自动化LOD工具代码与架构整理」上一轮 done 总结的改写。
//
// 根因：narrateSummary 构造 prompt 时，本会话的分片摘要为空就**回落全局** narrGlobal.lastSummary，
//   而全局是"最后说话的那个会话"的总结（写入侧在函数末尾无条件覆盖它）⇒ LLM 读到别的会话的进展，
//   生成张冠李戴的播报；那句又被写回本会话的分片，污染随之固化。
//   sid ↔ label 的归属本身没错（timeline 与 narrator.json 里 8 个会话各自的 label 都是对的）。
//
// 修法：多会话模式下不再回落全局（没有本会话分片就写「（なし）」）；单会话模式下全局就是这个会话
//   自己，回落等价，保持原样以零回归；无 sid（无归属播报）同样不回落。
//
// 这段逻辑嵌在 narrateSummary 里、依赖 config/memory/aiComplete 等一堆上下文，无法整函数执行，
// 故 prompt 隔离那一部分（§1~§4）仍用**源码锚点断言**守住修复不被改回去。
//
// §5/§6 是 I-3「按会话节流」的**行为覆盖**（独立复审 Important-2 的修法）：
//   · §5 把 narrateSummary 里那道 8s 节流门（gateSid … `if (now - gateAt < NARR_LLM_GAP_MS) return null`）
//     按行**原样切出来求值**，用真实输入观测它拦不拦；写入侧用**真实的 recordProgress**、
//     读档侧用**真实的 sanitizeProgressMap / sanitizeProgressEntry**，把
//     「登记 → 拦住同会话 → 不影响别的会话 → 重启读档后仍拦得住」串成一条可执行的链。
//   · §6 是元自检：把「节流被停用」「节流改回全局」「读档丢 lastLLMAt」三个变异注入**内存切片**，
//     同一组判据必须报红 —— 以证明 §5 不是恒真式（这正是"把 host 那行改成 if (false) 仍 13/0 全绿"那个洞）。
//
// 运行：node --test test/narrator-multisession.test.mjs

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const HOST = new URL('../host.mjs', import.meta.url)
const src = readFileSync(HOST, 'utf8')

let pass = 0
let fail = 0
// 第三个形参是可选诊断串（独立复审 Minor-5 的教训：同目录另一个测试把第三个实参静默丢了，
// 失败时只剩断言名）。不传时输出与原来逐字一致。
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  [PASS] ' + name) }
  else { fail++; console.log('  [FAIL] ' + name + (extra === undefined ? '' : '  ← ' + extra)) }
}

// ------------------------------------------------------------
// 切片器（与 test/voiceoff-no-audio.test.mjs 同一套手法）：花括号配对，**原样**切出生产代码，不做任何改写。
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
const truncCpsStub = (s, n) => String(s === undefined || s === null ? '' : s).slice(0, n)

test('进度播报的上下文按会话隔离，不回落到全局摘要', () => {
  console.log('\n== 1) 修复本身在位 ==')
  check('存在 allowGlobalFallback 开关，且要求 multiSession === false',
    /const allowGlobalFallback = config\.multiSession === false && wsSid\.length > 0/.test(src))
  check('prevSummary 只在允许回落时才用 globalSummary',
    /const prevSummary = truncCps\(shardSummary \|\| \(allowGlobalFallback \? globalSummary : ''\), 200\)/.test(src))
  check('旧的「shardSummary || globalSummary」写法已消失',
    !/truncCps\(shardSummary \|\| globalSummary/.test(src))

  console.log('\n== 2) 分片仍按 sid 取、且写入侧同步写分片（别把隔离机制一起删了）==')
  check('shardProgress 按 wsSid 取 memory.progress[wsSid]',
    /const shardProgress = \(wsSid\.length > 0 && memory\.progress && typeof memory\.progress === 'object'\) \? memory\.progress\[wsSid\] : undefined/.test(src))
  check('写入侧仍把总结写进本会话分片（recordProgress(o.sid, { lastSummary … })）',
    /recordProgress\(o\.sid, \{ lastSummary:/.test(src))
  check('wsSid 仍来自调用方显式传入的 sid', /const wsSid = \(typeof o\.sid === 'string' && o\.sid\.length > 0\) \? o\.sid : ''/.test(src))
  check('工作区名仍按 sid 取 label（labelForSid(wsSid)）', /const wsLabel = labelForSid\(wsSid\)/.test(src))

  console.log('\n== 3) 现场证据留下的坐标（便于日后复查这条修复）==')
  check('注释里记录了实测现场（A 会话首次 milestone 说出 B 会话的进展）',
    src.includes('QnMobile_Artistの最終確認') && src.includes('多会话串台'))
  check('注释里点明了全局 lastSummary 的真实语义（"最后说话的那个会话"的总结）',
    /全局是"最后说话的那个会话"的总结/.test(src))
  check('I-3：lastLLMAt 的节流已按会话下沉（不再是"已知但未动"）',
    /const gateAt = \(gateSid\.length > 0\)/.test(src) &&
    /recordProgress\(gateSid, \{ lastLLMAt: now \}\)/.test(src) &&
    /lastLLMAt: \(typeof e\.lastLLMAt === 'number' && isFinite\(e\.lastLLMAt\)\) \? e\.lastLLMAt : 0/.test(src))
  check('I-3：无归属（无 sid）时仍回落全局节流值（与旧行为一致）',
    /: \(narrGlobal\.lastLLMAt \|\| 0\)/.test(src))

  console.log('\n== 4) 全局摘要不再被当作「某个会话的上下文」 ==')
  // 真正要守住的是：globalSummary 这个局部变量只能出现在两处 —— 定义处、以及 allowGlobalFallback 的兜底处。
  // 任何第三处引用都意味着它又被塞回 per-session 上下文里了。
  const uses = [...src.matchAll(/globalSummary/g)].length
  check('globalSummary 变量只有「定义 + 单会话兜底」两处引用（实际 ' + uses + ' 处）', uses === 2)
  // 先剥掉注释行再统计 —— 否则"以后在注释里再提一次"会假红，而"真出现第 7 处代码引用、同时删掉一处注释"
  // 又会漏过（独立复审 Minor-5 指出原写法恰好顶格、且把注释行算了进去）。
  const srcNoComments = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
  const codeRows = new Set([...srcNoComments.matchAll(/narrGlobal\.lastSummary/g)]
    .map((m) => srcNoComments.slice(0, m.index).split('\n').length))
  check('剥掉注释后，narrGlobal.lastSummary 只剩 5 处代码引用（落盘/读档/写入/定义/面板，实际 ' + codeRows.size + ' 行）',
    codeRows.size <= 5)

  // ============================================================
  // §5 I-3「按会话节流」的行为覆盖；§6 是它的元自检（判据必须能被改坏）
  // ============================================================
  console.log('\n== 5) I-3 行为覆盖：8s 节流门真的按会话分片读（切片求值，不是字形锚点）==')
  {
    // --- 5.0 切片健全性：锚点 + 行数上界 + 关键字。切不到就**报红**（不 FATAL，后面的断言也要看到实况）---
    const lines = src.split('\n')
    const gi = lines.findIndex((l) => /^ {6}const gateSid = \(typeof o\.sid/.test(l))
    const gj = lines.findIndex((l) => /^ {6}if \(now - gateAt < NARR_LLM_GAP_MS\) return null\r?$/.test(l))
    const sliceOk = gi >= 0 && gj > gi && (gj - gi) <= 12
    // 统一去掉行尾 \r，切片里不混行尾（本文件读的是 CRLF 源码）
    const gateSrc = sliceOk ? lines.slice(gi, gj + 1).join('\n').split('\r').join('') : ''
    check('切片：节流门的源码锚点仍在（gateSid … 8s 比较），切片 1~12 行且含 lastLLMAt / NARR_LLM_GAP_MS',
      sliceOk && gateSrc.length > 150 && gateSrc.length < 1500 &&
      /lastLLMAt/.test(gateSrc) && /NARR_LLM_GAP_MS/.test(gateSrc),
      'gi=' + gi + ' gj=' + gj + ' len=' + gateSrc.length)

    const mkGate = (source) => {
      try {
        return new Function('o', 'memory', 'narrGlobal', 'NARR_LLM_GAP_MS', 'now',
          source + '\n  return { blocked: false, gateAt: gateAt, gateSid: gateSid }')
      } catch (e) { return null }
    }
    const gate = sliceOk ? mkGate(gateSrc) : null
    check('切片：切出来的节流门可以被求值（new Function 构造成功）', typeof gate === 'function')

    const mGap = /const NARR_LLM_GAP_MS = (\d+)/.exec(src)
    const GAP = mGap ? Number(mGap[1]) : 0
    // Minor-R2-2（独立复审）：这一条原先只判 `GAP > 0`，而 §5 的输入是**跟着 GAP 自适应**的
    // （新鲜侧固定 T-1000，过期侧用 T-GAP-1）⇒ 只抓小不抓大：8000→80 会红，
    // 8000→8000000 仍 29/0 全绿。而 8000000ms ≈ 2.2 小时意味着这个会话实际上**再也不会被总结**
    // （节流永不生效 = 用户看得见的后果），所以把量级也钉住：节流窗是"秒级"（1s~60s）。
    // 超出这个带就报红，需连同文件头那句「8s 节流门」的语义一起改。
    check('NARR_LLM_GAP_MS 量级在 1s~60s（Minor-R2-2：8000000 这种"节流永不生效"必须报红）',
      GAP >= 1000 && GAP <= 60000, 'GAP=' + GAP)

    const T = 1700000000000
    // 判据：门返回 null ⇔ 被拦住（"这条总结不该跑"，调用方走模板句）
    const blockedWith = (g, sid, mem, glob, now) => g !== null && g({ sid: sid }, mem, glob, GAP, now) === null

    // --- 5.1 门值取法的行为：按会话、回落全局、老档按 0 ---
    // A 会话刚总结过（分片新鲜），同时全局 lastLLMAt 也被写新鲜（recordProgress 之外 narrateSummary 还会写全局）
    const globFresh = { lastLLMAt: T - 1000, sessions: {} }
    const memTwo = { progress: { sidA: { lastLLMAt: T - 1000 }, sidB: { milestoneCount: 3, updatedAt: T - 1000 } } }
    check('同会话 8s 内第二次 → 拦住（这条在"节流被停用"时必红）',
      blockedWith(gate, 'sidA', memTwo, globFresh, T) === true,
      'gate=' + (gate === null ? 'null' : 'ok'))
    check('另一个会话**不受** A 的节流影响 → 放行（这条在"节流改回全局"时必红）',
      blockedWith(gate, 'sidB', memTwo, globFresh, T) === false)
    check('同会话但已超过 8s → 放行',
      blockedWith(gate, 'sidA', { progress: { sidA: { lastLLMAt: T - GAP - 1 } } }, globFresh, T) === false)
    check('无 sid（无归属）→ 仍回落全局节流值：全局新鲜则拦住（与旧行为一致）',
      blockedWith(gate, '', { progress: {} }, globFresh, T) === true)
    check('无 sid + 全局也已过期 → 放行',
      blockedWith(gate, '', { progress: {} }, { lastLLMAt: T - GAP - 1 }, T) === false)
    check('分片在但缺 lastLLMAt（老档）→ 按 0 处理 ⇒ 放行（注释声称的语义）',
      blockedWith(gate, 'sidC', { progress: { sidC: { milestoneCount: 2 } } }, globFresh, T) === false)

    // --- 5.2 写入侧：真实的 recordProgress 登记之后，同一 memory 立刻被门拦住（读写同一个字段）---
    const recSrc = sliceFunction(src, 'recordProgress')
    check('切片：recordProgress 抽到了', typeof recSrc === 'string' && recSrc.length > 400,
      'len=' + (recSrc === null ? 'null' : recSrc.length))
    const memLive = { progress: {} }
    const globLive = { lastLLMAt: 0, sessions: {} }
    let registered = null
    if (typeof recSrc === 'string') {
      try {
        const recordProgress = new Function(
          'memory', 'narrGlobal', 'sessions', 'truncCps', 'NARR_PROGRESS_MAX', 'progressShardIsLive',
          'scheduleSaveMemory', 'scheduleSaveNarrator',
          recSrc + '\nreturn recordProgress'
        )(memLive, globLive, new Map(), truncCpsStub, 64, () => false, () => {}, () => {})
        registered = recordProgress('sidLive', { lastLLMAt: T - 500 })
      } catch (e) { registered = null }
    }
    check('真实 recordProgress 登记 → 分片里出现 lastLLMAt，且同一分片立刻被门拦住',
      registered !== null && memLive.progress.sidLive && memLive.progress.sidLive.lastLLMAt === T - 500 &&
      blockedWith(gate, 'sidLive', memLive, globLive, T) === true,
      'shard=' + JSON.stringify(memLive.progress.sidLive))

    // --- 5.3 ⑤ 读档链：真实 sanitizeProgressMap / sanitizeProgressEntry（loadMemory 走的就是它）---
    const entrySrc = sliceFunction(src, 'sanitizeProgressEntry')
    const mapSrc = sliceFunction(src, 'sanitizeProgressMap')
    const sanOk = typeof entrySrc === 'string' && typeof mapSrc === 'string'
    const mkSan = (entry, map) => {
      try {
        return new Function('truncCps', entry + '\n' + map + '\nreturn sanitizeProgressMap')(truncCpsStub)
      } catch (e) { return null }
    }
    const sanitizeProgressMap = sanOk ? mkSan(entrySrc, mapSrc) : null
    // 落盘形态 = saveMemoryNow 写的 JSON.stringify(memory)；重启 = loadMemory 的 sanitizeProgressMap
    const persisted = JSON.parse(JSON.stringify(memLive))
    const reloaded = sanitizeProgressMap === null ? null : { progress: sanitizeProgressMap(persisted.progress) }
    check('重启读档（sanitizeProgressMap）后分片里**仍有** lastLLMAt（⑤：落盘字段不再被丢）',
      reloaded !== null && reloaded.progress.sidLive && reloaded.progress.sidLive.lastLLMAt === T - 500,
      'shard=' + (reloaded === null ? 'null' : JSON.stringify(reloaded.progress.sidLive)))
    check('重启后该会话的第一句总结**仍被** 8s 门拦住（这条在"读档丢 lastLLMAt"时必红）',
      reloaded !== null && blockedWith(gate, 'sidLive', reloaded, globLive, T) === true)

    // ============================================================
    console.log('\n== 6) 元自检：把三个变异注入**内存切片**，§5 的判据必须报红（判据非恒真）==')
    // ============================================================
    // 变异 1：节流整条停用（独立复审实测的那个改坏：`if (false) return null`）
    const offSrc = gateSrc.split('if (now - gateAt < NARR_LLM_GAP_MS) return null').join('if (false) return null')
    const offHit = sliceOk && offSrc !== gateSrc
    const gOff = offHit ? mkGate(offSrc) : null
    check('元自检：节流被停用后，「同会话 8s 内第二次 → 拦住」必须报红（实际变成放行）',
      offHit && gOff !== null && blockedWith(gOff, 'sidA', memTwo, globFresh, T) === false,
      'mutated=' + offHit)

    // 变异 2：节流改回**全局**（不再按会话分片读）—— 就是本分支修掉的那个跨会话耦合
    const globSrc = gateSrc.replace(
      /const gateAt = \(gateSid\.length > 0\)[\s\S]*?: \(narrGlobal\.lastLLMAt \|\| 0\)/,
      'const gateAt = (narrGlobal.lastLLMAt || 0)')
    const globHit = sliceOk && globSrc !== gateSrc
    const gGlob = globHit ? mkGate(globSrc) : null
    check('元自检：节流改回全局后，「另一个会话不受影响 → 放行」必须报红（实际变成拦住）',
      globHit && gGlob !== null && blockedWith(gGlob, 'sidB', memTwo, globFresh, T) === true,
      'mutated=' + globHit)

    // 变异 3：读档时丢掉 lastLLMAt（把 ⑤ 的白名单那行删掉）
    const dropRe = /\r?\n {6}if \(typeof v\.lastLLMAt === 'number' && isFinite\(v\.lastLLMAt\)\) out\.lastLLMAt = v\.lastLLMAt/
    const droppedEntry = sanOk ? entrySrc.replace(dropRe, '') : ''
    const dropHit = sanOk && droppedEntry !== entrySrc
    const droppedMap = dropHit ? mkSan(droppedEntry, mapSrc) : null
    const reloadedDropped = droppedMap === null ? null : { progress: droppedMap(persisted.progress) }
    check('元自检：读档丢掉 lastLLMAt 后，「重启后第一句仍被拦住」必须报红（字段确实丢了、门确实放行）',
      dropHit && reloadedDropped !== null &&
      !(reloadedDropped.progress.sidLive && typeof reloadedDropped.progress.sidLive.lastLLMAt === 'number') &&
      blockedWith(gate, 'sidLive', reloadedDropped, globLive, T) === false,
      'mutated=' + dropHit + ' shard=' + (reloadedDropped === null ? 'null' : JSON.stringify(reloadedDropped.progress.sidLive)))
  }

  console.log('\n[OK] ' + pass + ' 通过 / ' + fail + ' 失败')
  assert.equal(fail, 0, '有 ' + fail + ' 项断言失败')
})
