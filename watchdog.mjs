#!/usr/bin/env node
// ============================================================
// SAKIKO for DSH — 语音服务「退出看门狗」（v2.1.0）
// ============================================================
// 解决的问题（2026-09-13 用户实测）：
//   插件用 ctx.subprocess 拉起 GPT-SoVITS api(默认 9880) 与语音桥(默认 8000)，
//   而这些服务的回收**只挂在 JS 的退出钩子上**（插件 disposer + subprocess 服务的
//   process.on('exit')）。点控制台窗口的 X、taskkill /F、DSH 崩溃时钩子根本不会跑
//   ⇒ python 服务变孤儿，端口一直被占，下次启动插件判成「外部服务、不接管」。
//
// 本文件是被 host.mjs 用 **node:child_process.spawn**（detached + stdio:['pipe','ignore','ignore']）
// 拉起的独立进程 —— 不用 ctx.subprocess，因为那一套恰好会在 DSH 退出钩子里被回收，
// 而看门狗必须**活得比 DSH 的退出钩子久**。
//
// 三个信号 / 三条规矩：
//   1) 主信号：stdin 管道 EOF。DSH 进程一旦消失，写端被 OS 关闭 ⇒ 看门狗读到 EOF。
//      比轮询 pid 可靠（不依赖 pid 还能不能被查到，也没有 PID 复用风险）。
//   2) 兜底信号：每 pollMs（默认 2.5s）process.kill(dshPid, 0)。
//   3) 所有权令牌：触发回收时**重新读**令牌文件，token 与本代相同才动手；
//      token 不同 / 文件不在 / 读不动 ⇒ **什么都不杀**（fail-safe：宁可漏杀，绝不误杀）。
//
// 接口契约（与 host.mjs 的约定，改一边必须改另一边）：
//   argv: --token <uuid> --epoch <n> --dsh-pid <pid> --token-file <path> --log <path>
//         [--poll-ms n] [--port-wait-ms n] [--final-wait-ms n] [--no-stdin]
//   令牌文件: {"token":<uuid|null>,"epoch":n,"dshPid":n,"watchdogPid":n,
//             "updatedAt":<iso>,"services":[{"key":"api"|"bridge","pid":n,"port":n}]}
//   日志: 追加到 --log 指定文件，每行前缀 "[HH:MM:SS] [watchdog] "
//
// 零新依赖（只用 node: 内置模块），Windows 优先；posix 分支为尽力实现（见 README「已实测范围」）。
import { appendFileSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname } from 'node:path'
import net from 'node:net'

const opt = (() => {
  const out = {
    token: '', epoch: 0, dshPid: 0, tokenFile: '', log: '',
    pollMs: 2500, portWaitMs: 4000, finalWaitMs: 2000, useStdin: true,
  }
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => argv[++i]
    if (a === '--token') out.token = String(next() || '')
    else if (a === '--epoch') out.epoch = Number(next()) || 0
    else if (a === '--dsh-pid') out.dshPid = Number(next()) || 0
    else if (a === '--token-file') out.tokenFile = String(next() || '')
    else if (a === '--log') out.log = String(next() || '')
    else if (a === '--poll-ms') out.pollMs = Math.max(200, Number(next()) || 2500)
    else if (a === '--port-wait-ms') out.portWaitMs = Math.max(0, Number(next()) || 0)
    else if (a === '--final-wait-ms') out.finalWaitMs = Math.max(0, Number(next()) || 0)
    else if (a === '--no-stdin') out.useStdin = false
  }
  return out
})()

const T0 = Date.now()
const HARD_DEADLINE = T0 + 14000      // 回收必须远快于 15s 上限；留 1s 余量
const WIN = process.platform === 'win32'

