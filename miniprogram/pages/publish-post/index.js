const { callCloud, requireLogin } = require("../../utils/cloud");

const POST_CATEGORIES = ["校园动态", "求助问答", "拼单搭子", "失物招领", "新生指南", "吐槽闲聊"];

Page({
  data: {
    title: "",
    content: "",
    category: "校园动态",
    categories: POST_CATEGORIES,
    images: [],
    submitting: false,
  },

  onLoad(options = {}) {
    requireLogin();
    const category = decodeURIComponent(options.category || "");
    if (POST_CATEGORIES.includes(category)) {
      this.setData({ category });
    }
  },

  onInput(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({ [field]: e.detail.value });
  },

  selectCategory(e) {
    const category = e.currentTarget.dataset.category;
    if (POST_CATEGORIES.includes(category)) this.setData({ category });
  },

  chooseImages() {
    wx.chooseMedia({
      count: 6 - this.data.images.length,
      mediaType: ["image"],
      sourceType: ["album", "camera"],
      success: (res) => {
        const files = (res.tempFiles || []).map((file) => file.tempFilePath);
        this.setData({ images: this.data.images.concat(files).slice(0, 6) });
      },
    });
  },

  removeImage(e) {
    const images = this.data.images.slice();
    images.splice(e.currentTarget.dataset.index, 1);
    this.setData({ images });
  },

  async uploadImages() {
    const uploaded = [];
    for (let i = 0; i < this.data.images.length; i += 1) {
      const filePath = this.data.images[i];
      const suffix = filePath.substring(filePath.lastIndexOf(".") + 1) || "jpg";
      const res = await wx.cloud.uploadFile({
        cloudPath: `posts/${Date.now()}-${Math.floor(Math.random() * 100000)}.${suffix}`,
        filePath,
      });
      uploaded.push(res.fileID);
    }
    return uploaded;
  },

  async submit() {
    if (!requireLogin()) return;
    if (!this.data.title.trim()) {
      wx.showToast({ title: "标题不能为空", icon: "none" });
      return;
    }
    if (!this.data.content.trim()) {
      wx.showToast({ title: "内容不能为空", icon: "none" });
      return;
    }

    this.setData({ submitting: true });
    wx.showLoading({ title: "发布中", mask: true });
    try {
      const images = await this.uploadImages();
      await callCloud(
        "posts",
        {
          type: "add",
          title: this.data.title.trim(),
          content: this.data.content.trim(),
          category: this.data.category,
          images,
        },
        { silent: true }
      );
      wx.showToast({ title: "发布成功", icon: "success" });
      setTimeout(() => wx.navigateBack(), 500);
    } catch (error) {
      wx.showToast({ title: error.message || "发布失败", icon: "none" });
    } finally {
      wx.hideLoading();
      this.setData({ submitting: false });
    }
  },
});
