/**
 * 二手回收款领取服务。
 *
 * 客户端只提交 claim_id。收款人、金额、商户单号、场景和报备信息都从
 * market 云函数已经固化的领取单读取，避免把商家转账变成任意转账入口。
 */
const crypto = require('crypto');
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const defaultDatabase = cloud.database();
const OFFICIAL_STATES = new Set([
    'ACCEPTED', 'PROCESSING', 'WAIT_USER_CONFIRM', 'TRANSFERING',
    'SUCCESS', 'FAIL', 'CANCELING', 'CANCELLED',
]);
const TERMINAL_FAILURE_STATES = new Set(['FAIL', 'CANCELLED']);
const CLAIM_STATUSES = new Set([
    'reserved', 'dispatching', 'wait_user_confirm', 'accepted', 'processing',
    'success', 'fail', 'canceling', 'cancelled', 'needs_review',
]);

const cleanId = (value, fieldName) => {
    const result = typeof value === 'string' ? value.trim() : '';
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(result)) throw new Error(`${fieldName} 不合法`);
    return result;
};

const cleanBillNo = (value) => {
    const result = typeof value === 'string' ? value.trim() : '';
    if (!/^[A-Za-z0-9]{1,32}$/.test(result)) throw new Error('回收款商户单号不合法');
    return result;
};

const cleanGoodsName = (value) => {
    const result = typeof value === 'string' ? value.trim() : '';
    if (!result || result.length > 32) throw new Error('回收商品名称不合法');
    return result;
};

const getChannelStatus = (claim) => String(
    (claim && (claim.channelStatus || claim.channelState)) || 'NOT_STARTED'
).toUpperCase();

const claimStatusForChannel = (state) => ({
    ACCEPTED: 'accepted',
    PROCESSING: 'processing',
    WAIT_USER_CONFIRM: 'wait_user_confirm',
    TRANSFERING: 'processing',
    SUCCESS: 'success',
    FAIL: 'fail',
    CANCELING: 'canceling',
    CANCELLED: 'cancelled',
}[state] || 'needs_review');

const financeEntryId = (type, claimId) => (
    `fin_${crypto.createHash('sha256').update(`${type}:${claimId}`).digest('hex').slice(0, 36)}`
);

const publicResult = (claim, payConfig) => {
    const state = getChannelStatus(claim);
    return {
        claim_id: claim._id,
        state: state === 'NOT_STARTED' ? 'READY' : state,
        // 查询接口不会再次返回 package_info。保留首次创建转账单得到的凭证，
        // WAIT_USER_CONFIRM/TRANSFERING 时均可让用户继续打开微信确认页。
        package_info: ['WAIT_USER_CONFIRM', 'TRANSFERING'].includes(state)
            ? (claim.packageInfo || '') : '',
        mchId: payConfig.mchId,
        appId: payConfig.appId,
    };
};

class MarketTransferService {
    constructor(strategy, payConfig, database = defaultDatabase) {
        this.strategy = strategy;
        this.payConfig = payConfig;
        this.db = database;
    }

    requireCaller(params) {
        const openid = params && params._callerOpenId;
        if (!openid) throw new Error('无法确认当前领取用户');
        return openid;
    }

    async getClaim(claimId) {
        const res = await this.db.collection('market_claims').doc(claimId).get();
        return res.data || null;
    }

    async requireOwnedClaim(params) {
        const callerOpenId = this.requireCaller(params);
        const claimId = cleanId(params && params.claim_id, 'claim_id');
        const claim = await this.getClaim(claimId);
        if (!claim || claim.ownerOpenId !== callerOpenId) throw new Error('回收款领取单不存在');
        return claim;
    }

    validateStoredClaim(claim) {
        if (!claim || !CLAIM_STATUSES.has(claim.status)) throw new Error('当前回收款状态不可领取');
        const amount = Number(claim.transferAmountFen);
        if (!Number.isInteger(amount) || amount < 10 || amount >= 200000) {
            throw new Error('回收款金额超出当前安全范围');
        }
        if (claim.sceneId !== '1010') throw new Error('回收款转账场景不一致');
        cleanBillNo(claim.outBillNo);
        cleanGoodsName(claim.goodsTitleSnapshot);
        if (typeof claim.ownerOpenId !== 'string' || !claim.ownerOpenId.trim() || claim.ownerOpenId.length > 64) {
            throw new Error('回收款收款人信息不合法');
        }
        if (!this.payConfig.appId || !this.payConfig.mchId) throw new Error('商家转账 AppID 或商户号未配置');
        if (!/^https:\/\//.test(this.payConfig.transferNotifyUrl || '')
            || this.payConfig.transferNotifyUrl.includes('?')) {
            throw new Error('商家转账通知地址未正确配置');
        }
    }

