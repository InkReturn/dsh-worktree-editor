/**
 * bridge HTTP 处理器单测（T11 / minor-12）：体上限 413、方法 405、令牌 401、写响应与路由。
 * 用假 req/res 桩，不监听端口、不触网。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { BRIDGE_BASE, BRIDGE_BODY_LIMIT, BRIDGE_TOKEN_HEADER, createBridgeHandler } from '../lib/bridge.js';

/** 测试令牌。 */
const TOKEN = 't11-token';

/**
 * 造一个假的 IncomingMessage。
 * @param {{method?: string, url?: string, headers?: object, body?: string|Buffer}} options 请求参数。
 * @returns {EventEmitter} 带 method/url/headers 的假请求（异步发 data/end）。
 */
function makeRequest({ method = 'GET', url = '/', headers = {}, body } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = headers;
  req.destroy = () => { req.destroyed = true; };
  queueMicrotask(() => {
    if (body !== undefined) req.emit('data', Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8'));
    req.emit('end');
  });
  return req;
}

/**
 * 造一个假的 ServerResponse，记录状态码/头/体。
 * @returns {object} 假响应对象。
 */
function makeResponse() {
  const chunks = [];
  return {
    writableEnded: false,
    destroyed: false,
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers ?? {};
    },
    end(chunk) {
      if (chunk !== undefined) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      this.writableEnded = true;
      this.body = Buffer.concat(chunks).toString('utf8');
    },
  };
}

/**
 * 造 bridge 处理器与假注册表。
 * @returns {{handler: object, broadcasts: object[]}} 处理器与广播记录。
 */
function makeBridge() {
  const broadcasts = [];
  const registry = { resolveByFolder: (folder) => (folder === 'C:/repo/wt' ? 'session-1' : undefined) };
  const handler = createBridgeHandler({
    registry,
    getToken: () => TOKEN,
    resolveReal: (value) => value.replace(/\\/gu, '/'),
  });
  return { handler, broadcasts };
}

/**
 * 跑一次请求。
 * @param {object} handler bridge 处理器。
 * @param {object} req 假请求。
 * @param {object[]} broadcasts 广播记录数组。
 * @returns {Promise<object>} 假响应对象。
 */
async function run(handler, req, broadcasts) {
  const res = makeResponse();
  await handler.handle(req, res, (event, data) => broadcasts.push({ event, data }));
  return res;
}

test('GET /health：200 + JSON，不需要令牌，不广播', async () => {
  const { handler, broadcasts } = makeBridge();
  const res = await run(handler, makeRequest({ url: `${BRIDGE_BASE}/health` }), broadcasts);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { ok: true });
  assert.match(res.headers['content-type'], /application\/json/u);
  assert.equal(broadcasts.length, 0);
});

test('POST /hello：先读有界体再验令牌，无令牌返回 401', async () => {
  const { handler, broadcasts } = makeBridge();
  const res = await run(handler, makeRequest({ method: 'POST', url: `${BRIDGE_BASE}/hello`, body: '{"folder":"C:\\\\repo\\\\wt"}' }), broadcasts);
  assert.equal(res.statusCode, 401);
  assert.deepEqual(JSON.parse(res.body), { ok: false, error: 'unauthorized' });
  assert.equal(broadcasts.length, 0);
});

test('GET /hello 带令牌：405 method-not-allowed', async () => {
  const { handler, broadcasts } = makeBridge();
  const res = await run(handler, makeRequest({ method: 'GET', url: `${BRIDGE_BASE}/hello`, headers: { [BRIDGE_TOKEN_HEADER]: TOKEN } }), broadcasts);
  assert.equal(res.statusCode, 405);
});

test('POST 体超上限：413 且请求被销毁', async () => {
  const { handler, broadcasts } = makeBridge();
  const huge = 'x'.repeat(BRIDGE_BODY_LIMIT + 10);
  const req = makeRequest({ method: 'POST', url: `${BRIDGE_BASE}/event`, headers: { [BRIDGE_TOKEN_HEADER]: TOKEN }, body: huge });
  const res = await run(handler, req, broadcasts);
  assert.equal(res.statusCode, 413);
  assert.deepEqual(JSON.parse(res.body), { ok: false, error: 'too-large' });
});

