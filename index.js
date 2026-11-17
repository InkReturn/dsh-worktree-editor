/**
 * @local/dsh-plugin-cs-hub 的 host 半入口（契约 v3 §4.1/§4.2/§4.2.1/§4.3/§4.4/§4.5）。
 *
 * 职责：
 * 1. `/cs-hub` 逻辑频道上的四个一元 RPC 端点（state / window.touch / window.recover / window.destroy）；
 * 2. `/api/cs-hub/events` 的 SSE 推送，共 6 种事件：
 *    root-changed / window-frozen / window-live / registry-conflict / bridge-event / server-status；
 * 3. `session/event` 的 `working-directory/change`（以及过渡期兼容的 `worktree-root/changed`）→
 *    更新窗口注册表 + 反查索引 → 广播 `root-changed`（客户端只重载该会话的 iframe）；
 * 4. `/cs-hub-bridge/*` 前缀路由（自带令牌鉴权，移出 `/api` 以绕开 cookie fence）；
 * 5. 全部资源随插件 fiber 卸载（SSE 枢纽、webServer 路由、RPC 频道、事件监听都由 ctx.effect 持有）。
 *
 * 注意：本入口**不判断服务层是否存活**（契约 §3.3：host 过不了 DSH 的 cookie fence，
 * 存活只能由浏览器侧 probeServer 判定），也**不启动服务层**（服务层自己 prestart，重复拉起会撞端口）。
 */
import { normalizeConfig } from './lib/config.js';
import { CS_HUB_CHANNEL, dispatchCsHubEndpoint } from './lib/endpoints.js';
import { createWindowRegistry } from './lib/registry.js';
import { canonicalRoot, describeWorkingDirectoryRoot } from './lib/root.js';
import { createServerConfig, resolveDshHome } from './lib/server.js';
import { createSseHub } from './lib/sse.js';
import {
  BRIDGE_BASE,
  createBridgeHandler,
  rotateBridgeToken,
} from './lib/bridge.js';

/** 稳定 Cordis 插件名（必须与 cordis.patch.yml 的 id 一致）。 */
export const name = 'cs-hub';

/** SSE 路由：必须落在 `/api` 下（desktop 的 IPC 帧管道只桥接该前缀）。 */
export const CS_HUB_SSE_PATH = '/api/cs-hub/events';

/** 激活前必须就绪的官方服务；workingDirectory / worktreeRoot 走 ctx.get（可选，不进 inject）。 */
export const inject = ['connection', 'webServer', 'sessions'];

/** `root-changed` 广播时保留的字段白名单（不透传未知字段）。 */
const ROOT_CHANGED_FIELDS = ['sessionId', 'root', 'realRoot', 'kind', 'branch', 'phase', 'frozen'];

/**
 * 插件安装体：注册 RPC / SSE / bridge 与根跟随事件。
 * @param {object} ctx host 插件上下文（携带 inject 声明的官方服务）。
 * @param {object} [rawConfig] patch 行 config 原文；由 normalizeConfig 收口。
 * @returns {Promise<void>} 注册完成后兑现。
 */
