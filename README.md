# 校园二手集小程序

这是基于微信小程序原生框架和云开发的二手交易 + 社区论坛项目。

## 功能

- 二手商品列表、搜索、分类筛选和详情
- 登录后发布商品，支持上传云存储图片
- 社区帖子列表、发帖、点赞和评论
- 商品收藏、我的商品、我的帖子、我的收藏
- 云函数处理登录、商品、帖子、评论和收藏操作

## 云开发集合

需要在云开发数据库中准备这些集合：

- `users`
- `goods`
- `posts`
- `comments`
- `favorites`

## 云函数

需要上传并部署这些云函数：

- `login`
- `goods`
- `posts`
- `comments`
- `favorites`

`miniprogram/app.js` 中已配置云环境 ID，如需切换环境，修改 `globalData.env`。

## 页面

- `pages/home/index`：二手市场
- `pages/goods-detail/index`：商品详情
- `pages/publish-goods/index`：发布商品
- `pages/forum/index`：社区论坛
- `pages/post-detail/index`：帖子详情
- `pages/publish-post/index`：发布帖子
- `pages/profile/index`：个人中心
- `pages/login/index`：登录
