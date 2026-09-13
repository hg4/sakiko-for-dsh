#!/usr/bin/env node
// ============================================================
// SAKIKO for DSH — 看门狗（watchdog）快回路测试
// ============================================================
// 用法（默认测**本仓库**的插件；跑 main 分支对照时用 --plugin 指到那份干净副本）：
//   node tools/test-watchdog.mjs [--plugin <插件目录>] [--case all|positive|token-mismatch|external|graceful]
//                                [--api-port 19880] [--bridge-port 18000] [--keep] [--out <结果目录>]
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
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
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
// 默认端口避开 19880/18000（验收台在用那一对），也避开真实服务端口 9880/8000
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

// 进程表（pid / ppid / 创建时间 ms / 命令行），用于证据与"确实是我起的"核对
function psTable() {
  if (!WIN) return new Map()
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    'Get-CimInstance Win32_Process | ForEach-Object {',
    "  $ct = ''",
    '  try { $ct = [string]$_.CreationDate.ToFileTimeUtc() } catch { }',
    '  $cl = [string]$_.CommandLine',
    '  $cl = $cl -replace "`r", \' \'',
    '  $cl = $cl -replace "`n", \' \'',
    "  '{0}|{1}|{2}|{3}' -f $_.ProcessId, $_.ParentProcessId, $ct, $cl",
    '}',
  ].join('\n')
  const b64 = Buffer.from(script, 'utf16le').toString('base64')
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', b64],
    { encoding: 'utf8', timeout: 20000, windowsHide: true, maxBuffer: 32 * 1024 * 1024 })
  const map = new Map()
  if (!r || typeof r.stdout !== 'string') return map
  for (const line of r.stdout.split(/\r?\n/)) {
    const p = line.split('|')
    if (p.length < 4) continue
    const pid = Number(p[0])
    if (!Number.isFinite(pid) || pid <= 0) continue
    const ft = Number(p[2])
    map.set(pid, {
      ppid: Number(p[1]) || 0,
      createdMs: Number.isFinite(ft) && ft > 0 ? (ft / 10000 - 11644473600000) : 0,
      cmd: p.slice(3).join('|'),
    })
  }
  return map
}

function pidDesc(pid) {
  const t = psTable()
  const i = t.get(pid)
  if (!i) return 'pid=' + pid + '(不存在)'
  return 'pid=' + pid + '(ppid=' + i.ppid + ', created=' + new Date(i.createdMs).toISOString() + ', cmd=' + i.cmd.slice(0, 120) + ')'
}

function killTree(pid) {
  if (!pid || !pidAlive(pid)) return
  if (WIN) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 10000, stdio: 'ignore' })
  else { try { process.kill(-pid, 'SIGKILL') } catch (e) { try { process.kill(pid, 'SIGKILL') } catch (e2) { /* ignore */ } } }
}

async function waitFor(fn, timeoutMs, stepMs) {
  const end = Date.now() + timeoutMs
  for (;;) {
    let v = false
    try { v = await fn() } catch (e) { v = false }
    if (v) return { ok: true, ms: timeoutMs - (end - Date.now()) }
    if (Date.now() >= end) return { ok: false, ms: timeoutMs }
    await sleep(stepMs || 250)
  }
}

function readJson(p) {
  try { return JSON.parse(readFileSync(p, 'utf8')) } catch (e) { return null }
}

