/**
 * RPC 端点单测（契约 v2 §4.2）：信封形状、错误码、注册/LRU/销毁副作用、state 字段完整性。
 * 全部离线：假 ctx + 临时目录提供根，不碰网络与真实会话。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeConfig } from '../lib/config.js';
import { CS_HUB_ENDPOINTS, dispatchCsHubEndpoint } from '../lib/endpoints.js';
import { createWindowRegistry } from '../lib/registry.js';

/**
 * 造一套测试依赖：两个会话分别指向两个临时目录。
 * @param {{maxLiveWindows?: number}} [options] 配置覆盖。
 * @returns {object} { deps, sessions, cleanup, broadcasts }
 */
function makeHarness({ maxLiveWindows = 3 } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-hub-ep-'));
  const dirA = path.join(base, 'a');
  const dirB = path.join(base, 'b');
  fs.mkdirSync(dirA, { recursive: true });
  fs.mkdirSync(dirB, { recursive: true });
  const sessions = new Map([
    ['s1', { id: 's1', header: { cwd: dirA } }],
    ['s2', { id: 's2', header: { cwd: dirB } }],
  ]);
  const ctx = {
    get(name) {
      if (name === 'sessions') return { get: (id) => sessions.get(id) };
      return undefined;
    },
  };
  const broadcasts = [];
  const hub = { broadcast: (event, data) => broadcasts.push({ event, data }) };
  const config = normalizeConfig({ maxLiveWindows }, { warn: () => {} });
  const registry = createWindowRegistry({ maxLiveWindows: config.maxLiveWindows });
  return {
    deps: { ctx, config, registry, hub },
    sessions,
    broadcasts,
    dirs: { base, dirA, dirB },
    cleanup: () => fs.rmSync(base, { recursive: true, force: true }),
  };
}

test('端点白名单与契约一致', () => {
  assert.deepEqual([...CS_HUB_ENDPOINTS], ['state', 'window.touch', 'window.recover', 'window.destroy']);
});

test('未知端点：cs-hub/unknown-endpoint', async (t) => {
  const harness = makeHarness();
  t.after(harness.cleanup);
  const result = await dispatchCsHubEndpoint(harness.deps, 'nope', {}, new AbortController().signal);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'cs-hub/unknown-endpoint');
});

test('非法载荷（数组）：cs-hub/invalid-payload', async (t) => {
  const harness = makeHarness();
  t.after(harness.cleanup);
  const result = await dispatchCsHubEndpoint(harness.deps, 'state', [], undefined);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'cs-hub/invalid-payload');
});

test('sessionId 缺失/非法：cs-hub/invalid-payload', async (t) => {
  const harness = makeHarness();
  t.after(harness.cleanup);
  for (const payload of [{}, { sessionId: '' }, { sessionId: 42 }, { sessionId: 'a'.repeat(300) }]) {
    const result = await dispatchCsHubEndpoint(harness.deps, 'state', payload, undefined);
    assert.equal(result.error.code, 'cs-hub/invalid-payload');
  }
});

test('会话不存在：cs-hub/session-not-found', async (t) => {
  const harness = makeHarness();
  t.after(harness.cleanup);
  const result = await dispatchCsHubEndpoint(harness.deps, 'state', { sessionId: 'nope' }, undefined);
  assert.equal(result.error.code, 'cs-hub/session-not-found');
});

test('state 成功：字段齐全、frameFolder=canonical、server 只给配置面', async (t) => {
  const harness = makeHarness();
  t.after(harness.cleanup);
  const result = await dispatchCsHubEndpoint(harness.deps, 'state', { sessionId: 's1' }, undefined);
  assert.equal(result.ok, true);
  const value = result.value;
  assert.equal(value.ready, true);
  assert.equal(value.root.degraded, true); // 只有 sessions、没有 workingDirectory
  assert.equal(value.frameFolder, fs.realpathSync.native(harness.dirs.dirA));
  assert.deepEqual(Object.keys(value.server).sort(), ['allowLoopback', 'base', 'probeUrl']);
  assert.equal(value.server.base, '/code-server/');
  assert.equal(value.server.probeUrl, '/code-server/healthz');
  assert.deepEqual(value.limits, { maxLiveWindows: 3 });
  assert.equal(value.window.sessionId, 's1');
  assert.equal(value.window.state, 'live');
  assert.equal(value.windows.length, 1);
});

