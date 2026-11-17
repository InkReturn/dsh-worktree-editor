/**
 * 会话根解析（设计 §4，复刻 plugins/dsh-plugin-ide/lib/root.js 后裁剪）。
 *
 * 解析优先级（DSH 0.2.1 起以官方 workingDirectory 为主）：
 * 1. 自定义 worktree 插件账本明确处于 worktree 时采信它（过渡兼容；本机该插件已停用，服务缺席即跳过）；
 * 2. 官方 workingDirectory 服务在场时采信它（官方 create_worktree 与 working_directory 都只更新它）；
 * 3. 两个服务都缺席时降级为会话不可变的 header.cwd，并置 degraded 标记。
 *
 * 每次调用实时解析、绝不缓存：会话内切 worktree 后必须立刻反映到 iframe 的 `?folder=`。
 */
import fs from 'node:fs';
import path from 'node:path';
import { CsHubError } from './errors.js';
import { isExplicitAbsolute } from './paths.js';

/** 不确定相：guard fail-closed 口径，数据端点拒绝、UI 显示 ⚠。 */
export const UNCERTAIN_PHASES = Object.freeze(['blocked', 'entering', 'leaving']);

/**
 * 定位一个检出目录的 Git 目录，兼容 linked worktree 的 `.git` 文件形态。
 * @param {string} root 检出根绝对目录。
 * @returns {string|undefined} Git 目录绝对路径；非检出或读取失败时 undefined。
 */
function resolveGitDir(root) {
  try {
    const dotGit = path.join(root, '.git');
    const stat = fs.statSync(dotGit);
    // 1. 主检出：`.git` 是目录，直接作为 Git 目录。
    if (stat.isDirectory()) return dotGit;
    // 2. linked worktree：`.git` 是文件，内容为 `gitdir: <相对或绝对路径>`。
    if (!stat.isFile()) return undefined;
    const match = /^gitdir:\s*(.+)$/mu.exec(fs.readFileSync(dotGit, 'utf8'));
    if (!match) return undefined;
    return path.resolve(root, match[1].trim());
  } catch { return undefined; }
}

/**
 * 判断一个检出目录是否是 linked worktree（而非主检出或 submodule）。
 * @param {string} root 检出根绝对目录。
 * @returns {boolean} `.git` 文件指向的私有 Git 目录带 `commondir` 时为 true。
 */
function isLinkedWorktree(root) {
  const gitDir = resolveGitDir(root);
  // 1. 主检出（`.git` 目录）与不可读目录不是 linked worktree。
  if (gitDir === undefined || gitDir === path.join(root, '.git')) return false;
  // 2. linked worktree 的私有 Git 目录固定带 commondir；submodule 等形态没有该文件。
  try { return fs.statSync(path.join(gitDir, 'commondir')).isFile(); } catch { return false; }
}

/**
 * 直接读取检出目录 HEAD 指向的分支名，不启动 git 子进程。
 * @param {string} root 检出根绝对目录。
 * @returns {string|undefined} 分支名；detached HEAD 返回前 12 位提交号；失败返回 undefined。
 */
function readHeadBranch(root) {
  const gitDir = resolveGitDir(root);
  if (gitDir === undefined) return undefined;
  try {
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    // 1. 常规分支 HEAD 形如 `ref: refs/heads/<branch>`。
    if (head.startsWith('ref: ')) {
      const ref = head.slice(5);
      return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
    }
    // 2. detached HEAD 直接是提交对象名，用短号供角标显示。
    return head.slice(0, 12);
  } catch { return undefined; }
}

/**
 * 由官方 workingDirectory 给出的绝对目录构造根视图（供 state 端点与 SSE 共用）。
 * 不读会话、不调自定义 worktree 服务；目录必须真实存在。
 * @param {string} root 官方 workingDirectory 给出的绝对目录。
 * @returns {{root: string, kind: 'worktree'|'session', branch: string|undefined, phase: 'active'|'idle'}|undefined}
 *   根视图；非法或不存在时 undefined。
 */
export function describeWorkingDirectoryRoot(root) {
  // 1. 只接受完全限定绝对路径；非法形态交给调用方报 root-missing。
  if (!isExplicitAbsolute(root)) return undefined;
  // 2. 根必须真实存在，避免把已删除目录写进 SSE / iframe 地址。
  try { fs.realpathSync.native(root); } catch { return undefined; }
  // 3. linked worktree 与普通会话目录用同一套 HEAD 读取逻辑，不 spawn git。
  const worktree = isLinkedWorktree(root);
  return {
    root,
    kind: worktree ? 'worktree' : 'session',
    branch: readHeadBranch(root),
    phase: worktree ? 'active' : 'idle',
  };
}

