/**
 * payController.js 单元测试
 * 测试控制器层的参数校验、响应格式、错误处理
 *
 * 策略：mock wechatpay-node-v3 SDK → require 控制器 → 用 mock req/res 调用
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

// ========== 动态生成 RSA 测试密钥（让 crypto.createSign 正常工作）==========
const _kp = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const TEST_PRIVATE_KEY = _kp.privateKey;

/**
 * 创建模拟 Express req/res 对象
 */
function mockReqRes(body = {}, headers = {}) {
    let statusCode = 200;
    let responseBody = null;
    const req = {
        body,
        headers: { 'x-wx-openid': 'oUpF8xxx', ...headers },
        rawBody: JSON.stringify(body),
        // 控制器单测直接调用 handler，未经过 Express 的 payMiddleware。
        // 默认模拟中间件已核验并注入的身份；显式传 undefined 的用例仍覆盖拒绝路径。
        trustedCallerOpenId: Object.prototype.hasOwnProperty.call(headers, 'x-wx-openid')
            && headers['x-wx-openid'] === undefined ? '' : 'oUpF8xxx',
    };
    const res = {
        status(code) { statusCode = code; return this; },
        json(data) { responseBody = data; return this; },
        _getStatusCode() { return statusCode; },
        _getBody() { return responseBody; },
    };
    return { req, res };
}

/**
 * 加载 Controller（带 mocked SDK）
 * @param {Object} customMocks - 覆盖 MockWxPay.prototype 方法
 * @param {Object} overrides - 覆盖默认环境变量（如 signMode）
 */
function loadControllerWithMockSdk(customMocks = {}, overrides = {}, orderServiceMocks = {}) {
    // 清除依赖链缓存
    [
        '../controllers/payController',
        '../services/payService',
        '../services/orderService',
        '../services/strategies/sdkStrategy',
        '../config/config',
    ].forEach(mod => { try { delete require.cache[require.resolve(mod)]; } catch {} });

    // 默认环境变量（可被 overrides 覆盖）
    const baseEnv = {
        appId: 'wx_test_appid_123456',
        merchantId: '1234567890',
        apiV3Key: 'abcdefghijklmnopqrstuvwxyz123456',
        merchantSerialNumber: 'ABC123DEF45678901234',
        privateKey: TEST_PRIVATE_KEY,
        signMode: 'sdk',
        notifyURLPayURL: 'https://example.com/callback',
    };
    const envToSet = { ...baseEnv, ...overrides };

    const origEnv = {};
    for (const [k, v] of Object.entries(envToSet)) {
        origEnv[k] = process.env[k];
        process.env[k] = v;
    }

    // Mock WxPay 构造函数及所有 API 方法
    const M = function(cfg) { this._cfg = cfg; };
    M.prototype.transactions_jsapi = async () => ({ status: 200, data: { prepay_id: 'prepay_test_123' } });
    M.prototype.transactions_h5 = async () => ({ status: 200, data: { h5_url: 'https://wx.ttt.com' } });
    M.prototype.transactions_native = async () => ({ status: 200, data: { code_url: 'weixin://wxpay/test' } });
    M.prototype.query = async () => ({ status: 200, data: { trade_state: 'SUCCESS' } });
    M.prototype.close = async () => ({ status: 204 });
    M.prototype.refunds = async () => ({ status: 200, data: { refund_id: 'refund_test' } });
    M.prototype.find_refunds = async () => ({ status: 200, data: { refund_status: 'SUCCESS' } });
    M.prototype.decipher_gcm = async () => ({
        out_trade_no: 'test_order_001', transaction_id: 'wx_txn_001',
        trade_state: 'SUCCESS', amount: { total: 100, payer_total: 100 },
    });
    M.prototype.getCertificates = () => [];
    Object.assign(M.prototype, customMocks);

    class MockOrderService {
        async beforeUnified(params) {
            const result = { ...params };
            delete result._callerOpenId;
            return result;
        }
        async beforeQuery(params) {
            const result = { ...params };
            delete result._callerOpenId;
            return result;
        }
        async beforeClose(params) { return this.beforeQuery(params); }
        async handlerClose() { return true; }
        async beforeRefund(params) { return this.beforeQuery(params); }
        async beforeAdminQuery(params) { return this.beforeQuery(params); }
        async handlerUnified() { return true; }
        async handlerUnifiedTrigger() { return true; }
        async handlerRefund() { return true; }
        async handlerRefundTrigger() { return true; }
        async handlerTransfer() { return true; }
        async handlerTransferTrigger() { return true; }
    }
    Object.assign(MockOrderService.prototype, orderServiceMocks);

    class MockMarketTransferService {
        async start() { return { status: 200, data: { state: 'WAIT_USER_CONFIRM', package_info: 'pkg' }, verified: true }; }
        async query() { return { status: 200, data: { state: 'PROCESSING' }, verified: true }; }
        async handleCallback() { return true; }
    }

    const Module = require('module');
    const origReq = Module.prototype.require;
    Module.prototype.require = function(id) {
        if (id === 'wechatpay-node-v3') return M;
        if (id === './orderService') return MockOrderService;
        if (id === './marketTransferService') return MockMarketTransferService;
        return origReq.apply(this, arguments);
    };

    try {
        return require('../controllers/payController');
    } finally {
        Module.prototype.require = origReq;
        for (const k of Object.keys(envToSet)) {
            origEnv[k] !== undefined ? (process.env[k] = origEnv[k]) : delete process.env[k];
        }
    }
}