test('POST 非法 JSON：400 invalid-json', async () => {
  const { handler, broadcasts } = makeBridge();
  const res = await run(handler, makeRequest({ method: 'POST', url: `${BRIDGE_BASE}/hello`, headers: { [BRIDGE_TOKEN_HEADER]: TOKEN }, body: '{not-json' }), broadcasts);
  assert.equal(res.statusCode, 400);
});

test('POST /event 命中：200 routed:true 并广播一次 bridge-event', async () => {
  const { handler, broadcasts } = makeBridge();
  const res = await run(handler, makeRequest({
    method: 'POST',
    url: `${BRIDGE_BASE}/event`,
    headers: { [BRIDGE_TOKEN_HEADER]: TOKEN },
    body: JSON.stringify({ folder: 'C:\\repo\\wt', type: 'diff', payload: { file: 'a.ts' } }),
  }), broadcasts);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { routed: true });
  assert.equal(broadcasts.length, 1);
  assert.equal(broadcasts[0].event, 'bridge-event');
  assert.equal(broadcasts[0].data.sessionId, 'session-1');
});

test('POST /event 未命中：200 routed:false 且不广播（fail-closed）', async () => {
  const { handler, broadcasts } = makeBridge();
  const res = await run(handler, makeRequest({
    method: 'POST',
    url: `${BRIDGE_BASE}/event`,
    headers: { [BRIDGE_TOKEN_HEADER]: TOKEN },
    body: JSON.stringify({ folder: 'C:\\repo\\other', type: 'lock', payload: {} }),
  }), broadcasts);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { routed: false });
  assert.equal(broadcasts.length, 0);
});

test('带 Origin 头：403（即使令牌正确）', async () => {
  const { handler, broadcasts } = makeBridge();
  const res = await run(handler, makeRequest({
    method: 'POST',
    url: `${BRIDGE_BASE}/hello`,
    headers: { [BRIDGE_TOKEN_HEADER]: TOKEN, origin: 'http://evil' },
    body: '{"folder":"C:\\\\repo\\\\wt"}',
  }), broadcasts);
  assert.equal(res.statusCode, 403);
});

// ---- T21 公开版安全硬化：未认证请求不读请求体 ----

test('T21：未认证 POST 在读取请求体之前就被 401 挡住（请求体始终不 end）', async () => {
  const { handler, broadcasts } = makeBridge();
  const req = new EventEmitter();
  req.method = 'POST';
  req.url = `${BRIDGE_BASE}/hello`;
  req.headers = {};
  req.destroy = () => { req.destroyed = true; };
  const res = makeResponse();
  // 若实现仍在读体，这里会一直等 end ⇒ Promise 永不落地；用超时把它变成失败。
  const outcome = await Promise.race([
    handler.handle(req, res, (event, data) => broadcasts.push({ event, data })).then(() => 'handled'),
    new Promise((resolve) => { setTimeout(() => resolve('timeout'), 3000); }),
  ]);
  assert.equal(outcome, 'handled', '未认证 POST 不应等待请求体');
  assert.equal(res.statusCode, 401);
  assert.deepEqual(JSON.parse(res.body), { ok: false, error: 'unauthorized' });
  assert.equal(broadcasts.length, 0);
});

test('T21：超大请求体但无令牌 ⇒ 401（不是 413，说明未读体）', async () => {
  const { handler, broadcasts } = makeBridge();
  const huge = 'x'.repeat(BRIDGE_BODY_LIMIT + 10);
  const res = await run(handler, makeRequest({ method: 'POST', url: `${BRIDGE_BASE}/event`, body: huge }), broadcasts);
  assert.equal(res.statusCode, 401);
  assert.equal(broadcasts.length, 0);
});
