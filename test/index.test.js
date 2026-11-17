/**
 * index.js 接线单测（T11 / minor-12）：验证 apply 的注册面与 `session/event` → 注册表 → `state` 闭环。
 * 全部本地：假 ctx + 临时目录，不启动网络、不写 profile。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../index.js';

/**
 * 造一个假 host ctx，捕获 apply 注册的东西。
 * @param {{dirs: string[]}} options 每个会话指向的目录。
 * @returns {{ctx: object, captured: object, sessions: Map<string, object>}} ctx、捕获表与会话表。
 */
function makeCtx({ dirs }) {
  const sessions = new Map(dirs.map((dir, index) => [`s${index + 1}`, { id: `s${index + 1}`, header: { cwd: dir } }]));
  /** @type {Map<string, string>} 模拟官方 workingDirectory 服务：会话当前目录（事件发生时同步更新）。 */
  const workingDirs = new Map(dirs.map((dir, index) => [`s${index + 1}`, dir]));
  const captured = { rpc: null, fetch: null, bridge: null, listeners: new Map(), effects: [] };
  const ctx = {
    effect(fn, label) {
      const disposer = fn();
      captured.effects.push({ label, disposer });
      return () => {};
    },
    on(name, handler) {
      captured.listeners.set(name, handler);
      return () => {};
    },
    get(name) {
      if (name === 'sessions') return { get: (id) => sessions.get(id) };
      // 官方目录服务：真实 DSH 里它就是当前 cwd 的权威来源（事件前已更新）。
      if (name === 'workingDirectory') return { get: (session) => workingDirs.get(session.id) };
      return undefined;
    },
    connection: {
      rpc: { handle: (channel, dispatch) => { captured.rpc = { channel, dispatch }; return () => {}; } },
      fetch: { register: (route) => { captured.fetch = route; return () => {}; } },
    },
    webServer: { register: (route) => { captured.bridge = route; return () => {}; } },
  };
  return { ctx, captured, sessions, workingDirs };
}

test('apply 注册 RPC 频道 / SSE 路由 / session/event 监听（bridgeEnabled=false 不写令牌）', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-hub-index-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const { ctx, captured } = makeCtx({ dirs: [base] });
  await apply(ctx, { bridgeEnabled: false });
  assert.equal(captured.rpc.channel, '/cs-hub');
  assert.equal(captured.fetch.path, '/api/cs-hub/events');
  assert.deepEqual(captured.fetch.methods, ['GET']);
  assert.equal(typeof captured.listeners.get('session/event'), 'function');
  assert.equal(typeof captured.listeners.get('worktree-root/changed'), 'function');
  assert.equal(captured.bridge, null);
});

test('session/event 的 working-directory/change → 注册表更新 → state 只读可见（M1 后不接管）', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-hub-index-'));
  const dirA = path.join(base, 'a');
  const dirB = path.join(base, 'b');
  fs.mkdirSync(dirA, { recursive: true });
  fs.mkdirSync(dirB, { recursive: true });
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const { ctx, captured, sessions, workingDirs } = makeCtx({ dirs: [dirA] });
  await apply(ctx, { bridgeEnabled: false });
  const forward = captured.listeners.get('session/event');
  /**
   * 模拟一次真实切根（官方目录服务先更新，再发会话事件）。
   * @param {string} sessionId 会话 ID。
   * @param {string} dir 新目录。
   * @returns {void}
   */
  function changeRoot(sessionId, dir) {
    workingDirs.set(sessionId, dir);
    forward(sessions.get(sessionId), { type: 'working-directory/change', data: { cwd: dir } });
  }
  // 1. 首次根变化事件：会话被显式注册（这是所有权变更的显式入口）。
  changeRoot('s1', dirA);
  const first = await captured.rpc.dispatch('state', { sessionId: 's1' }, undefined);
  assert.equal(first.ok, true);
  assert.equal(first.value.window.sessionId, 's1');
  assert.equal(first.value.window.state, 'live');
  assert.equal(first.value.frameFolder, fs.realpathSync.native(dirA));
  // 2. 切根事件：注册表 folder/反查键更新。
  changeRoot('s1', dirB);
  const second = await captured.rpc.dispatch('state', { sessionId: 's1' }, undefined);
  assert.equal(second.value.frameFolder, fs.realpathSync.native(dirB));
  assert.equal(second.value.window.revision, 1);
  // 3. 无关事件不注册、不报错。
  forward(sessions.get('s1'), { type: 'message/appended', data: {} });
  assert.equal(second.value.window.stale, false);
});

test('apply 的 worktree-root/changed 兼容通道同样走注册表（root 非法时忽略）', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-hub-index-'));
  const dir = path.join(base, 'wt');
  fs.mkdirSync(dir, { recursive: true });
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const { ctx, captured } = makeCtx({ dirs: [dir] });
  await apply(ctx, { bridgeEnabled: false });
  const forward = captured.listeners.get('worktree-root/changed');
  // 1. 非法载荷直接忽略，不抛错。
  forward(null);
  forward({ sessionId: 's1' });
  // 2. 合法载荷注册。
  forward({ sessionId: 's1', root: dir });
  const state = await captured.rpc.dispatch('state', { sessionId: 's1' }, undefined);
  assert.equal(state.value.window.sessionId, 's1');
  assert.equal(state.value.frameFolder, fs.realpathSync.native(dir));
});

test('M2（T11）：冻结会话切根保持 frozen、更新 folder、不复活（无辜 live 窗不被挤）', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-hub-index-'));
  const dirA = path.join(base, 'a');
  const dirB = path.join(base, 'b');
  const dirC = path.join(base, 'c');
  fs.mkdirSync(dirA, { recursive: true });
  fs.mkdirSync(dirB, { recursive: true });
  fs.mkdirSync(dirC, { recursive: true });
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  // 上限 1：注册第二个会话会把第一个冻结。
  const { ctx, captured, sessions, workingDirs } = makeCtx({ dirs: [dirA, dirB] });
  await apply(ctx, { maxLiveWindows: 1, bridgeEnabled: false });
  const forward = captured.listeners.get('session/event');
  /**
   * 模拟一次真实切根（官方目录服务先更新，再发会话事件）。
   * @param {string} sessionId 会话 ID。
   * @param {string} dir 新目录。
   * @returns {void}
   */
  function changeRoot(sessionId, dir) {
    workingDirs.set(sessionId, dir);
    forward(sessions.get(sessionId), { type: 'working-directory/change', data: { cwd: dir } });
  }
  // 1. s1 先注册（live），s2 注册后 s1 被冻结。
  changeRoot('s1', dirA);
  changeRoot('s2', dirB);
  const frozen = await captured.rpc.dispatch('state', { sessionId: 's1' }, undefined);
  assert.equal(frozen.value.window.state, 'frozen');
  // 2. 冻结中的 s1 切根（dirA → dirC）：保持 frozen、folder/revision 更新。
  changeRoot('s1', dirC);
  const after = await captured.rpc.dispatch('state', { sessionId: 's1' }, undefined);
  assert.equal(after.value.window.state, 'frozen', '切根不得复活冻结窗口');
  assert.equal(after.value.frameFolder, fs.realpathSync.native(dirC));
  assert.equal(after.value.window.revision, 1);
  // 3. s2 仍 live（修复前 s1 复活会把 s2 挤成 frozen）。
  const s2State = await captured.rpc.dispatch('state', { sessionId: 's2' }, undefined);
  assert.equal(s2State.value.window.state, 'live');
});