    buildRequest(claim) {
        this.validateStoredClaim(claim);
        const goodsName = cleanGoodsName(claim.goodsTitleSnapshot);
        return {
            appid: this.payConfig.appId,
            out_bill_no: cleanBillNo(claim.outBillNo),
            transfer_scene_id: '1010',
            openid: claim.ownerOpenId,
            transfer_amount: Number(claim.transferAmountFen),
            transfer_remark: `二手回收款-${goodsName}`.slice(0, 32),
            notify_url: this.payConfig.transferNotifyUrl,
            user_recv_perception: '二手回收货款',
            transfer_scene_report_infos: [{
                info_type: '回收商品名称',
                info_content: goodsName,
            }],
        };
    }

    async markRequesting(claim) {
        return this.db.runTransaction(async (transaction) => {
            const ref = transaction.collection('market_claims').doc(claim._id);
            const current = (await ref.get()).data;
            if (!current || current.ownerOpenId !== claim.ownerOpenId) throw new Error('回收款领取单不存在');
            const channelStatus = getChannelStatus(current);
            if (current.status !== 'reserved' || channelStatus !== 'NOT_STARTED') {
                return { claim: current, acquired: false };
            }
            const now = new Date();
            const patch = {
                status: 'dispatching',
                channelStatus: 'REQUESTING',
                dispatchStatus: 'requesting',
                requestStartedAt: now,
                updatedAt: now,
            };
            await ref.update({ data: patch });
            return { claim: { ...current, ...patch }, acquired: true };
        });
    }

    async markUnknown(claimId, reason) {
        await this.db.runTransaction(async (transaction) => {
            const ref = transaction.collection('market_claims').doc(claimId);
            const current = (await ref.get()).data;
            const channelStatus = getChannelStatus(current);
            if (!current || channelStatus === 'SUCCESS' || TERMINAL_FAILURE_STATES.has(channelStatus)) return;
            const now = new Date();
            await ref.update({ data: {
                status: 'needs_review',
                channelStatus: 'UNKNOWN',
                dispatchStatus: 'query_required',
                failureReason: String(reason || '渠道结果待核实').slice(0, 160),
                updatedAt: now,
            } });
        });
    }

    validateChannelResult(claim, channel) {
        if (!channel || typeof channel !== 'object') throw new Error('微信支付返回格式异常');
        if (channel.out_bill_no && channel.out_bill_no !== claim.outBillNo) {
            throw new Error('微信转账单与领取意图不一致');
        }
        if (channel.transfer_amount !== undefined
            && Number(channel.transfer_amount) !== Number(claim.transferAmountFen)) {
            throw new Error('微信转账金额与领取意图不一致');
        }
        if (channel.openid && channel.openid !== claim.ownerOpenId) {
            throw new Error('微信转账收款人与领取意图不一致');
        }
        if (channel.mch_id && String(channel.mch_id) !== String(this.payConfig.mchId)) {
            throw new Error('微信转账商户号与当前配置不一致');
        }
        const state = String(channel.state || '').toUpperCase();
        if (!OFFICIAL_STATES.has(state)) throw new Error('微信转账状态不可识别');
        if (state === 'WAIT_USER_CONFIRM' && !channel.package_info && !claim.packageInfo) {
            throw new Error('微信转账缺少确认收款凭证');
        }
        return state;
    }

