/**
 * cs-hub 配置归一化（契约 v2 §3.1 的四个字段，唯一真源）。
 *
 * 为什么不导出 `Config` / 不依赖 schemastery：
 * 1. 一期没有设置卡片，字段只来自 patch 行；
 * 2. 老部署自带的 schemastery 可能没有 `.volatile()`，无条件调用会在模块求值期抛错并拖垮整棵插件树。
 * 因此改用本文件的纯函数在 `apply` 内收口，纯函数可离线单测（仓规「纯本地测试」）。
 */

/** 默认配置（与契约 §3.1 一致；任何非法输入都回退到这里）。 */
export const DEFAULT_CONFIG = Object.freeze({
  /** live 窗口上限：允许同时存在的 iframe 数。 */
  maxLiveWindows: 3,
  /** 服务层挂载前缀（对外 URL 以 `/` 结尾）。 */
  serverMount: '/code-server/',
  /** 是否允许在服务层 loopback 模式下拼跨源 URL（二期能力，一期恒 false = fail-closed）。 */
  allowLoopback: false,
  /** 是否启用 bridge 端点（关闭后不写令牌文件、不挂路由）。 */
  bridgeEnabled: true,
});

/** `maxLiveWindows` 的允许区间（闭区间）。 */
export const MAX_LIVE_MIN = 1;
export const MAX_LIVE_MAX = 6;

/**
 * 校验并归一化 `serverMount`：必须以 `/` 开头且以 `/` 结尾，且不含空白 / `?` / `#`。
 * @param {unknown} value patch 行里的原始值。
 * @returns {string|null} 合法值；非法返回 null（由调用方回退默认并告警）。
 */
export function normalizeServerMount(value) {
  // 1. 非字符串直接非法。
  if (typeof value !== 'string') return null;
  // 2. 形态约束：首尾斜杠、不含空白与查询/片段标记（避免拼出不可预期的 URL）。
  if (!value.startsWith('/') || !value.endsWith('/')) return null;
  if (/[\s?#]/u.test(value)) return null;
  // 3. 只允许一层前缀形态，多余斜杠归一化（`/a//` → `/a/`）会让契约方难对齐，直接拒绝。
  if (value.includes('//')) return null;
  return value;
}

/**
 * 归一化配置对象：逐字段校验、夹取与回退，并对每次回退调用一次告警回调。
 * @param {unknown} raw `apply(ctx, config)` 收到的 patch 行 config 原文（可能是 undefined）。
 * @param {{warn?: (message: string) => void}} [options] warn 用于上报被回退的配置（默认 console.warn）。
 * @returns {{maxLiveWindows: number, serverMount: string, allowLoopback: boolean, bridgeEnabled: boolean}}
 *   归一化后的配置（总是四字段齐全、类型正确）。
 */
export function normalizeConfig(raw, { warn = (message) => console.warn(message) } = {}) {
  // 1. 非对象（undefined/null/数组/标量）一律按空对象处理，逐字段取默认。
  const source = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw : {};
  const config = { ...DEFAULT_CONFIG };
  // 2. maxLiveWindows：必须是整数，夹到 [1, 6]；非整数回退默认并告警一次。
  const rawMax = source.maxLiveWindows;
  if (rawMax !== undefined) {
    if (typeof rawMax === 'number' && Number.isInteger(rawMax)) {
      const clamped = Math.min(MAX_LIVE_MAX, Math.max(MAX_LIVE_MIN, rawMax));
      if (clamped !== rawMax) warn(`[cs-hub] maxLiveWindows=${rawMax} 超出 [${MAX_LIVE_MIN}, ${MAX_LIVE_MAX}]，已夹到 ${clamped}`);
      config.maxLiveWindows = clamped;
    } else {
      warn(`[cs-hub] maxLiveWindows 必须是整数（收到 ${JSON.stringify(rawMax)}），回退默认 ${DEFAULT_CONFIG.maxLiveWindows}`);
    }
  }
  // 3. serverMount：形态非法回退默认并告警。
  if (source.serverMount !== undefined) {
    const mount = normalizeServerMount(source.serverMount);
    if (mount === null) {
      warn(`[cs-hub] serverMount 非法（收到 ${JSON.stringify(source.serverMount)}），回退默认 ${DEFAULT_CONFIG.serverMount}`);
    } else {
      config.serverMount = mount;
    }
  }
  // 4. allowLoopback：只有显式 true 才开启（fail-closed）；非布尔值告警并保持 false。
  if (source.allowLoopback !== undefined) {
    if (typeof source.allowLoopback === 'boolean') config.allowLoopback = source.allowLoopback;
    else warn('[cs-hub] allowLoopback 必须是布尔值，已保持 false（fail-closed）');
  }
  // 5. bridgeEnabled：只有显式 false 才关闭；非布尔值告警并保持 true。
  if (source.bridgeEnabled !== undefined) {
    if (typeof source.bridgeEnabled === 'boolean') config.bridgeEnabled = source.bridgeEnabled;
    else warn('[cs-hub] bridgeEnabled 必须是布尔值，已保持 true');
  }
  return config;
}
