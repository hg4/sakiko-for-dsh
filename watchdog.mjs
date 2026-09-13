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
// ⚠️ 真实进程形状（验收台 2026-09-13 在**真实 DSH + 真实强杀**上实测）：
//     DSH node(被杀) → api 启动器(随父同刻死) → api-worker(监听端口, 活) → api-grandchild(活)
//   libuv 在 Windows 用全局 Job Object（KILL_ON_JOB_CLOSE + SILENT_BREAKAWAY_OK）：node 一死，
//   job 关闭 ⇒ 在 job 里的**直接子进程**被一起杀；孙辈已 breakaway ⇒ 逃逸、继续占着端口。
//   ⇒ ① 看门狗必须 detached（否则也被这个 job 收走）；② **登记的"启动器"pid 在强杀场景下必然
//   已经死了**，只按它 taskkill 等于什么都没做 —— 必须按 ParentProcessId 链（父死后该字段仍在）
//   递归找回并杀掉它的后代，再反复复验端口。
//
// 接口契约（与 host.mjs 的约定，改一边必须改另一边）：
//   argv: --token <uuid> --epoch <n> --dsh-pid <pid> --token-file <path> --log <path>
//         [--poll-ms n] [--budget-ms n] [--no-stdin]
//   令牌文件: {"token":<uuid|null>,"epoch":n,"dshPid":n,"watchdogPid":n,
//             "updatedAt":<iso>,"services":[{"key":"api"|"bridge","pid":n,"port":n}]}
//   日志: 追加到 --log 指定文件，每行前缀 "[HH:MM:SS] [watchdog] "
//   注：看门狗**不读任何环境变量**，路径全部由 argv 显式传入（ctx.subprocess 的子进程拿不到
//   DSH_* 变量，本进程虽然能拿到，但不允许依赖 —— 见验收台 F3）。
//
// 零新依赖（只用 node: 内置模块），Windows 优先；posix 分支为尽力实现（见 README「已实测范围」）。
import { appendFileSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname } from 'node:path'
import net from 'node:net'

const opt = (() => {
  const out = {
    token: '', epoch: 0, dshPid: 0, tokenFile: '', log: '',
    pollMs: 2500, budgetMs: 14000, useStdin: true, useDescendants: true,
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
    else if (a === '--budget-ms') out.budgetMs = Math.max(1000, Number(next()) || 14000)
    // 诊断/取证开关：关掉 PPID 链后代枚举，单独检验"端口兜底"这条安全网（生产路径不用）
    else if (a === '--no-descendants') out.useDescendants = false
    else if (a === '--no-stdin') out.useStdin = false
  }
  return out
})()

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

// ---------------- 进程查询：**定向过滤**，绝不拉全表 ----------------
// 为什么不用整表 `Get-CimInstance Win32_Process`（连 CommandLine 一起拉）：几百个进程一来慢
// （实测单次 1.5~2.5s），二来每轮都要重查，代价与收益完全不成比例。本功能每次只关心
// 「令牌文件里登记的那几个 pid + 它们的后代」，用 `-Filter "ProcessId=…"` /
// `-Filter "ParentProcessId=… or …"` 定向查就够，且一次 PowerShell 调用内完成 BFS。
const PS_TIMEOUT_MS = 8000

function psExec(script) {
  // 用 -EncodedCommand 传脚本，彻底绕开 cmd/powershell 的引号地狱
  const b64 = Buffer.from(script, 'utf16le').toString('base64')
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', b64],
    { encoding: 'utf8', timeout: PS_TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024 })
  // ⚠️ 注意：**空结果集是合法的**（登记 pid 已死、且没有后代 ⇒ 查询本来就返回 0 行）。
  // 只有"命令本身失败"（非 0 退出/起不来）才算查询不可用 —— 早期版本把"空输出"当成失败，
  // 会在真实强杀场景里误报"进程查询不可用"，掩盖真正的判断。
  if (!r || r.error || r.status !== 0) return null
  return typeof r.stdout === 'string' ? r.stdout : ''
}

function parseProcLines(text, map) {
  for (const line of String(text).split(/\r?\n/)) {
    const p = line.split('|')
    if (p.length < 4) continue
    const pid = Number(p[1])
    if (!Number.isFinite(pid) || pid <= 0) continue
    const ft = Number(p[3])
    map.set(pid, {
      tag: p[0],
      ppid: Number(p[2]) || 0,
      // FILETIME(100ns since 1601) → ms since epoch
      createdMs: Number.isFinite(ft) && ft > 0 ? (ft / 10000 - 11644473600000) : 0,
    })
  }
  return map
}

