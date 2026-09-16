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
// 关于虚拟时钟（独立复审 C-5 的修法：**让虚拟时钟由循环自己的睡眠驱动**）：
//   waitVoiceReady 内部用 `Date.now()` 算超时、用真 `setTimeout` 睡眠。测试把提取块里的
//   `Date` **和 `setTimeout`** 一起换成替身：`Date.now()` 读累加器 clock.t，而
//   `setTimeout(fn, ms)` 做 `clock.t += ms`、再把回调交回真事件循环（realSetTimeout(fn, 0)）。
//   ⇒ **虚拟时间 = 睡眠之和**，退出点只由源码里的步长 `Math.min(VOICE_WAIT_INTERVAL_MS, remaining)`
//   决定，与真实定时器抖动、机器负载无关。原先的写法是拿一个 50ms 的真 setInterval 推进虚拟时钟，
//   而循环自己用 ~120ms 的真睡眠 —— 两者速度解耦，一次迭代之间虚拟时钟可能跳过 2~3 步，
//   于是「上限 + 一个周期」的余量时够时不够（实测同一条命令 6/10 报红）。
//   现在 `waitedMs` 恰好等于上限，所以 §9 直接断言「不超上限」这条**生产属性本身**。
//   ⚠️ 替身只作用于**提取块内部**：模块作用域的 realHttpProbe（:117）仍用真定时器，探针的超时
//   预算照常真实计时，而且探针耗时**不**推进虚拟时钟。若这个前提不成立（探针的定时器也被遮蔽），
//   clock.t 会被探针预算撞飞，C-5 会立刻报红 —— §9 因此同时是这条前提的守卫。
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
// 测试用的加速版：等待上限 / fallback 上限 / 轮询间隔，单位都是**虚拟毫秒**。
// 三个数**具名**，§9 的断言直接引用它们 —— 免得"改个比例"之后断言里的字面量变成对不上的常量
// （反向对照正是这么做的）。取值满足 上限 ≈ 6 个周期、fallback ≈ 2.5 个周期。
const FAST_MAX_MS = 700
const FAST_FALLBACK_MAX_MS = 300
const FAST_INTERVAL_MS = 120
const blockFast = block
  .replace(/const VOICE_WAIT_MAX_MS = \d+/, 'const VOICE_WAIT_MAX_MS = ' + FAST_MAX_MS)
  .replace(/const VOICE_WAIT_INTERVAL_MS = \d+/, 'const VOICE_WAIT_INTERVAL_MS = ' + FAST_INTERVAL_MS)
  // C-2 的 fallback 上限也要加速：否则 voiceStability:false 的用例要在虚拟时间里跑满 90s
  // （≈37s 真实时间）。对现有用例无影响 —— 它们都没设 voiceStability，走的是上面那条上限。
  .replace(/const VOICE_WAIT_FALLBACK_MAX_MS = \d+/, 'const VOICE_WAIT_FALLBACK_MAX_MS = ' + FAST_FALLBACK_MAX_MS)

// 按抽取到的源码构造一个可调用环境（依赖全用 mock 包起来）。
//   eval 的位置是关键，两处都踩过坑：
//     ① 不能用内层箭头函数把 eval 包起来 —— 那样 eval 体里声明的
//        `async function voiceBackendReadyNow` 会**绑定在内层函数作用域**，
//        内层返回后它就丢了（实测报 `voiceShared is not defined`，因为它退化成全局查找）；
//     ② 必须用**直接 eval**（`eval(code)` 而不是 `(0, eval)(code)`），这样提取块里的
//        函数声明才能看见工厂参数施加的**词法环境**（voiceShared/config/voiceLog/httpProbe）；
//     ③ `const Date` / `const setTimeout` 在 eval 之前求值，用于遮蔽块内全部 `Date.now()`
//        与定时器（虚拟时钟），不影响测试自己的真 Date / 真定时器。
//   定时器替身的语义（C-5 的修法）：**先把虚拟时钟推进 ms，再把回调交回真事件循环** ——
//   既不引入真实等待（realSetTimeout(fn, 0) 只是让 promise 有机会 resolve），
//   又让虚拟时间恰好等于睡眠之和。sleeps 记账交给 §9：那条断言要求
//   「虚拟时间 === 睡眠之和」，也就是"没有任何外部时间源掺进虚拟时钟"这个确定性前提。
function makeGate(opts) {
  const o = opts || {}
  const logs = []
  const calls = { httpProbe: 0 }
  const clock = { t: 0 }
  const sleeps = []
  const realSetTimeout = setTimeout   // 捕获真定时器（模块作用域）：替身借它把回调交回真事件循环
  const factory = new Function('voiceShared', 'config', 'voiceLog', 'httpProbe', 'clock', 'realSetTimeout', 'sleeps', 'body', `
    const Date = { now: () => clock.t }
    const setTimeout = (fn, ms) => {
      const d = Number(ms) || 0
      sleeps.push(d)
      clock.t += d
      return realSetTimeout(fn, 0)
    }
    eval(body)
    return {
      readyNow: () => voiceBackendReadyNow(),
      wait: () => waitVoiceReady(),
    }
  `)
  const impl = factory(o.voiceShared, o.config, (m) => logs.push(m), async (url, ms) => {
    calls.httpProbe++
    return o.httpProbe(url, ms)
  }, clock, realSetTimeout, sleeps, blockFast)
  return { impl, logs, calls, clock, sleeps }
}

