const { postJson, request } = require('./httpClient');
const { config } = require('./config');
const { getSettings, getActivePrompt, getSecrets, getLlmCandidates } = require('./store');

function cashtag(symbol) { return `$${String(symbol || '').replace(/^\$/, '').toUpperCase()}`; }
function compactText(text) {
  return String(text || '').replace(/^```[a-z]*\s*/i, '').replace(/```$/i, '').replace(/[“”]/g, '').trim();
}
function renderTemplate(template, pack, settings = getSettings()) {
  const lead = pack.trio.lead.symbol;
  const peer = pack.trio.peer.symbol;
  const anchor = pack.trio.anchor.symbol;
  const voiceAngles = [
    '先看谁在抢主动权，再看谁只是被情绪带着跑。',
    '从合约拥挤度和盘口承接切入，别写成涨跌榜复读。',
    '用交易员盘中复盘口吻，重点写强弱差和下一步观察位。',
    '从情绪是否过热切入，语气克制但要有判断。',
    '用一句盘感开场，然后用数据把主动腿、跟随腿、风险锚串起来。',
    '避免固定开头，像刚盯完盘顺手发的一段观察。'
  ];
  const voiceAngle = voiceAngles[Math.floor(Math.random() * voiceAngles.length)];
  const vars = {
    JOB_NAME: settings.jobName || '',
    JOB_DESCRIPTION: settings.jobDescription || '',
    LANGUAGE: settings.language || '',
    STYLE_GUIDE: settings.styleGuide || '',
    CONTENT_SOURCE: settings.contentSource || '',
    POST_TARGET: settings.postTarget || '',
    VOICE_ANGLE: voiceAngle,
    MIN_POST_CHARS: String(settings.minPostChars || 55),
    MAX_POST_CHARS: String(settings.maxPostChars || 110),
    LEAD: lead,
    PEER: peer,
    ANCHOR: anchor,
    LEAD_CASHTAG: cashtag(lead),
    PEER_CASHTAG: cashtag(peer),
    ANCHOR_CASHTAG: cashtag(anchor),
    FACTS: (pack.facts || []).join('\n'),
    TAKEAWAYS: (pack.takeaways || []).join('\n'),
    MARKET_PACK_JSON: JSON.stringify(pack, null, 2)
  };
  return String(template || '').replace(/\{\{\s*([A-Z0-9_]+)\s*\}\}/g, (_, key) => vars[key] ?? '');
}

function mockGenerate(pack) {
  const { lead, peer, anchor } = pack.trio;
  const l = cashtag(lead.symbol), p = cashtag(peer.symbol), a = cashtag(anchor.symbol);
  const leadStronger = Number(lead.change1h || 0) >= Number(peer.change1h || 0);
  if (leadStronger) return `${l} 今天更像主动腿，${p} 只是跟着放波动，${a} 还在给风险偏好定锚；这波我先看承接和换手，不急着追。`;
  return `${l} 负责把波动打出来，${p} 短线弹性反而更冲，${a} 还在给风险偏好定锚；这波我先看换手，不急着追。`;
}

async function callOpenAI(prompt, settings) {
  const secrets = getSecrets();
  const apiKey = secrets.openaiApiKey;
  if (!apiKey) throw new Error('missing_openai_api_key');
  return callOpenAIWithCandidate(prompt, {
    channelId: 'legacy',
    channelName: 'Legacy settings',
    apiKey,
    baseUrl: settings.openaiBaseUrl || config.openaiBaseUrl || 'https://api.openai.com/v1',
    model: settings.openaiModel || config.openaiModel,
    temperature: settings.openaiTemperature ?? config.openaiTemperature ?? 0.8,
    maxTokens: settings.openaiMaxTokens ?? config.openaiMaxTokens,
    timeoutMs: settings.openaiTimeoutMs || config.openaiTimeoutMs || 45000
  });
}

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!content) return '';
  if (Array.isArray(content)) return content.map(textFromContent).join('');
  if (typeof content === 'object') {
    if (typeof content.text === 'string') return content.text;
    if (typeof content.value === 'string') return content.value;
    if (typeof content.content === 'string') return content.content;
    if (Array.isArray(content.content)) return textFromContent(content.content);
    if (typeof content.output_text === 'string') return content.output_text;
  }
  return '';
}

