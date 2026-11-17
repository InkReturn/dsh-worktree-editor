#!/usr/bin/env node
/**
 * dsh-code-server-app 0.3.75 的 Windows extHost 缺陷补丁工具（cs-hub / T8）。
 *
 * 背景：`serve: dsh` 时 DSH 经命名管道把请求转给 launcher，launcher 再把手上的
 * 管道 socket 作为「句柄」`child.send()` 给 extension host 子进程；Node/libuv 在
 * Windows 上不能传递管道句柄 ⇒ extHost 反复退出（`Error: write ENOTSUP`），
 * LSP / git / 内置编辑器桥全部不可用。根因与两种修法见
 * 原理与排查见 `docs/TROUBLESHOOTING.md` 第 3 节。
 *
 * 两种变体（都保留 `serve: dsh` 同源外壳，都不退回跨源 loopback）：
 * - `socket-pipe`（A″，默认）：给 `codeArgs` 补 `socket-path` 与 `disable-workspace-trust`，
 *   让上游走它自带的命名管道泵（`_listenOnPipe` + `VSCODE_EXTHOST_IPC_HOOK`），全程不传句柄。
 * - `tcp-loopback`（A′）：`serve: dsh` 内部改听回环 TCP，`serve-dsh` 按端口代理；代价是多一个
 *   无令牌回环端口。
 *
 * 用法：
 *   node dsh-code-server-app-0.3.75-win-exthost.mjs --verify                # 只看状态，不改文件
 *   node dsh-code-server-app-0.3.75-win-exthost.mjs                          # 按默认变体打补丁
 *   node dsh-code-server-app-0.3.75-win-exthost.mjs --variant=tcp-loopback   # 切 A′
 *   node dsh-code-server-app-0.3.75-win-exthost.mjs --revert                 # 从 .bak 还原
 *   node dsh-code-server-app-0.3.75-win-exthost.mjs --profile=web            # 指定 profile
 *
 * 退出码：
 *   0 成功（或已是补丁，幂等）；1 用法/内部错误；2 版本不匹配（未适配）；
 *   3 目标文件既非原始也非已补丁（被第三方改过或清单过期，未改动任何文件）；
 *   4 锚点替换校验失败（已整体回滚）；5 `--revert` 时找不到备份。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

/** 清单文件名（与本脚本同目录、同基名）。 */
const MANIFEST_BASENAME = 'dsh-code-server-app-0.3.75-win-exthost.json';
/** 补丁标记：已打补丁的文件必须包含这一行（判幂等的第一依据）。 */
const MARKER_HINT = '// @cs-hub-patch:win-exthost v1';
/** 目标包的 npm 包名（同时是 node_modules 下的目录名）。 */
const TARGET_PACKAGE = 'dsh-code-server-app';

/**
 * 补丁工具的业务错误：带进程退出码，便于调用方（人或 CI）按码分支。
 */