/**
 * 取一个已存在目录的 canonical 路径（`fs.realpathSync.native`）。
 * @param {string} root 词法绝对目录。
 * @returns {string|undefined} canonical 路径；不存在/非法/读取失败时 undefined。
 */
export function canonicalRoot(root) {
  // 1. 先过绝对路径与存在性判定，再取 canonical（与 resolveSessionRoot 第 6 步同口径）。
  if (!isExplicitAbsolute(root)) return undefined;
  try { return fs.realpathSync.native(root); } catch { return undefined; }
}

/**
 * 解析一个会话的当前根目录。
 * @param {object} ctx host 插件上下文；经 ctx.get 读取 `sessions`、`workingDirectory` 与可选 `worktreeRoot`。
 * @param {string} sessionId 目标会话 ID（调用方已做形状校验）。
 * @param {{allowUncertain?: boolean}} [options] allowUncertain=true 时不确定相不抛错，以 uncertain=true 返回
 *   （仅 state 端点使用，让 UI 能显示 ⚠ 提示而不是报错）。
 * @returns {{root: string, realRoot: string, kind: 'worktree'|'session', branch: string|undefined,
 *   phase: string, degraded: boolean, uncertain: boolean}} 根视图；realRoot 是 canonical 路径（注册表键）。
 * @throws {CsHubError} `cs-hub/session-not-found`、`cs-hub/root-uncertain`、`cs-hub/root-missing`、`cs-hub/internal`。
 */
export function resolveSessionRoot(ctx, sessionId, { allowUncertain = false } = {}) {
  // 1. 会话必须真实存在；header.cwd 是不可变的最终降级来源。
  const sessions = ctx.get('sessions');
  const session = sessions?.get(sessionId);
  if (!session) throw new CsHubError('cs-hub/session-not-found', '会话不存在', { sessionId });
  const workingDirectory = ctx.get('workingDirectory');
  const worktreeRoot = ctx.get('worktreeRoot');
  // 2. 先读自定义 worktree 账本：仅当它明确报告 worktree 时才优先（过渡期兼容）。
  /** @type {{root?: string, kind?: 'worktree'|'session', branch?: string, phase?: string}|undefined} */
  let info;
  if (worktreeRoot) {
    try { info = worktreeRoot.resolve(sessionId); }
    catch (error) {
      // 2.1. 服务在场但解析失败：不静默降级（会掩盖账本故障），如实上报内部错误。
      throw new CsHubError('cs-hub/internal', 'worktreeRoot 解析失败', {}, { cause: error });
    }
  }
  const customManaged = info !== undefined && info.kind === 'worktree';
  // 3. 官方 workingDirectory 为主：create_worktree 与 working_directory 都只更新它。
  if (!customManaged && workingDirectory) {
    let officialRoot;
    try { officialRoot = workingDirectory.get(session); }
    catch (error) {
      throw new CsHubError('cs-hub/internal', 'workingDirectory 解析失败', {}, { cause: error });
    }
    info = describeWorkingDirectoryRoot(officialRoot);
    if (!info) throw new CsHubError('cs-hub/root-missing', '会话根目录缺失或非法', { sessionId });
  }
  // 4. 两个根服务都缺席才算降级；任何服务在场都让 UI 显示真实角标。
  const degraded = !workingDirectory && !worktreeRoot;
  const phase = info?.phase ?? 'idle';
  const uncertain = UNCERTAIN_PHASES.includes(phase);
  if (uncertain && !allowUncertain) throw new CsHubError('cs-hub/root-uncertain', '工作树状态不确定，等待落定', { phase });
  // 5. 根来源：服务给出的根优先；全部缺席时回退会话 header.cwd。
  const root = info?.root ?? session.header?.cwd;
  if (!isExplicitAbsolute(root)) throw new CsHubError('cs-hub/root-missing', '会话根目录缺失或非法', { sessionId });
  // 6. 根必须真实存在；canonical 路径既是 iframe folder 也是注册表反查键（契约 §1.3）。
  let realRoot;
  try { realRoot = fs.realpathSync.native(root); }
  catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      throw new CsHubError('cs-hub/root-missing', '会话根目录不存在', { root: undefined }, { cause: error });
    }
    throw new CsHubError('cs-hub/internal', '会话根目录读取失败', {}, { cause: error });
  }
  return { root, realRoot, kind: info?.kind ?? 'session', branch: info?.branch, phase, degraded, uncertain };
}
