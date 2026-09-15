#!/usr/bin/env node
// ============================================================
// SAKIKO for DSH — 语音就绪闸门回归测试（v2.2.0）
// ============================================================
// 测什么：`speakSynced` 之前那道「等语音真的能出声再合成」的闸门
//   （host.mjs 里的 `VOICE_WAIT_*` 常量 + `voiceBackendReadyNow` + `waitVoiceReady`）。
//
// 为什么用「源码抽取」而不是 import host.mjs：
//   host.mjs 是 Cordis 插件，顶层 `export function apply(ctx)`，所有逻辑都在 apply 的闭包内，
//   模块级既没有导出这些函数、也没有可用的 ctx。要在**不重启 DSH**（重启会杀掉当前会话宿主）
//   的前提下测到**真实代码**，唯一诚实的办法就是把闭包里那段原样抽出来、用 mock 依赖求值。
//   抽取靠注释锚点定位 —— 改动那段的边界注释会让本测试直接报「锚点丢失」，
//   而不是静默测了个空壳（宁可炸，不可假绿）。
//
// 与真实启动现场（2026-09-15 实测）的关系：
//   voice-autostart.log：开始自启动 → 41~56s 后 api 就绪 → 桥才开始在听
//   旧代码：入口固定 15s 就播报 ⇒ 那一刻桥(当时默认 8000)没在听 ⇒ 连接被拒 ⇒ **有气泡没声音**
//   本测试第 4 组就是复刻那个窗口：桥不可达时**必须等**，而不是探一次就放弃。
//
// 关于虚拟时钟：waitVoiceReady 内部用 `Date.now()` 算超时、用真 `setTimeout` 睡眠。
//   测试把提取块里的 `Date` 换成一个由 driveClock() 手动推进的累加器
//   （每 50ms 真实时间推进 VOICE_WAIT_INTERVAL_MS），于是「等 4 分钟」在测试里是亚秒级，
//   而轮询次数、超时判定走的仍是真源码逻辑。
//
// 跑法：node test/voice-ready-gate.test.mjs
// 零新依赖：只用 node: 内置模块。
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const HOST = join(HERE, '..', 'host.mjs')
const src = readFileSync(HOST, 'utf8')

let pass = 0
let fail = 0
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  [PASS] ' + name) }
  else { fail++; console.log('  [FAIL] ' + name + (extra === undefined ? '' : '  ← ' + extra)) }
}

const startAnchor = '// 语音就绪闸门（v2.2.0）'
const endAnchor = '// 通用同步出声：所有宿主发起的固定话语'
const i0 = src.indexOf(startAnchor)
const i1 = src.indexOf(endAnchor, i0 + 1)
if (i0 < 0 || i1 < 0 || i1 <= i0) {
  console.error('[FATAL] 抽取锚点丢失（i0=' + i0 + ' i1=' + i1 + '）—— host.mjs 的「语音就绪闸门」注释块被改动过，请同步更新本测试')
  process.exit(2)
}
const block = src.slice(i0, i1)

// 真源里的常量必须先自查（防止有人把上限误改成毫秒级/几十小时、把间隔改成 0 造成轮询风暴）
{
  const mMax = /const VOICE_WAIT_MAX_MS = (\d+)/.exec(block)
  const mInt = /const VOICE_WAIT_INTERVAL_MS = (\d+)/.exec(block)
  ok('host.mjs 有 VOICE_WAIT_MAX_MS 且在 60s~10min 量级',
    mMax !== null && Number(mMax[1]) >= 60000 && Number(mMax[1]) <= 600000, mMax === null ? 'missing' : mMax[1])
  ok('host.mjs 有 VOICE_WAIT_INTERVAL_MS 且在 1s~10s 之间（不是 0：防轮询风暴）',
    mInt !== null && Number(mInt[1]) >= 1000 && Number(mInt[1]) <= 10000, mInt === null ? 'missing' : mInt[1])
}
// 测试用的加速版：等待上限 700ms 虚拟时间、间隔 120ms 虚拟时间
const blockFast = block
  .replace(/const VOICE_WAIT_MAX_MS = \d+/, 'const VOICE_WAIT_MAX_MS = 700')
  .replace(/const VOICE_WAIT_INTERVAL_MS = \d+/, 'const VOICE_WAIT_INTERVAL_MS = 120')

