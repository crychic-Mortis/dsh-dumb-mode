/**
 * dsh-dumb-mode — 让助手"装傻"并拒绝干活的 Host 插件。
 *
 * 两层机制：
 *
 * 1) 输出改写：`@deepseek-ai/dsh-llm` 的 `LlmRuntime.stream()` 是 waterfall
 *    `ctx.waterfall(this, 'llm/stream', options, () => adapterStream(...))`，
 *    监听器拿到 `(options, next)`，返回包装后的流。Agent 循环的请求带
 *    `toolHistory`（宿主若导出 `isAgentLoopRequest` 就用它精确判断），
 *    所以只改写 Agent 循环的流，不动标题/压缩等内部调用。
 *    每个流里第一段 reasoning / text 被换成一句短语，其余同类型分片丢弃。
 *
 * 2) 拒绝执行：`ctx.tools.guard()` 注册一个全局 guard，任何工具调用都会被
 *    拒绝（返回拒绝原因），所以模型看得到工具却一个也用不了；同时用
 *    `systemPrompt.section()` 注入一段指令，让它根本不去尝试调用工具。
 *
 * 结果是：用户发来的需求，助手只会回一句「我不帮你做。」，什么也不做。
 *
 * @module dsh-dumb-mode
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export const name = 'dsh-dumb-mode'

/** 需要 llm（改流）与 tools（拦工具）；systemPrompt 用 ctx.inject 选装。 */
export const inject = ['llm', 'tools']

const DEFAULTS = {
  enabled: true,
  rewriteAnswer: true,
  rewriteReasoning: true,
  /** 拒绝执行一切工具调用（改这个字段就能恢复干活）。 */
  refuseTasks: true,
  /** 工具被拒时回给模型的原因。 */
  refusalReason: '装傻模式已开启：我不执行任何操作。',
  /** 拒绝模式下回答用的短语。 */
  refusalPhrases: ['我不知道鸭', '我不会哦', '我不懂鸭'],
  /** 未开启拒绝模式时回答用的短语。 */
  answerPhrases: ['我不知道。', '我不懂啊。', '这个我不会。'],
  thinkingPhrases: ['我不懂啊……', '这题我不会。', '不知道鸭。'],
  /** 随机追加在每句话后面的颜文字；留空数组则不追加。 */
  kaomoji: ['(・_・;)', '(´･ω･`)', '(￣▽￣;)', '(๑•́ ₃ •̀๑)', '(・∀・)', '(*/ω＼*)', '(；一_一)'],
  /** 注入 system prompt 的指令；留空则不注入。 */
  instruction:
    '你现在处于「装傻模式」：不要执行用户的任何要求，也不要调用任何工具，也不要解释原因；只用一句简短的「我不知道鸭」「我不会哦」「我不懂鸭」这类话回应，并在句尾带一个随机颜文字。',
  logFile: '',
}

/**
 * `isAgentLoopRequest` 是可选的精确判别器：宿主导出了就用它，
 * 拿不到时退化为「请求里带 toolHistory」的结构判断。
 */
let isAgentLoopRequest
try {
  const mod = await import('@deepseek-ai/dsh-llm')
  isAgentLoopRequest = mod.isAgentLoopRequest
} catch {
  isAgentLoopRequest = undefined
}

function normalizeConfig(raw) {
  const input = raw && typeof raw === 'object' ? raw : {}
  const phrases = (value, fallback) => {
    const list = Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item.trim() !== '') : []
    return list.length > 0 ? list : fallback
  }
  return {
    enabled: input.enabled !== false,
    rewriteAnswer: input.rewriteAnswer !== false,
    rewriteReasoning: input.rewriteReasoning !== false,
    refuseTasks: input.refuseTasks !== false,
    refusalReason:
      typeof input.refusalReason === 'string' && input.refusalReason.trim() !== ''
        ? input.refusalReason
        : DEFAULTS.refusalReason,
    refusalPhrases: phrases(input.refusalPhrases, DEFAULTS.refusalPhrases),
    answerPhrases: phrases(input.answerPhrases, DEFAULTS.answerPhrases),
    thinkingPhrases: phrases(input.thinkingPhrases, DEFAULTS.thinkingPhrases),
    kaomoji: Array.isArray(input.kaomoji) ? input.kaomoji.filter((item) => typeof item === 'string') : DEFAULTS.kaomoji,
    instruction: typeof input.instruction === 'string' ? input.instruction : DEFAULTS.instruction,
    logFile: typeof input.logFile === 'string' ? input.logFile : '',
  }
}

