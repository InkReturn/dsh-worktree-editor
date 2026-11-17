/**
 * SSE 枢纽单测（契约 v2 §4.3）：响应头、retry 首帧、事件广播、心跳、处置。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSseHub } from '../lib/sse.js';

/**
 * 读取一个 SSE Response 的前若干字节（带超时，避免流不结束卡死）。
 * @param {Response} response SSE 响应。
 * @param {number} count 期望读到的事件块数。
 * @param {number} [timeoutMs=500] 超时。
 * @returns {Promise<string>} 已读到的文本。
 */
async function readChunks(response, count, timeoutMs = 500) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let blocks = 0;
  const deadline = Date.now() + timeoutMs;
  while (blocks < count && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    blocks = (text.match(/\n\n/gu) ?? []).length;
  }
  await reader.cancel();
  return text;
}

test('响应头：text/event-stream + 禁缓存 + 禁反代缓冲', () => {
  const hub = createSseHub({ heartbeatMs: 10_000 });
  const response = hub.response({ signal: new AbortController().signal });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/u);
  assert.equal(response.headers.get('cache-control'), 'no-cache, no-transform');
  assert.equal(response.headers.get('x-accel-buffering'), 'no');
  hub.dispose();
});

test('首帧下发 retry；连接计入 size；断开后 size 归零', async () => {
  const hub = createSseHub({ heartbeatMs: 10_000, retryMs: 1234 });
  const controller = new AbortController();
  const response = hub.response({ signal: controller.signal });
  assert.equal(hub.size, 1);
  const text = await readChunks(response, 1);
  assert.match(text, /retry: 1234/u);
  controller.abort();
  // abort 是异步清理，给一个宏任务窗口。
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(hub.size, 0);
  hub.dispose();
});

test('broadcast 把所有命名事件推给连接', async () => {
  const hub = createSseHub({ heartbeatMs: 10_000 });
  const response = hub.response({ signal: new AbortController().signal });
  hub.broadcast('root-changed', { sessionId: 's1', root: 'C:\\a' });
  const text = await readChunks(response, 2);
  assert.match(text, /event: root-changed/u);
  assert.match(text, /"sessionId":"s1"/u);
  hub.dispose();
});

test('心跳：注释行按周期出现', async () => {
  const hub = createSseHub({ heartbeatMs: 30 });
  const response = hub.response({ signal: new AbortController().signal });
  const text = await readChunks(response, 2, 400);
  assert.match(text, /: ping/u);
  hub.dispose();
});

test('dispose 后新连接返回 503，旧连接被关闭', async () => {
  const hub = createSseHub({ heartbeatMs: 10_000 });
  const response = hub.response({ signal: new AbortController().signal });
  assert.equal(hub.size, 1);
  hub.dispose();
  assert.equal(hub.size, 0);
  const late = hub.response({ signal: new AbortController().signal });
  assert.equal(late.status, 503);
  // 已关闭的流：先消费掉已入队的首帧，随后应读到 done。
  const reader = response.body.getReader();
  let finished = false;
  for (let i = 0; i < 5 && !finished; i += 1) {
    const chunk = await reader.read();
    finished = chunk.done === true;
  }
  assert.equal(finished, true);
});