// 一次调用拿到：登记 pid 自身的信息（tag=S）+ 按 PPID 链递归找到的全部后代（tag=D）
function psProcTree(roots, maxDepth) {
  if (!WIN) return posixProcTree(roots, maxDepth)
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    '$roots = @(' + roots.map((x) => Number(x)).join(',') + ')',
    'function Emit($tag, $procs) {',
    '  foreach ($p in $procs) {',
    "    $ct = ''",
    '    try { $ct = [string]$p.CreationDate.ToFileTimeUtc() } catch { }',
    "    '{0}|{1}|{2}|{3}' -f $tag, [int]$p.ProcessId, [int]$p.ParentProcessId, $ct",
    '  }',
    '}',
    'if ($roots.Count -gt 0) {',
    "  $f = ($roots | ForEach-Object { 'ProcessId=' + $_ }) -join ' or '",
    '  Emit "S" (Get-CimInstance Win32_Process -Filter $f | Select-Object ProcessId,ParentProcessId,CreationDate)',
    '}',
    '$seen = @{}',
    'foreach ($r in $roots) { $seen[[int]$r] = 1 }',
    '$frontier = @($roots)',
    'for ($d = 0; $d -lt ' + Number(maxDepth) + ' -and $frontier.Count -gt 0; $d++) {',
    "  $f2 = ($frontier | ForEach-Object { 'ParentProcessId=' + $_ }) -join ' or '",
    '  $kids = @(Get-CimInstance Win32_Process -Filter $f2 | Select-Object ProcessId,ParentProcessId,CreationDate)',
    '  Emit "D" $kids',
    '  $next = @()',
    '  foreach ($k in $kids) { $p = [int]$k.ProcessId; if (-not $seen.ContainsKey($p)) { $seen[$p] = 1; $next += $p } }',
    '  $frontier = $next',
    '}',
  ].join('\n')
  const out = psExec(script)
  if (out === null) return null
  return parseProcLines(out, new Map())
}

// 从某个 pid 沿 ppid 往上走，返回祖先链（含自己）——只用于「关掉后代枚举」时的归属判定
function psAncestorChain(pid, maxDepth) {
  if (!WIN) return posixAncestorChain(pid, maxDepth)
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    '$x = ' + Number(pid),
    'for ($i = 0; $i -lt ' + Number(maxDepth) + ' -and $x -gt 0; $i++) {',
    "  $p = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $x) | Select-Object ProcessId,ParentProcessId,CreationDate",
    '  if (-not $p) { break }',
    "  $ct = ''",
    '  try { $ct = [string]$p.CreationDate.ToFileTimeUtc() } catch { }',
    "  'A|{0}|{1}|{2}' -f [int]$p.ProcessId, [int]$p.ParentProcessId, $ct",
    '  $x = [int]$p.ParentProcessId',
    '}',
  ].join('\n')
  const out = psExec(script)
  if (out === null) return null
  return parseProcLines(out, new Map())
}

// posix 尽力实现：/proc 是本地文件读，代价极低（无 /proc 时返回 null ⇒ 调用方按 unknown 处理）
function posixRead(pid) {
  try {
    const raw = readFileSync('/proc/' + pid + '/stat', 'utf8')
    const close = raw.lastIndexOf(')')
    const rest = raw.slice(close + 2).split(' ')
    let boot = 0
    try {
      const m = readFileSync('/proc/stat', 'utf8').match(/^btime\s+(\d+)/m)
      if (m) boot = Number(m[1]) * 1000
    } catch (e) { /* 拿不到开机时间就算 0 */ }
    const hz = 100
    return { ppid: Number(rest[1]) || 0, createdMs: boot + Math.round(((Number(rest[19]) || 0) / hz) * 1000) }
  } catch (e) { return null }
}

function posixProcTree(roots, maxDepth) {
  const map = new Map()
  for (const r of roots) {
    const info = posixRead(r)
    if (info !== null) map.set(Number(r), { tag: 'S', ppid: info.ppid, createdMs: info.createdMs })
  }
  let names = []
  try { names = readdirSync('/proc') } catch (e) { return map.size > 0 ? map : null }
  const all = new Map()
  for (const n of names) {
    if (!/^\d+$/.test(n)) continue
    const info = posixRead(n)
    if (info !== null) all.set(Number(n), info)
  }
  // 用本地读到的父子关系做 BFS（等价于 Windows 侧的定向递归）
  const kids = new Map()
  for (const [pid, info] of all) {
    if (!kids.has(info.ppid)) kids.set(info.ppid, [])
    kids.get(info.ppid).push(pid)
  }
  let frontier = roots.map(Number)
  const seen = new Set(frontier)
  for (let d = 0; d < maxDepth && frontier.length > 0; d++) {
    const next = []
    for (const p of frontier) {
      for (const k of kids.get(p) || []) {
        if (seen.has(k)) continue
        seen.add(k)
        next.push(k)
        map.set(k, { tag: 'D', ppid: all.get(k).ppid, createdMs: all.get(k).createdMs })
      }
    }
    frontier = next
  }
  return map.size > 0 ? map : null
}

