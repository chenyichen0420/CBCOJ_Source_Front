# CBCOJ 中间件迁移 —— 完整改造方案

---

## 一、概述

本文档提供将 LZJOJ 前端（Node.js + Express + EJS + MySQL）改造为对接 **CBCOJ 中间件**（C++ 二进制协议服务）的完整迁移方案，并包含一个 Node.js 适配层。

**核心目标**：保留所有 EJS 渲染和前端逻辑；将全部数据库操作（`pool.query`）替换为对 CBCOJ 中间件的调用。以下独立模块保留在本地：
- 讨论区（`discussions` / `replies`）
- 私信（`messages`）
- 网盘（`disk_files`）
- IP 封禁（`banned_ips`）
- 用户个人主页（`user_profiles`）
- 日志（`log_access`、`log_security`、`log_runtime`）

---

## 二、优先级定义

| 优先级 | 含义 |
|--------|------|
| **P0** | 核心功能，必须工作，否则 OJ 无法使用 |
| **P1** | 重要功能，用户期望但可暂时缺失 |
| **P2** | 锦上添花，可延后实现或保持独立 |

---

## 三、模块改造总览

| 模块 | 源文件 | 改造方式 | 优先级 | 说明 |
|------|--------|---------|--------|------|
| 用户认证与登录 | `routes/user.js` | 对接中间件 | **P0** | 登录/注册/Cookie 验证完全由中间件接管 |
| 评测提交与结果 | `routes/academic.js` | 对接中间件 | **P0** | 提交代码、查询记录由中间件处理 |
| 题目列表与详情 | `app.js` + `routes/academic.js` | 对接中间件 | **P0** | 题库浏览是 OJ 最基础功能 |
| 题目管理（CRUD） | `routes/admin.js` + `routes/user.js` | 对接中间件 | **P1** | 管理员创建/编辑题目 |
| 比赛管理 | `routes/contest.js` + `routes/admin.js` | 对接中间件 | **P1** | 比赛列表、详情、提交、排名 |
| 用户信息与设置 | `routes/user.js` | 对接中间件 | **P1** | 个人资料、签名、公开代码开关 |
| 个人主页 | `routes/profile.js` | **独立保留** | **P1** | Markdown 内容存本地数据库 |
| 讨论区 | `routes/community.js` | **独立保留** | **P2** | 中间件无此功能，独立实现 |
| 私信 | `routes/community.js` | **独立保留** | **P2** | 中间件无此功能，独立实现 |
| 网盘 | `routes/disk.js` | **独立保留** | **P2** | 中间件无此功能，独立实现 |
| 管理员日志 | `routes/admin.js` | **独立保留** | **P2** | 中间件日志不结构化 |
| IP 封禁 | `app.js` 中间件 + `routes/admin.js` | **独立保留** | **P2** | Web 层独立维护 |

---

## 四、模块详细改造清单

### 模块 1：用户认证与登录（P0）

**源文件**：`routes/user.js`

| 接口 | 方法 | 当前实现 | 改造方式 | 中间件命令 |
|------|------|---------|---------|-----------|
| `/login` | GET | SQL 查询 `users` 表 | 对接中间件 | Account Service `L` |
| `/verifycookie` | GET | SQL 查询 `users.cookie` | 对接中间件 | Account Service `V` |
| `/genregtoken` | GET | SQL INSERT `register_tokens` + 发邮件 | 对接中间件 | Account Service `P`（pre-register） |
| `/verifycode` | GET | SQL 查询 + INSERT `users` | 对接中间件 | Account Service `R`（register） |
| `/mypermissions` | GET | SQL 查询 `user_permissions` | 对接中间件 | `accmng` 解析 `flag` 字段 |
| `/getinfoshort` | GET | SQL 查询 `users` | 对接中间件 | `accmng.get_safe` + `ache` |
| `/updinfoshort` | POST | SQL UPDATE `users` | 对接中间件 | Account Service `S` / `1` / `2` |
| `/upload-avatar` | POST | 文件写入 | **保留独立** | 与中间件无关 |
| `/avatar/:username` | GET | 静态文件 / SVG | **保留独立** | 与中间件无关 |

