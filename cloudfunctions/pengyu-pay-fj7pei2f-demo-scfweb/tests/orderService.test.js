const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const originalRequire = Module.prototype.require;
Module.prototype.require = function(id) {
    if (id === 'wx-server-sdk') {
        return {
            DYNAMIC_CURRENT_ENV: 'test',
            init() {},
            database() { return {}; },
        };
    }
    return originalRequire.apply(this, arguments);
};
const OrderService = require('../services/orderService');
Module.prototype.require = originalRequire;

class FakeDatabase {
    constructor(seed = {}) {
        this.data = {};
        Object.entries(seed).forEach(([name, docs]) => {
            this.data[name] = new Map(docs.map((doc) => [doc._id, { ...doc }]));
        });
    }

    collection(name) {
        if (!this.data[name]) this.data[name] = new Map();
        const records = this.data[name];
        return {
            where: (query) => {
                const request = {
                    limit() { return request; },
                    async get() {
                        return {
                            data: Array.from(records.values()).filter((doc) => (
                                Object.entries(query).every(([key, value]) => doc[key] === value)
                            )).map((doc) => ({ ...doc })),
                        };
                    },
                };
                return request;
            },
            doc: (id) => ({
                async get() { return { data: records.has(id) ? { ...records.get(id) } : null }; },
                async update({ data }) {
                    const current = records.get(id);
                    if (!current) throw new Error(`missing ${name}/${id}`);
                    Object.assign(current, data);
                    return { updated: 1 };
                },
            }),
        };
    }

    async runTransaction(callback) {
        // Serialize the in-memory transactions so races exercise the same
        // read/check/write boundary required from the production database.
        const previous = this.transactionTail || Promise.resolve();
        let release;
        this.transactionTail = new Promise((resolve) => { release = resolve; });
        await previous;
        const snapshot = Object.fromEntries(Object.entries(this.data).map(([name, docs]) => (
            [name, new Map(Array.from(docs, ([id, doc]) => [id, { ...doc }]))]
        )));
        try {
            return await callback(this);
        } catch (error) {
            this.data = snapshot;
            throw error;
        } finally {
            release();
        }
    }
}

const makeOrder = (overrides = {}) => ({
    _id: 'order-1',
    outTradeNo: 'PY202609010001',
    buyerOpenId: 'buyer-openid',
    outletName: '一号楼代售点',
    totalAmountFen: 1,
    status: 'pending_payment',
    stockReleased: false,
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    items: [{ productId: 'product-1', quantity: 2 }],
    ...overrides,
});

describe('OrderService - 下单前服务端校验', () => {
    it('以数据库金额、描述和可信 openid 覆盖前端参数', async () => {
        const db = new FakeDatabase({ orders: [makeOrder()] });
        const service = new OrderService(db);
        const result = await service.beforeUnified({
            _callerOpenId: 'buyer-openid',
            out_trade_no: 'PY202609010001',
            description: '前端描述',
            amount: { total: 1 },
            payer: { openid: 'forged-openid' },
        });
        assert.equal(result.description, '一号楼代售点商品');
        assert.deepEqual(result.amount, { total: 1, currency: 'CNY' });
        assert.equal(result.payer.openid, 'buyer-openid');
        assert.equal(result._callerOpenId, undefined);
    });

    it('金额被篡改时拒绝下单', async () => {
        const service = new OrderService(new FakeDatabase({ orders: [makeOrder()] }));
        await assert.rejects(() => service.beforeUnified({
            _callerOpenId: 'buyer-openid',
            out_trade_no: 'PY202609010001',
            amount: { total: 2 },
        }), /支付金额与业务订单不一致/);
    });

    it('付款人不是订单所有者时拒绝下单', async () => {
        const service = new OrderService(new FakeDatabase({ orders: [makeOrder()] }));
        await assert.rejects(() => service.beforeUnified({
            _callerOpenId: 'other-openid',
            out_trade_no: 'PY202609010001',
            amount: { total: 1 },
        }), /业务订单不存在/);
    });
});