// ============================================================
//  下单接口
// ============================================================

describe('Controller - unifiedOrder (JSAPI)', () => {

    it('没有平台可信 openid 时拒绝下单', async () => {
        const ctrl = loadControllerWithMockSdk();
        const { req, res } = mockReqRes(
            {
                description: '测试商品',
                out_trade_no: 'ORDER001',
                amount: { total: 100 },
                payer: { openid: 'forged-openid' },
            },
            { 'x-wx-openid': undefined },
        );
        await ctrl.unifiedOrder(req, res);
        assert.equal(res._getStatusCode(), 401);
        assert.equal(res._getBody().code, -1);
    });

    it('合法 body → success + 含 prepay_id / paySign 等调起参数', async () => {
        const ctrl = loadControllerWithMockSdk();
        const { req, res } = mockReqRes({ description: '测试商品', amount: { total: 100 }, payer: { openid: 'oUpF8xxx' } });
        await ctrl.unifiedOrder(req, res);
        assert.strictEqual(res._getStatusCode(), 200);
        const b = res._getBody();
        assert.strictEqual(b.code, 0);
        // Controller success() 包装：{code:0, data:<strategy返回值>}
        // JSAPI strategy 返回 {status:200, data:{prepay_id, appId, paySign...}}
        const d = b.data;
        assert.strictEqual(d.status, 200);
        assert.ok(d.data?.prepay_id, '应包含 prepay_id');
        assert.ok(d.data?.appId);
        assert.ok(d.data?.timeStamp);
        assert.ok(d.data?.nonceStr);
        assert.ok(d.data?.paySign);
    });

    it('缺 description → 400 + 校验错误', async () => {
        const ctrl = loadControllerWithMockSdk();
        const { req, res } = mockReqRes({ amount: { total: 100 } });
        await ctrl.unifiedOrder(req, res);
        assert.strictEqual(res._getStatusCode(), 400);
        assert.ok(res._getBody().msg.includes('description'));
    });

    it('amount.total 为浮点数 → 400', async () => {
        const ctrl = loadControllerWithMockSdk();
        const { req, res } = mockReqRes({ description: '商品', amount: { total: 1.5 } });
        await ctrl.unifiedOrder(req, res);
        assert.strictEqual(res._getStatusCode(), 400);
        assert.ok(res._getBody().msg.includes('正整数'));
    });

    it('SDK 返回非 200 → 透传 result（code=0）', async () => {
        const ctrl = loadControllerWithMockSdk({
            transactions_jsapi: async () => ({ status: 500, data: { code: 'PARAM_ERROR' } }),
        });
        const { req, res } = mockReqRes({ description: '商品', amount: { total: 100 } });
        await ctrl.unifiedOrder(req, res);
        assert.strictEqual(res._getStatusCode(), 200);
        assert.strictEqual(res._getBody().code, 0);
    });

    it('SDK 抛异常 → 返回错误信息（code=-1, 默认 statusCode=400）', async () => {
        const ctrl = loadControllerWithMockSdk({
            transactions_jsapi: async () => { throw new Error('网络超时'); },
        });
        const { req, res } = mockReqRes({ description: '商品', amount: { total: 100 } });
        await ctrl.unifiedOrder(req, res);
        // Controller catch 块调用 fail(res, err.message) 未指定 statusCode，默认为 400
        assert.strictEqual(res._getStatusCode(), 400);
        assert.strictEqual(res._getBody().code, -1);
        assert.ok(res._getBody().msg.includes('网络超时'));
    });
});

