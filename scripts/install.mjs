/**
 * dsh-worktree-editor 安装器（可重复执行、每步幂等）。
 *
 * 用法：
 *   node scripts/install.mjs [--profile web] [--dsh-home <dir>] [--service] [--patch]
 *     [--settings] [--extensions=minimal|langs|all|none] [--registry=<url>] [--check] [--dry-run] [--yes]
 *
 * 不带分步开关 = 全流程（service + patch + settings + extensions=minimal）。
 * 退出码：0 成功/已最新；1 用法或环境缺失；2 服务层失败；3 补丁失败；4 设置/扩展部分失败；5 --check 有待做项。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = path.resolve(HERE, '..');
/** 服务层包与锁定版本：与 T2/T8 验证过的组合一致。 */
const SERVICE_PACKAGE = 'dsh-code-server-app';
const SERVICE_VERSION = '0.3.75';
/** 扩展集合（minimal 默认；langs/all 体积大，需显式选择）。 */
const EXTENSION_SETS = {
  minimal: [
    'dracula-theme.theme-dracula',
    'pkief.material-icon-theme',
  ],
  langs: [
    'dracula-theme.theme-dracula',
    'pkief.material-icon-theme',
    'ms-python.python',
    'ms-python.debugpy',
    'ms-python.vscode-python-envs',
    'redhat.java',
    'vscjava.vscode-java-pack',
    'vscjava.vscode-java-debug',
    'vscjava.vscode-java-test',
    'vscjava.vscode-maven',
    'vscjava.vscode-gradle',
    'vscjava.vscode-java-dependency',
    'vue.volar',
    'rust-lang.rust-analyzer',
    'golang.go',
  ],
  all: [
    'dracula-theme.theme-dracula',
    'pkief.material-icon-theme',
    'ms-ceintl.vscode-language-pack-zh-hans',
    'ms-python.python',
    'ms-python.debugpy',
    'ms-python.vscode-python-envs',
    'ms-python.vscode-pylance',
    'eamodio.gitlens',
    'redhat.java',
    'vscjava.vscode-java-pack',
    'vscjava.vscode-java-debug',
    'vscjava.vscode-java-test',
    'vscjava.vscode-maven',
    'vscjava.vscode-gradle',
    'vscjava.vscode-java-dependency',
    'vue.volar',
    'rust-lang.rust-analyzer',
    'golang.go',
  ],
};
/** 只上架官方市场的扩展（Open VSX 无）。 */
const MARKETPLACE_ONLY = new Set(['ms-python.vscode-pylance']);

/**
 * 解析命令行参数。
 * @param {string[]} argv 进程参数（不含 node 与脚本名）。
 * @returns {object} 归一化选项。
 */
function parseArgs(argv) {
  const options = {
    profile: 'web',
    dshHome: process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'),
    steps: { service: false, patch: false, settings: false },
    extensions: 'minimal',
    registry: null,
    check: false,
    dryRun: false,
    yes: false,
  };
  let explicitStep = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--profile') options.profile = argv[++index];
    else if (arg === '--dsh-home') options.dshHome = argv[++index];
    else if (arg === '--service') { options.steps.service = true; explicitStep = true; }
    else if (arg === '--patch') { options.steps.patch = true; explicitStep = true; }
    else if (arg === '--settings') { options.steps.settings = true; explicitStep = true; }
    else if (arg === '--extensions') options.extensions = argv[++index];
    else if (arg.startsWith('--registry=')) options.registry = arg.slice('--registry='.length);
    else if (arg === '--registry') options.registry = argv[++index];
    else if (arg === '--check') options.check = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--yes') options.yes = true;
  }
  if (explicitStep === false) options.steps = { service: true, patch: true, settings: true };
  if (EXTENSION_SETS[options.extensions] === undefined) options.extensions = 'none';
  return options;
}

/**
 * 跑一个命令并返回 stdout（失败抛错，含尾部输出）。
 * @param {string} file 可执行名。
 * @param {string[]} args 参数。
 * @returns {string} stdout。
 */