function extractChoiceText(json) {
  const candidates = [];
  if (typeof json?.output_text === 'string') candidates.push(json.output_text);
  if (Array.isArray(json?.choices)) {
    for (const choice of json.choices) {
      candidates.push(textFromContent(choice?.message?.content));
      candidates.push(textFromContent(choice?.delta?.content));
      candidates.push(textFromContent(choice?.text));
    }
  }
  if (Array.isArray(json?.output)) {
    for (const item of json.output) {
      candidates.push(textFromContent(item?.content));
      candidates.push(textFromContent(item?.text));
      candidates.push(textFromContent(item?.output_text));
    }
  }
  candidates.push(textFromContent(json?.content));
  return candidates.map(x => String(x || '').trim()).find(Boolean) || '';
}

function isReasoningLikeModel(candidateOrModel = '') {
  if (typeof candidateOrModel === 'object' && candidateOrModel) return candidateOrModel.reasoning === true;
  return false;
}

function effectiveMaxTokens(candidate = {}) {
  const requested = Number(candidate.maxTokens ?? config.openaiMaxTokens);
  const base = Number.isFinite(requested) && requested > 0 ? requested : Number(config.openaiMaxTokens || 180);
  // GPT-5 / o-series compatible relays may spend part of max_tokens on hidden reasoning.
  // Keep visible output short via post validation, but avoid content=null caused by too-small budgets.
  if (isReasoningLikeModel(candidate)) return Math.max(base, 800);
  return base;
}

function normalizeApiMode(value = 'auto') {
  const v = String(value || 'auto').trim().toLowerCase().replace(/_/g, '-');
  if (['auto', 'chat', 'completions', 'responses'].includes(v)) return v;
  if (['chat-completions', 'openai-completions', 'openai-chat-completions'].includes(v)) return 'chat';
  if (['legacy', 'legacy-completions', 'text-completions', 'openai-legacy-completions'].includes(v)) return 'completions';
  return 'auto';
}

function shortJson(json, max = 240) {
  try { return JSON.stringify(json).slice(0, max); } catch { return String(json).slice(0, max); }
}

function extractSseText(body = '') {
  let text = '';
  const lines = String(body || '').split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    let json;
    try { json = JSON.parse(data); } catch { continue; }

    if (typeof json.delta === 'string') text += json.delta;
    if (typeof json.output_text === 'string') text += json.output_text;
    if (typeof json.response?.output_text === 'string') text += json.response.output_text;

    if (Array.isArray(json.choices)) {
      for (const choice of json.choices) {
        text += textFromContent(choice?.delta?.content);
        text += textFromContent(choice?.message?.content);
        text += textFromContent(choice?.text);
      }
    }
    if (Array.isArray(json.output)) {
      for (const item of json.output) {
        text += textFromContent(item?.content);
        text += textFromContent(item?.text);
        text += textFromContent(item?.output_text);
      }
    }
  }
  return text;
}

async function postJsonSse(url, payload, { headers = {}, timeoutMs = 45000 } = {}) {
  const res = await request('POST', url, {
    headers: {
      'User-Agent': 'binance-square-autopost-service/0.1',
      Accept: 'text/event-stream, application/json',
      'Content-Type': 'application/json',
      ...headers
    },
    body: JSON.stringify(payload),
    timeoutMs
  });
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(`http_${res.statusCode}:${String(res.body || '').slice(0, 300)}`);
  }
  return res.body;
}

