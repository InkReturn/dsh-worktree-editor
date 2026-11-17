/**
 * `normalizeConfig` 单测（契约 v2 §3.1 四字段）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, normalizeConfig, normalizeServerMount } from '../lib/config.js';

test('空输入回退四个默认值', () => {
  const config = normalizeConfig(undefined, { warn: () => {} });
  assert.deepEqual(config, { ...DEFAULT_CONFIG });
});

test('maxLiveWindows 合法整数原样保留，越界夹到 [1,6]', () => {
  assert.equal(normalizeConfig({ maxLiveWindows: 1 }, { warn: () => {} }).maxLiveWindows, 1);
  assert.equal(normalizeConfig({ maxLiveWindows: 6 }, { warn: () => {} }).maxLiveWindows, 6);
  assert.equal(normalizeConfig({ maxLiveWindows: 0 }, { warn: () => {} }).maxLiveWindows, 1);
  assert.equal(normalizeConfig({ maxLiveWindows: 99 }, { warn: () => {} }).maxLiveWindows, 6);
});

test('maxLiveWindows 非整数回退默认并告警一次', () => {
  const warned = [];
  const config = normalizeConfig({ maxLiveWindows: 2.5 }, { warn: (message) => warned.push(message) });
  assert.equal(config.maxLiveWindows, DEFAULT_CONFIG.maxLiveWindows);
  assert.equal(warned.length, 1);
  assert.match(warned[0], /maxLiveWindows/);
});

test('serverMount 形态校验：首尾斜杠、无空白/查询/片段/双斜杠', () => {
  assert.equal(normalizeServerMount('/code-server/'), '/code-server/');
  assert.equal(normalizeServerMount('/a/b/'), '/a/b/');
  assert.equal(normalizeServerMount('code-server/'), null);
  assert.equal(normalizeServerMount('/code-server'), null);
  assert.equal(normalizeServerMount('/code server/'), null);
  assert.equal(normalizeServerMount('/a/?x/'), null);
  assert.equal(normalizeServerMount('/a/#x/'), null);
  assert.equal(normalizeServerMount('/a//'), null);
  assert.equal(normalizeServerMount(42), null);
});

test('serverMount 非法时回退默认并告警', () => {
  const warned = [];
  const config = normalizeConfig({ serverMount: 'nope' }, { warn: (message) => warned.push(message) });
  assert.equal(config.serverMount, DEFAULT_CONFIG.serverMount);
  assert.equal(warned.length, 1);
});

test('allowLoopback / bridgeEnabled 只接受严格布尔', () => {
  assert.equal(normalizeConfig({ allowLoopback: true }, { warn: () => {} }).allowLoopback, true);
  assert.equal(normalizeConfig({ allowLoopback: 'true' }, { warn: () => {} }).allowLoopback, false);
  assert.equal(normalizeConfig({ bridgeEnabled: false }, { warn: () => {} }).bridgeEnabled, false);
  assert.equal(normalizeConfig({ bridgeEnabled: 0 }, { warn: () => {} }).bridgeEnabled, true);
});

test('数组/标量载荷按空对象处理', () => {
  assert.deepEqual(normalizeConfig([], { warn: () => {} }), { ...DEFAULT_CONFIG });
  assert.deepEqual(normalizeConfig('x', { warn: () => {} }), { ...DEFAULT_CONFIG });
});
