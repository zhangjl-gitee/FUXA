'use strict';
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const utils = require('../../utils');
const deviceUtils = require('../device-utils');
const fs = require('fs');
const path = require('path');

// 确保Python桥接脚本存在
const bridgeScriptPath = path.join(__dirname, 'plc_bridge.py');
if (!fs.existsSync(bridgeScriptPath)) {
    throw new Error(`未找到PLC桥接脚本，请确保${bridgeScriptPath}存在`);
}

function EthernetIPDriver(_data, _logger, _events, _runtime) {
    // 核心变量
    let runtime = _runtime;
    let data = JSON.parse(JSON.stringify(_data));
    let logger = _logger;
    let events = _events;
    let lastStatus = '';
    let working = false;
    let connected = false;
    let tagMap = new Map();
    let varsValue = {};
    let lastTimestampValue;
    // 从配置获取Python路径，默认使用python命令
    let pythonPath = data.property?.pythonPath || 'python';
    // 配置参数（支持从设备属性读取）
    const PLC_IP = data.property?.address;
    const TIMEOUT = data.property?.timeout || 15000;
    const MAX_RETRIES = data.property?.maxRetries || 3;
    // 测试标签优先从配置获取，默认使用通用标签
    const TEST_TAG = data.property?.testTag || "Program:MainProgram.TestTag";

    // 检测Python环境
    const _checkPython = async () => {
        try {
            // 执行版本命令验证Python环境
            await execAsync(`"${pythonPath}" --version`);
            logger.info(`已找到Python环境: ${pythonPath}`);
            return true;
        } catch (err) {
            // 自动尝试python3作为备选
            logger.warn(`Python路径"${pythonPath}"不可用，尝试python3`);
            pythonPath = 'python3';
            try {
                await execAsync(`${pythonPath} --version`);
                logger.info(`已找到Python环境: ${pythonPath}`);
                return true;
            } catch (err) {
                logger.error("未找到可用的Python环境，请检查配置");
                return false;
            }
        }
    };

    // 执行Python脚本的通用方法（增强错误处理）
    const _runPythonCommand = async (command, tagName, value = '') => {
        try {
            // 构建命令（处理路径中的空格和特殊字符）
            const escapedTagName = tagName.replace(/"/g, '\\"');
            const escapedValue = value.toString().replace(/"/g, '\\"');
            const cmd = `"${pythonPath}" "${bridgeScriptPath}" "${command}" "${PLC_IP}" "${escapedTagName}" "${escapedValue}"`;
            logger.debug(`执行Python命令: ${cmd}`);

            // 执行并设置超时
            const { stdout, stderr } = await Promise.race([
                execAsync(cmd),
                new Promise((_, reject) =>
                    setTimeout(() => reject(new Error(`Python命令超时（${TIMEOUT/1000}秒）`)), TIMEOUT)
                )
            ]);

            // 处理标准错误输出
            if (stderr && stderr.trim() !== '') {
                logger.warn(`Python脚本警告: ${stderr.trim()}`);
            }

            // 解析JSON结果
            try {
                return JSON.parse(stdout);
            } catch (parseErr) {
                logger.error(`解析Python输出失败: ${parseErr.message}，原始输出: ${stdout}`);
                return { error: `解析响应失败: ${stdout.substring(0, 100)}` };
            }
        } catch (err) {
            const errorMsg = err.message.includes('timed out')
                ? `命令超时（${TIMEOUT/1000}秒）`
                : err.message;
            logger.error(`Python命令执行失败: ${errorMsg}`);
            return { error: errorMsg };
        }
    };

    // 公共方法
    this.init = function (_type) {
        logger.info(`'${data.name}' 初始化Python桥接ENIP驱动`);
    };

    this.connect = async function () {
        return new Promise(async (resolve, reject) => {
            if (working) {
                return reject(new Error("设备正忙，请稍后再试"));
            }
            if (!PLC_IP) {
                return reject(new Error("缺少PLC IP地址配置"));
            }

            working = true;
            try {
                // 检查Python环境
                if (!await _checkPython()) {
                    return reject(new Error("Python环境检测失败"));
                }

                // 测试连接（读取测试标签）
                logger.info(`测试连接到 ${PLC_IP}，读取测试标签: ${TEST_TAG}`);

                // 带重试的连接测试
                let lastError;
                for (let i = 0; i < MAX_RETRIES; i++) {
                    const result = await _runPythonCommand('read', TEST_TAG);
                    if (!result.error) {
                        logger.info(`测试标签读取成功: ${TEST_TAG}=${result.value}`);
                        lastError = null;
                        break;
                    }
                    lastError = result.error;
                    logger.warn(`连接测试尝试 ${i+1}/${MAX_RETRIES} 失败: ${lastError}`);
                    if (i < MAX_RETRIES - 1) {
                        await new Promise(res => setTimeout(res, 1000 * (i+1))); // 指数退避等待
                    }
                }

                if (lastError) {
                    return reject(new Error(`连接测试失败: ${lastError}`));
                }

                // 连接成功
                connected = true;
                _emitStatus('connect-ok');
                await _loadTagsToPLC();
                resolve();
            } catch (err) {
                connected = false;
                _emitStatus('connect-error');
                reject(err);
            } finally {
                working = false;
            }
        });
    };

    this.disconnect = function () {
        return new Promise(resolve => {
            if (connected) {
                logger.info(`断开与${PLC_IP}的连接`);
                connected = false;
                _clearVarsValue();
                _emitStatus('connect-off');
            }
            resolve();
        });
    };

    this.polling = async function () {
        if (!connected || working) return;

        working = true;
        try {
            // 批量读取标签（添加并发控制）
            const tagEntries = Array.from(tagMap.entries());
            const batchSize = 5; // 每次并发读取5个标签，避免请求过多
            for (let i = 0; i < tagEntries.length; i += batchSize) {
                const batch = tagEntries.slice(i, i + batchSize);
                await Promise.all(batch.map(async ([tagId, { plcTag }]) => {
                    try {
                        const result = await _runPythonCommand('read', plcTag.name);
                        if (result.value !== undefined) {
                            plcTag.value = result.value;
                            logger.debug(`读取标签 ${plcTag.name}=${result.value}`);
                        } else if (result.error) {
                            logger.error(`读取标签${plcTag.name}失败: ${result.error}`);
                        }
                    } catch (err) {
                        logger.error(`读取标签${plcTag.name}出错: ${err.message}`);
                    }
                }));
            }

            // 更新变量值
            const changed = await _updateVarsValue();
            lastTimestampValue = Date.now();
            _emitValues(varsValue);

            if (this.addDaq && !utils.isEmptyObject(changed)) {
                this.addDaq(changed, data.name, data.id);
            }
        } catch (err) {
            logger.error(`轮询错误: ${err.message}`);
        } finally {
            working = false;
        }
    };

    this.load = function (_data) {
        data = JSON.parse(JSON.stringify(_data));
        tagMap.clear();
        varsValue = {};

        try {
            data.tags = data.tags || {};
            const tagList = Object.values(data.tags);
            logger.info(`加载标签（共${tagList.length}个）`);

            tagList.forEach((tag, index) => {
                const address = tag.address.trim();
                if (!address) {
                    logger.error(`标签${index}地址无效（空值）`);
                    return;
                }
                tagMap.set(tag.id, {
                    fuxaTag: tag,
                    plcTag: { name: address, type: (tag.type || 'INT').toUpperCase() }
                });
                logger.info(`标签${index}加载成功: ${address}（类型: ${(tag.type || 'INT').toUpperCase()}）`);
            });
        } catch (err) {
            logger.error(`标签加载错误: ${err.message}`);
        }
    };

    this.setValue = async function (tagId, value) {
        if (!connected || !tagMap.has(tagId)) {
            logger.warn(`写入失败: ${!connected ? '未连接' : `标签不存在（ID: ${tagId}）`}`);
            return false;
        }

        try {
            const { fuxaTag, plcTag } = tagMap.get(tagId);
            const valueToSend = await deviceUtils.tagRawCalculator(value, fuxaTag, runtime);

            // 写入带重试
            let result;
            for (let i = 0; i < MAX_RETRIES; i++) {
                result = await _runPythonCommand('write', plcTag.name, valueToSend);
                if (!result.error) break;
                logger.warn(`写入尝试 ${i+1}/${MAX_RETRIES} 失败: ${result.error}`);
                if (i < MAX_RETRIES - 1) await new Promise(res => setTimeout(res, 1000));
            }

            if (result.error) {
                logger.error(`写入失败: ${result.error}`);
                return false;
            }

            plcTag.value = valueToSend;
            varsValue[tagId] = {
                value: valueToSend,
                timestamp: Date.now(),
                changed: true
            };
            logger.info(`写入成功: ${fuxaTag.name}=${valueToSend}`);
            return true;
        } catch (err) {
            logger.error(`写入标签${tagId}失败: ${err.message}`);
            varsValue[tagId]

            return false;
        }
    };

    // 框架接口方法
    this.getValues = () => varsValue;
    this.getValue = (id) => varsValue[id] ? { id, value: varsValue[id].value, ts: lastTimestampValue } : null;
    this.getStatus = () => lastStatus;
    this.getTagProperty = (tagid) => data.tags[tagid] ? {
        id: tagid,
        name: data.tags[tagid].name,
        type: data.tags[tagid].type
    } : null;
    this.isConnected = () => connected;
    this.bindAddDaq = (fnc) => this.addDaq = fnc;
    this.addDaq = null;
    this.lastReadTimestamp = () => lastTimestampValue;
    this.getTagDaqSettings = (tagId) => data.tags[tagId]?.daq || null;
    this.setTagDaqSettings = (tagId, settings)  => {
        if (data.tags[tagId]) {
            utils.mergeObjectsValues(data.tags[tagId].daq, settings);
        }
    };

    // 私有方法
    const _loadTagsToPLC = async () => {
        logger.info(`标签订阅完成（共${tagMap.size}个）`);
    };

    const _updateVarsValue = async () => {
        const timestamp = Date.now();
        const changed = {};
        for (const [tagId, { fuxaTag, plcTag }] of tagMap.entries()) {
            try {
                const newValue = plcTag.value;
                const oldValue = varsValue[tagId]?.value;
                const valueChanged = oldValue !== newValue;

                varsValue[tagId] = {
                    id: tagId,
                    value: newValue,
                    type: fuxaTag.type || 'INT',
                    daq: fuxaTag.daq || {},
                    changed: valueChanged,
                    timestamp
                };
                if (valueChanged) changed[tagId] = varsValue[tagId];
            } catch (err) {
                logger.error(`更新标签${tagId}失败: ${err.message}`);
            }
        }
        return changed;
    };

    const _clearVarsValue = () => {
        Object.keys(varsValue).forEach(id => {
            if (varsValue[id]) {
                varsValue[id].value = null;
                varsValue[id].changed = true;
            }
        });
        if (Object.keys(varsValue).length > 0) _emitValues(varsValue);
    };

    const _emitStatus = (status) => {
        lastStatus = status;
        events.emit('device-status:changed', { id: data.id, status });
    };

    const _emitValues = (values) => {
        events.emit('device-value:changed', { id: data.id, values });
    };
}

module.exports = {
    init: function (settings) {
    },
    create: function (data, logger, events, manager, runtime) {
<<<<<<< Updated upstream
        // To use with plugin
        try { EthernetIp = require('nodepccc'); } catch { }
        if (!EthernetIp && manager) { try { EthernetIp = manager.require('nodepccc'); } catch { } }
        if (!EthernetIp) return null;
        return new EthernetIPclient(data, logger, events, runtime);
=======
        return new EthernetIPDriver(data, logger, events, manager, runtime);
>>>>>>> Stashed changes
    }
}
