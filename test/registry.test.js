/**
 * 窗口注册表与 LRU 单测（设计 §6/§8、契约 §4.2）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWindowRegistry } from '../lib/registry.js';

/**
 * 构造一个可推进的假时钟。
 * @returns {{now: () => number, tick: (ms?: number) => void}} 时钟。
 */
function fakeClock() {
  let value = 1000;
  return {
    now: () => value,
    tick: (ms = 1) => { value += ms; },
  };
}

test('注册两个不同 folder 的会话：都在 live，反查命中各自的 canonical 路径', () => {
  const clock = fakeClock();
  const registry = createWindowRegistry({ maxLiveWindows: 3, now: clock.now });
  registry.register('s1', { root: 'C:\\a', realRoot: 'C:\\a' });
  registry.register('s2', { root: 'C:\\b', realRoot: 'C:\\b' });
  assert.equal(registry.liveCount, 2);
  assert.equal(registry.resolveByFolder('C:\\a'), 's1');
  assert.equal(registry.resolveByFolder('C:\\b'), 's2');
  assert.equal(registry.resolveByFolder('C:\\missing'), undefined);
  assert.equal(registry.list().length, 2);
});

test('超过上限时冻结最旧窗口（当前活动会话豁免）', () => {
  const clock = fakeClock();
  const registry = createWindowRegistry({ maxLiveWindows: 2, now: clock.now });
  registry.register('s1', { root: 'C:\\a', realRoot: 'C:\\a' });
  clock.tick(10);
  registry.register('s2', { root: 'C:\\b', realRoot: 'C:\\b' });
  clock.tick(10);
  // 第三次注册把最旧的 s1 冻结（s3 是当前会话，豁免）。
  const result = registry.register('s3', { root: 'C:\\c', realRoot: 'C:\\c' });
  assert.deepEqual(result.frozen, ['s1']);
  assert.equal(registry.liveCount, 2);
  const states = Object.fromEntries(registry.list().map((record) => [record.sessionId, record.state]));
  assert.deepEqual(states, { s1: 'frozen', s2: 'live', s3: 'live' });
});

test('touch 会刷新活跃时间，从而改变下一次 LRU 的牺牲者', () => {
  const clock = fakeClock();
  const registry = createWindowRegistry({ maxLiveWindows: 2, now: clock.now });
  registry.register('s1', { root: 'C:\\a', realRoot: 'C:\\a' });
  clock.tick(5);
  registry.register('s2', { root: 'C:\\b', realRoot: 'C:\\b' });
  clock.tick(5);
  registry.touch('s1');
  clock.tick(5);
  const result = registry.register('s3', { root: 'C:\\c', realRoot: 'C:\\c' });
  assert.deepEqual(result.frozen, ['s2']);
});

test('recover 把冻结窗口拉回 live，并可能冻结别的窗口', () => {
  const clock = fakeClock();
  const registry = createWindowRegistry({ maxLiveWindows: 1, now: clock.now });
  registry.register('s1', { root: 'C:\\a', realRoot: 'C:\\a' });
  clock.tick(5);
  registry.register('s2', { root: 'C:\\b', realRoot: 'C:\\b' });
  // s2 注册把 s1 冻结；现在恢复 s1 应该把 s2 冻结。
  const recovered = registry.recover('s1');
  assert.equal(recovered.record.state, 'live');
  assert.deepEqual(recovered.frozen, ['s2']);
  assert.equal(registry.liveCount, 1);
});

test('同一 folder 后注册者胜出：旧记录标 stale，反表指向新会话', () => {
  const clock = fakeClock();
  const registry = createWindowRegistry({ maxLiveWindows: 3, now: clock.now });
  registry.register('s1', { root: 'C:\\same', realRoot: 'C:\\same' });
  const result = registry.register('s2', { root: 'C:\\same', realRoot: 'C:\\same' });
  assert.deepEqual(result.conflict, { sessionId: 's1', folder: 'C:\\same' });
  assert.equal(registry.resolveByFolder('C:\\same'), 's2');
  const s1 = registry.list().find((record) => record.sessionId === 's1');
  assert.equal(s1.stale, true);
});

test('会话切 folder：revision 递增，旧反查键摘除', () => {
  const clock = fakeClock();
  const registry = createWindowRegistry({ maxLiveWindows: 3, now: clock.now });
  const first = registry.register('s1', { root: 'C:\\a', realRoot: 'C:\\a' });
  assert.equal(first.record.revision, 0);
  clock.tick(5);
  const second = registry.register('s1', { root: 'C:\\b', realRoot: 'C:\\b' });
  assert.equal(second.record.revision, 1);
  assert.equal(registry.resolveByFolder('C:\\a'), undefined);
  assert.equal(registry.resolveByFolder('C:\\b'), 's1');
});