function run(file, args) {
  return execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/**
 * 读 profile 的 package.json（不存在返回 null）。
 * @param {string} profileDir profile 目录。
 * @returns {object|null} 解析后的 JSON。
 */
function readProfilePackage(profileDir) {
  const file = path.join(profileDir, 'package.json');
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * 幂等合并 settings.json 的键（写前备份 .bak）。
 * @param {string} file settings.json 绝对路径。
 * @param {Record<string, unknown>} patch 要写入的键值。
 * @param {{dryRun?: boolean}} options 选项。
 * @returns {{changed: string[], backup: string|null}} 变更的键与备份路径。
 */
function mergeSettings(file, patch, { dryRun = false } = {}) {
  const current = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const changed = [];
  for (const [key, value] of Object.entries(patch)) {
    if (JSON.stringify(current[key]) !== JSON.stringify(value)) changed.push(key);
    current[key] = value;
  }
  if (changed.length === 0 || dryRun) return { changed, backup: null };
  let backup = null;
  if (fs.existsSync(file)) {
    backup = `${file}.bak-${new Date().toISOString().replace(/[:.]/gu, '-')}`;
    fs.copyFileSync(file, backup);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
  return { changed, backup };
}

/**
 * 探测可用 JDK：PATH → JAVA_HOME → 常见安装目录（不写死本机路径），返回主版本号最高的一个。
 *
 * Java 扩展（redhat.java 1.59+）要求 **JDK 25+** 运行 jdt.ls，所以这里按主版本排序取最高，
 * 低于 25 时由调用方告警（不静默写错配置）。
 * @returns {{home: string, version: string, major: number|null}|null} 找到的 JDK；找不到 null。
 */
function detectJdk() {
  /** @type {{home: string, version: string, major: number|null}[]} */
  const candidates = [];
  /**
   * 把候选 java 可执行加入列表并解析主版本。
   * @param {string} executable java 可执行文件绝对路径。
   * @returns {void}
   */
  function pushCandidate(executable) {
    try {
      const probe = spawnSync(executable, ['-version'], { encoding: 'utf8' });
      // java -version 在部分平台写到 stderr，两路都拼上看。
      const output = `${probe.stdout ?? ''}${probe.stderr ?? ''}`;
      const first = output.split(/\r?\n/u).find((line) => line.includes('version')) ?? '';
      const match = /version "(\d+)(?:\.(\d+))?/u.exec(first);
      const major = match === null ? null : Number(match[1]);
      candidates.push({ home: path.dirname(path.dirname(executable)), version: first, major });
    } catch { /* 忽略坏安装 */ }
  }
  // 1. PATH 上的 java。
  try {
    const where = process.platform === 'win32' ? run('where.exe', ['java']) : run('which', ['java']);
    for (const line of where.split(/\r?\n/u)) if (line.trim() !== '') pushCandidate(line.trim());
  } catch { /* 继续 */ }
  // 2. JAVA_HOME。
  const envHome = process.env.JAVA_HOME;
  if (typeof envHome === 'string' && envHome !== '') {
    for (const name of ['java.exe', 'java']) {
      const executable = path.join(envHome, 'bin', name);
      if (fs.existsSync(executable)) { pushCandidate(executable); break; }
    }
  }
  // 3. 常见目录（Windows: Program Files；macOS: /Library/Java；Linux: /usr/lib/jvm）。
  const roots = process.platform === 'win32'
    ? ['C:\\Program Files\\Java', 'C:\\Program Files\\Eclipse Adoptium', 'C:\\Program Files\\Zulu', 'C:\\Program Files\\Microsoft\\jdk']
    : ['/usr/lib/jvm', '/Library/Java/JavaVirtualMachines'];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root)) {
      const home = path.join(root, entry);
      for (const name of ['java.exe', 'java']) {
        const executable = path.join(home, 'bin', name);
        if (fs.existsSync(executable)) { pushCandidate(executable); break; }
      }
    }
  }
  if (candidates.length === 0) return null;
  // 4. 主版本降序：优先 25+，其次最高的。
  candidates.sort((a, b) => (b.major ?? 0) - (a.major ?? 0));
  return candidates[0];
}

