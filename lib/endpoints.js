/**
 * RPC 端点分派（契约 v2 §4.2）：`state` / `window.touch` / `window.recover` / `window.destroy`。
 *
 * 信封：成功 `{ok:true, value}`，失败 `{ok:false, error:{code,message,details}}`；未知异常一律归一化，
 * 绝不向传输层抛出。client 按 `error.code` 分支（`cs-hub/*`），不匹配 message。
 *
 * 副作用约定：
 * - `state` 首次访问会注册窗口并可能触发 LRU 冻结（冻结通过 SSE `window-frozen` 另行通知）；
 * - 所有端点都会实时解析根（不缓存），因此会话切 worktree 后立即生效。
 */
import { CsHubError } from './errors.js';
import { resolveSessionRoot } from './root.js';
import { createServerConfig } from './server.js';

/** RPC 频道名（index.js 注册与静态检查共用）。 */
export const CS_HUB_CHANNEL = '/cs-hub';

/** 全部合法端点（白名单；未知名直接失败，不进入执行）。 */
export const CS_HUB_ENDPOINTS = Object.freeze(['state', 'window.touch', 'window.recover', 'window.destroy']);

/**
 * 把一次 RPC 调用分派到具体端点实现。
 * @param {object} deps 依赖。
 * @param {object} deps.ctx host 插件上下文（提供 sessions/workingDirectory/worktreeRoot）。
 * @param {object} deps.config 归一化后的配置。
 * @param {object} deps.registry 窗口注册表（lib/registry.js）。
 * @param {{broadcast: (event: string, data: unknown) => void}} deps.hub SSE 枢纽。
 * @param {string} endpoint 频道相对端点名。
 * @param {unknown} payload 客户端 JSON 载荷（形状由各端点校验）。
 * @param {AbortSignal|undefined} signal 请求取消信号（当前端点均为同步解析，仅用于未来扩展与统一形状）。
 * @returns {Promise<{ok: true, value: object}|{ok: false, error: {code: string, message: string, details: object}}>}
 *   成功/失败信封。
 */
export async function dispatchCsHubEndpoint({ ctx, config, registry, hub }, endpoint, payload, signal) {
  // 1. 白名单：未注册名字直接失败，不进入任何执行路径。
  if (typeof endpoint !== 'string' || !CS_HUB_ENDPOINTS.includes(endpoint)) {
    return fail(new CsHubError('cs-hub/unknown-endpoint', '未知端点', { endpoint: endpoint === undefined ? null : String(endpoint) }));
  }
  try {
    // 2. 载荷必须是纯对象（null/undefined 归一化为空对象）。
    const input = requireRecord(payload);
    // 3. 分派；任何业务错误都在下面统一转 wire。
    const value = await HANDLERS[endpoint]({ ctx, config, registry, hub, signal }, input);
    return { ok: true, value };
  } catch (error) {
    // 4. 业务错误按稳定码上 wire；未知异常记录日志并归一化为 cs-hub/internal。
    if (error instanceof CsHubError) return fail(error);
    if (error?.name === 'AbortError') return fail(new CsHubError('cs-hub/internal', '请求已取消', {}));
    ctx.get('logger')?.error?.(`[cs-hub] 端点 ${endpoint} 未知异常`, error);
    return fail(new CsHubError('cs-hub/internal', '内部错误', {}, { cause: error }));
  }
}

/**
 * 构造失败信封。
 * @param {CsHubError} error 业务错误。
 * @returns {{ok: false, error: {code: string, message: string, details: object}}} wire 失败信封。
 */
function fail(error) {
  // 1. 只输出协议要求的三个字段。
  return { ok: false, error: error.toWire() };
}

/**
 * 把被 LRU 冻结的窗口列表广播成 `window-frozen`（附带该窗口的 folder 便于 UI 展示）。
 * @param {{broadcast: (event: string, data: unknown) => void}} hub SSE 枢纽。
 * @param {object} registry 注册表（用于查被冻结记录的 folder）。
 * @param {string[]} frozenSessionIds 被冻结的会话 ID 列表。
 * @returns {void}
 */
function broadcastFrozen(hub, registry, frozenSessionIds) {
  // 1. 逐条广播；folder 从注册表读取（记录仍保留在表中，只是 state=frozen）。
  const bySession = new Map(registry.list().map((record) => [record.sessionId, record]));
  for (const sessionId of frozenSessionIds) {
    const record = bySession.get(sessionId);
    hub.broadcast('window-frozen', { sessionId, folder: record?.folder ?? null, reason: 'lru' });
  }
}