// 按抽取到的源码构造一个可调用环境（依赖全用 mock 包起来）。
//   eval 的位置是关键，两处都踩过坑：
//     ① 不能用内层箭头函数把 eval 包起来 —— 那样 eval 体里声明的
//        `async function voiceBackendReadyNow` 会**绑定在内层函数作用域**，
//        内层返回后它就丢了（实测报 `voiceShared is not defined`，因为它退化成全局查找）；
//     ② 必须用**直接 eval**（`eval(code)` 而不是 `(0, eval)(code)`），这样提取块里的
//        函数声明才能看见工厂参数施加的**词法环境**（voiceShared/config/voiceLog/httpProbe）；
//     ③ `const Date = ...` 在 eval 之前求值，用于遮蔽块内全部 `Date.now()`（虚拟时钟），
//        不影响测试自己的真实 Date。
function makeGate(opts) {
  const o = opts || {}
  const logs = []
  const calls = { httpProbe: 0 }
  const clock = { t: 0 }
  const factory = new Function('voiceShared', 'config', 'voiceLog', 'httpProbe', 'clock', 'body', `
    const Date = { now: () => clock.t }
    eval(body)
    return {
      readyNow: () => voiceBackendReadyNow(),
      wait: () => waitVoiceReady(),
    }
  `)
  const impl = factory(o.voiceShared, o.config, (m) => logs.push(m), async (url, ms) => {
    calls.httpProbe++
    return o.httpProbe(url, ms)
  }, clock, blockFast)
  return { impl, logs, calls, clock }
}

// 虚拟时钟：随真实时间推进（不推的话超时分支永远到不了）
function driveClock(gate) {
  const t = setInterval(() => { gate.clock.t += 120 }, 50)
  return () => clearInterval(t)
}

// 起一个真 HTTP 假桥（不 mock fetch —— 测的是真探针）
function listen(port, body) {
  return new Promise((resolve) => {
    const s = createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
    })
    s.listen(port, '127.0.0.1', () => resolve(s))
  })
}

// ---- 与 host.mjs 同形的 httpProbe（默认预算、返回 {up,status,body} 或 {up:false,err}）----
async function realHttpProbe(url, ms) {
  const ctl = new AbortController()
  const timer = setTimeout(() => { try { ctl.abort() } catch (e) { /* ignore */ } }, ms || 1200)
  try {
    const r = await fetch(url, { signal: ctl.signal, cache: 'no-store' })
    let body = ''
    try { body = await r.text() } catch (e) { body = '' }
    return { up: true, status: r.status, body }
  } catch (e) {
    return { up: false, err: e && e.message ? String(e.message) : String(e) }
  } finally { clearTimeout(timer) }
}

const DEAD_PORT = 49999   // 没有服务在听：连接必然被拒

console.log('== 1) 就绪判据：认插件状态机（快路径）==')
{
  const vs = { state: { phase: 'ready', detail: '', log: [] }, procs: {} }
  const g = makeGate({ voiceShared: vs, config: { provider: 'aqua', voiceBridgePort: DEAD_PORT }, httpProbe: realHttpProbe })
  const r = await g.impl.readyNow()
  ok('phase=ready → ready=true', r.ready === true, JSON.stringify(r))
  ok('phase=ready 时一次探针都不发（快路径零开销）', g.calls.httpProbe === 0, 'probes=' + g.calls.httpProbe)

  vs.state.phase = 'external'
  const r2 = await g.impl.readyNow()
  ok('phase=external → ready=true（外部链同样可用）', r2.ready === true, JSON.stringify(r2))
}

console.log('== 1b) 闸门只对 aqua 通道生效（否则非 aqua 用户会白等满上限）==')
{
  for (const p of ['edge', 'quest', 'voicevox', 'openai']) {
    const vs = { state: { phase: 'starting', detail: '', log: [] }, procs: {} }
    // 桥故意指到死端口：非 aqua 通道**根本不该去探**，更不该等
    const g = makeGate({ voiceShared: vs, config: { provider: p, aquaUrl: 'http://127.0.0.1:' + DEAD_PORT, voiceBridgePort: DEAD_PORT }, httpProbe: realHttpProbe })
    const t0 = Date.now()
    const w = await g.impl.wait()
    ok('provider=' + p + ' → 零等待放行（skipped=true）',
      w.ready === true && w.skipped === true && (Date.now() - t0) < 200 && g.calls.httpProbe === 0,
      JSON.stringify(w) + ' probes=' + g.calls.httpProbe)
  }
  // auto + 没配 aquaVoice/aquaRefAudio：aqua 只是候选之一，不该为它等
  const vs = { state: { phase: 'starting', detail: '', log: [] }, procs: {} }
  const g = makeGate({ voiceShared: vs, config: { provider: 'auto', aquaVoice: '', aquaRefAudio: '', aquaUrl: 'http://127.0.0.1:' + DEAD_PORT, voiceBridgePort: DEAD_PORT }, httpProbe: realHttpProbe })
  const w = await g.impl.wait()
  ok('provider=auto 且未配 aqua → 零等待放行', w.ready === true && w.skipped === true && g.calls.httpProbe === 0, JSON.stringify(w))
  // auto + 配了 aquaVoice：要走桥 ⇒ 必须真探（不可达 ⇒ 未就绪）
  const g2 = makeGate({ voiceShared: { state: { phase: 'starting', detail: '', log: [] }, procs: {} }, config: { provider: 'auto', aquaVoice: 'sakiko', aquaUrl: 'http://127.0.0.1:' + DEAD_PORT, voiceBridgePort: DEAD_PORT }, httpProbe: realHttpProbe })
  const r2 = await g2.impl.readyNow()
  ok('provider=auto 且配了 aquaVoice → 认真探桥并判未就绪', r2.ready === false && g2.calls.httpProbe === 1, JSON.stringify(r2))
}

