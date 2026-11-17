/**
 * 开源发布物生成器（方案 A：monorepo 真源 → 发布镜像）。
 *
 * 用法：
 *   node scripts/publish-open-source.mjs [--dry-run] [--init] [--yes] [--force] [--tag v0.2.0]
 *
 * 做的事：
 *   1. 白名单复制插件目录到临时目录；
 *   2. 改名（`@local/dsh-plugin-cs-hub` → `dsh-worktree-editor`）并补 license/repository/homepage/bugs/version；
 *   3. 脱敏：删 `docs/specs/**`、删补丁 `history[]`、剔除本机绝对路径/令牌值；
 *   4. 生成 LICENSE / README / SECURITY / 公开 docs / .gitignore；
 *   5. 脱敏断言（命中即拒绝发布）；
 *   6. `--dry-run` 只打印清单；`--init` 在临时目录 git init+commit；`--yes` 才 push（默认 `--force` 覆盖镜像）。
 */
import fs from 'node:fs';
import vm from 'node:vm';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = path.resolve(HERE, '..');
const PUBLIC_NAME = 'dsh-worktree-editor';
const PUBLIC_VERSION = '0.2.0';
const REPO_URL = 'https://github.com/InkReturn/dsh-worktree-editor.git';
const HOMEPAGE = 'https://github.com/InkReturn/dsh-worktree-editor#readme';
const BUGS = 'https://github.com/InkReturn/dsh-worktree-editor/issues';
/** 白名单：只发布这些顶层条目（相对插件目录）。 */
const WHITELIST = [
  'package.json',
  'index.js',
  'client.js',
  'cordis.patch.yml',
  'lib',
  'patches',
  'scripts',
  'test',
  'test-helpers',
  'docs/ARCHITECTURE.md',
  'docs/TROUBLESHOOTING.md',
];
/** 发布物不得命中的本机痕迹（命中即拒绝发布）。 */
const FORBIDDEN_PATTERNS = [
  { pattern: /C:\\\\Users\\\\/u, reason: 'Windows 用户目录（转义反斜杠）' },
  { pattern: /C:\/Users\//u, reason: 'Windows 用户目录（正斜杠）' },
  { pattern: /D:\\\\Dev\\\\/u, reason: '本机开发根（转义反斜杠）' },
  { pattern: /D:\/Dev\//u, reason: '本机开发根（正斜杠）' },
  { pattern: /D:\\\\Tools/iu, reason: '本机工具目录 D:\\Tools' },
  { pattern: /Administrator/u, reason: '本机用户名' },
  { pattern: /\/home\/[a-z]/u, reason: 'POSIX 家目录' },
  { pattern: /AppData/iu, reason: 'Windows AppData 路径' },
  { pattern: /\.agents[\\/]worktrees/iu, reason: 'worktree 绝对路径残留' },
  { pattern: /docs[\\/]specs/iu, reason: '内部过程报告目录引用' },
  { pattern: /\bT\d{1,3}\b/u, reason: '内部任务号（T17/T22 之类）' },
  { pattern: /\$DSH_HOME\/cs-hub\/bridge\.json"\s*,\s*"token"/u, reason: '令牌值形状' },
];
/**
 * 允许保留的「通用示例绝对路径」：文档里教用户 `cd D:\dsh-portable` 这类不算泄漏。
 * 命中这里就豁免通用盘符规则。
 */
const SAMPLE_PATH_WHITELIST = [/^[A-Z]:\\(?:dsh-portable|Program Files)/iu];
/** 通用盘符绝对路径（未命中文档示例白名单时视为泄漏）。 */
const DRIVE_PATH_PATTERN = /\b[A-Z]:\\[^\s"'`<>|]{3,}/u;
/** 许可证正文（MIT）。 */
const LICENSE_TEXT = `MIT License

Copyright (c) 2026 InkReturn

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

/**
 * 解析参数。
 * @param {string[]} argv 进程参数。
 * @returns {{dryRun: boolean, init: boolean, yes: boolean, force: boolean, tag: string|null}} 选项。
 */
function parseArgs(argv) {
  const options = { dryRun: false, init: false, yes: false, force: true, tag: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--init') options.init = true;
    else if (arg === '--yes') options.yes = true;
    else if (arg === '--force') options.force = true;
    else if (arg === '--no-force') options.force = false;
    else if (arg === '--tag') options.tag = argv[++index];
  }
  return options;
}

/**
 * 递归复制白名单条目。
 * @param {string} source 源插件目录。
 * @param {string} target 目标临时目录。
 * @returns {string[]} 复制出的相对路径列表。
 */
function copyWhitelist(source, target) {
  const copied = [];
  /**
   * 递归复制单个条目。
   * @param {string} relative 相对路径。
   * @returns {void}
   */
  function copyEntry(relative) {
    const from = path.join(source, relative);
    if (!fs.existsSync(from)) return;
    const stat = fs.statSync(from);
    if (stat.isDirectory()) {
      for (const child of fs.readdirSync(from)) copyEntry(path.join(relative, child));
      return;
    }
    const to = path.join(target, relative);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    copied.push(relative);
  }
  for (const relative of WHITELIST) copyEntry(relative);
  return copied;
}

/**
 * 改写 package.json 为公开发布形态。
 * @param {string} target 临时目录。
 * @returns {object} 改写后的 package.json。
 */
function rewritePackageJson(target) {
  const file = path.join(target, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
  pkg.name = PUBLIC_NAME;
  pkg.version = PUBLIC_VERSION;
  pkg.private = false;
  pkg.license = 'MIT';
  pkg.repository = { type: 'git', url: `git+${REPO_URL}` };
  pkg.homepage = HOMEPAGE;
  pkg.bugs = { url: BUGS };
  pkg.description = '为 DeepSeek Harness 提供「每会话一个 VS Code 窗口」的编辑器插件：跟随会话 worktree，含窗口注册表、LRU 冻结与 bridge 路由。';
  pkg.files = [
    'index.js', 'client.js', 'lib/*.js', 'cordis.patch.yml',
    'patches/*.mjs', 'patches/*.json', 'patches/README.md',
    'scripts/*.mjs', 'test/*.js', 'test-helpers/*.js',
    'docs/ARCHITECTURE.md', 'docs/TROUBLESHOOTING.md',
    'README.md', 'LICENSE', 'SECURITY.md', 'CHANGELOG.md',
  ];
  fs.writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
  // cordis.patch.yml 的 name 也要指向新包名（发布物里 profile 解析用新名）。
  const patchFile = path.join(target, 'cordis.patch.yml');
  if (fs.existsSync(patchFile)) {
    const text = fs.readFileSync(patchFile, 'utf8')
      .replaceAll('@local/dsh-plugin-cs-hub', PUBLIC_NAME);
    fs.writeFileSync(patchFile, text, 'utf8');
  }
  // B1（T22 审计 blocker）：客户端 bundle id 必须等于包名——DSH 的 client modules 按
  // `factories.has(row.id)` 匹配 `dsh.client` 行，id 不匹配 ⇒ client 半静默不加载 ⇒ 页签/按钮都不出现。
  // 只改 bundle id 与头注释包名；**ABI 三样不动**：patch 行 id `cs-hub`、tab 注册 id `local:dsh-plugin-cs-hub`、端点路径。
  const clientFile = path.join(target, 'client.js');
  if (fs.existsSync(clientFile)) {
    const text = fs.readFileSync(clientFile, 'utf8')
      .replace("  id: '@local/dsh-plugin-cs-hub',", `  id: '${PUBLIC_NAME}',`)
      .replace(/^ \* @local\/dsh-plugin-cs-hub 客户端入口/mu, ` * ${PUBLIC_NAME} 客户端入口`);
    fs.writeFileSync(clientFile, text, 'utf8');
  }
  return pkg;
}

/**
 * 只脱敏补丁清单里的**描述性字段**（title/description/notes/summary）。
 *
 * T24/N1：`variants.*.insert` / `anchor` 是补丁代码本体，里面的 `// 见 T7 §1` 这类注释
 * 必须原样保留（改了会让补丁锚点/说明失真），所以只处理描述字段。
 * @param {object} value 补丁清单根对象（就地修改）。
 * @returns {boolean} 是否有字段被改写。
 */
function sanitizeDescriptiveFields(value) {
  const DESCRIPTIVE = new Set(['title', 'description', 'notes', 'summary']);
  let changed = false;
  /**
   * 把一段文本里的内部痕迹替换成占位符。
   * @param {string} text 原文。
   * @returns {string} 脱敏后的文本。
   */
  const clean = (text) => text
    .replace(/docs[\\/]specs[\\/][^\s)"'`]*/giu, '<internal-doc>')
    .replace(/docs[\\/]specs/giu, '<internal-doc>')
    .replace(/\bT\d{1,3}\b/gu, '<task>');
  /**
   * 递归遍历，只改描述键。
   * @param {unknown} node 当前节点。
   * @returns {unknown} 处理后的节点。
   */
  const visit = (node) => {
    if (Array.isArray(node)) return node.map(visit);
    if (node !== null && typeof node === 'object') {
      const out = {};
      for (const [key, val] of Object.entries(node)) {
        if (DESCRIPTIVE.has(key) && typeof val === 'string') {
          const next = clean(val);
          if (next !== val) changed = true;
          out[key] = next;
        } else out[key] = visit(val);
      }
      return out;
    }
    return node;
  };
  const next = visit(value);
  for (const key of Object.keys(value)) delete value[key];
  Object.assign(value, next);
  return changed;
}

/**
 * 脱敏：删内部报告与补丁历史，替换本机路径为占位符。
 * @param {string} target 临时目录。
 * @returns {string[]} 被处理的动作描述。
 */
function sanitize(target) {
  const actions = [];
  // 1. 删除内部过程报告（docs/specs 全部）。
  const specs = path.join(target, 'docs', 'specs');
  if (fs.existsSync(specs)) { fs.rmSync(specs, { recursive: true, force: true }); actions.push('删除 docs/specs/**'); }
  // 2. 补丁清单：删 history[]（含本机路径/平台/node 版本），并**只**脱敏描述性字段。
  //    注意：`variants.*.insert/anchor` 是补丁代码本身，绝不能替换（T24/N1）。
  const patchesDir = path.join(target, 'patches');
  if (fs.existsSync(patchesDir)) {
    for (const name of fs.readdirSync(patchesDir)) {
      if (!name.endsWith('.json')) continue;
      const file = path.join(patchesDir, name);
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      const changed = [];
      if (Array.isArray(data.history)) { delete data.history; changed.push('history[]'); }
      if (sanitizeDescriptiveFields(data)) changed.push('描述字段');
      fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
      if (changed.length > 0) actions.push(`补丁清单 ${name}: ${changed.join(' + ')}`);
    }
  }
  // 3. 文本文件里的本机痕迹统一替换为占位符（与 assertClean 的规则一一对应，避免"能删不能改"）。
  for (const relative of walk(target)) {
    if (!/\.(js|mjs|json|md|yml|yaml)$/u.test(relative)) continue;
    // 3.0 跳过本脚本：它的正则/规则字面量本身长得像绝对路径，替换会自毁。
    if (relative === path.join('scripts', 'publish-open-source.mjs')) continue;
    // 3.0.1 补丁清单已在第 2 步按字段脱敏；这里跳过，避免破坏 variants 的 insert/anchor 代码。
    if (/^patches[\\/].*\.json$/u.test(relative)) continue;
    const file = path.join(target, relative);
    let text = fs.readFileSync(file, 'utf8');
    const before = text;
    // 3.1 已知本机目录（对代码/文档都做：这些是真实泄漏路径）。
    text = text.replace(/C:\\Users\\[^\\/\s"']+/gu, '$DSH_HOME').replace(/D:\\Dev\\[^\\/\s"']+/gu, '<repo>');
    text = text.replace(/C:\/Users\/[^/\s"']+/gu, '$DSH_HOME').replace(/D:\/Dev\/[^/\s"']+/gu, '<repo>');
    text = text.replace(/D:\\Tools[^\s"']*/gu, '<tool-dir>').replace(/D:\/Tools[^\s"']*/gu, '<tool-dir>');
    // 3.2/3.3 只对文档与清单生效：通用盘符路径、内部报告引用、任务号。
    //     代码注释里的 Txx 与 `C:\Program Files` 属于正常技术内容，不做替换。
    const isDoc = relative.endsWith('.md') || relative.endsWith('.yml') || relative.endsWith('.json');
    if (isDoc) {
      text = text.replace(/\b[A-Z]:\\[^\s"'`<>|]{3,}/gu, (candidate) => {
        // 文档示例白名单：`cd D:\dsh-portable`、`C:\Program Files\...`（含整段前缀判断）。
        if (SAMPLE_PATH_WHITELIST.some((allowed) => allowed.test(candidate))) return candidate;
        if (/^[A-Z]:\\\\{1,2}Program/iu.test(candidate)) return candidate;
        return '<abs-path>';
      });
      text = text.replace(/docs[\\/]specs[\\/][^\s)"'`]*/giu, '<internal-doc>').replace(/docs[\\/]specs/giu, '<internal-doc>');
      text = text.replace(/\bT\d{1,3}\b/gu, '<task>');
    }
    if (text !== before) { fs.writeFileSync(file, text, 'utf8'); actions.push(`脱敏 ${relative}`); }
  }
  return actions;
}

/**
 * 递归列出文件（相对路径）。
 * @param {string} root 根目录。
 * @returns {string[]} 相对路径列表。
 */
function walk(root) {
  const out = [];
  /**
   * 递归收集。
   * @param {string} dir 当前目录。
   * @returns {void}
   */
  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else out.push(path.relative(root, full));
    }
  }
  visit(root);
  return out;
}

/**
 * 写入发布用文档（LICENSE / README / SECURITY / CHANGELOG / .gitignore）。
 * @param {string} target 临时目录。
 * @returns {void}
 */
function writeDocs(target) {
  fs.writeFileSync(path.join(target, 'LICENSE'), LICENSE_TEXT, 'utf8');
  const readme = path.join(target, 'README.md');
  const publicReadme = path.join(PLUGIN_DIR, 'docs', 'public', 'README.open-source.md');
  if (fs.existsSync(publicReadme)) fs.copyFileSync(publicReadme, readme);
  fs.writeFileSync(path.join(target, '.gitignore'), [
    'node_modules/', '*.log', '*.bak', '*.bak-*', 'bridge.json', 'extensions.json', '.playwright-cli/', 'coverage/',
  ].join('\n') + '\n', 'utf8');
  fs.writeFileSync(path.join(target, 'SECURITY.md'), [
    '# Security Policy',
    '',
    '- 本插件只在本机运行；bridge 令牌文件（`$DSH_HOME/cs-hub/bridge.json`）落盘时收紧 ACL（POSIX 0600 / Windows 仅当前用户 R,W）。',
    '- `/cs-hub-bridge/*` 自带令牌鉴权：未认证请求在读请求体之前就返回 401；带 `Origin` 一律 403。',
    '- 威胁模型只覆盖「本机其他普通用户不可读令牌」；同机同用户进程不在模型内。',
    '- 发现漏洞请开 issue 或私信维护者，不要公开 PoC。',
    '',
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(target, 'CHANGELOG.md'), [
    '# Changelog',
    '',
    '## 0.2.0',
    '',
    '- 首个公开发布：每会话 VS Code 窗口、窗口注册表、LRU 冻结、bridge 路由与 SSE。',
    '- 安全硬化：bridge 未认证请求不读请求体、令牌文件 ACL 收紧。',
    '- 安装器 `scripts/install.mjs`（分步幂等）与 restore 钩子 `scripts/post-restore.mjs`。',
    '',
  ].join('\n'), 'utf8');
}

/**
 * 脱敏断言：发布物中不得出现本机路径/令牌值/内部报告/任务号。
 *
 * 唯一豁免：`scripts/publish-open-source.mjs` 自身——它必须包含这些规则的**字面量**才能检查别人；
 * 豁免是硬编码的一条路径，不是「所有脚本都跳过」。
 * @param {string} target 临时目录。
 * @returns {string[]} 违规项（空数组 = 通过）。
 */
function assertClean(target) {
  const violations = [];
  for (const relative of walk(target)) {
    // 0. 豁免理由：脱敏规则的定义者本身（仅此一个文件）。
    if (relative === path.join('scripts', 'publish-open-source.mjs')) continue;
    const file = path.join(target, relative);
    const text = fs.readFileSync(file, 'utf8');
    // 1. 固定规则表。
    for (const rule of FORBIDDEN_PATTERNS) {
      // 任务号只在文档里算泄漏：代码注释里的 T9/T11 是正常技术注释。
      if (rule.reason.startsWith('内部任务号') && !relative.endsWith('.md')) continue;
      if (rule.pattern.test(text)) violations.push(`${relative} 命中规则 [${rule.reason}]`);
    }
    // 2. 通用盘符绝对路径：测试夹具（假路径）与文档示例白名单豁免。
    const isFixture = /^(test|test-helpers)[\\/]/u.test(relative);
    if (!isFixture) {
      for (const match of text.matchAll(/\b[A-Z]:\\[^\s"'`<>|]{3,}/gu)) {
        const candidate = match[0];
        if (SAMPLE_PATH_WHITELIST.some((allowed) => allowed.test(candidate))) continue;
        // `C:\Program Files\...` 会被空格截断成 `C:\Program`，前缀即视为系统目录示例。
        if (/^[A-Z]:\\\\{1,2}Program/iu.test(candidate)) continue;
        if (DRIVE_PATH_PATTERN.test(candidate)) violations.push(`${relative} 含绝对路径 ${candidate.slice(0, 40)}`);
      }
    }
    // 3. 令牌值形状（字段名允许出现，值不允许）。
    if (/x-cs-hub-bridge-token["']?\s*[:=]\s*["'][0-9a-f]{16,}/u.test(text)) violations.push(`${relative} 含疑似令牌值`);
  }
  return violations;
}

/**
 * B1 断言：发布物 `client.js` 的 bundle id 必须等于 `package.json.name`，且能被 VM 装载。
 *
 * DSH 契约：client modules 用 `factories.has(row.id)` 匹配 `dsh.client` 行；id 不等于包名时
 * client 半会静默不加载（页签/顶栏按钮都不出现），所以这里同时做静态比对 + VM 装载 smoke，
 * 并反向断言 ABI 未被误改（tab 注册 id、patch 行 id 保持原值）。
 * @param {string} target 临时目录。
 * @param {object} pkg 发布物 package.json。
 * @returns {string[]} 违规项（空数组 = 通过）。
 */
function assertBundleIdentity(target, pkg) {
  const violations = [];
  const clientFile = path.join(target, 'client.js');
  if (!fs.existsSync(clientFile)) return ['client.js 缺失'];
  const source = fs.readFileSync(clientFile, 'utf8');
  // 1. 静态比对：bundle id 必须等于包名。
  const idMatch = /__ModuleLoader__\.load\(\{\s*id:\s*'([^']+)'/u.exec(source);
  const bundleId = idMatch === null ? null : idMatch[1];
  if (bundleId !== pkg.name) violations.push(`bundle id 不匹配：client.js='${bundleId}' vs package.json='${pkg.name}'`);
  // 2. ABI 反向断言：这些值发布后必须保持原样。
  if (!source.includes("'local:dsh-plugin-cs-hub'")) violations.push('client.js 丢失 ABI：tab 注册 id 被改动');
  const patchYml = path.join(target, 'cordis.patch.yml');
  if (fs.existsSync(patchYml) && !/^\s*- id: cs-hub\s*$/mu.test(fs.readFileSync(patchYml, 'utf8'))) {
    violations.push('cordis.patch.yml 丢失 ABI：patch 行 id 不是 cs-hub');
  }
  // 3. VM 装载 smoke：真跑一遍工厂注册，确认 id 一致且 factory 可执行。
  let registered = null;
  const sandbox = {
    window: { __ModuleLoader__: { load: (value) => { registered = value; } } },
    require: () => ({}),
    console,
    document: { createElement: () => ({ setAttribute() {}, remove() {}, textContent: '' }), head: { appendChild() {} } },
    EventSource: class { addEventListener() {} close() {} },
    AbortController,
    fetch: async () => { throw new Error('no network'); },
  };
  try {
    vm.runInNewContext(source, sandbox, { filename: 'client.js' });
    if (registered === null) violations.push('client.js 未调用 __ModuleLoader__.load');
    else {
      if (registered.id !== pkg.name) violations.push(`VM 注册 id 不匹配：'${registered.id}' vs '${pkg.name}'`);
      if (typeof registered.factory !== 'function') violations.push('client.js factory 不是函数');
    }
  } catch (error) {
    violations.push(`client.js VM 装载失败：${error && error.message ? error.message : String(error)}`);
  }
  return violations;
}

/**
 * 主流程。
 * @returns {number} 退出码。
 */
function main() {
  const options = parseArgs(process.argv.slice(2));
  // 0. --yes 意味着要推送；没有 --init 时自动补上并明确提示（T27 minor）。
  if (options.yes && !options.init) {
    options.init = true;
    console.log('[publish] 检测到 --yes 但未给 --init：自动按 --init 处理（会 git init + commit 后 push）');
  }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-we-publish-'));
  const copied = copyWhitelist(PLUGIN_DIR, work);
  const pkg = rewritePackageJson(work);
  const actions = sanitize(work);
  writeDocs(work);
  const violations = [...assertClean(work), ...assertBundleIdentity(work, pkg)];
  const report = {
    dryRun: options.dryRun,
    target: work,
    name: pkg.name,
    version: pkg.version,
    fileCount: walk(work).length,
    files: walk(work).sort(),
    copiedCount: copied.length,
    sanitizeActions: actions,
    violations,
    bundleId: (() => {
      const source = fs.readFileSync(path.join(work, 'client.js'), 'utf8');
      const match = /__ModuleLoader__\.load\(\{\s*id:\s*'([^']+)'/u.exec(source);
      return match === null ? null : match[1];
    })(),
    git: options.init ? 'init+commit' : 'skipped',
    push: options.yes ? `${REPO_URL} (force=${options.force})` : 'skipped（需 --yes）',
    tag: options.tag,
  };
  if (violations.length > 0) {
    console.error(JSON.stringify(report, null, 2));
    console.error('[publish] 断言未通过，拒绝发布（脱敏或 bundle id）');
    // 失败也清理 staging，避免临时目录堆积。
    fs.rmSync(work, { recursive: true, force: true });
    return 1;
  }
  if (options.dryRun || !options.init) {
    console.log(JSON.stringify(report, null, 2));
    console.log('[publish] dry-run/未 init：未创建 git 仓库，未 push');
    if (process.env.DSH_WE_PUBLISH_KEEP === '1') console.log('[publish] 保留 staging：' + work);
    else fs.rmSync(work, { recursive: true, force: true });
    return 0;
  }
  // 1. git init + commit（只在 --init 时）。
  execFileSync('git', ['init', '-b', 'main'], { cwd: work, stdio: 'pipe' });
  execFileSync('git', ['add', '-A'], { cwd: work, stdio: 'pipe' });
  execFileSync('git', ['-c', 'user.name=InkReturn', '-c', 'user.email=inkreturn@users.noreply.github.com', 'commit', '-m', `release: ${PUBLIC_NAME} v${PUBLIC_VERSION}`], { cwd: work, stdio: 'pipe' });
  const afterInit = { ...report, git: 'committed' };
  if (!options.yes) {
    console.log(JSON.stringify(afterInit, null, 2));
    console.log('[publish] 已 commit，未 push（加 --yes 才 push）');
    fs.rmSync(work, { recursive: true, force: true });
    return 0;
  }
  // 2. push（默认 force 覆盖镜像；README 顶部已声明镜像语义）。
  execFileSync('git', ['remote', 'add', 'origin', REPO_URL], { cwd: work, stdio: 'pipe' });
  const pushArgs = ['push'];
  if (options.force) pushArgs.push('--force');
  pushArgs.push('origin', 'main');
  execFileSync('git', pushArgs, { cwd: work, stdio: 'pipe' });
  if (options.tag !== null) execFileSync('git', ['tag', options.tag], { cwd: work, stdio: 'pipe' });
  console.log(JSON.stringify({ ...afterInit, push: 'done' }, null, 2));
  // 3. 推送成功后清理 staging（失败时不清理，便于排查）。
  fs.rmSync(work, { recursive: true, force: true });
  return 0;
}

process.exitCode = main();







