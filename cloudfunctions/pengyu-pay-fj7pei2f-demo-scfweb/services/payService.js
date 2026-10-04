/**
 * 支付服务（策略入口）
 * 主动请求（下单/退款/转账）永远走 SDK 自签名直连微信
 * 回调处理根据 signMode 决定：自己验签解密 或 读取集成中心已解密的明文
 */
const { signMode, verifyMode, payConfig } = require('../config/config');
const SdkStrategy = require('./strategies/sdkStrategy');
const OrderService = require('./orderService');
const MarketTransferService = require('./marketTransferService');

class PayService {

    constructor() {
        this.orderService = new OrderService();

        // 永远使用 SDK 策略（自己签名直连微信）
        this.strategy = new SdkStrategy(payConfig);
        this.marketTransferService = new MarketTransferService(this.strategy, payConfig);
        console.log(`[PayService] 签名模式: SDK | 回调处理: ${signMode} | 验签方式: ${verifyMode}`);
    }

    // ========== 统一下单（支持多平台）==========

    /**
     * 统一下单
     * @param {Object} params - 下单参数
     * @param {string} payType - 支付类型: jsapi | h5 | native
     * @returns {Object} 微信支付返回结果
     */
    async unifiedOrder(params, payType = 'jsapi') {
        try {
            // 先从业务数据库核对订单、付款人和金额，再调用微信支付。
            // beforeUnified 会删除内部鉴权字段，并以服务端订单金额覆盖前端参数。
            params = await this.orderService.beforeUnified(params);

            // 商户、AppID 和回调地址只能来自服务端环境变量。beforeUnified 已经
            // 将请求压缩成业务订单白名单，客户端不能切换商户或改写回调地址。
            if (!payConfig.appId || !payConfig.mchId || !payConfig.jsapiNotifyUrl) {
                throw new Error('微信支付 AppID、商户号或支付回调地址未配置');
            }
            params.appid = payConfig.appId;
            params.mchid = payConfig.mchId;
            params.notify_url = payConfig.jsapiNotifyUrl;
            if (payType !== 'jsapi') delete params.payer;

            // 根据支付类型调不同接口
            let result;
            switch (payType) {
                case 'h5':
                    result = await this.strategy.h5(params);
                    break;
                case 'native':
                    result = await this.strategy.native(params);
                    break;
                case 'jsapi':
                default:
                    result = await this.strategy.jsapi(params);
                    break;
            }

            if (result.status === 200 && result.data) {
                await this.orderService.handlerUnified(params);
                return result;
            } else {
                console.error(`[PayService] ${payType} 下单失败: status=${result?.status}, code=${result?.data?.code}, message=${result?.data?.message}`);
                return result;
            }
        } catch (err) {
            console.error('[PayService] unifiedOrder error:', err);
            throw err;
        }
    }

    // ========== 回调处理 ==========

    /**
     * 支付回调处理
     * SDK 模式：验签 → 解密 → 处理业务
     * 网关模式：集成中心已解密，明文在 body.ParsedContent 中
     * @param {Object} callbackParams - 回调参数
     * @returns {Object} 解密后的支付结果
     */
    async handlePayCallback(callbackParams) {
        let payResult;

        if (signMode === 'gateway' && callbackParams.decryptedData) {
            // 网关模式：集成中心已解密，直接使用明文
            payResult = callbackParams.decryptedData;
        } else {
            // SDK 模式（或网关模式但无解密数据时回退）：自己验签 + 解密
            const verified = await this.strategy.verifySign(callbackParams);
            if (!verified) {
                console.error('[PayService] 支付回调验签失败');
                return null;
            }

            const { ciphertext, associated_data, nonce } = callbackParams.body.resource;
            payResult = await this.strategy.decryptResource(ciphertext, associated_data, nonce);
        }

        console.info('[PayService] 支付回调结果: out_trade_no=%s, trade_state=%s', payResult?.out_trade_no, payResult?.trade_state);

        // 必须等待业务事务成功后才向微信返回 SUCCESS。
        // 如果数据库更新失败，异常会传到控制器并返回 FAIL，让微信按规则重试。
        await this.orderService.handlerUnifiedTrigger(payResult);

        return payResult;
    }

    /**
     * 退款回调处理
     */
    async handleRefundCallback(callbackParams) {
        let refundResult;

        if (signMode === 'gateway' && callbackParams.decryptedData) {
            // 网关模式：集成中心已解密，直接使用明文
            refundResult = callbackParams.decryptedData;
        } else {
            // SDK 模式（或网关模式但无解密数据时回退）：自己验签 + 解密
            const verified = await this.strategy.verifySign(callbackParams);
            if (!verified) {
                console.error('[PayService] 退款回调验签失败');
                return null;
            }

            const { ciphertext, associated_data, nonce } = callbackParams.body.resource;
            refundResult = await this.strategy.decryptResource(ciphertext, associated_data, nonce);
        }

        console.info('[PayService] 退款回调结果: out_refund_no=%s, refund_status=%s', refundResult?.out_refund_no, refundResult?.refund_status);

        await this.orderService.handlerRefundTrigger(refundResult);

        return refundResult;
    }