describe('OrderService - 平台回收商品支付', () => {
    const makeMarketOrder = (overrides = {}) => ({
        _id: 'market-order-1',
        outTradeNo: 'MK202609050001',
        buyerOpenId: 'market-buyer',
        inventoryId: 'inventory-1',
        description: '鹏宇优选二手回收商品',
        totalAmountFen: 880,
        status: 'pending_payment',
        paymentStatus: 'unpaid',
        stockReleased: false,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
        ...overrides,
    });

    it('只使用市场订单保存的价格和付款人创建支付参数', async () => {
        const service = new OrderService(new FakeDatabase({
            orders: [],
            market_sale_orders: [makeMarketOrder()],
        }));
        const result = await service.beforeUnified({
            _callerOpenId: 'market-buyer',
            out_trade_no: 'MK202609050001',
            description: '伪造描述',
            amount: { total: 880 },
            payer: { openid: 'other-user' },
        });
        assert.equal(result.description, '鹏宇优选二手回收商品');
        assert.deepEqual(result.amount, { total: 880, currency: 'CNY' });
        assert.equal(result.payer.openid, 'market-buyer');
    });

    it('可信支付回调更新市场订单和对应唯一库存', async () => {
        const db = new FakeDatabase({
            orders: [],
            market_sale_orders: [makeMarketOrder()],
            market_inventory: [{ _id: 'inventory-1', goodsId: 'goods-1', status: 'locked', saleOrderId: 'market-order-1' }],
            goods: [{ _id: 'goods-1', status: 'on_sale', platformOwned: true }],
        });
        const service = new OrderService(db);
        await service.handlerUnifiedTrigger({
            out_trade_no: 'MK202609050001',
            transaction_id: 'wx-market-transaction-1',
            trade_state: 'SUCCESS',
            payer: { openid: 'market-buyer' },
            amount: { total: 880 },
        });
        assert.equal(db.data.market_sale_orders.get('market-order-1').status, 'paid');
        assert.equal(db.data.market_sale_orders.get('market-order-1').paymentStatus, 'paid');
        assert.equal(db.data.market_inventory.get('inventory-1').status, 'sold');
        assert.equal(db.data.goods.get('goods-1').status, 'sold');
    });

    it('取消释放后晚到的付款进入退款异常而不出售库存', async () => {
        const db = new FakeDatabase({
            orders: [],
            market_sale_orders: [makeMarketOrder({ status: 'cancelled', stockReleased: true })],
            market_inventory: [{ _id: 'inventory-1', goodsId: 'goods-1', status: 'on_sale', saleOrderId: '' }],
            goods: [{ _id: 'goods-1', status: 'on_sale', platformOwned: true }],
        });
        const service = new OrderService(db);
        await service.handlerUnifiedTrigger({
            out_trade_no: 'MK202609050001',
            transaction_id: 'wx-market-late-payment',
            trade_state: 'SUCCESS',
            amount: { total: 880 },
        });
        const order = db.data.market_sale_orders.get('market-order-1');
        assert.equal(order.status, 'payment_exception');
        assert.equal(order.paymentStatus, 'paid_after_close');
        assert.equal(order.needsRefund, true);
        assert.equal(db.data.market_inventory.get('inventory-1').status, 'on_sale');
    });
});

