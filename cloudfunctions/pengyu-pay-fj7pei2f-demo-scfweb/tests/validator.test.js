/**
 * validator.js 单元测试
 * 运行：npx jest tests/validator.test.js
 *   或：node --test tests/validator.test.js（Node 18+）
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { validateOrderParams, validateRefundParams, validateTransferParams } = require('../utils/validator');

// ========== validateOrderParams ==========

describe('validateOrderParams', () => {

    it('合法参数 → 无错误', () => {
        const errors = validateOrderParams({
            description: '测试商品',
            amount: { total: 100 },
        });
        assert.deepStrictEqual(errors, []);
    });

    it('合法参数（含 out_trade_no）→ 无错误', () => {
        const errors = validateOrderParams({
            description: '测试商品',
            amount: { total: 1 },
            out_trade_no: 'order_20260423_001',
        });
        assert.deepStrictEqual(errors, []);
    });

    // --- description ---

    it('缺少 description → 报错', () => {
        const errors = validateOrderParams({ amount: { total: 100 } });
        assert.ok(errors.some(e => e.includes('description')));
    });

    it('description 非字符串 → 报错', () => {
        const errors = validateOrderParams({ description: 123, amount: { total: 100 } });
        assert.ok(errors.some(e => e.includes('description')));
    });

    it('description 超过 127 字符 → 报错', () => {
        const errors = validateOrderParams({
            description: 'a'.repeat(128),
            amount: { total: 100 },
        });
        assert.ok(errors.some(e => e.includes('127')));
    });

    // --- amount ---

    it('缺少 amount → 报错', () => {
        const errors = validateOrderParams({ description: '商品' });
        assert.ok(errors.some(e => e.includes('amount.total')));
    });

    it('amount.total 为 0 → 报错', () => {
        const errors = validateOrderParams({ description: '商品', amount: { total: 0 } });
        assert.ok(errors.some(e => e.includes('amount.total')));
    });

    it('amount.total 为负数 → 报错', () => {
        const errors = validateOrderParams({ description: '商品', amount: { total: -1 } });
        assert.ok(errors.some(e => e.includes('正整数')));
    });

    it('amount.total 为浮点数 → 报错', () => {
        const errors = validateOrderParams({ description: '商品', amount: { total: 1.5 } });
        assert.ok(errors.some(e => e.includes('正整数')));
    });

    // --- out_trade_no ---

    it('out_trade_no 太短（<6 位）→ 报错', () => {
        const errors = validateOrderParams({
            description: '商品',
            amount: { total: 100 },
            out_trade_no: '12345',
        });
        assert.ok(errors.some(e => e.includes('6-32')));
    });

    it('out_trade_no 太长（>32 位）→ 报错', () => {
        const errors = validateOrderParams({
            description: '商品',
            amount: { total: 100 },
            out_trade_no: 'a'.repeat(33),
        });
        assert.ok(errors.some(e => e.includes('6-32')));
    });

    it('out_trade_no 含特殊字符 → 报错', () => {
        const errors = validateOrderParams({
            description: '商品',
            amount: { total: 100 },
            out_trade_no: 'order#123456',
        });
        assert.ok(errors.some(e => e.includes('字母、数字、下划线、连字符')));
    });
});

// ========== validateRefundParams ==========

describe('validateRefundParams', () => {

    const validRefund = {
        out_trade_no: 'order001',
        out_refund_no: 'refund001',
        amount: { refund: 50, total: 100 },
    };

    it('合法参数 → 无错误', () => {
        assert.deepStrictEqual(validateRefundParams(validRefund), []);
    });

    it('用 transaction_id 代替 out_trade_no → 无错误', () => {
        const errors = validateRefundParams({
            transaction_id: 'wx_txn_001',
            out_refund_no: 'refund001',
            amount: { refund: 50, total: 100 },
        });
        assert.deepStrictEqual(errors, []);
    });

    it('out_trade_no 和 transaction_id 都缺 → 报错', () => {
        const errors = validateRefundParams({
            out_refund_no: 'refund001',
            amount: { refund: 50, total: 100 },
        });
        assert.ok(errors.some(e => e.includes('out_trade_no') && e.includes('transaction_id')));
    });

    it('缺少 out_refund_no → 报错', () => {
        const errors = validateRefundParams({
            out_trade_no: 'order001',
            amount: { refund: 50, total: 100 },
        });
        assert.ok(errors.some(e => e.includes('out_refund_no')));
    });

    it('缺少 amount → 报错', () => {
        const errors = validateRefundParams({
            out_trade_no: 'order001',
            out_refund_no: 'refund001',
        });
        assert.ok(errors.some(e => e.includes('amount')));
    });

    it('refund 为 0 → 报错', () => {
        const errors = validateRefundParams({
            out_trade_no: 'order001',
            out_refund_no: 'refund001',
            amount: { refund: 0, total: 100 },
        });
        assert.ok(errors.some(e => e.includes('退款金额') && e.includes('正整数')));
    });

    it('退款金额 > 订单金额 → 报错', () => {
        const errors = validateRefundParams({
            out_trade_no: 'order001',
            out_refund_no: 'refund001',
            amount: { refund: 200, total: 100 },
        });
        assert.ok(errors.some(e => e.includes('不能大于')));
    });
});

// ========== validateTransferParams ==========

describe('validateTransferParams', () => {

    const validTransfer = {
        out_bill_no: 'bill20260423001',
        transfer_scene_id: '1000',
        openid: 'oUpF8uMuAJO_M2pxb1Q9zNjWeS6o',
        transfer_amount: 100,
        transfer_remark: '营销活动奖励',
        transfer_scene_report_infos: [
            { info_type: '活动名称', info_content: '春季活动' },
            { info_type: '奖励说明', info_content: '新会员注册奖励' },
        ],
    };

    const validRecovery = {
        ...validTransfer,
        transfer_scene_id: '1010',
        transfer_remark: '二手书回收货款',
        transfer_scene_report_infos: [{ info_type: '回收商品名称', info_content: '二手教材' }],
    };

    it('合法参数 → 无错误', () => {
        assert.deepStrictEqual(validateTransferParams(validTransfer), []);
    });

    it('请求体必须为对象，畸形值返回错误而非抛出异常', () => {
        for (const body of [undefined, null, [], '1010']) {
            assert.ok(validateTransferParams(body).length > 0);
        }
    });

    // --- out_bill_no ---

    it('缺少 out_bill_no → 报错', () => {
        const p = { ...validTransfer };
        delete p.out_bill_no;
        assert.ok(validateTransferParams(p).some(e => e.includes('out_bill_no')));
    });

    it('out_bill_no 含特殊字符 → 报错', () => {
        const p = { ...validTransfer, out_bill_no: 'bill-001' };
        assert.ok(validateTransferParams(p).some(e => e.includes('out_bill_no')));
    });

    it('out_bill_no 超过 32 位 → 报错', () => {
        const p = { ...validTransfer, out_bill_no: 'a'.repeat(33) };
        assert.ok(validateTransferParams(p).some(e => e.includes('out_bill_no')));
    });

    // --- transfer_scene_id ---

    it('缺少 transfer_scene_id → 报错', () => {
        const p = { ...validTransfer };
        delete p.transfer_scene_id;
        assert.ok(validateTransferParams(p).some(e => e.includes('transfer_scene_id')));
    });

    it('场景 ID 必须是非空字符串，数字 1010 不能绕过场景规则', () => {
        for (const sceneId of [1010, {}, ' ', '1'.repeat(37)]) {
            assert.ok(validateTransferParams({ ...validRecovery, transfer_scene_id: sceneId })
                .some(e => e.includes('transfer_scene_id')));
        }
    });

    // --- openid ---

    it('缺少 openid → 报错', () => {
        const p = { ...validTransfer };
        delete p.openid;
        assert.ok(validateTransferParams(p).some(e => e.includes('openid')));
    });

    it('openid 必须是非空字符串且不超过 64 个字符', () => {
        for (const openid of [123, {}, ' ', 'o'.repeat(65)]) {
            assert.ok(validateTransferParams({ ...validRecovery, openid }).some(e => e.includes('openid')));
        }
    });

    // --- transfer_amount ---

    it('transfer_amount 为 0 → 报错', () => {
        const p = { ...validTransfer, transfer_amount: 0 };
        assert.ok(validateTransferParams(p).some(e => e.includes('正整数')));
    });

    it('transfer_amount < 10 分 → 报错', () => {
        const p = { ...validRecovery, transfer_amount: 9 };
        assert.ok(validateTransferParams(p).some(e => e.includes('10 分')));
    });

    for (const amount of [10, 29, 30]) {
        it(`二手回收 ${amount} 分且不传姓名 → 通过基础校验`, () => {
            assert.deepStrictEqual(validateTransferParams({ ...validRecovery, transfer_amount: amount }), []);
        });
    }

    for (const amount of ['10', 10.5, NaN, Infinity]) {
        it(`金额 ${String(amount)} 必须是整数分，不能隐式转换`, () => {
            assert.ok(validateTransferParams({ ...validRecovery, transfer_amount: amount })
                .some(e => e.includes('正整数')));
        });
    }

    it('transfer_amount >= 200000（需姓名加密）→ 报错', () => {
        const p = { ...validTransfer, transfer_amount: 200000 };
        assert.ok(validateTransferParams(p).some(e => e.includes('2000 元')));
    });

    it('transfer_amount = 199999 → 通过基础校验，不代表商户已获此额度', () => {
        const p = { ...validTransfer, transfer_amount: 199999 };
        const errors = validateTransferParams(p);
        assert.ok(!errors.some(e => e.includes('2000 元')));
    });

    // --- transfer_remark ---

    it('缺少 transfer_remark → 报错', () => {
        const p = { ...validTransfer };
        delete p.transfer_remark;
        assert.ok(validateTransferParams(p).some(e => e.includes('transfer_remark')));
    });

    it('transfer_remark 必须是非空字符串', () => {
        for (const remark of [123, {}, ' ']) {
            assert.ok(validateTransferParams({ ...validRecovery, transfer_remark: remark })
                .some(e => e.includes('transfer_remark')));
        }
    });

    it('transfer_remark 超过 32 个字符 → 报错', () => {
        const p = { ...validTransfer, transfer_remark: '这是一段超长的转账备注用来测试最大长度限制是否生效超过三十二个字符' };
        assert.ok(validateTransferParams(p).some(e => e.includes('32')));
    });

    it('transfer_remark = 32 个字符（边界值）→ 无此错误', () => {
        const p = { ...validTransfer, transfer_remark: 'a'.repeat(32) };
        const errors = validateTransferParams(p);
        assert.ok(!errors.some(e => e.includes('32 个字符')));
    });

    // --- user_name ---

    it('包含 user_name → 报错（模板不支持）', () => {
        const p = { ...validTransfer, user_name: '张三' };
        assert.ok(validateTransferParams(p).some(e => e.includes('user_name')));
    });

    for (const userName of ['', null, false, 0]) {
        it(`传入空值或非字符串 user_name（${JSON.stringify(userName)}）也拒绝`, () => {
            assert.ok(validateTransferParams({ ...validRecovery, transfer_amount: 10, user_name: userName })
                .some(e => e.includes('user_name')));
        });
    }

    // --- transfer_scene_report_infos ---

    it('缺少 transfer_scene_report_infos → 报错', () => {
        const p = { ...validTransfer };
        delete p.transfer_scene_report_infos;
        assert.ok(validateTransferParams(p).some(e => e.includes('transfer_scene_report_infos')));
    });

    it('transfer_scene_report_infos 为空数组 → 报错', () => {
        const p = { ...validTransfer, transfer_scene_report_infos: [] };
        assert.ok(validateTransferParams(p).some(e => e.includes('transfer_scene_report_infos')));
    });

    for (const item of [null, '回收商品名称', 1, [], {},
        { info_type: '回收商品名称', info_value: '二手教材' },
        { name: '回收商品名称', value: '二手教材' },
        { info_type: '回收商品名称', info_content: '二手教材', info_value: '错误字段' },
        { info_type: 1010, info_content: '二手教材' },
        { info_type: '回收商品名称', info_content: 123 },
        { info_type: ' ', info_content: '二手教材' },
        { info_type: '回收商品名称', info_content: '\t ' },
    ]) {
        it(`拒绝畸形报备明细 ${JSON.stringify(item)}`, () => {
            assert.ok(validateTransferParams({ ...validRecovery, transfer_scene_report_infos: [item] })
                .some(e => e.includes('transfer_scene_report_infos')));
        });
    }

    it('报备类型最长 15 字符，内容最长 32 字符', () => {
        const p = { ...validTransfer, transfer_scene_report_infos: [{ info_type: '类'.repeat(15), info_content: '书'.repeat(32) }] };
        assert.deepStrictEqual(validateTransferParams(p), []);
        assert.ok(validateTransferParams({ ...p, transfer_scene_report_infos: [{ info_type: '类'.repeat(16), info_content: '教材' }] })
            .some(e => e.includes('info_type')));
        assert.ok(validateTransferParams({ ...p, transfer_scene_report_infos: [{ info_type: '回收商品名称', info_content: '书'.repeat(33) }] })
            .some(e => e.includes('info_content')));
    });

    it('1010 必须且只能报备一条回收商品名称，不能使用其他场景名称', () => {
        for (const reports of [
            validTransfer.transfer_scene_report_infos,
            [{ info_type: '采购商品名称', info_content: '二手教材' }],
            [...validRecovery.transfer_scene_report_infos, ...validRecovery.transfer_scene_report_infos],
        ]) {
            assert.ok(validateTransferParams({ ...validRecovery, transfer_scene_report_infos: reports })
                .some(e => e.includes('回收商品名称')));
        }
    });
});
