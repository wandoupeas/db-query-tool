# 数据库查询工具

[English](./README.md)

数据库查询工具是一款用于日常数据查询、结果导出和定时报表发送的桌面应用。项目使用 Electron 承载桌面窗口，Express 提供本地服务，支持 MySQL 与 PostgreSQL，查询结果可导出为 XLSX，也可通过邮件或企业微信机器人发送。

## 功能特性

- 本地认证：支持本地账号注册与登录。
- 用户级隔离：已保存连接、SMTP 设置、企业微信机器人和定时任务按用户隔离。
- 数据库连接管理：支持保存、切换、测试和删除 MySQL/PostgreSQL 连接。
- SQL 工作台：支持 SQL 执行、结果分页、列排序、表列表、表结构查看和查询历史复用。
- XLSX 导出：可将当前查询结果导出为 Excel 文件，并自定义文件名和 Sheet 名称。
- 报表发送：支持通过邮件、企业微信机器人或两者同时发送查询结果。
- 定时任务：基于 cron 表达式执行 SQL，自动发送结果，支持手动触发、编辑、删除和查看执行日志。
- 桌面打包：支持 Windows portable/zip 与 macOS dmg 打包。

## 技术栈

- Runtime：Node.js 16+
- Desktop：Electron
- Server：Express
- Database drivers：mysql2、pg
- Local storage：sql.js + SQLite 文件
- Scheduler：node-cron
- Export：xlsx
- Notifications：nodemailer、企业微信机器人 Webhook

## 项目结构

```text
.
├── electron/
│   └── main.js              # Electron 主进程，启动本地服务并打开窗口
├── public/
│   └── index.html           # 单页前端界面
├── tests/
│   ├── auth-flow.test.js    # 登录与用户隔离流程测试
│   └── schedule-contract.test.js
├── server.js                # Express API、数据库连接、导出、发送与定时任务逻辑
├── start.bat                # Windows 快捷启动脚本
├── package.json
└── app.sqlite               # 默认本地应用数据文件
```

## 环境要求

- Node.js >= 16.0.0
- npm
- 当前机器可以访问目标 MySQL 或 PostgreSQL 服务。
- 如需邮件发送，需要准备 SMTP 配置。
- 如需企业微信发送，需要准备企业微信群机器人 Webhook。

## 安装

```bash
npm install
```

## 运行

启动桌面应用：

```bash
npm start
```

仅启动本地 Web/后端服务，适合开发调试：

```bash
npm run dev
```

默认服务端口为 `3001`。如果端口被占用，服务会自动尝试后续端口。也可以显式指定起始端口：

```bash
PORT=3005 npm run dev
```

Windows 下也可以运行：

```bat
start.bat
```

## 使用说明

1. 注册或登录本地账号。
2. 填写数据库类型、地址、端口、库名、用户名和密码。
3. 点击“测试”验证连接，点击“连接”保存并进入查询。
4. 在 SQL 编辑区输入查询语句，点击“执行”查看结果。
5. 查询结果可导出为 XLSX，也可通过邮件或企业微信发送。
6. 配置 SMTP 或企业微信机器人后，可创建定时任务自动执行 SQL 并发送结果。

## 配置与数据

默认情况下，应用数据保存在项目根目录的 `app.sqlite`。其中包含用户、已保存数据库连接、SMTP 配置、企业微信机器人配置、定时任务和相关本地应用数据。

可以通过 `APP_DB_PATH` 指定 SQLite 文件路径：

```bash
APP_DB_PATH=/path/to/app.sqlite npm run dev
```

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3001` | 本地 Express 服务起始端口 |
| `APP_DB_PATH` | `./app.sqlite` | 本地 SQLite 数据文件路径 |

安全建议：

- 不要将包含真实账号、数据库密码、SMTP 密码或企业微信 Webhook 的 `app.sqlite` 提交到代码仓库。
- 仅在可信机器上运行本工具，并保护本地数据文件访问权限。
- 团队环境建议为不同用户使用独立账号，不要共享敏感连接配置。

## 定时任务

定时任务使用标准 cron 表达式：

| 表达式 | 含义 |
| --- | --- |
| `0 9 * * *` | 每天 09:00 执行 |
| `0 * * * *` | 每小时执行 |
| `*/30 * * * *` | 每 30 分钟执行 |
| `0 9 * * 1` | 每周一 09:00 执行 |
| `0 9 1 * *` | 每月 1 日 09:00 执行 |

每个定时任务会绑定创建或更新时选择的数据库连接，并根据配置发送到邮件、企业微信或两者。任务支持手动立即执行，也支持查看执行日志。

## 测试

当前项目未在 `package.json` 中配置统一的 `test` script，可直接使用 Node.js 内置测试运行器：

```bash
node --test tests/schedule-contract.test.js
node --test tests/auth-flow.test.js
```

`auth-flow.test.js` 会启动本地服务并使用临时 SQLite 文件验证注册、登录和用户级配置隔离。

## 打包

构建当前平台产物：

```bash
npm run build
```

构建 Windows 产物：

```bash
npm run build:win
```

构建 macOS 产物：

```bash
npm run build:mac
```

构建产物输出到 `dist/` 目录。Windows 配置包含 portable 和 zip，macOS 配置包含 dmg。

## 常见问题

### 应用启动后页面没有打开

确认依赖已安装，并检查 `3001` 及后续端口是否被其他进程或安全软件拦截。Electron 会等待本地服务可用后再打开窗口。

### 数据库连接失败

检查数据库地址、端口、库名、用户名和密码是否正确，并确认数据库服务允许当前机器访问。MySQL 常用端口为 `3306`，PostgreSQL 常用端口为 `5432`。

### 邮件发送失败

检查 SMTP 地址、端口、加密方式、用户名和密码或授权码。部分邮件服务需要使用应用专用密码，并显式开启 SMTP 服务。

### 企业微信发送失败

确认机器人 Webhook 完整有效，并且目标企业微信群允许机器人消息和文件上传。工具会通过 Webhook key 上传 XLSX 文件并发送通知。

## License

MIT
