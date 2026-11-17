# 故障排查

## 1. 右侧栏显示「code-server 不可达」/ iframe 空白

- `GET /code-server/healthz`：200 = 服务层活着；502 = 没起；401 = 没带 DSH cookie（正常，从 DSH 页面内访问）。
- 起不来时看重启结果：`POST /api/code-server/stop` → `POST /api/code-server/start`，再看 `status.error` 与 `logTail`。
- 日志：`$DSH_HOME/code-server/user-data/logs/<最新时间戳>/remoteagent.log`。

## 2. 编辑器里卡住 / 右键无菜单 / 打不了字

- `pid.json` **不可信**：热重载时旧实例可能晚于新实例删记录。不要用它判活，判活只用 `healthz`。
- 判断是否被冻结：右侧栏若显示「已冻结·点击恢复」，点一下即可（LRU 上限默认 3）。

## 3. extHost 反复退出（Windows）

- 症状：`remoteagent.log` 出现 `write ENOTSUP`，编辑器无补全/跳转。
- 原因：`serve: dsh` 命名管道下 Node 不能把管道句柄交给子进程。
- 处理：`node patches/dsh-code-server-app-0.3.75-win-exthost.mjs --verify`，未打则运行；**升级包版本后必须重跑**。

## 4. 代码跳转不工作

- Java：`java.jdt.ls.java.home` 必须指向 **JDK 25+**（redhat.java 1.59 起的硬要求）；loose `.java` 文件是轻量模式，需打开含 `pom.xml` 的项目文件夹。
- Go：需要 `gopls`（`go install golang.org/x/tools/gopls@latest`）且在 PATH 或 `$(go env GOPATH)/bin`；同样需要 `go.mod` 项目目录。
- Python：本插件不装 Python；没有解释器时补全/诊断不可用属于预期。

## 5. 中文界面不生效

- 语言包装了但界面还是英文：NLS 依赖 `<user-data>/languagepacks.json`，它只在**扩展管理服务安装扩展**时生成。
- 处理：IDE 内 `Ctrl+Shift+P` → `Extensions: Install from VSIX...` → 远端路径填语言包 VSIX → Install → reload。
  之后应出现 `clp/<hash>.zh-cn/nls.messages.js`（中文）。脚本手工解包不会生成该文件。

## 6. 两个会话同 folder 时出现提示条

- 这是设计行为：bridge 反查只能归属一个会话（后注册者胜出）。
- 提示条用户可见；关闭并重开该页签即可重新接管。不会互相踢。

## 7. 端口 / 挂载

- `serve: dsh` 模式没有独立端口，挂在 DSH 的 `/code-server/*`；
- 改 `serverMount` 要同步服务层配置，否则 iframe 404。

## 8. 如何收集诊断

```bash
node scripts/install.mjs --check          # 环境/补丁/设置/扩展四项体检，退出码 5 = 有待做
node --test                               # 插件自测（不触网）
```
