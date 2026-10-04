/**
 * 鹏宇优选微信支付业务钩子。
 *
 * 安全原则：
 * 1. 微信支付金额、商品描述和付款人只能由业务订单推导，不能信任前端。
 * 2. 支付与退款回调必须等待数据库事务完成后才向微信返回成功。
 * 3. 微信可能重复发送回调，因此所有状态和销量更新都必须幂等。
 */
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const defaultDatabase = cloud.database();
const PAYMENT_RECORDED_STATUSES = new Set(['paid', 'delivering', 'completed', 'payment_exception', 'refunding', 'refunded']);
const REFUNDABLE_STATUSES = new Set(['paid', 'delivering', 'completed', 'payment_exception']);

class OrderService {
    constructor(database = defaultDatabase) {
        this.db = database;
    }

    async getOrder(outTradeNo) {
        if (!outTradeNo) return null;
        const res = await this.db.collection('orders').where({ outTradeNo }).limit(1).get();
        return res.data[0] || null;
    }

    async getOrderByTransactionId(transactionId) {
        if (!transactionId) return null;
        const res = await this.db.collection('orders').where({ transactionId }).limit(1).get();
        return res.data[0] || null;
    }

    async getUserByOpenId(openid) {
        if (!openid) return null;
        const res = await this.db.collection('users').where({ _openid: openid }).limit(1).get();
        return res.data[0] || null;
    }

    requireCallerOpenId(params) {
        const openid = params && params._callerOpenId;
        if (!openid) throw new Error('无法确认当前付款用户');
        return openid;
    }

    stripInternalFields(params) {
        const result = { ...params };
        delete result._callerOpenId;
        return result;
    }

    async requireOwnedOrder(params) {
        const callerOpenId = this.requireCallerOpenId(params);
        const order = params.out_trade_no
            ? await this.getOrder(params.out_trade_no)
            : await this.getOrderByTransactionId(params.transaction_id);
        if (!order || order.buyerOpenId !== callerOpenId) {
            throw new Error('业务订单不存在');
        }
        return order;
    }

    async requireAdmin(params) {
        const callerOpenId = this.requireCallerOpenId(params);
        const user = await this.getUserByOpenId(callerOpenId);
        if (!user || user.role !== 'admin') throw new Error('无管理员权限');
        return user;
    }

    /**
     * 微信统一下单前，以数据库订单覆盖前端传入的金额和描述。
     */
    async beforeUnified(params) {
        const callerOpenId = this.requireCallerOpenId(params);
        const order = await this.getOrder(params.out_trade_no);
        if (!order || order.buyerOpenId !== callerOpenId) throw new Error('业务订单不存在');
        if (order.status !== 'pending_payment') throw new Error('业务订单状态不可支付');
        if (new Date(order.expiresAt).getTime() <= Date.now()) throw new Error('业务订单已超时');

        const requestedTotal = Number(params.amount && params.amount.total);
        if (requestedTotal !== Number(order.totalAmountFen)) {
            throw new Error('支付金额与业务订单不一致');
        }

        const cleanParams = this.stripInternalFields(params);
        return {
            ...cleanParams,
            description: `${order.outletName}商品`.slice(0, 127),
            amount: { total: Number(order.totalAmountFen), currency: 'CNY' },
            payer: { ...(cleanParams.payer || {}), openid: callerOpenId },
        };
    }

    async beforeQuery(params) {
        await this.requireOwnedOrder(params);
        return this.stripInternalFields(params);
    }

    async beforeClose(params) {
        const order = await this.requireOwnedOrder(params);
        if (order.status !== 'pending_payment') throw new Error('当前订单不能关闭');
        return this.stripInternalFields(params);
    }

    /**
     * 退款属于资金操作，只允许业务管理员发起；当前业务仅支持整单原路退款。
     */
    async beforeRefund(params) {
        const admin = await this.requireAdmin(params);
        const order = params.out_trade_no
            ? await this.getOrder(params.out_trade_no)
            : await this.getOrderByTransactionId(params.transaction_id);
        if (!order) throw new Error('退款对应的业务订单不存在');
        if (typeof params.out_refund_no !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(params.out_refund_no)) {
            throw new Error('退款单号不合法');
        }

        // 先保存意图再请求渠道：回调可能先于 HTTP 响应到达。
        // 未知网络结果保持退款中，仅能用同一单号重试；不能换号绕过并发保护。
        return this.db.runTransaction(async (transaction) => {
            const ref = transaction.collection('orders').doc(order._id);
            const current = (await ref.get()).data;
            if (!current) throw new Error('退款对应的业务订单不存在');
            if (current.outRefundNo && current.outRefundNo !== params.out_refund_no) {
                throw new Error('订单已绑定其他退款单号，请查询原退款单');
            }
            const retrying = current.status === 'refunding' && current.outRefundNo === params.out_refund_no;
            if (!REFUNDABLE_STATUSES.has(current.status) && !retrying) throw new Error('当前订单不能退款');
            this.validateRefundAmount(current, params);
            const cleanParams = this.stripInternalFields(params);
            // 无论按哪种订单引用发起，都使用数据库中的商户订单号请求渠道。
            delete cleanParams.transaction_id;
            const request = {
                ...cleanParams,
                out_trade_no: current.outTradeNo,
                amount: { total: Number(current.totalAmountFen), refund: Number(current.totalAmountFen), currency: 'CNY' },
            };
            if (!retrying) {
                const now = new Date();
                await ref.update({
                    data: {
                        status: 'refunding',
                        outRefundNo: request.out_refund_no,
                        refundAmountFen: Number(current.totalAmountFen),
                        refundCurrency: 'CNY',
                        refundFromStatus: current.status,
                        refundRequestedAt: now,
                        refundRequestedBy: admin._id,
                        updatedAt: now,
                    },
                });
            }
            return request;
        });
    }

