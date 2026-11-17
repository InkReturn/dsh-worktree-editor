# patches/：`dsh-code-server-app` Windows extHost 补丁

这里放的是**随插件交付的固化补丁**，用来修 `dsh-code-server-app@0.3.75` 在 Windows + `serve: dsh` 下
extension host 起不来的缺陷（`Error: write ENOTSUP`，原理与排查见
[../docs/TROUBLESHOOTING.md](../docs/TROUBLESHOOTING.md) 第 3 节）。

| 文件 | 作用 |
|---|---|
| `dsh-code-server-app-0.3.75-win-exthost.mjs` | 补丁工具：版本/hash 守卫、幂等、原子写、`--verify`、`--revert` |
| `dsh-code-server-app-0.3.75-win-exthost.json` | 补丁清单：目标版本、双 hash、两个变体的锚点、`history[]` |

变体：

- **`socket-pipe`（A″，默认）**：给 `codeArgs` 加 `socket-path` + `disable-workspace-trust`，让上游走自带的命名管道泵。
  零新增监听端口，`healthz.mode` 仍是 `pipe`。
- **`tcp-loopback`（A′，应急）**：`serve: dsh` 内部改听回环 TCP（`lib/index.js` 三处锚点）。多一个无令牌回环端口，
  `healthz.mode` 变 `tcp`。仅在 A″ 验证门失败时使用。

> 当前生效的是 **A″**。

## 什么时候要重跑

| 情形 | 要不要重跑 | 怎么做 |
|---|---|---|
| **同版本重装插件**（`plugin_manager install_bundle` / `pnpm install` 覆盖 `node_modules`） | **要** | 文件被还原成官方版 ⇒ 直接重跑脚本（hash 会回到 `original`） |
| **升级到新版本**（如 0.3.76+） | 要，但先验锚点 | 脚本会因版本守卫退出 **2**；按补丁清单里的锚点复核与 `_canSendSocket` 判据，更新清单里的 `version`/`originalSha256`/锚点，再重跑 |
| **DSH 重启 / 换 profile 副本** | **不要** | 改动在文件里，重启不丢；同一 `node_modules` 目录无需重跑 |
| 其它机器/新装 | 要 | 把整个 `patches/` 目录带过去，`DSH_HOME` 指对位置再跑 |

## 命令

```powershell
# 只看状态（不改文件）：退出 0=已补丁 / 4=未打（原始）/ 3=内容未知或混杂
node patches\dsh-code-server-app-0.3.75-win-exthost.mjs --verify

# 打补丁（默认变体 A″；幂等，已补丁则不会重复插入）
node patches\dsh-code-server-app-0.3.75-win-exthost.mjs

# 指定 profile / 指定备份路径来源（DSH_HOME 缺省 ~/.dsh）
node ...\dsh-code-server-app-0.3.75-win-exthost.mjs --profile=web

# 应急切 A′（先 --revert 再打，避免 A″ 的 launcher 改动残留）
node ...\dsh-code-server-app-0.3.75-win-exthost.mjs --revert
node ...\dsh-code-server-app-0.3.75-win-exthost.mjs --variant=tcp-loopback

# 回滚（从 .cs-hub-patch.bak 还原）
node ...\dsh-code-server-app-0.3.75-win-exthost.mjs --revert
```

打完/回滚后必须让 launcher 重新加载源码（三选一）：

1. `plugin_manager` → `set_plugin target=include:code-server enabled=false`，再 `enabled=true`（热重载，最省事）；
2. 改 profile `cordis.patch.yml` 触发该行热重载；
3. 重启 DSH（会中断所有进行中的会话回合）。

## 退出码

| 码 | 含义 | 该做什么 |
|---|---|---|
| 0 | 成功 / 已是补丁（幂等） | 重启 launcher 生效 |
| 1 | 用法或路径问题 | 看报错里的路径与参数 |
| 2 | 版本不匹配（未适配） | 按补丁清单里的锚点复核 → 更新清单 |
| 3 | 目标文件既非原始也非已补丁 | **不要强改**：人工 diff，确认是否被第三方改过/清单过期 |
| 4 | 锚点替换校验失败（已整体回滚）| 说明上游代码变了：复核锚点后更新清单 |
| 5 | `--revert` 找不到 `.bak` | 无备份可回；只能重装插件或手工还原 |

## 纪律

- **只改 `node_modules` 里的目标文件**，绝不手改后提交；`node_modules` 不入仓。
- 首次打补丁会留 `launcher.mjs.cs-hub-patch.bak` / `index.js.cs-hub-patch.bak`（A′），**不要删**，回滚要用。
- 验证不能只看 `healthz`：A″ 下 `mode` 仍是 `pipe`，必须以 `user-data/logs/<最新>/exthost1/` 是否出现 + `remoteagent.log` 无 `ENOTSUP` 为准。
