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
// 这段逻辑嵌在 narrateSummary 里、依赖 config/memory/aiComplete 等一堆上下文，无法像其它测试那样
// 抽出来执行，故改用**源码锚点断言**守住修复不被改回去。
//
// 运行：node --test test/narrator-multisession.test.mjs

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const HOST = new URL('../host.mjs', import.meta.url)
const src = readFileSync(HOST, 'utf8')

let pass = 0
let fail = 0
function check(name, cond) {
  if (cond) { pass++; console.log('  [PASS] ' + name) }
  else { fail++; console.log('  [FAIL] ' + name) }
}

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
  check('已知次生影响（lastLLMAt 全局节流会互相压制）已在注释里标注为本次未动',
    /lastLLMAt.*的全局节流同理/.test(src))

  console.log('\n== 4) 全局摘要不再被当作「某个会话的上下文」 ==')
  // 真正要守住的是：globalSummary 这个局部变量只能出现在两处 —— 定义处、以及 allowGlobalFallback 的兜底处。
  // 任何第三处引用都意味着它又被塞回 per-session 上下文里了。
  const uses = [...src.matchAll(/globalSummary/g)].length
  check('globalSummary 变量只有「定义 + 单会话兜底」两处引用（实际 ' + uses + ' 处）', uses === 2)
  // narrGlobal.lastSummary 自身仍应只出现在这些正当位置：落盘、读档、写入、定义处、面板读取、注释。
  // 注意按**行**去重（同一行内可能引用多次，例如 typeof 检查 + 取值）。
  const rawRows = new Set([...src.matchAll(/narrGlobal\.lastSummary/g)]
    .map((m) => src.slice(0, m.index).split('\n').length))
  check('narrGlobal.lastSummary 只出现在 6 行正当位置（落盘/读档/写入/定义/面板/注释，实际 ' + rawRows.size + ' 行）',
    rawRows.size <= 6)

  console.log('\n[OK] ' + pass + ' 通过 / ' + fail + ' 失败')
  assert.equal(fail, 0, '有 ' + fail + ' 项断言失败')
})
