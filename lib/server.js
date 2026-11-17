/**
 * 服务层「配置面」读取（契约 v2 §3.3）。
 *
 * 硬口径：host **不** 判服务层是否 mounted、**不** 读 `pid.json`。
 * - 存活由浏览器侧 `probeServer()` 同源探 `<base>healthz` 判定（只有浏览器过得了 DSH 的 cookie fence）；
 * - host 只输出配置面 `{base, probeUrl, allowLoopback}`；
 * - 仅 `allowLoopback === true` 的二期分支才读 `endpoint.json` / `path-token`（只读、不启动服务层）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 解析 DSH 数据根目录：优先环境变量 `DSH_HOME`，否则 `~/.dsh`（与包内 `dshHome()` 同口径）。
 * @param {NodeJS.ProcessEnv} [env=process.env] 环境变量表（单测可注入）。
 * @returns {string} DSH 数据根目录绝对路径。
 */
export function resolveDshHome(env = process.env) {
  // 1. 显式环境变量优先。
  const fromEnv = env?.DSH_HOME;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return path.resolve(fromEnv.trim());
  // 2. 回落到用户主目录下的 .dsh。
  return path.join(os.homedir(), '.dsh');
}

/**
 * 由归一化配置构造 host 侧「配置面」（不判存活）。
 * @param {{serverMount: string, allowLoopback: boolean}} config 归一化后的配置。
 * @returns {{base: string, probeUrl: string, allowLoopback: boolean}} base 以 `/` 结尾，probeUrl 是 healthz 完整路径。
 */
export function createServerConfig(config) {
  // 1. base 直接用配置值（normalizeConfig 已保证首尾斜杠）；probeUrl 只拼一次，避免客户端各自拼错。
  const base = config.serverMount;
  return { base, probeUrl: `${base}healthz`, allowLoopback: config.allowLoopback };
}

/**
 * 读取服务层 loopback 目标（**仅** `allowLoopback === true` 的二期分支使用）。
 *
 * 读取 `$DSH_HOME/code-server/endpoint.json` 与 `path-token`；任一缺失/非法返回 null。
 * 本函数不启动服务层、不写任何文件、不判 pid 存活（T7 已证 `pid.json` 会被热重载竞态删除）。
 * @param {string} dshHome DSH 数据根目录。
 * @returns {{host: string, port: number, token: string|null, productPath: string|undefined}|null}
 *   可用的回环目标；不可用时 null。
 */
export function readLoopbackTarget(dshHome) {
  // 1. 服务层状态文件都在 <DSH_HOME>/code-server/ 下。
  const root = path.join(dshHome, 'code-server');
  let endpoint;
  try {
    endpoint = JSON.parse(fs.readFileSync(path.join(root, 'endpoint.json'), 'utf8'));
  } catch { return null; }
  // 2. 形状校验：必须是回环 TCP 且端口合法，避免把管道形态误当端口用。
  if (typeof endpoint?.host !== 'string' || !Number.isInteger(endpoint?.port) || endpoint.port <= 0) return null;
  if (endpoint?.mode !== undefined && endpoint.mode !== 'tcp') return null;
  // 3. 路径令牌可选：缺失时返回 null（调用方必须把它当「不可用」而不是拼一个无令牌 URL）。
  let token = null;
  try {
    const raw = fs.readFileSync(path.join(root, 'path-token'), 'utf8').trim();
    if (raw !== '') token = raw;
  } catch { token = null; }
  return { host: endpoint.host, port: endpoint.port, token, productPath: endpoint.productPath };
}
