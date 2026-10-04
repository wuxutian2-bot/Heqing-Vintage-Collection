const { callCloud } = require("../../utils/cloud");
const { clearCart, getCart } = require("../../utils/cart");

const buildings = Array.from({ length: 16 }, (_, index) => `${index + 1}号楼`);
const floors = Array.from({ length: 6 }, (_, index) => `${index + 1}层`);
const getRooms = (floorNo) => Array.from(
  { length: 39 },
  (_, index) => `${floorNo * 100 + index + 1}宿舍`
);

const unwrapUser = (result) => {
  if (result && result.defaultAddress) return result;
  if (result && result.data && result.data.defaultAddress) return result.data;
  return null;
};

const addressMatches = (address, buildingNo, floorNo, roomIndex) => Boolean(
  address
  && Number(address.buildingNo) === buildingNo
  && Number(address.floorNo) === floorNo
  && Number(address.roomIndex) === roomIndex
);

Page({
  data: {
    required: false,
    loading: false,
    ranges: [buildings, floors, getRooms(1)],
    value: [0, 0, 0],
    addressText: "1号楼 101宿舍",
  },

  onLoad(options) {
    const user = wx.getStorageSync("user");
    if (!user) {
      wx.redirectTo({ url: "/pages/login/index" });
      return;
    }
    const address = user.defaultAddress || {};
    const buildingIndex = Math.max(0, Math.min(15, Number(address.buildingNo || 1) - 1));
    const floorIndex = Math.max(0, Math.min(5, Number(address.floorNo || 1) - 1));
    const roomIndex = Math.max(0, Math.min(38, Number(address.roomIndex || 1) - 1));
    const value = [buildingIndex, floorIndex, roomIndex];
    this.setData({
      required: options.required === "1",
      ranges: [buildings, floors, getRooms(floorIndex + 1)],
      value,
      addressText: this.formatAddress(value),
    });
  },

  formatAddress(value) {
    const buildingNo = Number(value[0]) + 1;
    const floorNo = Number(value[1]) + 1;
    const roomNo = floorNo * 100 + Number(value[2]) + 1;
    return `${buildingNo}号楼 ${roomNo}宿舍`;
  },

  onColumnChange(e) {
    const value = this.data.value.slice();
    value[Number(e.detail.column)] = Number(e.detail.value);
    if (Number(e.detail.column) === 1) {
      value[2] = 0;
      this.setData({ ranges: [buildings, floors, getRooms(value[1] + 1)] });
    }
    this.setData({ value, addressText: this.formatAddress(value) });
  },

  onAddressChange(e) {
    const value = e.detail.value.map(Number);
    this.setData({ value, addressText: this.formatAddress(value) });
  },

  async confirmCartReset(buildingNo) {
    const user = wx.getStorageSync("user") || {};
    const currentBuildingNo = Number(user.defaultAddress && user.defaultAddress.buildingNo || 0);
    const cart = getCart();
    if (!cart.items.length || !currentBuildingNo || currentBuildingNo === buildingNo) return true;
    return new Promise((resolve) => {
      wx.showModal({
        title: "更换楼栋",
        content: "不同楼栋库存独立，更换后会清空当前购物车。是否继续？",
        confirmText: "继续更换",
        success: (result) => resolve(result.confirm),
        fail: () => resolve(false),
      });
    });
  },

  async saveAddress() {
    if (this.data.loading) return;
    const buildingNo = Number(this.data.value[0]) + 1;
    const floorNo = Number(this.data.value[1]) + 1;
    const roomIndex = Number(this.data.value[2]) + 1;
    const currentUser = wx.getStorageSync("user") || {};
    const currentBuildingNo = Number(currentUser.defaultAddress && currentUser.defaultAddress.buildingNo || 0);
    const buildingChanged = currentBuildingNo > 0 && currentBuildingNo !== buildingNo;
    const confirmed = await this.confirmCartReset(buildingNo);
    if (!confirmed) return;

    this.setData({ loading: true });
    try {
      const result = await callCloud("login", {
        type: "saveAddress",
        buildingNo,
        floorNo,
        roomIndex,
      }, { silent: true });
      const savedUser = unwrapUser(result);
      if (!savedUser || !addressMatches(savedUser.defaultAddress, buildingNo, floorNo, roomIndex)) {
        const versionError = new Error("地址服务尚未更新");
        versionError.code = "ADDRESS_NOT_PERSISTED";
        throw versionError;
      }
      if (buildingChanged) clearCart();
      wx.setStorageSync("user", { ...currentUser, ...savedUser });
      this.addressSaved = true;
      wx.showToast({ title: "地址已保存", icon: "success" });
      this.leaveTimer = setTimeout(() => {
        if (this.data.required || getCurrentPages().length <= 1) {
          wx.reLaunch({
            url: "/pages/store/index",
            fail: () => {
              this.addressSaved = false;
              this.setData({ loading: false });
              wx.showToast({ title: "返回首页失败，请重试", icon: "none" });
            },
          });
          return;
        }
        wx.navigateBack({
          delta: 1,
          fail: () => {
            this.addressSaved = false;
            this.setData({ loading: false });
            wx.reLaunch({ url: "/pages/store/index" });
          },
        });
      }, 300);
    } catch (error) {
      if (error.code === "ADDRESS_NOT_PERSISTED") {
        wx.showModal({
          title: "地址未写入",
          content: "云端 login 函数仍是旧版本。请重新上传并部署 login 云函数后再保存。",
          showCancel: false,
        });
      } else {
        wx.showToast({ title: error.message || "保存失败", icon: "none" });
      }
    } finally {
      if (!this.addressSaved) this.setData({ loading: false });
    }
  },

  onUnload() {
    if (this.leaveTimer) clearTimeout(this.leaveTimer);
  },
});
