/**
 * 参数校验工具
 */

/**
 * 校验下单参数
 */
function validateOrderParams(body) {
    const errors = [];

    if (!body.description || typeof body.description !== 'string') {
        errors.push('description（商品描述）必填');
    } else if (body.description.length > 127) {
        errors.push('description（商品描述）不能超过 127 个字符');
    }

    if (!body.amount || !body.amount.total) {
        errors.push('amount.total（订单金额）必填');
    } else if (!Number.isInteger(body.amount.total) || body.amount.total <= 0) {
        errors.push('amount.total（订单金额）必须为正整数（单位：分）');
    }

    if (body.out_trade_no) {
        if (typeof body.out_trade_no !== 'string' || body.out_trade_no.length < 6 || body.out_trade_no.length > 32) {
            errors.push('out_trade_no（商户订单号）长度必须 6-32 位');
        }
        if (!/^[a-zA-Z0-9_-]+$/.test(body.out_trade_no)) {
            errors.push('out_trade_no（商户订单号）只能包含字母、数字、下划线、连字符');
        }
    }

    return errors;
}

/**
 * 校验退款参数
 */
function validateRefundParams(body) {
    const errors = [];

    if (!body.out_trade_no && !body.transaction_id) {
        errors.push('out_trade_no 或 transaction_id 至少填一个');
    }

    if (!body.out_refund_no) {
        errors.push('out_refund_no（商户退款单号）必填');
    }

    if (!body.amount) {
        errors.push('amount（金额信息）必填');
    } else {
        if (!Number.isInteger(body.amount.refund) || body.amount.refund <= 0) {
            errors.push('amount.refund（退款金额）必须为正整数');
        }
        if (!Number.isInteger(body.amount.total) || body.amount.total <= 0) {
            errors.push('amount.total（订单金额）必须为正整数');
        }
        if (body.amount.refund > body.amount.total) {
            errors.push('amount.refund（退款金额）不能大于 amount.total（订单金额）');
        }
    }

    return errors;
}

/**
 * 校验商家转账参数
 * 文档：https://pay.weixin.qq.com/doc/v3/merchant/4012716434
 *
 * ⚠️ 重要规则（来自官方文档 & FAQ）：
 * 1. 超时、系统错误或状态未知时先查询原单；不得仅凭超期更换单号，防止重复付款
 * 2. 非终态不得换单重试；确认原单失败后才可另建转账，按官方错误码和状态处理
 * 3. user_name（收款人姓名）：< 0.3 元不支持传入，≥ 2000 元必填（需 RSA/OAEP 加密）
 * 4. appid 参数名注意大小写：后端 API 用 appid（小写 i），前端 wx.requestMerchantTransfer 用 appId（大写 I）
 */
function validateTransferParams(body) {
    const errors = [];

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return ['商家转账请求参数必须为对象'];
    }

    if (!body.out_bill_no || typeof body.out_bill_no !== 'string') {
        errors.push('out_bill_no（商户单号）必填');
    } else if (!/^[a-zA-Z0-9]+$/.test(body.out_bill_no) || body.out_bill_no.length > 32) {
        errors.push('out_bill_no（商户单号）只能包含字母和数字，最长 32 位');
    }

    if (typeof body.transfer_scene_id !== 'string' || !body.transfer_scene_id.trim() || body.transfer_scene_id.length > 36) {
        errors.push('transfer_scene_id（转账场景ID）必须为非空字符串，最长 36 位，如 1010（二手回收）');
    }

    if (typeof body.openid !== 'string' || !body.openid.trim() || body.openid.length > 64) {
        errors.push('openid（收款用户 OpenID）必须为非空字符串，最长 64 位');
    }

    if (!Number.isInteger(body.transfer_amount) || body.transfer_amount <= 0) {
        errors.push('transfer_amount（转账金额）必须为正整数（单位：分）');
    } else {
        // 本项目基础金额范围为 10 分起；30 分是姓名校验阈值，不是最低转账金额。
        // 实际可转额度还必须受商户获批场景的单笔、单日、单用户额度约束。
        if (body.transfer_amount < 10) {
            errors.push('transfer_amount 不能小于 10 分（0.1 元）');
        }
        if (body.transfer_amount >= 200000) {
            errors.push(
                'transfer_amount 达到 2000 元（含）。' +
                '≥ 2000 元场景需填写 user_name 并进行敏感字段加密，本模板未实现此功能。'
            );
        }
    }

    if (typeof body.transfer_remark !== 'string' || !body.transfer_remark.trim()) {
        errors.push('transfer_remark（转账备注）必须为非空字符串');
    } else if (body.transfer_remark.length > 32) {
        errors.push('transfer_remark（转账备注）最多 32 个字符');
    }

    // 🚫 模板不支持 user_name（敏感字段需加密，参考 sdkStrategy.js）
    if (Object.prototype.hasOwnProperty.call(body, 'user_name')) {
        errors.push(
            'user_name 不支持。本模板未实现收款人姓名加密，禁止传入此字段。' +
            '如需支持，请参考 sdkStrategy.js 注释自行实现敏感字段加密。'
        );
    }

    // 检查官方报备字段名、内容和二手回收场景约束；不接受 info_value/name/value 等旧字段。
    const reports = body.transfer_scene_report_infos;
    if (!Array.isArray(reports) || reports.length === 0) {
        errors.push('transfer_scene_report_infos（转账场景报备信息）必填');
    } else {
        for (let index = 0; index < reports.length; index += 1) {
            const item = reports[index];
            const prefix = `transfer_scene_report_infos[${index}]`;
            if (!item || typeof item !== 'object' || Array.isArray(item)) {
                errors.push(`${prefix} 必须为包含 info_type、info_content 的对象`);
                continue;
            }
            if (Object.keys(item).some(key => key !== 'info_type' && key !== 'info_content')) {
                errors.push(`${prefix} 只允许 info_type、info_content 字段`);
            }
            if (typeof item.info_type !== 'string' || !item.info_type.trim() || item.info_type.length > 15) {
                errors.push(`${prefix}.info_type 必须为非空字符串，最长 15 个字符`);
            }
            if (typeof item.info_content !== 'string' || !item.info_content.trim() || item.info_content.length > 32) {
                errors.push(`${prefix}.info_content 必须为非空字符串，最长 32 个字符`);
            }
        }

        // https://pay.wechatpay.cn/doc/v3/merchant/4013774592
        // 1010 必须固定一条明细，且信息类型仅允许“回收商品名称”。
        if (body.transfer_scene_id === '1010' &&
            (reports.length !== 1 || !reports[0] || reports[0].info_type !== '回收商品名称')) {
            errors.push('transfer_scene_report_infos：1010 二手回收必须且只能填写一条“回收商品名称”');
        }
    }

    return errors;
}

module.exports = { validateOrderParams, validateRefundParams, validateTransferParams };