console.log('== 2) 就绪判据：phase 未就绪时用桥 /health 交叉证实 ==')
{
  const srv = await listen(0, { ok: true, api: true, registered: { sakiko: 'ok' } })
  const port = srv.address().port
  const vs = { state: { phase: 'starting', detail: '触发: DSH 启动', log: [] }, procs: {} }
  const g = makeGate({ voiceShared: vs, config: { provider: 'aqua', voiceBridgePort: port, aquaUrl: 'http://127.0.0.1:' + port }, httpProbe: realHttpProbe })
  const r = await g.impl.readyNow()
  ok('phase=starting + /health{api:true,registered ok} → ready=true（外部服务也能被认出来）', r.ready === true, JSON.stringify(r))
  srv.close()
}
{
  // registered 为空对象：桥刚起来还没按需注册任何音色。**必须判为可用**（实测：空注册表照样能合成）
  const srv = await listen(0, { ok: true, api: true, registered: {} })
  const port = srv.address().port
  const vs = { state: { phase: 'starting', detail: '', log: [] }, procs: {} }
  const g = makeGate({ voiceShared: vs, config: { provider: 'aqua', voiceBridgePort: port, aquaUrl: 'http://127.0.0.1:' + port }, httpProbe: realHttpProbe })
  const r = await g.impl.readyNow()
  ok('registered={} → ready=true（按需注册，不能误判成未就绪）', r.ready === true, JSON.stringify(r))
  srv.close()
}
{
  const srv = await listen(0, { ok: true, api: false, registered: {} })
  const port = srv.address().port
  const vs = { state: { phase: 'starting', detail: '', log: [] }, procs: {} }
  const g = makeGate({ voiceShared: vs, config: { provider: 'aqua', voiceBridgePort: port, aquaUrl: 'http://127.0.0.1:' + port }, httpProbe: realHttpProbe })
  const r = await g.impl.readyNow()
  ok('phase=starting + /health{api:false} → ready=false（api 没起来就是没就绪）', r.ready === false, JSON.stringify(r))
  ok('未就绪原因里带上了 api 字段实况', String(r.why).indexOf('api=false') >= 0, String(r.why))
  srv.close()
}
{
  const srv = await listen(0, { ok: true, api: true, registered: { sakiko: 'failed' } })
  const port = srv.address().port
  const vs = { state: { phase: 'starting', detail: '', log: [] }, procs: {} }
  const g = makeGate({ voiceShared: vs, config: { provider: 'aqua', voiceBridgePort: port, aquaUrl: 'http://127.0.0.1:' + port }, httpProbe: realHttpProbe })
  const r = await g.impl.readyNow()
  ok('音色注册失败（registered.sakiko=failed）→ ready=false', r.ready === false, JSON.stringify(r))
  srv.close()
}

console.log('== 3) waitVoiceReady：已就绪 → 零等待 ==')
{
  const vs = { state: { phase: 'ready', detail: '', log: [] }, procs: {} }
  const g = makeGate({ voiceShared: vs, config: { provider: 'aqua', voiceBridgePort: DEAD_PORT }, httpProbe: realHttpProbe })
  const t0 = Date.now()
  const w = await g.impl.wait()
  const wall = Date.now() - t0
  ok('ready → ready=true', w.ready === true, JSON.stringify(w))
  ok('ready → 真实耗时 < 200ms（没有白等）', wall < 200, wall + 'ms')
  ok('ready → 不打「等待语音就绪」日志', g.logs.filter((l) => l.indexOf('等待语音就绪') >= 0).length === 0, JSON.stringify(g.logs))
}

