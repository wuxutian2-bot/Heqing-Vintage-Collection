const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
    if (request === 'wx-server-sdk') {
        return {
            DYNAMIC_CURRENT_ENV: 'test',
            init() {},
            database() { return {}; },
        };
    }
    return originalLoad.call(this, request, parent, isMain);
};
const MarketTransferService = require('../services/marketTransferService');
Module._load = originalLoad;

const clone = (value) => {
    if (value instanceof Date) return new Date(value);
    if (Array.isArray(value)) return value.map(clone);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]));
    }
    return value;
};

class FakeDatabase {
    constructor(seed = {}) {
        this.data = Object.fromEntries(Object.entries(seed).map(([name, rows]) => (
            [name, new Map(rows.map((row) => [row._id, clone(row)]))]
        )));
        this.transactionTail = Promise.resolve();
    }

    collection(name) {
        if (!this.data[name]) this.data[name] = new Map();
        const records = this.data[name];
        return {
            doc: (id) => ({
                async get() {
                    return { data: records.has(id) ? clone(records.get(id)) : null };
                },
                async update({ data }) {
                    const current = records.get(id);
                    if (!current) throw new Error(`missing ${name}/${id}`);
                    Object.assign(current, clone(data));
                    return { stats: { updated: 1 } };
                },
                async set({ data }) {
                    records.set(id, { ...clone(data), _id: id });
                    return { _id: id };
                },
            }),
            where: (query) => {
                let maximum = Infinity;
                const request = {
                    limit(value) { maximum = value; return request; },
                    async get() {
                        return {
                            data: Array.from(records.values())
                                .filter((row) => Object.entries(query).every(([key, value]) => row[key] === value))
                                .slice(0, maximum)
                                .map(clone),
                        };
                    },
                };
                return request;
            },
        };
    }

