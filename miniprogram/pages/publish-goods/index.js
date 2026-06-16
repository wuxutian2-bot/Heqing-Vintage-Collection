const { callCloud, requireLogin } = require("../../utils/cloud");

const categories = ["数码", "教材", "生活", "服饰", "运动", "其他"];

Page({
  data: {
    categories,
    categoryIndex: 0,
    title: "",
    price: "",
    desc: "",
    contact: "",
    images: [],
    submitting: false,
  },

  onShow() {
    requireLogin();
  },

  onInput(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({ [field]: e.detail.value });
  },

  onCategoryChange(e) {
    this.setData({ categoryIndex: Number(e.detail.value) });
  },

  chooseImages() {
    wx.chooseMedia({
      count: 9 - this.data.images.length,
      mediaType: ["image"],
      sourceType: ["album", "camera"],
      success: (res) => {
        const files = (res.tempFiles || []).map((file) => file.tempFilePath);
        this.setData({ images: this.data.images.concat(files).slice(0, 9) });
      },
    });
  },

  removeImage(e) {
    const index = e.currentTarget.dataset.index;
    const images = this.data.images.slice();
    images.splice(index, 1);
    this.setData({ images });
  },

  validate() {
    if (!this.data.title.trim()) return "标题不能为空";
    if (!this.data.price || Number.isNaN(Number(this.data.price)) || Number(this.data.price) < 0) return "价格必须是数字";
    if (!this.data.desc.trim()) return "描述不能为空";
    if (!this.data.contact.trim()) return "联系方式不能为空";
    return "";
  },

  async uploadImages() {
    const uploaded = [];
    for (let i = 0; i < this.data.images.length; i += 1) {
      const filePath = this.data.images[i];
      if (filePath.indexOf("cloud://") === 0) {
        uploaded.push(filePath);
      } else {
        const suffix = filePath.substring(filePath.lastIndexOf(".") + 1) || "jpg";
        const res = await wx.cloud.uploadFile({
          cloudPath: `goods/${Date.now()}-${Math.floor(Math.random() * 100000)}.${suffix}`,
          filePath,
        });
        uploaded.push(res.fileID);
      }
    }
    return uploaded;
  },

  async submit() {
    if (!requireLogin()) return;
    const message = this.validate();
    if (message) {
      wx.showToast({ title: message, icon: "none" });
      return;
    }

    this.setData({ submitting: true });
    wx.showLoading({ title: "发布中", mask: true });
    try {
      const images = await this.uploadImages();
      await callCloud(
        "goods",
        {
          type: "add",
          title: this.data.title.trim(),
          price: Number(this.data.price),
          desc: this.data.desc.trim(),
          category: categories[this.data.categoryIndex],
          contact: this.data.contact.trim(),
          images,
        },
        { silent: true }
      );
      wx.showToast({ title: "发布成功", icon: "success" });
      this.setData({
        title: "",
        price: "",
        desc: "",
        contact: "",
        images: [],
        categoryIndex: 0,
      });
      setTimeout(() => wx.switchTab({ url: "/pages/home/index" }), 500);
    } catch (error) {
      wx.showToast({ title: error.message || "发布失败", icon: "none" });
    } finally {
      wx.hideLoading();
      this.setData({ submitting: false });
    }
  },
});