// ---------------- 日志（追加语义，绝不覆盖） ----------------
function short(t) { return (t === null || t === undefined || t === '') ? String(t) : String(t).slice(0, 8) }
function stamp() { return '[' + new Date().toISOString().slice(11, 19) + '] [watchdog] ' }
function wlog(line) {
  const msg = stamp() + line
  try { process.stdout.write(msg + '\n') } catch (e) { /* stdout 大概率是 NUL，忽略 */ }
  if (opt.log) {
    try {
      mkdirSync(dirname(opt.log), { recursive: true })
      appendFileSync(opt.log, msg + '\n', 'utf8')     // O_APPEND：与插件进程互不覆盖
    } catch (e) { /* 日志写不动不能影响回收 */ }
  }
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

// ---------------- 令牌文件 ----------------
function readTokenFile() {
  if (!opt.tokenFile) return { ok: false, why: '未传 --token-file' }
  let text = ''
  let mtimeMs = 0
  try {
    const st = statSync(opt.tokenFile)
    mtimeMs = st.mtimeMs
    text = readFileSync(opt.tokenFile, 'utf8')
  } catch (e) {
    return { ok: false, why: '读不到 ' + opt.tokenFile + '（' + (e && e.code ? e.code : String(e)) + '）' }
  }
  try {
    return { ok: true, data: JSON.parse(text), mtimeMs }
  } catch (e) {
    // 半截文件理论上不会出现（插件用临时文件 + rename 原子替换），真出现就当不可信
    return { ok: false, why: 'JSON 解析失败（' + (e && e.message ? e.message : String(e)) + '）' }
  }
}

// ---------------- 进程表（用于 PID 复用校验 + 后代判定） ----------------
// 返回 Map<pid, {ppid, createdMs, cmd}>；拿不到就返回 null（调用方按 unknown 处理）。
function procTable() {
  try { return WIN ? procTableWin() : procTablePosix() } catch (e) { return null }
}

function procTableWin() {
  // 用 -EncodedCommand 传脚本，彻底绕开 cmd/powershell 的引号地狱。
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
    { encoding: 'utf8', timeout: 8000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 })
  if (!r || typeof r.stdout !== 'string' || r.stdout.length === 0) return null
  const map = new Map()
  for (const line of r.stdout.split(/\r?\n/)) {
    const parts = line.split('|')
    if (parts.length < 4) continue
    const pid = Number(parts[0])
    if (!Number.isFinite(pid) || pid <= 0) continue
    const ft = Number(parts[2])
    // FILETIME(100ns since 1601) → ms since epoch
    const createdMs = Number.isFinite(ft) && ft > 0 ? (ft / 10000 - 11644473600000) : 0
    map.set(pid, { ppid: Number(parts[1]) || 0, createdMs, cmd: parts.slice(3).join('|') })
  }
  return map.size > 0 ? map : null
}

function procTablePosix() {
  // 尽力实现：Linux 有 /proc 就能做与 Windows 同样的校验；macOS 等无 /proc 时返回 null。
  let boot = 0
  try {
    const stat = readFileSync('/proc/stat', 'utf8')
    const m = stat.match(/^btime\s+(\d+)/m)
    if (m) boot = Number(m[1]) * 1000
  } catch (e) { return null }
  const hz = 100      // sysconf(_SC_CLK_TCK) 常规值；取不到就用 100（会带来 <10ms 误差，不影响判据）
  const map = new Map()
  let names = []
  try { names = readdirSync('/proc') } catch (e) { return null }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue
    try {
      const raw = readFileSync('/proc/' + name + '/stat', 'utf8')
      const close = raw.lastIndexOf(')')
      const rest = raw.slice(close + 2).split(' ')
      // 字段（1-based，去掉 pid/comm 后从 state 开始）：state=0, ppid=1, ..., starttime=19
      const ppid = Number(rest[1]) || 0
      const startTicks = Number(rest[19]) || 0
      map.set(Number(name), { ppid, createdMs: boot + Math.round((startTicks / hz) * 1000), cmd: '' })
    } catch (e) { /* 进程刚消失，跳过 */ }
  }
  return map.size > 0 ? map : null
}