// 起一个真 HTTP 假桥（不 mock fetch —— 测的是真探针）。
// ⚠️ 必须带「可达性自检 + 换端口重试」（2026-09-15 实测的偶发红，与闸门逻辑无关）：
//   合跑实测约 2~3% 的运行里，`listen(0)` 分配到的那个端口**bind 成功、探针却连不通**
//   （undici 只报笼统的 `fetch failed`）。落地症状是 §2 / §5 以"桥不可达"的样子偶发红：
//     [FAIL] registered={} → ready=true  ← {"ready":false,"why":"桥 http://127.0.0.1:6679/health 不可达（fetch failed）"}
//     [FAIL] 先不可达、后可达 → ready=true ← {"ready":false,"waitedMs":700,…"（等待超过上限，按未就绪降级）"}
//   取证：一次运行里**只有那一个端口**不通、同一次运行其它端口（含 §4/§6/§9 的 DEAD_PORT）行为全部正常
//   ⇒ 是逐端口的环境故障，不是连接池被污染（单独顺序 bind+探 400 个端口，0 失败）。
//   那是 harness 的前提「假桥可达」没成立，而**不是**闸门判错了 ⇒ 起桥时必须自检：
//   探不通就换一个端口重起（`listen(0)` 会顺序给下一个端口）；试满 10 个还不行就 FATAL 报清楚 ——
//   宁可炸，不可让"假桥其实连不通"这件事悄悄变成断言里的红灯。
async function listen(port, body) {
  for (let attempt = 1; attempt <= 10; attempt++) {
    const s = await new Promise((resolve, reject) => {
      const srv = createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(body))
      })
      srv.once('error', reject)      // 端口真的被占（EADDRINUSE）也算自检失败，换端口
      srv.listen(port, '127.0.0.1', () => resolve(srv))
    })
    const p = s.address().port
    const alive = await realHttpProbe('http://127.0.0.1:' + p + '/health', 1200)
    if (alive.up === true) return s
    console.error('[WARN] 假桥自检不通（第 ' + attempt + ' 次，port=' + p + '：' + String(alive.err) + '）—— 换端口重起')
    await new Promise((r) => s.close(r))
  }
  console.error('[FATAL] 起不出可达的假桥（连试 10 个端口都不通）—— 本机的 localhost 端口分配有问题，先排查环境再跑本测试')
  process.exit(2)
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
    // undici 对连接层故障只报笼统的 `fetch failed`——把底层 cause 一并留下，否则事后无法定位
    // （2026-09-15 的偶发红就是被这层笼统错误盖住的：到底是 ECONNREFUSED 还是 ECONNRESET 看不出来）
    const cause = e && e.cause ? (e.cause.code || e.cause.message || String(e.cause)) : ''
    return { up: false, err: (e && e.message ? String(e.message) : String(e)) + (cause ? ' / ' + cause : '') }
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
  const w = await g.impl.wait()
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
  const w = await g.impl.wait()
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
  const w = await g.impl.wait()
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
  const [a, b] = await Promise.all([g.impl.wait(), g.impl.wait()])
  ok('两次并发调用返回同一个结果对象（共用一条链）', a === b, a === b ? 'same' : 'different')
  ok('并发下探针数仍在轮询量级（没翻倍）', g.calls.httpProbe <= 8, 'probes=' + g.calls.httpProbe)
}

