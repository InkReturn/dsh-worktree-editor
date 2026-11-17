/**
 * bridge 端点（契约 v2 §4.4）：服务层之外的扩展宿主通道。
 *
 * 为什么挂在 `/cs-hub-bridge/*` 而不是 `/api`：`/api` 有 DSH 的 cookie fence，
 * 而扩展宿主是 Node 进程、永远拿不到浏览器 cookie（服务层包对同一条边界已有源码注释）。
 * 因此这里自带令牌鉴权，并沿用服务层已验证的安全不变量：
 * - 带 `Origin` 头一律 403（扩展不该带 Origin；浏览器打这个口也一律拒绝）；
 * - 令牌走 `x-cs-hub-bridge-token` 头，令牌文件 `$DSH_HOME/cs-hub/bridge.json`（不进仓、不打印）；
 * - `folder` 必须命中注册表反查索引才路由（fail-closed，未命中返回 `routed:false` 且不广播）。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/** bridge 路由前缀（与 contract §4.4 一致）。 */
export const BRIDGE_BASE = '/cs-hub-bridge';
/** 令牌头名（扩展侧读取令牌文件后写入该头）。 */
export const BRIDGE_TOKEN_HEADER = 'x-cs-hub-bridge-token';
/** 允许的 bridge 事件类型（白名单，未知类型拒绝）。 */
export const BRIDGE_EVENT_TYPES = Object.freeze(['diff', 'lock', 'follow']);
/** 请求体上限：64 KiB（bridge 只传增量 diff/lock/follow，不需要更大）。 */
export const BRIDGE_BODY_LIMIT = 64 * 1024;

/**
 * 令牌文件路径。
 * @param {string} dshHome DSH 数据根目录。
 * @returns {string} `<DSH_HOME>/cs-hub/bridge.json` 绝对路径。
 */
export function bridgeTokenPath(dshHome) {
  // 1. 固定目录结构，便于扩展侧按同一路径读取。
  return path.join(dshHome, 'cs-hub', 'bridge.json');
}

/**
 * 生成并落盘 bridge 令牌（幂等：每次 apply 轮换，旧令牌立即失效）。
 * @param {string} dshHome DSH 数据根目录。
 * @param {() => number} [now=Date.now] 时钟注入（单测用）。
 * @returns {{token: string, endpoint: string, createdAt: string, path: string}} 令牌与文件位置。
 */
export function rotateBridgeToken(dshHome, now = Date.now) {
  // 1. 24 字节随机数转 hex：足够熵，且便于放进 header。
  const token = crypto.randomBytes(24).toString('hex');
  const record = {
    token,
    endpoint: `${BRIDGE_BASE}/{health,hello,event}`,
    createdAt: new Date(now()).toISOString(),
  };
  // 2. 目录与文件都用最小权限落盘（POSIX 0600 + 目录 0700；Windows 走 ACL 收紧）。
  const file = bridgeTokenPath(dshHome);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  // 3. Windows 额外收紧 ACL（继承自 ~/.dsh 的权限可能让其它本地账号可读）。
  tightenTokenAcl(file);
  return { ...record, path: file };
}

/**
 * 收紧令牌文件的访问控制（公开版安全硬化，T21）。
 *
 * - POSIX：chmod 0600（文件）/ 0700（目录）；写时 mode 只是「建议值」，已存在文件不会变，所以显式 chmod。
 * - Windows：`icacls /inheritance:r /grant:r <当前用户>:(R,W)` 去掉继承、只留当前用户读写。
 * - 任何失败都只 `console.warn`，绝不中断插件 apply（令牌不可用比权限宽更糟）。
 * @param {string} file 令牌文件绝对路径。
 * @returns {void}
 */