export async function apply(ctx, rawConfig) {
  // 1. 配置归一化：四字段唯一真源（契约 §3.1），非法值回退默认并告警。
  const config = normalizeConfig(rawConfig);
  // 2. SSE 枢纽与窗口注册表：进程内单例，随插件卸载整体处置。
  const hub = createSseHub();
  ctx.effect(() => () => hub.dispose(), 'cs-hub: sse hub');
  const registry = createWindowRegistry({ maxLiveWindows: config.maxLiveWindows });
  const server = createServerConfig(config);

  /**
   * 把一个已解析的根写进注册表并广播副作用（根变化 / 首次注册共用）。
   * @param {string} sessionId 会话 ID。
   * @param {{root: string, realRoot: string, kind: string, branch: string|undefined, phase: string}} view 根视图。
   * @returns {void}
   */
  function applyRootChange(sessionId, view) {
    // 1. 注册/更新记录：preserveFrozen=true —— 已冻结的会话切根只更新 folder/反查键，
    //    保持 frozen、不复活、不发 window-live（恢复仍只能走 window.recover；T11 / T6 M2）。
    //    folder 变化时 revision 递增，客户端据此重拼 iframe src（冻结窗保持占位并记住新 folder）。
    const registration = registry.register(sessionId, view, { preserveFrozen: true });
    // 2. 冲突与冻结都要显式广播，不静默（契约 §6「后注册者胜出并通知」）。
    if (registration.conflict !== null) {
      hub.broadcast('registry-conflict', {
        sessionId: registration.conflict.sessionId,
        folder: registration.conflict.folder,
        takenBy: sessionId,
      });
    }
    for (const frozenSessionId of registration.frozen) {
      const frozenRecord = registry.list().find((record) => record.sessionId === frozenSessionId);
      hub.broadcast('window-frozen', { sessionId: frozenSessionId, folder: frozenRecord?.folder ?? null, reason: 'lru' });
    }
    // 3. 只广播白名单字段；realRoot 是客户端要钉进 `?folder=` 的 canonical 目录；
    //    frozen 让客户端知道「根变了但本窗仍是冻结占位」。
    const payload = {
      sessionId,
      root: view.root,
      realRoot: view.realRoot,
      kind: view.kind,
      branch: view.branch,
      phase: view.phase,
      frozen: registration.record.state === 'frozen',
    };
    const sanitized = {};
    for (const field of ROOT_CHANGED_FIELDS) if (payload[field] !== undefined) sanitized[field] = payload[field];
    hub.broadcast('root-changed', sanitized);
  }

  // 3. 官方通道：会话目录变化 → 更新注册表 + 广播 root-changed（不重启服务层进程）。
  ctx.on('session/event',
    /**
     * 转发会话目录变化。
     * @param {object} session 事件所属会话；id 是注册表主键。
     * @param {object} event 会话事件；`working-directory/change` 的 data.cwd 是新目录。
     * @returns {void}
     */
    function forwardWorkingDirectoryChanged(session, event) {
      // 3.1. 只处理目录变化事件，其它事件立即返回。
      if (event?.type !== 'working-directory/change') return;
      const sessionId = session?.id;
      if (typeof sessionId !== 'string') return;
      // 3.2. 广播前必须能描述成合法根（不存在/非法就不广播，下一次 state 会明确报错）。
      const view = describeWorkingDirectoryRoot(event.data?.cwd);
      if (view === undefined) return;
      // 3.3. canonical 路径既是反查键也是 iframe 的 `?folder=`（Windows 大小写/短路径/junction 只认一套键）。
      const realRoot = canonicalRoot(view.root);
      if (realRoot === undefined) return;
      applyRootChange(sessionId, { ...view, realRoot });
    });

  // 4. 过渡兼容：自定义 worktree 插件的稳定态事件（本机已停用，缺席即不触发）。
  ctx.on('worktree-root/changed',
    /**
     * 转发自定义 worktree 插件的根变化。
     * @param {unknown} payload `{sessionId, root}`；形状不对直接忽略。
     * @returns {void}
     */
    function forwardRootChanged(payload) {
      // 4.1. 形状防御：只接受带 sessionId 与 root 的对象。
      if (typeof payload !== 'object' || payload === null) return;
      const sessionId = payload.sessionId;
      if (typeof sessionId !== 'string') return;
      // 4.2. 根必须能被描述（存在且合法），canonical 由 realpath 取。
      const view = describeWorkingDirectoryRoot(payload.root);
      if (view === undefined) return;
      const realRoot = canonicalRoot(view.root);
      if (realRoot === undefined) return;
      applyRootChange(sessionId, { ...view, realRoot });
    });

  // 5. 一元 RPC：/cs-hub 频道（Connection 在派发前自动 admit，插件零自建鉴权）。
  ctx.connection.rpc.handle(CS_HUB_CHANNEL,
    /**
     * /cs-hub 频道端点分派。
     * @param {string} endpoint 频道相对端点名。
     * @param {unknown} payload 客户端载荷。
     * @param {AbortSignal} signal 请求取消信号。
     * @returns {Promise<object>} RPC 信封（ok/error）。
     */
    async function dispatch(endpoint, payload, signal) {
      // 5.1. 全部业务逻辑与错误归一化在 endpoints 层完成。
      return dispatchCsHubEndpoint({ ctx, config, registry, hub }, endpoint, payload, signal);
    });

  // 6. SSE：共享 /api 频道的精确 GET 路由（流式响应经 Connection 桥接逐块写出）。
  ctx.connection.fetch.register({
    path: CS_HUB_SSE_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    /**
     * 生成一条 SSE 流响应。
     * @param {Request} request 入站 GET；其 signal 在客户端断开时 abort。
     * @returns {Promise<Response>} text/event-stream 响应。
     */
    fetch: (request) => Promise.resolve(hub.response(request)),
  });

  // 7. bridge：本轮不依赖它的消费方（扩展二期接入），但 host 契约先落。
  if (config.bridgeEnabled) {
    const dshHome = resolveDshHome();
    const tokenRecord = rotateBridgeToken(dshHome);
    const bridge = createBridgeHandler({ registry, getToken: () => tokenRecord.token });
    const dispose = ctx.webServer.register({
      kind: 'prefix',
      path: BRIDGE_BASE,
      /**
       * bridge 路由处理器（自带令牌鉴权；/health 无鉴权只回活着）。
       * @param {import('node:http').IncomingMessage} req 入站请求。
       * @param {import('node:http').ServerResponse} res 出站响应。
       * @returns {Promise<void>} 响应完成时兑现。
       */
      handler: (req, res) => bridge.handle(req, res, (event, data) => hub.broadcast(event, data)),
    });
    ctx.effect(() => dispose, 'cs-hub: bridge route');
  }

  // 8. 配置面变化才发 server-status；本插件 config 每次 apply 固定，故只在注册时发一次给已连接客户端。
  hub.broadcast('server-status', server);
}