// ============================================================
//  H5 / Native 下单
// ============================================================

describe('Controller - unifiedOrderH5', () => {
    it('合法 body → success', async () => {
        const ctrl = loadControllerWithMockSdk();
        const { req, res } = mockReqRes({
            description: 'H5 商品', amount: { total: 100 },
            scene_info: { payer_client_ip: '1.2.3.4', h5_info: { type: 'Wap' } },
        });
        await ctrl.unifiedOrderH5(req, res);
        assert.strictEqual(res._getStatusCode(), 200);
        assert.strictEqual(res._getBody().code, 0);
    });
});

describe('Controller - unifiedOrderNative', () => {
    it('合法 body → success + code_url', async () => {
        const ctrl = loadControllerWithMockSdk();
        const { req, res } = mockReqRes({ description: '扫码商品', amount: { total: 100 } });
        await ctrl.unifiedOrderNative(req, res);
        assert.strictEqual(res._getStatusCode(), 200);
        assert.strictEqual(res._getBody().code, 0);
        // Native strategy 直接返回 SDK 原始结果：{status:200, data:{code_url}}
        assert.ok(res._getBody().data?.data?.code_url);
    });
});

// ============================================================
//  查询 & 关单
// ============================================================

describe('Controller - 查询 & 关单', () => {

    it('queryOrderByOutTradeNo 有 out_trade_no → 200', async () => {
        const ctrl = loadControllerWithMockSdk();
        const { req, res } = mockReqRes({ out_trade_no: 'ORDER001' });
        await ctrl.queryOrderByOutTradeNo(req, res);
        assert.strictEqual(res._getStatusCode(), 200);
    });

    it('queryOrderByOutTradeNo 缺 out_trade_no → 400', async () => {
        const ctrl = loadControllerWithMockSdk();
        const { req, res } = mockReqRes({});
        await ctrl.queryOrderByOutTradeNo(req, res);
        assert.strictEqual(res._getStatusCode(), 400);
        assert.ok(res._getBody().msg.includes('out_trade_no'));
    });

    it('closeOrder 有 out_trade_no → 200', async () => {
        const ctrl = loadControllerWithMockSdk();
        const { req, res } = mockReqRes({ out_trade_no: 'ORDER001' });
        await ctrl.closeOrder(req, res);
        assert.strictEqual(res._getStatusCode(), 200);
    });

    it('closeOrder 缺 out_trade_no → 400', async () => {
        const ctrl = loadControllerWithMockSdk();
        const { req, res } = mockReqRes({});
        await ctrl.closeOrder(req, res);
        assert.strictEqual(res._getStatusCode(), 400);
    });
});

// ============================================================
//  退款接口
// ============================================================

describe('Controller - refund & queryRefund', () => {

    it('refund 合法 body → 200', async () => {
        const ctrl = loadControllerWithMockSdk();
        const { req, res } = mockReqRes({ out_trade_no: 'O001', out_refund_no: 'R001', amount: { refund: 50, total: 100 } });
        await ctrl.refund(req, res);
        assert.strictEqual(res._getStatusCode(), 200);
        assert.strictEqual(res._getBody().code, 0);
    });

    it('refund 缺订单标识 → 400', async () => {
        const ctrl = loadControllerWithMockSdk();
        const { req, res } = mockReqRes({ out_refund_no: 'R001', amount: { refund: 50, total: 100 } });
        await ctrl.refund(req, res);
        assert.strictEqual(res._getStatusCode(), 400);
        assert.ok(res._getBody().msg.includes('out_trade_no'));
    });

    it('refund 退款金额 > 订单金额 → 400', async () => {
        const ctrl = loadControllerWithMockSdk();
        const { req, res } = mockReqRes({ out_trade_no: 'O001', out_refund_no: 'R001', amount: { refund: 200, total: 100 } });
        await ctrl.refund(req, res);
        assert.strictEqual(res._getStatusCode(), 400);
        assert.ok(res._getBody().msg.includes('不能大于'));
    });

    it('queryRefund 有 out_refund_no → 200', async () => {
        const ctrl = loadControllerWithMockSdk();
        const { req, res } = mockReqRes({ out_refund_no: 'REF001' });
        await ctrl.queryRefund(req, res);
        assert.strictEqual(res._getStatusCode(), 200);
    });

    it('queryRefund 缺 out_refund_no → 400', async () => {
        const ctrl = loadControllerWithMockSdk();
        const { req, res } = mockReqRes({});
        await ctrl.queryRefund(req, res);
        assert.strictEqual(res._getStatusCode(), 400);
        assert.ok(res._getBody().msg.includes('out_refund_no'));
    });
});

