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
const PAYMENT_RECORDED_STATUSES = new Set(['paid', 'delivering', 'completed', 'payment_exception', 'refunding', 'refunded', 'seller_delivered', 'settlement_available', 'disputed']);
const REFUNDABLE_STATUSES = new Set(['paid', 'delivering', 'completed', 'payment_exception', 'seller_delivered', 'settlement_available']);

class OrderService {
    constructor(database = defaultDatabase) {
        this.db = database;
    }

    async getOrder(outTradeNo) {
        if (!outTradeNo) return null;
        return this.findOrder({ outTradeNo });
    }

    async getOrderByTransactionId(transactionId) {
        if (!transactionId) return null;
        return this.findOrder({ transactionId });
    }

    async findOrder(where) {
        const matches = [];
        for (const collectionName of ['orders', 'market_sale_orders', 'market_c2c_orders']) {
            try {
                const res = await this.db.collection(collectionName).where(where).limit(2).get();
                if (res.data.length > 1) throw new Error('商户订单号不唯一');
                if (res.data[0]) {
                    matches.push({
                        ...res.data[0],
                        _collectionName: collectionName,
                        _businessType: collectionName === 'market_sale_orders'
                            ? 'market'
                            : (collectionName === 'market_c2c_orders' ? 'c2c_market' : 'store'),
                    });
                }
            } catch (error) {
                const message = String((error && (error.errMsg || error.message)) || error);
                if (!message.includes('collection not exists')) throw error;
            }
        }
        if (matches.length > 1) throw new Error('商户订单号跨业务不唯一');
        return matches[0] || null;
    }

    orderRef(database, order) {
        return database.collection(order._collectionName || 'orders').doc(order._id);
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
        const requestedTotal = Number(params.amount && params.amount.total);
        return this.db.runTransaction(async (transaction) => {
            const ref = this.orderRef(transaction, order);
            const current = (await ref.get()).data;
            if (!current || current.buyerOpenId !== callerOpenId) throw new Error('业务订单不存在');
            if (current.status !== 'pending_payment') throw new Error('业务订单状态不可支付');
            if (new Date(current.expiresAt).getTime() <= Date.now()) throw new Error('业务订单已超时');
            if (requestedTotal !== Number(current.totalAmountFen)) {
                throw new Error('支付金额与业务订单不一致');
            }

            // 必须在请求微信预下单之前落库，关闭“正在下单时被取消并释放库存”的竞态窗口。
            const now = new Date();
            if (!current.paymentRequestedAt) {
                await ref.update({ data: {
                    paymentRequestedAt: now,
                    paymentStatus: 'preparing',
                    updatedAt: now,
                } });
            }
            // 只构造微信 API 真正需要的字段，不透传客户端自带的 appid/mchid/notify_url 等参数。
            const c2cTitle = order._businessType === 'c2c_market'
                && current.goodsSnapshot && current.goodsSnapshot.title;
            return {
                out_trade_no: current.outTradeNo,
                description: String(current.description || (c2cTitle ? `校园闲置 · ${c2cTitle}` : `${current.outletName || '鹏宇优选'}商品`)).slice(0, 127),
                amount: { total: Number(current.totalAmountFen), currency: 'CNY' },
                payer: { openid: callerOpenId },
                time_expire: new Date(current.expiresAt).toISOString().replace(/\.\d{3}Z$/, 'Z'),
            };
        });
    }

    async beforeQuery(params) {
        const order = await this.requireOwnedOrder(params);
        return params.out_trade_no
            ? { out_trade_no: order.outTradeNo }
            : { transaction_id: order.transactionId };
    }

    async beforeClose(params) {
        const order = await this.requireOwnedOrder(params);
        if (!['pending_payment', 'payment_exception'].includes(order.status)) {
            throw new Error('当前订单不能关闭');
        }
        return { out_trade_no: order.outTradeNo };
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
            const ref = this.orderRef(transaction, order);
            const current = (await ref.get()).data;
            if (!current) throw new Error('退款对应的业务订单不存在');
            if (current.outRefundNo && current.outRefundNo !== params.out_refund_no) {
                throw new Error('订单已绑定其他退款单号，请查询原退款单');
            }
            const retrying = current.status === 'refunding' && current.outRefundNo === params.out_refund_no;
            if (!REFUNDABLE_STATUSES.has(current.status) && !retrying) throw new Error('当前订单不能退款');
            // C2C 卖方一旦进入结算申请或已经完成转账，绝不能再走原路退款，
            // 否则会形成“卖方已收款、买方又退款”的双重资金风险。
            if (order._businessType === 'c2c_market' && current.payoutStatus && current.payoutStatus !== 'not_requested') {
                throw new Error('卖家结算处理中，不能直接发起退款');
            }
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
                const refundIntent = {
                        status: 'refunding',
                        outRefundNo: request.out_refund_no,
                        refundAmountFen: Number(current.totalAmountFen),
                        refundCurrency: 'CNY',
                        refundFromStatus: current.status,
                        refundRequestedAt: now,
                        refundRequestedBy: admin._id,
                        updatedAt: now,
                    };
                if (order._businessType === 'c2c_market') refundIntent.settlementStatus = 'refund_pending';
                await ref.update({ data: refundIntent });
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
        return { out_refund_no: params.out_refund_no };
    }

