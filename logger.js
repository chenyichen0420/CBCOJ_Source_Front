const fs = require('fs');
const path = require('path');
const os = require('os');

// ---------- 日志目录 ----------
const LOGS_DIR = path.join(__dirname, 'logs');
if (!fs.existsSync(LOGS_DIR)) {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
}

// ---------- 辅助：获取客户端 IP ----------
function getClientIp(req) {
    const ip = req.headers['x-forwarded-for'] ||
               req.headers['x-real-ip'] ||
               req.connection.remoteAddress ||
               req.socket.remoteAddress ||
               req.ip;
    return ip ? ip.replace(/^::ffff:/, '') : 'unknown';
}

// ---------- 缓存管理（每种日志最多 256 条） ----------
const CACHE_SIZE = 256;

// 每条缓存条目结构：{ timestamp, level?, message, ... }
const cache = {
    security: [],
    access: [],
    runtime: [],
};

function addToCache(type, entry) {
    const arr = cache[type];
    if (!arr) return;
    arr.push({ timestamp: new Date().toISOString(), ...entry });
    if (arr.length > CACHE_SIZE) {
        arr.shift();
    }
}

// ---------- 通用写入函数（异步） ----------
function writeLogFile(filename, content) {
    const filePath = path.join(LOGS_DIR, filename);
    fs.appendFile(filePath, content + '\n', (err) => {
        if (err) console.error(`Failed to write log to ${filename}:`, err);
    });
}

function formatLogEntry(entry) {
    // entry 是一个对象，转换为一行文本
    const parts = [];
    for (const [key, val] of Object.entries(entry)) {
        if (val !== undefined && val !== null) {
            parts.push(`${key}=${typeof val === 'string' ? val.replace(/\s+/g, ' ') : String(val)}`);
        }
    }
    return parts.join(' ');
}

// ---------- 日志函数（替换原数据库写入） ----------

/**
 * 安全日志
 */
async function logSecurity(userId, username, ip, action, target = null, details = null) {
    const entry = {
        user_id: userId,
        username: username || 'unknown',
        ip: ip || 'unknown',
        action,
        target: target || '',
        details: details || '',
    };
    const line = `[${new Date().toISOString()}] ${formatLogEntry(entry)}`;
    writeLogFile('security.log', line);
    addToCache('security', entry);
}

/**
 * 访问日志
 */
async function logAccess(userId, username, ip, method, url, statusCode, responseTimeMs, userAgent, referer) {
    const entry = {
        user_id: userId,
        username: username || 'unknown',
        ip: ip || 'unknown',
        method: method || '-',
        url: url || '-',
        status_code: statusCode,
        response_time_ms: responseTimeMs,
        user_agent: (userAgent || '').replace(/\s+/g, ' '),
        referer: referer || '-',
    };
    const line = `[${new Date().toISOString()}] ${formatLogEntry(entry)}`;
    writeLogFile('access.log', line);
    addToCache('access', entry);
}

/**
 * 运行时日志（含统计信息）
 */
async function logRuntime(type, message, stack = null, extraStats = {}) {
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

    const entry = {
        log_type: type,
        message: message || '',
        stack: stack || '',
        cpu_usage: cpuUsage !== null ? cpuUsage.toFixed(2) : null,
        memory_usage_mb: memUsage,
        uptime_seconds: uptime,
    };
    const line = `[${new Date().toISOString()}] ${formatLogEntry(entry)}`;
    writeLogFile('runtime.log', line);
    addToCache('runtime', entry);

    // 如果 type 为 ERROR，也写入 error.log（方便查看）
    if (type === 'ERROR') {
        const errLine = `[${new Date().toISOString()}] ${formatLogEntry(entry)}`;
        writeLogFile('error.log', errLine);
        // 也加入 error 缓存（复用 runtime 缓存即可，或单独？为简单，不单独缓存 error）
    }
}

/**
 * 错误日志（便捷函数）
 */
async function logError(message, err) {
    await logRuntime('ERROR', message, err ? err.stack : null);
}

// ---------- 导出 ----------
module.exports = {
    getClientIp,
    logSecurity,
    logAccess,
    logRuntime,
    logError,
    // 可选：暴露缓存供调试
    getCache: () => cache,
};