describe('OrderService - C2C 担保交易支付', () => {
    const makeC2COrder = (overrides = {}) => ({
        _id: 'c2c-order-1', outTradeNo: 'C2C202609050001', buyerOpenId: 'buyer-openid',
        goodsId: 'goods-1', totalAmountFen: 3000, status: 'pending_payment', paymentStatus: 'not_started',
        settlementStatus: 'not_available', payoutStatus: 'not_requested', stockReleased: false,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000), ...overrides,
    });

    it('已验签付款回调只在商品锁定匹配时推进 C2C 订单', async () => {
        const db = new FakeDatabase({
            orders: [], market_sale_orders: [], market_c2c_orders: [makeC2COrder()],
            goods: [{ _id: 'goods-1', status: 'locked', c2cOrderId: 'c2c-order-1', c2cTradeStatus: 'pending_payment' }],
        });
        const service = new OrderService(db);
        await service.handlerUnifiedTrigger({
            out_trade_no: 'C2C202609050001', transaction_id: 'wx-c2c-transaction-1', trade_state: 'SUCCESS',
            payer: { openid: 'buyer-openid' }, amount: { total: 3000 },
        });
        assert.equal(db.data.market_c2c_orders.get('c2c-order-1').status, 'paid');
        assert.equal(db.data.goods.get('goods-1').status, 'trading');
        assert.equal(db.data.goods.get('goods-1').c2cTradeStatus, 'paid');
    });

    it('C2C 下单描述和金额均以订单快照为准', async () => {
        const db = new FakeDatabase({
            orders: [], market_sale_orders: [],
            market_c2c_orders: [makeC2COrder({ goodsSnapshot: { title: '高等数学教材' } })],
        });
        const service = new OrderService(db);
        const result = await service.beforeUnified({
            _callerOpenId: 'buyer-openid', out_trade_no: 'C2C202609050001',
            description: '伪造商品名', amount: { total: 3000 },
        });
        assert.equal(result.description, '校园闲置 · 高等数学教材');
        assert.deepEqual(result.amount, { total: 3000, currency: 'CNY' });
    });

    it('关闭未支付 C2C 订单必须解除同一订单的商品锁定', async () => {
        const db = new FakeDatabase({
            orders: [], market_sale_orders: [], market_c2c_orders: [makeC2COrder()],
            goods: [{ _id: 'goods-1', status: 'locked', c2cOrderId: 'c2c-order-1', c2cTradeStatus: 'pending_payment' }],
        });
        const service = new OrderService(db);
        await service.handlerClose({ out_trade_no: 'C2C202609050001' });
        assert.equal(db.data.market_c2c_orders.get('c2c-order-1').status, 'cancelled');
        assert.equal(db.data.goods.get('goods-1').status, 'on_sale');
        assert.equal(db.data.goods.get('goods-1').c2cOrderId, '');
    });
});

describe('OrderService - 支付回调幂等', () => {
    it('重复成功回调只更新一次销量', async () => {
        const db = new FakeDatabase({
            orders: [makeOrder()],
            store_products: [{ _id: 'product-1', salesCount: 3 }],
        });
        const service = new OrderService(db);
        const callback = {
            out_trade_no: 'PY202609010001',
            transaction_id: 'wx-transaction-1',
            trade_state: 'SUCCESS',
            amount: { total: 1 },
            payer: { openid: 'buyer-openid' },
        };

        await service.handlerUnifiedTrigger(callback);
        await service.handlerUnifiedTrigger(callback);

        assert.equal(db.data.orders.get('order-1').status, 'paid');
        assert.equal(db.data.orders.get('order-1').transactionId, 'wx-transaction-1');
        assert.equal(db.data.store_products.get('product-1').salesCount, 5);
    });

    it('库存已释放后收到成功回调会进入支付异常且不增加销量', async () => {
        const db = new FakeDatabase({
            orders: [makeOrder({ status: 'expired', stockReleased: true })],
            store_products: [{ _id: 'product-1', salesCount: 3 }],
        });
        const service = new OrderService(db);
        await service.handlerUnifiedTrigger({
            out_trade_no: 'PY202609010001',
            transaction_id: 'wx-late-transaction',
            trade_state: 'SUCCESS',
            amount: { total: 1 },
            payer: { openid: 'buyer-openid' },
        });

        assert.equal(db.data.orders.get('order-1').status, 'payment_exception');
        assert.equal(db.data.orders.get('order-1').needsRefund, true);
        assert.equal(db.data.store_products.get('product-1').salesCount, 3);
    });
});