function isDescendantOf(table, pid, roots) {
  let cur = pid
  for (let i = 0; i < 32 && cur > 0; i++) {
    if (roots.includes(cur)) return true
    const info = table.get(cur)
    if (info === undefined) return false
    cur = Number(info.ppid) || 0
  }
  return false
}

// ---------------- 杀进程 ----------------
function killTree(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return { ok: false, how: 'pid 非法' }
  if (pid === process.pid) return { ok: false, how: '拒绝自杀' }
  if (WIN) {
    const r = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'],
      { encoding: 'utf8', timeout: 8000, windowsHide: true })
    const out = String((r && (r.stdout || r.stderr)) || '').trim().replace(/\s+/g, ' ').slice(0, 160)
    return { ok: !!(r && r.status === 0), how: 'taskkill /PID ' + pid + ' /T /F' + (r && r.status === 0 ? '' : '（exit=' + (r ? r.status : '?') + ' ' + out + '）') }
  }
  let how = ''
  try { process.kill(-pid, 'SIGKILL'); how = 'kill(-' + pid + ', SIGKILL)（进程组）' }
  catch (e) {
    try { process.kill(pid, 'SIGKILL'); how = 'kill(' + pid + ', SIGKILL)（单进程）' }
    catch (e2) { return { ok: false, how: 'kill 失败：' + (e2 && e2.message ? e2.message : String(e2)) } }
  }
  // 进程组不一定等于进程树（服务是 DSH 的子进程，未必自成进程组）→ 补杀后代
  const t = procTable()
  if (t) {
    for (let round = 0; round < 3; round++) {
      let any = false
      for (const [p, info] of t) {
        if (isDescendantOf(t, p, [pid])) {
          try { process.kill(p, 'SIGKILL'); any = true } catch (e) { /* 已经没了 */ }
        }
      }
      if (!any) break
    }
  }
  return { ok: true, how }
}

// ---------------- 端口 ----------------
function portOpen(port, timeoutMs) {
  return new Promise((resolve) => {
    let done = false
    const sock = net.connect({ host: '127.0.0.1', port })
    const finish = (v) => {
      if (done) return
      done = true
      try { sock.destroy() } catch (e) { /* ignore */ }
      resolve(v)
    }
    sock.setTimeout(timeoutMs || 700)
    sock.once('connect', () => finish(true))
    sock.once('timeout', () => finish(false))
    sock.once('error', () => finish(false))
  })
}

async function waitPortsClear(ports, budgetMs) {
  const end = Date.now() + Math.max(0, budgetMs)
  for (;;) {
    const open = []
    for (const p of ports) if (await portOpen(p, 700)) open.push(p)
    if (open.length === 0) return []
    if (Date.now() >= end) return open
    await sleep(250)
  }
}

function portOwners(port) {
  if (WIN) {
    const r = spawnSync('netstat', ['-ano', '-p', 'tcp'],
      { encoding: 'utf8', timeout: 8000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 })
    const text = String((r && r.stdout) || '')
    const pids = new Set()
    for (const line of text.split(/\r?\n/)) {
      // 例：  TCP    127.0.0.1:9880    0.0.0.0:0    LISTENING    12345
      const m = line.trim().match(/^TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i)
      if (m && Number(m[1]) === port) pids.add(Number(m[2]))
    }
    return [...pids]
  }
  // posix 尽力：lsof → ss（都可能不存在，那就返回空 = 不做任何操作）
  for (const [cmd, args] of [['lsof', ['-ti', 'tcp:' + port, '-sTCP:LISTEN']], ['ss', ['-lptnH', 'sport = :' + port]]]) {
    try {
      const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 5000 })
      if (!r || r.status !== 0 || !r.stdout) continue
      const pids = new Set()
      for (const m of String(r.stdout).matchAll(/pid=(\d+)/g)) pids.add(Number(m[1]))
      if (pids.size === 0) for (const tok of String(r.stdout).split(/\s+/)) if (/^\d+$/.test(tok)) pids.add(Number(tok))
      if (pids.size > 0) return [...pids]
    } catch (e) { /* 试下一个 */ }
  }
  return []
}

