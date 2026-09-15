#!/usr/bin/env node
// ============================================================
// SAKIKO for DSH — 看门狗（watchdog）快回路测试
// ============================================================
// 用法（默认测**本仓库**的插件；跑 main 分支对照时用 --plugin 指到那份干净副本）：
//   node tools/test-watchdog.mjs [--plugin <插件目录>] [--case all|<用例名>]
//                                [--api-port 21880] [--bridge-port 21000] [--keep] [--out <结果目录>]
//   用例名：positive | detached-launcher | fallback-port | token-mismatch | external | graceful
//          | log-append | gate-reuse-legacy-nodesc | gate-reuse-legacy-desc | gate-reuse-control
//          | degraded-not-listening | degraded-listening | createdms-mismatch | createdms-match
//          | createdms-token | stop-port-recheck | watchdog-cwd
//
// 设计要点（**这不是"跑完没报错就算过"**）：
//   * 被测的不是本脚本自己模仿的逻辑，而是**插件真实的 host.mjs**：本脚本生成一个
//     "假 DSH 进程"，用最小 fake ctx（fs/webServer/subprocess/effect/timer）import 真插件并 apply()，
//     于是 armWatchdog / 令牌文件 / stopVoiceServices / stopWatchdog 全部是真代码在跑。
//   * 每个 dummy 服务都模拟"启动器 + 监听端口的 worker 子进程"两代进程（GPT-SoVITS 实测就是这个形状：
//     9880 的 listener 是 api 启动器的子进程），所以"只杀启动器、worker 变孤儿"会被抓出来。
//   * 每个 case 都先断言"前置事实"（例：看门狗确实活着），避免**空过**（vacuous pass）——
//     在未修版本上这些前置断言会先失败，随后我们照样把"孤儿残留"的原始证据打出来。
//   * 只用临时端口与自己刚起的 dummy 进程；杀之前一律按 pid + 启动时间核对是自己起的。
//
// R-A~R-D（2026-09-13 独立审查的 3 项误杀阻塞项 + 1 项条件项）逐条对应：
//   gate-reuse-*      ①  端口兜底不得绕过 PID 复用闸门（审查 S6b：allowlist 里混进了未校验的登记 pid）
//   degraded-*        ②  进程查询不可用（降级）时不许"盲杀"，只杀端口可证实的
//   createdms-*       ③  PID 复用闸门从"时间启发式"换成"创建时间身份校验"
//   stop-port-recheck ④  优雅停止后有界复核端口；端口仍被占就不许把看门狗收摊
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const WIN = process.platform === 'win32'

// ---------------- 参数 ----------------
const argv = process.argv.slice(2)
function argOf(name, dflt) {
  const i = argv.indexOf('--' + name)
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : dflt
}
const PLUGIN = path.resolve(argOf('plugin', REPO))
const CASE = argOf('case', 'all')
const KEEP = argv.includes('--keep')
// 默认端口避开 19880/18000（验收台在用那一对），也避开真实服务端口 9880/8100
const API_PORT_WANT = Number(argOf('api-port', '21880'))
const BRIDGE_PORT_WANT = Number(argOf('bridge-port', '21000'))
const OUT_ROOT = path.resolve(argOf('out', path.join(os.tmpdir(), 'sakiko-wd-watchdog-test')))

const results = []
function rec(caseName, name, ok, detail) {
  results.push({ case: caseName, name, ok: !!ok, detail: String(detail === undefined ? '' : detail) })
  console.log((ok ? '  [PASS] ' : '  [FAIL] ') + name + (detail ? '  —— ' + detail : ''))
}

// ---------------- 通用小工具 ----------------
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

function portOpen(port, timeoutMs) {
  return new Promise((resolve) => {
    let done = false
    const sock = net.connect({ host: '127.0.0.1', port })
    const fin = (v) => { if (done) return; done = true; try { sock.destroy() } catch (e) { /* ignore */ } ; resolve(v) }
    sock.setTimeout(timeoutMs || 700)
    sock.once('connect', () => fin(true))
    sock.once('timeout', () => fin(false))
    sock.once('error', () => fin(false))
  })
}

function freePort(preferred) {
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.once('error', () => {
      const s2 = net.createServer()
      s2.listen(0, '127.0.0.1', () => { const p = s2.address().port; s2.close(() => resolve(p)) })
    })
    srv.listen(preferred, '127.0.0.1', () => { srv.close(() => resolve(preferred)) })
  })
}

function pidAlive(pid) {
  if (!pid) return false
  try { process.kill(pid, 0); return true } catch (e) { return e && e.code === 'EPERM' }
}

// 本次测试自己起的进程登记表：收尾必须是空的（资源纪律 #1）
const FIXTURE = new Set()
function track() {
  for (const x of arguments) if (Number(x) > 0) FIXTURE.add(Number(x))
}

// 本测试起过的进程"身份判据"：命令行里必须出现本测试的目录（所有 case 都在 OUT_ROOT 下）
// 或插件里的 watchdog.mjs。为什么必须判身份：**Windows 会复用 pid**，只按 pidAlive 判"残留"，
// 会把一个恰好复用到同号的外来进程误报成本测试的残留（2026-09-13 实测：pid 10636 在 detached-launcher
// 用例里已确认"全灭"，90s 后被系统复用 ⇒ 收尾又把它列成残留）。
function isOursByCmd(cmd) {
  const s = String(cmd || '')
  const low = s.toLowerCase()
  return s.includes(OUT_ROOT) || low.includes('watchdog.mjs') || low.includes('fake-dsh.mjs')
}

function liveFixturePids() {
  const alive = [...FIXTURE].filter((p) => pidAlive(p))
  if (alive.length === 0) return []
  const info = psInfo(alive)            // 一次定向查询（不拉全表）
  const ours = []
  const foreign = []
  for (const p of alive) {
    const i = info.get(p)
    if (!i || !i.cmd) { foreign.push(p + '(查不到命令行，可能刚退出)'); continue }
    if (isOursByCmd(i.cmd)) ours.push(p)
    else foreign.push(p + '(cmd=' + String(i.cmd).replace(/\s+/g, ' ').slice(0, 70) + ')')
  }
  if (foreign.length > 0) {
    console.log('  [identity] 登记过的 pid 里有 ' + foreign.length + ' 个已被系统复用/不是本测试的进程，'
      + '不计入残留：' + foreign.join(' | '))
  }
  return ours.sort((a, b) => a - b)
}

// taskkill（带 /T）：**必须看退出码与输出**；失败且目标仍存活 ⇒ 记下、不靠反复重试掩盖（资源纪律 #5）
function killTreeStrict(pid, why) {
  if (!Number(pid) || pid <= 0) return { ok: false, how: 'pid 非法' }
  if (!pidAlive(pid)) return { ok: true, how: '已不存在（无需杀）' }
  if (!WIN) {
    try { process.kill(-pid, 'SIGKILL') } catch (e) { try { process.kill(pid, 'SIGKILL') } catch (e2) { return { ok: false, how: 'kill 失败：' + (e2 && e2.message) } } }
    return { ok: true, how: 'kill(SIGKILL)' }
  }
  const r = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8', timeout: 10000, windowsHide: true })
  const out = String((r && (r.stdout || r.stderr)) || '').trim().replace(/\s+/g, ' ').slice(0, 140)
  const status = r ? r.status : '?'
  const still = pidAlive(pid)
  console.log('  [taskkill] pid=' + pid + '（' + (why || '') + '，带 /T）exit=' + status
    + ' 输出=' + JSON.stringify(out) + '（控制台为 GBK，输出可能是乱码；判据看 exit 与存活状态）'
    + ' → 目标' + (still ? '★仍存活：校验/权限问题，记下不再重试' : '已消失'))
  return { ok: !still, how: 'taskkill(/T) exit=' + status + (still ? '（目标仍存活）' : ''), strictFail: still }
}

// **只杀这个 pid，不带 /T** —— 复刻"DSH 被强杀时只带走直接子进程（启动器）"这个真实形状
function killPidOnly(pid, why) {
  if (!Number(pid) || pid <= 0) return { ok: false, how: 'pid 非法' }
  if (!pidAlive(pid)) return { ok: true, how: '已不存在（无需杀）' }
  if (!WIN) {
    try { process.kill(pid, 'SIGKILL'); return { ok: true, how: 'kill(SIGKILL)' } } catch (e) { return { ok: false, how: String(e && e.message) } }
  }
  const r = spawnSync('taskkill', ['/PID', String(pid), '/F'], { encoding: 'utf8', timeout: 10000, windowsHide: true })
  const out = String((r && (r.stdout || r.stderr)) || '').trim().replace(/\s+/g, ' ').slice(0, 140)
  const status = r ? r.status : '?'
  const still = pidAlive(pid)
  console.log('  [taskkill] pid=' + pid + '（' + (why || '') + '，**不带 /T**）exit=' + status
    + ' 输出=' + JSON.stringify(out) + '（控制台为 GBK，输出可能是乱码；判据看 exit 与存活状态）'
    + ' → 目标' + (still ? '★仍存活：校验/权限问题，记下不再重试' : '已消失'))
  return { ok: !still, how: 'taskkill(无/T) exit=' + status + (still ? '（目标仍存活）' : ''), strictFail: still }
}

// ---------------- 进程查询：**定向过滤**（绝不拉全表；资源纪律 #4） ----------------
// 一次 PowerShell 调用拿到：指定 pid 自身的信息（tag=S）+ 按其 ParentProcessId 递归的后代（tag=D）
function psProcTree(roots, maxDepth) {
  if (!WIN || (roots || []).length === 0) return new Map()
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    '$roots = @(' + roots.map(Number).join(',') + ')',
    'function Emit($tag, $procs) {',
    '  foreach ($p in $procs) {',
    "    $ct = ''",
    '    try { $ct = [string]$p.CreationDate.ToFileTimeUtc() } catch { }',
    '    $cl = [string]$p.CommandLine',
    "    $cl = $cl -replace \"`r\", ' '",
    "    $cl = $cl -replace \"`n\", ' '",
    "    '{0}|{1}|{2}|{3}|{4}' -f $tag, [int]$p.ProcessId, [int]$p.ParentProcessId, $ct, $cl",
    '  }',
    '}',
    "Emit 'S' (Get-CimInstance Win32_Process -Filter (($roots | ForEach-Object { 'ProcessId=' + $_ }) -join ' or ') | Select-Object ProcessId,ParentProcessId,CreationDate,CommandLine)",
    '$seen = @{}',
    'foreach ($r in $roots) { $seen[[int]$r] = 1 }',
    '$frontier = @($roots)',
    'for ($d = 0; $d -lt ' + Number(maxDepth) + ' -and $frontier.Count -gt 0; $d++) {',
    "  $f2 = ($frontier | ForEach-Object { 'ParentProcessId=' + $_ }) -join ' or '",
    '  $kids = @(Get-CimInstance Win32_Process -Filter $f2 | Select-Object ProcessId,ParentProcessId,CreationDate,CommandLine)',
    "  Emit 'D' $kids",
    '  $next = @()',
    '  foreach ($k in $kids) { $p = [int]$k.ProcessId; if (-not $seen.ContainsKey($p)) { $seen[$p] = 1; $next += $p } }',
    '  $frontier = $next',
    '}',
  ].join('\n')
  const b64 = Buffer.from(script, 'utf16le').toString('base64')
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', b64],
    { encoding: 'utf8', timeout: 10000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 })
  const map = new Map()
  if (!r || r.error || r.status !== 0) return map     // 空结果集合法（进程都不在了）＝空 Map，不是失败
  const out = typeof r.stdout === 'string' ? r.stdout : ''
  for (const line of out.split(/\r?\n/)) {
    const p = line.split('|')
    if (p.length < 5) continue
    const pid = Number(p[1])
    if (!Number.isFinite(pid) || pid <= 0) continue
    const ft = Number(p[3])
    map.set(pid, {
      tag: p[0],
      ppid: Number(p[2]) || 0,
      createdMs: Number.isFinite(ft) && ft > 0 ? (ft / 10000 - 11644473600000) : 0,
      cmd: p.slice(4).join('|'),
    })
  }
  return map
}

function psInfo(pids) { return psProcTree(pids, 0) }

function psDescendants(roots, maxDepth) {
  const t = psProcTree(roots, maxDepth)
  const out = []
  for (const [pid, info] of t) if (info.tag === 'D') out.push(pid)
  return out.sort((a, b) => a - b)
}

function pidDesc(pid) {
  const i = psInfo([pid]).get(pid)
  if (!i) return 'pid=' + pid + '(不存在)'
  return 'pid=' + pid + '(ppid=' + i.ppid + ', created=' + new Date(i.createdMs).toISOString() + ', cmd=' + String(i.cmd).slice(0, 110) + ')'
}

async function waitFor(fn, timeoutMs, stepMs) {
  const end = Date.now() + timeoutMs
  for (;;) {
    let v = false
    try { v = await fn() } catch (e) { v = false }
    if (v) return { ok: true, ms: timeoutMs - (end - Date.now()) }
    if (Date.now() >= end) return { ok: false, ms: timeoutMs }
    await sleep(Math.max(300, stepMs || 400))     // 资源纪律 #2：轮询 ≥300ms，且必有硬超时
  }
}

function readJson(p) {
  try { return JSON.parse(readFileSync(p, 'utf8')) } catch (e) { return null }
}

// 安全的时间格式化：令牌里可能根本没有 createdMs（未修版本/旧世代）⇒ 不能直接 new Date(undefined)
function msStr(ms) {
  const n = Number(ms)
  return (Number.isFinite(n) && n > 0) ? new Date(n).toISOString() : 'n/a'
}

