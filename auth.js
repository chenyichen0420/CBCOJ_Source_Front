const { permission } = require('node:process');
const pool = require('./db');
const { packParams, parsePack } = require('./db');
const logger = require('./logger');

const FLAG_SIZE = 6;
const POS_ADMIN1 = 0;
const POS_ADMIN2 = 1;
const POS_LOCK1 = 2;
const POS_LOCK2 = 3;
const POS_STATUS1 = 4;
const POS_STATUS2 = 5;

/**
 * 从中间件获取用户的安全标志位（flag 数组）
 * @param {number} uid - 用户 ID
 * @returns {Promise<{ admin1: number, admin2: number, lock1: number, lock2: number, status1: number, status2: number } | null>}
 *          解析后的 flag 对象，若查询失败或用户不存在则返回 null
 */
async function getUserFlags(uid) {
    try {
        const conn = pool.getAccount();
        const data = packParams(['uid', String(uid), 'flag']);
        const resp = await conn.send('U', data);
        if (resp.command !== 'Y') return null;
        const parts = parsePack(resp.data); // parts 现在是 Buffer[]
        if (parts.length < 1) return null;
        const flagBuf = parts[0]; // 直接是 Buffer，无需再转码
        if (flagBuf.length !== FLAG_SIZE) return null;
        return {
            admin1: flagBuf[POS_ADMIN1] || 0,
            admin2: flagBuf[POS_ADMIN2] || 0,
            lock1: flagBuf[POS_LOCK1] || 0,
            lock2: flagBuf[POS_LOCK2] || 0,
            status1: flagBuf[POS_STATUS1] || 0,
            status2: flagBuf[POS_STATUS2] || 0,
        };
    } catch (err) {
        logger.logError(`getUserFlags failed for uid ${uid}: ${err.message}`, err);
        return null;
    }
}

/**
 * 从 Cookie 获取用户信息（通过中间件 U 指令）
 * @param {string} cookie - 用户 cookie
 * @returns {Promise<{ id: number, username: string, role: string } | null>}
 */
async function getUserByCookie(cookie) {
    if (!cookie) return null;
    try {
        const conn = pool.getAccount();
        const data = packParams(['cookie', cookie, 'uid', 'username', 'role']);
        const resp = await conn.send('U', data);
        if (resp.command !== 'Y') return null;
        const parts = parsePack(resp.data);
        if (parts.length < 3) {
            logger.logError('getUserByCookie: Invalid response', new Error('Expected 3 parts'));
            return null;
        }
        const uid = parseInt(parts[0].toString('utf8'));
        if (isNaN(uid)) {
            logger.logError('getUserByCookie: Invalid uid', new Error('uid: ' + parts[0]));
            return null;
        }
        return {
            id: uid,
            username: parts[1].toString('utf8'),
            role: parts[2].toString('utf8') // "user" | "admin" | "superadmin"
        };
    } catch (err) {
        logger.logError(`getUserByCookie failed: ${err.message}`, err);
        return null;
    }
}

/**
 * 获取用户所有权限（映射自中间件 flag 位）
 * @param {number} userId - 用户 ID
 * @returns {Promise<{
 *   can_manage_users: boolean,
 *   can_manage_problems: boolean,
 *   can_manage_contests: boolean,
 *   can_manage_disk: boolean,
 *   can_manage_chat: boolean,
 *   can_submit_code: boolean,
 *   can_create_discussion: boolean,
 *   can_reply_discussion: boolean,
 *   can_post_message: boolean,
 *   can_view_others_submissions: boolean
 * }>}
 */
async function getUserPermissions(userId) {
    const flags = await getUserFlags(userId);
    if (!flags) {
        // 用户不存在或查询失败，返回全 false
        return {
            can_manage_users: false,
            can_manage_problems: false,
            can_manage_contests: false,
            can_manage_disk: false,
            can_manage_chat: false,
            can_submit_code: false,
            can_create_discussion: false,
            can_reply_discussion: false,
            can_post_message: false,
            can_view_others_submissions: false,
        };
    }

    const { admin1, lock1 } = flags;

    // 超级管理员（ADMIN_SADMIN = 0x01）
    if (admin1 & 0x01) {
        return {
            can_manage_users: true,
            can_manage_problems: true,
            can_manage_contests: true,
            can_manage_disk: true,
            can_manage_chat: true,
            can_submit_code: true,
            can_create_discussion: true,
            can_reply_discussion: true,
            can_post_message: true,
            can_view_others_submissions: true,
        };
    }

    return {
        can_manage_users: !!(admin1 & 0x02),      // ADMIN_USER
        can_manage_problems: !!(admin1 & 0x04),   // ADMIN_PROBLEM
        can_manage_contests: !!(admin1 & 0x08),   // ADMIN_CONTEST
        can_manage_disk: !!(admin1 & 0x20),       // ADMIN_FILE
        can_manage_chat: !!(admin1 & 0x10),       // ADMIN_CHAT
        can_submit_code: !(lock1 & 0x02),         // LOCK_NO_SUBMIT
        can_create_discussion: !(lock1 & 0x04),   // LOCK_NO_DISCUSSION
        can_reply_discussion: !(lock1 & 0x04),    // same
        can_post_message: !(lock1 & 0x08),        // LOCK_NO_CHAT
        can_view_others_submissions: !(lock1 & 0x10), // LOCK_NO_VIEW_RECORD
    };
}