describe('OrderService - 退款权限', () => {
    it('只有管理员可以发起整单退款', async () => {
        const db = new FakeDatabase({
            orders: [makeOrder({ status: 'paid' })],
            users: [
                { _id: 'admin-1', _openid: 'admin-openid', role: 'admin' },
                { _id: 'user-1', _openid: 'buyer-openid', role: 'user' },
            ],
        });
        const service = new OrderService(db);
        const result = await service.beforeRefund({
            _callerOpenId: 'admin-openid',
            out_trade_no: 'PY202609010001',
            out_refund_no: 'RF202609010001',
            amount: { total: 1, refund: 1 },
        });
        assert.equal(result._callerOpenId, undefined);

        await assert.rejects(() => service.beforeRefund({
            _callerOpenId: 'buyer-openid',
            out_trade_no: 'PY202609010001',
            out_refund_no: 'RF202609010002',
            amount: { total: 1, refund: 1 },
        }), /无管理员权限/);
    });
});

const makeRefundRequest = (overrides = {}) => ({
    _callerOpenId: 'admin-openid',
    out_trade_no: 'PY202609010001',
    out_refund_no: 'RF202609010001',
    amount: { total: 100, refund: 100, currency: 'CNY' },
    ...overrides,
});

const makeRefundCallback = (overrides = {}) => ({
    out_trade_no: 'PY202609010001',
    out_refund_no: 'RF202609010001',
    refund_id: 'wx-refund-1',
    refund_status: 'SUCCESS',
    // The refund notification amount schema can omit currency.
    amount: { total: 100, refund: 100, payer_total: 100, payer_refund: 100 },
    ...overrides,
});

const makeRefundContext = (overrides = {}) => {
    const db = new FakeDatabase({
        orders: [makeOrder({ status: 'paid', totalAmountFen: 100, transactionId: 'wx-transaction-1', ...overrides })],
        users: [{ _id: 'admin-1', _openid: 'admin-openid', role: 'admin' }],
    });
    return { db, service: new OrderService(db), order: () => db.data.orders.get('order-1') };
};