function logText(p) {
  try { return readFileSync(p, 'utf8') } catch (e) { return '' }
}

// 轮转出来的历史档（新命名 `.1-<ts>`；旧实现的 `.1` 也一并收进来，好让"未修版本"的对照能打印证据）
function rotatedLogs(c) {
  try {
    return readdirSync(path.dirname(c.voiceLog))
      .filter((n) => n.startsWith(path.basename(c.voiceLog) + '.1'))
      .sort()
      .map((n) => ({ name: n, text: logText(path.join(path.dirname(c.voiceLog), n)) }))
  } catch (e) { return [] }
}

// 直接按**插件写令牌文件的格式**喂看门狗（R-A/R-B/R-C 用：这些用例要精确控制 token/mtime/createdMs，
// 走插件就会把这三个量都盖掉）。mtimeMs 用 utimesSync 显式设定 —— "登记 pid 的现进程比令牌还新 N 秒"
// 这个前提只能这么造。
function writeRawToken(c, obj, opts) {
  mkdirSync(path.dirname(c.tokenFile), { recursive: true })
  writeFileSync(c.tokenFile, JSON.stringify(obj, null, 2) + '\n', 'utf8')
  if (opts && Number.isFinite(opts.mtimeMs)) {
    const sec = opts.mtimeMs / 1000
    utimesSync(c.tokenFile, sec, sec)
  }
  return readJson(c.tokenFile)
}

// 直接起看门狗（不经过插件）：--dsh-pid 用**本测试进程**（一直活着，所以不会走 pid 轮询那条路），
// 触发一律靠 stdin EOF。extraArgs 用来注入 --no-descendants / --ps-exe 这些开关。
function startWatchdogDirect(c, token, extraArgs) {
  const wd = spawn(process.execPath, [
    path.join(PLUGIN, 'watchdog.mjs'),
    '--token', token, '--epoch', '1', '--dsh-pid', String(process.pid),
    '--token-file', c.tokenFile, '--log', c.voiceLog, '--poll-ms', '60000',
  ].concat(extraArgs || []), { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true, detached: true, cwd: c.dir })
  try { if (wd.stdin) wd.stdin.on('error', () => { /* EPIPE 无所谓 */ }) } catch (e) { /* ignore */ }
  track(wd.pid)
  return wd
}

// 起一个"单个进程"的 dummy（squat=监听端口 / sleeper=不监听），返回 { pid, createdMs }
async function startSingleDummy(c, role, port, tag) {
  const rec = path.join(c.dir, 'single-' + tag + '-' + port + '.json')
  const ch = spawn(process.execPath, [c.dummyScript, role, String(port), rec], { stdio: 'ignore', windowsHide: true, detached: true })
  const wantListen = role === 'squat'
  const ok = await waitFor(async () => existsSync(rec) && (!wantListen || (await portOpen(port, 400))), 15000, 300)
  const j = readJson(rec)
  const pid = j && Number(j.pid) > 0 ? Number(j.pid) : ch.pid
  track(pid)
  const info = psInfo([pid]).get(pid)
  return { pid, rec, ok: ok.ok, createdMs: info ? Number(info.createdMs) || 0 : 0, role }
}

// ---------------- 生成"假 DSH 进程"与 dummy 服务（都写进临时目录，仓库里不留机器相关路径） ----------------
const DUMMY_SRC = String.raw`
// dummy 服务：复刻验收台在**真实 DSH** 上实测到的进程形状（F1-a）：
//   假DSH(被杀) → launcher(随父同刻死) → worker(监听端口, 活) → grandchild(常驻, 活)
// 关键：launcher 由 driver **不 detached** 拉起（libuv 的 job 会把它随 node 一起收走）；
// worker / grandchild 由上一代 **detached** 拉起，等价于真实环境里的 breakaway 逃逸。
import { spawn } from 'node:child_process'
import { openSync, writeFileSync } from 'node:fs'
import net from 'node:net'

const role = process.argv[2]
const port = Number(process.argv[3])
const out = process.argv[4]

if (role === 'grandchild') {
  // 常驻孙进程：不监听端口（真实 GPT-SoVITS 树里同样有这类进程，只按端口找会漏掉它）
  setInterval(() => { }, 1000)
} else if (role === 'squat') {
  // R-A/R-B/R-C 用：**登记 pid 自己就是监听者**（模拟"pid 被复用后，占用者正好在监听登记端口"）
  const srv = net.createServer((s) => { s.on('error', () => { }); s.end('dummy') })
  srv.on('error', (e) => { process.stderr.write('squat server error: ' + e.message + '\n') })
  srv.listen(port, '127.0.0.1', () => { process.stdout.write('SQUAT-LISTEN ' + port + ' pid=' + process.pid + '\n') })
  writeFileSync(out, JSON.stringify({ role: 'squat', pid: process.pid, port, at: new Date().toISOString() }, null, 2))
  setInterval(() => { }, 1000)
} else if (role === 'sleeper') {
  // 对照组用：**不监听任何端口**的常驻进程（同构造、只差"没占端口"这一项）
  writeFileSync(out, JSON.stringify({ role: 'sleeper', pid: process.pid, port: 0, at: new Date().toISOString() }, null, 2))
  setInterval(() => { }, 1000)
} else if (role === 'worker') {
  process.on('uncaughtException', (e) => { process.stderr.write('worker uncaught: ' + (e && e.stack ? e.stack : String(e)) + '\n') })
  const g = spawn(process.execPath, [process.argv[1], 'grandchild', String(port), out], { stdio: 'ignore', windowsHide: true, detached: true })
  g.unref()
  writeFileSync(out + '.gchild.json', JSON.stringify({ workerPid: process.pid, grandchildPid: g.pid, port, at: new Date().toISOString() }, null, 2))
  const srv = net.createServer((s) => { s.on('error', () => { }); s.end('dummy') })
  srv.on('error', (e) => { process.stderr.write('worker server error: ' + e.message + '\n') })
  srv.listen(port, '127.0.0.1', () => { process.stdout.write('DUMMY-LISTEN ' + port + ' pid=' + process.pid + '\n') })
  process.on('exit', (c) => { process.stderr.write('worker exit code=' + c + ' at=' + new Date().toISOString() + '\n') })
  setInterval(() => { }, 1000)
} else {
  // launcher：对外表现为"抢到端口的服务"，实际监听的是它的 worker（与 GPT-SoVITS 同形）
  const errFd = openSync(out + '.worker.err.log', 'a')
  const w = spawn(process.execPath, [process.argv[1], 'worker', String(port), out], { stdio: ['ignore', 'ignore', errFd], windowsHide: true, detached: true })
  w.unref()
  writeFileSync(out, JSON.stringify({ role: 'launcher', port, launcherPid: process.pid, workerPid: w.pid, at: new Date().toISOString() }, null, 2))
  setInterval(() => { }, 1000)
}
`

const DRIVER_SRC = String.raw`
// 假 DSH 进程：用最小 fake ctx 跑**真插件**的 host.mjs。
import { spawn as spawnChild } from 'node:child_process'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const args = {}
for (let i = 2; i + 1 < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1]
const pluginDir = args.plugin
const tmpDir = args.tmp
const mode = args.mode || 'idle'
const launcherDetached = args['launcher-detached'] === '1'
const terminateLauncherOnly = args['terminate-launcher-only'] === '1'
const launcherScript = args.launcher
const tokenFile = args['token-file']
const apiPort = Number(args['api-port'])
const bridgePort = Number(args['bridge-port'])

function svcJson(port) { return tmpDir + '/svc-' + port + '.json' }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }
function note(s) { process.stdout.write('[driver] ' + s + '\n') }

const routes = new Map()
const seen = { spawned: [], spawnCalls: [] }
let webServer = null

const fsSvc = {
  async resolve(p) { return String(p) },
  async stat(p) {
    try { const s = statSync(p); return { size: s.size, mtimeMs: s.mtimeMs, isFile: s.isFile(), isDirectory: s.isDirectory() } }
    catch (e) { return undefined }
  },
  async readText(p) { try { return readFileSync(p, 'utf8') } catch (e) { return '' } },
  async readBytes(p, off, max) { try { const b = readFileSync(p); return (max && b.length > max) ? b.subarray(0, max) : b } catch (e) { return null } },
  async writeText(p, content) {
    try { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, content, 'utf8'); return { ok: true } }
    catch (e) { return { ok: false } }
  },
}

function killTree(pid) {
  if (!pid) return
  if (process.platform === 'win32') {
    // 假 DSH 里的 terminate()/terminateForHostExit()：**看退出码**并把结果写进 driver 日志（资源纪律 #5）
    // --terminate-launcher-only 1（R-D 用）：只杀启动器、**不带 /T**，复刻"terminate 只终结了启动器，
    // 而已经 breakaway 的 worker 还占着端口"这种退化情形（真实 ctx.subprocess 未必这样，这里测的是
    // **插件对这种情况的反应**：不许把看门狗收摊、不许报"停干净了"）。
    const argv = terminateLauncherOnly ? ['/PID', String(pid), '/F'] : ['/PID', String(pid), '/T', '/F']
    const r = spawnChild('taskkill', argv, { encoding: 'utf8', windowsHide: true })
    const out = String((r && (r.stdout || r.stderr)) || '').trim().replace(/\s+/g, ' ').slice(0, 100)
    note('taskkill ' + argv.join(' ') + ' → exit=' + (r ? r.status : '?') + ' ' + JSON.stringify(out))
  } else {
    try { process.kill(-pid, 'SIGKILL') } catch (e) { try { process.kill(pid, 'SIGKILL') } catch (e2) { } }
  }
}

function makeHandle(child) {
  let settled = false
  const done = new Promise((resolve) => {
    child.on('exit', (code) => { settled = true; resolve({ exitCode: code }) })
    child.on('error', () => { settled = true; resolve({ exitCode: null }) })
  })
  return {
    pid: child.pid,
    done,
    stdout: null,
    collected: {
      stdout: { readFrom: async () => ({ text: '' }) },
      stderr: { readFrom: async () => ({ text: '' }) },
    },
    terminate() { killTree(child.pid) },
    terminateForHostExit() { killTree(child.pid) },
    waitForExit() { return done },
  }
}

const subprocessSvc = {
  async resolveExecutable(name) { return name },
  spawn(opts) {
    const av = opts.argv || []
    const env = opts.env || {}
    let port = 0
    const pi = av.indexOf('-p')
    if (pi >= 0) port = Number(av[pi + 1]) || 0
    if (!port && env.BRIDGE_PORT) port = Number(env.BRIDGE_PORT) || 0
    seen.spawnCalls.push({
      argv: av.slice(0, 12),
      cwd: String(opts.cwd || ''),
      port: port,
      BRIDGE_PORT: String(env.BRIDGE_PORT || ''),
    })
    let child
    if (port > 0) {
      // ★ 默认 **不 detached**：复刻真实形状（F1-a）—— 插件用 ctx.subprocess 拉起的启动器在 libuv
      //   的 job 里，DSH node 被强杀时它随父同刻死亡；只有 detached(breakaway) 的孙辈活下来占端口。
      //   --launcher-detached 1（用例 R1）则反过来：启动器也活着，走「树杀活着的启动器」这条路径。
      const det = launcherDetached
      child = spawnChild(process.execPath, [launcherScript, 'launcher', String(port), svcJson(port)],
        { stdio: 'ignore', windowsHide: true, cwd: tmpDir, detached: det })
      if (det) child.unref()
      seen.spawned.push({ port, pid: child.pid, launcherDetached: det })
      note('fake subprocess.spawn 托管服务 port=' + port + ' pid=' + child.pid
        + (det ? '（detached，启动器会活下来）' : '（不 detached，随假 DSH 同刻死）'))
    } else {
      // 非服务类 spawn（例如 ensureDataDirs 的 mkdir）：按原 argv 真跑
      child = spawnChild(av[0], av.slice(1), { stdio: 'ignore', windowsHide: true, cwd: opts.cwd || tmpDir, env: Object.assign({}, process.env, env) })
    }
    return makeHandle(child)
  },
}

webServer = { register(route) { routes.set(route.path, route.handler); return () => routes.delete(route.path) } }

const ctx = {
  get(name) {
    if (name === 'fs') return fsSvc
    if (name === 'subprocess') return subprocessSvc
    if (name === 'webServer') return webServer
    return undefined
  },
  effect(fn) { try { const d = fn(); if (typeof d === 'function') return d } catch (e) { note('effect 抛错: ' + (e && e.message ? e.message : String(e))) } return () => {} },
  on() { return () => {} },
  timeout(a, b) { if (typeof a === 'function') { const t = setTimeout(a, b); return () => clearTimeout(t) } return new Promise((r) => setTimeout(r, Number(a) || 0)) },
  interval(fn, ms) { const t = setInterval(fn, ms); return () => clearInterval(t) },
  logger: { info() { }, warn() { }, error() { } },
}

async function callVoice(query) {
  const handler = routes.get('/sakiko/voice')
  if (!handler) throw new Error('路由 /sakiko/voice 未注册')
  let body = ''
  let status = 0
  const res = { writeHead(code) { status = code }, end(text) { body = text || '' } }
  const req = { url: '/sakiko/voice' + (query || ''), method: 'GET', headers: { host: '127.0.0.1:3080' } }
  await handler(req, res)
  return { status, body }
}

function tokenSnapshot() {
  try { return JSON.parse(readFileSync(tokenFile, 'utf8')) } catch (e) { return null }
}

const mod = await import('file:///' + pluginDir.replace(/\\/g, '/') + '/host.mjs')
mod.apply(ctx)
note('apply 完成，等待语音链路就绪…')

let ready = null
for (let i = 0; i < 90; i++) {
  await sleep(500)
  try {
    const r = await callVoice('')
    const j = JSON.parse(r.body)
    if (j.phase === 'ready' || j.phase === 'external') { ready = j; break }
    // 本测试故意只放 api.py（不放 bridge_tts.py）⇒ 桥那一步必然失败；只要 api 已经在听就算到位
    if (j.api && j.api.up && j.api.pid > 0 && !j.starting) { ready = j; break }
  } catch (e) { note('查状态失败: ' + (e && e.message ? e.message : String(e))) }
}
const ev = {
  dshPid: process.pid,
  mode: mode,
  phase: ready ? ready.phase : null,
  owner: ready ? ready.owner : null,
  apiPid: ready && ready.api ? ready.api.pid : 0,
  bridgePid: ready && ready.bridge ? ready.bridge.pid : 0,
  spawned: seen.spawned,
  spawnCalls: seen.spawnCalls,
  dshEnvVisibleToWatchdogLaunch: false,
  at: new Date().toISOString(),
}
process.stdout.write('EVIDENCE ' + JSON.stringify(ev) + '\n')
writeFileSync(tmpDir + '/driver-ready.json', JSON.stringify({ ev: ev, token: tokenSnapshot() }, null, 2))
note('证据已写入 ' + tmpDir + '/driver-ready.json')

if (mode === 'stop' || mode === 'stop-hold') {
  const r = await callVoice('?action=stop')
  writeFileSync(tmpDir + '/driver-stop.json', r.body)
  process.stdout.write('STOP-RESPONSE ' + r.body.replace(/\s+/g, ' ').slice(0, 600) + '\n')
  note('stop 响应已写入 driver-stop.json（mode=' + mode + '）')
  // stop-hold：**保持假 DSH 活着**（脚本自己收尾）—— R-D 要在"停止之后、DSH 还在"的窗口里
  // 观察看门狗有没有被收摊；若让假 DSH 退出，看门狗会因为 stdin EOF 触发回收，观察窗口就没了。
  if (mode === 'stop') { await sleep(5000); process.exit(0) }
}
setInterval(() => { }, 1000)
`

