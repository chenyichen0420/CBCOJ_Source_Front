// db.js — CBCOJ Middleware Client

const net = require('net');
const crypto = require('crypto');
const config = require('./config');
const logger = require('./logger');

// ---------- 从配置加载 ----------
const CONFIG = {
	HOST: config.middleware.host,
	ACCOUNT_PORT: config.middleware.accountPort,
	HACK_PORT: config.middleware.hackPort,
	JUDGE_PORT: config.middleware.judgePort,
	REQUEST_TIMEOUT: config.middleware.requestTimeout,
	CONNECT_TIMEOUT: config.middleware.connectTimeout,
	MAX_RETRIES: config.middleware.maxRetries,
	RETRY_DELAY: config.middleware.retryDelay,
	SLICE_SIZE: config.middleware.sliceSize,
	HACK_RETRIES: config.middleware.hackRetries,
	SECRET: config.middleware.secret,
	TIME_WINDOW: config.middleware.timeWindow,
	HACK_IDLE_TIMEOUT: config.middleware.hackIdleTimeout,
	HACK_MAX_CHANNELS: config.middleware.hackMaxChannels,
};

// ---------- 私有协议工具 ----------
function packParams(arr) {
	const result = [];
	for (const item of arr) {
		const str = String(item);
		const len = str.length;
		if (len <= 128 && len > 0) {
			result.push(Buffer.from([256 - len]));
		} else {
			const b = Buffer.alloc(3);
			b[0] = (len >> 16) & 0xFF;
			b[1] = (len >> 8) & 0xFF;
			b[2] = len & 0xFF;
			result.push(b);
		}
		result.push(Buffer.from(str, 'utf8'));
	}
	return Buffer.concat(result);
}

function parsePack(data) {
    const result = [];
    let i = 0;
    while (i < data.length) {
        const first = data[i++];
        let len;
        if (first >= 0x80) {
            len = 256 - first;
        } else {
            if (i + 2 >= data.length) break;
            const b1 = data[i++];
            const b2 = data[i++];
            len = (first << 16) | (b1 << 8) | b2;
        }
        if (i + len > data.length) break;
        result.push(data.slice(i, i + len));
        i += len;
    }
    return result;
}

function buildPacket(command, seq, data) {
	const len = data.length;
	const header = Buffer.alloc(5);
	header[0] = command.charCodeAt(0);
	header[1] = seq;
	header[2] = (len >> 16) & 0xFF;
	header[3] = (len >> 8) & 0xFF;
	header[4] = len & 0xFF;
	return Buffer.concat([header, data]);
}

// ---------- Connection 类（通用长连接） ----------
class Connection {
	constructor(port, host, name) {
		this.port = port;
		this.host = host;
		this.name = name;
		this.socket = null;
		this.buffer = Buffer.alloc(0);
		this.pending = new Map();
		this.seqCounter = 0;
		this.isConnecting = false;
		this.isClosed = false;
		this.retryCount = 0;
		this.retryTimer = null;
		this.connected = false;
		this._reconnectPromise = null;
		this._idleTimer = null;
		this._idleTimeout = 0;
	}

	setIdleTimeout(ms) {
		this._idleTimeout = ms;
		this._resetIdleTimer();
	}

	_resetIdleTimer() {
		if (this._idleTimer) {
			clearTimeout(this._idleTimer);
			this._idleTimer = null;
		}
		if (this._idleTimeout > 0 && this.connected) {
			this._idleTimer = setTimeout(() => {
				logger.logRuntime('INFO', `[${this.name}] Idle timeout, closing connection`);
				this.close();
			}, this._idleTimeout);
		}
	}

	_nextSeq() {
		this.seqCounter = (this.seqCounter % 255) + 1;
		return this.seqCounter;
	}

