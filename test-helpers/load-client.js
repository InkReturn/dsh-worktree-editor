/**
 * 测试辅助：在 Node 的 VM 里加载客户端产物（`client.js` 是 `window.__ModuleLoader__` 工厂格式）。
 *
 * 为什么这样做：客户端产物不是 ESM，但其中的纯函数（folder 归一化、src 组装、healthz 四态判定）
 * 必须能离线单测。这里用最小桩（window/__ModuleLoader__/require('react')）把它跑起来，
 * 保证「被测代码 == 上线代码」，不做第二份实现。
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * 加载客户端模块并返回其 exports。
 * @param {object} [options] 可选覆盖。
 * @param {object} [options.react] 注入的 react 桩（默认最小桩：createElement/useState/... 全为函数）。
 * @returns {object} module.exports（含 apply/inject/__test）。
 */
export function loadClientModule({ react } = {}) {
  // 1. 读取产物源码。
  const file = path.join(here, '..', 'client.js');
  const code = fs.readFileSync(file, 'utf8');
  // 2. 最小 react 桩：只有纯函数会被调用，UI 侧只需函数占位。
  const reactStub = react ?? {
    createElement: (...args) => ({ type: 'element', args }),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  };
  /** @type {object|undefined} */
  let registration;
  const sandbox = {
    window: { __ModuleLoader__: { load: (value) => { registration = value; } } },
    require: (id) => {
      if (id === 'react') return reactStub;
      throw new Error(`unexpected require(${id})`);
    },
    console,
    document: { createElement: () => ({ setAttribute() {}, remove() {}, textContent: '' }), head: { appendChild() {} } },
    EventSource: class { addEventListener() {} close() {} },
    AbortController,
    fetch: async () => { throw new Error('no network in unit tests'); },
  };
  // 3. 执行产物并取工厂返回值。
  vm.runInNewContext(code, sandbox, { filename: 'client.js' });
  if (!registration || typeof registration.factory !== 'function') throw new Error('client bundle 未调用 __ModuleLoader__.load');
  return registration.factory(sandbox.require);
}