/**
 * 从 Open VSX（主）或官方市场（兜底）下载并安装一个扩展。
 * @param {string} id publisher.name。
 * @param {string} extensionsDir 扩展目录。
 * @param {{dryRun?: boolean}} options 选项。
 * @returns {Promise<string>} 安装结果描述。
 */
async function installExtension(id, extensionsDir, { dryRun = false } = {}) {
  const [publisher, name] = id.split('.');
  let download;
  let source;
  if (MARKETPLACE_ONLY.has(id)) {
    download = `https://marketplace.visualstudio.com/_apis/public/gallery/publishers/${publisher}/vsextensions/${name}/latest/vspackage`;
    source = 'marketplace';
  } else {
    const response = await fetch(`https://open-vsx.org/api/${publisher}/${name}/latest`, { headers: { 'user-agent': 'dsh-worktree-editor-install' } });
    if (response.status !== 200) throw new Error(`Open VSX 无此扩展: HTTP ${response.status}`);
    const meta = await response.json();
    download = meta.files.download;
    source = 'open-vsx';
  }
  if (dryRun) return `${id} (dry-run, ${source})`;
  // 1. 下载 VSIX（就是 zip）。
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-we-vsix-'));
  const vsix = path.join(work, 'ext.vsix');
  const fileResponse = await fetch(download, { headers: { 'user-agent': 'dsh-worktree-editor-install' } });
  if (fileResponse.status !== 200) throw new Error(`${id} 下载失败: HTTP ${fileResponse.status}`);
  fs.writeFileSync(vsix, Buffer.from(await fileResponse.arrayBuffer()));
  // 2. 解包（Windows 自带 bsdtar 可解 zip）。
  const out = path.join(work, 'unzipped');
  fs.mkdirSync(out, { recursive: true });
  execFileSync('tar', ['-xf', vsix, '-C', out], { stdio: 'pipe' });
  const json = path.join(out, 'extension', 'package.json');
  if (!fs.existsSync(json)) throw new Error(`${id}: VSIX 结构异常（无 extension/package.json）`);
  const pkg = JSON.parse(fs.readFileSync(json, 'utf8'));
  // 3. 落到 extensions/<publisher>.<name>-<version>/。
  const target = path.join(extensionsDir, `${String(pkg.publisher).toLowerCase()}.${String(pkg.name).toLowerCase()}-${pkg.version}`);
  fs.rmSync(target, { recursive: true, force: true });
  fs.cpSync(path.join(out, 'extension'), target, { recursive: true });
  return `${id}@${pkg.version} (${source})`;
}

/**
 * 重建 extensions.json 并清掉 .obsolete 里指向有效目录的条目（服务层扫描器的兼容修复）。
 * @param {string} extensionsDir 扩展目录。
 * @returns {number} 注册条目数。
 */
function rebuildExtensionState(extensionsDir) {
  if (!fs.existsSync(extensionsDir)) return 0;
  const entries = [];
  for (const entry of fs.readdirSync(extensionsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const pkgFile = path.join(extensionsDir, entry.name, 'package.json');
    if (!fs.existsSync(pkgFile)) continue;
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
      if (typeof pkg.publisher !== 'string' || typeof pkg.name !== 'string' || typeof pkg.version !== 'string') continue;
      entries.push({
        identifier: { id: `${pkg.publisher.toLowerCase()}.${pkg.name.toLowerCase()}` },
        version: pkg.version,
        location: { $mid: 1, path: `/${extensionsDir.replace(/\\/gu, '/')}/${entry.name}`, scheme: 'file' },
        relativeLocation: entry.name,
      });
    } catch { /* 跳过坏包 */ }
  }
  fs.writeFileSync(path.join(extensionsDir, 'extensions.json'), JSON.stringify(entries));
  const obsolete = path.join(extensionsDir, '.obsolete');
  if (fs.existsSync(obsolete)) {
    const map = JSON.parse(fs.readFileSync(obsolete, 'utf8') || '{}');
    const valid = new Set(entries.map((entry) => entry.relativeLocation));
    for (const key of Object.keys(map)) if (valid.has(key)) delete map[key];
    if (Object.keys(map).length === 0) fs.rmSync(obsolete, { force: true });
    else fs.writeFileSync(obsolete, JSON.stringify(map));
  }
  return entries.length;
}

