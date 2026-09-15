// provider 缓存键回归测试
//
// 背景：aqua 的 provider 缓存键原先只含 voice / refAudio / preset，漏了 aquaPromptText 等
// **会改变合成结果**的参数 ⇒ 用户改配置后键不变、命中旧音频，表现为「改了没反应」，日志里毫无提示。
// 2026-09-15 独立复审又补了三处（B-1/B-2/B-3），本测试一并覆盖：
//   B-1 questSpeaker（quest 通道唯一的说话人参数）、emotionIntensity（edge 用它算强度）原先没进键；
//   B-2 两个 TTS 的 apiKey 换租户会换音源，但明文不宜进键 ⇒ 以 SHA-256 前 12 位指纹入键；
//   B-3 stableJson 原用 `k=v` 逗号拼接：`{a:'1,b=2'}` 与 `{a:'1',b:'2'}` 会同串（碰撞）、
//       嵌套对象被塌成 `[object Object]` ⇒ 改递归 + JSON 转义。
//
// 本测试直接从 host.mjs 原样抽取这几个函数的源码执行，锚点找不到就 FATAL 退出 ——
// 不允许「测了个空壳还全绿」。它们依赖模块级的 createHash，故显式注入。
//
// 运行：node --test test/provider-cache-key.test.mjs     （或 node test/provider-cache-key.test.mjs）

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

const HOST = new URL('../host.mjs', import.meta.url)
const src = readFileSync(HOST, 'utf8')

function extract(name) {
  // apply() 体内的函数都是 4 空格缩进，函数体以 "\n    }" 收尾
  const re = new RegExp('function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n    \\}', 'm')
  const m = re.exec(src)
  if (!m) {
    console.error('[FATAL] 在 host.mjs 里找不到锚点 function ' + name + '() —— 测试已失效，请同步更新测试')
    process.exit(1)
  }
  return m[0]
}

const code = [extract('stableJson'), extract('keyFingerprint'), extract('providerCacheKey')].join('\n') +
  '\nreturn { stableJson, keyFingerprint, providerCacheKey };'
let providerCacheKey, stableJson, keyFingerprint
try {
  const mod = new Function('createHash', code)(createHash)
  providerCacheKey = mod.providerCacheKey
  stableJson = mod.stableJson
  keyFingerprint = mod.keyFingerprint
  if (typeof providerCacheKey !== 'function' || typeof stableJson !== 'function' || typeof keyFingerprint !== 'function') {
    throw new Error('抽取结果不完整')
  }
} catch (e) {
  console.error('[FATAL] 抽取出来的代码无法执行：' + e.message)
  process.exit(1)
}

let pass = 0
let fail = 0
function check(name, cond) {
  if (cond) { pass++; console.log('  [PASS] ' + name) }
  else { fail++; console.log('  [FAIL] ' + name) }
}

const AQUA = {
  provider: 'aqua',
  aquaVoice: 'sakiko',
  aquaRefAudio: 'C:\\ref\\sakiko_ref.wav',
  aquaPreset: 'fast',
  aquaPromptText: 'これから私たちはバンド、共に音楽を奏でる運命共同体となるのです。',
  aquaPromptLanguage: '日文',
  aquaTextLanguage: '日文',
  aquaUrl: 'http://127.0.0.1:8100',
  aquaEmotionVoices: { happy: 'sakiko-happy' },
  aquaApiKey: 'sk-aqua-aaaa'
}
const key = (over) => providerCacheKey(Object.assign({}, AQUA, over))