// ---------------- case 基础设施 ----------------
function makeCaseDir(name) {
  const dir = path.join(OUT_ROOT, name + '-' + Date.now())
  const dshHome = path.join(dir, 'dshhome')
  const data = path.join(dshHome, 'sakiko')
  const voiceRoot = path.join(dir, 'voiceroot')
  for (const d of [data, path.join(data, 'config'), path.join(data, 'logs'), path.join(data, 'run'), path.join(data, 'tmp'), path.join(voiceRoot, 'GPT-SoVITS-main')]) {
    mkdirSync(d, { recursive: true })
  }
  writeFileSync(path.join(voiceRoot, 'GPT-SoVITS-main', 'api.py'), '# dummy\n', 'utf8')
  // 注意：**故意不创建 bridge_tts.py** —— 插件走完 api 之后会因"找不到桥"而收尾，于是每个用例
  // 只有**一个**托管服务 ⇒ 假 DSH + 启动器 + worker [+ 孙进程] = ≤4 个进程（资源纪律 #1）。
  // api 这条路径已覆盖 armWatchdog / 令牌文件 / 回收判定；两服务的停止路径另有 graceful 用例覆盖。
  const dummy = path.join(dir, 'dummy.mjs')
  const driver = path.join(dir, 'fake-dsh.mjs')
  writeFileSync(dummy, DUMMY_SRC, 'utf8')
  writeFileSync(driver, DRIVER_SRC, 'utf8')
  return {
    name, dir, dshHome, data, voiceRoot,
    dummyScript: dummy, driverScript: driver,
    tokenFile: path.join(data, 'run', 'voice-watchdog.json'),
    voiceLog: path.join(data, 'logs', 'voice-autostart.log'),
    driverOut: path.join(dir, 'driver.out.log'),
  }
}

function writeConfig(c, apiPort, bridgePort) {
  c.ports = [apiPort]      // 本 case 实际使用的服务端口（单服务；见 makeCaseDir 的说明）
  const cfg = {
    voiceAutoStart: true,
    voiceRoot: c.voiceRoot,
    voiceApiPort: apiPort,
    voiceBridgePort: bridgePort,
    voiceOn: false, chatOn: false, callOn: false, idleChatOn: false, humOn: false,
    provider: 'aqua',            // 避开 edge TTS worker 预热（与语音托管无关，省掉无关噪声）
    personaOn: false, themeOn: false,
  }
  writeFileSync(path.join(c.data, 'config', 'sakiko.json'), JSON.stringify(cfg, null, 2), 'utf8')
}

function startDriver(c, apiPort, bridgePort, mode, opts) {
  const out = []
  const extra = []
  if (opts && opts.launcherDetached) extra.push('--launcher-detached', '1')
  if (opts && opts.terminateLauncherOnly) extra.push('--terminate-launcher-only', '1')
  const env = Object.assign({}, process.env, { DSH_HOME: c.dshHome, SAKIKO_ROOT: (opts && opts.sakikoRoot) || PLUGIN })
  const child = spawn(process.execPath, [
    c.driverScript,
    '--plugin', PLUGIN,
    '--tmp', c.dir,
    '--mode', mode,
    '--launcher', c.dummyScript,
    '--token-file', c.tokenFile,
    '--api-port', String(apiPort),
    '--bridge-port', String(bridgePort),
  ].concat(extra), {
    cwd: c.dir,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: env,
  })
  child.stdout.on('data', (b) => out.push(String(b)))
  child.stderr.on('data', (b) => out.push('[stderr] ' + String(b)))
  const flush = () => { try { writeFileSync(c.driverOut, out.join(''), 'utf8') } catch (e) { /* ignore */ } }
  const iv = setInterval(flush, 500)
  return { child, out, flush, stopFlush: () => clearInterval(iv) }
}

async function startExternalDummies(c, ports) {
  const pids = []
  for (const p of ports) {
    const ch = spawn(process.execPath, [c.dummyScript, 'launcher', String(p), path.join(c.dir, 'svc-' + p + '.json')], { stdio: 'ignore', windowsHide: true })
    pids.push(ch.pid)
  }
  const ok = await waitFor(async () => {
    for (const p of ports) {
      if (!(await portOpen(p, 500))) return false
      if (!gchildRecord(c, p)) return false
    }
    return true
  }, 15000, 200)
  return { pids, ok: ok.ok }
}

function findWatchdogs(tokenFile) {
  const tok = readJson(tokenFile)
  const pid = tok && Number(tok.watchdogPid) > 0 ? Number(tok.watchdogPid) : 0
  if (!pid || !pidAlive(pid)) return []
  const i = psInfo([pid]).get(pid)
  if (!i) return []
  if (!String(i.cmd).toLowerCase().includes('watchdog.mjs')) return []
  return [{ pid, cmd: i.cmd }]
}

// 诊断串：把 findWatchdogs 判空的每一步都摊开（前置断言失败时必须能看出卡在哪一步）
function wdDiag(c) {
  const tok = readJson(c.tokenFile)
  const pid = tok && Number(tok.watchdogPid) > 0 ? Number(tok.watchdogPid) : 0
  const info = pid > 0 ? psInfo([pid]).get(pid) : undefined
  return 'token=' + (tok ? String(tok.token).slice(0, 8) : '（无令牌文件）')
    + '；token.watchdogPid=' + (tok ? String(tok.watchdogPid) : 'n/a')
    + '；pidAlive=' + (pid > 0 ? String(pidAlive(pid)) : 'n/a')
    + '；psInfo.cmd=' + (info ? JSON.stringify(String(info.cmd).slice(0, 120)) : '（查不到该 pid）')
    + '；services=' + (tok ? JSON.stringify(tok.services) : 'n/a')
}

// 有界等待"令牌文件里的看门狗登记就位且进程活着"（插件写令牌是异步的：不要用一次瞬时读去赌）
async function waitForWatchdog(c, timeoutMs) {
  const r = await waitFor(() => findWatchdogs(c.tokenFile).length === 1, timeoutMs || 20000, 400)
  return { wds: findWatchdogs(c.tokenFile), ok: r.ok, ms: r.ms }
}

function portOwners(ports) {
  const r = spawnSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8', timeout: 15000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 })
  const res = {}
  for (const p of ports) res[p] = []
  for (const line of String((r && r.stdout) || '').split(/\r?\n/)) {
    const m = line.trim().match(/^TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i)
    if (m && res[Number(m[1])] !== undefined) res[Number(m[1])].push(Number(m[2]))
  }
  return res
}

// 本 case 已知的 pid（svc/gchild 记录 + 令牌文件里的 watchdogPid）——定向查询与清理都用它
function knownPidsOf(c) {
  const out = []
  for (const p of (c && c.ports) || []) {
    const d = dummyPids(c, p)
    for (const k of ['launcher', 'worker', 'grandchild']) if (d[k]) out.push(d[k])
  }
  const tok = c ? readJson(c.tokenFile) : null
  if (tok && Number(tok.watchdogPid) > 0) out.push(Number(tok.watchdogPid))
  return out
}

function dumpDiag(c, ports, driverPid) {
  console.log('  --- 诊断（定向查询：只查本 case 的进程树，不拉全表）---')
  const tree = psProcTree([driverPid].concat(knownPidsOf(c)).filter((x) => x > 0), 6)
  for (const [pid, i] of tree) {
    console.log('    [' + i.tag + '] pid=' + pid + ' ppid=' + i.ppid + ' ' + String(i.cmd).replace(/\s+/g, ' ').slice(0, 120))
  }
  const owners = portOwners(ports)
  for (const p of ports) console.log('  端口 ' + p + ' 的监听者 pid=' + JSON.stringify(owners[p]))
}

function svcRecord(c, port) { return readJson(path.join(c.dir, 'svc-' + port + '.json')) }
function gchildRecord(c, port) { return readJson(path.join(c.dir, 'svc-' + port + '.json.gchild.json')) }

// 一个 dummy 服务的三代 pid：launcher（随假 DSH 同刻死）/ worker（监听端口）/ grandchild（常驻）
function dummyPids(c, port) {
  const r = svcRecord(c, port)
  const g = gchildRecord(c, port)
  return { launcher: r ? r.launcherPid : 0, worker: r ? r.workerPid : 0, grandchild: g ? g.grandchildPid : 0 }
}
function allDummyPids(c, ports) {
  const out = []
  for (const p of ports) {
    const d = dummyPids(c, p)
    for (const k of ['launcher', 'worker', 'grandchild']) if (d[k]) out.push(d[k])
  }
  return out
}

async function cleanup(c, ctxObj) {
  // 每个 case 结束都要把这一代**全部**清干净（含孙进程），再进下一个 case（资源纪律 #3）
  if (ctxObj && ctxObj.wd && pidAlive(ctxObj.wd.pid)) killTreeStrict(ctxObj.wd.pid, '本 case 自己起的看门狗')
  if (ctxObj && ctxObj.driver && ctxObj.driver.child && pidAlive(ctxObj.driver.child.pid)) {
    killTreeStrict(ctxObj.driver.child.pid, '本 case 的假 DSH')
    await sleep(600)
  }
  for (const pid of (ctxObj && ctxObj.extraPids) || []) if (pidAlive(pid)) killTreeStrict(pid, 'dummy')
  for (const w of findWatchdogs(c.tokenFile)) killTreeStrict(w.pid, '令牌文件里登记的看门狗')
  // 定向兜底：从"本 case 假 DSH 的 pid"沿 PPID 链找回还活着的后代（**不扫全表**）
  const roots = [(ctxObj && ctxObj.driver && ctxObj.driver.child.pid) || 0].filter((x) => x > 0)
  if (roots.length > 0) {
    for (const p of psDescendants(roots, 6)) {
      if (pidAlive(p)) killTreeStrict(p, '本 case 假 DSH 的残留后代')
    }
  }
  const still = liveFixturePids()
  console.log('  [cleanup] 本 case 结束后仍存活的本测试 pid：' + (still.length === 0 ? '（空）' : still.join(',')))
  return still
}

