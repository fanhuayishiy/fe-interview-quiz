# 单账号后端实施计划

**Goal:** 个人登录后自动同步刷题数据，提供可供 1Panel 部署的完整项目。

**Architecture:** Node.js 原生 HTTP、crypto 与 SQLite；服务端注入独立 sync.js 和 sync.css，原单文件页面保持离线兼容。

**Tech Stack:** Node.js 24 LTS，node:sqlite，node:test，Docker Compose。

- [x] 在 tests/server.test.cjs 编写真实 HTTP 测试并验证缺少服务时失败：账号、登录、会话、数据持久化、冲突、防护和静态文件边界。
- [x] 实现 lib/store.cjs（校验、账号、会话和状态）、server.cjs（路由、来源校验、登录限流和静态白名单），通过测试。
- [x] 页面增加导出与数据桥接，public/sync-engine.js 独立处理同步状态，public/sync.js 实现登录与导入界面，在 public/sync.css 中增加窄屏样式。
- [x] 增加 Dockerfile、compose.yaml、.env.example、README 部署/备份/迁移说明，运行后端和前端回归并检查浏览器交互。

验证：14 项后端/同步测试与 7 项抽题检查通过。浏览器实测登录、答题、收藏、保存、刷新恢复以及独立 localStorage 来源读取同一云端记录。审查发现并修复旧 GET 晚于 PUT 返回和初始服务失败不重连的时序问题，均补回归测试并复核通过。

验证限制：当前机器没有 Docker，未实测容器构建和 1Panel 代理、数据卷权限与备份恢复。部署文档与可上传项目包随代码交付。

无服务器凭据，完成本地实现与部署材料；不会推测或访问用户的 1Panel。新功能未被要求推送，先交付可检查的工作区。