**需要移除的代码**：
- `users` 表相关 SQL（`SELECT ... WHERE username=? AND password=?`）
- `register_tokens` 表 SQL
- `user_permissions` 表 SQL
- 本地密码哈希逻辑

**需要保留的代码**：
- 头像上传/获取逻辑（文件系统）
- Cookie 的 HTTP 传输逻辑（`res.cookie` / `req.cookies`）

**适配层需要实现**：
```javascript
// adapter/account.js
login(username, password)   // → L 命令
verifyCookie(cookie)        // → V 命令
preRegister(email, username, password) // → P 命令
register(token, code)       // → R 命令
getUserInfo(uid)            // → accmng.get_safe + 个人字段
updateUserInfo(uid, fields) // → S / 1 / 2 命令
getPermissions(uid)         // → 解析 flag 位
```

---

### 模块 2：评测提交与结果（P0）

**源文件**：`routes/academic.js`

| 接口 | 方法 | 当前实现 | 改造方式 | 中间件命令 |
|------|------|---------|---------|-----------|
| `/submit` | POST | 保存代码 → 编译 → 写入 `submissions` + `tasks` | 对接中间件 | Judge Service `S` |
| `/record` | GET | SQL JOIN `submissions` + `results` | 对接中间件 | Judge Service `Q` |
| `/recordlist` | GET | SQL JOIN 分页查询 | 对接中间件 | `recmng.query_page` |
| `/getproblem` | GET | SQL 查询 `problems` | 对接中间件 | `promng` |
| `/getproblemlist` | POST | SQL 分页查询 | 对接中间件 | `promng` |

**需要移除的代码**：
- `submissions` 表 SQL（INSERT / SELECT / JOIN）
- `results` 表 SQL
- `tasks` 表 SQL
- 本地编译逻辑（`compileCode` 函数）
- 代码文件保存逻辑（`saveCodeFile` 函数）
- `finalizer` 定时器（聚合评测结果）

**需要保留的代码**：
- 无（整个评测流程完全由中间件接管）

**适配层需要实现**：
```javascript
// adapter/judge.js
submit(pid, uid, cid, language, code)  // → S 命令，返回 rid
getResult(rid, uid)                    // → Q 命令，返回 overview + detail + code
getRecordList(uid, pid, page)          // → recmng.query_page
getProblem(pid)                        // → promng
getProblemList(page)                   // → promng
```

**特别注意**：
- 原项目中的 `compileCode` 函数**必须废弃**，因为 CBCOJ 中间件的评测机在远端完成编译。
- `tasks` 表不再需要，由中间件的 `submng` 队列接管。
- `finalizer` 定时器不再需要，由中间件的 `recmng` 统一管理。

---

### 模块 3：题目列表与详情（P0）

**源文件**：`app.js`（页面路由）

| 路由 | 方法 | 当前实现 | 改造方式 | 数据来源 |
|------|------|---------|---------|---------|
| `/problem/list` | GET | SQL 分页查询 `problems` | 对接中间件 | `promng` |
| `/problem/:pid` | GET | SQL 查询单个 `problems` | 对接中间件 | `promng` |
| `/problem/me` | GET | SQL 按作者筛选 | 对接中间件 | `promng` 按作者过滤 |

**需要移除的代码**：
- `problems` 表 SQL 查询

**需要保留的代码**：
- EJS 模板渲染逻辑（`res.render('problemlist', ...)`）
- 分页参数解析

**适配层需要实现**：
```javascript
// adapter/problem.js
getProblemList(page, perPage, filter)   // 分页获取题目列表
getProblem(pid)                         // 获取单个题目详情
getMyProblems(username, page)           // 获取当前用户创建的题目
```

---

### 模块 4：题目管理（P1）

**源文件**：`routes/admin.js` + `routes/user.js`