describe('OrderService - 退款意图与终态保护', () => {
    it('请求渠道前保存退款单号，允许合法回调先于退款请求返回', async () => {
        const { service, order } = makeRefundContext();
        const request = await service.beforeRefund(makeRefundRequest());
        assert.equal(order().outRefundNo, request.out_refund_no);
        assert.equal(order().status, 'refunding');
        await service.handlerRefundTrigger(makeRefundCallback());
        await service.handlerRefund(request);
        assert.equal(order().status, 'refunded');
    });

    it('迟到的退款请求响应不会覆盖已成功退款的终态和时间', async () => {
        const { service, order } = makeRefundContext({ status: 'refunding', outRefundNo: 'RF202609010001' });
        await service.handlerRefundTrigger(makeRefundCallback());
        const refundedAt = order().refundedAt;
        await service.handlerRefund(makeRefundRequest());
        assert.equal(order().status, 'refunded');
        assert.equal(order().refundedAt, refundedAt);
    });

    it('未知网络结果可用相同退款单号重试，不能换号再次发起', async () => {
        const { service, order } = makeRefundContext();
        await service.beforeRefund(makeRefundRequest());
        await service.beforeRefund(makeRefundRequest());
        await assert.rejects(() => service.beforeRefund(makeRefundRequest({ out_refund_no: 'RF-OTHER' })), /退款单号/);
        assert.equal(order().outRefundNo, 'RF202609010001');
    });

    it('并发不同退款单号只允许一份退款意图通过', async () => {
        const { service, order } = makeRefundContext();
        const results = await Promise.allSettled([
            service.beforeRefund(makeRefundRequest()),
            service.beforeRefund(makeRefundRequest({ out_refund_no: 'RF-OTHER' })),
        ]);
        assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
        assert.ok(['RF202609010001', 'RF-OTHER'].includes(order().outRefundNo));
    });

    for (const [label, overrides] of [
        ['错误退款单号', { out_refund_no: 'RF-OTHER' }],
        ['缺少退款单号', { out_refund_no: undefined }],
        ['部分退款金额', { amount: { total: 100, refund: 1 } }],
        ['缺少退款金额', { amount: { total: 100 } }],
        ['错误币种', { amount: { total: 100, refund: 100, currency: 'USD' } }],
    ]) {
        it(`${label}不会把订单标为整单退款成功`, async () => {
            const { service, order } = makeRefundContext({ status: 'refunding', outRefundNo: 'RF202609010001' });
            await assert.rejects(() => service.handlerRefundTrigger(makeRefundCallback(overrides)), /退款/);
            assert.equal(order().status, 'refunding');
        });
    }

    it('没有可信退款意图时不接受成功回调', async () => {
        const { service, order } = makeRefundContext();
        await assert.rejects(() => service.handlerRefundTrigger(makeRefundCallback()), /退款单号/);
        assert.equal(order().status, 'paid');
    });

    it('并发成功和迟到非成功回调不能使已退款订单倒退', async () => {
        const { service, order } = makeRefundContext({ status: 'refunding', outRefundNo: 'RF202609010001' });
        await Promise.all([
            service.handlerRefundTrigger(makeRefundCallback()),
            service.handlerRefundTrigger(makeRefundCallback({ refund_status: 'CLOSED' })),
        ]);
        assert.equal(order().status, 'refunded');
        assert.equal(order().refundStatus, 'SUCCESS');
    });

    it('退款成功后重放支付回调保留退款终态及销量', async () => {
        const { db, service, order } = makeRefundContext({ status: 'refunded', stockReleased: true });
        db.data.store_products = new Map([['product-1', { _id: 'product-1', salesCount: 3 }]]);
        await service.handlerUnifiedTrigger({
            out_trade_no: 'PY202609010001', transaction_id: 'wx-transaction-1',
            trade_state: 'SUCCESS', amount: { total: 100 }, payer: { openid: 'buyer-openid' },
        });
        assert.equal(order().status, 'refunded');
        assert.equal(db.data.store_products.get('product-1').salesCount, 3);
    });

    it('退款中重放原支付回调保持退款状态并成功确认', async () => {
        const { service, order } = makeRefundContext({ status: 'refunding' });
        await service.handlerUnifiedTrigger({
            out_trade_no: 'PY202609010001', transaction_id: 'wx-transaction-1',
            trade_state: 'SUCCESS', amount: { total: 100 }, payer: { openid: 'buyer-openid' },
        });
        assert.equal(order().status, 'refunding');
    });

    it('以微信交易号退款时返回绑定订单的商户单号', async () => {
        const { service } = makeRefundContext();
        const request = await service.beforeRefund(makeRefundRequest({ out_trade_no: undefined, transaction_id: 'wx-transaction-1' }));
        assert.equal(request.out_trade_no, 'PY202609010001');
        assert.equal(request.transaction_id, undefined);
    });

    it('退款申请补全渠道必填CNY，错误币种不保存退款意图', async () => {
        const valid = makeRefundContext();
        const request = await valid.service.beforeRefund(makeRefundRequest({ amount: { total: 100, refund: 100 } }));
        assert.deepEqual(request.amount, { total: 100, refund: 100, currency: 'CNY' });
        const invalid = makeRefundContext();
        await assert.rejects(() => invalid.service.beforeRefund(makeRefundRequest({ amount: { total: 100, refund: 100, currency: 'USD' } })), /退款币种/);
        assert.equal(invalid.order().status, 'paid');
        assert.equal(invalid.order().outRefundNo, undefined);
    });

    it('已退款订单仍拒绝无关支付交易号与无关退款单号', async () => {
        const { service, order } = makeRefundContext({ status: 'refunded', outRefundNo: 'RF202609010001' });
        await assert.rejects(() => service.handlerUnifiedTrigger({
            out_trade_no: 'PY202609010001', transaction_id: 'wx-unrelated',
            trade_state: 'SUCCESS', amount: { total: 100 }, payer: { openid: 'buyer-openid' },
        }), /交易号/);
        await assert.rejects(() => service.handlerRefundTrigger(makeRefundCallback({ out_refund_no: 'RF-OTHER' })), /退款单号/);
        assert.equal(order().status, 'refunded');
    });
});
