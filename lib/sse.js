/**
 * SSE 推送枢纽（cs-hub 契约 v2 §4.3；反代禁缓冲与心跳口径沿用参考实现 plugins/dsh-plugin-ide/lib/sse.js）。
 *
 * 每个连接的浏览器客户端对应一条 `text/event-stream`；hub 把 worktree 稳定态事件
 * 广播给所有连接（客户端按 sessionId 过滤）。响应头固定携带：
 * - `cache-control: no-cache, no-transform`
 * - `x-accel-buffering: no`（nginx 等反代禁用缓冲）
 * 连接建立即下发 `retry:` 控制浏览器重连间隔，并按心跳周期发送 SSE 注释行
 * 防止反代空闲超时掐线（Lead 评审要求：心跳与 retry 必须实现；cs-hub 直接复用该实现）。
 */

/** 默认心跳周期：25 秒（低于常见反代 60s 空闲超时，spec §6.5 建议 ≥300s 亦覆盖）。 */
export const DEFAULT_HEARTBEAT_MS = 25_000;
/** 默认浏览器重连间隔：5 秒。 */
export const DEFAULT_RETRY_MS = 5000;

/**
 * 创建一个 SSE 连接枢纽。
 * @param {object} [options] 可调参数（测试可注入短周期）。
 * @param {number} [options.heartbeatMs=25000] 心跳注释行周期，毫秒；必须为正有限数。
 * @param {number} [options.retryMs=5000] 下发给浏览器的重连间隔，毫秒。
 * @returns {{size: number, broadcast: (event: string, data: unknown) => void,
 *   response: (request: {signal?: AbortSignal}) => Response, dispose: () => void}}
 *   size=当前连接数；broadcast 向所有连接推送一个命名事件；
 *   response 为一次 GET 请求生成 SSE Response；dispose 关闭全部连接与定时器。
 */
export function createSseHub({ heartbeatMs = DEFAULT_HEARTBEAT_MS, retryMs = DEFAULT_RETRY_MS } = {}) {
  // 1. 参数防御：周期必须是正有限数。
  if (!Number.isFinite(heartbeatMs) || heartbeatMs <= 0) throw new RangeError('heartbeatMs 必须是正有限数');
  if (!Number.isFinite(retryMs) || retryMs < 0) throw new RangeError('retryMs 必须是非负有限数');
  const encoder = new TextEncoder();
  /** @type {Set<{send: (event: string, data: unknown) => void, close: () => void}>} */
  const clients = new Set();
  let disposed = false;

  /**
   * 生成一条 SSE 流的 Response（供 Connection fetch 路由返回）。
   * @param {{signal?: AbortSignal}} request 入站请求；signal 在客户端断开时 abort。
   * @returns {Response} 流式 SSE 响应，头含禁缓冲约束。
   */
  function response(request) {
    // 1. 已整体处置的枢纽拒绝新连接（插件卸载竞态窗口）。
    if (disposed) return new Response('gone', { status: 503 });
    let controller;
    let heartbeat;
    let closed = false;
    const entry = {
      send,
      close,
    };
    const stream = new ReadableStream({
      start(streamController) {
        // 2. 首帧下发 retry，注册进 hub，启动心跳。
        controller = streamController;
        controller.enqueue(encoder.encode(`retry: ${Math.round(retryMs)}\n\n`));
        clients.add(entry);
        heartbeat = setInterval(ping, heartbeatMs);
        heartbeat.unref?.();
        request.signal?.addEventListener('abort', close, { once: true });
      },
      cancel() {
        // 3. 消费侧取消（bridge 断线）时同样清理。
        close();
      },
    });

    /**
     * 向本连接推送一个命名事件。
     * @param {string} event SSE 事件名（客户端 addEventListener 的键）。
     * @param {unknown} data JSON 可序列化载荷。
     * @returns {void} 连接已关闭时静默忽略。
     */
    function send(event, data) {
      // 1. 已关闭连接不再写入；enqueue 失败视为对端断开并清理。
      if (closed) return;
      try {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      } catch {
        close();
      }
    }

    /**
     * 发送一条 SSE 注释行作为心跳，维持反代空闲计时器。
     * @returns {void}
     */
    function ping() {
      // 1. 注释行以 `:` 开头，浏览器忽略内容，仅保活。
      if (closed) return;
      try { controller.enqueue(encoder.encode(': ping\n\n')); }
      catch { close(); }
    }

    /**
     * 关闭本连接并释放全部资源（幂等）。
     * @returns {void}
     */
    function close() {
      // 1. 摘除注册、停心跳、解绑 abort 监听，再关闭流。
      if (closed) return;
      closed = true;
      clients.delete(entry);
      clearInterval(heartbeat);
      request.signal?.removeEventListener('abort', close);
      try { controller?.close(); } catch { /* 流已关闭 */ }
    }

    return new Response(stream, {
      status: 200,
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        'x-accel-buffering': 'no',
      },
    });
  }

  return {
    get size() { return clients.size; },
    /**
     * 向所有连接广播一个命名事件。
     * @param {string} event SSE 事件名。
     * @param {unknown} data JSON 可序列化载荷。
     * @returns {void}
     */
    broadcast(event, data) {
      // 1. 快照遍历：send 内部可能同步清理断开的连接。
      if (disposed) return;
      for (const client of [...clients]) client.send(event, data);
    },
    response,
    /**
     * 处置枢纽：关闭全部连接并拒绝后续新连接（插件卸载时调用）。
     * @returns {void}
     */
    dispose() {
      // 1. 逐连接关闭；置 disposed 阻止新流。
      disposed = true;
      for (const client of [...clients]) client.close();
      clients.clear();
    },
  };
}
