# 军火商（Ammo Trader）

子弹倒卖记录工具。手机 / 电脑 / 网页三端通过自建后端实时同步，数据集中存在服务端的 `data/db.json`。

## 功能
1. **📦 仓库**：录入采购（名称 / 数量 / 单价 / 时:分，年月日自动取当天），同款合并成一行，显示购买均价与回本均价（= 均价 × 1.156）。点开看历史，可改可删。
2. **💰 价格表**：录入价格（时间自动取录入当下，可在记录里改），同款显示历史最低价 + 该价格时刻。点开有折线图（每日均价趋势 / 当日分时波动）。
3. **📈 销售**：录入卖出（价 / 量 / 时间），自动算单颗利润（= 卖出价 − 成本均价 × 1.156）与利润率。同款显示近 7 天卖出均价 / 总利润 / 单颗利润 / 利润率，可改可删。

## 本地运行
```bash
node server.js        # 监听 PORT（默认 3000）
# 浏览器打开 http://localhost:3000
```

## 部署到「固定公网地址」（无需信用卡）
镜像为 Docker，端口由 `PORT` 环境变量决定（Hugging Face Spaces 固定 7860，其余平台按各自变量）。

### Hugging Face Spaces（推荐 · 免信用卡）
1. 注册 https://huggingface.co （免费，无需信用卡）
2. New Space → SDK 选 **Docker** → **Blank** → Hardware: **Free**
3. Settings → 开启 **Persistent Storage**（挂载 `/data`，数据持久不丢）
4. 连接方式选 GitHub 仓库 `fushuyihao/junhuoshang`，或直接把本仓库文件推到 Space
5. 得到固定地址 `https://你的用户名-空间名.hf.space`

### Koyeb（免信用卡 · 内置数据库）
1. 注册 https://koyeb.com
2. 创建 App → 选 GitHub 仓库 → 自动识别 `Dockerfile`
3. 免费 Starter 实例，地址固定

### Render（需绑卡，备选）
仓库内含 `render.yaml`，连 GitHub 仓库后自动读取配置部署。
