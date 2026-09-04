const pool = require('./db');
const os = require('os');

function getClientIp(req) {
    const ip = req.headers['x-forwarded-for'] ||
               req.headers['x-real-ip'] ||
               req.connection.remoteAddress ||
               req.socket.remoteAddress ||
               req.ip;
    return ip ? ip.replace(/^::ffff:/, '') : 'unknown';
}

/*
Function: logSecurity
Status: TO BE REMOVED (replaced by local file logging)

This function is no longer needed. Security logs will be written to local files.
No database operations should be performed for logging.
*/
async function logSecurity(userId, username, ip, action, target = null, details = null) {
    try {
        /*
        DB Interface, TO BE REMOVED

        This function currently writes to log_security table.
        Replace with local file logging (e.g., using fs.appendFile to a security.log file).
        */
        await pool.query(
            `INSERT INTO log_security (user_id, username, ip_address, action, target, details)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [userId, username, ip, action, target, details]
        );
    } catch (err) {
        console.error('Failed to log security:', err);
    }
}

/*
Function: logAccess
Status: TO BE REMOVED (replaced by local file logging)

This function is no longer needed. Access logs will be written to local files.
No database operations should be performed for logging.
*/
async function logAccess(userId, username, ip, method, url, statusCode, responseTimeMs, userAgent, referer) {
    try {
        /*
        DB Interface, TO BE REMOVED

        This function currently writes to log_access table.
        Replace with local file logging (e.g., using fs.appendFile to an access.log file).
        */
        await pool.query(
            `INSERT INTO log_access (user_id, username, ip_address, method, url, status_code, response_time_ms, user_agent, referer)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [userId, username, ip, method, url, statusCode, responseTimeMs, userAgent, referer]
        );
    } catch (err) {
        console.error('Failed to log access:', err);
    }
}

/*
Function: logRuntime
Status: TO BE REMOVED (replaced by local file logging)

This function is no longer needed. Runtime logs will be written to local files.
No database operations should be performed for logging.
*/
async function logRuntime(type, message, stack = null, extraStats = {}) {
    try {
        let cpuUsage = extraStats.cpuUsage || null;
        let memUsage = extraStats.memoryUsageMb || null;
        let uptime = extraStats.uptimeSec || null;

        if (type === 'STATS' && (cpuUsage === null || memUsage === null)) {
            const cpus = os.cpus();
            const totalMem = os.totalmem();
            const freeMem = os.freemem();
            const loadAvg = os.loadavg()[0];
            cpuUsage = (loadAvg / cpus.length) * 100;
            memUsage = Math.round((totalMem - freeMem) / 1024 / 1024);
            uptime = Math.floor(process.uptime());
        }

        /*
        DB Interface, TO BE REMOVED

        This function currently writes to log_runtime table.
        Replace with local file logging (e.g., using fs.appendFile to a runtime.log file).
        Statistics (cpuUsage, memUsage, uptime) can still be collected but written to file.
        */
        await pool.query(
            `INSERT INTO log_runtime (log_type, message, stack, cpu_usage, memory_usage_mb, uptime_seconds)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [type, message, stack, cpuUsage, memUsage, uptime]
        );
    } catch (err) {
        console.error('Failed to log runtime:', err);
    }
}

/*
PS：此后日志本地记录，不入数据库，均摊压力

## 标注说明

所有日志函数需要从**数据库写入**改为**本地文件写入**：

```javascript
// 替换前
await pool.query('INSERT INTO log_security ...', [...]);

// 替换后
const fs = require('fs');
fs.appendFileSync(
    path.join(__dirname, 'logs', 'security.log'),
    `[${new Date().toISOString()}] user_id=${userId} username=${username} ip=${ip} action=${action} target=${target} details=${details}\n`
);
```

这样做的好处：
1. 减少数据库压力（日志量大）
2. 与中间件解耦（中间件无日志查询接口）
3. 日志文件可轮转（logrotate）或归档

需要保留的目录结构：
```
logs/
├── access.log     # 访问日志
├── security.log   # 安全日志
├── runtime.log    # 运行时日志
└── error.log      # 错误日志
```
*/