| 接口 | 方法 | 当前实现 | 改造方式 | 中间件命令 |
|------|------|---------|---------|-----------|
| `/admin/problem` | POST | SQL INSERT `problems` | 对接中间件 | `promng` 创建题目 |
| `/admin/problem/:id` | PUT | SQL UPDATE `problems` | 对接中间件 | `promng` 更新题目 |
| `/admin/problem/:id` | DELETE | SQL DELETE `problems` | 对接中间件 | `promng` 删除题目 |
| `/admin/problem/:id/upload-data` | POST | ZIP 解压 + SQL UPDATE | 对接中间件 | 多信道文件上传协议 |
| `/admin/problem/:id/upload-checker` | POST | 编译 + SQL UPDATE | 对接中间件 | 多信道文件上传协议 |
| `/admin/problem/:id/select` | PUT | SQL UPDATE `selected` | 对接中间件 | `promng` 更新精选状态 |
| `/problem/edit/:pid` | GET | SQL 查询 + EJS 渲染 | 对接中间件 | `promng` 获取题目数据 |
| `/problem/edit` | POST | SQL UPDATE | 对接中间件 | `promng` 更新题目 |

**需要移除的代码**：
- `problems` 表 CRUD 操作
- 本地 ZIP 解压逻辑（`AdmZip`）
- 本地 Checker 编译逻辑（`execPromise`）

**需要保留的代码**：
- 文件上传的 Multer 配置（作为 HTTP 入口，但最终转发给中间件）
- EJS 编辑页面渲染

**适配层需要实现**：
```javascript
// adapter/problem.js（扩展）
createProblem(data)                     // 创建题目
updateProblem(id, data)                 // 更新题目
deleteProblem(id)                       // 删除题目
uploadProblemData(pid, zipBuffer)       // 多信道上传数据包
uploadChecker(pid, cppBuffer)           // 多信道上传检查器
setProblemSelected(id, selected)        // 设置精选状态
```

---

### 模块 5：比赛管理（P1）

**源文件**：`routes/contest.js` + `routes/admin.js`

| 接口 | 方法 | 当前实现 | 改造方式 | 中间件命令 |
|------|------|---------|---------|-----------|
| `/contests` | GET | SQL 查询 `contests` | 对接中间件 | `conmng` |
| `/contests/:id` | GET | SQL JOIN `contests` + `contest_problems` | 对接中间件 | `conmng` |
| `/contests/:id/rank` | GET | SQL 统计排名 | 对接中间件 | `conmng` 排名接口 |
| `/contests/:id/submit` | POST | 同普通提交 + `contest_id` | 对接中间件 | Judge Service `S`（带 `cid`） |
| `/admin/contests` | GET/POST | SQL 管理比赛 | 对接中间件 | `conmng`（需扩展） |

**需要移除的代码**：
- `contests` 表 SQL
- `contest_problems` 表 SQL
- `contest_submissions` 表 SQL

**适配层需要实现**：
```javascript
// adapter/contest.js
getContestList(page)                    // 获取比赛列表
getContestDetail(id)                    // 获取比赛详情
getContestRank(id)                      // 获取比赛排名
submitToContest(contestId, pid, uid, code, language) // 比赛提交
createContest(data)                     // 创建比赛（管理）
updateContest(id, data)                 // 更新比赛（管理）
deleteContest(id)                       // 删除比赛（管理）
```

---

### 模块 6：用户信息与设置（P1）

**源文件**：`routes/user.js`

| 接口 | 方法 | 当前实现 | 改造方式 | 中间件命令 |
|------|------|---------|---------|-----------|
| `/updinfoshort` | POST | SQL UPDATE `users` | 对接中间件 | Account Service `S` / `1` / `2` |
| `/settings` | GET | EJS 渲染 | 对接中间件 | `accmng` 获取用户数据 |

**需要移除的代码**：
- `users` 表的 UPDATE 操作

**需要保留的代码**：
- EJS 设置页面渲染
- 表单提交的请求解析

