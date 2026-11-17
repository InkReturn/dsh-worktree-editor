/**
 * 路径小工具：只保留 cs-hub 需要的两个判定。
 *
 * 参考实现（plugins/dsh-plugin-ide/lib/fence.js）里有完整的围栏逻辑，cs-hub 一期
 * 没有文件路径入参（iframe 直接用 canonical 根），只复制「完全限定绝对路径」这一条判据。
 */
import path from 'node:path';

/**
 * 判定完全限定的绝对路径。
 *
 * Windows 上 `/foo` 与 `\\foo` 仍依赖当前盘符，不能作为可信绝对路径（与参考实现同口径）。
 * @param {unknown} value 待判定的路径参数。
 * @returns {boolean} POSIX 根、Windows 盘符根或明确 UNC 根成立时为 true。
 */
export function isExplicitAbsolute(value) {
  // 1. 非字符串、含 NUL 或相对路径直接不成立。
  if (typeof value !== 'string' || value === '' || value.includes('\0') || !path.isAbsolute(value)) return false;
  // 2. Windows 上盘符缺失的 \foo、/foo 也按「不可信绝对形态」处理。
  const root = path.parse(value).root;
  return process.platform !== 'win32' || (root !== '\\' && root !== '/');
}

/**
 * 构造路径身份键（Windows 忽略大小写），用于注册表反查与冲突比较。
 * @param {string} value 绝对路径。
 * @returns {string} 归一化后的身份键；不修改调用参数。
 */
export function pathKey(value) {
  // 1. 只规范化身份，不替调用者补参数。
  const normalized = path.resolve(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}
