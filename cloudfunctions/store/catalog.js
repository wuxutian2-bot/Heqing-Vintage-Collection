const PRODUCT_CATEGORIES = [
  "速食泡面类",
  "膨化食品类",
  "辣条面筋调味面制品",
  "卤味肉食类",
  "蛋类",
  "饼干糕点类",
  "魔芋素肉",
  "瓜子炒货坚果",
  "香肠类",
];

// 内置实拍图用于商品库的默认展示。运营人员为某个商品上传了云存储图片后，
// 云存储图片会优先显示；这里的图片只为尚未单独配置图片的标准商品兜底。
const PRODUCT_IMAGE_BY_TITLE = {
  "可比克薯片（番茄/青瓜/原滋味）": "/images/store/copico-potato-chips.jpg",
  "稻口香薄脆饼干烤馍": "/images/store/rice-fragrant-crisp-biscuits.jpg",
  "美思缘辣条": "/images/store/meisiyuan-spicy-strips.jpg",
  "劲仔深海小鱼": "/images/store/jinzi-deep-sea-fish.jpg",
  "卫龙魔芋爽": "/images/store/weilong-konjac-snack.jpg",
  "手撕烤脖": "/images/store/hand-torn-roast-neck.jpg",
  "泡翅": "/images/store/pickled-chicken-wings.jpg",
  "泡椒鸡爪": "/images/store/pickled-chicken-feet.jpg",
  "多味鸡爪": "/images/store/assorted-chicken-feet.jpg",
  "鸭翅根": "/images/store/duck-wing-root.jpg",
  "圣茗香茶叶蛋": "/images/store/tea-egg.jpg",
  "八爪烧": "/images/store/octopus-snack.jpg",
  "虾仔面": "/images/store/shrimp-noodles.jpg",
  "牛羊配": "/images/store/beef-mutton-snack.jpg",
  "咪咪虾条": "/images/store/mimi-shrimp-sticks.jpg",
};

const RAW_PRODUCTS = [
  ["速食泡面类", "杨掌柜粉面菜蛋", 550],
  ["速食泡面类", "虾仔面", 200],
  ["膨化食品类", "八爪烧", 100],
  ["膨化食品类", "海螺丝", 200],
  ["膨化食品类", "小米锅巴", 200],
  ["膨化食品类", "可比克薯片（番茄/青瓜/原滋味）", 300],
  ["膨化食品类", "咪咪虾条", 200],
  ["膨化食品类", "时光海苔卷", 100],
  ["膨化食品类", "南京板鸭", 100],
  ["膨化食品类", "牛羊配", 200],
  ["辣条面筋调味面制品", "卫龙大面筋", 350],
  ["辣条面筋调味面制品", "麻辣王子（辣/微辣)", 150],
  ["辣条面筋调味面制品", "美思缘辣条", 50],
  ["卤味肉食类", "鸭翅根", 100],
  ["卤味肉食类", "泡椒鸡爪", 200],
  ["卤味肉食类", "多味鸡爪", 200],
  ["卤味肉食类", "泡翅", 100],
  ["卤味肉食类", "手撕烤脖", 200],
  ["卤味肉食类", "劲仔深海小鱼", 100],
  ["蛋类", "圣茗香茶叶蛋", 150],
  ["蛋类", "盐焗卤蛋", 150],
  ["饼干糕点类", "稻口香薄脆饼干烤馍", 100],
  ["魔芋素肉", "卫龙魔芋爽", 100],
  ["瓜子炒货坚果", "多味瓜子", 100],
  ["瓜子炒货坚果", "焦糖瓜子", 100],
  ["瓜子炒货坚果", "西瓜子", 100],
  ["香肠类", "香肠", 100],
];

const PRODUCT_CATALOG = RAW_PRODUCTS.map(([category, title, priceFen, image], index) => ({
  sku: String(index + 1).padStart(3, "0"),
  category,
  title,
  priceFen,
  image: image || PRODUCT_IMAGE_BY_TITLE[title] || "",
}));

const outletDocId = (buildingNo) => `building_${String(buildingNo).padStart(2, "0")}_outlet`;
const productDocId = (buildingNo, sku) => `building_${String(buildingNo).padStart(2, "0")}_product_${sku}`;

module.exports = {
  PRODUCT_CATALOG,
  PRODUCT_CATEGORIES,
  outletDocId,
  productDocId,
};