---

### 模块 7：个人主页（P1，独立保留）

**源文件**：`routes/profile.js`

| 接口 | 方法 | 当前实现 | 改造方式 |
|------|------|---------|---------|
| `/profile/:username` | GET | SQL 查询 `user_profiles` | **独立保留**（本地 SQLite/MySQL 表） |
| `/profile/edit` | POST | SQL UPSERT `user_profiles` | **独立保留** |

**说明**：中间件无对应功能，个人主页的 Markdown 内容继续使用本地数据库（可复用原有 MySQL 表，或改用 SQLite）。

---

### 模块 8：讨论区（P2，独立保留）

**源文件**：`routes/community.js`

| 接口 | 方法 | 当前实现 | 改造方式 |
|------|------|---------|---------|
| `/getdisclist` | GET | SQL 查询 `discussions` | **独立保留** |
| `/getdisc` | GET | SQL JOIN `discussions` + `replies` | **独立保留** |
| `/newdisc` | POST | SQL INSERT `discussions` | **独立保留** |
| `/postdisc` | POST | SQL INSERT `replies` | **独立保留** |
| `/reply/:id` | DELETE | SQL DELETE `replies` | **独立保留** |
| `/discussion/:id` | DELETE | SQL DELETE `discussions` + `replies` | **独立保留** |

**说明**：使用本地数据库独立存储，与中间件无关。

---

### 模块 9：私信（P2，独立保留）

**源文件**：`routes/community.js`

| 接口 | 方法 | 当前实现 | 改造方式 |
|------|------|---------|---------|
| `/postmsg` | POST | SQL INSERT `messages` | **独立保留** |
| `/getmsg` | GET | SQL 查询 `messages` | **独立保留** |
| `/getmessages` | POST | SQL 查询（管理员） | **独立保留** |
| `/conversations` | GET | SQL 聚合查询 | **独立保留** |
| `/conversation` | GET | SQL 双向查询 | **独立保留** |

**说明**：使用本地数据库独立存储。

---

### 模块 10：网盘（P2，独立保留）

**源文件**：`routes/disk.js`

| 接口 | 方法 | 当前实现 | 改造方式 |
|------|------|---------|---------|
| `/quota` | GET | SQL 查询 `users.disk_quota` | **独立保留** |
| `/files` | GET | SQL 查询 `disk_files` | **独立保留** |
| `/upload` | POST | 文件保存 + SQL INSERT | **独立保留** |
| `/file/:fileId` | DELETE | 文件删除 + SQL DELETE | **独立保留** |
| `/download/:fileId` | GET | 流式返回 | **独立保留** |
| `/admin/files` | GET | SQL JOIN | **独立保留** |
| `/admin/quota/:userId` | PUT | SQL UPDATE | **独立保留** |
| `/admin/file/:fileId` | DELETE | 文件删除 + SQL DELETE | **独立保留** |

**说明**：使用本地文件系统 + 本地数据库独立存储。

---

### 模块 11：管理员日志与封禁（P2，独立保留）

**源文件**：`routes/admin.js`

| 接口 | 方法 | 当前实现 | 改造方式 |
|------|------|---------|---------|
| `/admin/logs` | GET | SQL 查询 `log_*` 表 | **独立保留** |
| `/admin/ban-ip` | POST | SQL INSERT `banned_ips` | **独立保留** |
| `/admin/banned-ips` | GET | SQL 查询 | **独立保留** |
| `/admin/ban-ip/:ip` | DELETE | SQL DELETE | **独立保留** |
| `/admin/clear-ip-logs` | POST | SQL DELETE | **独立保留** |

**说明**：日志和封禁功能是 Web 层的管理功能，与评测核心无关，全部独立保留。

---

## 五、需要移除的组件汇总

