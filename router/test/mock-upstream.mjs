// 测试用假上游：按模型名返回不同的失败形态，用来验证路由器的失败归因与切换策略。
import http from 'node:http';

const calls = [];
const PORT = Number(process.env.MOCK_PORT || 18799);

const server = http.createServer(async (req, res) => {
  if (req.url === '/__calls') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(calls));
    return;
  }
  if (req.url === '/__reset') { calls.length = 0; res.end('ok'); return; }

  const chunks = [];
  for await (const c of req) chunks.push(c);
  let body = {};
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { /* 保持空 */ }
  const model = body.model;
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  calls.push({
    model,
    temperature: body.temperature,
    auth: req.headers.authorization,
    rc: msgs.some((m) => m && m.reasoning_content != null),
    thinking: msgs.some((m) => m && m.thinking != null),
    eff: body.reasoning_effort != null,
    tools: Array.isArray(body.tools) ? body.tools.length : 0,
    fmt: !!body.response_format,
  });

  const call = calls[calls.length - 1];
  res.on('close', () => { call.closed = true; });
  const json = (st, obj) => { res.writeHead(st, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if (model === 'tier-classifier' || model === 'tier-classifier-expert') {
    const text = String(msgs.at(-1)?.content || '');
    const tier = model === 'tier-classifier-expert' ? 'EXPERT' : (text.match(/#TIER=(SIMPLE|CODING|COMPLEX|EXPERT)/)?.[1] || 'SIMPLE');
    return json(200, { choices: [{ message: { content: tier } }] });
  }
  const sse = (mode = 'done') => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"id":"mock","choices":[{"delta":{"role":"assistant"}}]}\n\n');
    res.write(': keepalive\n\n');
    res.write('data: {"id":"mock","choices":[{"delta":{"content":"ok"}}]}\n\n');
    if (mode === 'usage') res.write('data: {"id":"mock","choices":[],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}\n\n');
    if (mode === 'cut') { setTimeout(() => res.destroy(), 40); return; }
    if (mode === 'no-done') { res.end(); return; }
    res.write('data: [DONE]\n\n');
    res.end();
  };
  if (model === 'tools' || model === 'timeout' || model === 'delayed-headers') {
    const start = () => {
      if (res.destroyed) return;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n: heartbeat\n\n');
      if (model === 'timeout') return;
      setTimeout(() => {
        if (res.destroyed) return;
        res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"test","arguments":"{}"}}]}}]}\n\n');
        res.write('data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}\n\n');
        res.end('data: [DONE]\n\n');
      }, 80);
    };
    if (model === 'delayed-headers') setTimeout(start, 500);
    else start();
    return;
  }
  if (model === 'cut') return sse('cut');
  if (model === 'nodone') return sse('no-done');
  if (model === 'usage') return sse('usage');
  if (model === 'slow') {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"first"}}]}\n\n');
    setTimeout(() => { if (!res.destroyed) { res.write('data: [DONE]\n\n'); res.end(); } }, 500);
    return;
  }

  if (model === 'quota') {
    const t = new Date(Date.now() + 30000).toISOString().replace('T', ' ').slice(0, 19);
    return json(429, { error: { code: 'AccountQuotaExceeded', message: `You have exceeded the 5-hour usage quota. It will reset at ${t} +0000 UTC.`, type: 'TooManyRequests' } });
  }
  // 限流：一分钟窗口，短时间恢复——不能当「配额耗尽」熔断 15 分钟
  if (model === 'ratelimit') {
    return json(429, {
      error: {
        message: '[ReverixAI] Request rate limit reached\nAt most 30 requests per 1 minute(s) are allowed. Reduce submission frequency and wait for the limit window.',
        type: 'rate_limit_error',
      },
    });
  }
  if (model === 'balance') return json(403, { error: { message: 'Insufficient available balance', code: 'insufficient_user_quota', type: 'invalid_request_error' } });
  if (model === 'auth') return json(401, { error: { message: 'Invalid API key provided', type: 'authentication_error' } });
  if (model === 'nf') return json(404, { error: { message: 'The model `nf` does not exist', code: 'model_not_found' } });
  if (model === 'temp') {
    if (body.temperature !== 0.6) {
      return json(400, { error: { code: 'InvalidParameter', message: '`temperature` only 0.6 is allowed for this model', type: 'BadRequest' } });
    }
    return sse();
  }
  if (model === 'reqbad') return json(400, { error: { message: '"messages" is required', type: 'invalid_request_error' } });
  // Reverix 的真实形态：OpenAI→Anthropic 转换层拒绝思维链回显
  if (model === 'rc') {
    if (calls[calls.length - 1].rc) {
      return json(400, {
        error: {
          message: '[ReverixAI] Unsupported protocol conversion\nThis protocol conversion cannot preserve the requested feature in: messages.reasoning_content.',
          type: 'invalid_request_error',
        },
      });
    }
    return sse();
  }
  // DeepSeek 新版推理模型的真实形态：思维链**必须回传**，剥掉会 400
  if (model === 'rcmust') {
    if (!calls[calls.length - 1].rc) {
      return json(400, {
        error: {
          message: 'The `reasoning_content` in the thinking mode must be passed back to the API.',
          type: 'invalid_request_error',
        },
      });
    }
    return sse();
  }
  // 本地 Ollama 的真实形态：模型不支持 thinking
  if (model === 'think') {
    if (body.reasoning_effort != null) {
      return json(400, { error: { message: `"${model}" does not support thinking`, type: 'invalid_request_error' } });
    }
    return sse();
  }
  // 工具调用不被支持 → 应剥掉 tools 自愈重试，而不是整条链放弃
  if (model === 'notools') {
    if (Array.isArray(body.tools) && body.tools.length) {
      return json(400, { error: { message: 'tools is not supported by this model', type: 'invalid_request_error' } });
    }
    return sse();
  }
  // 未知 400：不是致命请求错误，应继续换下一个目标
  if (model === 'weird400') return json(400, { error: { message: 'unsupported input field: foo', type: 'invalid_request_error' } });
  // 上下文超限：属于模型级，换模型而不是拒绝请求
  if (model === 'ctx') return json(400, { error: { code: 'context_length_exceeded', message: "This model's maximum context length is 8192 tokens", type: 'invalid_request_error' } });
  // 单模型服务故障：上游 500 但只影响这个模型，换模型即可恢复
  if (model === 'flaky500' || model === 'dead500' || model === 'dead501') {
    return json(500, {
      error: {
        message: '[ReverixAI] Model service temporarily unavailable\nThe model service returned a service error. Please wait before trying again, or choose another available model.',
        type: 'server_error',
      },
    });
  }
  if (model === 'dead') { req.destroy(); return; }
  return sse();
});

server.listen(PORT, '127.0.0.1', () => console.log(`[mock] listening ${PORT}`));
