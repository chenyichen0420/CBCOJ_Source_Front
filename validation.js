/**
 * 参数合法性检验工具模块
 * 对所有涉及数据库操作的参数进行校验
 */

/**
 * 校验整数字段（用于 id、page 等）
 * @param {*} val - 要校验的值
 * @param {Object} options
 * @param {boolean} options.positive - 是否必须为正整数（默认 true）
 * @param {number} options.min - 最小值（默认 1）
 * @returns {string|null} 错误信息或 null
 */
function validateInt(val, options = {}) {
    const { positive = true, min = positive ? 1 : 0 } = options;
    if (val === undefined || val === null || val === '') {
        return '参数不能为空';
    }
    const num = Number(val);
    if (isNaN(num) || !Number.isInteger(num)) {
        return '参数必须为整数';
    }
    if (num < min) {
        return `参数不能小于 ${min}`;
    }
    return null;
}

/**
 * 校验字符串字段
 * @param {*} val - 要校验的值
 * @param {Object} options
 * @param {number} options.maxLen - 最大长度
 * @param {number} options.minLen - 最小长度（默认 1）
 * @param {string} options.pattern - 正则表达式
 * @returns {string|null} 错误信息或 null
 */
function validateString(val, options = {}) {
    const { maxLen, minLen = 1, pattern } = options;
    if (val === undefined || val === null) {
        return '参数不能为空';
    }
    if (typeof val !== 'string') {
        return '参数必须为字符串';
    }
    if (val.length < minLen) {
        return `参数长度不能小于 ${minLen}`;
    }
    if (maxLen !== undefined && val.length > maxLen) {
        return `参数长度不能超过 ${maxLen}`;
    }
    if (pattern && !pattern.test(val)) {
        return '参数格式不正确';
    }
    return null;
}

/**
 * 校验邮箱格式
 * @param {*} val
 * @returns {string|null}
 */
function validateEmail(val) {
    if (val === undefined || val === null || val === '') {
        return '邮箱不能为空';
    }
    if (typeof val !== 'string') {
        return '邮箱必须为字符串';
    }
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(val)) {
        return '邮箱格式不正确';
    }
    if (val.length > 200) {
        return '邮箱长度不能超过 200 个字符';
    }
    return null;
}

/**
 * 校验数组字段
 * @param {*} val
 * @param {Object} options
 * @param {number} options.minLen - 最小长度
 * @param {number} options.maxLen - 最大长度
 * @returns {string|null}
 */
function validateArray(val, options = {}) {
    const { minLen = 1, maxLen } = options;
    if (val === undefined || val === null) {
        return '参数不能为空';
    }
    if (!Array.isArray(val)) {
        return '参数必须为数组';
    }
    if (val.length < minLen) {
        return `数组长度不能小于 ${minLen}`;
    }
    if (maxLen !== undefined && val.length > maxLen) {
        return `数组长度不能超过 ${maxLen}`;
    }
    return null;
}

/**
 * 校验布尔字段
 * @param {*} val
 * @returns {string|null}
 */
function validateBoolean(val) {
    if (val === undefined || val === null) {
        return '参数不能为空';
    }
    if (typeof val === 'boolean') return null;
    if (val === 'true' || val === 'false' || val === 0 || val === 1) return null;
    return '参数必须为布尔值';
}

/**
 * 校验枚举值
 * @param {*} val
 * @param {string[]} allowedValues
 * @returns {string|null}
 */
function validateEnum(val, allowedValues) {
    if (val === undefined || val === null || val === '') {
        return '参数不能为空';
    }
    if (!allowedValues.includes(val)) {
        return `参数值必须是以下之一: ${allowedValues.join(', ')}`;
    }
    return null;
}

/**
 * 检查对象中是否包含所有必需的字段
 * @param {Object} obj
 * @param {string[]} requiredFields
 * @returns {string|null}
 */
function requireFields(obj, requiredFields) {
    if (!obj || typeof obj !== 'object') {
        return '请求体不能为空';
    }
    for (const field of requiredFields) {
        if (obj[field] === undefined || obj[field] === null || obj[field] === '') {
            return `缺少必要字段: ${field}`;
        }
    }
    return null;
}

/**
 * 中间件生成器：校验请求中的整数字段
 * @param {string} source - 参数来源 ('query', 'params', 'body')
 * @param {string} field - 字段名
 * @param {Object} options - validateInt 的选项
 * @returns {Function} express 中间件
 */
function requireInt(source, field, options = {}) {
    return (req, res, next) => {
        const val = req[source] && req[source][field];
        const err = validateInt(val, options);
        if (err) {
            return res.status(400).json({ status: 'N', error: `${field}: ${err}` });
        }
        // 将转换后的整数回写
        if (req[source]) {
            req[source][field] = Number(val);
        }
        next();
    };
}

/**
 * 中间件生成器：校验请求中的字符串字段
 * @param {string} source - 参数来源 ('query', 'params', 'body')
 * @param {string} field - 字段名
 * @param {Object} options - validateString 的选项
 * @returns {Function} express 中间件
 */
function requireString(source, field, options = {}) {
    return (req, res, next) => {
        const val = req[source] && req[source][field];
        const err = validateString(val, options);
        if (err) {
            return res.status(400).json({ status: 'N', error: `${field}: ${err}` });
        }
        next();
    };
}

module.exports = {
    validateInt,
    validateString,
    validateEmail,
    validateArray,
    validateBoolean,
    validateEnum,
    requireFields,
    requireInt,
    requireString
};