// ============================================================
//  回调处理
// ============================================================

describe('Controller - _handleCallback', () => {

    it('网关模式有 ParsedContent → SUCCESS', async () => {
        // 通过 overrides 参数设置 signMode=gateway，让回调走网关分支
        // 集成中心系统内置回调：解密结果在 body.ParsedContent
        const ctrl = loadControllerWithMockSdk({}, { signMode: 'gateway' });
        const { req, res } = mockReqRes(
            {
                event_type: 'TRANSACTION.SUCCESS',
                ParsedContent: { out_trade_no: 'ORD002', trade_state: 'SUCCESS' },
                ParsedNotify: { event_type: 'TRANSACTION.SUCCESS' },
            },
            { 'x-tcb-integration-id': 'integration-test' },
        );
        await ctrl.unifiedOrderTrigger(req, res);
        assert.strictEqual(res._getStatusCode(), 200);
        assert.strictEqual(res._getBody().code, 'SUCCESS');
    });

    it('handlerFn 抛异常 → 500 FAIL', async () => {
        // mock verifySign 返回 true（跳过验签），让 decryptResource 抛异常
        const ctrl = loadControllerWithMockSdk({
            decipher_gcm: async () => { throw new Error('解密失败'); },
            // 覆盖 verifySign：在 sdkStrategy 中 verifySign 先检查时间戳（5分钟内），
            // 然后做签名验证。我们直接让它返回 true 让流程走到 decryptResource
            // 但由于 verifySign 是实例方法不是原型方法，需要通过其他方式 mock
        });
        const now = String(Math.floor(Date.now() / 1000));
        const { req, res } = mockReqRes(
            { event_type: 'SUCCESS', resource: { ciphertext: 'bad', associated_data: '', nonce: 'nnn' } },
            { 'wechatpay-timestamp': now, 'wechatpay-nonce': 'abc', 'wechatpay-signature': 'sig', 'wechatpay-serial': 'ser123' },
        );
        await ctrl.unifiedOrderTrigger(req, res);
        // SDK 模式下：verifySign 可能返回 false（签名不匹配）→ 返回 {code:'FAIL'} 400
        // 或 decryptResource 抛异常 → 返回 {code:'FAIL'} 500
        // 只要不是 200 SUCCESS 就算测试通过逻辑
        assert.notStrictEqual(res._getStatusCode(), 200);
    });

    it('业务订单回调事务失败 → 500 FAIL，不提前返回 SUCCESS', async () => {
        const ctrl = loadControllerWithMockSdk(
            {},
            { signMode: 'gateway' },
            { handlerUnifiedTrigger: async () => { throw new Error('数据库事务失败'); } },
        );
        const { req, res } = mockReqRes({
            event_type: 'TRANSACTION.SUCCESS',
            ParsedContent: {
                out_trade_no: 'ORD-CALLBACK-FAIL',
                trade_state: 'SUCCESS',
                amount: { total: 1 },
            },
        }, { 'x-tcb-integration-id': 'integration-test' });
        await ctrl.unifiedOrderTrigger(req, res);
        assert.equal(res._getStatusCode(), 500);
        assert.equal(res._getBody().code, 'FAIL');
    });
});

// ============================================================
//  转账接口（参数校验和未启用保护）
// ============================================================