function logText(p) {
  try { return readFileSync(p, 'utf8') } catch (e) { return '' }
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
  if (process.platform === 'win32') spawnChild('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
  else { try { process.kill(-pid, 'SIGKILL') } catch (e) { try { process.kill(pid, 'SIGKILL') } catch (e2) { } } }
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
  await sleep(1000)
  try {
    const r = await callVoice('')
    const j = JSON.parse(r.body)
    if (j.phase === 'ready') { ready = j; break }
    if (j.phase === 'external') { ready = j; break }
    if (j.phase === 'failed' && i > 20) { ready = j; break }
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

if (mode === 'stop') {
  const r = await callVoice('?action=stop')
  writeFileSync(tmpDir + '/driver-stop.json', r.body)
  process.stdout.write('STOP-RESPONSE ' + r.body.replace(/\s+/g, ' ').slice(0, 600) + '\n')
  await sleep(5000)
  process.exit(0)
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
  writeFileSync(path.join(voiceRoot, 'bridge_tts.py'), '# dummy\n', 'utf8')
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
    env: Object.assign({}, process.env, { DSH_HOME: c.dshHome, SAKIKO_ROOT: PLUGIN }),
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
  const t = psTable()
  const want = tokenFile.replace(/\//g, '\\').toLowerCase()
  const out = []
  for (const [pid, info] of t) {
    const cmd = info.cmd.replace(/\//g, '\\').toLowerCase()
    if (cmd.includes('watchdog.mjs') && cmd.includes(want)) out.push({ pid, cmd: info.cmd })
  }
  return out
}

// 诊断：列出命令行里带某个标记（本 case 的临时目录）的所有进程，以及端口持有者
function procsWithMarker(marker) {
  const t = psTable()
  const key = marker.replace(/\//g, '\\').toLowerCase()
  const out = []
  for (const [pid, info] of t) {
    if (info.cmd.replace(/\//g, '\\').toLowerCase().includes(key)) {
      out.push({ pid, ppid: info.ppid, cmd: info.cmd.replace(/\s+/g, ' ').slice(0, 150) })
    }
  }
  return out.sort((a, b) => a.pid - b.pid)
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

function dumpDiag(c, ports) {
  console.log('  --- 诊断：本 case 目录下的进程 ---')
  for (const p of procsWithMarker(c.dir)) console.log('    pid=' + p.pid + ' ppid=' + p.ppid + ' ' + p.cmd)
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
  if (ctxObj && ctxObj.driver && ctxObj.driver.child && pidAlive(ctxObj.driver.child.pid)) {
    killTree(ctxObj.driver.child.pid)
    await sleep(600)
  }
  if (ctxObj && ctxObj.wd && pidAlive(ctxObj.wd.pid)) killTree(ctxObj.wd.pid)
  for (const pid of (ctxObj && ctxObj.extraPids) || []) if (pidAlive(pid)) killTree(pid)
  for (const w of findWatchdogs(c.tokenFile)) killTree(w.pid)
  // 兜底：把本 case 目录下**所有**残留进程（含孙进程）按 pid 清掉
  for (const p of procsWithMarker(c.dir)) if (pidAlive(p.pid)) killTree(p.pid)
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
  const cx = { ports: [apiPort, bridgePort], extraPids: [] }
  console.log('\n=== case ' + name + '（' + (realShape
    ? 'R1\'：启动器随 DSH 同刻死亡 ⇒ 必须按 PPID 链回收后代'
    : 'R1：启动器仍活着 ⇒ 树杀活着的启动器') + '）===')
  console.log('  plugin=' + PLUGIN + '\n  tmp=' + c.dir + '\n  ports=' + apiPort + '/' + bridgePort
    + '\n  形状=' + (realShape ? '假DSH → 启动器(非detached,随父死) → worker(detached,监听) → 孙进程(detached)' : '假DSH → 启动器(detached) → worker(detached,监听) → 孙进程(detached)'))
  if (!(await portOpen(apiPort, 400)) && !(await portOpen(bridgePort, 400))) rec(name, '前置：临时端口空闲', true, '')
  else rec(name, '前置：临时端口空闲', false, '端口已被占用，测试无效')
  writeConfig(c, apiPort, bridgePort)
  const d = startDriver(c, apiPort, bridgePort, 'idle', { launcherDetached: !realShape })
  cx.driver = d

  const up = await waitFor(async () => {
    const a = svcRecord(c, apiPort); const b = svcRecord(c, bridgePort)
    const ga = gchildRecord(c, apiPort); const gb = gchildRecord(c, bridgePort)
    return !!a && !!b && !!ga && !!gb && (await portOpen(apiPort, 400)) && (await portOpen(bridgePort, 400))
  }, 60000, 500)
  d.flush()
  const pids = { api: dummyPids(c, apiPort), bridge: dummyPids(c, bridgePort) }
  const dummies = allDummyPids(c, [apiPort, bridgePort])
  cx.extraPids = dummies
  rec(name, '前置：两个 dummy 服务各三代进程都在（启动器 + 监听 worker + 常驻孙进程）',
    up.ok && dummies.length === 6, 'api=' + JSON.stringify(pids.api) + ' bridge=' + JSON.stringify(pids.bridge))

  const token = readJson(c.tokenFile)
  const wds = findWatchdogs(c.tokenFile)
  rec(name, '前置：令牌文件已生成且 services 登记了两个 pid', !!(token && token.token && token.services && token.services.length === 2),
    token ? JSON.stringify(token).slice(0, 300) : '（令牌文件不存在）')
  rec(name, '前置：看门狗进程确实活着（否则本 case 会"空过"）', wds.length === 1,
    wds.length > 0 ? pidDesc(wds[0].pid) : '（没有找到 watchdog.mjs 进程）')

  // ★ F2：验证插件真实的 spawn 形状（api: cwd=GPT-SoVITS-main + 相对 argv api.py；bridge: <voiceRoot>/bridge_tts.py + BRIDGE_PORT）
  //   注：driver-ready.json 是插件进入 ready 后才写的，端口通 ≠ 已 ready（可能还在 set_model），所以这里要等文件
  const drReady = await waitFor(() => existsSync(path.join(c.dir, 'driver-ready.json')), 30000, 300)
  const dr0 = readJson(path.join(c.dir, 'driver-ready.json'))
  const calls = (dr0 && dr0.ev && dr0.ev.spawnCalls) || []
  const apiCall = calls.find((x) => x.port === apiPort)
  const brCall = calls.find((x) => x.port === bridgePort)
  const apiOk = !!apiCall && /GPT-SoVITS-main$/.test(String(apiCall.cwd).replace(/[\\/]+$/, ''))
    && apiCall.argv[2] === 'api.py' && apiCall.argv.includes('-p') && apiCall.argv.includes(String(apiPort))
  const brOk = !!brCall && String(brCall.argv[2]).endsWith('bridge_tts.py') && brCall.BRIDGE_PORT === String(bridgePort)
  rec(name, '前置：复刻了真实的 spawn 形状（F2：api cwd=GPT-SoVITS-main + 裸 argv api.py；桥=<voiceRoot>/bridge_tts.py + BRIDGE_PORT）',
    drReady.ok && apiOk && brOk, 'api=' + JSON.stringify(apiCall) + ' bridge=' + JSON.stringify(brCall))

  // ---- 强杀假 DSH（不带 /T：模仿验收台的真实强杀方式 taskkill /F /PID <node>）----
  dumpDiag(c, [apiPort, bridgePort])
  const wdPid = wds.length > 0 ? wds[0].pid : 0
  const killAt = new Date()
  const t0 = Date.now()
  console.log('  >>> taskkill /F /PID ' + d.child.pid + '（' + killAt.toISOString() + '，**不带 /T**）')
  spawnSync('taskkill', ['/F', '/PID', String(d.child.pid)], { windowsHide: true, stdio: 'ignore', timeout: 10000 })
  const dshGone = await waitFor(() => !pidAlive(d.child.pid), 5000, 100)
  rec(name, '假 DSH 进程已被强杀', dshGone.ok, 'pid=' + d.child.pid + ' 消失耗时 ' + dshGone.ms + 'ms')

  // ★ 强杀后立刻取"形状快照"（此时看门狗还在查进程表，来不及动手）
  const shape = {
    launcherAlive: [pids.api.launcher, pids.bridge.launcher].filter((p) => p && pidAlive(p)),
    workerAlive: [pids.api.worker, pids.bridge.worker].filter((p) => p && pidAlive(p)),
    gchildAlive: [pids.api.grandchild, pids.bridge.grandchild].filter((p) => p && pidAlive(p)),
    watchdogAlive: pidAlive(wdPid),
    at: new Date().toISOString(),
    deltaMs: Date.now() - t0,
  }
  if (realShape) {
    rec(name, '★★★ 前置（核心判据）：登记的启动器**已随 DSH 同刻死亡**，而 worker/孙进程仍活着并占着端口',
      shape.launcherAlive.length === 0 && shape.workerAlive.length === 2 && shape.gchildAlive.length === 2,
      '强杀后 +' + shape.deltaMs + 'ms 快照：存活启动器=' + JSON.stringify(shape.launcherAlive)
      + '（必须为空），存活 worker=' + JSON.stringify(shape.workerAlive) + '，存活孙进程=' + JSON.stringify(shape.gchildAlive))
  } else {
    rec(name, '前置：启动器在回收时刻**仍然活着**（本 case 走的是"树杀活着的启动器"路径）',
      shape.launcherAlive.length === 2 && shape.workerAlive.length === 2 && shape.gchildAlive.length === 2,
      '强杀后 +' + shape.deltaMs + 'ms 快照：存活启动器=' + JSON.stringify(shape.launcherAlive) + '（应为 2 个）')
  }
  rec(name, '★★ 看门狗在假 DSH 被 taskkill /F 强杀后**仍然存活**（detached 生效，没被 job 收走）',
    shape.watchdogAlive && wdPid > 0,
    '看门狗 pid=' + wdPid + ' 在 ' + shape.at + ' 仍 alive=' + shape.watchdogAlive + '（其父 pid=' + d.child.pid + ' 已消失）')

  const clr = await waitFor(async () => !(await portOpen(apiPort, 400)) && !(await portOpen(bridgePort, 400)), 15000, 250)
  const elapsed = Date.now() - t0
  rec(name, '≤15s 内两个端口都空闲', clr.ok, clr.ok
    ? ('端口 ' + apiPort + '/' + bridgePort + ' 释放耗时 ' + elapsed + 'ms')
    : ('15s 内端口仍未释放：' + apiPort + '=' + (await portOpen(apiPort, 400)) + ' ' + bridgePort + '=' + (await portOpen(bridgePort, 400)) + '（等待超时 ' + elapsed + 'ms）'))
  const dead = await waitFor(() => dummies.every((p) => !pidAlive(p)), 15000, 200)
  rec(name, '≤15s 内整棵后代树（启动器+worker+孙进程 ×2 服务）全部消失', dead.ok && dummies.length === 6,
    'pids=' + dummies.join(',') + '；仍存活=' + dummies.filter(pidAlive).join(',') + '（空=全灭）')
  const wdGone = await waitFor(() => findWatchdogs(c.tokenFile).length === 0, 15000, 300)
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
  const cx = { ports: [apiPort, bridgePort], extraPids: [] }
  console.log('\n=== case token-mismatch（反例 A：令牌已被新一代改写 ⇒ 什么都不许杀）===')
  console.log('  tmp=' + c.dir)
  writeConfig(c, apiPort, bridgePort)
  const d = startDriver(c, apiPort, bridgePort, 'idle')
  cx.driver = d
  const up = await waitFor(async () => {
    const a = svcRecord(c, apiPort); const b = svcRecord(c, bridgePort)
    const ga = gchildRecord(c, apiPort); const gb = gchildRecord(c, bridgePort)
    return !!a && !!b && !!ga && !!gb && (await portOpen(apiPort, 400)) && (await portOpen(bridgePort, 400))
  }, 60000, 500)
  d.flush()
  const dummies = allDummyPids(c, [apiPort, bridgePort])
  cx.extraPids = dummies
  rec('token-mismatch', '前置：两个 dummy 服务（三代进程）已在监听', up.ok && dummies.length === 6,
    'api=' + JSON.stringify(dummyPids(c, apiPort)) + ' bridge=' + JSON.stringify(dummyPids(c, bridgePort)))
  const token = readJson(c.tokenFile)
  const wds = findWatchdogs(c.tokenFile)
  rec('token-mismatch', '前置：看门狗进程确实活着', wds.length === 1, wds.length ? pidDesc(wds[0].pid) : '（未找到）')

  // 模拟"新一代已经接管"：把令牌文件改写成另一个 token
  const forged = Object.assign({}, token, { token: 'forged-new-generation-' + Date.now(), updatedAt: new Date().toISOString() })
  writeFileSync(c.tokenFile, JSON.stringify(forged, null, 2), 'utf8')
  console.log('  >>> 令牌文件已被改写为 token=' + forged.token)

  const t0 = Date.now()
  spawnSync('taskkill', ['/F', '/PID', String(d.child.pid)], { windowsHide: true, stdio: 'ignore', timeout: 10000 })
  const wdGone = await waitFor(() => findWatchdogs(c.tokenFile).length === 0, 15000, 300)
  const hadWatchdog = wds.length === 1
  rec('token-mismatch', '看门狗在 ≤15s 内退出（读完令牌就收工）', wdGone.ok && hadWatchdog,
    hadWatchdog ? ('耗时 ' + (Date.now() - t0) + 'ms') : '（本 case 从未出现看门狗 ⇒ 该断言不成立）')
  await sleep(1500)   // 先让"启动器随假 DSH 同刻死亡"这件事发生完（那是 job 干的，不是看门狗）
  const aliveAfterKill = dummies.filter(pidAlive)
  await sleep(3000)   // 再等一会儿：若看门狗要误杀，这段时间足够它动手
  const aliveLater = dummies.filter(pidAlive)
  rec('token-mismatch', '★ 看门狗没杀任何进程：强杀后还活着的后代（worker/孙进程）3s 后依然全在',
    aliveLater.length >= 4 && aliveLater.length === aliveAfterKill.length
    && aliveLater.every((p) => aliveAfterKill.includes(p)),
    '强杀后存活=' + aliveAfterKill.join(',') + ' → 3s 后存活=' + aliveLater.join(',')
    + '（登记启动器已随 DSH 死亡，本就不该在存活集里）')
  rec('token-mismatch', '端口仍然被占（证明服务真的没被杀）',
    (await portOpen(apiPort, 500)) && (await portOpen(bridgePort, 500)), apiPort + '/' + bridgePort + ' 仍在监听')
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
  const cx = { ports: [apiPort, bridgePort], extraPids: [] }
  console.log('\n=== case external（反例 B：端口已被外来服务占用 ⇒ 不生成看门狗、不杀任何东西）===')
  console.log('  tmp=' + c.dir)
  const ext = await startExternalDummies(c, [apiPort, bridgePort])
  const dummies = allDummyPids(c, [apiPort, bridgePort])
  cx.extraPids = dummies
  rec('external', '前置：外来（非插件拉起）的 dummy 服务（三代进程）已在监听', ext.ok && dummies.length === 6,
    'api=' + JSON.stringify(dummyPids(c, apiPort)) + ' bridge=' + JSON.stringify(dummyPids(c, bridgePort)))
  writeConfig(c, apiPort, bridgePort)
  const d = startDriver(c, apiPort, bridgePort, 'idle')
  cx.driver = d
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
  rec('external', '★ 外来 dummy 服务（worker/孙进程）一个都没被杀', alive.length === 6 && dummies.length === 6, '存活=' + alive.join(','))
  // 连 driver 也一起杀掉，再确认外来服务仍然活着（真正的"非优雅退出也不误杀"）
  spawnSync('taskkill', ['/F', '/PID', String(d.child.pid)], { windowsHide: true, stdio: 'ignore', timeout: 10000 })
  await sleep(4000)
  const alive2 = dummies.filter(pidAlive)
  rec('external', '强杀假 DSH 之后外来服务依然活着（无看门狗 ⇒ 无任何回收动作）', alive2.length === 6, '存活=' + alive2.join(','))
  const lg = logText(c.voiceLog)
  rec('external', '日志里写明「检测到外部服务…不做任何操作」', /外部服务已在监听/.test(lg),
    (lg.split('\n').filter((l) => l.includes('外部服务')).slice(-1).join('')).slice(0, 300))
  console.log('  --- 原始证据 ---')
  console.log('  driver 输出: ' + c.driverOut)
  for (const l of logText(c.voiceLog).split('\n').filter((x) => x.includes('外部') || x.includes('[watchdog]'))) console.log('    ' + l)
  await cleanup(c, cx)
  if (!KEEP) { try { rmSync(c.dir, { recursive: true, force: true }) } catch (e) { /* ignore */ } }
  return c
}

async function caseGraceful(apiPort, bridgePort) {
  const c = makeCaseDir('graceful')
  const cx = { ports: [apiPort, bridgePort], extraPids: [] }
  console.log('\n=== case graceful（回归：?action=stop ⇒ 服务停掉 + 看门狗收摊 + 无孤儿）===')
  console.log('  tmp=' + c.dir)
  writeConfig(c, apiPort, bridgePort)
  const d = startDriver(c, apiPort, bridgePort, 'stop')
  cx.driver = d
  const up = await waitFor(async () => {
    const a = svcRecord(c, apiPort); const b = svcRecord(c, bridgePort)
    const ga = gchildRecord(c, apiPort); const gb = gchildRecord(c, bridgePort)
    return !!a && !!b && !!ga && !!gb && (await portOpen(apiPort, 400)) && (await portOpen(bridgePort, 400))
  }, 60000, 500)
  d.flush()
  const dummies = allDummyPids(c, [apiPort, bridgePort])
  cx.extraPids = dummies
  rec('graceful', '前置：两个 dummy 服务（三代进程）已在监听', up.ok && dummies.length === 6,
    'api=' + JSON.stringify(dummyPids(c, apiPort)) + ' bridge=' + JSON.stringify(dummyPids(c, bridgePort)))
  const wdsBefore = findWatchdogs(c.tokenFile)
  rec('graceful', '前置：看门狗进程确实活着', wdsBefore.length === 1, wdsBefore.length ? pidDesc(wdsBefore[0].pid) : '（未找到）')

  const stopped = await waitFor(() => existsSync(path.join(c.dir, 'driver-stop.json')), 30000, 300)
  rec('graceful', 'driver 调用了 ?action=stop 并拿到响应', stopped.ok, stopped.ok ? logText(path.join(c.dir, 'driver-stop.json')).replace(/\s+/g, ' ').slice(0, 240) : '（超时）')
  const t0 = Date.now()
  const clr = await waitFor(async () => !(await portOpen(apiPort, 400)) && !(await portOpen(bridgePort, 400)), 15000, 250)
  rec('graceful', '服务被停掉：两个端口空闲', clr.ok, clr.ok
    ? ('耗时 ' + (Date.now() - t0) + 'ms')
    : ('15s 内端口仍未释放：' + apiPort + '=' + (await portOpen(apiPort, 400)) + ' ' + bridgePort + '=' + (await portOpen(bridgePort, 400))))
  const dead = await waitFor(() => dummies.every((p) => !pidAlive(p)), 15000, 200)
  rec('graceful', '整棵后代树（启动器+worker+孙进程）全部消失（无孤儿）', dead.ok && dummies.length === 6,
    'pids=' + dummies.join(',') + '；仍存活=' + dummies.filter(pidAlive).join(',') + '（空=全灭）')
  const wdGone = await waitFor(() => findWatchdogs(c.tokenFile).length === 0, 15000, 300)
  const hadWatchdog = wdsBefore.length === 1
  rec('graceful', '看门狗已收摊（进程退出）', wdGone.ok && hadWatchdog,
    hadWatchdog ? ('耗时 ' + (Date.now() - t0) + 'ms') : '（本 case 从未出现看门狗 ⇒ 该断言不成立）')
  await waitFor(() => !pidAlive(d.child.pid), 20000, 300)
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
  const cx = { ports: [apiPort, bridgePort], extraPids: [] }
  console.log('\n=== case log-append（Minor：日志改 append + 1MB 轮转 ⇒ 重启后仍能取证上一代怎么退出的）===')
  console.log('  tmp=' + c.dir + '（两代假 DSH 共用同一个 DSH_HOME / 同一份日志）')
  writeConfig(c, apiPort, bridgePort)

  // ---- 第一代 ----
  const d1 = startDriver(c, apiPort, bridgePort, 'idle')
  const up1 = await waitFor(async () => !!svcRecord(c, apiPort) && !!svcRecord(c, bridgePort)
    && !!gchildRecord(c, apiPort) && !!gchildRecord(c, bridgePort), 60000, 500)
  const api1 = svcRecord(c, apiPort)
  const gen1Pids = allDummyPids(c, [apiPort, bridgePort])
  cx.extraPids = gen1Pids
  d1.flush()
  const marker1 = '已拉起 GPT-SoVITS api pid=' + (api1 ? api1.launcherPid : '?')
  const token1 = readJson(c.tokenFile)
  rec('log-append', '前置：第一代已拉起服务且日志落盘', up1.ok, marker1 + '；token=' + (token1 ? String(token1.token).slice(0, 8) : 'n/a'))
  spawnSync('taskkill', ['/F', '/PID', String(d1.child.pid)], { windowsHide: true, stdio: 'ignore', timeout: 10000 })
  await waitFor(() => gen1Pids.every((p) => !pidAlive(p)), 15000, 300)
  d1.stopFlush()
  const log1 = logText(c.voiceLog)
  rec('log-append', '前置：第一代的行确实写进了日志文件', log1.includes(marker1),
    '第一代 dshPid=' + d1.child.pid + '；文件长度=' + log1.length)

  // 本 case 只验证日志语义：第一代残留（未修版本里没有看门狗 ⇒ 服务成孤儿、端口仍被占）
  // 由**测试脚本自己**按 pid 清掉，否则第二代会被判成"外部服务"而不拉起，污染本 case 的前提。
  const leftOrphans = gen1Pids.filter(pidAlive)
  if (leftOrphans.length > 0) {
    console.log('  >>> 第一代残留孤儿（测试脚本自行清理，不代表被测插件的行为）：' + leftOrphans.join(','))
    for (const p of leftOrphans) killTree(p)
  }
  const clear1 = await waitFor(async () => !(await portOpen(apiPort, 400)) && !(await portOpen(bridgePort, 400)), 10000, 250)
  rec('log-append', '前置：第二代启动前两个端口都空闲（第一代已彻底清干净）', clear1.ok,
    clear1.ok ? 'ok' : ('端口仍被占：' + apiPort + '=' + (await portOpen(apiPort, 400)) + ' ' + bridgePort + '=' + (await portOpen(bridgePort, 400))))

  // 把日志预填到 >1MB，好让第二代的第一次写盘触发轮转
  appendFileSync(c.voiceLog, ('filler-to-exceed-rotation-threshold ' + 'x'.repeat(200) + '\n').repeat(5000), 'utf8')
  const sizeBefore = statSync(c.voiceLog).size
  console.log('  >>> 已把日志预填到 ' + sizeBefore + ' 字节（>1MB），然后启动第二代')

  // ---- 第二代（同一个 DSH_HOME）----
  const d2 = startDriver(c, apiPort, bridgePort, 'stop')
  cx.driver = d2
  const up2 = await waitFor(async () => !!svcRecord(c, apiPort) && !!svcRecord(c, bridgePort)
    && !!gchildRecord(c, apiPort) && !!gchildRecord(c, bridgePort), 60000, 500)
  d2.flush()
  const api2 = svcRecord(c, apiPort)
  rec('log-append', '前置：第二代（新进程）已拉起服务', up2.ok, '第二代 dshPid=' + d2.child.pid + '、api launcher=' + (api2 ? api2.launcherPid : '?'))
  await waitFor(() => existsSync(path.join(c.dir, 'driver-stop.json')), 30000, 300)
  await waitFor(() => !pidAlive(d2.child.pid), 20000, 300)
  d2.stopFlush()

  const log2 = logText(c.voiceLog)
  const rot = logText(c.voiceLog + '.1')
  const sizeAfter = (() => { try { return statSync(c.voiceLog).size } catch (e) { return 0 } })()
  rec('log-append', '★ 第一代的行在第二代起来之后仍然查得到（append 语义，不再被整份覆写）',
    rot.includes(marker1) || log2.includes(marker1),
    'marker=「' + marker1 + '」；.1 档里有=' + rot.includes(marker1) + '；主档里有=' + log2.includes(marker1))
  rec('log-append', '超过 1MB 时轮转出 .1（旧档保留一份）', rot.length > 0 && sizeAfter < sizeBefore,
    '.1 长度=' + rot.length + '；主档 ' + sizeBefore + ' → ' + sizeAfter + ' 字节')
  rec('log-append', '第二代自己的记录写进了主档（新档从本代开始）', log2.includes('已拉起 GPT-SoVITS api pid='),
    (log2.split('\n').filter((l) => l.length > 0).slice(0, 3).join(' | ')).slice(0, 300))
  console.log('  --- 原始证据 ---')
  console.log('  日志主档: ' + c.voiceLog + '（' + sizeAfter + ' 字节，前 3 行）')
  for (const l of log2.split('\n').filter((x) => x.length > 0).slice(0, 3)) console.log('    ' + l)
  console.log('  日志轮转档: ' + c.voiceLog + '.1' + '（' + rot.length + ' 字符）')
  for (const l of rot.split('\n').filter((x) => x.includes(marker1) || x.includes('[watchdog] 已拉起')).slice(0, 3)) console.log('    ' + l)
  await cleanup(c, cx)
  if (!KEEP) { try { rmSync(c.dir, { recursive: true, force: true }) } catch (e) { /* ignore */ } }
  return c
}

// 端口兜底单独验证（控制者要求）：登记的启动器**已死** + 关掉 PPID 链后代枚举 ⇒
// 只剩"按端口找持有者 → 用 ppid 链判定它属于本代（走到已死的启动器 pid 上）→ 树杀"这一条路。
async function caseFallbackPort(apiPort, bridgePort) {
  const name = 'fallback-port'
  const c = makeCaseDir(name)
  const cx = { ports: [apiPort, bridgePort], extraPids: [] }
  console.log('\n=== case fallback-port（只靠端口兜底：登记启动器已死 + --no-descendants）===')
  console.log('  tmp=' + c.dir)
  const launchers = []
  for (const p of [apiPort, bridgePort]) {
    const ch = spawn(process.execPath, [c.dummyScript, 'launcher', String(p), path.join(c.dir, 'svc-' + p + '.json')], { stdio: 'ignore', windowsHide: true })
    launchers.push(ch.pid)
  }
  const up = await waitFor(async () => {
    for (const p of [apiPort, bridgePort]) {
      if (!(await portOpen(p, 400))) return false
      if (!gchildRecord(c, p)) return false
    }
    return true
  }, 20000, 250)
  const pApi = dummyPids(c, apiPort)
  const pBr = dummyPids(c, bridgePort)
  const dummies = allDummyPids(c, [apiPort, bridgePort])
  cx.extraPids = dummies
  rec(name, '前置：两代/三代 dummy 已就位（启动器 + 监听 worker + 孙进程）', up.ok && dummies.length === 6, JSON.stringify(dummies))

  // 令牌文件完全按插件的格式写：services 里登记的是**启动器** pid（与 host.mjs 一致）
  const token = 'fallback-port-' + Date.now()
  mkdirSync(path.dirname(c.tokenFile), { recursive: true })
  writeFileSync(c.tokenFile, JSON.stringify({
    token, epoch: 1, dshPid: process.pid, watchdogPid: 0, updatedAt: new Date().toISOString(),
    services: [{ key: 'api', pid: pApi.launcher, port: apiPort }, { key: 'bridge', pid: pBr.launcher, port: bridgePort }],
  }, null, 2), 'utf8')
  // 杀掉两个启动器（模拟"强杀 DSH 时启动器随父同刻死"），不带 /T ⇒ detached 的 worker/孙进程活下来
  for (const pid of launchers) spawnSync('taskkill', ['/F', '/PID', String(pid)], { windowsHide: true, stdio: 'ignore', timeout: 10000 })
  await sleep(900)
  rec(name, '★★★ 前置：登记的启动器已死（对它 taskkill 只会"找不到进程"），占端口的是它的 worker',
    !pidAlive(pApi.launcher) && !pidAlive(pBr.launcher) && pidAlive(pApi.worker) && pidAlive(pBr.worker)
    && (await portOpen(apiPort, 500)) && (await portOpen(bridgePort, 500)),
    '启动器存活=' + JSON.stringify([pApi.launcher, pBr.launcher].filter(pidAlive)) + '（应为空）'
    + '；worker 存活=' + JSON.stringify([pApi.worker, pBr.worker].filter(pidAlive)))

  const wdScript = path.join(PLUGIN, 'watchdog.mjs')
  const wd = spawn(process.execPath, [
    wdScript, '--token', token, '--epoch', '1', '--dsh-pid', String(process.pid),
    '--token-file', c.tokenFile, '--log', c.voiceLog, '--no-descendants', '--poll-ms', '60000',
  ], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true, detached: true, cwd: c.dir })
  cx.wd = wd
  try { if (wd.stdin) wd.stdin.on('error', () => { /* EPIPE 无所谓 */ }) } catch (e) { /* ignore */ }
  await sleep(1500)
  rec(name, '前置：看门狗已起来（--no-descendants：只走端口兜底这条安全网）', pidAlive(wd.pid), 'watchdog pid=' + wd.pid)

  const t0 = Date.now()
  try { wd.stdin.end() } catch (e) { /* ignore */ }   // 主信号：stdin EOF ⇒ 触发回收
  const clr = await waitFor(async () => !(await portOpen(apiPort, 400)) && !(await portOpen(bridgePort, 400)), 15000, 250)
  const elapsed = Date.now() - t0
  rec(name, '≤15s 内端口空闲（登记 pid 已死、又不做后代枚举，只能靠端口兜底）', clr.ok, clr.ok
    ? ('释放耗时 ' + elapsed + 'ms')
    : ('15s 内仍未释放：' + apiPort + '=' + (await portOpen(apiPort, 400)) + ' ' + bridgePort + '=' + (await portOpen(bridgePort, 400)) + '（' + elapsed + 'ms）'))
  const dead = await waitFor(() => dummies.every((p) => !pidAlive(p)), 15000, 200)
  rec(name, 'worker 与孙进程全部消失（启动器本就已经死了）', dead.ok,
    'pids=' + dummies.join(',') + '；仍存活=' + dummies.filter(pidAlive).join(',') + '（空=全灭）')
  const wdGone = await waitFor(() => !pidAlive(wd.pid), 15000, 300)
  rec(name, '看门狗自行退出', wdGone.ok, '耗时 ' + (Date.now() - t0) + 'ms')
  const lg = logText(c.voiceLog)
  rec(name, '★★ 日志出现「端口 … 的持有者 pid=… 确认属本代服务（登记集∪后代集）→ 树杀成功」',
    /的持有者 pid=\d+ 确认属本代服务/.test(lg),
    (lg.split('\n').filter((l) => l.includes('持有者')).slice(-2).join(' | ')).slice(0, 300))
  rec(name, '日志同时写明「登记启动器已不存在」与「--no-descendants 生效」',
    /进程已不存在/.test(lg) && /--no-descendants 生效/.test(lg), '')
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

  const failed = results.filter((r) => !r.ok)
  const summary = {
    plugin: PLUGIN,
    watchdogPresent: existsSync(path.join(PLUGIN, 'watchdog.mjs')),
    apiPort, bridgePort,
    startedAt: new Date(t0).toISOString(),
    finishedAt: new Date().toISOString(),
    total: results.length,
    failed: failed.length,
    results,
  }
  writeFileSync(path.join(OUT_ROOT, 'result-' + Date.now() + '.json'), JSON.stringify(summary, null, 2), 'utf8')
  console.log('\n================ 汇总 ================')
  for (const r of results) console.log((r.ok ? 'PASS  ' : 'FAIL  ') + r.case.padEnd(15) + ' ' + r.name)
  console.log('总计 ' + results.length + ' 条断言，失败 ' + failed.length + ' 条；plugin=' + PLUGIN)
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((e) => { console.error('测试脚本自身异常:', e); process.exit(2) })