| 组件 | 位置 | 原因 |
|------|------|------|
| 所有 `pool.query` 调用 | 全部 `routes/*.js` | 由中间件接管 |
| `compileCode` 函数 | `routes/academic.js` | 评测机远端编译 |
| `saveCodeFile` 函数 | `routes/academic.js` | 代码存储由中间件接管 |
| `finalizer` 定时器 | `app.js` | 结果聚合由中间件接管 |
| `tasks` 表相关逻辑 | 全项目 | 评测队列由 `submng` 接管 |
| `submissions` / `results` 表 | 全项目 | 记录由 `recmng` 接管 |
| `users` 表（认证部分） | 全项目 | 账户由 `accmng` 接管 |
| `problems` 表 | 全项目 | 题目由 `promng` 接管 |
| `contests` / `contest_problems` | 全项目 | 比赛由 `conmng` 接管 |
| `register_tokens` 表 | 全项目 | 注册流程由 `regmng` 接管 |
| `user_permissions` 表 | 全项目 | 权限由 `flag` 位接管 |

---

## 六、保留的独立组件汇总

| 组件 | 存储方式 | 说明 |
|------|---------|------|
| `user_profiles` 表 | 本地 MySQL/SQLite | 个人主页 Markdown |
| `discussions` / `replies` 表 | 本地 MySQL/SQLite | 讨论区 |
| `messages` 表 | 本地 MySQL/SQLite | 私信 |
| `disk_files` 表 + 文件系统 | 本地 MySQL + 文件系统 | 网盘 |
| `banned_ips` 表 | 本地 MySQL/SQLite | IP 封禁 |
| `log_access` / `log_security` / `log_runtime` | 本地 MySQL | 日志 |
| 头像文件 | 本地文件系统 | 头像存储 |

---