function tightenTokenAcl(file) {
  try {
    if (process.platform === 'win32') {
      // 1. Windows：去掉继承权限，只授予当前用户读写（系统与管理员组仍可通过文件所有权接管）。
      const user = process.env.USERNAME;
      if (typeof user !== 'string' || user === '') {
        console.warn('[cs-hub] bridge 令牌 ACL 未收紧：读不到 USERNAME');
        return;
      }
      execFileSync('icacls', [file, '/inheritance:r', '/grant:r', `${user}:(R,W)`], { stdio: 'pipe' });
      return;
    }
    // 2. POSIX：目录 0700、文件 0600。
    fs.chmodSync(path.dirname(file), 0o700);
    fs.chmodSync(file, 0o600);
  } catch (error) {
    console.warn(`[cs-hub] bridge 令牌 ACL 收紧失败（仅告警）：${error && error.message ? error.message : String(error)}`);
  }
}

/**
 * 把路径里的 bridge 前缀剥掉。
 * @param {string} url 原始请求 URL（可带 query）。
 * @returns {string|null} 子路径（如 `/hello`）；不在前缀下返回 null。
 */
export function bridgeSubPath(url) {
  // 1. 只按 pathname 匹配，query 一律丢弃（端点不需要 query）。
  const pathname = typeof url === 'string' ? url.split('?')[0] : '';
  if (!pathname.startsWith(`${BRIDGE_BASE}/`) && pathname !== BRIDGE_BASE) return null;
  const rest = pathname.slice(BRIDGE_BASE.length);
  return rest === '' ? '/' : rest;
}

/**
 * 把扩展请求体规整成白名单对象（不透传未知字段）。
 * @param {unknown} body 已解析的 JSON 体。
 * @returns {{folder: string, type?: string, payload?: object}|null} 规整结果；形状非法返回 null。
 */
export function sanitizeBridgeBody(body) {
  // 1. 必须是纯对象。
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  // 2. folder 必填且必须是非空字符串（绝对路径由 realpath 兜底校验）。
  if (typeof body.folder !== 'string' || body.folder === '') return null;
  const sanitized = { folder: body.folder };
  // 3. type/payload 只在 event 端点出现；类型必须在白名单内，payload 必须是对象或 undefined。
  if (body.type !== undefined) {
    if (typeof body.type !== 'string' || !BRIDGE_EVENT_TYPES.includes(body.type)) return null;
    sanitized.type = body.type;
  }
  if (body.payload !== undefined) {
    if (typeof body.payload !== 'object' || body.payload === null || Array.isArray(body.payload)) return null;
    sanitized.payload = body.payload;
  }
  return sanitized;
}

/**
 * 请求「前置判定」：前缀 → Origin → health → 端点白名单 → 令牌 → 方法。
 *
 * 公开版安全硬化（T21）：`handle()` 必须在**读请求体之前**调用本函数；
 * 否则未认证的 POST 也能触发一次 64 KiB 有界读（T14 minor-13 的残留问题）。
 * @param {object} input 判定输入。
 * @param {string} input.method 已大写的 HTTP 方法。
 * @param {string} input.url 请求 URL（可含查询串）。
 * @param {object} [input.headers] 请求头（小写键优先读取）。
 * @param {string} input.token 当前有效令牌。
 * @returns {{status: number, body: object}|null} 非 null 表示应立即按此响应、**不要读请求体**。
 */
export function precheckBridgeRequest({ method, url, headers = {}, token }) {
  // 1. 前缀与 Origin：不在前缀下 404；带 Origin 一律 403（与 service launcher 同口径）。
  const subPath = bridgeSubPath(url);
  if (subPath === null) return { status: 404, body: { ok: false, error: 'not-found' } };
  if (readHeader(headers, 'origin') !== undefined) return { status: 403, body: { ok: false, error: 'origin-forbidden' } };
  // 2. 探活：不需要令牌。
  if (subPath === '/health' && method === 'GET') return { status: 200, body: { ok: true } };
  // 3. 白名单 → 令牌 → 方法：顺序固定，避免泄露端点是否存在。
  if (subPath !== '/hello' && subPath !== '/event') return { status: 404, body: { ok: false, error: 'not-found' } };
  if (!tokenMatches(readHeader(headers, BRIDGE_TOKEN_HEADER), token)) {
    return { status: 401, body: { ok: false, error: 'unauthorized' } };
  }
  if (method !== 'POST') return { status: 405, body: { ok: false, error: 'method-not-allowed' } };
  return null;
}

