const { callCloud, requireLogin } = require("../../utils/cloud");

Page({
  data: {
    title: "",
    content: "",
    images: [],
    submitting: false,
  },

  onLoad() {
    requireLogin();
  },

  onInput(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({ [field]: e.detail.value });
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