/**
 * 注册一个会话窗口并广播副作用（state / touch / recover 共用的收口）。
 * @param {object} deps 依赖（同 dispatchCsHubEndpoint）。
 * @param {string} sessionId 会话 ID。
 * @param {{allowUncertain?: boolean, preserveFrozen?: boolean}} [options]
 *   allowUncertain=是否允许不确定相（仅 state 使用）；
 *   preserveFrozen=重拉时保持已有 frozen 状态（state 重拉必须为 true，否则冻结会被自己复活）。
 * @returns {{resolved: object|null, registration: object|null}} 根视图与注册结果；不确定相时不注册。
 * @throws {CsHubError} 根解析错误。
 */
function registerSession(deps, sessionId, { allowUncertain = false, preserveFrozen = false } = {}) {
  // 1. 实时解析根；不确定相允许返回视图但不注册（避免把摆动中的目录写进 iframe）。
  const resolved = resolveSessionRoot(deps.ctx, sessionId, { allowUncertain });
  if (resolved.uncertain) return { resolved, registration: null };
  // 2. 注册/更新记录（同 folder 冲突会在这里被顶掉；preserveFrozen 防止 state 重拉复活冻结窗）。
  const registration = deps.registry.register(sessionId, resolved, { preserveFrozen });
  // 3. 副作用：冲突与冻结都要通过 SSE 明确告知，不静默。
  if (registration.conflict !== null) {
    deps.hub.broadcast('registry-conflict', {
      sessionId: registration.conflict.sessionId,
      folder: registration.conflict.folder,
      takenBy: sessionId,
    });
  }
  if (registration.frozen.length > 0) broadcastFrozen(deps.hub, deps.registry, registration.frozen);
  return { resolved, registration };
}

/**
 * 组装 `state` 的返回值（读接口的公共形状，避免两条路径字段漂移）。
 * @param {object} deps 依赖（需要 registry / config）。
 * @param {object} resolved 根解析结果（RootView）。
 * @param {object|null} record 该会话的窗口记录（未注册/不确定相时 null）。
 * @returns {{ready: boolean, root: object, window: object|null, windows: object[], server: object,
 *   limits: object, frameFolder: string}} StateResult（契约 §4.2）。
 */
function buildStateResult(deps, resolved, record) {
  // 1. ready 只表示根解析落定（不确定相为 false，UI 由 root.uncertain 显示 ⚠）。
  // 2. server 只给配置面；mounted/instanceTag 由 client 探 healthz（契约 §3.3）。
  // 3. frameFolder 用 canonical 根（契约 §1.3），client 负责拼 `?s=&folder=`。
  return {
    ready: !resolved.uncertain,
    root: resolved,
    window: record,
    windows: deps.registry.list(),
    server: createServerConfig(deps.config),
    limits: { maxLiveWindows: deps.registry.maxLiveWindows },
    frameFolder: resolved.realRoot,
  };
}

/**
 * `state`：面板初始化——实时解析根 + 读注册表 + 回配置面（不判服务层存活）。
 *
 * **所有权语义（T11 / T6 M1）**：对**已存在**的 sessionId 是**只读**——不 register、不接管、
 * 不改 frozen/live、不广播；只有「全新 sessionId 的首次 state」才懒注册（这是所有权变更的
 * 显式入口之一，与开窗 / window.recover / applyRootChange 并列）。被动重拉永不改写所有权，
 * 否则两个会话同 folder 时会互相顶掉并形成无限回环。
 * @param {object} deps 依赖。
 * @param {object} payload `{sessionId: string}`。
 * @returns {Promise<object>} StateResult（见契约 §4.2）。
 */
async function state(deps, payload) {
  // 1. 校验会话 ID，允许不确定相（UI 需要 ⚠ 而不是报错）。
  const sessionId = requireSessionId(payload);
  // 2. 已注册会话：只读路径（resolve 只为拿最新 canonical 根给 frameFolder，不改注册表）。
  const existing = deps.registry.get(sessionId);
  if (existing !== undefined) {
    const resolved = resolveSessionRoot(deps.ctx, sessionId, { allowUncertain: true });
    return buildStateResult(deps, resolved, existing);
  }
  // 3. 全新会话：懒注册（首次 state 即显式开窗；同 folder 冲突在这里只会发生一次）。
  const { resolved, registration } = registerSession(deps, sessionId, { allowUncertain: true });
  return buildStateResult(deps, resolved, registration?.record ?? null);
}