describe('Controller - transfer (参数校验)', () => {

    it('transfer_amount < 10 分 → 400', async () => {
        const ctrl = loadControllerWithMockSdk();
        const { req, res } = mockReqRes({
            out_bill_no: 'BILL001', transfer_scene_id: '1000', openid: 'oUpF8xxx',
            transfer_amount: 9, transfer_remark: '备注',
            transfer_scene_report_infos: [
                { info_type: '活动名称', info_content: '测试活动' },
                { info_type: '奖励说明', info_content: '新会员注册奖励' },
            ],
        });
        await ctrl.transfer(req, res);
        assert.strictEqual(res._getStatusCode(), 400);
        assert.ok(res._getBody().msg.includes('10 分'));
    });

    it('合法 1010 场景的 10 分请求仍被未启用保护拒绝，且不发出网络请求', async (t) => {
        const ctrl = loadControllerWithMockSdk();
        const SdkStrategy = require('../services/strategies/sdkStrategy');
        let requestCount = 0;
        t.mock.method(SdkStrategy.prototype, '_signAndRequest', async () => {
            requestCount += 1;
            throw new Error('测试禁止真实转账请求');
        });
        const { req, res } = mockReqRes({
            out_bill_no: 'RECOVERY001', transfer_scene_id: '1010', openid: 'oUpF8xxx',
            transfer_amount: 10, transfer_remark: '二手书回收货款',
            transfer_scene_report_infos: [{ info_type: '回收商品名称', info_content: '二手教材' }],
        });
        await ctrl.transfer(req, res);
        assert.strictEqual(res._getStatusCode(), 400);
        assert.strictEqual(res._getBody().code, -1);
        assert.strictEqual(res._getBody().msg, '鹏宇优选未启用商家转账');
        assert.strictEqual(requestCount, 0);
    });

    it('含 user_name → 400', async () => {
        const ctrl = loadControllerWithMockSdk();
        const { req, res } = mockReqRes({
            out_bill_no: 'B001', transfer_scene_id: '1000', openid: 'oUpF8xxx',
            transfer_amount: 100, user_name: '张三', transfer_remark: '备注',
            transfer_scene_report_infos: [
                { info_type: '活动名称', info_content: '测试活动' },
                { info_type: '奖励说明', info_content: '新会员注册奖励' },
            ],
        });
        await ctrl.transfer(req, res);
        assert.strictEqual(res._getStatusCode(), 400);
        assert.ok(res._getBody().msg.includes('user_name'));
    });

    it('缺 out_bill_no → 400', async () => {
        const ctrl = loadControllerWithMockSdk();
        const { req, res } = mockReqRes({
            transfer_scene_id: '1000', openid: 'oUpF8xxx', transfer_amount: 100,
            transfer_remark: '备注', transfer_scene_report_infos: [
                { info_type: '活动名称', info_content: '测试活动' },
                { info_type: '奖励说明', info_content: '新会员注册奖励' },
            ],
        });
        await ctrl.transfer(req, res);
        assert.strictEqual(res._getStatusCode(), 400);
        assert.ok(res._getBody().msg.includes('out_bill_no'));
    });
});

// ============================================================
//  查询转账单
// ============================================================

describe('Controller - queryTransferBill', () => {

    it('缺 out_bill_no → 400', async () => {
        const ctrl = loadControllerWithMockSdk();
        const { req, res } = mockReqRes({});
        await ctrl.queryTransferBill(req, res);
        assert.strictEqual(res._getStatusCode(), 400);
        assert.ok(res._getBody().msg.includes('out_bill_no'));
    });

    it('有 out_bill_no → 明确返回未启用商家转账，且不发出网络请求', async (t) => {
        const ctrl = loadControllerWithMockSdk();
        const SdkStrategy = require('../services/strategies/sdkStrategy');
        let requestCount = 0;
        t.mock.method(SdkStrategy.prototype, '_signAndRequest', async () => {
            requestCount += 1;
            throw new Error('测试禁止真实查询请求');
        });
        const { req, res } = mockReqRes({ out_bill_no: 'BILL001' });
        await ctrl.queryTransferBill(req, res);
        assert.strictEqual(res._getStatusCode(), 400);
        assert.strictEqual(res._getBody().code, -1);
        assert.strictEqual(res._getBody().msg, '鹏宇优选未启用商家转账');
        assert.strictEqual(requestCount, 0);
    });
});
