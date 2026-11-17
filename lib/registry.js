/**
 * 窗口注册表 + LRU（设计 §6 / §8，契约 v2 §4.2）。
 *
 * 数据模型：
 * - 正表 `Map<sessionId, WindowRecord>`：一个会话最多一条窗口记录；
 * - 反表 `Map<folderKey, sessionId>`：bridge 路由键，`folderKey = pathKey(realRoot)`（Windows 折叠大小写）。
 * - 一个 realFolder 同一时刻只归属一个会话：后注册者胜出，旧记录标 `stale` 并由调用方广播告警（不静默）。
 *
 * LRU 语义（契约 §8）：
 * - `maxLiveWindows` 是 **live（已渲染 iframe）** 窗口上限，冻结中的窗口不占名额；
 * - register / touch / recover 之后若 live 数超上限，冻结 `lastActiveAt` 最旧的 live 窗口；
 * - 当前活动会话豁免（不会被自己触发的冻结踢掉）。
 *
 * 纯内存实现：不碰磁盘、不依赖时钟（`now` 可注入），因此可离线单测。
 */
import { pathKey } from './paths.js';

/**
 * @typedef {object} WindowRecord
 * @property {string} sessionId 所属会话 ID。
 * @property {string} folder 词法绝对路径（RootView.root），仅作展示/诊断。
 * @property {string} realFolder canonical 路径（RootView.realRoot），反查索引键。
 * @property {'live'|'frozen'} state 窗口是否已渲染 iframe。
 * @property {number} lastActiveAt epoch 毫秒；LRU 冻结的唯一依据。
 * @property {number} revision 每次 folder 变化递增（客户端据此判断要不要重拼 src）。
 * @property {boolean} stale 该记录是否已被同 folder 的新会话顶掉（仅诊断/告警用）。
 */

/**
 * 创建窗口注册表。
 * @param {object} options 构造参数。
 * @param {number} [options.maxLiveWindows=3] live 窗口上限（调用方已归一化到 [1, 6]）。
 * @param {() => number} [options.now=Date.now] 时钟注入（单测用）。
 * @returns {object} 注册表实例（register/touch/recover/freezeLRU/destroy/list/resolveByFolder/setMax）。
 */