/**
 * `window.touch`：会话变活跃 / iframe 获得焦点——刷新 lastActiveAt 并按需冻结最旧窗口。
 * @param {object} deps 依赖。
 * @param {object} payload `{sessionId: string}`。
 * @returns {Promise<{window: object, frozen: string[]}>} 记录与本次被冻结的会话。
 */
async function windowTouch(deps, payload) {
  // 1. 未注册时退化为「注册一次」（客户端理论上先调 state，这里防御性兜底；新会话首次注册即 live）。
  const sessionId = requireSessionId(payload);
  const touched = deps.registry.touch(sessionId);
  if (touched === undefined) {
    const { registration } = registerSession(deps, sessionId, { preserveFrozen: true });
    if (registration === null) throw new CsHubError('cs-hub/root-uncertain', '工作树状态不确定，等待落定', { sessionId });
    return { window: registration.record, frozen: registration.frozen };
  }
  // 2. 已注册：touch 不改变 frozen/live（冻结窗不会被 touch 复活），只广播真实发生的冻结。
  if (touched.frozen.length > 0) broadcastFrozen(deps.hub, deps.registry, touched.frozen);
  return { window: touched.record, frozen: touched.frozen };
}

/**
 * `window.recover`：冻结窗口恢复（置 live、刷新活跃时间、必要时再冻结别的窗口）。
 * @param {object} deps 依赖。
 * @param {object} payload `{sessionId: string}`。
 * @returns {Promise<{window: object, frozen: string[]}>} 记录与本次被冻结的会话。
 */
async function windowRecover(deps, payload) {
  // 1. 与 touch 同一收口；未注册时重新解析根并注册（文件夹可能已被删除，故走完整解析）。
  const sessionId = requireSessionId(payload);
  const recovered = deps.registry.recover(sessionId);
  if (recovered !== undefined) {
    // 1.1. 恢复成功后广播 window-live，让该会话的客户端重建 iframe。
    deps.hub.broadcast('window-live', { sessionId, folder: recovered.record.folder });
    if (recovered.frozen.length > 0) broadcastFrozen(deps.hub, deps.registry, recovered.frozen);
    return { window: recovered.record, frozen: recovered.frozen };
  }
  const { registration } = registerSession(deps, sessionId);
  if (registration === null) throw new CsHubError('cs-hub/root-uncertain', '工作树状态不确定，等待落定', { sessionId });
  deps.hub.broadcast('window-live', { sessionId, folder: registration.record.folder });
  return { window: registration.record, frozen: registration.frozen };
}

/**
 * `window.destroy`：会话结束 / worktree 收尾——移出正表与反表（幂等）。
 * @param {object} deps 依赖。
 * @param {object} payload `{sessionId: string}`。
 * @returns {Promise<{closed: true}>} 固定结果。
 */
async function windowDestroy(deps, payload) {
  // 1. 只校验形状后删除；未注册也算成功（幂等）。
  const sessionId = requireSessionId(payload);
  deps.registry.destroy(sessionId);
  return { closed: true };
}

/**
 * 端点实现表（键必须与 CS_HUB_ENDPOINTS 一致）。
 * @type {Record<string, (deps: object, payload: object) => Promise<object>>}
 */
const HANDLERS = Object.freeze({
  state,
  'window.touch': windowTouch,
  'window.recover': windowRecover,
  'window.destroy': windowDestroy,
});

/**
 * 校验载荷是纯对象。
 * @param {unknown} payload RPC 载荷。
 * @returns {object} 原载荷对象；null/undefined 归一化为空对象。
 * @throws {CsHubError} `cs-hub/invalid-payload`（数组/标量）。
 */
function requireRecord(payload) {
  // 1. null/undefined 容忍为空对象，其余必须是纯对象。
  if (payload === undefined || payload === null) return {};
  if (typeof payload !== 'object' || Array.isArray(payload)) throw new CsHubError('cs-hub/invalid-payload', '载荷必须是对象');
  return payload;
}

/**
 * 校验会话 ID。
 * @param {object} payload 端点载荷。
 * @returns {string} 合法会话 ID。
 * @throws {CsHubError} `cs-hub/invalid-payload`（缺失/非字符串/超长/含控制字符）。
 */
function requireSessionId(payload) {
  // 1. 会话 ID 是短字符串；控制字符与超长值一律拒绝。
  const sessionId = payload.sessionId;
  if (typeof sessionId !== 'string' || sessionId === '' || sessionId.length > 256 || /[\x00-\x1f\x7f]/u.test(sessionId)) {
    throw new CsHubError('cs-hub/invalid-payload', 'sessionId 无效', { sessionId: undefined });
  }
  return sessionId;
}