/**
 * 纯判定：给一次 bridge 请求算出响应（不碰 socket，便于离线单测）。
 * @param {object} input 请求事实与依赖。
 * @param {string} input.method HTTP 方法（大写）。
 * @param {string} input.url 原始 URL。
 * @param {object} input.headers 请求头（小写键优先读取）。
 * @param {unknown} input.body 已解析的 JSON 体（GET 为 undefined）。
 * @param {object} input.registry 窗口注册表（提供 resolveByFolder）。
 * @param {string} input.token 当前有效令牌。
 * @param {(realPath: string) => string} [input.resolveReal] 路径规范化函数（默认 fs.realpathSync.native，单测可注入）。
 * @returns {{status: number, body: object, broadcast: {event: string, data: object}|null}}
 *   status/body 用于写回；broadcast 非空表示命中路由、需要向 SSE 广播一次。
 */
export function evaluateBridgeRequest({
  method,
  url,
  headers = {},
  body,
  registry,
  token,
  resolveReal = (realPath) => fs.realpathSync.native(realPath),
}) {
  // 1. 前置判定：命中即返回（此时调用方不应读体，也不会广播）。
  const pre = precheckBridgeRequest({ method, url, headers, token });
  if (pre !== null) return { status: pre.status, body: pre.body, broadcast: null };
  const subPath = bridgeSubPath(url);
  // 2. 体形状白名单。
  const sanitized = sanitizeBridgeBody(body);
  if (sanitized === null) return { status: 400, body: { ok: false, error: 'invalid-body' }, broadcast: null };
  // 3. realpath 规范化后反查会话（fail-closed：目录不存在/未注册都不路由）。
  let realFolder;
  try { realFolder = resolveReal(sanitized.folder); }
  catch {
    // 3.1. 契约 §4.4：`event` 的「不可路由」统一回 `routed:false`（含目录不存在）；
    //      404 folder-not-found 只属于 `hello`（它要明确回答「这个目录归属哪个会话」）。
    if (subPath === '/event') return { status: 200, body: { routed: false }, broadcast: null };
    return { status: 404, body: { ok: false, error: 'folder-not-found' }, broadcast: null };
  }
  const sessionId = registry.resolveByFolder(realFolder);
  if (subPath === '/hello') {
    if (sessionId === undefined) return { status: 404, body: { ok: false, error: 'folder-unrouted' }, broadcast: null };
    return { status: 200, body: { sessionId }, broadcast: null };
  }
  // 4. event：未命中返回 routed:false 且**不广播**（fail-closed）；命中则广播一次。
  if (sessionId === undefined) return { status: 200, body: { routed: false }, broadcast: null };
  return {
    status: 200,
    body: { routed: true },
    broadcast: {
      event: 'bridge-event',
      data: { sessionId, type: sanitized.type, payload: sanitized.payload ?? {} },
    },
  };
}

/**
 * 恒定时间比较两个令牌（避免按前缀逐字节比较泄露时序信息）。
 * @param {string|undefined} provided 请求头里带的令牌（可能缺失）。
 * @param {string|undefined} expected 当前有效令牌。
 * @returns {boolean} 完全相等（长度与内容）时为 true。
 */
function tokenMatches(provided, expected) {
  // 1. 任一缺失/非字符串直接失败（不做任何比较）。
  if (typeof provided !== 'string' || typeof expected !== 'string') return false;
  // 2. 先比长度：长度不同必然不等，且 timingSafeEqual 要求等长 Buffer。
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  // 3. 等长后恒定时间比较内容。
  return crypto.timingSafeEqual(a, b);
}

/**
 * 读取请求头（大小写不敏感）。
 * @param {object} headers 头对象（Node 的 IncomingHttpHeaders）。
 * @param {string} name 小写头名。
 * @returns {string|undefined} 头值（数组取第一个）。
 */
function readHeader(headers, name) {
  // 1. 先按小写直接取，再线性兜底一次（兼容手工构造的头对象）。
  const direct = headers?.[name];
  if (direct !== undefined) return Array.isArray(direct) ? direct[0] : String(direct);
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (key.toLowerCase() !== name) continue;
    return Array.isArray(value) ? value[0] : value === undefined ? undefined : String(value);
  }
  return undefined;
}