    // ========== 查询 ==========

    async queryOrderByOutTradeNo(params) {
        params = await this.orderService.beforeQuery(params);
        const result = await this.strategy.query(params);
        if (result?.status === 200 && result.data?.trade_state === 'SUCCESS') {
            // 主动查单是支付回调丢失时的兜底，同样走幂等业务事务。
            await this.orderService.handlerUnifiedTrigger(result.data);
        } else if (result?.status === 200 && result.data?.trade_state === 'CLOSED') {
            await this.orderService.handlerClose(params);
        }
        return result;
    }

    async queryOrderByTransactionId(params) {
        params = await this.orderService.beforeQuery(params);
        const result = await this.strategy.query(params);
        if (result?.status === 200 && result.data?.trade_state === 'SUCCESS') {
            await this.orderService.handlerUnifiedTrigger(result.data);
        } else if (result?.status === 200 && result.data?.trade_state === 'CLOSED') {
            // 查询响应携带 out_trade_no，使用它绑定并关闭本地订单。
            await this.orderService.handlerClose({ out_trade_no: result.data.out_trade_no });
        }
        return result;
    }

    // ========== 关闭订单 ==========

    async closeOrder(params) {
        params = await this.orderService.beforeClose(params);
        const result = await this.strategy.close(params);
        if (result && result.status >= 200 && result.status < 300) {
            // 只有微信明确关单成功，才取消本地订单并释放市场库存。
            await this.orderService.handlerClose(params);
        }
        return result;
    }

    // ========== 退款 ==========

    async refund(params) {
        try {
            params = await this.orderService.beforeRefund(params);
            params.notify_url = payConfig.refundNotifyUrl;
            const result = await this.strategy.refund(params);

            if (result.status === 200 && result.data) {
                await this.orderService.handlerRefund(params);
                return result;
            } else {
                console.error('[PayService] 退款失败: status=%s, code=%s, message=%s', result?.status, result?.data?.code, result?.data?.message);
                return result;
            }
        } catch (err) {
            console.error('[PayService] refund error:', err);
            throw err;
        }
    }

    async queryRefund(params) {
        params = await this.orderService.beforeAdminQuery(params);
        return this.strategy.queryRefund(params);
    }

    // ========== 商家转账 ==========

    /**
     * 发起商家转账（升级版 - 单笔模式）
     * 文档：https://pay.weixin.qq.com/doc/v3/merchant/4012716434
     *
     * ⚠️ 重要：
     * 1. 受理成功 ≠ 转账成功，必须通过查单或回调确认最终状态
     * 2. 系统错误/资金不足/频率超限时，必须用相同参数重试，勿更换单号
     * 3. user_name 字段规则：< 0.3元不填，≥ 2000元必填
     */
    async transfer() {
        // 本项目不使用商家转账，保持显式关闭，避免把支付函数误当成转账接口。
        throw new Error('鹏宇优选未启用商家转账');
    }

    /**
     * 商户单号查询转账单（升级版）
     */
    async queryTransferBill(params) {
        throw new Error('鹏宇优选未启用商家转账');
    }

    /**
     * 微信单号查询转账单（升级版）
     */
    async queryTransferBillByNo(params) {
        throw new Error('鹏宇优选未启用商家转账');
    }

    /**
     * 依据服务端已保存的回收款领取单发起商家转账。
     * 客户端只能传 claim_id，所有资金字段由 MarketTransferService 读取并校验。
     */
    async startMarketClaimTransfer(params) {
        return this.marketTransferService.start(params);
    }

    async queryMarketClaimTransfer(params) {
        return this.marketTransferService.query(params);
    }

    /**
     * 商家转账回调处理
     */
    async handleTransferCallback(callbackParams) {
        let transferResult;

        if (signMode === 'gateway' && callbackParams.decryptedData) {
            // 网关模式：集成中心已解密，直接使用明文
            transferResult = callbackParams.decryptedData;
        } else {
            // SDK 模式（或网关模式但无解密数据时回退）：自己验签 + 解密
            const verified = await this.strategy.verifySign(callbackParams);
            if (!verified) {
                console.error('[PayService] 转账回调验签失败');
                return null;
            }

            const { ciphertext, associated_data, nonce } = callbackParams.body.resource;
            transferResult = await this.strategy.decryptResource(ciphertext, associated_data, nonce);
        }

        console.info('[PayService] 转账回调结果: out_bill_no=%s, state=%s', transferResult?.out_bill_no, transferResult?.state);

        await this.marketTransferService.handleCallback(transferResult);

        return transferResult;
    }
}

module.exports = PayService;
