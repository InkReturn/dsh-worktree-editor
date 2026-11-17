/**
 * 根解析单测（设计 §4）：用临时目录夹具模拟主检出 / linked worktree / 降级目录。
 * 全部离线：不 spawn git、不触网。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  canonicalRoot,
  describeWorkingDirectoryRoot,
  resolveSessionRoot,
  UNCERTAIN_PHASES,
} from '../lib/root.js';

/**
 * 造一套临时夹具：主检出 + linked worktree + 普通目录。
 * @returns {{base: string, main: string, worktree: string, plain: string, cleanup: () => void}} 夹具路径与清理函数。
 */
function makeFixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-hub-root-'));
  // 1. 主检出：`.git` 是目录，里面只有 HEAD。
  const main = path.join(base, 'main');
  fs.mkdirSync(path.join(main, '.git'), { recursive: true });
  fs.writeFileSync(path.join(main, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  // 2. linked worktree：私有 gitdir 带 commondir，worktree 的 `.git` 是文件。
  const gitdir = path.join(base, 'gitdirs', 'wt1');
  fs.mkdirSync(gitdir, { recursive: true });
  fs.writeFileSync(path.join(gitdir, 'HEAD'), 'ref: refs/heads/feat-cs-hub\n');
  fs.writeFileSync(path.join(gitdir, 'commondir'), '../..\n');
  const worktree = path.join(base, 'wt');
  fs.mkdirSync(worktree, { recursive: true });
  fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${gitdir}\n`);
  // 3. 普通目录（非 git）。
  const plain = path.join(base, 'plain');
  fs.mkdirSync(plain, { recursive: true });
  return {
    base,
    main,
    worktree,
    plain,
    cleanup: () => fs.rmSync(base, { recursive: true, force: true }),
  };
}

/**
 * 造一个最小 host ctx（只实现 root.js 用到的 ctx.get 契约）。
 * @param {object} options 依赖注入。
 * @param {Map<string, {header: {cwd: string}}>} options.sessions 会话表。
 * @param {(session: object) => string} [options.workingDirectoryGet] 官方目录解析函数。
 * @param {(sessionId: string) => object} [options.worktreeRootResolve] 自定义 worktree 账本。
 * @returns {object} 假 ctx。
 */
function makeCtx({ sessions, workingDirectoryGet, worktreeRootResolve }) {
  return {
    get(name) {
      if (name === 'sessions') return { get: (id) => sessions.get(id) };
      if (name === 'workingDirectory') {
        return workingDirectoryGet === undefined ? undefined : { get: workingDirectoryGet };
      }
      if (name === 'worktreeRoot') {
        return worktreeRootResolve === undefined ? undefined : { resolve: worktreeRootResolve };
      }
      return undefined;
    },
  };
}

test('linked worktree：kind=worktree、分支来自私有 gitdir 的 HEAD、realRoot 为 canonical', (t) => {
  const fixture = makeFixture();
  t.after(fixture.cleanup);
  const sessions = new Map([['s1', { header: { cwd: fixture.worktree } }]]);
  const ctx = makeCtx({ sessions, workingDirectoryGet: (session) => session.header.cwd });
  const view = resolveSessionRoot(ctx, 's1');
  assert.equal(view.kind, 'worktree');
  assert.equal(view.branch, 'feat-cs-hub');
  assert.equal(view.phase, 'active');
  assert.equal(view.degraded, false);
  assert.equal(view.uncertain, false);
  assert.equal(view.root, fixture.worktree);
  assert.equal(view.realRoot, fs.realpathSync.native(fixture.worktree));
});

test('主检出：kind=session、分支 main', (t) => {
  const fixture = makeFixture();
  t.after(fixture.cleanup);
  const sessions = new Map([['s1', { header: { cwd: fixture.main } }]]);
  const ctx = makeCtx({ sessions, workingDirectoryGet: (session) => session.header.cwd });
  const view = resolveSessionRoot(ctx, 's1');
  assert.equal(view.kind, 'session');
  assert.equal(view.branch, 'main');
  assert.equal(view.phase, 'idle');
});

test('两个根服务都缺席：降级到 header.cwd 且 degraded=true', (t) => {
  const fixture = makeFixture();
  t.after(fixture.cleanup);
  const sessions = new Map([['s1', { header: { cwd: fixture.plain } }]]);
  const ctx = makeCtx({ sessions });
  const view = resolveSessionRoot(ctx, 's1');
  assert.equal(view.root, fixture.plain);
  assert.equal(view.degraded, true);
  assert.equal(view.kind, 'session');
});

test('会话不存在：抛 cs-hub/session-not-found', () => {
  const ctx = makeCtx({ sessions: new Map() });
  assert.throws(() => resolveSessionRoot(ctx, 'nope'), (error) => error.code === 'cs-hub/session-not-found');
});

test('根目录不存在：抛 cs-hub/root-missing', () => {
  const sessions = new Map([['s1', { header: { cwd: path.join(os.tmpdir(), 'cs-hub-definitely-missing-dir') } }]]);
  const ctx = makeCtx({ sessions });
  assert.throws(() => resolveSessionRoot(ctx, 's1'), (error) => error.code === 'cs-hub/root-missing');
});

test('相对路径 cwd 非法：抛 cs-hub/root-missing', () => {
  const sessions = new Map([['s1', { header: { cwd: 'relative/dir' } }]]);
  const ctx = makeCtx({ sessions });
  assert.throws(() => resolveSessionRoot(ctx, 's1'), (error) => error.code === 'cs-hub/root-missing');
});

test('不确定相 fail-closed：默认抛 root-uncertain，allowUncertain 时原样返回', (t) => {
  const fixture = makeFixture();
  t.after(fixture.cleanup);
  const sessions = new Map([['s1', { header: { cwd: fixture.worktree } }]]);
  const ctx = makeCtx({
    sessions,
    worktreeRootResolve: () => ({ kind: 'worktree', root: fixture.worktree, phase: 'blocked' }),
  });
  assert.throws(() => resolveSessionRoot(ctx, 's1'), (error) => error.code === 'cs-hub/root-uncertain');
  const view = resolveSessionRoot(ctx, 's1', { allowUncertain: true });
  assert.equal(view.uncertain, true);
  assert.equal(view.phase, 'blocked');
});

test('UNCERTAIN_PHASES 与设计一致', () => {
  assert.deepEqual([...UNCERTAIN_PHASES], ['blocked', 'entering', 'leaving']);
});

test('describeWorkingDirectoryRoot：非法/不存在返回 undefined', (t) => {
  const fixture = makeFixture();
  t.after(fixture.cleanup);
  assert.equal(describeWorkingDirectoryRoot('relative'), undefined);
  assert.equal(describeWorkingDirectoryRoot(path.join(fixture.base, 'nope')), undefined);
  assert.equal(describeWorkingDirectoryRoot(fixture.worktree).kind, 'worktree');
});

test('canonicalRoot：存在目录返回 canonical，不存在返回 undefined', (t) => {
  const fixture = makeFixture();
  t.after(fixture.cleanup);
  assert.equal(canonicalRoot(fixture.plain), fs.realpathSync.native(fixture.plain));
  assert.equal(canonicalRoot(path.join(fixture.base, 'nope')), undefined);
});