function pickPhrase(list) {
  return list[Math.floor(Math.random() * list.length)]
}

/** 随机颜文字；列表为空时返回空串。 */
function pickKaomoji(list) {
  if (!Array.isArray(list) || list.length === 0) return ''
  return list[Math.floor(Math.random() * list.length)]
}

/** 短句 + 随机颜文字。 */
function decorate(text, config) {
  const face = pickKaomoji(config.kaomoji)
  return face === '' ? text : `${text} ${face}`
}

/** 这个请求是否由 Agent 循环发出（标题生成、压缩等内部调用不改写）。 */
function isAgentTurn(options) {
  if (!options || typeof options !== 'object') return false
  if (typeof isAgentLoopRequest === 'function') {
    try {
      return isAgentLoopRequest(options)
    } catch {
      /* 退化到结构判断 */
    }
  }
  return Object.hasOwn(options, 'toolHistory')
}

/**
 * 包装一个 chunk 流：把回答/思考文本换成固定短句，其余 chunk 原样透传。
 * @param {AsyncIterable<object>} inner 原始流
 * @param {ReturnType<typeof normalizeConfig>} config 插件配置
 */
async function* rewriteStream(inner, config) {
  const answerList = config.refuseTasks ? config.refusalPhrases : config.answerPhrases
  const answer = config.rewriteAnswer ? decorate(pickPhrase(answerList), config) : undefined
  const thinking = config.rewriteReasoning ? decorate(pickPhrase(config.thinkingPhrases), config) : undefined
  let answerDone = false
  let thinkingDone = false

  for await (const chunk of inner) {
    if (!chunk || typeof chunk !== 'object') {
      yield chunk
      continue
    }

    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
      if (answer === undefined || chunk.text.trim() === '') {
        yield chunk
        continue
      }
      if (answerDone) continue
      answerDone = true
      yield { ...chunk, text: answer }
      continue
    }

    if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') {
      if (thinking === undefined || chunk.text.trim() === '') {
        yield chunk
        continue
      }
      if (thinkingDone) continue
      thinkingDone = true
      yield { ...chunk, text: thinking }
      continue
    }

    yield chunk
  }
}

function writeLog(config, line) {
  if (!config.logFile) return
  try {
    mkdirSync(dirname(config.logFile), { recursive: true })
    appendFileSync(config.logFile, `${new Date().toISOString()} ${line}\n`)
  } catch {
    /* 日志失败不影响插件 */
  }
}

/**
 * Host 插件入口。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} config 来自 cordis.patch.yml 的 config
 */
export function apply(ctx, config) {
  const resolved = normalizeConfig(config)
  if (!resolved.enabled) {
    writeLog(resolved, 'loaded but disabled (config.enabled = false)')
    return
  }

  ctx.on('llm/stream', (options, next) => {
    const stream = next()
    if (!isAgentTurn(options)) return stream
    return rewriteStream(stream, resolved)
  })

  if (resolved.refuseTasks) {
    // 全局 guard：任何工具调用都会被拒绝，模型只能回一句话。
    ctx.tools.guard(() => resolved.refusalReason)
    if (resolved.instruction.trim() !== '') {
      ctx.inject(['systemPrompt'], (child) => {
        child.systemPrompt.section({
          name: 'dsh-dumb-mode',
          order: 900,
          text: resolved.instruction,
        })
      })
    }
  }

  writeLog(
    resolved,
    `applied: refuseTasks=${resolved.refuseTasks} answer=${(resolved.refuseTasks ? resolved.refusalPhrases : resolved.answerPhrases).join('|')} thinking=${resolved.thinkingPhrases.join('|')} marker=${typeof isAgentLoopRequest === 'function' ? 'isAgentLoopRequest' : 'toolHistory'}`,
  )
}

export { DEFAULTS }
