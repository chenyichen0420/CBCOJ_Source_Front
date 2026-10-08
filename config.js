// config.js
const fs = require('fs');
const path = require('path');

// 默认配置（硬编码默认值）
const DEFAULT_CONFIG = {
    middleware: {
        host: '127.0.0.1',
        accountPort: 8640,
        judgePort: 8641,
        updatePort: 8642,
        hackPort: 8643,
        appPort: 8630,
        requestTimeout: 3000,
        connectTimeout: 2000,
        maxRetries: 3,
        retryDelay: 500,
        sliceSize: 1048576,
        hackRetries: 3,
        timeWindow: 300,
        hackIdleTimeout: 1000,
        hackMaxChannels: 64,
    },
    upload: {
        tempDir: '/tmp/cbcoj_upload_temp',
        maxZipSizeBytes: 50 * 1024 * 1024,
        maxExpandedSizeBytes: 256 * 1024 * 1024,
        maxEntrySizeBytes: 64 * 1024 * 1024,
        maxEntryCount: 2000,
    },
    logging: {
        level: 'info',
    },
};

// 配置文件路径（可环境变量覆盖）
const CONFIG_PATH = process.env.CBCOJ_CONFIG || path.join(__dirname, 'config.json');

// 加载配置文件
function loadConfig() {
    let userConfig = {};
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
            userConfig = JSON.parse(raw);
        } else {
            console.warn(`[config] Config file not found at ${CONFIG_PATH}, using defaults.`);
        }
    } catch (err) {
        console.error(`[config] Failed to load config from ${CONFIG_PATH}:`, err.message);
        process.exit(1);
    }

    // 深度合并（简单实现）
    function deepMerge(target, source) {
        for (const key in source) {
            if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
                target[key] = deepMerge(target[key] || {}, source[key]);
            } else {
                target[key] = source[key];
            }
        }
        return target;
    }

    const config = deepMerge(JSON.parse(JSON.stringify(DEFAULT_CONFIG)), userConfig);

    console.log('Final config: ' + JSON.stringify(config, null, 2))

    // 环境变量覆盖（可选）
    // if (process.env.CBCOJ_HOST) config.middleware.host = process.env.CBCOJ_HOST;
    // if (process.env.CBCOJ_ACCOUNT_PORT) config.middleware.accountPort = parseInt(process.env.CBCOJ_ACCOUNT_PORT);
    // if (process.env.CBCOJ_HACK_PORT) config.middleware.hackPort = parseInt(process.env.CBCOJ_HACK_PORT);
    // if (process.env.CBCOJ_JUDGE_PORT) config.middleware.judgePort = parseInt(process.env.CBCOJ_JUDGE_PORT);

    return config;
}

module.exports = loadConfig();