console.log('== 9) C-2 / C-5：上限取值与「不超上限」（独立复审 I-1：这两条原先零覆盖）==')
{
  // --- 静态锚点：把实现改回去就会红 ---
  const mMax = /const VOICE_WAIT_MAX_MS = (\d+)/.exec(block)
  const mFb = /const VOICE_WAIT_FALLBACK_MAX_MS = (\d+)/.exec(block)
  ok('host.mjs 有 VOICE_WAIT_FALLBACK_MAX_MS', mFb !== null, mFb === null ? 'missing' : mFb[1])
  // Minor-R2-4（独立复审）：原先只判 `>= 60000` ⇒ 把常量改回 60000 仍然全绿（锁不住本分支把它
  // 提到 90s 的取值）。改成按**源码注释里写明的取值依据**锁：≥ 90s（最坏冷启动样本 60s + 4s
  // 轮询粒度之上留边距，注释里"独立复审建议 90s，采纳"就是这条）。改回 60000 必须报红。
  ok('fallback 上限 ≥ 90s（Minor-R2-4：改回 60000 必须报红；注释里的取值依据就是 90s）',
    mFb !== null && Number(mFb[1]) >= 90000, mFb === null ? 'missing' : mFb[1])
  ok('fallback 上限 < 默认上限（否则 C-2 没有意义）',
    mFb !== null && mMax !== null && Number(mFb[1]) < Number(mMax[1]),
    (mFb ? mFb[1] : '?') + ' vs ' + (mMax ? mMax[1] : '?'))
  ok('C-2：上限按 voiceStability 二选一（删掉这个三元分支即失败）',
    /const maxMs = config\.voiceStability === false \? VOICE_WAIT_FALLBACK_MAX_MS : VOICE_WAIT_MAX_MS/.test(block))
  ok('C-5：睡眠被剩余预算夹住（Math.min(INTERVAL, remaining)）',
    /Math\.min\(VOICE_WAIT_INTERVAL_MS, remaining\)/.test(block))
  ok('C-5：超时判据基于 remaining（不再是"先判超时再睡满一个周期"）',
    /const remaining = maxMs - \(Date\.now\(\) - t0\)/.test(block) && /if \(remaining <= 0\)/.test(block))

  // --- 行为：voiceStability=false 应当更早结算（fallback 上限 vs 默认上限，单位都是虚拟毫秒）---
  // 这两组用的**必须是** makeGate 里那个"由睡眠驱动"的确定性时钟：虚拟时间 = 睡眠之和，
  // 退出点只由 `Math.min(INTERVAL, remaining)` 决定 ⇒ waitedMs 恰好等于上限，
  // 「有没有超出上限」才成为可判别的生产属性（原先用真 setInterval 推时钟，测的是时钟比）。
  async function settle(stability) {
    const vs = { state: { phase: 'starting', detail: '', log: [] }, procs: {} }
    const cfg = { provider: 'aqua', voiceBridgePort: DEAD_PORT, aquaUrl: 'http://127.0.0.1:' + DEAD_PORT }
    if (stability !== undefined) cfg.voiceStability = stability
    const g = makeGate({ voiceShared: vs, config: cfg, httpProbe: realHttpProbe })
    const w = await g.impl.wait()
    return { w, sleeps: g.sleeps }
  }
  const rFb = await settle(false)
  const rDef = await settle(undefined)
  const wFb = rFb.w
  const wDef = rDef.w
  ok('voiceStability=false 确实更早结算（走了 fallback 上限）',
    wFb.timeout === true && wDef.timeout === true && wFb.waitedMs < wDef.waitedMs,
    'fallback=' + wFb.waitedMs + 'ms  default=' + wDef.waitedMs + 'ms')
  // C-5 本体：睡眠被 remaining 夹住 ⇒ 两种情形都**不超各自上限**（虚拟时间 = 睡眠之和）。
  // 正对照（把生产里那行改成睡满 VOICE_WAIT_INTERVAL_MS）实测报红：默认 720>700、fallback 360>300。
  ok('C-5：两种情形都没有超出各自上限（睡眠被 remaining 夹住 ⇒ 虚拟耗时恰好 = 上限）',
    wFb.waitedMs <= FAST_FALLBACK_MAX_MS && wDef.waitedMs <= FAST_MAX_MS,
    'fallback=' + wFb.waitedMs + 'ms<=' + FAST_FALLBACK_MAX_MS +
    '  default=' + wDef.waitedMs + 'ms<=' + FAST_MAX_MS)
  // 前提自检（上面那条判据的立足点）：虚拟时间必须**恰好**等于块内睡眠之和 —— 即时钟完全由循环
  // 自己的睡眠驱动、探针耗时/外部定时器一律没有掺进虚拟时间（探针用的是模块作用域的真定时器）。
  // 若有人把真定时器时钟（旧的 driveClock）加回来、或让探针也被遮蔽，这条会先报红，
  // 从而避免"又变回测时钟比却仍显示绿灯"。
  const sum = (a) => a.reduce((x, y) => x + y, 0)
  ok('C-5：虚拟时间恰好 = 块内睡眠之和（确定性前提：探针耗时与外部定时器都没掺进虚拟时钟）',
    sum(rFb.sleeps) === wFb.waitedMs && sum(rDef.sleeps) === wDef.waitedMs,
    'fb sleeps=' + JSON.stringify(rFb.sleeps) + ' → ' + wFb.waitedMs + 'ms；def sleeps=' +
    JSON.stringify(rDef.sleeps) + ' → ' + wDef.waitedMs + 'ms')
}

console.log('')
console.log((fail === 0 ? '[OK] ' : '[FAILED] ') + pass + ' 通过 / ' + fail + ' 失败')
process.exit(fail === 0 ? 0 : 1)
