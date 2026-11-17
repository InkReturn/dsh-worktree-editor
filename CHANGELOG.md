# Changelog

## 0.2.0

- 首个公开发布：每会话 VS Code 窗口、窗口注册表、LRU 冻结、bridge 路由与 SSE。
- 安全硬化：bridge 未认证请求不读请求体、令牌文件 ACL 收紧。
- 安装器 `scripts/install.mjs`（分步幂等）与 restore 钩子 `scripts/post-restore.mjs`。