## 七、适配层架构

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Express 路由层                              │
│  app.js (页面渲染) + routes/*.js (API)                             │
├─────────────────────────────────────────────────────────────────────┤
│                       适配层 (adapter/)                             │
│  ┌─────────────┬─────────────┬─────────────┬─────────────────────┐│
│  │ account.js  │ judge.js    │ problem.js  │ contest.js          ││
│  │ (用户认证)   │ (评测提交)   │ (题目管理)   │ (比赛管理)          ││
│  └─────────────┴─────────────┴─────────────┴─────────────────────┘│
│                           │                                         │
│  ┌───────────────────────▼───────────────────────────────────────┐│
│  │                    client.js (TCP 协议封装)                    ││
│  │   - 连接管理 (Account / Update / Judge / Hack 四服务)         ││
│  │   - 二进制协议打包/解包                                        ││
│  │   - 请求-响应映射 (seq 管理)                                   ││
│  └───────────────────────────────────────────────────────────────┘│
├─────────────────────────────────────────────────────────────────────┤
│                      CBCOJ 中间件 (C++)                             │
│   Account Server │ Update Server │ Judge Server │ Hack Server      │
└─────────────────────────────────────────────────────────────────────┘

独立模块 (不经过适配层):
┌─────────────────────────────────────────────────────────────────────┐
│  本地 MySQL/SQLite + 文件系统                                       │
│  讨论区 │ 私信 │ 网盘 │ 个人主页 │ 日志 │ IP封禁 │ 头像             │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 八、实施步骤

### 第一阶段：基础架构（P0）

1. **创建适配层骨架**
   - `adapter/client.js` —— TCP 连接管理与协议封装
   - `adapter/account.js` —— 用户认证适配器
   - `adapter/judge.js` —— 评测提交适配器
   - `adapter/problem.js` —— 题目查询适配器

2. **改造用户认证模块**（`routes/user.js`）
   - 登录 → `L` 命令
   - Cookie 验证 → `V` 命令
   - 注册 → `P` + `R` 命令

3. **改造评测提交与查询**（`routes/academic.js`）
   - 提交 → `S` 命令
   - 记录查询 → `Q` 命令
   - 记录列表 → `recmng.query_page`

4. **改造题库浏览**（`app.js` 页面路由）
   - `/problem/list` → `promng`
   - `/problem/:pid` → `promng`

### 第二阶段：核心管理功能（P1）

5. **改造题目管理**（`routes/admin.js` + `routes/user.js`）
   - 创建/编辑/删除题目 → `promng`
   - 数据包上传 → 多信道协议

6. **改造比赛模块**（`routes/contest.js` + `routes/admin.js`）
   - 比赛列表/详情/排名 → `conmng`
   - 比赛提交 → `S` 命令（带 `cid`）

7. **改造用户设置**（`routes/user.js`）
   - 个人信息更新 → `S` / `1` / `2` 命令

### 第三阶段：独立模块保留（P1-P2）

8. **保留个人主页**（`routes/profile.js`）
   - 继续使用本地数据库

9. **保留讨论区**（`routes/community.js`）
   - 继续使用本地数据库

10. **保留私信**（`routes/community.js`）
    - 继续使用本地数据库

11. **保留网盘**（`routes/disk.js`）
    - 继续使用本地文件系统 + 数据库

12. **保留日志与封禁**（`routes/admin.js`）
    - 继续使用本地数据库

### 第四阶段：清理与优化

13. **移除废弃代码**
    - 所有 `pool.query` 调用（除独立模块）
    - `compileCode`、`saveCodeFile` 函数
    - `finalizer` 定时器
    - `tasks` 表相关逻辑

14. **配置统一管理**
    - `config.js` 增加中间件连接配置

---

## 九、风险与注意事项

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| 中间件未提供部分查询接口 | P1/P2 功能受阻 | 独立模块保留在本地 |
| 二进制协议实现复杂 | 开发周期延长 | 充分参考 C++ 代码中的协议定义 |
| 网络延迟增加 | 页面响应变慢 | 增加缓存层（Redis / 内存缓存） |
| 中间件服务不可用 | 整个 OJ 不可用 | 增加健康检查和降级逻辑 |
| 权限模型差异 | 权限判断错误 | 在适配层建立 `flag` ↔ `permission` 映射表 |

---

## 十、文件改动总览

### 新增文件

```
adapter/
├── index.js          # 统一导出
├── client.js         # TCP 协议封装
├── account.js        # 用户认证适配器
├── judge.js          # 评测提交适配器
├── problem.js        # 题目管理适配器
└── contest.js        # 比赛管理适配器
```

### 修改文件

| 文件 | 改动程度 | 说明 |
|------|---------|------|
| `app.js` | 中等 | 页面路由中 `pool.query` → 适配器调用 |
| `routes/user.js` | **大量** | 全部 SQL → 适配器调用 |
| `routes/academic.js` | **大量** | 全部 SQL + 编译 → 适配器调用 |
| `routes/admin.js` | 中等 | 管理接口 → 适配器调用 |
| `routes/contest.js` | 中等 | 全部 SQL → 适配器调用 |
| `routes/profile.js` | **少量** | 保持独立，无需修改 |
| `routes/community.js` | **无** | 完全独立保留 |
| `routes/disk.js` | **无** | 完全独立保留 |
| `config.js` | 少量 | 增加中间件配置 |

### 移除文件（逻辑废弃）

- 无完整文件移除，但 `routes/academic.js` 中的 `compileCode`、`saveCodeFile`、`finalizer` 相关代码被移除

---

## 十一、验收标准

| 功能 | 验收标准 |
|------|---------|
| 用户登录 | 正确用户名密码返回 cookie |
| 用户注册 | 邮箱验证码 → 创建用户成功 |
| 提交代码 | 返回 rid，状态为 `judging` |
| 查询结果 | 返回 overview + detail，源码 base64 正确 |
| 题库列表 | 分页正确，数据完整 |
| 题目详情 | 显示完整题目信息 |
| 创建题目 | 题目出现在列表中 |
| 上传数据 | ZIP 解压成功，数据路径正确 |
| 比赛列表 | 显示已开始的比赛 |
| 比赛提交 | 成功提交，排名更新 |

---

*文档版本: 1.0*
*最后更新: 2026.09.04*