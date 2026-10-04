const MAP_URL = "/campus-map/images/campus-map.jpg";

Page({
  data: {
    mapUrl: MAP_URL,
  },

  previewMap() {
    wx.previewImage({ current: MAP_URL, urls: [MAP_URL] });
  },

  onShareAppMessage() {
    return {
      title: "鹏宇校园地图",
      path: "/campus-map/pages/index",
    };
  },
});