console.log('== 4) waitVoiceReady：桥不可达时必须等（复刻启动窗口），超时后降级并写清原因 ==')
{
  const vs = { state: { phase: 'starting', detail: '触发: DSH 启动 / 插件加载', log: [] }, procs: {} }
  const g = makeGate({ voiceShared: vs, config: { provider: 'aqua', voiceBridgePort: DEAD_PORT, aquaUrl: 'http://127.0.0.1:' + DEAD_PORT }, httpProbe: realHttpProbe })
  const stop = driveClock(g)
  const w = await g.impl.wait()
  stop()
  ok('桥不可达 → ready=false（不假装成功）', w.ready === false, JSON.stringify(w))
  ok('桥不可达 → timeout=true', w.timeout === true, JSON.stringify(w))
  ok('桥不可达 → 真的轮询了（不是探一次就放弃）', g.calls.httpProbe >= 2, 'probes=' + g.calls.httpProbe)
  ok('降级原因写清「不可达」', String(w.why).indexOf('不可达') >= 0, String(w.why))
  ok('进了「等待语音就绪」日志（用户可据此排查）', g.logs.some((l) => l.indexOf('等待语音就绪') >= 0), JSON.stringify(g.logs))
}

console.log('== 5) waitVoiceReady：等到就绪立刻放行（不等满上限）==')
{
  const srv = await listen(0, { ok: true, api: true, registered: { sakiko: 'ok' } })
  const port = srv.address().port
  const vs = { state: { phase: 'starting', detail: '', log: [] }, procs: {} }
  let first = true
  const probe = async (url, ms) => {
    if (first) { first = false; return { up: false, err: 'connect ECONNREFUSED' } }   // 第一枪：桥还没起来
    return await realHttpProbe(url, ms)
  }
  const g = makeGate({ voiceShared: vs, config: { provider: 'aqua', voiceBridgePort: port, aquaUrl: 'http://127.0.0.1:' + port }, httpProbe: probe })
  const stop = driveClock(g)
  const w = await g.impl.wait()
  stop()
  ok('先不可达、后可达 → ready=true', w.ready === true, JSON.stringify(w))
  ok('就绪后 timeout=false', w.timeout === false, JSON.stringify(w))
  ok('就绪后打了「语音已就绪」日志', g.logs.some((l) => l.indexOf('语音已就绪') >= 0), JSON.stringify(g.logs))
  srv.close()
}

console.log('== 6) waitVoiceReady：状态机判 failed 时不再空等满上限 ==')
{
  const vs = { state: { phase: 'failed', detail: 'api 180s 内未就绪', log: [] }, procs: {} }
  const g = makeGate({ voiceShared: vs, config: { provider: 'aqua', voiceBridgePort: DEAD_PORT, aquaUrl: 'http://127.0.0.1:' + DEAD_PORT }, httpProbe: realHttpProbe })
  const t0 = Date.now()
  const w = await g.impl.wait()
  const wall = Date.now() - t0
  ok('phase=failed → ready=false 且不空等', w.ready === false && wall < 400, wall + 'ms ' + JSON.stringify(w))
  ok('原因里带上状态机的 detail', String(w.why).indexOf('api 180s 内未就绪') >= 0, String(w.why))
}

console.log('== 7) 结算后不再轮询（防"就绪了还在探"）==')
{
  const vs = { state: { phase: 'starting', detail: '', log: [] }, procs: {} }
  const g = makeGate({ voiceShared: vs, config: { provider: 'aqua', voiceBridgePort: DEAD_PORT, aquaUrl: 'http://127.0.0.1:' + DEAD_PORT }, httpProbe: realHttpProbe })
  const stop = driveClock(g)
  const w = await g.impl.wait()
  stop()
  await new Promise((r) => setTimeout(r, 250))
  const probesAtEnd = g.calls.httpProbe
  await new Promise((r) => setTimeout(r, 400))
  ok('超时结算后探针计数不再增长（轮询确实停了）', g.calls.httpProbe === probesAtEnd, probesAtEnd + ' → ' + g.calls.httpProbe)
  ok('结算结果是降级态', w.ready === false, JSON.stringify(w))
}

console.log('== 8) 在途去重：并发等只跑一条轮询链 ==')
{
  const vs = { state: { phase: 'starting', detail: '', log: [] }, procs: {} }
  const g = makeGate({ voiceShared: vs, config: { provider: 'aqua', voiceBridgePort: DEAD_PORT, aquaUrl: 'http://127.0.0.1:' + DEAD_PORT }, httpProbe: realHttpProbe })
  const stop = driveClock(g)
  const [a, b] = await Promise.all([g.impl.wait(), g.impl.wait()])
  stop()
  ok('两次并发调用返回同一个结果对象（共用一条链）', a === b, a === b ? 'same' : 'different')
  ok('并发下探针数仍在轮询量级（没翻倍）', g.calls.httpProbe <= 8, 'probes=' + g.calls.httpProbe)
}

console.log('')
console.log((fail === 0 ? '[OK] ' : '[FAILED] ') + pass + ' 通过 / ' + fail + ' 失败')
process.exit(fail === 0 ? 0 : 1)
