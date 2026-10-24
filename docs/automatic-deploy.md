# 自动部署接入

现有站点：`https://quiz.fhysy.com/`，服务器 `149.118.56.76`，现有 1Panel 编排 `fe-interview-quiz`，目录 `/opt/fe-interview-quiz`。SSH 用户、端口、数据库卷与网络须首次只读核对后再启用。

## 工作流程

main 推送或手动运行 Actions 后，先跑应用测试，再构建带提交号的 Docker 镜像。CI 使用真实容器验证登录、数据保存、重启持久化、代理网络保留、失败回滚及数据卷误配置保护，全部通过后生成镜像包。

启用部署后，通过校验主机公钥的 SSH 连接传输镜像，校验 SHA256 后加载。服务器沿用原 `.env` 与指定的现有数据卷；停止旧容器后复制完整 SQLite 数据，备份完成才更新。容器健康检查失败时恢复原镜像，数据卷不切换，也不自动用备份覆盖可能新增的数据。

服务器不需要访问 GHCR 或 Docker Hub 来下载新应用镜像；镜像已在 CI 中构建，通过 SSH 传输。当前构建使用 GitHub Linux x86_64 runner；首次连接须确认服务器为 x86_64，其他架构需要调整构建配置后才可启用。

## 首次配置

1. 确认 SSH 用户和端口，在服务器为专用部署公钥授权。不在聊天中传递密码或私钥。
2. 核对 SSH 主机公钥指纹，将已确认的 known_hosts 内容保存到 GitHub Secret。
3. 只读核对原容器 Compose 项目名、`/app/data` 的真实数据卷和代理网络。绑定主机目录的数据库或 host/container 网络模式，需要单独迁移方案，部署脚本会拒绝直接切换。
4. 在服务器原有 `/opt/fe-interview-quiz/.env` 中追加核对后的两项，其他账号密码配置保留：

```dotenv
COMPOSE_PROJECT_NAME=实际现有项目名
QUIZ_DATA_VOLUME=实际现有数据卷名
```

脚本不自动创建数据卷，防止填错卷名后出现空白记录。现有桥接网络及服务别名会自动写入每个发布目录的 `networks.json`，更新和回滚均使用，以保留 1Panel/OpenResty 代理路径。

5. 在 GitHub 仓库 Actions secrets 中配置：

| Secret | 含义 |
| --- | --- |
| QUIZ_SSH_HOST | 服务器 IP 或主机名 |
| QUIZ_SSH_PORT | SSH 端口，未填时为 22 |
| QUIZ_SSH_USER | 部署用户 |
| QUIZ_SSH_KEY | 专用部署私钥，由受控本地文件写入 Secret |
| QUIZ_SSH_KNOWN_HOSTS | 已核对指纹的 SSH 主机公钥记录 |

在 Actions variables 配置 `QUIZ_DEPLOY_ROOT=/opt/fe-interview-quiz`。完成 CI 与服务器检查后，设置 `QUIZ_DEPLOY_ENABLED=true` 才会实际部署。默认不部署，因此首次提交工作流可以先验证 Docker 构建和回滚。

## 使用和回退

以后只需正常推送 main。构建或测试失败时不触碰服务器；多个部署串行执行，服务器端也有独立文件锁。GitHub 的 Actions 页面显示每次构建与部署结果。

服务器文件：

- `releases/<提交号>/`：该版本部署脚本、Compose、保留的网络配置。
- `backups/<时间>-<提交号>/data.tar.gz`：更新前完整数据备份。
- `.current-release`：最近成功版本。
- 原有 `.env`：持续留在服务器，不上传 GitHub。

成功部署后删除已经加载的镜像传输包，保留旧镜像和数据库备份用于回退；不会执行镜像全局清理或删除数据卷。应按服务器容量定期检查旧备份。

接入后更新以流水线为准，避免同时在 1Panel 用旧 Compose 重新构建覆盖。1Panel 仍可用于查看容器、日志、资源和网站代理。