export function createWindowRegistry({ maxLiveWindows = 3, now = Date.now } = {}) {
  /** @type {Map<string, WindowRecord>} */
  const bySession = new Map();
  /** @type {Map<string, string>} */
  const byFolder = new Map();
  let limit = maxLiveWindows;

  /**
   * 统计当前 live 窗口数。
   * @returns {number} state === 'live' 的记录数。
   */
  function liveCount() {
    // 1. 逐条计数（窗口规模只有个位数，不做额外缓存）。
    let count = 0;
    for (const record of bySession.values()) if (record.state === 'live') count += 1;
    return count;
  }

  /**
   * 按 lastActiveAt 升序返回 live 记录（最旧的在前）。
   * @returns {WindowRecord[]} live 记录数组（新数组，可安全遍历）。
   */
  function liveByAge() {
    // 1. 过滤 live，按活跃时间升序；同刻按 sessionId 保证确定性。
    return [...bySession.values()]
      .filter((record) => record.state === 'live')
      .sort((a, b) => a.lastActiveAt - b.lastActiveAt || (a.sessionId < b.sessionId ? -1 : 1));
  }

  /**
   * 冻结最旧的 live 窗口（当前活动会话豁免）。一次只冻结一个，调用方循环调用直至满足上限。
   * @param {string} [activeSessionId] 当前活动会话；它永不被本函数冻结。
   * @returns {WindowRecord|undefined} 被冻结的记录；没有可冻结对象时 undefined。
   */
  function freezeLRU(activeSessionId) {
    // 1. 取最旧且不是当前活动的 live 窗口。
    const victim = liveByAge().find((record) => record.sessionId !== activeSessionId);
    if (victim === undefined) return undefined;
    // 2. 置冻结态：记录保留（恢复时不用重新解析根），但不再占 live 名额。
    victim.state = 'frozen';
    return victim;
  }

  /**
   * 把 live 数压回上限内，返回本次被冻结的会话列表。
   * @param {string} [activeSessionId] 当前活动会话（豁免冻结）。
   * @returns {string[]} 被冻结的会话 ID（按冻结顺序）。
   */
  function enforceLimit(activeSessionId) {
    // 1. 逐次冻结最旧窗口，直到 live 数不超过上限或没有可冻结对象（防御死循环）。
    const frozen = [];
    let guard = bySession.size + 1;
    while (liveCount() > limit && guard > 0) {
      const victim = freezeLRU(activeSessionId);
      if (victim === undefined) break;
      frozen.push(victim.sessionId);
      guard -= 1;
    }
    return frozen;
  }

  /**
   * 注册/更新一个会话的窗口记录（首次访问 state、根变化、冻结窗口恢复都走这里）。
   * @param {string} sessionId 会话 ID。
   * @param {{root: string, realRoot: string}} view 根视图（root 词法路径、realRoot canonical）。
   * @param {{preserveFrozen?: boolean}} [options] preserveFrozen=true 时：记录已存在且处于 frozen，
   *   则**保持冻结**（只更新 folder/revision，不复活）。`state` 端点的重拉必须用这个口径，
   *   否则冻结刚发出就会被自己的 state 拉回 live（T5 实证的 LRU 复活 bug）。
   *   新会话首次注册（记录不存在）仍然注册为 live——那是「懒注册」，不是复活。
   * @returns {{record: WindowRecord, frozen: string[], conflict: {sessionId: string, folder: string}|null}}
   *   record=该会话最新记录；frozen=本次因 LRU 被冻结的会话；conflict=同 folder 被顶掉的旧会话（无则 null）。
   */
  function register(sessionId, view, { preserveFrozen = false } = {}) {
    // 1. 计算反查键，并处理「一个 folder 同时只归属一个会话」：后注册者胜出。
    const key = pathKey(view.realRoot);
    const previousOwner = byFolder.get(key);
    let conflict = null;
    if (typeof previousOwner === 'string' && previousOwner !== sessionId) {
      const staleRecord = bySession.get(previousOwner);
      if (staleRecord !== undefined) {
        // 1.1. 旧记录标 stale 并从反表摘除（它的 iframe 由客户端收到 root-changed 后自行重定向）。
        staleRecord.stale = true;
        conflict = { sessionId: previousOwner, folder: staleRecord.folder };
      }
      byFolder.delete(key);
    }
    // 2. 复用/新建记录；folder 变化时递增 revision，客户端据此重拼 iframe src。
    const existing = bySession.get(sessionId);
    const changedFolder = existing !== undefined && pathKey(existing.realFolder) !== key;
    if (existing !== undefined) {
      // 2.1. 会话切了根：先把旧反查键摘掉，避免旧 folder 继续指向本会话。
      if (changedFolder) byFolder.delete(pathKey(existing.realFolder));
    }
    // 2.2. 关键分支：已冻结的记录在 preserveFrozen 下**不得复活**（只有 recover 能置 live）。
    const keepFrozen = preserveFrozen && existing !== undefined && existing.state === 'frozen';
    /** @type {WindowRecord} */
    const record = existing ?? {
      sessionId,
      folder: view.root,
      realFolder: view.realRoot,
      state: 'live',
      lastActiveAt: now(),
      revision: 0,
      stale: false,
    };
    record.folder = view.root;
    record.realFolder = view.realRoot;
    record.stale = false;
    if (keepFrozen) {
      // 2.3. 冻结中：不动 state、也不刷新 lastActiveAt（避免重拉把冻结窗口「变新」、污染 LRU 排序）。
    } else {
      record.state = 'live';
      record.lastActiveAt = now();
    }
    if (changedFolder) record.revision += 1;
    bySession.set(sessionId, record);
    // 3. 反表指向本会话。
    byFolder.set(key, sessionId);
    // 4. 注册即可能超上限：冻结最旧的其他窗口（当前会话豁免）。
    const frozen = enforceLimit(sessionId);
    return { record, frozen, conflict };
  }

  /**
   * 更新会话活跃时间（切活动会话 / iframe 获得焦点）。
   *
   * **不改变 frozen/live**：冻结窗口的客户端不应发 touch；即使发了也只刷新时间、不复活
   * （复活只允许走 `recover`，见 T9 修复说明）。
   * @param {string} sessionId 会话 ID。
   * @returns {{record: WindowRecord, frozen: string[]}|undefined} 更新后的记录；会话未注册时 undefined。
   */
  function touch(sessionId) {
    // 1. 未注册的会话不隐式创建（必须先用 state 注册，避免把无效会话写进表）。
    const record = bySession.get(sessionId);
    if (record === undefined) return undefined;
    // 2. 只刷新活跃时间；frozen 保持 frozen。
    record.lastActiveAt = now();
    // 3. 兜底压一次上限（正常不会因 touch 超限，防止历史遗留超限）。
    return { record, frozen: enforceLimit(sessionId) };
  }

  /**
   * 恢复一个被冻结的窗口（用户点「已冻结·点击恢复」）——**唯一** frozen→live 的入口。
   * @param {string} sessionId 会话 ID。
   * @returns {{record: WindowRecord, frozen: string[]}|undefined} 恢复后的记录；未注册时 undefined。
   */
  function recover(sessionId) {
    // 1. 未注册会话不隐式创建。
    const record = bySession.get(sessionId);
    if (record === undefined) return undefined;
    // 2. 显式置 live 并刷新活跃时间。
    record.state = 'live';
    record.lastActiveAt = now();
    // 3. 恢复可能挤压别的窗口（当前会话豁免）。
    return { record, frozen: enforceLimit(sessionId) };
  }

  /**
   * 销毁一个会话的窗口（会话结束 / worktree 收尾）。幂等。
   * @param {string} sessionId 会话 ID。
   * @returns {boolean} 是否真的移除了记录（未注册时 false）。
   */
  function destroy(sessionId) {
    // 1. 正表移除；反表只在确实指向本会话时移除（避免误删别人的键）。
    const record = bySession.get(sessionId);
    if (record === undefined) return false;
    bySession.delete(sessionId);
    const key = pathKey(record.realFolder);
    if (byFolder.get(key) === sessionId) byFolder.delete(key);
    return true;
  }

  /**
   * 只读取一个会话的窗口记录（**不改状态、不接管所有权、不广播**）。
   *
   * `state` 端点对已存在会话必须走这里：被动读永远不能改写 frozen/live 与反查所有权，
   * 否则两个会话同 folder 时会互相顶掉并触发无限重拉回环（T11 / T6 M1）。
   * @param {string} sessionId 会话 ID。
   * @returns {WindowRecord|undefined} 记录；未注册时 undefined。
   */
  function get(sessionId) {
    // 1. 直接查正表；返回内部记录供只读消费（调用方不得修改）。
    return bySession.get(sessionId);
  }

  /**
   * 按 canonical folder 反查会话（bridge 路由键，fail-closed：未命中返回 undefined）。
   * @param {string} folder 绝对路径（调用方通常会先 realpath）。
   * @returns {string|undefined} 归属该 folder 的会话 ID。
   */
  function resolveByFolder(folder) {
    // 1. 键归一化后查反表；未命中即未命中，绝不模糊匹配。
    return byFolder.get(pathKey(folder));
  }

  /**
   * 列出全部窗口记录（live + frozen），供 state 返回。
   * @returns {WindowRecord[]} 记录数组（新数组）。
   */
  function list() {
    // 1. 返回浅拷贝数组；记录本身是内部对象，调用方只读。
    return [...bySession.values()];
  }

  /**
   * 调整 live 上限（配置热更新/测试用）。
   * @param {number} next 新上限（调用方负责归一化）。
   * @returns {string[]} 因收紧上限而被冻结的会话。
   */
  function setMax(next) {
    // 1. 更新上限并按当前活动会话（未知）压一次；没有活动会话时会冻结最旧的即可。
    limit = next;
    return enforceLimit(undefined);
  }

  return {
    register,
    touch,
    recover,
    freezeLRU: (activeSessionId) => {
      // 1. 对外的 freezeLRU 只冻结一个，并在冻结后返回该记录。
      return freezeLRU(activeSessionId);
    },
    destroy,
    get,
    resolveByFolder,
    list,
    setMax,
    /** @returns {number} 当前 live 上限。 */
    get maxLiveWindows() { return limit; },
    /** @returns {number} 当前 live 窗口数。 */
    get liveCount() { return liveCount(); },
  };
}