async function callOpenAIWithCandidate(prompt, candidate) {
  if (!candidate?.apiKey) throw new Error('missing_openai_api_key');
  const baseUrl = String(candidate.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const chatUrl = `${baseUrl}/chat/completions`;
  const completionsUrl = `${baseUrl}/completions`;
  const responsesUrl = `${baseUrl}/responses`;
  const apiMode = normalizeApiMode(candidate.apiMode || 'auto');
  const reasoningLike = isReasoningLikeModel(candidate);
  const timeoutMs = Number(candidate.timeoutMs || config.openaiTimeoutMs || 45000);
  const headers = { Authorization: `Bearer ${candidate.apiKey}` };
  const systemText = '你只输出最终可发布的纯文本短帖，不解释过程。';
  const maybeTemperature = () => {
    // Several GPT-5/o-series relays either reject or silently mishandle non-default temperature.
    if (reasoningLike) return {};
    return { temperature: Number(candidate.temperature ?? config.openaiTemperature ?? 0.8) };
  };
  const model = candidate.model || config.openaiModel;
  const runChat = async (maxTokens, tokenParam = reasoningLike ? 'max_completion_tokens' : 'max_tokens') => {
    const payload = {
      model,
      ...maybeTemperature(),
      messages: [
        { role: 'system', content: systemText },
        { role: 'user', content: prompt }
      ]
    };
    if (Number.isFinite(maxTokens) && maxTokens > 0) payload[tokenParam] = maxTokens;
    let json;
    try {
      json = await postJson(chatUrl, payload, { headers, timeoutMs });
    } catch (err) {
      // Some OpenAI-compatible relays do not support max_completion_tokens yet.
      if (tokenParam === 'max_completion_tokens' && /http_400|unsupported|unknown|max_completion_tokens/i.test(err.message || '')) {
        return runChat(maxTokens, 'max_tokens');
      }
      throw err;
    }
    return { label: `chat/completions:${tokenParam}:${maxTokens || 'none'}`, json, text: compactText(extractChoiceText(json)) };
  };
  const runChatStream = async (maxTokens, tokenParam = reasoningLike ? 'max_completion_tokens' : 'max_tokens') => {
    const payload = {
      model,
      ...maybeTemperature(),
      stream: true,
      stream_options: { include_usage: true },
      messages: [
        { role: 'system', content: systemText },
        { role: 'user', content: prompt }
      ]
    };
    if (Number.isFinite(maxTokens) && maxTokens > 0) payload[tokenParam] = maxTokens;
    let body;
    try {
      body = await postJsonSse(chatUrl, payload, { headers, timeoutMs });
    } catch (err) {
      if (tokenParam === 'max_completion_tokens' && /http_400|unsupported|unknown|max_completion_tokens/i.test(err.message || '')) {
        return runChatStream(maxTokens, 'max_tokens');
      }
      throw err;
    }
    return { label: `chat/completions:stream:${tokenParam}:${maxTokens || 'none'}`, json: { stream: true, sample: String(body || '').slice(0, 240) }, text: compactText(extractSseText(body)) };
  };
  const runCompletions = async (maxTokens) => {
    const payload = {
      model,
      prompt: `${systemText}\n\n${prompt}\n`,
      ...maybeTemperature()
    };
    if (Number.isFinite(maxTokens) && maxTokens > 0) payload.max_tokens = maxTokens;
    const json = await postJson(completionsUrl, payload, { headers, timeoutMs });
    return { label: `completions:max_tokens:${maxTokens || 'none'}`, json, text: compactText(extractChoiceText(json)) };
  };
  const runResponses = async (maxTokens) => {
    const payload = {
      model,
      instructions: systemText,
      input: prompt,
      ...maybeTemperature()
    };
    if (Number.isFinite(maxTokens) && maxTokens > 0) payload.max_output_tokens = maxTokens;
    const json = await postJson(responsesUrl, payload, { headers, timeoutMs });
    return { label: `responses:max_output_tokens:${maxTokens || 'none'}`, json, text: compactText(extractChoiceText(json)) };
  };

  const runResponsesStream = async (maxTokens) => {
    const payload = {
      model,
      instructions: systemText,
      input: prompt,
      stream: true,
      ...maybeTemperature()
    };
    if (Number.isFinite(maxTokens) && maxTokens > 0) payload.max_output_tokens = maxTokens;
    const body = await postJsonSse(responsesUrl, payload, { headers, timeoutMs });
    return { label: `responses:stream:max_output_tokens:${maxTokens || 'none'}`, json: { stream: true, sample: String(body || '').slice(0, 240) }, text: compactText(extractSseText(body)) };
  };

  const firstMaxTokens = effectiveMaxTokens(candidate);
  let attempts = [];
  if (apiMode === 'chat') {
    attempts = reasoningLike
      ? [
          () => runChat(firstMaxTokens, 'max_completion_tokens'),
          () => runChatStream(firstMaxTokens, 'max_completion_tokens'),
          () => runChat(Math.max(firstMaxTokens, 1200), 'max_tokens'),
          () => runChatStream(Math.max(firstMaxTokens, 1200), 'max_tokens')
        ]
      : [
          () => runChat(firstMaxTokens, 'max_tokens'),
          () => runChatStream(firstMaxTokens, 'max_tokens')
        ];
  } else if (apiMode === 'completions') {
    attempts = [() => runCompletions(firstMaxTokens)];
  } else if (apiMode === 'responses') {
    attempts = [() => runResponses(firstMaxTokens), () => runResponsesStream(firstMaxTokens)];
  } else if (reasoningLike) {
    attempts = [
      () => runChat(firstMaxTokens, 'max_completion_tokens'),
      () => runChatStream(firstMaxTokens, 'max_completion_tokens'),
      () => runChat(Math.max(firstMaxTokens, 1200), 'max_tokens'),
      () => runChatStream(Math.max(firstMaxTokens, 1200), 'max_tokens'),
      () => runResponses(Math.max(firstMaxTokens, 1200)),
      () => runResponsesStream(Math.max(firstMaxTokens, 1200)),
      () => runCompletions(Math.max(firstMaxTokens, 1200)),
      () => runChat(4096, 'max_tokens'),
      () => runChatStream(4096, 'max_tokens'),
      () => runResponses(4096),
      () => runResponsesStream(4096),
      () => runCompletions(4096)
    ];
  } else {
    attempts = [
      () => runChat(firstMaxTokens, 'max_tokens'),
      () => runChatStream(firstMaxTokens, 'max_tokens'),
      () => runCompletions(firstMaxTokens),
      () => runResponses(firstMaxTokens),
      () => runResponsesStream(firstMaxTokens)
    ];
  }

  const errors = [];
  for (const attempt of attempts) {
    try {
      const result = await attempt();
      if (result.text) return result.text;
      errors.push(`${result.label}:empty:${shortJson(result.json)}`);
    } catch (err) {
      errors.push(`${err.message || String(err)}`);
    }
  }
  throw new Error(`llm_no_text_output:${errors.join(' | ')}`);
}

function validatePostText(text, pack, settings = getSettings()) {
  const errors = [];
  const clean = compactText(text);
  const len = [...clean].length;
  if (len < Number(settings.minPostChars || 55)) errors.push(`too_short:${len}`);
  if (len > Number(settings.maxPostChars || 110)) errors.push(`too_long:${len}`);
  if (/不构成投资建议|以上仅供参考|公开信息显示|简短原因|简要原因|可能原因/.test(clean)) errors.push('template_or_disclaimer_phrase');
  if (settings.requireCashtags) {
    for (const symbol of [pack.trio.lead.symbol, pack.trio.peer.symbol, pack.trio.anchor.symbol]) {
      if (!clean.includes(cashtag(symbol))) errors.push(`missing_cashtag:${symbol}`);
    }
  }
  return { ok: errors.length === 0, errors, text: clean, length: len };
}

function validationError(validation) {
  return `post_validation_failed:${validation.errors.join(',')}`;
}

function repairPromptForPost(text, validation, pack, settings = getSettings()) {
  const min = Number(settings.minPostChars || 55);
  const max = Number(settings.maxPostChars || 110);
  const symbols = [pack.trio.lead.symbol, pack.trio.peer.symbol, pack.trio.anchor.symbol];
  const tags = symbols.map(cashtag).join(' ');
  return `下面这条 Binance Square 正文已经生成，但没有通过本地校验：${validation.errors.join(',')}。

请只输出改写后的最终正文，不解释过程。

硬性要求：
1. 字数必须在 ${min} 到 ${max} 个中文字符之间，不能超过 ${max}。
2. 必须保留并自然提到这 3 个 Cashtag：${tags}。
3. 必须写出谁更强、谁跟随、谁是风险锚/情绪锚、接下来盯什么。
4. 只能使用 facts / takeaways 里的真实数据，禁止编造。
5. 不要标题、不要项目符号、不要免责声明、不要报告腔。

原文：
${text}

facts：
${(pack.facts || []).join('\n')}

交易解读：
${(pack.takeaways || []).join('\n')}`;
}

async function repairPostText(text, validation, pack, settings, candidate) {
  const repairCandidate = { ...candidate };
  const requested = Number(repairCandidate.maxTokens || config.openaiMaxTokens || 1024);
  repairCandidate.maxTokens = Math.max(512, Math.min(requested || 1024, 2048));
  const repairedText = await callOpenAIWithCandidate(repairPromptForPost(text, validation, pack, settings), repairCandidate);
  const repairedValidation = validatePostText(repairedText, pack, settings);
  return { text: repairedText, validation: repairedValidation };
}

async function generatePost(pack) {
  const settings = getSettings();
  const prompt = getActivePrompt();
  if (!prompt) throw new Error('no_active_prompt');
  const renderedPrompt = renderTemplate(prompt.content, pack, settings);
  const provider = String(settings.llmProvider || config.llmProvider || 'mock').toLowerCase();
  if (provider === 'mock') {
    const text = mockGenerate(pack);
    const validation = validatePostText(text, pack, settings);
    if (!validation.ok) throw new Error(`${validationError(validation)}:text=${validation.text}`);
    return { text: validation.text, promptId: prompt.id, promptName: prompt.name, provider, model: 'mock', renderedPrompt, attempts: [{ provider, model: 'mock', ok: true }] };
  }

  const candidates = getLlmCandidates();
  const attempts = [];
  if (candidates.length) {
    for (const candidate of candidates) {
      const label = `${candidate.channelName || candidate.channelId}/${candidate.model}`;
      try {
        const text = await callOpenAIWithCandidate(renderedPrompt, candidate);
        const validation = validatePostText(text, pack, settings);
        if (!validation.ok) {
          try {
            const repaired = await repairPostText(text, validation, pack, settings, candidate);
            if (repaired.validation.ok) {
              attempts.push({ channelId: candidate.channelId, channelName: candidate.channelName, model: candidate.model, ok: true, repaired: true, originalError: validationError(validation), originalLength: validation.length, repairedLength: repaired.validation.length });
              return {
                text: repaired.validation.text,
                promptId: prompt.id,
                promptName: prompt.name,
                provider,
                channelId: candidate.channelId,
                channelName: candidate.channelName,
                model: candidate.model,
                renderedPrompt,
                attempts
              };
            }
            attempts.push({ channelId: candidate.channelId, channelName: candidate.channelName, model: candidate.model, ok: false, error: `${validationError(validation)}; repair_failed:${validationError(repaired.validation)}`, text: validation.text, repairedText: repaired.validation.text });
          } catch (repairErr) {
            attempts.push({ channelId: candidate.channelId, channelName: candidate.channelName, model: candidate.model, ok: false, error: `${validationError(validation)}; repair_error:${repairErr.message || String(repairErr)}`, text: validation.text });
          }
          continue;
        }
        attempts.push({ channelId: candidate.channelId, channelName: candidate.channelName, model: candidate.model, ok: true });
        return {
          text: validation.text,
          promptId: prompt.id,
          promptName: prompt.name,
          provider,
          channelId: candidate.channelId,
          channelName: candidate.channelName,
          model: candidate.model,
          renderedPrompt,
          attempts
        };
      } catch (err) {
        attempts.push({ channelId: candidate.channelId, channelName: candidate.channelName, model: candidate.model, ok: false, error: err.message || String(err) });
        console.warn(`[llm] candidate failed: ${label}: ${err.message || err}`);
      }
    }
    throw new Error(`llm_all_candidates_failed:${attempts.map(a => `${a.channelName || a.channelId}/${a.model}:${a.error}`).join(' | ')}`);
  }

  const text = await callOpenAI(renderedPrompt, settings);
  let validation = validatePostText(text, pack, settings);
  let finalText = validation.text;
  const legacyCandidate = {
    channelId: 'legacy',
    channelName: 'Legacy settings',
    apiKey: getSecrets().openaiApiKey,
    baseUrl: settings.openaiBaseUrl || config.openaiBaseUrl || 'https://api.openai.com/v1',
    model: settings.openaiModel || config.openaiModel,
    temperature: settings.openaiTemperature ?? config.openaiTemperature ?? 0.8,
    maxTokens: settings.openaiMaxTokens ?? config.openaiMaxTokens,
    timeoutMs: settings.openaiTimeoutMs || config.openaiTimeoutMs || 45000
  };
  const attemptsLegacy = [{ channelId: 'legacy', channelName: 'Legacy settings', model: settings.openaiModel || config.openaiModel, ok: validation.ok }];
  if (!validation.ok) {
    const repaired = await repairPostText(text, validation, pack, settings, legacyCandidate);
    validation = repaired.validation;
    finalText = validation.text;
    attemptsLegacy.push({ channelId: 'legacy', channelName: 'Legacy settings', model: settings.openaiModel || config.openaiModel, ok: validation.ok, repaired: true, length: validation.length });
  }
  if (!validation.ok) throw new Error(`${validationError(validation)}:text=${finalText}`);
  return { text: finalText, promptId: prompt.id, promptName: prompt.name, provider, channelId: 'legacy', channelName: 'Legacy settings', model: settings.openaiModel || config.openaiModel, renderedPrompt, attempts: attemptsLegacy };
}

module.exports = { generatePost, validatePostText, renderTemplate, cashtag, callOpenAIWithCandidate, effectiveMaxTokens };