	async connect() {
		if (this.connected && this.socket && !this.socket.destroyed) {
			return;
		}

		if (this.isConnecting) {
			if (this._reconnectPromise) {
				return this._reconnectPromise;
			}
			await new Promise(resolve => setTimeout(resolve, 100));
			return this.connect();
		}

		this.isConnecting = true;
		this.isClosed = false;

		return new Promise((resolve, reject) => {
			const socket = new net.Socket();
			const timeout = setTimeout(() => {
				socket.destroy();
				this.isConnecting = false;
				reject(new Error(`Connect timeout to ${this.name}`));
			}, CONFIG.CONNECT_TIMEOUT);

			socket.connect(this.port, this.host, () => {
				clearTimeout(timeout);
				this.socket = socket;
				this.connected = true;
				this.isConnecting = false;
				this.retryCount = 0;
				this._setupSocketEvents();
				this._resetIdleTimer();
				logger.logRuntime('INFO', `[${this.name}] Connected to ${this.host}:${this.port}`);
				resolve();
			});

			socket.once('error', (err) => {
				clearTimeout(timeout);
				this.isConnecting = false;
				reject(err);
			});
		});
	}

	_setupSocketEvents() {
		if (!this.socket) return;

		this.socket.on('data', (chunk) => {
			this._resetIdleTimer();
			this._handleData(chunk);
		});

		this.socket.on('error', (err) => {
			logger.logError(`[${this.name}] Socket error: ${err.message}`, err);
			this._handleDisconnect();
		});

		this.socket.on('close', () => {
			logger.logRuntime('WARN', `[${this.name}] Socket closed`);
			this._handleDisconnect();
		});
	}

	_handleDisconnect() {
		if (this.isClosed) return;
		this.connected = false;
		this.isConnecting = false;

		for (const [seq, entry] of this.pending) {
			clearTimeout(entry.timer);
			entry.reject(new Error(`Connection to ${this.name} lost`));
		}
		this.pending.clear();

		if (this.socket) {
			this.socket.destroy();
			this.socket = null;
		}

		if (this._idleTimer) {
			clearTimeout(this._idleTimer);
			this._idleTimer = null;
		}

		if (this.retryCount < CONFIG.MAX_RETRIES) {
			const delay = CONFIG.RETRY_DELAY * Math.pow(2, this.retryCount);
			this.retryCount++;
			logger.logRuntime('WARN', `[${this.name}] Reconnecting in ${delay}ms (attempt ${this.retryCount}/${CONFIG.MAX_RETRIES})`);
			clearTimeout(this.retryTimer);
			this.retryTimer = setTimeout(() => {
				this.connect().catch((err) => {
					logger.logError(`[${this.name}] Reconnect failed: ${err.message}`, err);
				});
			}, delay);
		} else {
			logger.logRuntime('ERROR', `[${this.name}] Max retries reached, giving up`);
			this.isClosed = true;
		}
	}

	_handleData(chunk) {
		this.buffer = Buffer.concat([this.buffer, chunk]);

		while (this.buffer.length >= 5) {
			const bodyLen = (this.buffer[2] << 16) | (this.buffer[3] << 8) | this.buffer[4];
			const totalLen = 5 + bodyLen;

			if (this.buffer.length < totalLen) break;

			const packet = this.buffer.slice(0, totalLen);
			this.buffer = this.buffer.slice(totalLen);

			const command = String.fromCharCode(packet[0]);
			const seq = packet[1];
			const data = packet.slice(5, totalLen);

			const entry = this.pending.get(seq);
			if (entry) {
				clearTimeout(entry.timer);
				this.pending.delete(seq);
				entry.resolve({ command, data });
			} else {
				logger.logRuntime('WARN', `[${this.name}] No pending request for seq ${seq}, ignoring`);
			}
		}
	}

