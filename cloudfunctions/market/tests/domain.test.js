const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  BusinessError,
  TRANSFER_SCENE_ID,
  TRANSFER_REPORT_TYPE,
  validateQuote,
  assertClaimHasNoClientMoneyOrRecipient,
  makeClaimId,
  makeOutBillNo,
  makeOutTradeNo,
  publicClaim,
  goodsTitleForTransfer,
  expectedVersion,
} = require("../domain");

describe("market domain", () => {
  it("固化二手回收场景和报备名称", () => {
    assert.equal(TRANSFER_SCENE_ID, "1010");
    assert.equal(TRANSFER_REPORT_TYPE, "回收商品名称");
  });

  it("商家转账单号固定、仅含字母数字且不超过32字符", () => {
    const claimId = makeClaimId("rec_example_001");
    const first = makeOutBillNo(claimId);
    assert.equal(first, makeOutBillNo(claimId));
    assert.match(first, /^[A-Za-z0-9]+$/);
    assert.equal(first.length, 32);
  });

  it("支付订单号固定、仅含字母数字且不超过32字符", () => {
    const value = makeOutTradeNo("mso_example_001");
    assert.match(value, /^[A-Za-z0-9]+$/);
    assert.equal(value.length, 32);
  });

  it("报价使用整数分并由服务端计算净额", () => {
    const now = new Date("2026-09-05T00:00:00.000Z");
    const quote = validateQuote({
      grossAmountFen: 10000,
      feeAmountFen: 0,
      platformSalePriceFen: 12000,
    }, now);
    assert.equal(quote.netAmountFen, 10000);
    assert.equal(quote.grossAmountFen, 10000);
    assert.equal(quote.feeAmountFen, 0);
  });

  it("费用规则未配置前拒绝收取服务费", () => {
    assert.throws(() => validateQuote({
      grossAmountFen: 10000,
      feeAmountFen: 500,
      platformSalePriceFen: 12000,
    }), /未启用回收服务费/);
  });

  it("拒绝达到20万元分界的转账金额", () => {
    assert.throws(() => validateQuote({
      grossAmountFen: 200000,
      feeAmountFen: 0,
      platformSalePriceFen: 210000,
    }), BusinessError);
  });

  it("领取申请拒绝客户端提供金额和收款人", () => {
    assert.throws(
      () => assertClaimHasNoClientMoneyOrRecipient({ transferAmountFen: 1 }),
      /不能提交字段/
    );
    assert.throws(
      () => assertClaimHasNoClientMoneyOrRecipient({ ownerOpenId: "forged" }),
      /不能提交字段/
    );
    assert.doesNotThrow(() => assertClaimHasNoClientMoneyOrRecipient({ recoveryId: "rec_ok" }));
  });

  it("用户领取响应不泄露openid或商户转账单号", () => {
    const result = publicClaim({
      _id: "clm_1",
      recoveryOrderId: "rec_1",
      goodsTitleSnapshot: "二手书",
      transferAmountFen: 100,
      status: "reserved",
      channelStatus: "NOT_STARTED",
      ownerOpenId: "secret-openid",
      outBillNo: "MRSECRET",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    assert.equal(Object.prototype.hasOwnProperty.call(result, "ownerOpenId"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(result, "outBillNo"), false);
  });

  it("只有待用户确认时才返回微信收款包", () => {
    const base = {
      _id: "clm_1",
      recoveryOrderId: "rec_1",
      goodsTitleSnapshot: "二手书",
      transferAmountFen: 100,
      channelStatus: "WAIT_USER_CONFIRM",
      packageInfo: "package-token",
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    assert.equal(publicClaim({ ...base, status: "reserved" }, { includePackage: true }).packageInfo, undefined);
    assert.equal(
      publicClaim({ ...base, status: "wait_user_confirm" }, { includePackage: true }).packageInfo,
      "package-token"
    );
  });

  it("报备商品名最长保留32字符", () => {
    assert.equal(goodsTitleForTransfer("书".repeat(40)).length, 32);
  });

  it("管理员乐观锁接受数值版本并拒绝字符串版本", () => {
    assert.equal(expectedVersion(3), 3);
    assert.throws(() => expectedVersion("3"), /非负整数/);
  });
});
