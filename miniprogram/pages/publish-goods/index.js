const { callCloud, requireLogin } = require("../../utils/cloud");

const categories = ["零食", "饮料", "数码", "教材", "学习用品", "生活用品", "服饰鞋包", "运动健身", "美妆护理", "票券卡类", "求购", "其他"];

Page({
  data: {
    categories,
    categoryIndex: 0,
    title: "",
    price: "",
    desc: "",
    images: [],
    submitting: false,
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
    if (!Array.isArray(this.data.images) || this.data.images.length === 0) return "请至少上传1张商品图片";
    return "";
  },

  async uploadImages() {
    const uploaded = [];
    for (let i = 0; i < this.data.images.length; i += 1) {
      const filePath = this.data.images[i];
      if (filePath.indexOf("cloud://") === 0) {
        uploaded.push(filePath);
      } else {
        const suffixMatch = String(filePath).match(/\.([a-zA-Z0-9]+)(?:\?.*)?$/);
        const suffix = suffixMatch ? suffixMatch[1].toLowerCase() : "jpg";
        const res = await wx.cloud.uploadFile({
          cloudPath: `goods/${Date.now()}-${Math.floor(Math.random() * 100000)}.${suffix}`,
          filePath,
        });
        if (!res || !res.fileID) throw new Error("商品图片上传失败，请重试");
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
          images,
        },
        { silent: true }
      );
      wx.showToast({ title: "发布成功", icon: "success" });
      this.setData({
        title: "",
        price: "",
        desc: "",
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
