/**
 * dsh-worktree-editor 客户端入口（契约 v2 §4.6）。
 *
 * 形态说明：DSH 的客户端插件以 `window.__ModuleLoader__.load({id, factory})` 工厂装载
 * （同参考实现 plugins/dsh-plugin-ide 的产物体）。本插件**不引入构建工具**，源码即产物：
 * 工厂体内用 `React.createElement` 写 UI，纯函数额外挂到 `module.exports.__test` 供 `node --test` 用 VM 加载后单测。
 *
 * 注册面（两段式，契约 §4.6）：
 * 1. `sidebarRightTabs.register` 注册页面类型 `kind='cs-hub'`（不声明 patterns：一期不认领文件地址）；
 * 2. keyed 槽位正文/标题（key = 注册 id），正文吃 `sessionId` + `useTabInfo()`。
 *
 * 数据面：每会话一个 iframe，`src` 由 host 给的 `frameFolder` + 本端 healthz 探测出的 `pid` 组装；
 * 收到 `root-changed` 只让**该会话**的 iframe 重载（folder 变化才重载），切活动会话只 touch 不重载。
 */
window.__ModuleLoader__.load({
  id: 'dsh-worktree-editor',
  factory(require) {
    const React = require('react');
    const module = { exports: {} };
    const exports = module.exports;

    /** 页面类型 kind（tab type，不是注册 id）。 */
    const CS_HUB_KIND = 'cs-hub';
    /** 注册 id：全局唯一，必须是 kindDomain 形态（reference 用 `local:` 前缀）。 */
    const CS_HUB_TAB_ID = 'local:dsh-plugin-cs-hub';
    /** 顶栏「一键打开编辑器」动作的注册 id（`conversation.session.header.actions` 列表槽位）。 */
    const HEADER_ACTION_ID = 'cs-hub-open-editor';
    /** 顶栏动作排序：放在团队/创造模式之后、右侧工具之前（数值越大越靠右）。 */
    const HEADER_ACTION_ORDER = 40;
    /** RPC 频道与 SSE 端点（SSE 用 document-relative，跟页面 authority 走）。 */
    const RPC_CHANNEL = '/cs-hub';
    const SSE_URL = 'api/cs-hub/events';
    /** 文案命名空间。 */
    const NS = 'cs-hub';

    /** 中英文案（界面文案走 locale 服务，与宿主语言一致）。 */
    const ZH = {
      'tab.title': '编辑器',
      'guide.title': '编辑器',
      'guide.description': '跟随当前会话 worktree 的编辑器窗口',
      'state.loading': '正在解析会话 worktree…',
      'state.retry': '重试',
      'state.uncertain': '工作树状态切换中，稍等自动刷新',
      'state.degraded': '当前是会话目录（非 worktree）视图',
      'probe.mountMissing': '服务层未挂载（/code-server/ 404）：确认已安装 code-server 插件且 serve: dsh',
      'probe.upstream': '服务层未就绪：等待 launcher 启动后再点重试',
      'probe.auth': '登录态失效，请重新登录 DSH',
      'probe.network': '无法连接服务层（网络错误）',
      'frozen.title': '已冻结',
      'frozen.hint': '为控制内存，该窗口已冻结（扩展宿主已释放）',
      'frozen.recover': '点击恢复',
      'frozen.recovering': '恢复中…',
      'error.prefix': '加载失败：',
      'conflict.hint': '该目录的 bridge 路由已指向另一会话；关闭并重新打开本页签可重新接管。',
      'header.openEditor': '打开 code-server 编辑器',
    };
    const EN = {
      'tab.title': 'Editor',
      'guide.title': 'Editor',
      'guide.description': 'Editor window pinned to the current session worktree',
      'state.loading': 'Resolving session worktree…',
      'state.retry': 'Retry',
      'state.uncertain': 'Worktree state is changing, retrying shortly',
      'state.degraded': 'Showing the session directory (not a linked worktree)',
      'probe.mountMissing': 'Service not mounted (/code-server/ 404): install the code-server plugin with serve: dsh',
      'probe.upstream': 'Service not ready: wait for the launcher then retry',
      'probe.auth': 'Session expired, sign in again',
      'probe.network': 'Cannot reach the service (network error)',
      'frozen.title': 'Frozen',
      'frozen.hint': 'This window was frozen to save memory (extension host released)',
      'frozen.recover': 'Click to resume',
      'frozen.recovering': 'Resuming…',
      'error.prefix': 'Failed to load: ',
      'conflict.hint': 'The bridge route for this folder now points to another session; close and reopen this tab to take it back.',
      'header.openEditor': 'Open the code-server editor',
    };

    /**
     * 把本机路径转成 code-server 认的 folder 参数（契约 §1.1/§1.3）。
     *
     * 规则：反斜杠转正斜杠；`C:/x` 前面补 `/`（否则被当 URI scheme 剥掉盘符）；
     * UNC `\\server\share` 只做正斜杠化并前置 `/`，不丢前缀。
     * @param {string|undefined} folder 本机绝对路径（host 给的 frameFolder，通常已是 canonical）；
     *   允许 `undefined`/空串（state 尚未返回时），此时返回空串，由调用方退回不带 folder= 的 base URL。
     * @returns {string} 形如 `/C:/...` 或 `/server/share` 的 folder 参数值；空输入返回空串。
     */
    function toUrlFolder(folder) {
      // 1. 非字符串/空串直接返回空串（调用方会退回不带 folder= 的 base URL）。
      if (typeof folder !== 'string' || folder === '') return '';
      // 2. 正斜杠化，并把任意数量的前导斜杠收敛成一个（UNC 的 `//server/share` 走这一步）。
      const slashed = folder.replace(/\\/gu, '/');
      // 3. 盘符形态补前导 `/`（`C:/x` → `/C:/x`，否则被当 URI scheme 剥掉盘符）。
      return `/${slashed.replace(/^\/+/u, '')}`;
    }

    /**
     * 组装每会话 iframe 的 src（契约 §1.3 四步；纯函数，单测覆盖）。
     * @param {{base: string, instanceTag: string|number|null, folder: string}} input base=服务层挂载前缀
     *   （如 `/code-server/`）；instanceTag=healthz.pid（探测不到传 null）；folder=RootView.realRoot。
     * @returns {string} iframe src；folder 为空时只返回 base（沿用上次目录）。
     */
    function buildFrameSrc({ base, instanceTag, folder }) {
      // 1. base 兜底与尾斜杠归一化：避免拼出 `/code-server?folder=` 这类 404 路径。
      const root = typeof base === 'string' && base !== '' ? base : '/code-server/';
      const safeBase = root.endsWith('/') ? root : `${root}/`;
      // 2. folder 为空：只回 base（服务层会沿用上次打开的目录）。
      const urlFolder = toUrlFolder(folder);
      if (urlFolder === '') return safeBase;
      // 3. 实例标记可选：有 pid 才带 `?s=`，没有就从 `?folder=` 起（避免出现 `?s=&folder=`）。
      const query = typeof instanceTag === 'string' || typeof instanceTag === 'number'
        ? `?s=${encodeURIComponent(String(instanceTag))}&folder=${encodeURIComponent(urlFolder)}`
        : `?folder=${encodeURIComponent(urlFolder)}`;
      return `${safeBase}${query}`;
    }

    /**
     * 把一次 healthz 探测结果解释成「挂载/存活」四态（契约 §3.3；纯函数，单测覆盖）。
     * @param {{status?: number, body?: unknown, error?: unknown}} input status=HTTP 状态码（网络失败时 undefined）；
     *   body=已解析 JSON；error=网络异常。
     * @returns {{mounted: boolean, pid?: number, mode?: string, productPath?: string, htmlTag?: string,
     *   reason?: 'mount-missing'|'upstream-unavailable'|'auth'|'network'}} 判定结果。
     */
    function decideProbe({ status, body, error }) {
      // 1. 网络异常：无法判定。
      if (error !== undefined || typeof status !== 'number') return { mounted: false, reason: 'network' };
      // 2. 200 + ok:true：挂载在、服务层活着；带出 pid 等实例信息。
      if (status === 200) {
        if (typeof body !== 'object' || body === null || body.ok !== true) return { mounted: false, reason: 'upstream-unavailable' };
        const result = { mounted: true };
        if (Number.isInteger(body.pid)) result.pid = body.pid;
        if (typeof body.mode === 'string') result.mode = body.mode;
        if (typeof body.productPath === 'string') result.productPath = body.productPath;
        if (typeof body.htmlTag === 'string') result.htmlTag = body.htmlTag;
        return result;
      }
      // 3. 401/403：挂载在但没过 DSH fence（正常带 cookie 不会出现）。
      if (status === 401 || status === 403) return { mounted: true, reason: 'auth' };
      // 4. 404：前缀没挂上（包未装 / serve 没改成 dsh / 挂载失败）。
      if (status === 404) return { mounted: false, reason: 'mount-missing' };
      // 5. 502/503：挂载在但上游 launcher 未起（serve-dsh 回 503 code-server 未启动）。
      if (status === 502 || status === 503) return { mounted: false, reason: 'upstream-unavailable' };
      // 6. 其它状态码：按上游不可用处理（保守，不乐观放行）。
      return { mounted: false, reason: 'upstream-unavailable' };
    }

    /**
     * 同源探测服务层 healthz（必须带 credentials：DSH 的 cookie fence 在 /code-server/ 前置）。
     * @param {string} probeUrl healthz 完整路径（state.server.probeUrl）。
     * @param {AbortSignal} [signal] 取消信号。
     * @returns {Promise<object>} decideProbe 的结果。
     */
    async function probeServer(probeUrl, signal) {
      // 1. 路径兜底：probeUrl 缺失时用默认挂载前缀，避免 fetch 一个空串。
      const url = typeof probeUrl === 'string' && probeUrl !== '' ? probeUrl : '/code-server/healthz';
      try {
        const response = await fetch(url, { credentials: 'include', cache: 'no-store', signal });
        // 2. 200 才尝试解析 JSON；其余状态不需要体。
        if (response.status === 200) {
          let body;
          try { body = await response.json(); } catch { body = undefined; }
          return decideProbe({ status: response.status, body });
        }
        return decideProbe({ status: response.status });
      } catch (error) {
        // 3. AbortError 是调用方主动取消，不算网络失败（仍返回 network 由调用方丢弃）。
        return decideProbe({ error });
      }
    }

    /**
     * 由 state/probe/本地冻结标记推导界面该显示什么（纯函数，便于单测）。
     *
     * `frozen` 分支优先于 `frame`：命中即渲染「已冻结·点击恢复」占位、**不创建 iframe**，
     * 从而让该窗口的 extHost/LSP 真正退出（T9 修复的核心客户端行为）。
     * @param {object} input state=RPC 返回；probe=healthz 判定；loading=是否仍在加载；
     *   frozen=本地 SSE 冻结标记（window-frozen 置位、window-live/恢复清除）。
     * @returns {{kind: 'loading'|'error'|'uncertain'|'unavailable'|'frozen'|'frame', reason?: string}}
     *   kind 决定渲染分支；reason 是服务层不可用/出错时的原因码。
     */
    function decideViewState({ state, probe, loading, frozen }) {
      // 1. 加载中。
      if (loading === true) return { kind: 'loading' };
      // 2. 本地冻结标记优先于一切数据分支：冻结窗不渲染 iframe（服务端 state 可能还没来得及反映）。
      if (frozen === true) return { kind: 'frozen' };
      // 3. RPC 失败（根解析错误等）。
      if (state === null || state === undefined) return { kind: 'error', reason: 'state' };
      // 4. 不确定相：fail-closed，不渲染 iframe。
      if (state.root && state.root.uncertain === true) return { kind: 'uncertain' };
      // 5. 服务层不可用（挂载缺失 / 未起 / 鉴权失败 / 网络）。
      if (probe !== null && probe !== undefined && probe.mounted !== true) {
        return { kind: 'unavailable', reason: probe.reason ?? 'upstream-unavailable' };
      }
      // 6. 服务端记录为 frozen（例如刷新页面后本地标记还没收到）：同样销毁 iframe 显示占位。
      if (state.window && state.window.state === 'frozen') return { kind: 'frozen' };
      // 7. 正常渲染 iframe。
      return { kind: 'frame' };
    }

    /**
     * RPC 调用器（相对频道，宿主鉴权）。
     * @param {object} connection 宿主 connection 服务。
     * @param {string} endpoint 端点名。
     * @param {object} payload 入参（含 sessionId）。
     * @param {AbortSignal} [signal] 取消信号。
     * @returns {Promise<{ok: boolean, value?: object, error?: object}>} 服务端信封。
     */
    async function callRpc(connection, endpoint, payload, signal) {
      // 1. 正常路径：交给宿主的 connection.rpc.call（频道内相对端点，鉴权由宿主负责）。
      try {
        return await connection.rpc.call(RPC_CHANNEL, endpoint, payload, signal);
      } catch (error) {
        // 2. 取消：返回 aborted 语义失败信封（调用方按 signal.aborted 直接丢弃）。
        if (signal && signal.aborted) return { ok: false, error: { code: 'cs-hub/internal', message: 'aborted', details: {} } };
        // 3. 其它异常：归一化为 cs-hub/internal 失败信封，绝不向上抛（渲染层始终拿信封）。
        return { ok: false, error: { code: 'cs-hub/internal', message: String((error && error.message) || error), details: {} } };
      }
    }

    /**
     * 会话级事件存储：SSE 只开一条，按 sessionId 分发 root-changed/window-*。
     *
     * 冻结 / 恢复 / 冲突的记忆分三类（T9 + T11）：
     * - `window-frozen` 只置本地 frozen 标记，**不递增重拉计数**（重拉会打 state，旧实现会因此把冻结复活）；
     * - `window-live` 清冻结+冲突标记并递增重拉计数（恢复后要重新拿 frameFolder/实例标记再重建 iframe）；
     * - `root-changed` 递增重拉计数（携带 `frozen:true` 时同步冻结标记，冻结窗切根仍保持占位）；
     * - `registry-conflict` **只记录提示、不递增重拉计数**——被动重拉会重新接管所有权，形成无限回环（T11 / T6 M1）。
     * @returns {{subscribe: Function, getRevision: Function, isFrozen: Function, getConflict: Function,
     *   clearFrozen: Function, start: Function, sse: Function}} 存储。
     */
    function createSessionStore() {
      /** @type {Map<string, number>} sessionId → 该会话的重拉信号计数。 */
      const revisions = new Map();
      /** @type {Set<string>} 当前被 LRU 冻结、应由本端渲染占位的会话。 */
      const frozenSessions = new Set();
      /** @type {Map<string, {takenBy: string|null, folder: string|null}>} 被同 folder 会话顶掉的提示。 */
      const conflicts = new Map();
      const listeners = new Set();
      let sseState = 'connecting';

      /**
       * 通知订阅者。
       * @returns {void}
       */
      function notify() {
        for (const listener of [...listeners]) listener();
      }

      return {
        /**
         * 订阅任意会话的变更。
         * @param {Function} listener 变化回调。
         * @returns {Function} 退订函数。
         */
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        /**
         * 取某会话的重拉信号计数（变化即需要重拉 state）。
         * @param {string} sessionId 会话 ID。
         * @returns {number} 计数；未出现过为 0。
         */
        getRevision(sessionId) {
          return revisions.get(sessionId) ?? 0;
        },
        /**
         * 该会话当前是否被冻结（由 SSE window-frozen 置位、window-live/本地 recover 清除）。
         * @param {string} sessionId 会话 ID。
         * @returns {boolean} 冻结为 true。
         */
        isFrozen(sessionId) {
          return frozenSessions.has(sessionId);
        },
        /**
         * 取「本会话被同 folder 的其它会话顶掉」的提示信息（只用于 UI 提示，不驱动重拉）。
         * @param {string} sessionId 会话 ID。
         * @returns {{takenBy: string|null, folder: string|null}|undefined} 冲突信息；无冲突为 undefined。
         */
        getConflict(sessionId) {
          return conflicts.get(sessionId);
        },
        /**
         * 本地清除冻结标记（点「恢复」后立即让占位消失，等待 window-live/state 拿新 src）。
         * @param {string} sessionId 会话 ID。
         * @returns {void}
         */
        clearFrozen(sessionId) {
          frozenSessions.delete(sessionId);
          notify();
        },
        /**
         * 取 SSE 连接状态（诊断用）。
         * @returns {string} 'connecting' | 'open' | 'closed'。
         */
        sse() {
          return sseState;
        },
        /**
         * 启动 SSE 跟随（apply 级 effect 持有返回的清理函数）。
         * @returns {Function} 关闭 EventSource 的清理函数。
         */
        start() {
          const source = new EventSource(SSE_URL);
          /**
           * 解析一帧事件的 JSON 载荷。
           * @param {MessageEvent} event 事件。
           * @returns {object|null} 载荷对象；非法返回 null。
           */
          function payloadOf(event) {
            try {
              const data = JSON.parse(event.data);
              return data && typeof data === 'object' ? data : null;
            } catch { return null; }
          }
          /**
           * 解析一帧事件的 sessionId。
           * @param {MessageEvent} event 事件。
           * @returns {string|null} 会话 ID；载荷非法返回 null。
           */
          function sessionOf(event) {
            const data = payloadOf(event);
            return data && typeof data.sessionId === 'string' ? data.sessionId : null;
          }
          /**
           * 递增某会话的重拉计数并通知订阅者。
           * @param {string} sessionId 会话 ID。
           * @returns {void}
           */
          function bumpRevision(sessionId) {
            revisions.set(sessionId, (revisions.get(sessionId) ?? 0) + 1);
            notify();
          }
          source.addEventListener('open', () => { sseState = 'open'; notify(); });
          source.addEventListener('error', () => { sseState = 'closed'; notify(); });
          // 1. 根变化：携带 frozen 时同步本地冻结标记，然后重拉（state 现在是只读，重拉安全）。
          source.addEventListener('root-changed', (event) => {
            const data = payloadOf(event);
            if (!data || typeof data.sessionId !== 'string') return;
            if (data.frozen === true) frozenSessions.add(data.sessionId);
            bumpRevision(data.sessionId);
          });
          // 2. 同 folder 冲突：**只记录提示、不重拉**（重拉会重新接管，形成无限回环；T11 / T6 M1）。
          source.addEventListener('registry-conflict', (event) => {
            const data = payloadOf(event);
            if (!data || typeof data.sessionId !== 'string') return;
            conflicts.set(data.sessionId, {
              takenBy: typeof data.takenBy === 'string' ? data.takenBy : null,
              folder: typeof data.folder === 'string' ? data.folder : null,
            });
            notify();
          });
          // 3. 冻结：只置本地标记（不重拉，避免 state 把冻结拉回 live）。
          source.addEventListener('window-frozen', (event) => {
            const sessionId = sessionOf(event);
            if (sessionId === null) return;
            frozenSessions.add(sessionId);
            notify();
          });
          // 4. 恢复：清冻结与冲突标记并重拉（拿新 folder/实例标记重建 iframe）。
          source.addEventListener('window-live', (event) => {
            const sessionId = sessionOf(event);
            if (sessionId === null) return;
            frozenSessions.delete(sessionId);
            conflicts.delete(sessionId);
            bumpRevision(sessionId);
          });
          return () => { source.close(); sseState = 'closed'; };
        },
      };
    }

    /** 正文容器样式（占满页签区域，居中提示）。 */
    const ROOT_STYLE = { display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', padding: '16px', textAlign: 'center', color: 'var(--dsw-alias-label-secondary, #888)', fontSize: '13px' };

    /**
     * 生成页面正文组件（apply 时创建的 store 与 connection 在此闭包内）。
     *
     * 只用 `React.useState/useEffect`：宿主 React 版本不保证提供 `useSyncExternalStore`
     * （旧版缺失时会在渲染期直接抛错、整块正文空白），因此这里不依赖新 API。
     * @param {{store: object, connection: object, t: Function}} deps 数据面依赖与翻译函数。
     * @returns {Function} React 组件（props: sessionId + hooks/useTabInfo）。
     */
    function createBody({ store, connection, t }) {
      return function CsHubBody(props) {
        // 1. 会话与可见性：宿主可能以 hooks.tabInfo 或旧版 useTabInfo 注入，两种都兼容。
        const tabInfoHook = (props && props.hooks && props.hooks.tabInfo) || props.useTabInfo;
        const tabInfo = typeof tabInfoHook === 'function' ? tabInfoHook() : null;
        const sessionId = props && props.sessionId;
        const visible = !tabInfo || !tabInfo.tab || tabInfo.tab.visible !== false;
        // 2. 本地状态：RPC 结果、healthz 探测、加载/错误、恢复中、SSE 重拉计数。
        const [state, setState] = React.useState(null);
        const [probe, setProbe] = React.useState(null);
        const [loading, setLoading] = React.useState(true);
        const [error, setError] = React.useState(null);
        const [recovering, setRecovering] = React.useState(false);
        const [revision, setRevision] = React.useState(0);
        const [frozen, setFrozen] = React.useState(false);
        /** @type {[object|null, Function]} 同 folder 冲突提示（只展示，不驱动重拉）。 */
        const [conflict, setConflict] = React.useState(null);
        // 2.1 本地手动重拉计数（重试按钮 / iframe onError / 恢复成功时递增）。
        const [localTick, setLocalTick] = React.useState(0);
        // 3. 订阅会话级 SSE 信号（root-changed / window-frozen / window-live / registry-conflict）。
        React.useEffect(() => {
          if (typeof sessionId !== 'string') return undefined;
          const sync = () => {
            setRevision(store.getRevision(sessionId));
            setFrozen(store.isFrozen(sessionId));
            setConflict(store.getConflict(sessionId) ?? null);
          };
          sync();
          return store.subscribe(sync);
        }, [sessionId]);
        // 4. 拉取 state 并探测 healthz；SSE 信号（revision）或本地重拉（localTick）变化时重拉。
        React.useEffect(() => {
          if (typeof sessionId !== 'string') return undefined;
          // 4.1 冻结中不做重拉：state 会打扰服务端，且旧 host 会因此把冻结复活（T9）。
          if (store.isFrozen(sessionId)) { setLoading(false); return undefined; }
          const controller = new AbortController();
          let alive = true;
          setLoading(true);
          void (async () => {
            try {
              const result = await callRpc(connection, 'state', { sessionId }, controller.signal);
              if (!alive || controller.signal.aborted) return;
              if (!result.ok) {
                setError((result.error && result.error.message) || 'state');
                setState(null);
                setProbe(null);
                return;
              }
              setError(null);
              setState(result.value);
              // 4.1 probeUrl 由 host 给（挂载前缀改动时两边不会各拼一套）。
              const probed = await probeServer(result.value && result.value.server ? result.value.server.probeUrl : undefined, controller.signal);
              if (!alive || controller.signal.aborted) return;
              setProbe(probed);
            } finally {
              if (alive && !controller.signal.aborted) setLoading(false);
            }
          })();
          return () => { alive = false; controller.abort(); };
        }, [sessionId, revision, localTick, frozen]);
        // 5. 可见且未冻结时上报活跃（LRU 依据）；冻结窗不发 touch（复活只能走 recover）。
        React.useEffect(() => {
          if (!visible || frozen || typeof sessionId !== 'string') return;
          void callRpc(connection, 'window.touch', { sessionId });
        }, [visible, sessionId, revision, frozen]);
        // 6. 卸载即销毁该会话窗口（keepMounted 下只发生在关页签/会话结束）。
        React.useEffect(() => () => {
          if (typeof sessionId === 'string') void callRpc(connection, 'window.destroy', { sessionId });
        }, [sessionId]);

        /**
         * 恢复被 LRU 冻结的窗口：host 置 live 后广播 window-live，本端清本地冻结标记并重拉重建 iframe。
         * @returns {Promise<void>} 恢复请求完成时兑现。
         */
        async function recover() {
          setRecovering(true);
          try {
            const result = await callRpc(connection, 'window.recover', { sessionId });
            // 1. 成功即本地清冻结标记并手动重拉（不等 SSE，避免广播偶发丢失时占位卡住）。
            if (result && result.ok) {
              store.clearFrozen(sessionId);
              setFrozen(false);
              setLocalTick((value) => value + 1);
            }
          } finally {
            setRecovering(false);
          }
        }

        /**
         * 渲染一个居中提示块。
         * @param {object} children React 子节点。
         * @returns {object} React 元素。
         */
        function box(children) {
          return React.createElement('div', { className: 'dsh-cs-hub-root', style: ROOT_STYLE }, children);
        }

        /**
         * 渲染带「重试」按钮的提示块。
         * @param {string} message 提示文案。
         * @returns {object} React 元素。
         */
        function retryBox(message) {
          return box(React.createElement('div', null,
            React.createElement('div', null, message),
            React.createElement('button', {
              type: 'button',
              onClick: () => setLocalTick((value) => value + 1),
              style: { marginTop: '8px' },
            }, t('state.retry')),
          ));
        }

        // 7. 状态分支渲染（frozen 优先于 frame：占位分支不创建 iframe，从而卸载 extHost）。
        const view = decideViewState({ state, probe, loading, frozen });
        if (view.kind === 'loading') return box(t('state.loading'));
        if (view.kind === 'uncertain') return box(t('state.uncertain'));
        if (view.kind === 'error') return retryBox(t('error.prefix') + (error === null ? '' : error));
        if (view.kind === 'unavailable') {
          const key = view.reason === 'mount-missing' ? 'probe.mountMissing'
            : view.reason === 'auth' ? 'probe.auth'
              : view.reason === 'network' ? 'probe.network'
                : 'probe.upstream';
          return retryBox(t(key));
        }
        if (view.kind === 'frozen') {
          return box(React.createElement('div', null,
            React.createElement('div', { style: { fontWeight: 600, marginBottom: '6px' } }, t('frozen.title')),
            React.createElement('div', null, t('frozen.hint')),
            React.createElement('button', {
              type: 'button',
              disabled: recovering,
              onClick: () => { void recover(); },
              style: { marginTop: '10px' },
            }, recovering ? t('frozen.recovering') : t('frozen.recover')),
          ));
        }
        // 8. 正常渲染：每会话一个 iframe，src 由 host 的 frameFolder + healthz.pid 组装。
        //    - 不加 sandbox（同源下写了等于没写，契约 §1.3）；
        //    - key 用 sessionId + 会话窗口 revision：只有该会话的根变了才重建 iframe；
        //    - 被同 folder 会话顶掉时只加一条提示（不重拉、不 fight，见 T11 M1）。
        const src = buildFrameSrc({
          base: state && state.server ? state.server.base : undefined,
          instanceTag: probe && probe.pid !== undefined ? probe.pid : null,
          folder: state ? state.frameFolder : undefined,
        });
        const frame = React.createElement('iframe', {
          key: 'cs-hub:' + sessionId + ':' + (state && state.window ? state.window.revision : 0),
          title: t('tab.title'),
          src,
          allow: 'clipboard-read; clipboard-write',
          style: { width: '100%', height: '100%', border: '0', display: 'block', background: '#1f1f1f' },
          onError: () => setLocalTick((value) => value + 1),
        });
        if (conflict === null) return frame;
        return React.createElement('div', { style: { display: 'flex', flexDirection: 'column', height: '100%' } },
          React.createElement('div', {
            className: 'dsh-cs-hub-conflict',
            style: { padding: '6px 10px', fontSize: '12px', lineHeight: 1.4, color: 'var(--dsw-alias-label-secondary, #b08000)' },
          }, t('conflict.hint')),
          React.createElement('div', { style: { flex: '1 1 auto', minHeight: 0 } }, frame),
        );
      };
    }

    /**
     * 生成页签标题组件。
     * @param {Function} t 翻译函数。
     * @returns {Function} React 组件。
     */
    function createTitle(t) {
      return function CsHubTitle() {
        // 1. 标题只显示固定文案（不显示会话名，页签本身已经带会话上下文）。
        return React.createElement('span', { className: 'dsh-cs-hub-title' }, t('tab.title'));
      };
    }

    /**
     * 顶栏动作的纯描述（供单测断言 id/order/文案，不依赖 React）。
     * @param {Function} t 翻译函数。
     * @returns {{id: string, order: number, label: string}} 注册 id、排序与可访问名。
     */
    function describeHeaderAction(t) {
      // 1. id/order 是常量；label 跟随宿主语言（aria-label 与 title 共用）。
      return { id: HEADER_ACTION_ID, order: HEADER_ACTION_ORDER, label: t('header.openEditor') };
    }

    /**
     * 生成顶栏「一键打开编辑器」按钮组件。
     *
     * 依赖通过闭包传入（`openTabIn`），slot 运行时只给 `sessionId` 与 `t`；
     * 按钮样式与宿主顶栏其它动作一致：28×28、token 取色、hover 用官方 interactive token。
     * @param {{openTabIn: (sessionId: string) => void}} deps 打开编辑器页签的函数。
     * @returns {Function} React 组件（props: sessionId + t）。
     */
    function createHeaderButton({ openTabIn }) {
      return function CsHubHeaderButton({ sessionId, t }) {
        const meta = describeHeaderAction(t);
        // 1. 无会话时不渲染（slot 本身 scope=session，这里再兜一层）。
        if (typeof sessionId !== 'string') return null;
        // 2. 图标用 currentColor 描边，颜色交给顶栏 token。
        return React.createElement('button', {
          type: 'button',
          id: meta.id,
          className: 'dsh-cs-hub-header-button',
          title: meta.label,
          'aria-label': meta.label,
          onClick: () => openTabIn(sessionId),
        }, React.createElement('svg', {
          width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true',
          strokeWidth: 1.4, stroke: 'currentColor', strokeLinecap: 'round', strokeLinejoin: 'round',
        },
        React.createElement('path', { d: 'M5.5 3.5 1.5 8l4 4.5' }),
        React.createElement('path', { d: 'M10.5 3.5 14.5 8l-4 4.5' })));
      };
    }

    /** 本 client 模块必需的浏览器服务。 */
    const inject = ['slots', 'locale', 'connection', 'sidebarRightTabs', 'sidebarRight'];

    /**
     * Client 插件体：样式、文案、数据面（SSE）、右侧栏页签注册。
     * @param {object} ctx 浏览器 Cordis 上下文。
     * @returns {void}
     */
    function apply(ctx) {

      // 1. 插件级样式：apply effect 持有，卸载即移除。
      ctx.effect(() => {
        const style = document.createElement('style');
        style.setAttribute('data-dsh-plugin-cs-hub', '');
        style.textContent = [
          '.dsh-cs-hub-root{background:transparent}',
          '.dsh-cs-hub-root button{font:inherit;color:inherit;background:transparent;border:1px solid currentColor;border-radius:6px;padding:2px 10px;cursor:pointer}',
          '.dsh-cs-hub-root button[disabled]{opacity:.6;cursor:default}',
          '.dsh-cs-hub-title{display:inline-flex;align-items:center;gap:5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
          // 顶栏动作按钮：尺寸/圆角/取色对齐宿主（参考 ui-subagent 的 sidebarButton）。
          '.dsh-cs-hub-header-button{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;margin:4px 0;padding:6px;flex:none;border:0;border-radius:var(--dsw-radius-sm);background:0 0;color:var(--dsw-alias-label-tertiary);cursor:pointer}',
          '.dsh-cs-hub-header-button:hover,.dsh-cs-hub-header-button:focus-visible{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
        ].join('\n');
        document.head.appendChild(style);
        return () => style.remove();
      }, 'cs-hub: styles');
      // 2. 文案字典与绑定翻译。
      ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), 'cs-hub: locales');
      const t = ctx.locale.bind(NS);
      // 3. 数据面：单条 SSE + RPC 包装（生命周期与插件一致）。
      const store = createSessionStore();
      ctx.effect(() => store.start(), 'cs-hub: sse follow');
      const Body = createBody({ store, connection: ctx.connection, t });
      const Title = createTitle(t);
      // 4. 页面类型注册：每会话最一个（multiple:false），keepMounted 保证切会话不卸载 iframe。
      ctx.effect(() => ctx.sidebarRightTabs.register({
        id: CS_HUB_TAB_ID,
        kind: CS_HUB_KIND,
        priority: 'extension',
        multiple: false,
        keepMounted: true,
        title: () => t('tab.title'),
        guide: [{
          id: 'cs-hub',
          order: 30,
          title: () => t('guide.title'),
          description: () => t('guide.description'),
        }],
      }), 'cs-hub: tab type');
      // 5. 正文与标题（keyed by 注册 id）。
      ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
        name: 'sidebar.right.pane.tab', key: CS_HUB_TAB_ID, locale: NS,
      }, Body)), 'cs-hub: body');
      ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
        name: 'sidebar.right.pane.tab.title', key: CS_HUB_TAB_ID, locale: NS,
      }, Title)), 'cs-hub: title');
      // 6. 顶栏动作：一键打开/激活本会话的编辑器页签（`openTabIn` 会展开右栏并激活该 tab）。
      const HeaderButton = createHeaderButton({
        openTabIn: (sessionId) => ctx.sidebarRight.openTabIn(sessionId, CS_HUB_KIND),
      });
      ctx.effect(() => ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
        name: 'conversation.session.header.actions',
        id: HEADER_ACTION_ID,
        order: HEADER_ACTION_ORDER,
        locale: NS,
      }, HeaderButton)), 'cs-hub: header action');
    }

    // 6. 导出（__test 仅供 node --test 通过 VM 加载后单测纯函数，不参与运行时）。
    module.exports = { apply, inject, __test: { toUrlFolder, buildFrameSrc, decideProbe, decideViewState, describeHeaderAction, createHeaderButton } };
    return module.exports;
  },
});