test('destroy 幂等：移除正表与反表', () => {
  const clock = fakeClock();
  const registry = createWindowRegistry({ maxLiveWindows: 3, now: clock.now });
  registry.register('s1', { root: 'C:\\a', realRoot: 'C:\\a' });
  assert.equal(registry.destroy('s1'), true);
  assert.equal(registry.destroy('s1'), false);
  assert.equal(registry.resolveByFolder('C:\\a'), undefined);
  assert.equal(registry.list().length, 0);
});

test('未注册会话的 touch/recover 返回 undefined（不隐式建记录）', () => {
  const registry = createWindowRegistry({ maxLiveWindows: 3 });
  assert.equal(registry.touch('nope'), undefined);
  assert.equal(registry.recover('nope'), undefined);
});

test('setMax 收紧上限会冻结多余窗口', () => {
  const clock = fakeClock();
  const registry = createWindowRegistry({ maxLiveWindows: 3, now: clock.now });
  registry.register('s1', { root: 'C:\\a', realRoot: 'C:\\a' });
  clock.tick(5);
  registry.register('s2', { root: 'C:\\b', realRoot: 'C:\\b' });
  clock.tick(5);
  registry.register('s3', { root: 'C:\\c', realRoot: 'C:\\c' });
  const frozen = registry.setMax(1);
  assert.equal(frozen.length, 2);
  assert.equal(registry.liveCount, 1);
  assert.equal(registry.maxLiveWindows, 1);
});

test('preserveFrozen：state 重拉已冻结记录保持 frozen，不复活（T9）', () => {
  const clock = fakeClock();
  const registry = createWindowRegistry({ maxLiveWindows: 1, now: clock.now });
  registry.register('s1', { root: 'C:\\a', realRoot: 'C:\\a' });
  clock.tick(5);
  registry.register('s2', { root: 'C:\\b', realRoot: 'C:\\b' }); // 冻结 s1
  // 模拟 s1 的客户端因 window-frozen 重拉 state：preserveFrozen 必须保持冻结。
  const reloaded = registry.register('s1', { root: 'C:\\a', realRoot: 'C:\\a' }, { preserveFrozen: true });
  assert.equal(reloaded.record.state, 'frozen');
  assert.equal(registry.liveCount, 1);
  // 不带 preserveFrozen 的老口径仍会置 live（防止误改其它调用方语义）。
  const revived = registry.register('s1', { root: 'C:\\a', realRoot: 'C:\\a' });
  assert.equal(revived.record.state, 'live');
});

test('preserveFrozen 不刷新 lastActiveAt（冻结窗重拉不污染 LRU 排序）', () => {
  const clock = fakeClock();
  const registry = createWindowRegistry({ maxLiveWindows: 1, now: clock.now });
  registry.register('s1', { root: 'C:\\a', realRoot: 'C:\\a' });
  clock.tick(5);
  registry.register('s2', { root: 'C:\\b', realRoot: 'C:\\b' }); // 冻结 s1，lastActiveAt=1005
  const frozenAt = registry.list().find((record) => record.sessionId === 's1').lastActiveAt;
  clock.tick(100);
  registry.register('s1', { root: 'C:\\a', realRoot: 'C:\\a' }, { preserveFrozen: true });
  assert.equal(registry.list().find((record) => record.sessionId === 's1').lastActiveAt, frozenAt);
});

test('touch 不复活冻结窗口（复活只允许 recover）', () => {
  const clock = fakeClock();
  const registry = createWindowRegistry({ maxLiveWindows: 1, now: clock.now });
  registry.register('s1', { root: 'C:\\a', realRoot: 'C:\\a' });
  clock.tick(5);
  registry.register('s2', { root: 'C:\\b', realRoot: 'C:\\b' });
  const touched = registry.touch('s1');
  assert.equal(touched.record.state, 'frozen');
  assert.equal(registry.liveCount, 1);
});

test('recover 是唯一 frozen→live 入口；新会话首次注册仍是 live', () => {
  const clock = fakeClock();
  const registry = createWindowRegistry({ maxLiveWindows: 1, now: clock.now });
  registry.register('s1', { root: 'C:\\a', realRoot: 'C:\\a' });
  clock.tick(5);
  registry.register('s2', { root: 'C:\\b', realRoot: 'C:\\b' });
  const recovered = registry.recover('s1');
  assert.equal(recovered.record.state, 'live');
  // s1 恢复后 s2 被冻结（上限 1）。
  assert.deepEqual(recovered.frozen, ['s2']);
  // 新会话首次注册（带 preserveFrozen 也一样）必须是 live——这是懒注册，不是复活。
  const fresh = registry.register('s3', { root: 'C:\\c', realRoot: 'C:\\c' }, { preserveFrozen: true });
  assert.equal(fresh.record.state, 'live');
});
