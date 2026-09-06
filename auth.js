const pool = require('./db');

/**
 * 从 Cookie 获取用户信息
 * @param {string} cookie - 用户 cookie
 * @returns {Promise<{ id: number, username: string, role: string } | null>}
 */
async function getUserByCookie(cookie) {
    if (!cookie) return null;

    try {
        const conn = pool.getAccount();
        const data = packParams([cookie]);
        const resp = await conn.send('C', data);

        if (resp.command !== 'Y') {
            return null;
        }

        const parts = parsePack(resp.data);
        if (parts.length < 3) {
            logger.logError('getUserByCookie: Invalid response from middleware', new Error('Expected 3 parts, got ' + parts.length));
            return null;
        }

        const uid = parseInt(parts[0]);
        if (isNaN(uid)) {
            logger.logError('getUserByCookie: Invalid uid in response', new Error('uid: ' + parts[0]));
            return null;
        }

        return {
            id: uid,
            username: parts[1],
            role: parts[2] // "user" | "admin" | "superadmin"
        };
    } catch (err) {
        logger.logError(`getUserByCookie failed: ${err.message}`, err);
        return null;
    }
}

async function getUserPermissions(userId) {
    /*
    DB Interface, waiting for implement

    Input: userId (int)
    Output: { [permissionName: string]: boolean }

    Expected middleware behavior:
    - Get all permissions for a user
    - If user is superadmin: return all permissions as true
    - Otherwise: return the actual permission flags
    - Permission names: can_manage_users, can_manage_problems, can_manage_contests,
      can_manage_disk, can_submit_code, can_create_discussion, can_reply_discussion,
      can_post_message, can_view_others_submissions, can_view_others_messages
    - Return empty object if user not found
    */
}

async function checkPermission(userId, permission) {
    /*
    DB Interface, waiting for implement

    Input: userId (int), permission (string)
    Output: boolean

    Expected middleware behavior:
    - Admin/superadmin: return true (already handled above)
    - Regular user: check if the specific permission flag is set
    - Return true if user has the permission, false otherwise
    - Return false if user or permission record not found
    */
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
    return
        (await checkPermission(user.id, 'can_manage_users')) ||
        (await checkPermission(user.id, 'can_manage_problems')) ||
        (await checkPermission(user.id, 'can_manage_contests')) ||
        (await checkPermission(user.id, 'can_manage_disk'));
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
        if (!hasPerm && user.role !== 'admin') {
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

module.exports = { requireLogin, requireAdmin, requirePermission, optionalAuth, checkPermission, checkAdmin, getUserPermissions, requireSuperAdmin };

/*
## 标注汇总

以下是在 `auth.js` 中标注的数据库通信接口：

| 函数 | 标注位置 | 说明 |
|------|---------|------|
| `getUserByCookie` | 删除，移动至 db.js | Cookie → 用户信息查询 |
| `checkPermission` | 替换 `pool.query` | 用户权限查询 |
| `getUserPermissions` | 替换 `pool.query` | 获取用户所有权限 |
| `checkPermission`（第二个） | 替换 `pool.query` | 权限检查（含角色判断） |

**未标注的中间件函数**（保持不变）：
- `requireLogin` — 仅调用 `getUserByCookie`，逻辑本身无需标注
- `checkAdmin` — 仅调用 `getUserByCookie` 和 `checkPermission`，逻辑本身无需标注
- `requireAdmin` — 仅调用 `checkAdmin`，逻辑本身无需标注
- `requireSuperAdmin` — 仅检查 `req.user.role`，无数据库查询
- `requirePermission` — 仅调用 `getUserByCookie` 和 `checkPermission`，逻辑本身无需标注
- `optionalAuth` — 仅调用 `getUserByCookie`，逻辑本身无需标注
*/