    validateRefundAmount(order, params) {
        const amount = params.amount || {};
        if (Number(amount.total) !== Number(order.totalAmountFen)
            || Number(amount.refund) !== Number(order.totalAmountFen)) {
            throw new Error('退款金额与业务订单不一致');
        }
        // 微信退款通知的 amount 不包含 currency；退款请求则统一补全 CNY。
        if (amount.currency !== undefined && amount.currency !== 'CNY') {
            throw new Error('退款币种与业务订单不一致');
        }
    }

    validateRefundBinding(order, params) {
        if (!order.outRefundNo || !params.out_refund_no || order.outRefundNo !== params.out_refund_no) {
            throw new Error('退款单号与已保存的退款意图不一致');
        }
        this.validateRefundAmount(order, params);
    }

    async beforeAdminQuery(params) {
        await this.requireAdmin(params);
        return this.stripInternalFields(params);
    }

    async handlerUnified(params) {
        const order = await this.getOrder(params.out_trade_no);
        if (!order) throw new Error('业务订单不存在');
        if (Number(params.amount && params.amount.total) !== Number(order.totalAmountFen)) {
            throw new Error('支付金额校验失败');
        }
        await this.db.collection('orders').doc(order._id).update({
            data: { paymentRequestedAt: new Date(), updatedAt: new Date() },
        });
        return true;
    }

    async handlerUnifiedTrigger(params) {
        const order = await this.getOrder(params.out_trade_no);
        if (!order) throw new Error('支付回调对应的业务订单不存在');
        if (params.trade_state !== 'SUCCESS') return true;
        if (Number(params.amount && params.amount.total) !== Number(order.totalAmountFen)) {
            throw new Error('支付回调金额与业务订单不一致');
        }
        if (params.payer && params.payer.openid && params.payer.openid !== order.buyerOpenId) {
            throw new Error('支付回调付款人与业务订单不一致');
        }

        await this.db.runTransaction(async (transaction) => {
            const ref = transaction.collection('orders').doc(order._id);
            const currentRes = await ref.get();
            const current = currentRes.data;
            if (!current) throw new Error('业务订单不存在');
            if (current.transactionId && current.transactionId !== params.transaction_id) {
                throw new Error('支付回调交易号与业务订单不一致');
            }
            // 已记录付款的订单可能正在退款或已经退款，原支付重放不得回退状态。
            if (PAYMENT_RECORDED_STATUSES.has(current.status)) return;

            const now = new Date();
            if (current.stockReleased || ['cancelled', 'expired'].includes(current.status)) {
                await ref.update({
                    data: {
                        status: 'payment_exception',
                        needsRefund: true,
                        transactionId: params.transaction_id || '',
                        paidAt: now,
                        updatedAt: now,
                    },
                });
                return;
            }
            if (current.status !== 'pending_payment') {
                throw new Error('支付回调对应的订单状态异常');
            }

            for (const item of current.items || []) {
                const productRef = transaction.collection('store_products').doc(item.productId);
                const productRes = await productRef.get();
                if (!productRes.data) continue;
                await productRef.update({
                    data: {
                        salesCount: Number(productRes.data.salesCount || 0) + Number(item.quantity || 0),
                        updatedAt: now,
                    },
                });
            }
            await ref.update({
                data: {
                    status: 'paid',
                    transactionId: params.transaction_id || '',
                    paidAt: now,
                    updatedAt: now,
                },
            });
        });
        return true;
    }

    async handlerRefund(params) {
        const order = await this.getOrder(params.out_trade_no);
        if (!order) throw new Error('退款对应的业务订单不存在');
        await this.db.runTransaction(async (transaction) => {
            const ref = transaction.collection('orders').doc(order._id);
            const current = (await ref.get()).data;
            if (!current) throw new Error('退款对应的业务订单不存在');
            this.validateRefundBinding(current, params);
            if (current.status === 'refunded') return;
            if (current.status !== 'refunding') throw new Error('退款对应的订单状态异常');
            if (current.refundAcceptedAt) return;
            const now = new Date();
            await ref.update({ data: { refundAcceptedAt: now, updatedAt: now } });
        });
        return true;
    }

    async handlerRefundTrigger(params) {
        const order = await this.getOrder(params.out_trade_no);
        if (!order) throw new Error('退款回调对应的业务订单不存在');
        await this.db.runTransaction(async (transaction) => {
            const ref = transaction.collection('orders').doc(order._id);
            const current = (await ref.get()).data;
            if (!current) throw new Error('退款回调对应的业务订单不存在');
            this.validateRefundBinding(current, params);
            if (current.status === 'refunded') return;
            if (current.status !== 'refunding') throw new Error('退款回调对应的订单状态异常');
            const refunded = params.refund_status === 'SUCCESS';
            const now = new Date();
            const data = {
                status: refunded ? 'refunded' : 'refunding',
                refundId: params.refund_id || '',
                refundStatus: params.refund_status || '',
                refundedAt: refunded ? now : null,
                updatedAt: now,
            };
            if (refunded) data.needsRefund = false;
            await ref.update({ data });
        });
        return true;
    }

    async handlerTransfer() {
        throw new Error('鹏宇优选未启用商家转账');
    }

    async handlerTransferTrigger() {
        throw new Error('鹏宇优选未启用商家转账');
    }
}

module.exports = OrderService;
