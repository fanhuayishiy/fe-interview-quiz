# 通过 1Panel 部署个人刷题站

部署内容是整个项目，包含后端；不要只上传 index.html。无需安装 MySQL、Redis，也无需开放注册。

## 1. 准备项目和账号

在服务器终端把完整项目放到固定目录，例如 `/opt/fe-interview-quiz`。可从 GitHub 克隆，也可上传项目压缩包后解压；代码更新发布前请使用本次交付的项目文件。

在该目录执行：

```sh
cp .env.example .env
chmod 600 .env
```

用 1Panel 文件编辑器填写 `.env`：

```dotenv
ADMIN_USERNAME=你的用户名
ADMIN_PASSWORD='这里换成你自己的至少12位随机密码'
PUBLIC_URL=https://你的刷题域名
COOKIE_SECURE=true
QUIZ_PORT=3000
```

不要把 `.env` 上传 GitHub。账号只在数据库首次创建时初始化；普通重启、升级不会重建账号或清空记录。

## 2. 启动容器

1Panel 的“容器 → 编排”支持选择服务器上的 Compose 文件。选择项目目录里的 `compose.yaml`，并让项目目录中的 `.env` 参与变量解析。不同版本的面板名称可能略有区别。

如果面板无法找到 `.env` 或相对构建路径，在服务器终端直接运行：

```sh
cd /opt/fe-interview-quiz
docker compose --env-file .env -f compose.yaml up -d --build
docker compose logs --tail=50 quiz
curl http://127.0.0.1:3000/healthz
```

健康检查返回 `{"ok":true}` 即表示后端已启动；容器也可以在 1Panel 中查看。首次构建需要从 Docker Hub 下载官方 Node.js 24 镜像。

## 3. 域名、反向代理和 HTTPS

先把域名解析到服务器，再在 1Panel 的“网站”中新建反向代理站点，并申请 HTTPS 证书。

- 若 OpenResty 使用宿主机网络，代理目标填写 `http://127.0.0.1:3000`；其他面板代理可使用同等的宿主机访问方式。
- 若 OpenResty 使用独立容器桥接网络，其内部的 `127.0.0.1` 指向它自己。请在 1Panel 中让两个容器加入同一自定义 Docker 网络，并将代理目标设置为 `http://quiz:3000`。可给本项目 Compose 的 `quiz` 服务添加该外部网络，项目根部声明 `networks: {面板网络名: {external: true}}`，服务处声明 `networks: [面板网络名]`。
- 不需要把后端 3000 端口开放到公网；通过域名访问同一个前后端站点。
- `PUBLIC_URL` 必须与浏览器地址一致，例如 `https://quiz.example.com`。HTTPS 部署保持 `COOKIE_SECURE=true`。

打开域名，用 `.env` 中的账号登录。登录后应看到“云端已连接”或“已保存到服务器”。答题或调整设置后，状态会变为“正在保存…”再变为“已保存到服务器”。

临时通过 HTTP 测试时，需要同时设置 `PUBLIC_URL=http://实际地址:端口` 与 `COOKIE_SECURE=false`，并确保网络代理可访问该端口。正式启用 HTTPS 后恢复 `COOKIE_SECURE=true`。

## 4. 把旧记录搬过来

旧页面的数据在浏览器中，服务器无法直接读取另一个域名或本地文件的数据。

1. 打开更新后的本地 HTML 或更新后的旧站点，在原来存有数据的浏览器中点击“导出刷题记录”。文件版请使用与原来相同的文件路径。
2. 登录新站点，点击顶部“导入旧记录”，选择导出的 JSON。
3. 核对题目/错题/收藏数量，点击“确认导入并替换”。
4. 看到“已保存到服务器”后，再用另一个设备登录验证。

若同一域名下已经存有旧浏览器记录，而服务器没有记录，首次登录会直接提示导入。导入或采用服务器记录前，会在本机保留最近一次替换前的备份，可通过“本机备份”下载。备份仍在该浏览器里，清理浏览器数据会删除它。

旧格式兼容：旧版 `catCount` 会转为类型勾选，设为 0 的类型继续排除；旧版已答题记录仍参与降权，错题仍保留正常权重。没有 `optionOrders` 的旧练习继续使用原始 A/B/C/D 排列，历史答案、分数、错题选择不变；重新开始新一轮才随机排列选项。服务端读取旧数据库不会改写原始 JSON 或推进版本号，后续正常保存时才写入转换后的格式。

浏览器首次转换旧格式前，会尽力将原始字符串备份到 localStorage 的 `fe_quiz_mcq_v1_before_upgrade`，不覆盖已有升级前备份。需要取出时，可在原站点或原文件的浏览器控制台执行 `localStorage.getItem('fe_quiz_mcq_v1_before_upgrade')` 获取。不要清理原浏览器的数据；不同域名或本地文件之间仍需通过 JSON 导出、导入迁移。

## 5. 备份与恢复

数据库位于持久化卷 `quiz_data` 的 `/app/data/quiz.sqlite`。SQLite 使用 WAL，因此不能只在运行时随意复制主文件。以下步骤先停止服务，再复制完整数据目录：

```sh
cd /opt/fe-interview-quiz
mkdir -p backups
docker compose stop quiz
docker compose cp quiz:/app/data/. ./backups/
docker compose start quiz
```

将 `backups` 目录和安全保存的 `.env` 备份到别处。数据库同时包含账号与登录会话，备份应保密；无需把账号密码发给开发者。

恢复到已有容器的数据卷：

```sh
docker compose stop quiz
docker compose cp ./backups/. quiz:/app/data/
docker compose run --rm --no-deps --user root --entrypoint sh quiz -c 'chown -R node:node /app/data'
docker compose start quiz
```

新服务器先用相同项目名执行 `docker compose create` 创建容器和数据卷，再执行恢复步骤。不要执行 `docker compose down -v`，该命令会删除数据卷。

## 6. 更新和重置密码

更新代码后，在原项目目录执行：

```sh
docker compose up -d --build
```

保持目录与 Compose 项目名一致，数据卷会继续使用。

重置密码时先修改 `.env` 的账号和密码，再执行：

```sh
docker compose stop quiz
docker compose run --rm --no-deps quiz node server.cjs --reset-password
docker compose up -d
```

刷题数据保留，旧登录会话全部失效。若只改 `.env` 后重启，不会修改已存在的账号密码。

## 7. 同步规则

- 错题、收藏、统计、出题设置和未完成练习一起同步。
- 断网后继续操作会暂存在本机；恢复网络后重试。离开页面前尽量等到“已保存到服务器”。
- 多设备同时修改发生冲突时，不自动覆盖。可以先下载本机副本，再选择使用服务器或明确覆盖服务器。
- 为避免无意丢失清空/删除操作，同步使用完整数据版本，并不自动合并两台设备的数据。
- 个人单账号，无注册、邮箱验证码或找回密码页面。登录有效期为 7 天，过期后重新登录。
- 当前 GitHub Pages 仍是离线版本，不会自动变成后端；云端功能需访问部署在服务器上的新站点。
