const { postJson } = require('./httpClient');
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
  const vars = {
    JOB_NAME: settings.jobName || '',
    JOB_DESCRIPTION: settings.jobDescription || '',
    LANGUAGE: settings.language || '',
    STYLE_GUIDE: settings.styleGuide || '',
    CONTENT_SOURCE: settings.contentSource || '',
    POST_TARGET: settings.postTarget || '',
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

function extractChoiceText(json) {
  const choice = json?.choices?.[0];
  const content = choice?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(part => {
      if (typeof part === 'string') return part;
      return part?.text || part?.content || '';
    }).join('');
  }
  if (typeof choice?.text === 'string') return choice.text;
  if (typeof json?.output_text === 'string') return json.output_text;
  if (Array.isArray(json?.output)) {
    return json.output.map(item => {
      if (typeof item?.content === 'string') return item.content;
      if (Array.isArray(item?.content)) {
        return item.content.map(part => part?.text || part?.value || part?.content || '').join('');
      }
      return item?.text || '';
    }).join('');
  }
  return '';
}

function isReasoningLikeModel(model = '') {
  return /(^|[/:_-])(gpt-5|o1|o3|o4|gpt-oss)/i.test(String(model || ''));
}

function effectiveMaxTokens(candidate = {}) {
  const requested = Number(candidate.maxTokens ?? config.openaiMaxTokens);
  const base = Number.isFinite(requested) && requested > 0 ? requested : Number(config.openaiMaxTokens || 180);
  // GPT-5 / o-series compatible relays may spend part of max_tokens on hidden reasoning.
  // Keep visible output short via post validation, but avoid content=null caused by too-small budgets.
  if (isReasoningLikeModel(candidate.model)) return Math.max(base, 800);
  return base;
}

async function callOpenAIWithCandidate(prompt, candidate) {
  if (!candidate?.apiKey) throw new Error('missing_openai_api_key');
  const baseUrl = String(candidate.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const chatUrl = `${baseUrl}/chat/completions`;
  const responsesUrl = `${baseUrl}/responses`;
  const reasoningLike = isReasoningLikeModel(candidate.model);
  const timeoutMs = Number(candidate.timeoutMs || config.openaiTimeoutMs || 45000);
  const headers = { Authorization: `Bearer ${candidate.apiKey}` };
  const maybeTemperature = () => {
    // Several GPT-5/o-series relays either reject or silently mishandle non-default temperature.
    if (reasoningLike) return {};
    return { temperature: Number(candidate.temperature ?? config.openaiTemperature ?? 0.8) };
  };
  const runChat = async (maxTokens, tokenParam = reasoningLike ? 'max_completion_tokens' : 'max_tokens') => {
    const payload = {
      model: candidate.model || config.openaiModel,
      ...maybeTemperature(),
      messages: [
        { role: 'system', content: '你只输出最终可发布的纯文本短帖，不解释过程。' },
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
    return { json, text: compactText(extractChoiceText(json)) };
  };
  const runResponses = async (maxTokens) => {
    const payload = {
      model: candidate.model || config.openaiModel,
      instructions: '你只输出最终可发布的纯文本短帖，不解释过程。',
      input: prompt,
      ...maybeTemperature()
    };
    if (Number.isFinite(maxTokens) && maxTokens > 0) payload.max_output_tokens = maxTokens;
    const json = await postJson(responsesUrl, payload, { headers, timeoutMs });
    return { json, text: compactText(extractChoiceText(json)) };
  };

  const firstMaxTokens = effectiveMaxTokens(candidate);
  const attempts = reasoningLike
    ? [
        () => runChat(firstMaxTokens, 'max_completion_tokens'),
        () => runChat(Math.max(firstMaxTokens, 1200), 'max_tokens'),
        () => runResponses(Math.max(firstMaxTokens, 1200)),
        () => runChat(4096, 'max_tokens'),
        () => runResponses(4096)
      ]
    : [
        () => runChat(firstMaxTokens, 'max_tokens'),
        () => runResponses(firstMaxTokens)
      ];
  let json = null;
  const errors = [];
  for (const attempt of attempts) {
    try {
      const result = await attempt();
      json = result.json;
      if (result.text) return result.text;
    } catch (err) {
      errors.push(err.message || String(err));
    }
  }
  if (!json && errors.length) throw new Error(`llm_request_failed:${errors.join(' | ')}`);
  throw new Error(`llm_empty_response:${JSON.stringify(json).slice(0, 300)}${errors.length ? `; fallback_errors=${errors.join(' | ')}` : ''}`);
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

async function generatePost(pack) {
  const settings = getSettings();
  const prompt = getActivePrompt();
  if (!prompt) throw new Error('no_active_prompt');
  const renderedPrompt = renderTemplate(prompt.content, pack, settings);
  const provider = String(settings.llmProvider || config.llmProvider || 'mock').toLowerCase();
  if (provider === 'mock') {
    const text = mockGenerate(pack);
    const validation = validatePostText(text, pack, settings);
    if (!validation.ok) throw new Error(`post_validation_failed:${validation.errors.join(',')}:text=${validation.text}`);
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
          attempts.push({ channelId: candidate.channelId, channelName: candidate.channelName, model: candidate.model, ok: false, error: `post_validation_failed:${validation.errors.join(',')}`, text: validation.text });
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
  const validation = validatePostText(text, pack, settings);
  if (!validation.ok) throw new Error(`post_validation_failed:${validation.errors.join(',')}:text=${validation.text}`);
  return { text: validation.text, promptId: prompt.id, promptName: prompt.name, provider, channelId: 'legacy', channelName: 'Legacy settings', model: settings.openaiModel || config.openaiModel, renderedPrompt, attempts: [{ channelId: 'legacy', channelName: 'Legacy settings', model: settings.openaiModel || config.openaiModel, ok: true }] };
}

module.exports = { generatePost, validatePostText, renderTemplate, cashtag, callOpenAIWithCandidate, effectiveMaxTokens };
