/**
 * 客户端纯函数单测（契约 v2 §4.6 / §1.3 / §3.3）。
 *
 * 通过 VM 加载**真正的** client.js 产物（不是第二份实现），保证测的就是上线代码。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadClientModule } from '../test-helpers/load-client.js';

const { __test } = loadClientModule();
const { toUrlFolder, buildFrameSrc, decideProbe, decideViewState, describeHeaderAction, createHeaderButton } = __test;

/**
 * 跨 realm 的深比较：VM 里创建的对象原型与测试进程不同，`deepStrictEqual` 会因原型不同判不等。
 * 这里统一按 JSON 结构比较（这些纯函数只返回 JSON 可序列化的普通对象）。
 * @param {unknown} actual 实际值。
 * @param {unknown} expected 期望值。
 * @returns {void}
 */
function assertJson(actual, expected) {
  assert.equal(JSON.stringify(actual), JSON.stringify(expected));
}

test('导出面：apply/inject 可被宿主装载', () => {
  const moduleExports = loadClientModule();
  assert.equal(typeof moduleExports.apply, 'function');
  assertJson([...moduleExports.inject], ['slots', 'locale', 'connection', 'sidebarRightTabs', 'sidebarRight']);
});

test('toUrlFolder：盘符正斜杠化并补前导斜杠', () => {
  assert.equal(toUrlFolder('/D:/repo/wt'), '/D:/repo/wt');
  assert.equal(toUrlFolder('C:/repo/wt'), '/C:/repo/wt');
  assert.equal(toUrlFolder('C:\\work\\repo'), '/C:/work/repo');
  assert.equal(toUrlFolder('\\\\server\\share'), '/server/share');
  assert.equal(toUrlFolder(''), '');
  assert.equal(toUrlFolder(undefined), '');
});

test('buildFrameSrc：base + ?s=<pid>&folder=<encoded>', () => {
  const src = buildFrameSrc({ base: '/code-server/', instanceTag: 64244, folder: '/<repo>' });
  assert.equal(src, `/code-server/?s=64244&folder=${encodeURIComponent('/<repo>')}`);
});

test('buildFrameSrc：没有 pid 时不带 ?s（不自造空参数）', () => {
  const src = buildFrameSrc({ base: '/code-server/', instanceTag: null, folder: 'C:\\Dev\\repo' });
  assert.equal(src, `/code-server/?folder=${encodeURIComponent('/C:/Dev/repo')}`);
});

test('buildFrameSrc：空 folder 只回 base；base 缺尾斜杠自动补', () => {
  assert.equal(buildFrameSrc({ base: '/code-server/', instanceTag: 1, folder: '' }), '/code-server/');
  assert.equal(buildFrameSrc({ base: '/code-server', instanceTag: 1, folder: '' }), '/code-server/');
  assert.equal(buildFrameSrc({ base: undefined, instanceTag: 1, folder: '' }), '/code-server/');
});

test('decideProbe：200 + ok:true ⇒ mounted 并带出 pid/mode', () => {
  const result = decideProbe({ status: 200, body: { ok: true, pid: 7, mode: 'pipe', productPath: 'stable-x', htmlTag: 't' } });
  assertJson(result, { mounted: true, pid: 7, mode: 'pipe', productPath: 'stable-x', htmlTag: 't' });
});

test('decideProbe：401/403 ⇒ mounted 但 reason=auth', () => {
  assertJson(decideProbe({ status: 401 }), { mounted: true, reason: 'auth' });
  assertJson(decideProbe({ status: 403 }), { mounted: true, reason: 'auth' });
});

test('decideProbe：404 ⇒ mount-missing；502/503 ⇒ upstream-unavailable', () => {
  assertJson(decideProbe({ status: 404 }), { mounted: false, reason: 'mount-missing' });
  assertJson(decideProbe({ status: 503 }), { mounted: false, reason: 'upstream-unavailable' });
  assertJson(decideProbe({ status: 502 }), { mounted: false, reason: 'upstream-unavailable' });
});

test('decideProbe：网络异常/非 JSON 体 ⇒ 保守判定', () => {
  assertJson(decideProbe({ error: new Error('boom') }), { mounted: false, reason: 'network' });
  assertJson(decideProbe({ status: 200, body: undefined }), { mounted: false, reason: 'upstream-unavailable' });
  assertJson(decideProbe({ status: 200, body: { ok: false } }), { mounted: false, reason: 'upstream-unavailable' });
});

test('decideViewState：六个分支', () => {
  assertJson(decideViewState({ state: { root: {} }, probe: null, loading: true }), { kind: 'loading' });
  assertJson(decideViewState({ state: null, probe: null, loading: false }), { kind: 'error', reason: 'state' });
  assertJson(decideViewState({ state: { root: { uncertain: true } }, probe: null, loading: false }), { kind: 'uncertain' });
  assertJson(
    decideViewState({ state: { root: {}, window: { state: 'live' } }, probe: { mounted: true }, loading: false }),
    { kind: 'frame' },
  );
  assertJson(
    decideViewState({ state: { root: {}, window: { state: 'live' } }, probe: { mounted: false, reason: 'mount-missing' }, loading: false }),
    { kind: 'unavailable', reason: 'mount-missing' },
  );
  assertJson(
    decideViewState({ state: { root: {}, window: { state: 'frozen' } }, probe: { mounted: true }, loading: false }),
    { kind: 'frozen' },
  );
});