    async applyChannelResult(claimId, channel) {
        return this.db.runTransaction(async (transaction) => {
            const ref = transaction.collection('market_claims').doc(claimId);
            const current = (await ref.get()).data;
            if (!current) throw new Error('回收款领取单不存在');
            const state = this.validateChannelResult(current, channel);
            const previousState = getChannelStatus(current);

            if (previousState === 'SUCCESS') return current;
            if (TERMINAL_FAILURE_STATES.has(previousState)) {
                if (previousState === state) return current;
                throw new Error('微信转账终态冲突，请人工核对');
            }

            const now = new Date();
            const status = claimStatusForChannel(state);
            const update = {
                status,
                channelStatus: state,
                channelTransferBillNo: channel.transfer_bill_no || current.channelTransferBillNo || '',
                packageInfo: ['WAIT_USER_CONFIRM', 'TRANSFERING'].includes(state)
                    ? (channel.package_info || current.packageInfo || '') : '',
                dispatchStatus: state === 'WAIT_USER_CONFIRM'
                    ? 'waiting_user' : (state === 'SUCCESS' || TERMINAL_FAILURE_STATES.has(state))
                        ? 'completed' : 'processing',
                failureCode: TERMINAL_FAILURE_STATES.has(state) ? String(channel.fail_reason || '').slice(0, 64) : '',
                failureReason: TERMINAL_FAILURE_STATES.has(state) ? String(channel.fail_reason || '').slice(0, 160) : '',
                channelUpdatedAt: now,
                updatedAt: now,
            };
            if (state === 'SUCCESS') update.succeededAt = now;
            if (TERMINAL_FAILURE_STATES.has(state)) update.failedAt = now;
            await ref.update({ data: update });

            if (current.recoveryOrderId) {
                const recoveryRef = transaction.collection('market_recovery_orders').doc(current.recoveryOrderId);
                const recovery = (await recoveryRef.get()).data;
                if (recovery && recovery.ownerOpenId === current.ownerOpenId
                    && recovery.activeClaimId === current._id) {
                    const recoveryUpdate = {
                        claimStatus: status,
                        payableStatus: state === 'SUCCESS'
                            ? 'paid' : TERMINAL_FAILURE_STATES.has(state) ? 'available' : 'reserved',
                        activeClaimId: TERMINAL_FAILURE_STATES.has(state) ? '' : current._id,
                        updatedAt: now,
                    };
                    if (state === 'SUCCESS') recoveryUpdate.claimPaidAt = now;
                    if (TERMINAL_FAILURE_STATES.has(state)) recoveryUpdate.lastFailedClaimId = current._id;
                    await recoveryRef.update({ data: recoveryUpdate });
                }
            }

            if (state === 'SUCCESS' || TERMINAL_FAILURE_STATES.has(state)) {
                const entryType = state === 'SUCCESS' ? 'claim_paid' : 'claim_released';
                await transaction.collection('market_finance_entries')
                    .doc(financeEntryId(entryType, current._id)).set({ data: {
                        type: entryType,
                        businessType: 'market_recovery_claim',
                        businessId: current._id,
                        recoveryOrderId: current.recoveryOrderId || '',
                        ownerUserId: current.ownerUserId || '',
                        amountFen: Number(current.transferAmountFen),
                        channelState: state,
                        createdAt: now,
                    } });
            }
            return { ...current, ...update };
        });
    }

    async start(params) {
        let claim = await this.requireOwnedClaim(params);
        this.validateStoredClaim(claim);
        const channelStatus = getChannelStatus(claim);
        if (channelStatus === 'SUCCESS' || claim.status === 'success') {
            return { status: 200, data: publicResult(claim, this.payConfig), verified: true };
        }
        if (TERMINAL_FAILURE_STATES.has(channelStatus) || ['fail', 'cancelled'].includes(claim.status)) {
            throw new Error('本次回收款转账已终止，请从回收单重新申请领取');
        }
        if (channelStatus !== 'NOT_STARTED') return this.query(params);

        const reservation = await this.markRequesting(claim);
        claim = reservation.claim;
        if (!reservation.acquired) return this.query(params);

        const request = this.buildRequest(claim);
        let result;
        try {
            result = await this.strategy.transfer(request);
        } catch (error) {
            await this.markUnknown(claim._id, '发起请求结果未知');
            throw error;
        }
        if (!result || result.verified !== true) {
            await this.markUnknown(claim._id, '响应未通过验签');
            throw new Error('微信支付 API 响应未通过验签');
        }
        if (result.status !== 200) {
            await this.markUnknown(claim._id, result.data && (result.data.code || result.data.message));
            return result;
        }
        const updated = await this.applyChannelResult(claim._id, result.data);
        return { ...result, data: publicResult(updated, this.payConfig) };
    }

    async query(params) {
        const claim = await this.requireOwnedClaim(params);
        this.validateStoredClaim(claim);
        if (getChannelStatus(claim) === 'NOT_STARTED' && claim.status === 'reserved') {
            return { status: 200, data: publicResult(claim, this.payConfig), verified: true };
        }
        const result = await this.strategy.queryTransferBill({ out_bill_no: cleanBillNo(claim.outBillNo) });
        if (!result || result.verified !== true) throw new Error('微信支付 API 响应未通过验签');
        if (result.status !== 200) return result;
        const updated = await this.applyChannelResult(claim._id, result.data);
        return { ...result, data: publicResult(updated, this.payConfig) };
    }

    async handleCallback(channel) {
        if (!channel || typeof channel.out_bill_no !== 'string') throw new Error('转账通知缺少商户单号');
        const callbackState = String(channel.state || '').toUpperCase();
        if (callbackState !== 'SUCCESS' && !TERMINAL_FAILURE_STATES.has(callbackState)) {
            throw new Error('转账通知不是微信定义的终态');
        }
        const outBillNo = cleanBillNo(channel.out_bill_no);
        const res = await this.db.collection('market_claims').where({ outBillNo }).limit(2).get();
        if (!res.data || res.data.length !== 1) throw new Error('转账通知对应的领取单不存在或不唯一');
        const updated = await this.applyChannelResult(res.data[0]._id, channel);
        return publicResult(updated, this.payConfig);
    }
}

module.exports = MarketTransferService;