// ---------------- 各 case ----------------
// 同一个用例跑两种形状（**两种都保留**，它们验证的是不同分支）：
//   R1' real-shape      启动器 **非 detached** ⇒ 强杀时启动器随 DSH 同刻死，占端口的是它的后代
//                       （这是生产环境真正会走的分支，也是本功能的核心判据）
//   R1  detached-launcher 启动器也 detached ⇒ 回收时启动器还活着，走"树杀活着的启动器"这条路径
async function caseKillTree(apiPort, bridgePort, variant) {
  const realShape = variant === 'real-shape'
  const name = realShape ? 'positive' : 'detached-launcher'
  const c = makeCaseDir(name)
  const PORTS = [apiPort]
  const cx = { ports: PORTS, extraPids: [] }
  console.log('\n=== case ' + name + '（' + (realShape
    ? 'R1\'：启动器随 DSH 同刻死亡 ⇒ 必须按 PPID 链回收后代'
    : 'R1：启动器仍活着 ⇒ 树杀活着的启动器') + '）===')
  console.log('  plugin=' + PLUGIN + '\n  tmp=' + c.dir + '\n  端口=' + apiPort + '（单服务：只放 api.py）'
    + '\n  形状=' + (realShape ? '假DSH → 启动器(非detached,随父死) → worker(detached,监听) → 孙进程(detached)' : '假DSH → 启动器(detached) → worker(detached,监听) → 孙进程(detached)'))
  if (!(await portOpen(apiPort, 400))) rec(name, '前置：临时端口空闲', true, '')
  else rec(name, '前置：临时端口空闲', false, '端口已被占用，测试无效')
  writeConfig(c, apiPort, bridgePort)
  const d = startDriver(c, apiPort, bridgePort, 'idle', { launcherDetached: !realShape })
  cx.driver = d
  track(d.child.pid)

  const up = await waitFor(async () => {
    const a = svcRecord(c, apiPort)
    const ga = gchildRecord(c, apiPort)
    return !!a && !!ga && (await portOpen(apiPort, 400))
  }, 60000, 500)
  d.flush()
  const pids = { api: dummyPids(c, apiPort) }
  const dummies = allDummyPids(c, PORTS)
  track(pids.api.launcher, pids.api.worker, pids.api.grandchild)
  cx.extraPids = dummies
  rec(name, '前置：dummy 服务三代进程都在（启动器 + 监听 worker + 常驻孙进程）',
    up.ok && dummies.length === 3, 'api=' + JSON.stringify(pids.api))

  const token = readJson(c.tokenFile)
  const wds = findWatchdogs(c.tokenFile)
  track(wds.length > 0 ? wds[0].pid : 0)
  rec(name, '前置：令牌文件已生成且 services 登记了那一个 pid', !!(token && token.token && token.services && token.services.length === 1),
    token ? JSON.stringify(token).slice(0, 300) : '（令牌文件不存在）')
  rec(name, '前置：看门狗进程确实活着（否则本 case 会"空过"）', wds.length === 1,
    wds.length > 0 ? pidDesc(wds[0].pid) : '（没有找到 watchdog.mjs 进程）')

  // ★ F2：验证插件真实的 spawn 形状（api: cwd=GPT-SoVITS-main + 相对 argv api.py）
  const drReady = await waitFor(() => existsSync(path.join(c.dir, 'driver-ready.json')), 30000, 400)
  const dr0 = readJson(path.join(c.dir, 'driver-ready.json'))
  const calls = (dr0 && dr0.ev && dr0.ev.spawnCalls) || []
  const apiCall = calls.find((x) => x.port === apiPort)
  const apiOk = !!apiCall && /GPT-SoVITS-main$/.test(String(apiCall.cwd).replace(/[\\/]+$/, ''))
    && apiCall.argv[2] === 'api.py' && apiCall.argv.includes('-p') && apiCall.argv.includes(String(apiPort))
  rec(name, '前置：复刻了真实的 spawn 形状（F2：api cwd=GPT-SoVITS-main + 裸 argv api.py）',
    drReady.ok && apiOk, 'api=' + JSON.stringify(apiCall))

  // ---- 强杀假 DSH（**不带 /T**：模仿验收台的真实强杀方式 taskkill /F /PID <node>）----
  dumpDiag(c, PORTS, d.child.pid)
  const wdPid = wds.length > 0 ? wds[0].pid : 0
  const killAt = new Date()
  const t0 = Date.now()
  console.log('  >>> taskkill /F /PID ' + d.child.pid + '（' + killAt.toISOString() + '，**不带 /T**）')
  const dshKill = killPidOnly(d.child.pid, '假 DSH 强杀')
  const dshGone = await waitFor(() => !pidAlive(d.child.pid), 5000, 400)
  rec(name, '假 DSH 进程已被强杀', dshGone.ok && dshKill.ok, 'pid=' + d.child.pid + ' 消失耗时 ' + dshGone.ms + 'ms；' + dshKill.how)

  // ★ 强杀后立刻取"形状快照"（此时看门狗还在查进程，来不及动手）
  const shape = {
    launcherAlive: [pids.api.launcher].filter((p) => p && pidAlive(p)),
    workerAlive: [pids.api.worker].filter((p) => p && pidAlive(p)),
    gchildAlive: [pids.api.grandchild].filter((p) => p && pidAlive(p)),
    watchdogAlive: pidAlive(wdPid),
    at: new Date().toISOString(),
    deltaMs: Date.now() - t0,
  }
  if (realShape) {
    rec(name, '★★★ 前置（核心判据）：登记的启动器**已随 DSH 同刻死亡**，而 worker/孙进程仍活着并占着端口',
      shape.launcherAlive.length === 0 && shape.workerAlive.length === 1 && shape.gchildAlive.length === 1,
      '强杀后 +' + shape.deltaMs + 'ms 快照：存活启动器=' + JSON.stringify(shape.launcherAlive)
      + '（必须为空），存活 worker=' + JSON.stringify(shape.workerAlive) + '，存活孙进程=' + JSON.stringify(shape.gchildAlive))
  } else {
    rec(name, '前置：启动器在回收时刻**仍然活着**（本 case 走的是"树杀活着的启动器"路径）',
      shape.launcherAlive.length === 1 && shape.workerAlive.length === 1 && shape.gchildAlive.length === 1,
      '强杀后 +' + shape.deltaMs + 'ms 快照：存活启动器=' + JSON.stringify(shape.launcherAlive) + '（应为 1 个）')
  }
  rec(name, '★★ 看门狗在假 DSH 被 taskkill /F 强杀后**仍然存活**（detached 生效，没被 job 收走）',
    shape.watchdogAlive && wdPid > 0,
    '看门狗 pid=' + wdPid + ' 在 ' + shape.at + ' 仍 alive=' + shape.watchdogAlive + '（其父 pid=' + d.child.pid + ' 已消失）')

  const clr = await waitFor(async () => !(await portOpen(apiPort, 400)), 15000, 400)
  const elapsed = Date.now() - t0
  rec(name, '≤15s 内端口空闲', clr.ok, clr.ok
    ? ('端口 ' + apiPort + ' 释放耗时 ' + elapsed + 'ms')
    : ('15s 内端口仍未释放：' + apiPort + '=' + (await portOpen(apiPort, 400)) + '（等待超时 ' + elapsed + 'ms）'))
  const dead = await waitFor(() => dummies.every((p) => !pidAlive(p)), 15000, 400)
  rec(name, '≤15s 内整棵后代树（启动器+worker+孙进程）全部消失', dead.ok && dummies.length === 3,
    'pids=' + dummies.join(',') + '；仍存活=' + dummies.filter(pidAlive).join(',') + '（空=全灭）')
  const wdGone = await waitFor(() => findWatchdogs(c.tokenFile).length === 0, 15000, 400)
  const hadWatchdog = wds.length === 1
  rec(name, '看门狗完成回收后自行退出', wdGone.ok && hadWatchdog,
    hadWatchdog ? ('耗时 ' + (Date.now() - t0) + 'ms') : '（本 case 从未出现看门狗 ⇒ 该断言不成立）')
  d.flush(); d.stopFlush()
  const lg = logText(c.voiceLog)
  rec(name, '语音日志里出现看门狗前缀记录', lg.includes('[watchdog]'), '行数=' + lg.split('\n').length)
  if (realShape) {
    rec(name, '★★ 日志写明「登记启动器已死（随 DSH 被 job 收走）⇒ 无法对它 taskkill，改为按 PPID 链回收后代」'
      + '（即：回收不依赖对登记 pid 的 taskkill 是否成功）',
      /进程已不存在（强杀时随 DSH 一起被 job 收走的直接子进程）/.test(lg) && /的后代：/.test(lg), '')
  } else {
    rec(name, '日志写明「树杀成功 …（taskkill /PID … /T /F）」（活着的启动器被 /T 连后代一起带走）',
      /树杀成功/.test(lg) && /taskkill \/PID \d+ \/T \/F/.test(lg), '')
  }
  rec(name, '日志记录了检测方式（stdin EOF）与回收结果（端口空闲）',
    /检测方式=stdin/.test(lg) && /现在空闲/.test(lg),
    (lg.split('\n').filter((l) => l.includes('[watchdog]')).slice(-3).join(' | ')).slice(0, 400))
  console.log('  --- 关键时刻线 ---')
  console.log('  强杀时刻   : ' + killAt.toISOString() + '（taskkill /F /PID ' + d.child.pid + '，不带 /T）')
  console.log('  形状快照   : ' + shape.at + '（+' + shape.deltaMs + 'ms）启动器存活=' + JSON.stringify(shape.launcherAlive)
    + ' worker 存活=' + JSON.stringify(shape.workerAlive) + ' 孙进程存活=' + JSON.stringify(shape.gchildAlive)
    + ' 看门狗 alive=' + shape.watchdogAlive)
  console.log('  端口释放   : ' + new Date(killAt.getTime() + elapsed).toISOString() + '（+' + elapsed + 'ms）')
  console.log('  看门狗退出 : +' + (Date.now() - t0) + 'ms（pid=' + wdPid + '）')
  console.log('  --- 原始证据 ---')
  console.log('  driver 输出: ' + c.driverOut)
  console.log('  日志文件   : ' + c.voiceLog)
  for (const l of lg.split('\n').filter((x) => x.includes('[watchdog]'))) console.log('    ' + l)
  console.log('  driver 关键行:')
  for (const l of d.out.join('').split('\n').filter((x) => x.startsWith('EVIDENCE') || x.includes('fake subprocess'))) console.log('    ' + l.slice(0, 300))
  await cleanup(c, cx)
  if (!KEEP) { try { rmSync(c.dir, { recursive: true, force: true }) } catch (e) { /* ignore */ } }
  return c
}

async function caseTokenMismatch(apiPort, bridgePort) {
  const c = makeCaseDir('token-mismatch')
  const PORTS = [apiPort]
  const cx = { ports: PORTS, extraPids: [] }
  console.log('\n=== case token-mismatch（反例 A：令牌已被新一代改写 ⇒ 什么都不许杀）===')
  console.log('  tmp=' + c.dir)
  writeConfig(c, apiPort, bridgePort)
  const d = startDriver(c, apiPort, bridgePort, 'idle')
  cx.driver = d
  track(d.child.pid)
  const up = await waitFor(async () => {
    const a = svcRecord(c, apiPort)
    const ga = gchildRecord(c, apiPort)
    return !!a && !!ga && (await portOpen(apiPort, 400))
  }, 60000, 500)
  d.flush()
  const dummies = allDummyPids(c, PORTS)
  for (const p of dummies) track(p)
  cx.extraPids = dummies
  rec('token-mismatch', '前置：dummy 服务三代进程已在监听', up.ok && dummies.length === 3,
    'api=' + JSON.stringify(dummyPids(c, apiPort)))
  const token = readJson(c.tokenFile)
  const wds = findWatchdogs(c.tokenFile)
  track(wds.length > 0 ? wds[0].pid : 0)
  rec('token-mismatch', '前置：看门狗进程确实活着', wds.length === 1, wds.length ? pidDesc(wds[0].pid) : '（未找到）')

  // 模拟"新一代已经接管"：把令牌文件改写成另一个 token
  const forged = Object.assign({}, token, { token: 'forged-new-generation-' + Date.now(), updatedAt: new Date().toISOString() })
  writeFileSync(c.tokenFile, JSON.stringify(forged, null, 2), 'utf8')
  console.log('  >>> 令牌文件已被改写为 token=' + forged.token)

  const t0 = Date.now()
  killPidOnly(d.child.pid, '假 DSH 强杀')
  const wdGone = await waitFor(() => findWatchdogs(c.tokenFile).length === 0, 15000, 400)
  const hadWatchdog = wds.length === 1
  rec('token-mismatch', '看门狗在 ≤15s 内退出（读完令牌就收工）', wdGone.ok && hadWatchdog,
    hadWatchdog ? ('耗时 ' + (Date.now() - t0) + 'ms') : '（本 case 从未出现看门狗 ⇒ 该断言不成立）')
  await sleep(1500)   // 先让"启动器随假 DSH 同刻死亡"发生完（那是 job 干的，不是看门狗）
  const aliveAfterKill = dummies.filter(pidAlive)
  await sleep(3000)   // 再等一会儿：若看门狗要误杀，这段时间足够它动手
  const aliveLater = dummies.filter(pidAlive)
  rec('token-mismatch', '★ 看门狗没杀任何进程：强杀后还活着的后代（worker/孙进程）3s 后依然全在',
    aliveLater.length >= 2 && aliveLater.length === aliveAfterKill.length
    && aliveLater.every((p) => aliveAfterKill.includes(p)),
    '强杀后存活=' + aliveAfterKill.join(',') + ' → 3s 后存活=' + aliveLater.join(',')
    + '（登记启动器已随 DSH 死亡，本就不该在存活集里）')
  rec('token-mismatch', '端口仍然被占（证明服务真的没被杀）',
    await portOpen(apiPort, 500), apiPort + ' 仍在监听')
  d.flush(); d.stopFlush()
  const lg = logText(c.voiceLog)
  rec('token-mismatch', '日志写明「token 不匹配 ⇒ 不做任何操作」', /token 不匹配/.test(lg) && /不做任何操作/.test(lg),
    (lg.split('\n').filter((l) => l.includes('[watchdog]')).slice(-2).join(' | ')).slice(0, 400))
  console.log('  --- 原始证据 ---')
  for (const l of lg.split('\n').filter((x) => x.includes('[watchdog]'))) console.log('    ' + l)
  await cleanup(c, cx)
  if (!KEEP) { try { rmSync(c.dir, { recursive: true, force: true }) } catch (e) { /* ignore */ } }
  return c
}

