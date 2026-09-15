// provider 缓存键回归测试
//
// 背景（独立审查 2026-09-15 报的隐患）：aqua 的 provider 缓存键原先只含 voice / refAudio / preset，
// 漏了 aquaPromptText（参考音频的逐字文稿）等**会改变合成结果**的参数 ⇒ 用户热改文稿后键不变、
// 命中旧音频，表现为「改了没反应」，而且日志里一点提示都没有。
//
// 本测试直接从 host.mjs 原样抽取 providerCacheKey / stableJson 两个函数的源码执行，
// 锚点找不到就 FATAL 退出 —— 不允许「测了个空壳还全绿」。
//
// 运行：node --test test/provider-cache-key.test.mjs     （或 node test/provider-cache-key.test.mjs）

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

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

const code = extract('stableJson') + '\n' + extract('providerCacheKey') + '\nreturn { stableJson, providerCacheKey };'
let providerCacheKey
try {
  const mod = new Function(code)()
  providerCacheKey = mod.providerCacheKey
  if (typeof providerCacheKey !== 'function') throw new Error('抽取结果里没有 providerCacheKey 函数')
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
  aquaUrl: 'http://127.0.0.1:8000',
  aquaEmotionVoices: { happy: 'sakiko-happy' }
}
const key = (over) => providerCacheKey(Object.assign({}, AQUA, over))

test('provider 缓存键覆盖所有会改变合成结果的参数', () => {
  console.log('\n== 1) 键的稳定性与本次修复的核心项 ==')
  check('同一份配置 → 同一个键（幂等）', key({}) === key({}))
  check('改 aquaPromptText → 键必须变（本次修复的核心）', key({ aquaPromptText: '换一段文稿' }) !== key({}))
  check('aquaPromptText 从缺失到有值 → 键必须变', providerCacheKey({ provider: 'aqua', aquaVoice: 'sakiko' }) !== providerCacheKey({ provider: 'aqua', aquaVoice: 'sakiko', aquaPromptText: 'x' }))

  console.log('\n== 2) 其余会影响合成结果的 aqua 参数 ==')
  check('改 aquaPromptLanguage（决定参考音频的 G2P）→ 键变', key({ aquaPromptLanguage: '中文' }) !== key({}))
  check('改 aquaTextLanguage（决定待合成文本的 G2P）→ 键变', key({ aquaTextLanguage: '中文' }) !== key({}))
  check('改 aquaUrl（换了桥/后端）→ 键变', key({ aquaUrl: 'http://127.0.0.1:9000' }) !== key({}))
  check('改 aquaEmotionVoices（同一 emo 映射到不同 voice）→ 键变', key({ aquaEmotionVoices: { happy: 'other' } }) !== key({}))
  check('aquaEmotionVoices 增删键 → 键变', key({ aquaEmotionVoices: {} }) !== key({}))

  console.log('\n== 3) 原有的三项仍要生效（不能改回归）==')
  check('改 aquaVoice → 键变', key({ aquaVoice: 'sakiko-zero-shot' }) !== key({}))
  check('改 aquaRefAudio → 键变', key({ aquaRefAudio: 'D:\\other.wav' }) !== key({}))
  check('改 aquaPreset → 键变', key({ aquaPreset: 'quality' }) !== key({}))

  console.log('\n== 4) 对象序列化要稳定（键序不同 ≠ 需要重新合成）==')
  check('键序不同的等价 aquaEmotionVoices → 键相同',
    providerCacheKey(Object.assign({}, AQUA, { aquaEmotionVoices: { happy: 'a', sad: 'b' } })) ===
    providerCacheKey(Object.assign({}, AQUA, { aquaEmotionVoices: { sad: 'b', happy: 'a' } })))
  check('aquaEmotionVoices 缺失与空对象 → 同为无映射（键相同）',
    providerCacheKey(Object.assign({}, AQUA, { aquaEmotionVoices: undefined })) ===
    providerCacheKey(Object.assign({}, AQUA, { aquaEmotionVoices: {} })))

  console.log('\n== 5) 其它 provider ==')
  const vv = { provider: 'voicevox', voicevoxSpeaker: 8, voicevoxUrl: 'http://127.0.0.1:50021', voicevoxEmotionSpeakers: { happy: 1 } }
  check('voicevox：改 speaker → 键变', providerCacheKey(vv) !== providerCacheKey(Object.assign({}, vv, { voicevoxSpeaker: 3 })))
  check('voicevox：改 emotionSpeakers → 键变', providerCacheKey(vv) !== providerCacheKey(Object.assign({}, vv, { voicevoxEmotionSpeakers: { happy: 2 } })))
  const oa = { provider: 'openai', openaiTtsModel: 'tts-1', openaiTtsVoice: 'nova', openaiTtsUrl: '', openaiTtsSpeed: 1, chatBaseUrl: 'https://api.deepseek.com/v1' }
  check('openai：改 model → 键变', providerCacheKey(oa) !== providerCacheKey(Object.assign({}, oa, { openaiTtsModel: 'tts-1-hd' })))
  check('openai：改 voice → 键变', providerCacheKey(oa) !== providerCacheKey(Object.assign({}, oa, { openaiTtsVoice: 'alloy' })))
  check('openai：改 speed → 键变', providerCacheKey(oa) !== providerCacheKey(Object.assign({}, oa, { openaiTtsSpeed: 1.5 })))
  check('openai：未配 openaiTtsUrl 时回退 chatBaseUrl，改它 → 键变', providerCacheKey(oa) !== providerCacheKey(Object.assign({}, oa, { chatBaseUrl: 'https://other/v1' })))

  console.log('\n== 6) 边界：不能抛 ==')
  check('cfg 为 undefined → 返回字符串且不抛', typeof providerCacheKey(undefined) === 'string')
  check('provider 未知 → 返回 provider 名', providerCacheKey({ provider: 'edge' }) === 'edge')
  check('aqua 全空配置 → 返回字符串且不抛', typeof providerCacheKey({ provider: 'aqua' }) === 'string')

  console.log('\n== 7) 防回退：synthesize 必须走 providerCacheKey ==')
  check('host.mjs 里已无旧的 `let providerKey = config.provider` 拼装', !/let providerKey = config\.provider/.test(src))
  check('host.mjs 里 synthesize 调用 providerCacheKey(config)', /const providerKey = providerCacheKey\(config\)/.test(src))

  console.log('\n[OK] ' + pass + ' 通过 / ' + fail + ' 失败')
  assert.equal(fail, 0, '有 ' + fail + ' 项断言失败')
})