// ---------------- 回收 ----------------
let fired = false

async function recover(reason) {
  const tf = readTokenFile()
  if (!tf.ok) {
    wlog('令牌文件不可用（' + tf.why + '）→ fail-safe：不杀任何进程，直接退出')
    return { action: 'fail-safe', why: tf.why }
  }
  const data = tf.data || {}
  if (data.token !== opt.token) {
    wlog('token 不匹配（文件 token=' + short(data.token) + '，本代 token=' + short(opt.token) + '；新一代已接管）→ 不做任何操作并退出')
    return { action: 'token-mismatch' }
  }
  const svcs = (Array.isArray(data.services) ? data.services : [])
    .filter((s) => s && Number(s.pid) > 0)
    .map((s) => ({ key: String(s.key || '?'), pid: Number(s.pid), port: Number(s.port) || 0 }))
  if (svcs.length === 0) {
    wlog('令牌匹配，但 services 为空（本代没有登记任何托管服务）→ 无事可做，退出')
    return { action: 'nothing-to-do' }
  }

  const table = procTable()
  if (table === null) wlog('进程表不可用（拿不到进程创建时间/命令行）→ 归属校验降级为「只看 token 匹配」')

  const killed = []
  const skipped = []
  for (const s of svcs) {
    if (table === null) {
      wlog('无法校验 ' + s.key + ' pid=' + s.pid + ' 的归属 → 按 token 匹配结果继续回收')
    } else {
      const info = table.get(s.pid)
      if (info === undefined) {
        wlog('登记项 ' + s.key + ' pid=' + s.pid + '：进程已不存在（无需回收）')
        skipped.push(s.key)
        continue
      }
      // PID 复用防护：本代服务一定**早于**最后一次写令牌文件（spawn 成功后才写）；
      // 若这个 pid 现在的进程比令牌文件还新，就说明原进程已死、pid 被系统复用 ⇒ 不碰。
      if (Number(info.createdMs) > 0 && tf.mtimeMs > 0 && Number(info.createdMs) > tf.mtimeMs + 5000) {
        wlog('拒绝回收 ' + s.key + ' pid=' + s.pid + '：该 pid 已被复用（现进程创建时间晚于本代令牌文件）→ fail-safe 跳过')
        skipped.push(s.key)
        continue
      }
    }
    const r = killTree(s.pid)
    killed.push(s.key + ' pid=' + s.pid)
    wlog('树杀 ' + s.key + ' pid=' + s.pid + '（' + r.how + '）')
  }

  const ports = [...new Set(svcs.map((s) => s.port).filter((p) => p > 0))]
  let open = []
  if (ports.length > 0) {
    const budget = Math.min(opt.portWaitMs, Math.max(0, HARD_DEADLINE - Date.now() - 3000))
    open = await waitPortsClear(ports, budget)
  }

  // 兜底：端口还在听 ⇒ 按端口找持有者。**但只杀「本代服务进程树里的」进程** ——
  // 端口被别人接手时（我们的服务已死、外部脚本占用同一端口）绝不动手。
  if (open.length > 0) {
    const again = readTokenFile()
    if (!again.ok || (again.data && again.data.token !== opt.token)) {
      wlog('端口复查前发现令牌已变化 → 停止后续动作（fail-safe）')
    } else {
      const t2 = procTable()
      const roots = svcs.map((s) => s.pid)
      for (const p of open) {
        const owners = portOwners(p)
        if (owners.length === 0) {
          wlog('端口 ' + p + ' 仍在监听，但查不到持有者 → 不做任何操作（fail-safe）')
          continue
        }
        for (const o of owners) {
          if (t2 !== null && isDescendantOf(t2, o, roots)) {
            const r2 = killTree(o)
            wlog('端口 ' + p + ' 仍被 pid=' + o + ' 监听，已确认它是本代托管服务的后代 → 树杀（' + r2.how + '）')
          } else {
            wlog('端口 ' + p + ' 仍被 pid=' + o + ' 监听，但它不在本代托管服务的进程树内 → 不做任何操作（fail-safe：绝不误杀外来服务）')
          }
        }
      }
      const budget2 = Math.min(3000, Math.max(0, HARD_DEADLINE - Date.now()))
      open = await waitPortsClear(open, budget2)
    }
  }

  // 最终确认（每次连接预算压到 600ms，避免拖过 15s）
  const openNow = []
  for (const p of ports) if (await portOpen(p, 600)) openNow.push(p)
  const used = Date.now() - T0
  if (openNow.length === 0) {
    wlog('已树杀 ' + (killed.length > 0 ? killed.join(' / ') : '（无活着的登记项）')
      + '；端口 ' + ports.join('/') + ' 现在空闲（检测方式=' + reason + '，耗时 ' + used + 'ms）')
  } else {
    wlog('回收结束：端口 ' + openNow.join('/') + ' 仍在监听（已尽力：' + (killed.join(' / ') || '无')
      + (skipped.length > 0 ? '；跳过 ' + skipped.join('/') : '') + '，耗时 ' + used + 'ms）')
  }
  return { action: 'recovered', killed, skipped, portsStillOpen: openNow, elapsedMs: used }
}