async function caseExternal(apiPort, bridgePort) {
  const c = makeCaseDir('external')
  // 外部服务放在**桥端口**上：插件的 external 判定就是先看桥端口在不在听（且此时它一个都不 spawn）
  const EXT_PORT = bridgePort
  const cx = { ports: [EXT_PORT], extraPids: [] }
  console.log('\n=== case external（反例 B：端口已被外来服务占用 ⇒ 不生成看门狗、不杀任何东西）===')
  console.log('  tmp=' + c.dir + '\n  外来服务端口=' + EXT_PORT + '（桥端口）')
  const ext = await startExternalDummies(c, [EXT_PORT])
  const dummies = allDummyPids(c, [EXT_PORT])
  for (const p of dummies) track(p)
  cx.extraPids = dummies
  rec('external', '前置：外来（非插件拉起）的 dummy 服务已在监听', ext.ok && dummies.length === 3,
    'dummy=' + JSON.stringify(dummyPids(c, EXT_PORT)))
  writeConfig(c, apiPort, bridgePort)
  const d = startDriver(c, apiPort, bridgePort, 'idle')
  cx.driver = d
  track(d.child.pid)
  const ready = await waitFor(() => existsSync(path.join(c.dir, 'driver-ready.json')), 90000, 500)
  d.flush()
  const dr = readJson(path.join(c.dir, 'driver-ready.json'))
  rec('external', '插件判定为 external（不接管）', ready.ok && dr && dr.ev && dr.ev.phase === 'external',
    dr ? JSON.stringify(dr.ev) : '（driver 未就绪）')
  rec('external', '插件没有 spawn 任何服务（spawned 为空）', dr && dr.ev && dr.ev.spawned.length === 0,
    dr ? JSON.stringify(dr.ev.spawned) : '')
  const wds = findWatchdogs(c.tokenFile)
  rec('external', '★ 没有生成看门狗进程（没 spawn 就没有所有权）', wds.length === 0,
    wds.length ? JSON.stringify(wds) : 'watchdog 进程数=0')
  const tok = readJson(c.tokenFile)
  rec('external', '令牌文件没有被写成本代有效令牌', !(tok && tok.token), tok ? JSON.stringify(tok).slice(0, 200) : '（令牌文件不存在）')
  const alive = dummies.filter(pidAlive)
  rec('external', '★ 外来 dummy 服务（worker/孙进程）一个都没被杀', alive.length === 3 && dummies.length === 3, '存活=' + alive.join(','))
  // 连 driver 也一起杀掉，再确认外来服务仍然活着（真正的"非优雅退出也不误杀"）
  killPidOnly(d.child.pid, '假 DSH 强杀')
  await sleep(4000)
  const alive2 = dummies.filter(pidAlive)
  rec('external', '强杀假 DSH 之后外来服务依然活着（无看门狗 ⇒ 无任何回收动作）', alive2.length === 3, '存活=' + alive2.join(','))
  const lg = logText(c.voiceLog)
  rec('external', '日志写明走的是 external 分支（"外部服务已在监听"或 D8 的"外部桥在听、api 未就绪"）',
    /检测到外部服务已在监听|警告：外部桥 \d+ 在听/.test(lg) && /不做任何操作|请自行检查 api 进程/.test(lg),
    (lg.split('\n').filter((l) => l.includes('外部')).slice(-1).join('')).slice(0, 300))
  console.log('  --- 原始证据 ---')
  console.log('  driver 输出: ' + c.driverOut)
  for (const l of logText(c.voiceLog).split('\n').filter((x) => x.includes('外部') || x.includes('[watchdog]'))) console.log('    ' + l)
  await cleanup(c, cx)
  if (!KEEP) { try { rmSync(c.dir, { recursive: true, force: true }) } catch (e) { /* ignore */ } }
  return c
}

async function caseGraceful(apiPort, bridgePort) {
  const c = makeCaseDir('graceful')
  const PORTS = [apiPort]
  const cx = { ports: PORTS, extraPids: [] }
  console.log('\n=== case graceful（回归：?action=stop ⇒ 服务停掉 + 看门狗收摊 + 无孤儿）===')
  console.log('  tmp=' + c.dir)
  writeConfig(c, apiPort, bridgePort)
  const d = startDriver(c, apiPort, bridgePort, 'stop')
  cx.driver = d
  track(d.child.pid)
  const up = await waitFor(async () => {
    const a = svcRecord(c, apiPort)
    const ga = gchildRecord(c, apiPort)
    return !!a && !!ga && (await portOpen(apiPort, 400))
  }, 60000, 500)
  d.flush()
  const dummies = allDummyPids(c, PORTS)
  for (const p of dummies) track(p)
  cx.extraPids = dummies
  rec('graceful', '前置：dummy 服务三代进程已在监听', up.ok && dummies.length === 3,
    'api=' + JSON.stringify(dummyPids(c, apiPort)))
  const wdsBefore = findWatchdogs(c.tokenFile)
  track(wdsBefore.length > 0 ? wdsBefore[0].pid : 0)
  rec('graceful', '前置：看门狗进程确实活着', wdsBefore.length === 1, wdsBefore.length ? pidDesc(wdsBefore[0].pid) : '（未找到）')

  const stopped = await waitFor(() => existsSync(path.join(c.dir, 'driver-stop.json')), 30000, 400)
  rec('graceful', 'driver 调用了 ?action=stop 并拿到响应', stopped.ok, stopped.ok ? logText(path.join(c.dir, 'driver-stop.json')).replace(/\s+/g, ' ').slice(0, 240) : '（超时）')
  const t0 = Date.now()
  const clr = await waitFor(async () => !(await portOpen(apiPort, 400)), 15000, 400)
  rec('graceful', '服务被停掉：端口空闲', clr.ok, clr.ok
    ? ('耗时 ' + (Date.now() - t0) + 'ms')
    : ('15s 内端口仍未释放：' + apiPort + '=' + (await portOpen(apiPort, 400))))
  const dead = await waitFor(() => dummies.every((p) => !pidAlive(p)), 15000, 400)
  rec('graceful', '整棵后代树（启动器+worker+孙进程）全部消失（无孤儿）', dead.ok && dummies.length === 3,
    'pids=' + dummies.join(',') + '；仍存活=' + dummies.filter(pidAlive).join(',') + '（空=全灭）')
  const wdGone = await waitFor(() => findWatchdogs(c.tokenFile).length === 0, 15000, 400)
  const hadWatchdog = wdsBefore.length === 1
  rec('graceful', '看门狗已收摊（进程退出）', wdGone.ok && hadWatchdog,
    hadWatchdog ? ('耗时 ' + (Date.now() - t0) + 'ms') : '（本 case 从未出现看门狗 ⇒ 该断言不成立）')
  await waitFor(() => !pidAlive(d.child.pid), 20000, 400)
  d.flush(); d.stopFlush()
  const tok = readJson(c.tokenFile)
  rec('graceful', '令牌文件已被置为失效态（token=null）', !!(tok && tok.token === null), tok ? JSON.stringify(tok).slice(0, 200) : '（令牌文件不存在）')
  const lg = logText(c.voiceLog)
  rec('graceful', '日志里有「已停止看门狗」记录', /已停止看门狗/.test(lg),
    (lg.split('\n').filter((l) => l.includes('[watchdog]')).slice(-2).join(' | ')).slice(0, 400))
  console.log('  --- 原始证据 ---')
  for (const l of lg.split('\n').filter((x) => x.includes('[watchdog]') || x.includes('已停止')).slice(-12)) console.log('    ' + l)
  await cleanup(c, cx)
  if (!KEEP) { try { rmSync(c.dir, { recursive: true, force: true }) } catch (e) { /* ignore */ } }
  return c
}

async function caseLogAppend(apiPort, bridgePort) {
  const c = makeCaseDir('log-append')
  const PORTS = [apiPort]
  const cx = { ports: PORTS, extraPids: [] }
  console.log('\n=== case log-append（Minor：日志改 append + 1MB 轮转 ⇒ 重启后仍能取证上一代怎么退出的）===')
  console.log('  tmp=' + c.dir + '（两代假 DSH 共用同一个 DSH_HOME / 同一份日志；每代单服务，串行）')
  writeConfig(c, apiPort, bridgePort)

  // ---- 第一代 ----
  const d1 = startDriver(c, apiPort, bridgePort, 'idle')
  track(d1.child.pid)
  const up1 = await waitFor(async () => !!svcRecord(c, apiPort) && !!gchildRecord(c, apiPort), 60000, 500)
  const api1 = svcRecord(c, apiPort)
  const gen1Pids = allDummyPids(c, PORTS)
  for (const p of gen1Pids) track(p)
  cx.extraPids = gen1Pids
  d1.flush()
  const marker1 = '已拉起 GPT-SoVITS api pid=' + (api1 ? api1.launcherPid : '?')
  const token1 = readJson(c.tokenFile)
  rec('log-append', '前置：第一代已拉起服务且日志落盘', up1.ok, marker1 + '；token=' + (token1 ? String(token1.token).slice(0, 8) : 'n/a'))
  killPidOnly(d1.child.pid, '第一代假 DSH 强杀')
  await waitFor(() => gen1Pids.every((p) => !pidAlive(p)), 15000, 400)
  d1.stopFlush()
  const log1 = logText(c.voiceLog)
  rec('log-append', '前置：第一代的行确实写进了日志文件', log1.includes(marker1),
    '第一代 dshPid=' + d1.child.pid + '；文件长度=' + log1.length)

  // 本 case 只验证日志语义：第一代残留（未修版本里没有看门狗 ⇒ 服务成孤儿、端口仍被占）
  // 由**测试脚本自己**按 pid 清掉，否则第二代会被判成"外部服务"而不拉起，污染本 case 的前提。
  const leftOrphans = gen1Pids.filter(pidAlive)
  if (leftOrphans.length > 0) {
    console.log('  >>> 第一代残留孤儿（测试脚本自行清理，不代表被测插件的行为）：' + leftOrphans.join(','))
    for (const p of leftOrphans) killTreeStrict(p, '第二代开工前清场')
  }
  const clear1 = await waitFor(async () => !(await portOpen(apiPort, 400)), 10000, 400)
  rec('log-append', '前置：第二代启动前端口空闲（第一代已彻底清干净）', clear1.ok,
    clear1.ok ? 'ok' : ('端口仍被占：' + apiPort + '=' + (await portOpen(apiPort, 400))))

  // 把日志预填到 >1MB，好让第二代的第一次写盘触发轮转
  appendFileSync(c.voiceLog, ('filler-to-exceed-rotation-threshold ' + 'x'.repeat(200) + '\n').repeat(5000), 'utf8')
  const sizeBefore = statSync(c.voiceLog).size
  console.log('  >>> 已把日志预填到 ' + sizeBefore + ' 字节（>1MB），然后启动第二代')

  // ---- 第二代（同一个 DSH_HOME）----
  const d2 = startDriver(c, apiPort, bridgePort, 'stop')
  track(d2.child.pid)
  cx.driver = d2
  const up2 = await waitFor(async () => !!svcRecord(c, apiPort) && !!gchildRecord(c, apiPort), 60000, 500)
  d2.flush()
  const api2 = svcRecord(c, apiPort)
  rec('log-append', '前置：第二代（新进程）已拉起服务', up2.ok, '第二代 dshPid=' + d2.child.pid + '、api launcher=' + (api2 ? api2.launcherPid : '?'))
  await waitFor(() => existsSync(path.join(c.dir, 'driver-stop.json')), 30000, 300)
  await waitFor(() => !pidAlive(d2.child.pid), 20000, 300)
  d2.stopFlush()

  const log2 = logText(c.voiceLog)
  const rots = rotatedLogs(c)
  const rotAll = rots.map((r) => r.text).join('\n')
  const sizeAfter = (() => { try { return statSync(c.voiceLog).size } catch (e) { return 0 } })()
  rec('log-append', '★ 第一代的行在第二代起来之后仍然查得到（append 语义，不再被整份覆写）',
    rotAll.includes(marker1) || log2.includes(marker1),
    'marker=「' + marker1 + '」；历史档里有=' + rotAll.includes(marker1) + '；主档里有=' + log2.includes(marker1))
  rec('log-append', '★ 超过 1MB 时轮转出**带时间戳**的历史档 .1-<ts>（不再用"先 rm 再 rename"那对会互相删档的 .1）',
    rots.length >= 1 && /^voice-autostart\.log\.1-\d{4}-\d\d-\d\dT/.test(rots[0].name) && sizeAfter < sizeBefore,
    '历史档=' + JSON.stringify(rots.map((r) => r.name)) + '；主档 ' + sizeBefore + ' → ' + sizeAfter + ' 字节')
  rec('log-append', '★ 历史档最多保留 2 份（文件名互不相同 ⇒ 两代同时轮转也不会互相删掉刚写下的记录）',
    rots.length <= 2, '历史档数=' + rots.length)
  rec('log-append', '第二代自己的记录写进了主档（新档从本代开始）', log2.includes('已拉起 GPT-SoVITS api pid='),
    (log2.split('\n').filter((l) => l.length > 0).slice(0, 3).join(' | ')).slice(0, 300))
  // 源码级断言（无法用运行时事件直接证明"看门狗没有轮转"）：看门狗只 append，没有任何改名/删除/覆写动作
  const wdSrc = readFileSync(path.join(PLUGIN, 'watchdog.mjs'), 'utf8')
  rec('log-append', '★ 看门狗进程永不轮转（源码里只有 appendFileSync，没有 rename/rm/覆写日志的动作）',
    /appendFileSync/.test(wdSrc) && !/renameSync|rmSync|unlinkSync|writeFileSync|truncate/.test(wdSrc),
    'watchdog.mjs 里 appendFileSync=' + /appendFileSync/.test(wdSrc)
    + '、rename/rm/覆写动作=' + /renameSync|rmSync|unlinkSync|writeFileSync|truncate/.test(wdSrc))
  console.log('  --- 原始证据 ---')
  console.log('  日志主档: ' + c.voiceLog + '（' + sizeAfter + ' 字节，前 3 行）')
  for (const l of log2.split('\n').filter((x) => x.length > 0).slice(0, 3)) console.log('    ' + l)
  console.log('  日志历史档: ' + (rots.length === 0 ? '（无）' : JSON.stringify(rots.map((r) => r.name + '=' + r.text.length + '字符'))))
  for (const l of rotAll.split('\n').filter((x) => x.includes(marker1) || x.includes('[watchdog] 已拉起')).slice(0, 3)) console.log('    ' + l)
  await cleanup(c, cx)
  if (!KEEP) { try { rmSync(c.dir, { recursive: true, force: true }) } catch (e) { /* ignore */ } }
  return c
}