test('state 注册后 window.touch 返回记录；LRU 超限时冻结最旧并广播', async (t) => {
  const harness = makeHarness({ maxLiveWindows: 1 });
  t.after(harness.cleanup);
  await dispatchCsHubEndpoint(harness.deps, 'state', { sessionId: 's1' }, undefined);
  const touch = await dispatchCsHubEndpoint(harness.deps, 'window.touch', { sessionId: 's1' }, undefined);
  assert.equal(touch.ok, true);
  assert.equal(touch.value.window.sessionId, 's1');
  // s2 注册把 s1 冻结。
  const second = await dispatchCsHubEndpoint(harness.deps, 'state', { sessionId: 's2' }, undefined);
  assert.equal(second.value.windows.length, 2);
  const frozen = harness.broadcasts.filter((item) => item.event === 'window-frozen');
  assert.equal(frozen.length, 1);
  assert.equal(frozen[0].data.sessionId, 's1');
  assert.equal(frozen[0].data.reason, 'lru');
});

test('window.recover：冻结窗口恢复 live 并广播 window-live', async (t) => {
  const harness = makeHarness({ maxLiveWindows: 1 });
  t.after(harness.cleanup);
  await dispatchCsHubEndpoint(harness.deps, 'state', { sessionId: 's1' }, undefined);
  await dispatchCsHubEndpoint(harness.deps, 'state', { sessionId: 's2' }, undefined);
  const recover = await dispatchCsHubEndpoint(harness.deps, 'window.recover', { sessionId: 's1' }, undefined);
  assert.equal(recover.ok, true);
  assert.equal(recover.value.window.state, 'live');
  assert.deepEqual(recover.value.frozen, ['s2']);
  assert.equal(harness.broadcasts.some((item) => item.event === 'window-live' && item.data.sessionId === 's1'), true);
});

test('window.destroy 幂等：两次都返回 closed:true 且注册表清空', async (t) => {
  const harness = makeHarness();
  t.after(harness.cleanup);
  await dispatchCsHubEndpoint(harness.deps, 'state', { sessionId: 's1' }, undefined);
  const first = await dispatchCsHubEndpoint(harness.deps, 'window.destroy', { sessionId: 's1' }, undefined);
  const second = await dispatchCsHubEndpoint(harness.deps, 'window.destroy', { sessionId: 's1' }, undefined);
  assert.deepEqual(first.value, { closed: true });
  assert.deepEqual(second.value, { closed: true });
  assert.equal(harness.deps.registry.list().length, 0);
});

test('M1（T11）：同 folder 双会话只接管一次；后续 state 重拉不再接管/不再广播', async (t) => {
  const harness = makeHarness();
  t.after(harness.cleanup);
  // s1/s2 指向同一目录（真机很常见的「同 cwd 双会话」）。
  harness.sessions.set('s2', { id: 's2', header: { cwd: harness.dirs.dirA } });
  // 1. 首次注册：s1 拿到所有权。
  const first = await dispatchCsHubEndpoint(harness.deps, 'state', { sessionId: 's1' }, undefined);
  assert.equal(first.value.window.stale, false);
  // 2. s2 首次 state：显式接管一次（唯一一次冲突广播）。
  await dispatchCsHubEndpoint(harness.deps, 'state', { sessionId: 's2' }, undefined);
  const conflicts = harness.broadcasts.filter((item) => item.event === 'registry-conflict');
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].data.sessionId, 's1');
  // 3. 双方反复重拉 state：只读路径，不得再产生冲突广播（修复前这里会无限互踢）。
  for (let i = 0; i < 5; i += 1) {
    await dispatchCsHubEndpoint(harness.deps, 'state', { sessionId: 's1' }, undefined);
    await dispatchCsHubEndpoint(harness.deps, 'state', { sessionId: 's2' }, undefined);
  }
  assert.equal(harness.broadcasts.filter((item) => item.event === 'registry-conflict').length, 1);
  // 4. 所有权仍归 s2（被动读不改所有权），s1 记录保持 stale 供 UI 提示。
  assert.equal(harness.deps.registry.resolveByFolder(fs.realpathSync.native(harness.dirs.dirA)), 's2');
  assert.equal(harness.deps.registry.get('s1').stale, true);
  // 5. live 数不因重拉改变。
  assert.equal(harness.deps.registry.liveCount, 2);
});

