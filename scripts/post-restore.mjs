/**
 * dsh-portable `restore` 后处理钩子（插件侧通用约定）。
 *
 * 由 `restore.ps1` 在恢复完插件后按约定调用：
 *   node <pluginDir>/scripts/post-restore.mjs --dsh-home <DSH_HOME> [--profile web]
 *     [--skip-patch] [--skip-extensions] [--skip-settings]
 *
 * 行为等价 `install.mjs --patch --settings --extensions=minimal`，但**不装服务层**（restore 的 pnpm 已装），
 * 且任何失败都不抛：打印一行 JSON 摘要并返回非 0 退出码，由 restore 记日志（不中断恢复）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = path.resolve(HERE, '..');

/**
 * 解析参数。
 * @param {string[]} argv 进程参数。
 * @returns {{dshHome: string|null, profile: string, skipPatch: boolean, skipExtensions: boolean, skipSettings: boolean, extensions: string}} 选项。
 */
function parseArgs(argv) {
  const options = { dshHome: null, profile: 'web', skipPatch: false, skipExtensions: false, skipSettings: false, extensions: 'minimal' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dsh-home') options.dshHome = argv[++index];
    else if (arg === '--profile') options.profile = argv[++index];
    else if (arg === '--skip-patch') options.skipPatch = true;
    else if (arg === '--skip-extensions') options.skipExtensions = true;
    else if (arg === '--skip-settings') options.skipSettings = true;
    else if (arg === '--extensions') options.extensions = argv[++index];
  }
  return options;
}

/**
 * 主流程：拼出 install.mjs 的分步参数并执行，输出 JSON 摘要。
 * @returns {number} 退出码（0 全成功；1 有告警）。
 */
function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.dshHome === null) {
    console.log(JSON.stringify({ ok: false, error: '缺少 --dsh-home' }));
    return 1;
  }
  const args = [path.join(PLUGIN_DIR, 'scripts', 'install.mjs'), '--dsh-home', options.dshHome, '--profile', options.profile];
  if (!options.skipPatch) args.push('--patch');
  if (!options.skipSettings) args.push('--settings');
  if (!options.skipExtensions) args.push(`--extensions=${options.extensions}`);
  const summary = { ok: true, patched: false, extensions: options.skipExtensions ? 'skipped' : options.extensions, settings: options.skipSettings ? 'skipped' : 'merged', warnings: [] };
  try {
    // 1. 调 install.mjs 的对应步骤；失败（非 0）记进 warnings，不抛。
    execFileSync(process.execPath, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    summary.patched = process.platform === 'win32' && !options.skipPatch;
  } catch (error) {
    // 2. 失败只告警：restore 不应因为扩展/JDK 而中断。
    summary.ok = false;
    const stderr = typeof error?.stderr === 'string' ? error.stderr.trim().split(/\r?\n/u).slice(-3).join(' | ') : '';
    summary.warnings.push(stderr === '' ? String(error?.message ?? error) : stderr);
    summary.patched = false;
  }
  // 3. 附一句可操作提示（不打印任何本机敏感路径以外的信息）。
  const logFile = path.join(options.dshHome, 'logs', 'dsh-worktree-editor-post-restore.log');
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.appendFileSync(logFile, `${new Date().toISOString()} ${JSON.stringify(summary)}\n`, 'utf8');
  } catch { /* 日志失败也不影响退出码 */ }
  console.log(JSON.stringify(summary));
  return summary.ok ? 0 : 1;
}

process.exitCode = main();