test('provider 缓存键覆盖所有会改变合成结果的参数', () => {
  console.log('\n== 1) 稳定性与 aqua 核心项 ==')
  check('同一份配置 → 同一个键（幂等）', key({}) === key({}))
  check('改 aquaPromptText → 键必须变', key({ aquaPromptText: '换一段文稿' }) !== key({}))
  check('aquaPromptText 从缺失到有值 → 键必须变',
    providerCacheKey({ provider: 'aqua', aquaVoice: 'sakiko' }) !==
    providerCacheKey({ provider: 'aqua', aquaVoice: 'sakiko', aquaPromptText: 'x' }))
  check('改 aquaPromptLanguage → 键变', key({ aquaPromptLanguage: '中文' }) !== key({}))
  check('改 aquaTextLanguage → 键变', key({ aquaTextLanguage: '中文' }) !== key({}))
  check('改 aquaUrl（换桥/后端）→ 键变', key({ aquaUrl: 'http://127.0.0.1:9000' }) !== key({}))
  check('改 aquaEmotionVoices → 键变', key({ aquaEmotionVoices: { happy: 'other' } }) !== key({}))
  check('改 aquaVoice → 键变', key({ aquaVoice: 'sakiko-zero-shot' }) !== key({}))
  check('改 aquaRefAudio → 键变', key({ aquaRefAudio: 'D:\\other.wav' }) !== key({}))
  check('改 aquaPreset → 键变', key({ aquaPreset: 'quality' }) !== key({}))

  console.log('\n== 2) B-1：quest / edge 原先漏掉的参数 ==')
  const quest = { provider: 'quest', questSpeaker: 8 }
  check('quest：改 questSpeaker → 键变（原先恒为 "quest"）',
    providerCacheKey(quest) !== providerCacheKey(Object.assign({}, quest, { questSpeaker: 3 })))
  check('quest：默认 speaker 与显式 8 等价', providerCacheKey({ provider: 'quest' }) === providerCacheKey(quest))
  const edge = { provider: 'edge', emotionIntensity: 1 }
  check('edge：改 emotionIntensity → 键变（synthesizeEdge 用它算强度）',
    providerCacheKey(edge) !== providerCacheKey(Object.assign({}, edge, { emotionIntensity: 1.8 })))
  check('edge：缺省 intensity 与显式 1 等价', providerCacheKey({ provider: 'edge' }) === providerCacheKey(edge))

  console.log('\n== 3) 反向：不吃该参数的 provider 不该被它影响（避免无谓 miss）==')
  const vv = { provider: 'voicevox', voicevoxSpeaker: 8, voicevoxUrl: 'http://127.0.0.1:50021', voicevoxEmotionSpeakers: { happy: 1 }, emotionIntensity: 1 }
  check('voicevox：改 emotionIntensity → 键**不变**（它只吃 speaker/emotionSpeakers）',
    providerCacheKey(vv) === providerCacheKey(Object.assign({}, vv, { emotionIntensity: 2 })))
  check('voicevox：改 speaker → 键变', providerCacheKey(vv) !== providerCacheKey(Object.assign({}, vv, { voicevoxSpeaker: 3 })))
  check('voicevox：改 emotionSpeakers → 键变', providerCacheKey(vv) !== providerCacheKey(Object.assign({}, vv, { voicevoxEmotionSpeakers: { happy: 2 } })))
  const aq = Object.assign({}, AQUA)
  check('aqua：改 emotionIntensity → 键**不变**（它吃 aquaEmotionVoices 而非 intensity）',
    providerCacheKey(aq) === providerCacheKey(Object.assign({}, aq, { emotionIntensity: 2 })))

  console.log('\n== 4) B-2：apiKey 以指纹入键，且不含明文 ==')
  const oa = { provider: 'openai', openaiTtsModel: 'tts-1', openaiTtsVoice: 'nova', openaiTtsUrl: '', openaiTtsSpeed: 1, chatBaseUrl: 'https://api.deepseek.com/v1', openaiTtsApiKey: 'sk-openai-aaaa' }
  check('openai：改 apiKey → 键变', providerCacheKey(oa) !== providerCacheKey(Object.assign({}, oa, { openaiTtsApiKey: 'sk-openai-bbbb' })))
  check('openai：未配 openaiTtsApiKey 时回退 chatApiKey，改它 → 键变',
    providerCacheKey({ provider: 'openai', chatApiKey: 'sk-chat-aaaa' }) !==
    providerCacheKey({ provider: 'openai', chatApiKey: 'sk-chat-bbbb' }))
  check('aqua：改 apiKey → 键变', key({ aquaApiKey: 'sk-aqua-bbbb' }) !== key({}))
  const kk = key({})
  check('键里**不含** apiKey 明文', !kk.includes('sk-aqua-aaaa'))
  check('指纹长度 = 12 且为 hex', /^[0-9a-f]{12}$/.test(keyFingerprint('sk-aqua-aaaa')))
  check('空 / 非字符串 apiKey → 空指纹（不抛）', keyFingerprint('') === '' && keyFingerprint(undefined) === '' && keyFingerprint(123) === '')
  check('相同 apiKey → 相同指纹', keyFingerprint('x') === keyFingerprint('x'))

  console.log('\n== 5) B-3：stableJson 的碰撞与塌陷 ==')
  check('键序不同的等价对象 → 同串', stableJson({ a: 1, b: 2 }) === stableJson({ b: 2, a: 1 }))
  check('嵌套对象不再塌成 [object Object]', stableJson({ a: { x: 1 } }) !== stableJson({ a: { y: 2 } }))
  check('嵌套同值对象 → 同串', stableJson({ a: { x: 1, y: 2 } }) === stableJson({ a: { y: 2, x: 1 } }))
  check('逗号拼接碰撞已消除', stableJson({ a: '1,b=2' }) !== stableJson({ a: '1', b: '2' }))
  check('数组顺序敏感（不同顺序 → 不同串）', stableJson([1, 2]) !== stableJson([2, 1]))
  check('null / undefined → 空串；数字/字符串/布尔仍可区分',
    stableJson(null) === '' && stableJson(undefined) === '' && stableJson(1) !== stableJson('1') && stableJson(true) !== stableJson('true'))
  check('空对象与缺失**不同**（{} 与 undefined 语义不同）', stableJson({}) !== stableJson(undefined))
  check('aquaEmotionVoices 键序不同 → 整个键相同',
    providerCacheKey(Object.assign({}, AQUA, { aquaEmotionVoices: { a: 1, b: 2 } })) ===
    providerCacheKey(Object.assign({}, AQUA, { aquaEmotionVoices: { b: 2, a: 1 } })))

  console.log('\n== 6) 边界：不能抛 ==')
  check('cfg 为 undefined → 返回字符串且不抛', typeof providerCacheKey(undefined) === 'string')
  check('provider 未知 → 返回 provider 名', providerCacheKey({ provider: 'edge-x' }) === 'edge-x')
  check('aqua 全空配置 → 返回字符串且不抛', typeof providerCacheKey({ provider: 'aqua' }) === 'string')

  console.log('\n== 7) 防回退锚点（守的是已修掉的缺陷别被改回来）==')
  check('synthesize 仍调用 providerCacheKey(config)', /const providerKey = providerCacheKey\(config\)/.test(src))
  check('host.mjs 里已无旧的 `let providerKey = config.provider` 拼装', !/let providerKey = config\.provider/.test(src))
  check('questSpeaker 确实进了 providerCacheKey', /\['quest', c\.questSpeaker \|\| 8\]/.test(src))
  check('emotionIntensity 确实进了 edge 分支', /const intensity = typeof c\.emotionIntensity === 'number'/.test(src))
  check('speakSynced 签名里已无 noWait（C-4 死参数）', !/async function speakSynced\([^)]*noWait/.test(src))
  check('announce 签名里已无 noWait', !/async function announce\([^)]*noWait/.test(src))
  // C-3：announce 与 narrate 都不该在写完留痕后因 voiceOn 提前 return（那会把气泡吞掉）；
  // 而 checkCalls / checkIdle / checkHum 里的同类 return 是另一回事（"语音关就别做这件事"），故意保留。
  // 判据用「三处守卫各自落在哪个函数里」——比抽取函数体更稳（narrate 很长，抽取容易被中间的 `}` 截断）。
  const guardFns = []
  {
    const re = /if \(config\.voiceOn !== true\) return/g
    let m
    while ((m = re.exec(src)) !== null) {
      const before = src.slice(Math.max(0, m.index - 600), m.index)
      const fns = [...before.matchAll(/function\s+(\w+)\s*\(/g)]
      guardFns.push(fns.length ? fns[fns.length - 1][1] : '?')
    }
  }
  check('voiceOn 守卫恰好 3 处，且分别在 checkCalls/checkIdle/checkHum（⇒ announce/narrate 里没有了）',
    guardFns.join(',') === 'checkCalls,checkIdle,checkHum')
  check('voiceOn 判定已收到 speakSynced 里', /const voiceOff = config\.voiceOn !== true/.test(src))

  console.log('\n[OK] ' + pass + ' 通过 / ' + fail + ' 失败')
  assert.equal(fail, 0, '有 ' + fail + ' 项断言失败')
})