function posixAncestorChain(pid, maxDepth) {
  const map = new Map()
  let cur = Number(pid)
  for (let i = 0; i < maxDepth && cur > 0; i++) {
    const info = posixRead(cur)
    if (info === null) break
    map.set(cur, { tag: 'A', ppid: info.ppid, createdMs: info.createdMs })
    cur = info.ppid
  }
  return map.size > 0 ? map : null
}

// 从 tree 结果里按 ppid 关系取出某个 root 的后代列表
function descendantsFrom(procs, root) {
  const kids = new Map()
  for (const [pid, info] of procs) {
    if (!kids.has(info.ppid)) kids.set(info.ppid, [])
    kids.get(info.ppid).push(pid)
  }
  const out = []
  const seen = new Set([root])
  const queue = [root]
  while (queue.length > 0) {
    const cur = queue.shift()
    for (const k of kids.get(cur) || []) {
      if (seen.has(k)) continue
      seen.add(k)
      out.push(k)
      queue.push(k)
    }
  }
  return out
}

// ---------------- 杀进程 ----------------
function pidAlive(pid) {
  try { process.kill(pid, 0); return true } catch (e) { return !!(e && e.code === 'EPERM') }
}

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
  // 进程组不一定等于进程树（posix 下服务是 DSH 的子进程，未必自成进程组）→ 定向补杀后代
  const t = psProcTree([pid], 6)
  if (t !== null) {
    for (const d of descendantsFrom(t, pid)) {
      try { process.kill(d, 'SIGKILL') } catch (e) { /* 已经没了 */ }
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
// ⚠️ 真实进程形状（验收台 2026-09-13 在**真实 DSH + 真实强杀**上实测，见 before-force-b72bcfa）：
//     DSH node(被杀) → api 启动器(随父同刻死) → api-worker(监听端口, 活) → api-grandchild(活)
//   机理：libuv 在 Windows 用了一个全局 Job Object（KILL_ON_JOB_CLOSE + SILENT_BREAKAWAY_OK）：
//   node 一死，job 关闭 ⇒ **在 job 里的直接子进程一起被杀**；孙辈已 breakaway ⇒ 逃逸、继续占端口。
//   ⇒ 两件事必须同时做到：
//   ① 看门狗自己必须 detached（否则被同一个 job 收走 = 等于没有看门狗）；
//   ② **不能只按登记的那个 pid 杀** —— 强杀场景下登记的「启动器」pid 必然已经死了，
//      占端口的是它的后代。必须按 ParentProcessId 链（父死后该字段仍在）递归找回后代再杀，
//      并且反复复验端口，直到空闲或超时。
let fired = false

// 按 PPID 链递归枚举后代（**父进程已死也能查到**：子进程记录里的 ParentProcessId 不会消失）
// 实现见上面的 descendantsFrom()（从 psProcTree 的定向查询结果里取）。

async function recover(reason, firedAt) {
  // 时间预算从**检测到 DSH 消失的那一刻**算起（不是看门狗启动时刻 —— 它可能已经活了几小时）
  const deadline = firedAt + opt.budgetMs
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

  const ports = [...new Set(svcs.map((s) => s.port).filter((p) => p > 0))]
  const roots = svcs.map((s) => s.pid)
  const killed = new Set()          // **确认已消失**的 pid（taskkill 成功，或目标本来就不存在）
  const failed = []                 // taskkill 报错且目标仍在（不能算成功；端口兜底会继续处理）
  const refused = new Set()         // 明确判定"不是本代的"端口持有者
  const deadRoots = []              // 登记时是"启动器"、触发回收时已经不在的 pid
  const skipped = []
  let round = 0
  let openNow = []

  // 反复「重算目标集合 → 树杀 → 复验端口」，直到端口空闲或超时
  for (;;) {
    round++
    // 定向查询：登记 pid 自身 + 它们的后代（一次 PowerShell 调用，内部做 BFS）
    const procs = psProcTree(roots, opt.useDescendants ? 6 : 0)
    if (procs === null && round === 1) wlog('进程查询不可用（拿不到 PPID/创建时间）→ 归属校验降级为「只看 token 匹配」')

    // ---- 目标集合 = 登记 pid ∪ 其后代（父已死也算） ----
    const targets = new Map()       // pid -> 人类可读的来源说明
    for (const s of svcs) {
      if (procs === null) {
        targets.set(s.pid, s.key + '（未校验）')
        continue
      }
      const info = procs.get(s.pid)
      if (info === undefined || info.tag !== 'S') {
        // ★ 关键分支：强杀场景下登记的启动器**必然已经死了**，占端口的是它的后代
        if (!deadRoots.includes(s.pid)) {
          deadRoots.push(s.pid)
          wlog('登记项 ' + s.key + ' pid=' + s.pid + '：进程已不存在（强杀时随 DSH 一起被 job 收走的直接子进程）→ 改为按 PPID 链回收它的后代')
        }
        if (!opt.useDescendants && round === 1) wlog('诊断开关 --no-descendants 生效：不做 PPID 链后代枚举，只靠登记 pid + 端口兜底')
        const desc = opt.useDescendants ? descendantsFrom(procs, s.pid) : []
        if (desc.length > 0 && round === 1) wlog('登记项 ' + s.key + ' pid=' + s.pid + ' 的后代：' + desc.join(','))
        for (const d of desc) {
          const di = procs.get(d)
          // PID 复用防护（对后代用「DSH 死亡时刻」当上界）：本代后代必然在 DSH 死亡前就已存在；
          // 晚于死亡时刻才出现的，只可能是"父 pid 被复用后新拉起的进程" ⇒ 不碰。
          if (di && Number(di.createdMs) > 0 && Number(di.createdMs) > firedAt + 5000) {
            if (!skipped.includes(d)) { skipped.push(d); wlog('跳过 pid=' + d + '（' + s.key + ' 的名义后代）：它的创建时间晚于 DSH 死亡时刻 ⇒ 判为 pid 复用，不碰') }
            continue
          }
          if (!targets.has(d)) targets.set(d, s.key + ' 的后代')
        }
        continue
      }
      // 登记 pid 还活着：PID 复用防护（本代服务一定早于最后一次写令牌文件）
      if (Number(info.createdMs) > 0 && tf.mtimeMs > 0 && Number(info.createdMs) > tf.mtimeMs + 5000) {
        if (!skipped.includes(s.pid)) {
          skipped.push(s.pid)
          wlog('拒绝回收 ' + s.key + ' pid=' + s.pid + '：该 pid 已被复用（现进程创建时间晚于本代令牌文件）→ fail-safe 跳过')
        }
        continue
      }
      targets.set(s.pid, s.key)
    }

    // ---- 只杀"最上层"目标：父也在目标集里的交给 /T 一起带走，少发几条 taskkill ----
    const toKill = []
    for (const pid of targets.keys()) {
      if (killed.has(pid)) continue
      const info = procs === null ? undefined : procs.get(pid)
      if (info !== undefined && targets.has(Number(info.ppid))) continue
      toKill.push(pid)
    }
    for (const pid of toKill) {
      const r = killTree(pid)
      // ★ 只按**真实结果**归类：taskkill 报错不能算成功，否则端口兜底会因为
      //   "这个 pid 已经杀过了"而跳过它（旧版本正是这么自欺的）。
      if (r.ok) {
        killed.add(pid)
        wlog('树杀成功 ' + targets.get(pid) + ' pid=' + pid + '（' + r.how + '）')
      } else if (!pidAlive(pid)) {
        killed.add(pid)          // 目标本来就已经没了（例如随 DSH 一起死的启动器）—— 不算失败
        wlog('目标 ' + targets.get(pid) + ' pid=' + pid + ' 已不存在，无需树杀')
      } else {
        failed.push(pid)
        wlog('★ 树杀失败 ' + targets.get(pid) + ' pid=' + pid + '：' + r.how
          + ' → 不记为成功；端口兜底与最终复核会继续处理它')
      }
    }

    // ---- 复验：端口空闲 **且** 目标后代全部消失，才算收工 ----
    //  只验端口是不够的：不监听端口的孙进程（真实 GPT-SoVITS 树里就有）也可能还活着，
    //  所以两者都满足才 break；否则继续下一轮（重算目标 → 再杀）。
    const leftovers = [...targets.keys()].filter((p) => pidAlive(p))
    openNow = []
    for (const p of ports) if (await portOpen(p, 600)) openNow.push(p)
    if (openNow.length === 0 && leftovers.length === 0) break
    if (round === 1 && leftovers.length > 0) wlog('本轮结束后仍有目标存活：' + leftovers.join(',') + ' → 继续下一轮')
    if (Date.now() >= deadline) break

    // ---- 端口仍被占：找持有者，只杀「登记集 ∪ 后代集」里的 ----
    const again = readTokenFile()
    if (!again.ok || (again.data && again.data.token !== opt.token)) {
      wlog('端口复验前发现令牌已变化 → 停止后续动作（fail-safe）')
      break
    }
    const allowed = [...new Set([...roots, ...targets.keys(), ...killed])]
    for (const p of openNow) {
      const owners = portOwners(p)
      if (owners.length === 0) {
        if (round === 1) wlog('端口 ' + p + ' 仍在监听，但查不到持有者 → 不做任何操作（fail-safe）')
        continue
      }
      for (const o of owners) {
        // 归属判定：① 直接就是登记/目标集里的 pid；② 已枚举到的后代；
        // ③ 枚举被关掉时，用**定向的祖先链查询**（一次 PowerShell，最多 6 级）往上找登记 pid。
        let ours = allowed.includes(o)
        if (!ours && procs !== null && opt.useDescendants) {
          for (const r of roots) if (descendantsFrom(procs, r).includes(o)) { ours = true; break }
        }
        if (!ours && !opt.useDescendants) {
          // 祖先链判定：从端口持有者往上走，**任何一级的 pid 或它的 ppid 命中"登记集∪已确认集合"**都算本代。
          // （只比对"链上的 pid"是不够的：链在父进程处就断了，而父正是登记在册的启动器 pid。）
          const chain = psAncestorChain(o, 6)
          if (chain !== null) {
            ours = [...chain.entries()].some(([p, info]) => allowed.includes(p) || allowed.includes(Number(info.ppid)))
          }
        }
        if (ours) {
          // 注意：只有**确认已消失**的才进 killed；上一轮树杀失败的 pid 仍会在这里被重试
          if (!killed.has(o)) {
            const r2 = killTree(o)
            if (r2.ok || !pidAlive(o)) {
              killed.add(o)
              wlog('端口 ' + p + ' 的持有者 pid=' + o + ' 确认属本代服务（登记集∪后代集）→ 树杀成功（' + r2.how + '）')
            } else {
              if (!failed.includes(o)) failed.push(o)
              wlog('★ 端口 ' + p + ' 的持有者 pid=' + o + ' 属本代服务，但树杀失败：' + r2.how + ' → 继续复验/重试')
            }
          }
        } else if (!refused.has(o)) {
          refused.add(o)
          wlog('端口 ' + p + ' 仍被 pid=' + o + ' 监听，但它不在本代登记集∪后代集内 → 不做任何操作（fail-safe：绝不误杀外来服务）')
        }
      }
    }
    if (Date.now() >= deadline) break
    await sleep(400)
  }

  // ---- 最终复验（压到 600ms/次，确保不拖过 15s）----
  openNow = []
  for (const p of ports) if (await portOpen(p, 600)) openNow.push(p)
  const used = Date.now() - firedAt
  const killedList = [...killed].join(' / ')
  const failNote = failed.length > 0 ? '；★ 有 ' + failed.length + ' 次树杀报错（pid=' + failed.join('/') + '）' : ''
  if (openNow.length === 0) {
    wlog('回收完成：确认已消失的 pid=[' + (killedList || '无') + ']；端口 ' + ports.join('/')
      + ' 现在空闲（检测方式=' + reason + '，耗时 ' + used + 'ms，轮次=' + round + '）' + failNote)
  } else {
    wlog('回收结束：端口 ' + openNow.join('/') + ' 仍在监听（已确认消失的 pid=[' + (killedList || '无') + ']'
      + (deadRoots.length > 0 ? '；登记启动器已死 pid=' + deadRoots.join('/') : '')
      + (skipped.length > 0 ? '；按 PID 复用跳过 ' + skipped.join('/') : '')
      + failNote + '，耗时 ' + used + 'ms，轮次=' + round + '）')
  }
  return { action: 'recovered', killed: [...killed], failed, skipped, deadRoots, portsStillOpen: openNow, elapsedMs: used, rounds: round }
}

function fire(reason) {
  if (fired) return
  fired = true
  const firedAt = Date.now()
  wlog('DSH 进程已消失（dshPid=' + opt.dshPid + '，检测方式=' + reason + '）→ 开始回收语音服务')
  Promise.resolve()
    .then(() => recover(reason, firedAt))
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