    async handlerUnified(params) {
        const order = await this.getOrder(params.out_trade_no);
        if (!order) throw new Error('业务订单不存在');
        if (Number(params.amount && params.amount.total) !== Number(order.totalAmountFen)) {
            throw new Error('支付金额校验失败');
        }
        await this.db.runTransaction(async (transaction) => {
            const ref = this.orderRef(transaction, order);
            const current = (await ref.get()).data;
            if (!current) throw new Error('业务订单不存在');
            const now = new Date();
            const patch = { prepayCreatedAt: now, updatedAt: now };
            if (current.status === 'pending_payment'
                && !['paid', 'paid_after_close'].includes(current.paymentStatus)) {
                patch.paymentStatus = 'prepay_created';
            }
            await ref.update({ data: patch });
        });
        return true;
    }

    async handlerClose(params) {
        const order = await this.getOrder(params.out_trade_no);
        if (!order) throw new Error('业务订单不存在');
        await this.db.runTransaction(async (transaction) => {
            const ref = this.orderRef(transaction, order);
            const current = (await ref.get()).data;
            if (!current) throw new Error('业务订单不存在');
            if (PAYMENT_RECORDED_STATUSES.has(current.status) && current.status !== 'payment_exception') return;
            if (!['pending_payment', 'payment_exception'].includes(current.status)) return;
            if (current.needsRefund || ['paid', 'paid_after_close'].includes(current.paymentStatus)) return;

            const now = new Date();
            if (order._businessType === 'market' && current.inventoryId) {
                const inventoryRef = transaction.collection('market_inventory').doc(current.inventoryId);
                const inventory = (await inventoryRef.get()).data;
                if (inventory && inventory.status === 'locked' && inventory.saleOrderId === current._id) {
                    await inventoryRef.update({ data: {
                        status: 'on_sale',
                        saleOrderId: '',
                        lockExpiresAt: null,
                        version: Number(inventory.version || 0) + 1,
                        updatedAt: now,
                    } });

                    const sourceGoodsId = inventory.sourceGoodsId || inventory.goodsId;
                    if (sourceGoodsId) {
                        const goodsRef = transaction.collection('goods').doc(sourceGoodsId);
                        const goods = (await goodsRef.get()).data;
                        if (goods) await goodsRef.update({ data: {
                            marketAvailability: 'on_sale',
                            updatedAt: now,
                        } });
                    }
                }
            } else if (order._businessType === 'c2c_market' && current.goodsId) {
                const goodsRef = transaction.collection('goods').doc(current.goodsId);
                const goods = (await goodsRef.get()).data;
                if (goods && goods.status === 'locked' && goods.c2cOrderId === current._id) {
                    await goodsRef.update({ data: {
                        status: 'on_sale',
                        c2cOrderId: '',
                        c2cTradeStatus: 'cancelled',
                        c2cLockExpiresAt: null,
                        updatedAt: now,
                    } });
                }
            }
            await ref.update({ data: {
                status: 'cancelled',
                paymentStatus: 'closed',
                stockReleased: true,
                cancelledAt: now,
                updatedAt: now,
            } });
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
            const ref = this.orderRef(transaction, order);
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
                if (order._businessType === 'c2c_market' && current.goodsId) {
                    const goodsRef = transaction.collection('goods').doc(current.goodsId);
                    const goods = (await goodsRef.get()).data;
                    if (goods && goods.c2cOrderId === current._id) {
                        await goodsRef.update({ data: {
                            status: 'trading',
                            c2cTradeStatus: 'payment_exception',
                            updatedAt: now,
                        } });
                    }
                }
                await ref.update({
                    data: {
                        status: 'payment_exception',
                        paymentStatus: 'paid_after_close',
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

            if (order._businessType === 'market') {
                const inventoryRef = transaction.collection('market_inventory').doc(current.inventoryId);
                const inventory = (await inventoryRef.get()).data;
                if (!inventory || inventory.saleOrderId !== current._id) {
                    throw new Error('市场订单库存绑定不一致');
                }
                await inventoryRef.update({ data: {
                    status: 'sold',
                    soldOrderId: current._id,
                    soldAt: now,
                    updatedAt: now,
                } });
                const sourceGoodsId = inventory.sourceGoodsId || inventory.goodsId;
                if (sourceGoodsId) {
                    const goodsRef = transaction.collection('goods').doc(sourceGoodsId);
                    const goods = (await goodsRef.get()).data;
                    if (goods) await goodsRef.update({ data: {
                        status: 'sold',
                        marketAvailability: 'sold',
                        updatedAt: now,
                    } });
                }
            } else if (order._businessType === 'c2c_market') {
                const goodsRef = transaction.collection('goods').doc(current.goodsId);
                const goods = (await goodsRef.get()).data;
                if (!goods || goods.status !== 'locked' || goods.c2cOrderId !== current._id) {
                    throw new Error('C2C 订单商品锁定状态不一致');
                }
                await goodsRef.update({ data: {
                    status: 'trading',
                    c2cTradeStatus: 'paid',
                    c2cLockExpiresAt: null,
                    updatedAt: now,
                } });
            } else {
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
            }
            await ref.update({
                data: {
                    status: 'paid',
                    paymentStatus: 'paid',
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
            const ref = this.orderRef(transaction, order);
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
            const ref = this.orderRef(transaction, order);
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
            if (order._businessType === 'c2c_market' && refunded) {
                data.settlementStatus = 'refund_completed';
                const goodsRef = transaction.collection('goods').doc(current.goodsId);
                const goods = (await goodsRef.get()).data;
                // 退款并不等于卖方已取回实物：保持交易锁定，需线下退回后由运营处理。
                if (goods && goods.c2cOrderId === current._id) {
                    await goodsRef.update({ data: {
                        status: 'trading',
                        c2cTradeStatus: 'refunded_pending_return',
                        updatedAt: now,
                    } });
                }
            }
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