	async send(command, data) {
		if (!this.connected || !this.socket || this.socket.destroyed) {
			await this.connect();
		}

		const seq = this._nextSeq();
		const packet = buildPacket(command, seq, data);

		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				if (this.pending.has(seq)) {
					this.pending.delete(seq);
					reject(new Error(`Request timeout (${CONFIG.REQUEST_TIMEOUT}ms) on ${this.name}`));
				}
			}, CONFIG.REQUEST_TIMEOUT);

			this.pending.set(seq, { resolve, reject, timer });

			this.socket.write(packet, (err) => {
				if (err) {
					clearTimeout(timer);
					this.pending.delete(seq);
					reject(err);
				}
			});
		});
	}

	isAvailable() {
		return this.connected && this.socket && !this.socket.destroyed;
	}

	close() {
		this.isClosed = true;
		clearTimeout(this.retryTimer);
		if (this._idleTimer) {
			clearTimeout(this._idleTimer);
			this._idleTimer = null;
		}
		for (const [, entry] of this.pending) {
			clearTimeout(entry.timer);
			entry.reject(new Error(`Connection ${this.name} closed`));
		}
		this.pending.clear();
		if (this.socket) {
			this.socket.destroy();
			this.socket = null;
		}
		this.connected = false;
		this.isConnecting = false;
		logger.logRuntime('INFO', `[${this.name}] Closed`);
	}
}

// ---------- HackConnection（多信道支持，单连接复用） ----------
class HackConnection extends Connection {
	constructor(port, host, name) {
		super(port, host, name);
		this.channelAllocSeq = 255;
		this.activeChannels = new Set();
		this.channelResolvers = new Map();
		this.pendingSubmit = [];
		this._processing = false;
	}

	_handleData(chunk) {
		this.buffer = Buffer.concat([this.buffer, chunk]);

		while (this.buffer.length >= 5) {
			const bodyLen = (this.buffer[2] << 16) | (this.buffer[3] << 8) | this.buffer[4];
			const totalLen = 5 + bodyLen;

			if (this.buffer.length < totalLen) break;

			const packet = this.buffer.slice(0, totalLen);
			this.buffer = this.buffer.slice(totalLen);

			const command = String.fromCharCode(packet[0]);
			const seq = packet[1];
			const data = packet.slice(5, totalLen);

			if (seq === 255) {
				const entry = this.pending.get(255);
				if (entry) {
					clearTimeout(entry.timer);
					this.pending.delete(255);
					entry.resolve({ command, data });
				}
			} else {
				const channel = seq;
				const entry = this.channelResolvers.get(channel);
				if (entry) {
					clearTimeout(entry.timer);
					this.channelResolvers.delete(channel);
					this.activeChannels.delete(channel);
					entry.resolve({ command, data });
				} else {
					logger.logRuntime('WARN', `[${this.name}] No pending resolver for channel ${channel}, ignoring`);
				}
			}
		}
	}

	async allocateChannel() {
		const seq = 255;
		const packet = buildPacket('H', seq, Buffer.alloc(0));

		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				if (this.pending.has(seq)) {
					this.pending.delete(seq);
					reject(new Error('Channel allocation timeout'));
				}
			}, CONFIG.REQUEST_TIMEOUT);

			this.pending.set(seq, { resolve, reject, timer });

			this.socket.write(packet, (err) => {
				if (err) {
					clearTimeout(timer);
					this.pending.delete(seq);
					reject(err);
				}
			});
		}).then((resp) => {
			if (resp.command === 'Y') {
				const parts = parsePack(resp.data);
				if (parts.length > 0) {
					const channel = parseInt(parts[0]);
					if (!isNaN(channel)) {
						this.activeChannels.add(channel);
						return channel;
					}
				}
				throw new Error('Invalid channel allocation response');
			}
			const errMsg = resp.data.toString('utf8') || 'No error message';
			throw new Error(`Channel allocation failed: ${errMsg}`);
		});
	}

	async sendViaChannel(channel, command, data) {
		const packet = buildPacket(command, channel, data);
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				if (this.channelResolvers.has(channel)) {
					this.channelResolvers.delete(channel);
					this.activeChannels.delete(channel);
					reject(new Error(`Channel ${channel} timeout`));
				}
			}, CONFIG.REQUEST_TIMEOUT);

			this.channelResolvers.set(channel, { resolve, reject, timer });

			this.socket.write(packet, (err) => {
				if (err) {
					clearTimeout(timer);
					this.channelResolvers.delete(channel);
					this.activeChannels.delete(channel);
					reject(err);
				}
			});
		});
	}

	releaseChannel(channel) {
		this.activeChannels.delete(channel);
		this.channelResolvers.delete(channel);
		logger.logRuntime('DEBUG', `[${this.name}] Channel ${channel} released`);
	}

	getActiveChannelCount() {
		return this.activeChannels.size;
	}

	async close() {
		if (this.activeChannels.size > 0) {
			logger.logRuntime('INFO', `[${this.name}] Waiting for ${this.activeChannels.size} active channels to complete...`);
			await new Promise(resolve => setTimeout(resolve, 5000));
		}
		super.close();
	}
}