test('同 folder 冲突：后注册者胜出并广播 registry-conflict', async (t) => {
  const harness = makeHarness();
  t.after(harness.cleanup);
  // 让 s2 与 s1 指向同一目录（模拟两个会话落在同一 worktree）。
  harness.sessions.set('s2', { id: 's2', header: { cwd: harness.dirs.dirA } });
  await dispatchCsHubEndpoint(harness.deps, 'state', { sessionId: 's1' }, undefined);
  await dispatchCsHubEndpoint(harness.deps, 'state', { sessionId: 's2' }, undefined);
  const conflict = harness.broadcasts.filter((item) => item.event === 'registry-conflict');
  assert.equal(conflict.length, 1);
  assert.equal(conflict[0].data.sessionId, 's1');
  assert.equal(conflict[0].data.takenBy, 's2');
  // 反查键是 canonical 路径（Windows 下 os.tmpdir() 可能是短名，必须用 realpath 再查）。
  assert.equal(harness.deps.registry.resolveByFolder(fs.realpathSync.native(harness.dirs.dirA)), 's2');
});

test('state 重拉已冻结会话：保持 frozen，不复活（T9 回归）', async (t) => {
  const harness = makeHarness({ maxLiveWindows: 1 });
  t.after(harness.cleanup);
  await dispatchCsHubEndpoint(harness.deps, 'state', { sessionId: 's1' }, undefined);
  // s2 注册把 s1 冻结（s1 是最旧的 live）。
  await dispatchCsHubEndpoint(harness.deps, 'state', { sessionId: 's2' }, undefined);
  assert.equal(harness.deps.registry.list().find((record) => record.sessionId === 's1').state, 'frozen');
  // 模拟 s1 的客户端收到 window-frozen 后重拉 state：必须仍是 frozen，且不产生新的 window-frozen 广播。
  const frozenBefore = harness.broadcasts.filter((item) => item.event === 'window-frozen').length;
  const reload = await dispatchCsHubEndpoint(harness.deps, 'state', { sessionId: 's1' }, undefined);
  assert.equal(reload.ok, true);
  assert.equal(reload.value.window.state, 'frozen');
  assert.equal(harness.deps.registry.liveCount, 1);
  assert.equal(harness.broadcasts.filter((item) => item.event === 'window-frozen').length, frozenBefore);
});

test('window.touch 不复活冻结会话；window.recover 才复活并重建（T9）', async (t) => {
  const harness = makeHarness({ maxLiveWindows: 1 });
  t.after(harness.cleanup);
  await dispatchCsHubEndpoint(harness.deps, 'state', { sessionId: 's1' }, undefined);
  await dispatchCsHubEndpoint(harness.deps, 'state', { sessionId: 's2' }, undefined);
  // 冻结窗收到 touch：状态不变（冻结窗的客户端本来也不该发 touch）。
  const touched = await dispatchCsHubEndpoint(harness.deps, 'window.touch', { sessionId: 's1' }, undefined);
  assert.equal(touched.value.window.state, 'frozen');
  // 恢复：置 live，把 s2 冻结，并广播 window-live（客户端据此重建 iframe）。
  const recover = await dispatchCsHubEndpoint(harness.deps, 'window.recover', { sessionId: 's1' }, undefined);
  assert.equal(recover.value.window.state, 'live');
  assert.deepEqual(recover.value.frozen, ['s2']);
  assert.equal(harness.broadcasts.some((item) => item.event === 'window-live' && item.data.sessionId === 's1'), true);
  // 恢复后再看 state：live 且 frameFolder 可用（客户端可据此重建 iframe）。
  const after = await dispatchCsHubEndpoint(harness.deps, 'state', { sessionId: 's1' }, undefined);
  assert.equal(after.value.window.state, 'live');
  assert.equal(typeof after.value.frameFolder, 'string');
});