// 端口兜底单独验证（诊断开关 --no-descendants）—— **契约在 2026-09-13 被 ① 改掉了**，本用例随之改写：
// 旧契约（未修版本 c5860cf）：登记启动器已死 + 不做后代枚举 ⇒ 端口兜底的"祖先链判定"会走到已死的
//   登记 pid 上，于是把 worker 认成"本代的"、树杀掉。为此 `allowed` 里必须塞进**未经校验的原始登记
//   pid**（`...roots`）—— 而这正是 ① 的漏洞：同一个 pid 刚被判成"已被复用"也能被端口兜底认领。
// 新契约：`allowed` 只含**通过校验的目标**（targets ∪ killed），skipped 是永久排除集。于是
//   "登记启动器已死 + 关掉后代枚举"这条**诊断路径**下，端口持有者认不出来 ⇒ 只记日志、**不杀**。
//   （方向按 fail-safe 选"宁可漏杀"：PID 复用的登记 pid 与"父已死"的登记 pid 在证据上无法区分。
//    生产路径永远带后代枚举 —— host.mjs 拉起看门狗时只传 token/epoch/dsh-pid/token-file/log ——
//    真实强杀形状的后代会被并进 targets，回收不受影响，见 positive 用例。）
async function caseFallbackPort(apiPort, bridgePort) {
  const name = 'fallback-port'
  const c = makeCaseDir(name)
  const PORTS = [apiPort]
  const cx = { ports: PORTS, extraPids: [] }
  console.log('\n=== case fallback-port（诊断路径 --no-descendants：登记启动器已死 ⇒ 端口兜底**认不出**持有者）===')
  console.log('  tmp=' + c.dir + '\n  端口=' + apiPort + '（单服务）')
  const ch = spawn(process.execPath, [c.dummyScript, 'launcher', String(apiPort), path.join(c.dir, 'svc-' + apiPort + '.json')], { stdio: 'ignore', windowsHide: true })
  track(ch.pid)
  const up = await waitFor(async () => (await portOpen(apiPort, 400)) && !!gchildRecord(c, apiPort), 20000, 400)
  const pApi = dummyPids(c, apiPort)
  const dummies = allDummyPids(c, PORTS)
  for (const p of dummies) track(p)
  cx.extraPids = dummies
  rec(name, '前置：三代 dummy 已就位（启动器 + 监听 worker + 孙进程）', up.ok && dummies.length === 3, JSON.stringify(pApi))

  // 令牌文件完全按插件的格式写：services 里登记的是**启动器** pid（与 host.mjs 一致）
  const token = 'fallback-port-' + Date.now()
  writeRawToken(c, {
    token, epoch: 1, dshPid: process.pid, watchdogPid: 0, updatedAt: new Date().toISOString(),
    services: [{ key: 'api', pid: pApi.launcher, port: apiPort }],
  }, null)
  // 杀掉启动器（模拟"强杀 DSH 时启动器随父同刻死"），**不带 /T** ⇒ detached 的 worker/孙进程活下来
  killPidOnly(pApi.launcher, '制造启动器已死的形状')
  await sleep(900)
  rec(name, '★★★ 前置：登记的启动器已死（对它 taskkill 只会"找不到进程"），占端口的是它的 worker',
    !pidAlive(pApi.launcher) && pidAlive(pApi.worker) && (await portOpen(apiPort, 500)),
    '启动器存活=' + JSON.stringify([pApi.launcher].filter(pidAlive)) + '（应为空）'
    + '；worker 存活=' + JSON.stringify([pApi.worker].filter(pidAlive)))

  const wd = startWatchdogDirect(c, token, ['--no-descendants'])
  cx.wd = wd
  await sleep(1500)
  rec(name, '前置：看门狗已起来（--no-descendants：不做 PPID 链后代枚举）', pidAlive(wd.pid), 'watchdog pid=' + wd.pid)

  const t0 = Date.now()
  try { wd.stdin.end() } catch (e) { /* ignore */ }   // 主信号：stdin EOF ⇒ 触发回收
  const wdGone = await waitFor(() => !pidAlive(wd.pid), 40000, 400)
  rec(name, '看门狗自行退出', wdGone.ok, '耗时 ' + (Date.now() - t0) + 'ms')
  const lg = logText(c.voiceLog)
  rec(name, '★★ 端口持有者**没有被杀**（allowed 里不再有"未经校验的登记 pid" ⇒ 认不出 ⇒ 不杀）',
    pidAlive(pApi.worker) && (await portOpen(apiPort, 500)),
    'worker 存活=' + pidAlive(pApi.worker) + '；端口在听=' + (await portOpen(apiPort, 500)) + '（旧契约下这里会被树杀）')
  rec(name, '★ 日志如实写明"端口 … 的持有者 … 不在本代**已校验**的目标集内 → 不做任何操作（fail-safe）"',
    /不在本代\*\*已校验\*\*的目标集内/.test(lg),
    (lg.split('\n').filter((l) => l.includes('持有者')).slice(-2).join(' | ')).slice(0, 300))
  rec(name, '日志**没有**「确认属本代服务」（不再把未经校验的登记 pid 当所有权依据）',
    !/确认属本代服务/.test(lg), '出现次数=' + (lg.match(/确认属本代服务/g) || []).length)
  rec(name, '日志同时写明「登记启动器已不存在」与「--no-descendants 生效」',
    /进程已不存在/.test(lg) && /--no-descendants 生效/.test(lg), '')
  console.log('  --- 原始证据 ---')
  for (const l of lg.split('\n').filter((x) => x.includes('[watchdog]'))) console.log('    ' + l)
  await cleanup(c, cx)
  if (!KEEP) { try { rmSync(c.dir, { recursive: true, force: true }) } catch (e) { /* ignore */ } }
  return c
}

// ============================================================
// R-A（对应审查 ① / 审查者的 S6b 反例）：端口兜底**不得绕过 PID 复用闸门**
// ============================================================
// 构造：令牌匹配、登记 api pid=X；X **自己就监听登记端口**；令牌文件的 mtime 被显式设到 X 的
// 创建时间之前 6000ms（= "X 的现进程创建时间晚于令牌 mtime 5000ms 以上"，正是 pid 被复用的时间特征）。
// 期望：闸门（"拒绝回收 … 该 pid 已被复用"）生效后，端口兜底**不许**再把 X 认领回来杀掉。
// 未修版本在这里会自相矛盾：同一秒内先写"拒绝回收 … 该 pid 已被复用"，紧接着又写
// 「端口 … 的持有者 pid=X 确认属本代服务（登记集∪后代集）→ 树杀成功」⇒ X 被整树杀掉。
// variant: legacy-nodesc（--no-descendants，走祖先链那条路）/ legacy-desc（常规路径）/
//          control（同构造但 X **不监听**端口 ⇒ 端口兜底这条路过都没走，用来区分"凶手就是端口兜底"）
async function caseGateReuse(apiPort, bridgePort, variant) {
  const listen = variant !== 'control'
  const name = 'gate-reuse-' + variant
  const c = makeCaseDir(name)
  const cx = { ports: [apiPort], extraPids: [] }
  console.log('\n=== case ' + name + '（① 端口兜底 vs PID 复用闸门；登记进程'
    + (listen ? '**正在监听**登记端口' : '**不监听**登记端口 = 对照组') + '）===')
  console.log('  tmp=' + c.dir + '\n  端口=' + apiPort)
  writeConfig(c, apiPort, bridgePort)
  const d = await startSingleDummy(c, listen ? 'squat' : 'sleeper', apiPort, name)
  cx.extraPids = [d.pid]
  const listening0 = listen ? await portOpen(apiPort, 400) : false
  rec(name, '前置：登记 pid 进程已就位' + (listen ? '并监听 ' + apiPort : '（不监听任何端口）'),
    d.ok && pidAlive(d.pid) && (!listen || listening0),
    'pid=' + d.pid + ' created=' + new Date(d.createdMs).toISOString() + ' 监听=' + listening0)

  const token = 'gate-reuse-' + variant + '-' + Date.now()
  const mt = d.createdMs - 6000
  writeRawToken(c, {
    token, epoch: 1, dshPid: process.pid, watchdogPid: 0, updatedAt: new Date().toISOString(),
    services: [{ key: 'api', pid: d.pid, port: apiPort }],     // 故意**不写** createdMs：走"旧世代"退化判据
  }, { mtimeMs: mt })
  rec(name, '★★★ 前置（构造有效性）：令牌登记的就是这个 pid，且它的现进程比令牌文件新 6000ms（PID 复用特征）',
    d.createdMs > mt + 5000,
    '令牌 mtime=' + new Date(mt).toISOString() + '（utimesSync 显式设定）；现进程创建=' + new Date(d.createdMs).toISOString()
    + ' ⇒ 现进程比令牌新 ' + (d.createdMs - mt) + 'ms（大于旧 5000ms 窗口，也远大于收紧后的 1500ms）')

  const wd = startWatchdogDirect(c, token, ['--no-descendants', '--budget-ms', '5000'])
  cx.wd = wd
  await sleep(1500)
  rec(name, '前置：看门狗已起来（--no-descendants ⇒ 只剩"登记 pid + 端口兜底"两条路）', pidAlive(wd.pid), 'watchdog pid=' + wd.pid)

  const t0 = Date.now()
  try { wd.stdin.end() } catch (e) { /* ignore */ }
  const wdGone = await waitFor(() => !pidAlive(wd.pid), 40000, 400)
  rec(name, '看门狗在预算内收工退出', wdGone.ok, '耗时 ' + (Date.now() - t0) + 'ms')

  const alive = pidAlive(d.pid)
  rec(name, '★★★ X **没有被杀**（端口兜底不得绕过"该 pid 已被复用"这个闸门）', alive,
    'pid=' + d.pid + ' 存活=' + alive + (listen ? '（未修版本在这里会被整树杀掉）' : '（对照组：本来就不该被杀）'))
  const lg = logText(c.voiceLog)
  rec(name, '★ 日志出现「拒绝回收 api pid=X：该 pid 已被复用」', /拒绝回收 api pid=\d+：该 pid 已被复用/.test(lg),
    (lg.split('\n').filter((l) => l.includes('拒绝回收')).slice(-1).join('')).slice(0, 320))
  rec(name, '★★ 日志**不再出现**「确认属本代服务 … 树杀成功」（未修版本那两行自相矛盾的日志）',
    !/确认属本代服务/.test(lg) && !/树杀成功/.test(lg),
    '「确认属本代服务」出现次数=' + (lg.match(/确认属本代服务/g) || []).length
    + '；「树杀成功」出现次数=' + (lg.match(/树杀成功/g) || []).length)
  const portNow = await portOpen(apiPort, 500)
  rec(name, listen ? '端口仍被 X 占着（= 服务真没被杀；未修版本这里会是空闲）' : '对照组：端口本来就没有人监听（端口兜底这条路走都没走）',
    listen ? portNow : !portNow, 'portOpen(' + apiPort + ')=' + portNow)
  console.log('  --- 原始证据（看门狗日志全文）---')
  for (const l of lg.split('\n').filter((x) => x.includes('[watchdog]'))) console.log('    ' + l)
  await cleanup(c, cx)
  if (!KEEP) { try { rmSync(c.dir, { recursive: true, force: true }) } catch (e) { /* ignore */ } }
  return c
}

