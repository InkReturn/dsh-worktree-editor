/**
 * bridge 路由单测（契约 v2 §4.4）：令牌校验、Origin 拒绝、fail-closed 反查、事件白名单。
 * 全部离线：不监听端口，只测纯判定函数。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  BRIDGE_BASE,
  BRIDGE_TOKEN_HEADER,
  evaluateBridgeRequest,
  rotateBridgeToken,
  sanitizeBridgeBody,
} from '../lib/bridge.js';

/** 令牌明文（测试专用，与生产无关）。 */
const TOKEN = 'test-token-value';
/** 假注册表：只认 `C:\repo\wt` 这个目录（realpath 用恒等函数模拟）。 */
const registry = { resolveByFolder: (folder) => (folder === 'C:/repo/wt' ? 'session-1' : undefined) };
/** realpath 桩：把反斜杠换成斜杠并折叠，模拟 canonical 化。 */
const resolveReal = (value) => value.replace(/\\/gu, '/');

/**
 * 便捷调用。
 * @param {object} overrides 覆盖项。
 * @returns {{status: number, body: object, broadcast: object|null}} 判定结果。
 */
function evaluate(overrides) {
  return evaluateBridgeRequest({
    method: 'GET',
    url: '',
    headers: {},
    registry,
    token: TOKEN,
    resolveReal,
    ...overrides,
  });
}

test('前缀外路径返回 404', () => {
  assert.equal(evaluate({ url: '/other/health' }).status, 404);
});

test('带 Origin 头一律 403（即使 token 正确）', () => {
  const result = evaluate({ url: `${BRIDGE_BASE}/health`, headers: { origin: 'http://evil' } });
  assert.equal(result.status, 403);
  assert.equal(result.body.error, 'origin-forbidden');
});

test('health 不需要令牌，返回 200 {ok:true}', () => {
  const result = evaluate({ url: `${BRIDGE_BASE}/health` });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { ok: true });
});

test('hello 缺令牌 / 错令牌一律 401', () => {
  assert.equal(evaluate({ method: 'POST', url: `${BRIDGE_BASE}/hello`, body: { folder: 'C:\\repo\\wt' } }).status, 401);
  assert.equal(evaluate({
    method: 'POST',
    url: `${BRIDGE_BASE}/hello`,
    headers: { [BRIDGE_TOKEN_HEADER]: 'wrong' },
    body: { folder: 'C:\\repo\\wt' },
  }).status, 401);
});

test('hello 命中反查返回 sessionId；未命中 404', () => {
  const hit = evaluate({
    method: 'POST',
    url: `${BRIDGE_BASE}/hello`,
    headers: { [BRIDGE_TOKEN_HEADER]: TOKEN },
    body: { folder: 'C:\\repo\\wt' },
  });
  assert.equal(hit.status, 200);
  assert.deepEqual(hit.body, { sessionId: 'session-1' });
  const miss = evaluate({
    method: 'POST',
    url: `${BRIDGE_BASE}/hello`,
    headers: { [BRIDGE_TOKEN_HEADER]: TOKEN },
    body: { folder: 'C:\\repo\\other' },
  });
  assert.equal(miss.status, 404);
});

test('event 命中：routed=true 并给出一次广播', () => {
  const result = evaluate({
    method: 'POST',
    url: `${BRIDGE_BASE}/event`,
    headers: { [BRIDGE_TOKEN_HEADER]: TOKEN },
    body: { folder: 'C:\\repo\\wt', type: 'diff', payload: { file: 'a.ts', hunks: [] } },
  });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { routed: true });
  assert.equal(result.broadcast.event, 'bridge-event');
  assert.equal(result.broadcast.data.sessionId, 'session-1');
  assert.equal(result.broadcast.data.type, 'diff');
});

test('event 未命中：routed=false 且**不广播**（fail-closed）', () => {
  const result = evaluate({
    method: 'POST',
    url: `${BRIDGE_BASE}/event`,
    headers: { [BRIDGE_TOKEN_HEADER]: TOKEN },
    body: { folder: 'C:\\repo\\other', type: 'lock', payload: { file: 'a.ts', readonly: true } },
  });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { routed: false });
  assert.equal(result.broadcast, null);
});

test('event 的 type 必须在白名单内，未知类型 400', () => {
  const result = evaluate({
    method: 'POST',
    url: `${BRIDGE_BASE}/event`,
    headers: { [BRIDGE_TOKEN_HEADER]: TOKEN },
    body: { folder: 'C:\\repo\\wt', type: 'exec', payload: {} },
  });
  assert.equal(result.status, 400);
  assert.equal(result.body.error, 'invalid-body');
});

test('sanitizeBridgeBody 不透传未知字段', () => {
  const sanitized = sanitizeBridgeBody({ folder: 'C:\\repo\\wt', type: 'follow', payload: { file: 'a.ts', line: 3 }, evil: 1 });
  assert.deepEqual(Object.keys(sanitized).sort(), ['folder', 'payload', 'type']);
});

test('方法不匹配返回 405（hello/event 只接受 POST）', () => {
  const result = evaluate({ method: 'GET', url: `${BRIDGE_BASE}/hello`, headers: { [BRIDGE_TOKEN_HEADER]: TOKEN } });
  assert.equal(result.status, 405);
});

test('realpath 抛错（目录不存在）时 hello 返回 404、event 返回 200 routed:false', () => {
  const exploding = () => { throw new Error('ENOENT'); };
  assert.equal(evaluateBridgeRequest({
    method: 'POST', url: `${BRIDGE_BASE}/hello`, headers: { [BRIDGE_TOKEN_HEADER]: TOKEN },
    body: { folder: 'C:\\repo\\wt' }, registry, token: TOKEN, resolveReal: exploding,
  }).status, 404);
  // 契约 §4.4：event 的「不可路由」统一 routed:false（不广播）；404 只留给 hello。
  const event = evaluateBridgeRequest({
    method: 'POST', url: `${BRIDGE_BASE}/event`, headers: { [BRIDGE_TOKEN_HEADER]: TOKEN },
    body: { folder: 'C:\\repo\\wt', type: 'diff', payload: {} }, registry, token: TOKEN, resolveReal: exploding,
  });
  assert.equal(event.status, 200);
  assert.deepEqual(event.body, { routed: false });
  assert.equal(event.broadcast, null);
});

test('令牌文件轮换：写入 <DSH_HOME>/cs-hub/bridge.json 且返回新令牌', async (t) => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-hub-bridge-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const first = rotateBridgeToken(home);
  const file = path.join(home, 'cs-hub', 'bridge.json');
  assert.equal(fs.existsSync(file), true);
  const written = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(written.token, first.token);
  assert.match(written.createdAt, /^\d{4}-\d{2}-\d{2}T/u);
  assert.equal(written.endpoint, `${BRIDGE_BASE}/{health,hello,event}`);
});
