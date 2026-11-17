# Security Policy

- 本插件只在本机运行；bridge 令牌文件（`$DSH_HOME/cs-hub/bridge.json`）落盘时收紧 ACL（POSIX 0600 / Windows 仅当前用户 R,W）。
- `/cs-hub-bridge/*` 自带令牌鉴权：未认证请求在读请求体之前就返回 401；带 `Origin` 一律 403。
- 威胁模型只覆盖「本机其他普通用户不可读令牌」；同机同用户进程不在模型内。
- 发现漏洞请开 issue 或私信维护者，不要公开 PoC。