// ============================================================
// R-B（对应审查 ②）：进程查询不可用（降级）时**不许盲杀**
// ============================================================
// 用 --ps-exe 指向一个不存在的可执行文件，强制走"进程表拿不到"的降级分支（生产路径不传这个开关）。
// variant 'not-listening'：登记 pid 不监听登记端口 ⇒ **不许杀**（旧实现在这里直接盲杀）。
// variant 'listening'    ：登记 pid 确实在监听登记端口 ⇒ **必须杀**（端口交叉证实的正向路径）。
async function caseDegraded(apiPort, bridgePort, variant) {
  const listen = variant === 'listening'
  const name = 'degraded-' + variant
  const c = makeCaseDir(name)
  const cx = { ports: [apiPort], extraPids: [] }
  console.log('\n=== case ' + name + '（② 降级模式：进程表不可用；登记 pid '
    + (listen ? '**正在监听**登记端口 ⇒ 应被杀' : '**不监听**登记端口 ⇒ 不许杀') + '）===')
  console.log('  tmp=' + c.dir + '\n  端口=' + apiPort)
  writeConfig(c, apiPort, bridgePort)
  const d = await startSingleDummy(c, listen ? 'squat' : 'sleeper', apiPort, name)
  cx.extraPids = [d.pid]
  rec(name, '前置：登记 pid 进程已就位（' + (listen ? '监听 ' + apiPort : '不监听任何端口') + '）',
    d.ok && pidAlive(d.pid) && (!listen || (await portOpen(apiPort, 400))),
    'pid=' + d.pid + ' created=' + new Date(d.createdMs).toISOString())

  const token = 'degraded-' + variant + '-' + Date.now()
  writeRawToken(c, {
    token, epoch: 1, dshPid: process.pid, watchdogPid: 0, updatedAt: new Date().toISOString(),
    services: [{ key: 'api', pid: d.pid, port: apiPort, createdMs: d.createdMs, createdSrc: 'test' }],
  }, { mtimeMs: Date.now() })

  const bogusPs = path.join(c.dir, 'no-such-powershell.exe')     // 保证不存在 ⇒ psExec 返回 null
  const wd = startWatchdogDirect(c, token, ['--ps-exe', bogusPs, '--budget-ms', '5000'])
  cx.wd = wd
  await sleep(1500)
  rec(name, '前置：看门狗已起来（--ps-exe 指向不存在的 ' + bogusPs + ' ⇒ 强制降级）', pidAlive(wd.pid), 'watchdog pid=' + wd.pid)

  const t0 = Date.now()
  try { wd.stdin.end() } catch (e) { /* ignore */ }
  const wdGone = await waitFor(() => !pidAlive(wd.pid), 40000, 400)
  rec(name, '看门狗在预算内收工退出', wdGone.ok, '耗时 ' + (Date.now() - t0) + 'ms')
  const lg = logText(c.voiceLog)
  rec(name, '★ 日志写明"进程查询不可用 … **已降级**：只杀能被端口持有者交叉证实的登记 pid"',
    /进程查询不可用/.test(lg) && /已降级/.test(lg) && /只杀/.test(lg),
    (lg.split('\n').filter((l) => l.includes('降级')).slice(0, 2).join(' | ')).slice(0, 320))

  if (listen) {
    rec(name, '★★★ 确实在监听登记端口的登记 pid **被杀掉**（降级时只杀端口可证实的）', !pidAlive(d.pid),
      'pid=' + d.pid + ' 存活=' + pidAlive(d.pid))
    rec(name, '★ 日志写明"（降级：已被端口 … 的持有者交叉证实）→ 树杀成功"',
      /降级：已被端口 \d+ 的持有者交叉证实/.test(lg) && /树杀成功/.test(lg),
      (lg.split('\n').filter((l) => l.includes('树杀成功')).slice(0, 1).join('')).slice(0, 320))
    const clr = await waitFor(async () => !(await portOpen(apiPort, 400)), 10000, 400)
    rec(name, '端口随之空闲', clr.ok, 'portOpen(' + apiPort + ')=' + (await portOpen(apiPort, 400)))
  } else {
    rec(name, '★★★ 不监听登记端口的登记 pid **没有被杀**（降级时不许盲杀；未修版本这里会盲杀）',
      pidAlive(d.pid), 'pid=' + d.pid + ' 存活=' + pidAlive(d.pid))
    rec(name, '★ 日志写明"降级模式：api pid=X 不是端口 P 的持有者（无人在听该端口）⇒ fail-safe 跳过（不杀）"',
      /降级模式：api pid=\d+ 不是端口 \d+ 的持有者/.test(lg) && /fail-safe 跳过（不杀）/.test(lg),
      (lg.split('\n').filter((l) => l.includes('降级模式')).slice(0, 1).join('')).slice(0, 320))
    rec(name, '★ 日志里一点都没动手（没有「树杀成功」、没有「树杀失败」）',
      !/树杀成功/.test(lg) && !/树杀失败/.test(lg),
      '「树杀成功」次数=' + (lg.match(/树杀成功/g) || []).length)
  }
  console.log('  --- 原始证据（看门狗日志全文）---')
  for (const l of lg.split('\n').filter((x) => x.includes('[watchdog]'))) console.log('    ' + l)
  await cleanup(c, cx)
  if (!KEEP) { try { rmSync(c.dir, { recursive: true, force: true }) } catch (e) { /* ignore */ } }
  return c
}

// ============================================================
// R-C（对应审查 ③）：PID 复用闸门 = **创建时间身份校验**，不再是时间启发式
// ============================================================
// 令牌里带 createdMs（host.mjs 现在会写这个字段，口径同 psProcTree）：
//   mismatch：令牌记录的 createdMs 与现进程相差 30000ms（>2s）⇒ 判 pid 复用 ⇒ **不许杀**
//   match   ：相差 800ms（≤2s）⇒ 按正常路径处理 ⇒ 杀掉
// 两个 variant 的令牌 mtime 都设在"当下"，所以**旧的时间启发式不会拒绝它** —— 差异只来自身份字段，
// 于是 mismatch 在未修版本上必然被杀（FAIL），在修好版上必然不杀（PASS）。
async function caseCreatedMsIdentity(apiPort, bridgePort, variant) {
  const mismatch = variant === 'mismatch'
  const name = 'createdms-' + variant
  const c = makeCaseDir(name)
  const cx = { ports: [apiPort], extraPids: [] }
  console.log('\n=== case ' + name + '（③ createdMs 身份校验；令牌与现进程相差 '
    + (mismatch ? '30000ms > 2s ⇒ 不许杀' : '800ms ≤ 2s ⇒ 正常路径杀掉') + '）===')
  console.log('  tmp=' + c.dir + '\n  端口=' + apiPort)
  writeConfig(c, apiPort, bridgePort)
  const d = await startSingleDummy(c, 'squat', apiPort, name)
  cx.extraPids = [d.pid]
  rec(name, '前置：登记 pid 正在监听 ' + apiPort, d.ok && pidAlive(d.pid) && (await portOpen(apiPort, 400)),
    'pid=' + d.pid + ' created=' + new Date(d.createdMs).toISOString())

  const token = 'createdms-' + variant + '-' + Date.now()
  const recMs = mismatch ? d.createdMs + 30000 : d.createdMs + 800
  const mt = Date.now()
  writeRawToken(c, {
    token, epoch: 1, dshPid: process.pid, watchdogPid: 0, updatedAt: new Date().toISOString(),
    services: [{ key: 'api', pid: d.pid, port: apiPort, createdMs: recMs, createdSrc: 'test' }],
  }, { mtimeMs: mt })
  rec(name, '★★★ 前置（构造有效性）：令牌 mtime 就在当下（时间启发式**不会**拒绝它），差异只来自 createdMs',
    Math.abs(recMs - d.createdMs) === (mismatch ? 30000 : 800),
    '令牌 createdMs=' + new Date(recMs).toISOString() + ' vs 现进程=' + new Date(d.createdMs).toISOString()
    + ' ⇒ 相差 ' + Math.abs(recMs - d.createdMs) + 'ms；令牌 mtime=' + new Date(mt).toISOString())

  const wd = startWatchdogDirect(c, token, ['--budget-ms', '5000'])
  cx.wd = wd
  await sleep(1500)
  rec(name, '前置：看门狗已起来（常规路径：带 PPID 链后代枚举）', pidAlive(wd.pid), 'watchdog pid=' + wd.pid)

  const t0 = Date.now()
  try { wd.stdin.end() } catch (e) { /* ignore */ }
  const wdGone = await waitFor(() => !pidAlive(wd.pid), 40000, 400)
  rec(name, '看门狗自行退出', wdGone.ok, '耗时 ' + (Date.now() - t0) + 'ms')
  const lg = logText(c.voiceLog)
  if (mismatch) {
    rec(name, '★★★ 相差 30000ms ⇒ 判为 pid 复用，**没有被杀**', pidAlive(d.pid),
      'pid=' + d.pid + ' 存活=' + pidAlive(d.pid) + '（未修版本忽略 createdMs ⇒ 会被杀）')
    rec(name, '★ 日志写明「拒绝回收 … 现进程创建于 … 令牌记录的是 … 相差 30000ms > 2s」',
      /拒绝回收 api pid=\d+：该 pid 已被复用/.test(lg) && /相差 30000ms > 2s/.test(lg),
      (lg.split('\n').filter((l) => l.includes('拒绝回收')).slice(-1).join('')).slice(0, 360))
    rec(name, '★ 端口仍被占着（= 服务真没被杀）', await portOpen(apiPort, 500), 'portOpen(' + apiPort + ')=true')
    rec(name, '日志没有「确认属本代服务」（端口兜底同样不许认领它）', !/确认属本代服务/.test(lg), '')
  } else {
    rec(name, '★★★ 相差 800ms ≤ 2s ⇒ 按正常路径处理，**被杀掉**', !pidAlive(d.pid),
      'pid=' + d.pid + ' 存活=' + pidAlive(d.pid) + '（身份匹配 ⇒ 不该被过度拦截）')
    rec(name, '★ 日志写明「树杀成功」（身份校验没把正常情况误拦）', /树杀成功/.test(lg) && !/拒绝回收/.test(lg),
      (lg.split('\n').filter((l) => l.includes('树杀成功')).slice(0, 1).join('')).slice(0, 320))
    const clr = await waitFor(async () => !(await portOpen(apiPort, 400)), 10000, 400)
    rec(name, '端口随之空闲', clr.ok, 'portOpen(' + apiPort + ')=' + (await portOpen(apiPort, 400)))
  }
  console.log('  --- 原始证据（看门狗日志全文）---')
  for (const l of lg.split('\n').filter((x) => x.includes('[watchdog]'))) console.log('    ' + l)
  await cleanup(c, cx)
  if (!KEEP) { try { rmSync(c.dir, { recursive: true, force: true }) } catch (e) { /* ignore */ } }
  return c
}

// ============================================================
// R-D（对应审查 ④）：优雅停止后**有界端口复核** —— 端口仍在听就不许把看门狗收摊
// ============================================================
// 构造：假 DSH 里的 subprocess 句柄用 --terminate-launcher-only 1 ⇒ terminate() 只杀启动器（不带 /T），
// 已经 detached 的 worker 继续占着端口（= 审查担心的"terminate 只终结了启动器"那种退化情形；
// 本用例测的是**插件对这种情况的反应**，不是在断言真实 DSH 一定这么干）。
// 期望：survivors 为空但端口还在听 ⇒ ① 不收摊看门狗；② 令牌不置失效；③ 如实报"未能停掉（端口仍在监听）"。
async function caseStopPortRecheck(apiPort, bridgePort) {
  const name = 'stop-port-recheck'
  const c = makeCaseDir(name)
  const PORTS = [apiPort]
  const cx = { ports: PORTS, extraPids: [] }
  console.log('\n=== case stop-port-recheck（④ ?action=stop 时句柄退出但端口仍被占）===')
  console.log('  tmp=' + c.dir + '\n  端口=' + apiPort + '（单服务；terminate 只杀启动器、不带 /T）')
  writeConfig(c, apiPort, bridgePort)
  const d = startDriver(c, apiPort, bridgePort, 'stop-hold', { terminateLauncherOnly: true })
  cx.driver = d
  track(d.child.pid)
  const up = await waitFor(async () => {
    const a = svcRecord(c, apiPort)
    const ga = gchildRecord(c, apiPort)
    return !!a && !!ga && (await portOpen(apiPort, 400))
  }, 60000, 500)
  d.flush()
  const pApi = dummyPids(c, apiPort)
  const dummies = allDummyPids(c, PORTS)
  for (const p of dummies) track(p)
  cx.extraPids = dummies
  rec(name, '前置：三代 dummy 已就位（启动器 + 监听 worker + 孙进程）', up.ok && dummies.length === 3, JSON.stringify(pApi))
  const wdWait = await waitForWatchdog(c, 20000)
  const wds = wdWait.wds
  track(wds.length > 0 ? wds[0].pid : 0)
  const wdPid0 = wds.length > 0 ? wds[0].pid : 0
  rec(name, '前置：看门狗进程确实活着（否则本 case 会"空过"）', wds.length === 1,
    wds.length > 0 ? pidDesc(wdPid0) : ('等待 ' + wdWait.ms + 'ms 仍未就位；' + wdDiag(c)))

  const stopped = await waitFor(() => existsSync(path.join(c.dir, 'driver-stop.json')), 30000, 400)
  rec(name, 'driver 调用了 ?action=stop 并拿到响应', stopped.ok,
    stopped.ok ? logText(path.join(c.dir, 'driver-stop.json')).replace(/\s+/g, ' ').slice(0, 260) : '（超时）')
  const launcherGone = await waitFor(() => !pidAlive(pApi.launcher), 8000, 400)
  rec(name, '★★★ 前置（构造有效性）：被 terminate 的启动器已死，但 detached worker 仍占着端口',
    launcherGone.ok && pidAlive(pApi.worker) && (await portOpen(apiPort, 500)),
    '启动器存活=' + pidAlive(pApi.launcher) + '（应为 false）；worker 存活=' + pidAlive(pApi.worker)
    + '；端口在听=' + (await portOpen(apiPort, 500)))

  await sleep(1500)     // 给插件时间把 stop 路径走完（含 ≤3s 的有界端口复核）
  const wdNow = findWatchdogs(c.tokenFile)
  rec(name, '★★ 停止之后看门狗**仍然活着**（没有被收摊；未修版本会在这里被杀掉）',
    wdNow.length === 1 && wdNow[0].pid === wdPid0,
    '停止前 pid=' + wdPid0 + '；停止后=' + JSON.stringify(wdNow.map((x) => x.pid)) + '（' + wdDiag(c) + '）')
  const tok = readJson(c.tokenFile)
  rec(name, '★ 令牌文件**没有被置为失效态**（token 不是 null）⇒ 残留看门狗醒来仍按本代 token 判归属',
    !!(tok && tok.token), tok ? JSON.stringify(tok).slice(0, 240) : '（令牌文件不存在）')
  const resp = readJson(path.join(c.dir, 'driver-stop.json'))
  rec(name, '★★ 停止响应如实报"未能停掉（端口仍在监听）"（phase=failed + detail 带端口）',
    !!(resp && resp.phase === 'failed' && /端口仍在监听/.test(String(resp.detail || ''))),
    resp ? ('phase=' + resp.phase + ' detail=' + String(resp.detail).slice(0, 200)) : '（无响应）')
  const lg = logText(c.voiceLog)
  rec(name, '★★ 语音日志同样如实记录「★ 未能停掉（端口仍在监听）：api:' + apiPort + '」', /未能停掉（端口仍在监听）：api:/.test(lg),
    (lg.split('\n').filter((l) => l.includes('未能停掉')).slice(-1).join('')).slice(0, 260))
  rec(name, '★ 日志写明"看门狗保持运行"', /看门狗保持运行/.test(lg), '')
  const said = lg.includes('已停止看门狗')
  rec(name, '★ 日志**没有**「已停止看门狗」（不许假装收工）', !said,
    '「已停止看门狗」出现次数=' + (lg.match(/已停止看门狗/g) || []).length)
  console.log('  --- 原始证据 ---')
  for (const l of lg.split('\n').filter((x) => x.includes('[watchdog]') || x.includes('未能停掉') || x.includes('已停止'))) console.log('    ' + l)
  console.log('  driver 关键行:')
  for (const l of d.out.join('').split('\n').filter((x) => x.includes('taskkill') || x.includes('STOP-RESPONSE'))) console.log('    ' + l.slice(0, 300))
  await cleanup(c, cx)
  if (!KEEP) { try { rmSync(c.dir, { recursive: true, force: true }) } catch (e) { /* ignore */ } }
  return c
}