/**
 * 检查用户是否拥有指定权限
 * @param {number} userId - 用户 ID
 * @param {string} permission - 权限名称（如 'can_manage_users'）
 * @returns {Promise<boolean>} 是否拥有该权限
 */
async function checkPermission(userId, permission) {
    const flags = await getUserFlags(userId);
    if (!flags) return false;

    const { admin1, lock1 } = flags;

    // 超级管理员拥有所有权限
    if (admin1 & 0x01) return true;

    switch (permission) {
        case 'can_manage_users':    return !!(admin1 & 0x02);
        case 'can_manage_problems': return !!(admin1 & 0x04);
        case 'can_manage_contests': return !!(admin1 & 0x08);
        case 'can_manage_disk':     return !!(admin1 & 0x20);
        case 'can_manage_chat':     return !!(admin1 & 0x10);
        case 'can_submit_code':     return !(lock1 & 0x02);
        case 'can_create_discussion': return !(lock1 & 0x04);
        case 'can_reply_discussion':  return !(lock1 & 0x04);
        case 'can_post_message':    return !(lock1 & 0x08);
        case 'can_view_others_submissions': return !(lock1 & 0x10);
        default:
            logger.logError(`checkPermission: unknown permission '${permission}'`, new Error('Unknown permission'));
            return false;
    }
}

async function requireLogin(req, res, next) {
    let cookie = (req.body && req.body.cookie) || (req.query && req.query.cookie);
    if (req.headers.cookie && !cookie) {
        const match = req.headers.cookie.match(/(?:^|;\s*)user_cookie=([^;]*)/);
        if (match) {
            cookie = decodeURIComponent(match[1]);
        }
    }
    const user = await getUserByCookie(cookie);
    if (!user) return res.status(401).json({ status: 'N', error: '请先登录' });
    req.user = user;
    next();
}

async function checkAdmin(req) {
    let cookie = (req.body && req.body.cookie) || (req.query && req.query.cookie);
    if (req.headers.cookie && !cookie) {
        const match = req.headers.cookie.match(/(?:^|;\s*)user_cookie=([^;]*)/);
        if (match) {
            cookie = decodeURIComponent(match[1]);
        }
    }
    if (!cookie) return false;
    const user = await getUserByCookie(cookie);
    if (!user) return false;
    if (user.role === 'admin' || user.role === 'superadmin') return true;
    return (
        (await checkPermission(user.id, 'can_manage_users')) ||
        (await checkPermission(user.id, 'can_manage_problems')) ||
        (await checkPermission(user.id, 'can_manage_contests')) ||
        (await checkPermission(user.id, 'can_manage_disk')));
}

async function requireAdmin(req, res, next) {
    if (!(await checkAdmin(req)))
        return res.status(403).json({ status: 'N', error: '权限不足' });
    next();
}

// Middleware: only allow superadmin
function requireSuperAdmin(req, res, next) {
    const user = req.user;
    if (!user || user.role !== 'superadmin')
        return res.status(403).json({ status: 'N', error: '权限不足' });
    next();
}

function requirePermission(permission) {
    return async (req, res, next) => {
        var cookie = (req.body && req.body.cookie) || (req.query && req.query.cookie);
        if (req.headers.cookie && !cookie) {
            const match = req.headers.cookie.match(/(?:^|;\s*)user_cookie=([^;]*)/);
            if (match) {
                cookie = decodeURIComponent(match[1]);
            }
        }
        const user = await getUserByCookie(cookie);
        if (!user) {
            return res.status(401).json({ status: 'N', error: '请先登录' });
        }
        const hasPerm = await checkPermission(user.id, permission);
        if (!hasPerm) {
            return res.status(403).json({ status: 'N', error: '权限不足' });
        }
        req.user = user;
        next();
    };
}

async function optionalAuth(req, res, next) {
    const cookie = (req.body && req.body.cookie) || (req.query && req.query.cookie);
    if (cookie) {
        const user = await getUserByCookie(cookie);
        if (user) req.user = user;
    }
    next();
}

module.exports = {
    requireLogin,
    requireAdmin,
    requirePermission,
    optionalAuth,
    checkPermission,
    checkAdmin,
    getUserPermissions,
    requireSuperAdmin,
    getUserByCookie
};