// ---------- ConnectionPool 管理器 ----------
class ConnectionPool {
	constructor() {
		this.accountConn = new Connection(
			CONFIG.ACCOUNT_PORT,
			CONFIG.HOST,
			'Account'
		);
		this.judgeConn = new Connection(
			CONFIG.JUDGE_PORT,
			CONFIG.HOST,
			'Judge'
		);
		this.hackConn = new HackConnection(
			CONFIG.HACK_PORT,
			CONFIG.HOST,
			'Hack'
		);
		this._initialized = false;
	}

	async init() {
		if (this._initialized) return;
		await Promise.all([
			this.accountConn.connect(),
			this.judgeConn.connect(),
			this.hackConn.connect(),
		]);
		this.hackConn.setIdleTimeout(CONFIG.HACK_IDLE_TIMEOUT);
		this._initialized = true;
		logger.logRuntime('INFO', 'Connection pool initialized (including Hack multi-channel)');
	}

	getAccount() { return this.accountConn; }
	getJudge() { return this.judgeConn; }
	getHack() { return this.hackConn; }

	healthCheck() {
		return {
			account: this.accountConn.isAvailable(),
			judge: this.judgeConn.isAvailable(),
			hack: this.hackConn.isAvailable(),
			hackChannels: this.hackConn.getActiveChannelCount(),
		};
	}

	close() {
		this.accountConn.close();
		this.judgeConn.close();
		this.hackConn.close();
		this._initialized = false;
		logger.logRuntime('INFO', 'Connection pool closed');
	}
}

// ---------- 单例连接池 ----------
const pool = new ConnectionPool();

/**
 * 提交 Hack 评测（使用多信道连接池）
 */