// ③ 的 host 侧端到端验证：令牌里记的 createdMs 必须与**该进程真实的** CreationDate 很接近
// （看门狗是拿自己 psProcTree 查到的 createdMs 与它比；两边差太多 ⇒ 身份校验会误判）。
// 同时钉住"锚点来源 = spawn 时刻、**不**在 DSH 进程里起 powershell"这个实测结论。
async function caseCreatedMsToken(apiPort, bridgePort) {
  const name = 'createdms-token'
  const c = makeCaseDir(name)
  const PORTS = [apiPort]
  const cx = { ports: PORTS, extraPids: [] }
  console.log('\n=== case createdms-token（③ host 侧：令牌 createdMs 锚点 vs 真实 CreationDate ≤2s）===')
  console.log('  tmp=' + c.dir)
  writeConfig(c, apiPort, bridgePort)
  const d = startDriver(c, apiPort, bridgePort, 'idle')
  cx.driver = d
  track(d.child.pid)
  const up = await waitFor(async () => {
    const a = svcRecord(c, apiPort)
    const ga = gchildRecord(c, apiPort)
    return !!a && !!ga && (await portOpen(apiPort, 400))
  }, 60000, 500)
  d.flush()
  const pApi = dummyPids(c, apiPort)
  const dummies = allDummyPids(c, PORTS)
  for (const p of dummies) track(p)
  cx.extraPids = dummies
  rec(name, '前置：三代 dummy 已就位（启动器 + 监听 worker + 孙进程）', up.ok && dummies.length === 3, JSON.stringify(pApi))
  const wdWait = await waitForWatchdog(c, 20000)
  const wds = wdWait.wds
  track(wds.length > 0 ? wds[0].pid : 0)
  rec(name, '前置：看门狗进程确实活着', wds.length === 1,
    wds.length > 0 ? pidDesc(wds[0].pid) : ('等待 ' + wdWait.ms + 'ms 仍未就位；' + wdDiag(c)))

  // ③ host 侧的关键判据：令牌里的 createdMs（锚点）与**该进程真实的** CreationDate 必须很接近 ——
  // 看门狗就是拿自己 psProcTree 查到的 createdMs 与它比、相差 >2s 判"pid 已复用"，
  // 两边差得太多会让身份校验误判（要么误杀，要么漏杀）。
  const tok = readJson(c.tokenFile)
  const svc = tok && Array.isArray(tok.services) ? tok.services[0] : null
  const info = pApi.launcher ? psInfo([pApi.launcher]).get(pApi.launcher) : undefined
  const realMs = info ? Number(info.createdMs) || 0 : 0
  const deltaMs = svc && realMs > 0 ? Math.abs(Number(svc.createdMs) - realMs) : -1
  rec(name, '★ 令牌里的 services[0] 带 createdMs/createdSrc（③ 要求 host 在令牌里写下创建时间锚点）',
    !!(svc && Number(svc.createdMs) > 0 && svc.createdSrc === 'spawn'),
    tok ? JSON.stringify(tok.services) : '（令牌文件不存在）')
  rec(name, '★★★ 令牌里的 createdMs 与该进程真实 CreationDate **相差 ≤2s**（身份判据成立）',
    deltaMs >= 0 && deltaMs <= 2000,
    '令牌 createdMs=' + msStr(svc && svc.createdMs)
    + ' vs 测试侧 psInfo 实测=' + msStr(realMs)
    + '；实测相差=' + deltaMs + 'ms（看门狗容忍窗 2000ms）')
  rec(name, '★ 登记的就是插件自己 spawn 的那个启动器 pid、端口是本代 api 端口（所有权仍来自活句柄）',
    !!svc && Number(svc.pid) === Number(pApi.launcher) && Number(svc.port) === apiPort,
    '登记 pid=' + (svc ? svc.pid : 'n/a') + '（svc 记录里的启动器=' + pApi.launcher + '）；端口=' + (svc ? svc.port : 'n/a'))
  rec(name, '★ createdSrc 只能是 "spawn"（**不**在 DSH 进程里起 powershell 查 CreationDate：那会把事件循环卡住 300~700ms）',
    !!svc && svc.createdSrc === 'spawn', 'createdSrc=' + (svc ? svc.createdSrc : 'n/a'))
  console.log('  --- 原始证据 ---')
  console.log('  令牌文件: ' + JSON.stringify(tok))
  for (const l of logText(c.voiceLog).split('\n').filter((x) => x.includes('[watchdog]'))) console.log('    ' + l)
  await cleanup(c, cx)
  if (!KEEP) { try { rmSync(c.dir, { recursive: true, force: true }) } catch (e) { /* ignore */ } }
  return c
}
// Minor-M3（顺手）：看门狗是 detached 起的，若 cwd 用了可被 SAKIKO_ROOT 覆盖的 ROOT，
// 配错（目录不存在）就会 spawn ENOENT ⇒ **静默失去整个看门狗**。改用 MODULE_DIR 后，
// 即使 SAKIKO_ROOT 指向不存在的目录，看门狗照样起得来。
async function caseWatchdogCwd(apiPort, bridgePort) {
  const name = 'watchdog-cwd'
  const c = makeCaseDir(name)
  const PORTS = [apiPort]
  const cx = { ports: PORTS, extraPids: [] }
  const bogusRoot = path.join(c.dir, 'nonexistent-root')     // 故意不存在
  console.log('\n=== case watchdog-cwd（Minor：SAKIKO_ROOT 配错 ⇒ 看门狗仍必须起得来）===')
  console.log('  tmp=' + c.dir + '\n  SAKIKO_ROOT=' + bogusRoot + '（不存在的目录）')
  writeConfig(c, apiPort, bridgePort)
  const d = startDriver(c, apiPort, bridgePort, 'idle', { sakikoRoot: bogusRoot })
  cx.driver = d
  track(d.child.pid)
  const up = await waitFor(async () => {
    const a = svcRecord(c, apiPort)
    const ga = gchildRecord(c, apiPort)
    return !!a && !!ga && (await portOpen(apiPort, 400))
  }, 60000, 500)
  d.flush()
  const dummies = allDummyPids(c, PORTS)
  for (const p of dummies) track(p)
  cx.extraPids = dummies
  rec(name, '前置：SAKIKO_ROOT 指向不存在的目录时，插件仍把 api 拉起来了（否则本 case 无效）',
    up.ok && dummies.length === 3, 'dummy=' + JSON.stringify(dummyPids(c, apiPort)))
  const token = readJson(c.tokenFile)
  const wdWait = await waitForWatchdog(c, 20000)
  const wds = wdWait.wds
  track(wds.length > 0 ? wds[0].pid : 0)
  rec(name, '★★ 看门狗**确实被拉起来了**（token.watchdogPid>0 且进程活着，cmd 指向 watchdog.mjs）',
    wds.length === 1, 'token.watchdogPid=' + (token ? token.watchdogPid : 'n/a')
    + (wds.length > 0 ? '；' + pidDesc(wds[0].pid) : '（等待 ' + wdWait.ms + 'ms 仍没找到；' + wdDiag(c) + '）'))
  const lg = logText(c.voiceLog)
  rec(name, '★ 日志里没有"看门狗出错 / 拉起看门狗失败"', !/看门狗出错|拉起看门狗失败/.test(lg),
    (lg.split('\n').filter((l) => l.includes('看门狗')).slice(-2).join(' | ')).slice(0, 300))
  console.log('  --- 原始证据 ---')
  for (const l of lg.split('\n').filter((x) => x.includes('[watchdog]'))) console.log('    ' + l)
  await cleanup(c, cx)
  if (!KEEP) { try { rmSync(c.dir, { recursive: true, force: true }) } catch (e) { /* ignore */ } }
  return c
}

// ---------------- main ----------------
async function main() {
  console.log('看门狗测试开始')
  console.log('  plugin   = ' + PLUGIN)
  console.log('  watchdog = ' + path.join(PLUGIN, 'watchdog.mjs') + (existsSync(path.join(PLUGIN, 'watchdog.mjs')) ? '（存在）' : '（不存在）'))
  console.log('  结果目录 = ' + OUT_ROOT)
  mkdirSync(OUT_ROOT, { recursive: true })
  const apiPort = await freePort(API_PORT_WANT)
  const bridgePort = await freePort(BRIDGE_PORT_WANT)
  console.log('  临时端口 = ' + apiPort + ' / ' + bridgePort)
  const t0 = Date.now()
  if (CASE === 'all' || CASE === 'positive') await caseKillTree(apiPort, bridgePort, 'real-shape')
  if (CASE === 'all' || CASE === 'detached-launcher') await caseKillTree(apiPort, bridgePort, 'detached-launcher')
  if (CASE === 'all' || CASE === 'fallback-port') await caseFallbackPort(apiPort, bridgePort)
  if (CASE === 'all' || CASE === 'token-mismatch') await caseTokenMismatch(apiPort, bridgePort)
  if (CASE === 'all' || CASE === 'external') await caseExternal(apiPort, bridgePort)
  if (CASE === 'all' || CASE === 'graceful') await caseGraceful(apiPort, bridgePort)
  if (CASE === 'all' || CASE === 'log-append') await caseLogAppend(apiPort, bridgePort)
  // ↓ 2026-09-13 误杀类阻塞项（① ② ③ ④）与 Minor 的回归用例
  if (CASE === 'all' || CASE === 'gate-reuse-legacy-nodesc') await caseGateReuse(apiPort, bridgePort, 'legacy-nodesc')
  if (CASE === 'all' || CASE === 'gate-reuse-legacy-desc') await caseGateReuse(apiPort, bridgePort, 'legacy-desc')
  if (CASE === 'all' || CASE === 'gate-reuse-control') await caseGateReuse(apiPort, bridgePort, 'control')
  if (CASE === 'all' || CASE === 'degraded-not-listening') await caseDegraded(apiPort, bridgePort, 'not-listening')
  if (CASE === 'all' || CASE === 'degraded-listening') await caseDegraded(apiPort, bridgePort, 'listening')
  if (CASE === 'all' || CASE === 'createdms-mismatch') await caseCreatedMsIdentity(apiPort, bridgePort, 'mismatch')
  if (CASE === 'all' || CASE === 'createdms-match') await caseCreatedMsIdentity(apiPort, bridgePort, 'match')
  if (CASE === 'all' || CASE === 'stop-port-recheck') await caseStopPortRecheck(apiPort, bridgePort)
  if (CASE === 'all' || CASE === 'watchdog-cwd') await caseWatchdogCwd(apiPort, bridgePort)
  if (CASE === 'all' || CASE === 'createdms-token') await caseCreatedMsToken(apiPort, bridgePort)

  const failed = results.filter((r) => !r.ok)
  const survivors = liveFixturePids()
  const summary = {
    plugin: PLUGIN,
    watchdogPresent: existsSync(path.join(PLUGIN, 'watchdog.mjs')),
    apiPort, bridgePort,
    startedAt: new Date(t0).toISOString(),
    finishedAt: new Date().toISOString(),
    total: results.length,
    failed: failed.length,
    fixturePidsTracked: [...FIXTURE].sort((a, b) => a - b),
    survivors,
    results,
  }
  writeFileSync(path.join(OUT_ROOT, 'result-' + Date.now() + '.json'), JSON.stringify(summary, null, 2), 'utf8')
  console.log('\n================ 汇总 ================')
  for (const r of results) console.log((r.ok ? 'PASS  ' : 'FAIL  ') + r.case.padEnd(15) + ' ' + r.name)
  console.log('总计 ' + results.length + ' 条断言，失败 ' + failed.length + ' 条；plugin=' + PLUGIN)
  // 资源纪律 #1：结束前必须打印"仍存活的、属于本次测试的 pid 列表"，必须是空
  console.log('本测试登记过的进程 pid（' + FIXTURE.size + ' 个）：' + [...FIXTURE].sort((a, b) => a - b).join(','))
  console.log('★ 仍存活的、属于本次测试的 pid 列表：' + (survivors.length === 0 ? '（空 —— 无残留）' : survivors.join(',')))
  process.exit(failed.length === 0 && survivors.length === 0 ? 0 : 1)
}

main().catch((e) => { console.error('测试脚本自身异常:', e); process.exit(2) })