/**
 * 主流程。
 * @returns {Promise<number>} 退出码。
 */
async function main() {
  const options = parseArgs(process.argv.slice(2));
  const profileDir = path.join(options.dshHome, 'profiles', options.profile);
  const userData = path.join(options.dshHome, 'code-server', 'user-data');
  const extensionsDir = path.join(options.dshHome, 'code-server', 'extensions');
  const settingsFile = path.join(userData, 'User', 'settings.json');
  const report = { pending: [], warnings: [] };
  /** 补丁失败标记：不中断后续步骤，由退出码 3 表达。 */
  let patchFailed = false;

  // 0. 环境校验。
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor < 22) { console.error(`需要 Node ≥ 22，当前 ${process.versions.node}`); return 1; }
  if (!fs.existsSync(profileDir)) { console.error(`profile 不存在：${profileDir}（先运行一次 dsh web）`); return 1; }
  console.log(`[install] DSH_HOME=${options.dshHome} profile=${options.profile} extensions=${options.extensions}${options.dryRun ? ' (dry-run)' : ''}`);

  // 1. 服务层版本。
  if (options.steps.service) {
    const profilePkg = readProfilePackage(profileDir) ?? {};
    const dep = profilePkg.dependencies?.[SERVICE_PACKAGE];
    if (dep === SERVICE_VERSION || dep === `^${SERVICE_VERSION}`) {
      console.log(`[install] 服务层已是 ${SERVICE_VERSION}`);
    } else if (options.check) {
      report.pending.push(`service: 需要安装 ${SERVICE_PACKAGE}@${SERVICE_VERSION}（当前 ${dep ?? '未安装'}）`);
    } else if (options.dryRun) {
      console.log(`[install] (dry-run) dsh plugin --profile ${options.profile} add ${SERVICE_PACKAGE}@${SERVICE_VERSION}`);
    } else {
      try {
        console.log('[install] 安装服务层（网络慢可加 --registry=https://registry.npmmirror.com）…');
        // 1. 可选 registry：通过 npm_config_registry 传给 dsh/pnpm 子进程，跑完恢复原值。
        const previousRegistry = process.env.npm_config_registry;
        if (typeof options.registry === 'string' && options.registry !== '') {
          process.env.npm_config_registry = options.registry;
          console.log(`[install] 使用 registry: ${options.registry}`);
        }
        try {
          run('dsh', ['plugin', '--profile', options.profile, 'add', `${SERVICE_PACKAGE}@${SERVICE_VERSION}`]);
        } finally {
          if (previousRegistry === undefined) delete process.env.npm_config_registry;
          else process.env.npm_config_registry = previousRegistry;
        }
      } catch (error) {
        console.error(`[install] 服务层安装失败：${error && error.message ? error.message : String(error)}`);
        return 2;
      }
    }
  }

  // 2. Windows 补丁（非 win32 跳过）。
  if (options.steps.patch) {
    if (process.platform !== 'win32') {
      console.log('[install] 跳过补丁：该缺陷仅 Windows 命名管道（非 win32）');
    } else {
      const patchScript = path.join(PLUGIN_DIR, 'patches', 'dsh-code-server-app-0.3.75-win-exthost.mjs');
      if (!fs.existsSync(patchScript)) {
        report.warnings.push('patch: 找不到 patches/dsh-code-server-app-0.3.75-win-exthost.mjs');
      } else if (options.check) {
        try {
          run(process.execPath, [patchScript, '--verify']);
        } catch {
          report.pending.push('patch: Windows extendHost 补丁未打（node patches/…mjs）');
        }
      } else if (options.dryRun) {
        console.log(`[install] (dry-run) node ${path.relative(process.cwd(), patchScript)} --verify`);
      } else {
        try {
          console.log(run(process.execPath, [patchScript, '--verify']));
        } catch {
          try {
            console.log(run(process.execPath, [patchScript]));
          } catch (error) {
            // 2.1 补丁失败不中断后续步骤（restore 钩子靠它做 best-effort；退出码最后统一给 3）。
            patchFailed = true;
            report.warnings.push(`patch: 补丁失败（${error && error.message ? error.message : String(error)}）`);
          }
        }
      }
    }
  }

  // 3. settings 合并（主题/图标 + 探测到的 JDK）。
  if (options.steps.settings) {
    const jdk = detectJdk();
    if (jdk === null) report.warnings.push('jdk: 未探测到 JDK（Java 语言服务器需要 JDK 25+，请自行安装）');
    const patch = { 'workbench.colorTheme': 'Dracula Theme', 'workbench.iconTheme': 'material-icon-theme' };
    // 3.1. 只有 JDK 主版本 ≥ 25 才写 java.jdt.ls.java.home（redhat.java 1.59+ 的硬要求）。
    if (jdk !== null && (jdk.major ?? 0) >= 25) {
      patch['java.jdt.ls.java.home'] = jdk.home;
    } else if (jdk !== null) {
      report.warnings.push(`jdk: 只探测到 JDK ${jdk.major ?? '?'}（${jdk.home}），Java 扩展需要 25+，未写入 java.jdt.ls.java.home`);
    }
    if (options.check) {
      const current = fs.existsSync(settingsFile) ? JSON.parse(fs.readFileSync(settingsFile, 'utf8')) : {};
      for (const [key, value] of Object.entries(patch)) {
        if (JSON.stringify(current[key]) !== JSON.stringify(value)) report.pending.push(`settings: ${key} 需要设为 ${JSON.stringify(value)}`);
      }
    } else {
      const merged = mergeSettings(settingsFile, patch, { dryRun: options.dryRun });
      if (merged.changed.length > 0) console.log(`[install] settings 已更新：${merged.changed.join(', ')}${merged.backup ? `（备份 ${path.basename(merged.backup)}）` : ''}`);
      else console.log('[install] settings 已是最新');
    }
  }

  // 4. 扩展（默认 minimal）。
  const extensionIds = EXTENSION_SETS[options.extensions] ?? [];
  if (options.extensions !== 'none' && extensionIds.length > 0) {
    if (options.check) {
      // 4.1 --check 是只读体检：只检查目录里是否已有该扩展，绝不下载/写盘。
      const present = fs.existsSync(extensionsDir) ? fs.readdirSync(extensionsDir) : [];
      for (const id of extensionIds) {
        const prefix = `${id.toLowerCase()}-`;
        if (!present.some((name) => name.toLowerCase().startsWith(prefix))) {
          report.pending.push(`extension: 缺少 ${id}（--extensions=${options.extensions}）`);
        }
      }
    } else {
      const failed = [];
      for (const id of extensionIds) {
        try {
          const result = await installExtension(id, extensionsDir, { dryRun: options.dryRun });
          console.log(`[install] 扩展 ${result}`);
        } catch (error) {
          failed.push(id);
          report.warnings.push(`extension ${id}: ${error && error.message ? error.message : String(error)}`);
        }
      }
      if (!options.dryRun && failed.length === 0) console.log(`[install] extensions.json 注册 ${rebuildExtensionState(extensionsDir)} 项`);
    }
  }

  // 5. --check 汇总与退出码。
  if (options.check) {
    if (report.pending.length === 0 && report.warnings.length === 0) { console.log('[check] 无需动作'); return 0; }
    for (const item of report.pending) console.log(`[check][待做] ${item}`);
    for (const item of report.warnings) console.log(`[check][告警] ${item}`);
    return report.pending.length > 0 ? 5 : 0;
  }
  for (const item of report.warnings) console.warn(`[warn] ${item}`);
  console.log('[install] 完成。重启 DSH 后打开右侧栏「编辑器」；验证：GET /code-server/healthz 返回 200。');
  if (patchFailed) return 3;
  return report.warnings.length > 0 ? 4 : 0;
}

process.exitCode = await main();