function fire(reason) {
  if (fired) return
  fired = true
  wlog('DSH 进程已消失（dshPid=' + opt.dshPid + '，检测方式=' + reason + '）→ 开始回收语音服务')
  Promise.resolve()
    .then(() => recover(reason))
    .catch((e) => { wlog('回收异常：' + (e && e.stack ? e.stack : String(e))) })
    .then(() => { try { process.exit(0) } catch (e) { /* ignore */ } })
}

function main() {
  if (!opt.token || !opt.tokenFile || !opt.dshPid) {
    wlog('参数不足（需要 --token/--dsh-pid/--token-file）→ 直接退出')
    process.exit(2)
    return
  }
  if (opt.dshPid === process.pid) {
    wlog('dshPid 等于自己的 pid（配置错误）→ 直接退出，绝不自杀式回收')
    process.exit(2)
    return
  }
  wlog('已启动 pid=' + process.pid + '，监视 dshPid=' + opt.dshPid + '，token=' + short(opt.token)
    + '，令牌文件=' + opt.tokenFile + '，日志=' + opt.log)

  // 主信号：stdin 管道 EOF（DSH 消失 ⇒ 写端被 OS 关闭）
  if (opt.useStdin && !process.stdin.isTTY) {
    try {
      process.stdin.on('end', () => fire('stdin EOF'))
      process.stdin.on('close', () => fire('stdin 关闭'))
      process.stdin.on('error', () => fire('stdin 错误'))
      process.stdin.resume()
    } catch (e) {
      wlog('stdin 监听失败（' + (e && e.message ? e.message : String(e)) + '）→ 只靠 pid 轮询兜底')
    }
  } else {
    wlog('未启用 stdin 信号（--no-stdin 或 stdin 是 TTY）→ 只靠 pid 轮询兜底')
  }

  // 兜底信号：pid 轮询（这个 interval **故意保持 ref**：看门狗要靠它活着等信号）
  setInterval(() => {
    let alive = true
    try { process.kill(opt.dshPid, 0) } catch (e) { alive = (e && e.code === 'EPERM') }
    if (!alive) fire('pid 轮询（' + opt.pollMs + 'ms 一次）')
  }, opt.pollMs)
}

main()