/**
 * 收集并解析请求体（有界：超过 BRIDGE_BODY_LIMIT 直接拒绝）。
 * @param {import('node:http').IncomingMessage} req 入站请求。
 * @returns {Promise<{ok: true, body: unknown}|{ok: false, error: 'too-large'|'invalid-json'}>} 解析结果。
 */
export function readBridgeBody(req) {
  return new Promise((resolve) => {
    // 1. 逐块累积，超限立即停止并销毁请求流。
    const chunks = [];
    let size = 0;
    let settled = false;
    /**
     * 一次性兑现 Promise（幂等）：data/end/error/超限四条路径都可能先到，
     * 只有第一次调用生效，后续调用被忽略。
     * @param {{ok: true, body: unknown}|{ok: false, error: 'too-large'|'invalid-json'}} value 兑现值。
     * @returns {void}
     */
    const settle = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > BRIDGE_BODY_LIMIT) {
        settle({ ok: false, error: 'too-large' });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      // 2. 空体按「非法体」处理（两个端点都要求 JSON）。
      const text = Buffer.concat(chunks).toString('utf8');
      if (text.trim() === '') return settle({ ok: false, error: 'invalid-json' });
      try {
        settle({ ok: true, body: JSON.parse(text) });
      } catch {
        settle({ ok: false, error: 'invalid-json' });
      }
    });
    req.on('error', () => settle({ ok: false, error: 'invalid-json' }));
  });
}

/**
 * 创建一个 bridge 处理器（index.js 挂到 webServer 前缀路由上）。
 * @param {object} deps 依赖。
 * @param {object} deps.registry 窗口注册表。
 * @param {() => string} deps.getToken 取当前有效令牌（每次请求读取，令牌轮换立即生效）。
 * @param {(realPath: string) => string} [deps.resolveReal] 路径规范化（单测注入）。
 * @returns {{handle: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, onBroadcast: (event: string, data: unknown) => void) => Promise<void>}}
 *   处理器；调用方负责把 broadcast 转给 SSE 枢纽。
 */
export function createBridgeHandler({ registry, getToken, resolveReal }) {
  return {
    /**
     * 处理一次 bridge HTTP 请求。
     * @param {import('node:http').IncomingMessage} req 入站请求。
     * @param {import('node:http').ServerResponse} res 出站响应。
     * @param {(event: string, data: unknown) => void} onBroadcast 命中路由时的 SSE 广播回调。
     * @returns {Promise<void>} 响应写完或连接已销毁时兑现。
     */
    async handle(req, res, onBroadcast) {
      // 1. 先做前置判定（前缀/Origin/health/白名单/令牌/方法）：未认证请求**不读体**。
      const method = String(req.method ?? 'GET').toUpperCase();
      const url = String(req.url ?? '');
      const pre = precheckBridgeRequest({ method, url, headers: req.headers, token: getToken() });
      if (pre !== null) {
        writeJson(res, pre.status, pre.body);
        return;
      }
      // 2. 通过前置判定后才读有界体（POST）。
      let body;
      if (method === 'POST') {
        const parsed = await readBridgeBody(req);
        if (!parsed.ok) {
          writeJson(res, parsed.error === 'too-large' ? 413 : 400, { ok: false, error: parsed.error });
          return;
        }
        body = parsed.body;
      }
      // 3. 纯判定，再统一写响应。
      const result = evaluateBridgeRequest({
        method,
        url,
        headers: req.headers,
        body,
        registry,
        token: getToken(),
        resolveReal,
      });
      if (result.broadcast !== null) onBroadcast(result.broadcast.event, result.broadcast.data);
      writeJson(res, result.status, result.body);
    },
  };
}

/**
 * 写 JSON 响应（带禁缓存头；bridge 响应很短，不需要流式）。
 * @param {import('node:http').ServerResponse} res 响应对象。
 * @param {number} status HTTP 状态码。
 * @param {object} body 响应体（JSON 可序列化）。
 * @returns {void}
 */
function writeJson(res, status, body) {
  // 1. 已结束的响应不再写（客户端提前断开）。
  if (res.writableEnded || res.destroyed) return;
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(payload.length),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