async function submitHack({ code, input, output, setv, tl, ml, token, cookie }) {
	if (!code || !input || !output || !setv || tl === undefined || ml === undefined || !token || !cookie) {
		throw new Error('Missing required fields');
	}

	const valid = await verifyCookie(cookie);
	if (!valid) {
		throw new Error('Invalid or expired cookie');
	}

	const tlNum = parseInt(tl);
	const mlNum = parseInt(ml);
	if (isNaN(tlNum) || isNaN(mlNum)) {
		throw new Error('Invalid time/memory limit');
	}
	if (tlNum > 10000 || mlNum > 1024) {
		throw new Error('Time/memory limit exceeds maximum');
	}

	const inputBuf = Buffer.from(input, 'base64');
	const outputBuf = Buffer.from(output, 'base64');
	const codeStr = Buffer.from(code, 'base64').toString('utf8');

	if (!codeStr || codeStr.length === 0) {
		throw new Error('Code is empty after decoding');
	}

	const hackConn = pool.getHack();
	let channel = null;

	try {
		if (!hackConn.isAvailable()) {
			await hackConn.connect();
		}

		channel = await hackConn.allocateChannel();
		logger.logRuntime('DEBUG', `Hack channel ${channel} allocated`);

		const SLICE_SIZE = CONFIG.SLICE_SIZE;
		const pack1 = Math.ceil(inputBuf.length / SLICE_SIZE);
		const pack2 = Math.ceil(outputBuf.length / SLICE_SIZE);

		const meta = packParams([
			codeStr,
			String(pack1),
			String(pack2),
			setv,
			String(tlNum),
			String(mlNum),
			'fc'
		]);

		let resp = await hackConn.sendViaChannel(channel, 'H', meta);
		if (resp.command !== 'Y') {
			const errMsg = resp.data.toString('utf8') || 'No error message';
			throw new Error(`Metadata send failed: ${errMsg}`);
		}

		for (let offset = 0; offset < inputBuf.length; offset += SLICE_SIZE) {
			const chunk = inputBuf.slice(offset, offset + SLICE_SIZE);
			await hackConn.sendViaChannel(channel, 'I', chunk);
		}

		for (let offset = 0; offset < outputBuf.length; offset += SLICE_SIZE) {
			const chunk = outputBuf.slice(offset, offset + SLICE_SIZE);
			await hackConn.sendViaChannel(channel, 'O', chunk);
		}

		resp = await hackConn.sendViaChannel(channel, '', Buffer.alloc(0));
		if (resp.command !== 'Y') {
			const errMsg = resp.data.toString('utf8') || 'No error message';
			throw new Error(`Hack submission failed: ${errMsg}`);
		}

		const parts = parsePack(resp.data);
		if (parts.length > 0) {
			const hid = parseInt(parts[0]);
			if (!isNaN(hid)) {
				return hid;
			}
		}

		const str = resp.data.toString();
		const match = str.match(/\d+/);
		if (match) {
			const hid = parseInt(match[0]);
			if (!isNaN(hid)) {
				return hid;
			}
		}

		throw new Error('Missing hid in response');

	} catch (err) {
		if (channel !== null) {
			hackConn.releaseChannel(channel);
		}
		logger.logError(`Hack submission failed: ${err.message}`, err);
		throw err;
	}
}

/**
 * 查询 Hack 结果
 */
async function queryResult(hid) {
	if (isNaN(hid) || hid < 0) {
		throw new Error('Invalid hid');
	}

	try {
		const conn = pool.getJudge();
		const data = packParams([String(hid)]);
		const resp = await conn.send('H', data);

		if (resp.command === 'Y') {
			const parts = parsePack(resp.data);
			if (parts.length >= 1) {
				return parts[0];
			}
			throw new Error('Invalid result response');
		} else if (resp.command === 'N') {
			const parts = parsePack(resp.data);
			if (parts.length > 0 && parts[0].includes('Not finished')) {
				return null;
			}
			throw new Error(`Query failed: ${parts[0] || 'unknown'}`);
		} else {
			throw new Error(`Unexpected response: ${resp.command}`);
		}
	} catch (err) {
		logger.logError(`Query result failed for hid ${hid}: ${err.message}`, err);
		throw err;
	}
}

/**
 * 获取统计信息
 */
async function getStatistics() {
	try {
		logger.logRuntime('WARN', 'getStatistics: statistics API not implemented, returning default values');
		return {
			problems: 0,
			users: 0,
			submissions: 0,
			contests: 0,
		};
	} catch (err) {
		logger.logError(`Get statistics failed: ${err.message}`, err);
		return { problems: 0, users: 0, submissions: 0, contests: 0 };
	}
}

module.exports = {
	// 连接池管理
	init: () => pool.init(),
	close: () => pool.close(),
	healthCheck: () => pool.healthCheck(),

	// 获取各服务连接（供业务模块使用）
	getAccount: () => pool.getAccount(),
	getJudge: () => pool.getJudge(),
	getHack: () => pool.getHack(),

	// 底层协议工具（供业务模块使用）
	packParams,
	parsePack,
	buildPacket,

	// Hack 连接池特殊方法
	getHackConn: () => pool.getHack(),

	// 内部暴露（调试用）
	_pool: pool
};