test('decideViewState：本地冻结标记优先 → 渲染占位、不创建 iframe（T9）', () => {
  // 服务端 state 还显示 live（重拉尚未返回），但本地已收到 window-frozen：
  // 必须走 frozen 占位分支（该分支只返回占位 DOM，不渲染 iframe）。
  assertJson(
    decideViewState({ state: { root: {}, window: { state: 'live' } }, probe: { mounted: true }, loading: false, frozen: true }),
    { kind: 'frozen' },
  );
  // frozen 优先于 unavailable/uncertain 之外的判断：即使 loading 已结束、state 正常也仍是占位。
  assertJson(
    decideViewState({ state: { root: {}, window: null }, probe: null, loading: false, frozen: true }),
    { kind: 'frozen' },
  );
  // 恢复后本地标记清除 + 服务端 live ⇒ 回到 iframe 分支（重建）。
  assertJson(
    decideViewState({ state: { root: {}, window: { state: 'live' } }, probe: { mounted: true }, loading: false, frozen: false }),
    { kind: 'frame' },
  );
});



// ---- T26：顶栏「一键打开编辑器」动作 ----

test('顶栏动作：id/order/文案（中英）', () => {
  const zh = describeHeaderAction((key) => ({ 'header.openEditor': '打开 code-server 编辑器' })[key]);
  assertJson(zh, { id: 'cs-hub-open-editor', order: 40, label: '打开 code-server 编辑器' });
  const en = describeHeaderAction((key) => ({ 'header.openEditor': 'Open the code-server editor' })[key]);
  assertJson(en, { id: 'cs-hub-open-editor', order: 40, label: 'Open the code-server editor' });
  // 无会话时按钮组件不应渲染：这里只验证 meta 与 id 稳定，渲染分支由 slot scope 保证。
  assert.equal(zh.id, 'cs-hub-open-editor');
});


test('顶栏按钮：渲染 28×28 按钮并在点击时打开本会话编辑器（T26）', () => {
  /** @type {string[]} */
  const opened = [];
  const Button = createHeaderButton({ openTabIn: (sessionId) => opened.push(sessionId) });
  const t = (key) => ({ 'header.openEditor': '打开 code-server 编辑器' })[key];
  const element = Button({ sessionId: 'session-1', t });
  assert.equal(element.type, 'element');
  assert.equal(element.args[0], 'button');
  const props = element.args[1];
  assert.equal(props.id, 'cs-hub-open-editor');
  assert.equal(props.className, 'dsh-cs-hub-header-button');
  assert.equal(props['aria-label'], '打开 code-server 编辑器');
  props.onClick();
  assert.deepEqual(opened, ['session-1']);
  // 无会话时返回 null（不渲染空按钮）。
  assert.equal(Button({ sessionId: undefined, t }), null);
});

// ---- T24：apply() 接线集成测试（无浏览器，用假 ctx 捕获槽位注册与点击动作）----

test('apply：注册顶栏动作并在点击时 openTabIn(sessionId, cs-hub)', () => {
  const moduleExports = loadClientModule();
  /** @type {object[]} */
  const slotRegistrations = [];
  /** @type {object[]} */
  const tabTypes = [];
  /** @type {string[]} */
  const opened = [];
  const dictionaries = {};
  /** 假 cordis 上下文：effect 立即执行，slots 注册被记录，sidebarRight 记录打开动作。 */
  const ctx = {
    effect: (fn) => { fn(); },
    slots: {
      inject: (_name, callback) => { callback(); },
      register: (descriptor, component) => { slotRegistrations.push({ descriptor, component }); },
    },
    locale: {
      register: (ns, dicts) => { dictionaries[ns] = dicts; },
      bind: (ns) => (key) => (dictionaries[ns] && dictionaries[ns].zh[key]) || key,
    },
    connection: {},
    sidebarRightTabs: { register: (definition) => { tabTypes.push(definition); } },
    sidebarRight: { openTabIn: (sessionId, kind) => { opened.push(`${sessionId}:${kind}`); } },
  };
  // 1. 跑真实 apply()。
  moduleExports.apply(ctx);
  // 2. 顶栏动作必须注册到 header.actions，且 id/order/locale 符合约定。
  const header = slotRegistrations.find((item) => item.descriptor.name === 'conversation.session.header.actions');
  assert.ok(header, '未注册 conversation.session.header.actions');
  assertJson(
    { id: header.descriptor.id, order: header.descriptor.order, locale: header.descriptor.locale },
    { id: 'cs-hub-open-editor', order: 40, locale: 'cs-hub' },
  );
  // 3. 渲染按钮：点击必须打开当前会话的编辑器页签。
  const element = header.component({ sessionId: 'session-9', t: (key) => (key === 'header.openEditor' ? '打开 code-server 编辑器' : key) });
  assert.equal(element.args[0], 'button');
  element.args[1].onClick();
  assertJson(opened, ['session-9:cs-hub']);
  // 4. 页面类型也照常注册（一次 apply 两件事都齐）。
  assert.equal(tabTypes.length, 1);
  assert.equal(tabTypes[0].kind, 'cs-hub');
});