class PatchError extends Error {
  /**
   * @param {number} code 进程退出码（2=版本不匹配，3=内容未知，4=替换失败，5=无备份）
   * @param {string} message 面向人的中文说明
   */
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * 计算文件的 SHA-256（大写十六进制），用于清单双 hash 守卫。
 * @param {Buffer|string} content 文件字节或文本（文本按 UTF-8 编码参与计算）
 * @returns {string} 64 位大写十六进制摘要
 */
function sha256(content) {
  // 1. 统一转成 Buffer；文本一律 UTF-8（与 VS Code 源码文件编码一致）。
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  // 2. 输出大写，便于与清单里人工核对的字面量直接比对。
  return crypto.createHash('sha256').update(buffer).digest('hex').toUpperCase();
}

/**
 * 解析 DSH 数据根目录：优先环境变量 `DSH_HOME`，否则 `~/.dsh`。
 * 口径与包内 `dshHome()` 一致，避免把补丁打到别处。
 * @returns {string} DSH 数据根目录的绝对路径
 */
function resolveDshHome() {
  // 1. 显式环境变量优先（多实例/绿色版用户会用它）。
  const fromEnv = process.env.DSH_HOME;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return path.resolve(fromEnv.trim());
  // 2. 回落到用户主目录下的 .dsh。
  return path.join(os.homedir(), '.dsh');
}

/**
 * 解析参数：支持 `--verify`、`--revert`、`--variant=<name>`、`--profile=<name>`、`--help`。
 * 未知参数一律报错退出，避免拼错时静默按默认值打补丁。
 * @param {string[]} argv process.argv.slice(2)
 * @returns {{verify: boolean, revert: boolean, variant: string|null, profile: string}} 解析结果
 */
function parseArgs(argv) {
  const options = { verify: false, revert: false, variant: null, profile: 'web' };
  // 1. 逐个消费参数；带值的参数接受 `--k=v` 形式。
  for (const raw of argv) {
    if (raw === '--verify') options.verify = true;
    else if (raw === '--revert') options.revert = true;
    else if (raw === '--help' || raw === '-h') options.help = true;
    else if (raw.startsWith('--variant=')) options.variant = raw.slice('--variant='.length);
    else if (raw.startsWith('--profile=')) options.profile = raw.slice('--profile='.length);
    else throw new PatchError(1, `未知参数：${raw}（可用：--verify / --revert / --variant=<name> / --profile=<name>）`);
  }
  // 2. verify 与 revert 互斥：一个只看，一个要改回。
  if (options.verify && options.revert) throw new PatchError(1, '--verify 与 --revert 不能同时使用');
  return options;
}

/**
 * 读取并解析清单 JSON（与脚本同目录）。
 * @returns {{manifestPath: string, manifest: object}} 清单路径与解析后的对象
 */
function loadManifest() {
  // 1. 用 import.meta.url 定位脚本所在目录，清单与脚本同目录、同基名。
  const here = path.dirname(fileURLToPath(import.meta.url));
  const manifestPath = path.join(here, MANIFEST_BASENAME);
  // 2. 读不到就是部署不完整，直接报错（不能猜默认值）。
  if (!fs.existsSync(manifestPath)) {
    throw new PatchError(1, `找不到补丁清单：${manifestPath}`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  // 3. 清单自身版本必须与目标包名一致，防止拷错文件。
  if (manifest.package !== TARGET_PACKAGE) {
    throw new PatchError(1, `清单的包名是 ${manifest.package}，但本工具只服务于 ${TARGET_PACKAGE}`);
  }
  return { manifestPath, manifest };
}

/**
 * 定位已安装的目标包目录并校验版本。
 * @param {string} dshHome DSH 数据根目录
 * @param {string} profile profile 名（如 `web`）
 * @param {string} expectedVersion 清单声明支持的版本（如 `0.3.75`）
 * @returns {string} 目标包目录的绝对路径
 * @throws {PatchError} 包不存在或版本不匹配时抛 2
 */
function resolveTargetDir(dshHome, profile, expectedVersion) {
  // 1. 固定结构：<DSH_HOME>/profiles/<profile>/node_modules/<包名>，不写死盘符路径。
  const targetDir = path.join(dshHome, 'profiles', profile, 'node_modules', TARGET_PACKAGE);
  const pkgJsonPath = path.join(targetDir, 'package.json');
  if (!fs.existsSync(pkgJsonPath)) {
    throw new PatchError(1, `没找到已安装的 ${TARGET_PACKAGE}：${pkgJsonPath}（先装插件再打补丁）`);
  }
  // 2. 版本守卫：只接受清单声明版本，版本不符不猜锚点。
  const installedVersion = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8')).version;
  if (installedVersion !== expectedVersion) {
    throw new PatchError(
      2,
      `未适配版本 ${installedVersion}：请按补丁清单里的锚点复核后更新清单`,
    );
  }
  return targetDir;
}

/**
 * 判定单个目标文件的补丁状态。
 * @param {string} absPath 目标文件绝对路径
 * @param {object} fileSpec 清单里的文件条目（path / originalSha256 / patchedSha256 / edits）
 * @returns {{state: 'patched'|'original'|'unknown', hash: string, text: string}} 状态、当前 hash 与文本内容
 */
function inspectFile(absPath, fileSpec) {
  // 1. 读原文；sha256 用作双 hash 判定依据。
  const text = fs.readFileSync(absPath, 'utf8');
  const hash = sha256(text);
  // 2. 先判「已打补丁」：标记行最可靠（patchedSha256 在首次打补丁后才回写）。
  if (text.includes(MARKER_HINT)) return { state: 'patched', hash, text };
  if (typeof fileSpec.patchedSha256 === 'string' && hash === fileSpec.patchedSha256) {
    return { state: 'patched', hash, text };
  }
  // 3. 再判「原始版本」：hash 必须与清单记录的原始 hash 完全一致。
  if (hash === fileSpec.originalSha256) return { state: 'original', hash, text };
  // 4. 两者都不是 ⇒ 文件被第三方改过或清单过期，绝不能盲改。
  return { state: 'unknown', hash, text };
}

/**
 * 用字面量做一次替换，并强制断言「锚点出现次数恰好 1」。
 * 用函数式 replacer，避免插入文本里的 `$&`、`$1` 被当成替换模式。
 * @param {string} source 原始文本
 * @param {{anchor: string, insert: string, note: string}} edit 清单里的一条编辑
 * @param {string} fileLabel 用于报错定位的文件标签
 * @returns {string} 替换后的文本
 * @throws {PatchError} 锚点出现次数不为 1 时抛 4
 */
function applyEdit(source, edit, fileLabel) {
  // 1. 统计锚点出现次数（用 split 计数，避免正则元字符问题）。
  const occurrences = source.split(edit.anchor).length - 1;
  if (occurrences !== 1) {
    throw new PatchError(
      4,
      `${fileLabel} 锚点匹配 ${occurrences} 次（必须恰好 1 次）：${edit.note}\n锚点首行：${edit.anchor.split('\n')[0]}`,
    );
  }
  // 2. 单次替换；函数式 replacer 保证插入文本原样写回。
  return source.replace(edit.anchor, () => edit.insert);
}

/**
 * 原子写文件：先写同目录临时文件再 rename，避免 DSH 热重载读到半截内容。
 * @param {string} absPath 目标文件路径
 * @param {string} content 新内容（UTF-8 文本）
 */
function writeFileAtomic(absPath, content) {
  // 1. 临时文件放在同目录，保证与目标同一文件系统（跨盘 rename 会失败）。
  const tmpPath = `${absPath}.cs-hub-patch.tmp`;
  fs.writeFileSync(tmpPath, content, 'utf8');
  // 2. rename 覆盖是原子的；失败时尽量清掉临时文件再抛出。
  try {
    fs.renameSync(tmpPath, absPath);
  } catch (error) {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      /* 清理失败不影响主错误 */
    }
    throw error;
  }
}

/**
 * 首次打补丁前留一份 `.cs-hub-patch.bak`（已存在则不覆盖，保证回滚点始终指向原始文件）。
 * @param {string} absPath 目标文件绝对路径
 * @returns {string} 备份文件路径
 */
function ensureBackup(absPath) {
  const bakPath = `${absPath}.cs-hub-patch.bak`;
  // 1. 已有备份说明之前打过补丁，保留最初的那份，避免二次备份覆盖回滚点。
  if (!fs.existsSync(bakPath)) fs.copyFileSync(absPath, bakPath);
  return bakPath;
}

/**
 * 把一次成功操作追加进清单 `history[]` 并回写清单（原子写）。
 * @param {string} manifestPath 清单路径
 * @param {object} manifest 清单对象（就地修改）
 * @param {object} record 历史记录（时间/变体/文件前后 hash 等）
 */
function appendHistory(manifestPath, manifest, record) {
  // 1. 统一时间戳为 ISO 秒级，便于与文档里的排障记录对齐。
  const entry = { at: new Date().toISOString(), ...record };
  if (!Array.isArray(manifest.history)) manifest.history = [];
  manifest.history.push(entry);
  // 2. 清单本身也用原子写，防止并发读到半截 JSON。
  writeFileAtomic(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

/**
 * 主流程：解析参数 → 定位包 → 逐文件判定/打补丁/回滚 → 记录清单。
 * @param {string[]} argv 命令行参数（不含 node 与脚本路径）
 * @returns {number} 进程退出码
 */
function main(argv) {
  // 1. 参数与清单。
  const options = parseArgs(argv);
  if (options.help) {
    printUsage();
    return 0;
  }
  const { manifestPath, manifest } = loadManifest();
  const variantName = options.variant ?? manifest.defaultVariant;
  const variant = manifest.variants[variantName];
  if (!variant) {
    throw new PatchError(1, `未知变体 ${variantName}；可用：${Object.keys(manifest.variants).join(' / ')}`);
  }

  // 2. 定位目标包并校验版本。
  const dshHome = resolveDshHome();
  const targetDir = resolveTargetDir(dshHome, options.profile, manifest.version);
  console.log(`[cs-hub-patch] 目标：${targetDir}`);
  console.log(`[cs-hub-patch] 变体：${variantName}（${variant.title}）`);

  // 3. 逐文件判定状态（只读阶段，任何异常都可以安全退出）。
  const inspected = variant.files.map((fileSpec) => {
    const absPath = path.join(targetDir, fileSpec.path);
    if (!fs.existsSync(absPath)) throw new PatchError(1, `目标文件不存在：${absPath}`);
    return { fileSpec, absPath, ...inspectFile(absPath, fileSpec) };
  });
  for (const item of inspected) {
    console.log(`[cs-hub-patch] ${item.fileSpec.path}: ${item.state} (sha256=${item.hash})`);
  }

  // 4. --revert：从 .bak 还原（只还原存在备份的文件）。
  if (options.revert) return revertFiles(inspected, manifestPath, manifest, variantName);

  // 5. --verify：只报告状态，不改任何文件。
  if (options.verify) {
    const allPatched = inspected.every((item) => item.state === 'patched');
    const allOriginal = inspected.every((item) => item.state === 'original');
    console.log(
      allPatched
        ? '[cs-hub-patch] 已是补丁状态'
        : allOriginal
          ? '[cs-hub-patch] 未打补丁（原始版本）'
          : '[cs-hub-patch] 状态混杂或内容未知，详见上方逐文件状态',
    );
    if (allPatched) return 0;
    if (allOriginal) return 4;
    return 3;
  }

  // 6. 打补丁前的硬前置：任何文件状态未知 ⇒ 整体拒绝，不改任何文件。
  const unknown = inspected.filter((item) => item.state === 'unknown');
  if (unknown.length > 0) {
    throw new PatchError(
      3,
      `以下文件既非原始也非已补丁，拒绝改动：${unknown.map((item) => item.fileSpec.path).join(', ')}\n` +
        '可能被第三方改过或清单已过期；请人工核对后更新清单 hash。',
    );
  }

  // 7. 需要改的文件：先全部在内存里算好，再统一落盘；任何一步失败就整体回滚。
  const pending = inspected.filter((item) => item.state === 'original');
  if (pending.length === 0) {
    console.log('[cs-hub-patch] already patched，无需改动');
    return 0;
  }

  const backups = new Map();
  const results = [];
  try {
    for (const item of pending) {
      // 7.1 先解析所有编辑（锚点断言在内存里做，落盘前不产生副作用）。
      let next = item.text;
      for (const edit of item.fileSpec.edits) next = applyEdit(next, edit, item.fileSpec.path);
      // 7.2 留备份，再原子写。
      const bakPath = ensureBackup(item.absPath);
      backups.set(item.absPath, bakPath);
      writeFileAtomic(item.absPath, next);
      const afterHash = sha256(next);
      results.push({ path: item.fileSpec.path, before: item.hash, after: afterHash });
      console.log(`[cs-hub-patch] 已打补丁：${item.fileSpec.path}（备份 ${path.basename(bakPath)}）`);
    }
  } catch (error) {
    // 7.3 任一文件失败 ⇒ 用备份还原已改过的文件，保持「全成或全不改」。
    for (const [absPath, bakPath] of backups) {
      try {
        writeFileAtomic(absPath, fs.readFileSync(bakPath, 'utf8'));
      } catch {
        console.error(`[cs-hub-patch] 回滚失败：${absPath}（请手工从 ${bakPath} 还原）`);
      }
    }
    throw error instanceof PatchError ? error : new PatchError(4, `打补丁失败并已回滚：${error.message}`);
  }

  // 8. 回写清单：patchedSha256（首次打补丁后才可知）+ history 记录。
  for (const fileSpec of variant.files) {
    const hit = results.find((item) => item.path === fileSpec.path);
    if (hit) fileSpec.patchedSha256 = hit.after;
    else if (fileSpec.patchedSha256 === null) {
      // 该文件本来就是补丁状态（例如上次已打），从磁盘补一次 hash，保证清单可用。
      fileSpec.patchedSha256 = sha256(fs.readFileSync(path.join(targetDir, fileSpec.path), 'utf8'));
    }
  }
  appendHistory(manifestPath, manifest, {
    action: 'apply',
    variant: variantName,
    version: manifest.version,
    dshHome,
    profile: options.profile,
    files: results,
    node: process.versions.node,
    platform: process.platform,
  });

  console.log('[cs-hub-patch] 完成。重启 launcher 后新源码才生效（DSH 侧热重载或重启 DSH）。');
  return 0;
}

/**
 * `--revert` 分支：从 `.cs-hub-patch.bak` 还原目标文件。
 * @param {Array<{fileSpec: object, absPath: string, state: string, hash: string}>} inspected 判定结果
 * @param {string} manifestPath 清单路径
 * @param {object} manifest 清单对象
 * @param {string} variantName 变体名（写历史用）
 * @returns {number} 进程退出码
 */
function revertFiles(inspected, manifestPath, manifest, variantName) {
  // 1. 先检查备份齐不齐；缺备份就整体不动（避免只还原一半）。
  const withBackup = inspected.filter((item) => fs.existsSync(`${item.absPath}.cs-hub-patch.bak`));
  if (withBackup.length === 0) throw new PatchError(5, '找不到任何 .cs-hub-patch.bak 备份，无法还原');
  // 2. 逐个原子还原，并要求还原后 hash 回到清单记录的原始值。
  const restored = [];
  for (const item of withBackup) {
    const bakPath = `${item.absPath}.cs-hub-patch.bak`;
    const originalText = fs.readFileSync(bakPath, 'utf8');
    writeFileAtomic(item.absPath, originalText);
    const afterHash = sha256(originalText);
    restored.push({ path: item.fileSpec.path, before: item.hash, after: afterHash });
    const ok = afterHash === item.fileSpec.originalSha256;
    console.log(`[cs-hub-patch] 已还原 ${item.fileSpec.path}${ok ? '' : '（警告：hash 与清单原始值不一致）'}`);
  }
  // 3. 记录还原动作，便于后续排障。
  appendHistory(manifestPath, manifest, {
    action: 'revert',
    variant: variantName,
    version: manifest.version,
    files: restored,
    node: process.versions.node,
    platform: process.platform,
  });
  console.log('[cs-hub-patch] 还原完成。重启 launcher 后回到原始行为。');
  return 0;
}

/** 打印用法（--help 与参数错误时使用）。 */
function printUsage() {
  console.log(
    [
      '用法：node dsh-code-server-app-0.3.75-win-exthost.mjs [--verify|--revert] [--variant=<name>] [--profile=<name>]',
      '  --verify           只报告状态，不改文件（0=已是补丁，4=未打，3=未知/混杂）',
      '  --revert           从 .cs-hub-patch.bak 还原',
      '  --variant=...      选择补丁变体（socket-pipe=A″默认 / tcp-loopback=A′）',
      '  --profile=web      profile 名（默认 web）',
      '  DSH_HOME           环境变量，缺省 ~/.dsh',
    ].join('\n'),
  );
}

// 顶层入口：把业务错误转成退出码，未预期错误统一 1。
try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  if (error instanceof PatchError) {
    console.error(`[cs-hub-patch] ${error.message}`);
    process.exitCode = error.code;
  } else {
    console.error(`[cs-hub-patch] 未预期错误：${error && error.stack ? error.stack : error}`);
    process.exitCode = 1;
  }
}