    async runTransaction(callback) {
        const previous = this.transactionTail;
        let release;
        this.transactionTail = new Promise((resolve) => { release = resolve; });
        await previous;
        const snapshot = Object.fromEntries(Object.entries(this.data).map(([name, rows]) => (
            [name, new Map(Array.from(rows, ([id, row]) => [id, clone(row)]))]
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

const claimSeed = (overrides = {}) => ({
    _id: 'claim-1',
    recoveryOrderId: 'recovery-1',
    ownerOpenId: 'owner-openid',
    transferAmountFen: 1888,
    outBillNo: 'PYRC202609050001',
    sceneId: '1010',
    goodsTitleSnapshot: '二手高等数学教材',
    status: 'reserved',
    channelState: '',
    ...overrides,
});

const config = {
    appId: 'wx-test-app',
    mchId: '1900000001',
    transferNotifyUrl: 'https://pay.example.test/wx-pay/transferTrigger',
};

const setup = ({ claim = claimSeed(), strategy = {} } = {}) => {
    const db = new FakeDatabase({
        market_claims: [claim],
        market_recovery_orders: [{
            _id: 'recovery-1',
            ownerOpenId: 'owner-openid',
            status: 'acquisition_completed',
            claimStatus: 'reserved',
            activeClaimId: 'claim-1',
        }],
    });
    return {
        db,
        service: new MarketTransferService(strategy, config, db),
        claim: () => db.data.market_claims.get('claim-1'),
        recovery: () => db.data.market_recovery_orders.get('recovery-1'),
    };
};

describe('MarketTransferService - trusted transfer intent', () => {
    it('accepts only claim_id as authority and builds all money fields from the saved claim', async () => {
        const calls = [];
        const strategy = {
            async transfer(request) {
                calls.push(clone(request));
                return {
                    status: 200,
                    verified: true,
                    data: {
                        out_bill_no: request.out_bill_no,
                        transfer_bill_no: 'wx-transfer-1',
                        transfer_amount: request.transfer_amount,
                        openid: request.openid,
                        state: 'WAIT_USER_CONFIRM',
                        package_info: 'affffddafdfafddffda==',
                    },
                };
            },
        };
        const { service, claim } = setup({ strategy });

        const result = await service.start({
            claim_id: 'claim-1',
            _callerOpenId: 'owner-openid',
            transfer_amount: 1,
            openid: 'forged-openid',
            out_bill_no: 'FORGED001',
            transfer_scene_id: '1000',
            transfer_scene_report_infos: [{ info_type: '伪造', info_content: '伪造' }],
        });

        assert.equal(calls.length, 1);
        assert.deepEqual(calls[0], {
            appid: 'wx-test-app',
            out_bill_no: 'PYRC202609050001',
            transfer_scene_id: '1010',
            openid: 'owner-openid',
            transfer_amount: 1888,
            transfer_remark: '二手回收款-二手高等数学教材',
            notify_url: config.transferNotifyUrl,
            user_recv_perception: '二手回收货款',
            transfer_scene_report_infos: [{
                info_type: '回收商品名称',
                info_content: '二手高等数学教材',
            }],
        });
        assert.equal(result.data.state, 'WAIT_USER_CONFIRM');
        assert.equal(result.data.package_info, 'affffddafdfafddffda==');
        assert.equal(claim().transferAmountFen, 1888);
        assert.equal(claim().ownerOpenId, 'owner-openid');
        assert.equal(claim().outBillNo, 'PYRC202609050001');
    });

    it('rejects a caller who does not own the claim before contacting WeChat Pay', async () => {
        let calls = 0;
        const { service } = setup({
            strategy: {
                async transfer() { calls += 1; throw new Error('must not be called'); },
                async queryTransferBill() { calls += 1; throw new Error('must not be called'); },
            },
        });

        await assert.rejects(() => service.start({
            claim_id: 'claim-1',
            _callerOpenId: 'other-openid',
        }), /领取单不存在/);
        assert.equal(calls, 0);
    });

    for (const amount of [9, 200000, 200001, 12.5]) {
        it(`rejects unsafe saved amount ${amount} before contacting the channel`, async () => {
            let calls = 0;
            const { service } = setup({
                claim: claimSeed({ transferAmountFen: amount }),
                strategy: { async transfer() { calls += 1; } },
            });
            await assert.rejects(() => service.start({
                claim_id: 'claim-1',
                _callerOpenId: 'owner-openid',
            }), /金额超出当前安全范围/);
            assert.equal(calls, 0);
        });
    }

    it('allows the largest amount below the current no-name-encryption boundary', async () => {
        const seen = [];
        const { service } = setup({
            claim: claimSeed({ transferAmountFen: 199999 }),
            strategy: {
                async transfer(request) {
                    seen.push(request.transfer_amount);
                    return {
                        status: 200,
                        verified: true,
                        data: {
                            out_bill_no: request.out_bill_no,
                            transfer_amount: request.transfer_amount,
                            openid: request.openid,
                            state: 'PROCESSING',
                        },
                    };
                },
            },
        });
        await service.start({ claim_id: 'claim-1', _callerOpenId: 'owner-openid' });
        assert.deepEqual(seen, [199999]);
    });
});

describe('MarketTransferService - idempotency and uncertain results', () => {
    it('reuses the saved bill number and queries the original transfer on a repeated call', async () => {
        const calls = { transfer: [], query: [] };
        const strategy = {
            async transfer(request) {
                calls.transfer.push(request.out_bill_no);
                return {
                    status: 200,
                    verified: true,
                    data: {
                        out_bill_no: request.out_bill_no,
                        transfer_amount: request.transfer_amount,
                        openid: request.openid,
                        state: 'WAIT_USER_CONFIRM',
                        package_info: 'same-package',
                    },
                };
            },
            async queryTransferBill(request) {
                calls.query.push(request.out_bill_no);
                return {
                    status: 200,
                    verified: true,
                    data: {
                        out_bill_no: request.out_bill_no,
                        transfer_amount: 1888,
                        openid: 'owner-openid',
                        state: 'WAIT_USER_CONFIRM',
                        package_info: 'same-package',
                    },
                };
            },
        };
        const { service } = setup({ strategy });

        await service.start({ claim_id: 'claim-1', _callerOpenId: 'owner-openid' });
        const repeated = await service.start({ claim_id: 'claim-1', _callerOpenId: 'owner-openid' });

        assert.deepEqual(calls.transfer, ['PYRC202609050001']);
        assert.deepEqual(calls.query, ['PYRC202609050001']);
        assert.equal(repeated.data.package_info, 'same-package');
    });

    it('marks a network outcome unknown and retries by querying the same bill instead of creating another transfer', async () => {
        const calls = { transfer: 0, query: [] };
        const strategy = {
            async transfer() {
                calls.transfer += 1;
                throw new Error('socket closed after write');
            },
            async queryTransferBill(request) {
                calls.query.push(request.out_bill_no);
                return {
                    status: 200,
                    verified: true,
                    data: {
                        out_bill_no: request.out_bill_no,
                        transfer_amount: 1888,
                        openid: 'owner-openid',
                        state: 'PROCESSING',
                    },
                };
            },
        };
        const { service, claim } = setup({ strategy });

        await assert.rejects(() => service.start({
            claim_id: 'claim-1', _callerOpenId: 'owner-openid',
        }), /socket closed/);
        assert.equal(claim().status, 'needs_review');
        assert.equal(claim().channelStatus, 'UNKNOWN');

        await service.start({ claim_id: 'claim-1', _callerOpenId: 'owner-openid' });
        assert.equal(calls.transfer, 1);
        assert.deepEqual(calls.query, ['PYRC202609050001']);
        assert.equal(claim().outBillNo, 'PYRC202609050001');
    });

    it('does not persist an unverified API response as a channel result', async () => {
        const { service, claim } = setup({
            strategy: {
                async transfer(request) {
                    return {
                        status: 200,
                        verified: false,
                        data: { out_bill_no: request.out_bill_no, state: 'SUCCESS' },
                    };
                },
            },
        });
        await assert.rejects(() => service.start({
            claim_id: 'claim-1', _callerOpenId: 'owner-openid',
        }), /响应未通过验签/);
        assert.equal(claim().status, 'needs_review');
        assert.equal(claim().channelStatus, 'UNKNOWN');
        assert.equal(claim().paidAt, undefined);
    });

    it('applies duplicate success callbacks once and never lets a late failure reverse success', async () => {
        const { service, claim, recovery } = setup();
        const success = {
            out_bill_no: 'PYRC202609050001',
            transfer_bill_no: 'wx-transfer-1',
            transfer_amount: 1888,
            openid: 'owner-openid',
            state: 'SUCCESS',
        };

        await service.handleCallback(success);
        const firstPaidAt = claim().succeededAt;
        await service.handleCallback(success);
        await service.handleCallback({ ...success, state: 'FAIL', fail_reason: 'late event' });

        assert.equal(claim().status, 'success');
        assert.equal(claim().channelStatus, 'SUCCESS');
        assert.equal(claim().succeededAt.getTime(), firstPaidAt.getTime());
        assert.equal(recovery().claimStatus, 'success');
        assert.equal(recovery().activeClaimId, 'claim-1');
    });
});
