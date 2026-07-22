# Apple 客户端（iOS / iPadOS / macOS）

源码：`apple/`（Swift · SwiftUI · Metal 计算着色器 · URLSession）

单一 Xcode multiplatform target，三个平台共享同一套代码；平台差异用 `#if os(macOS)` 局部处理。

## 环境

- Xcode 16+（macOS 14+ SDK / iOS 17+ SDK）
- Deployment target：iOS/iPadOS 17.0，macOS 14.0
- 工程由 [XcodeGen](https://github.com/yonaskolb/XcodeGen) 从 `apple/project.yml` 生成：

```bash
brew install xcodegen
cd apple
xcodegen generate
open Nianxiang.xcodeproj
```

改动 `project.yml`（或新增源文件后工程没识别）就重新 `xcodegen generate`。仓库里 `DEVELOPMENT_TEAM` 默认留空：模拟器构建无需签名；真机构建请在 `project.yml` 填入自己的 Apple Developer Team ID，或在 Xcode 里选择自动管理签名。

## 构建与测试

```bash
cd apple
# macOS
xcodebuild -project Nianxiang.xcodeproj -scheme Nianxiang -destination 'platform=macOS' build
# iOS 模拟器
xcodebuild -project Nianxiang.xcodeproj -target Nianxiang -sdk iphonesimulator build
# 单元测试
xcodebuild test -project Nianxiang.xcodeproj -scheme Nianxiang -destination 'platform=macOS'
```

### 端到端验收（MOCK_AI）

对真实服务端跑完整生命周期（登录 → 上传 → open×2 幂等 → message → complete → done → PATCH 白名单 → 删除）：

```bash
# 1. 起隔离的 MOCK 服务端（临时目录，避免污染真实数据）
TMP=$(mktemp -d) && mkdir -p "$TMP/server" \
  && cp -R server/src "$TMP/server/src" && cp server/package.json "$TMP/server/" \
  && ln -s "$PWD/server/node_modules" "$TMP/server/node_modules" \
  && (cd "$TMP" && PORT=18787 MOCK_AI=1 JWT_SECRET=e2e-secret-that-is-long-enough node server/src/index.ts &)

# 2. 运行集成测试（不设 NIANXIANG_E2E_BASE 时自动跳过）
cd apple
TEST_RUNNER_NIANXIANG_E2E_BASE=http://127.0.0.1:18787 \
  xcodebuild test -project Nianxiang.xcodeproj -scheme Nianxiang \
  -destination 'platform=macOS' -only-testing:NianxiangTests/ServerIntegrationTests
```

## 连接服务器

1. 启动念想服务（`/api/v1` 可用）
2. 登录页点「连接设置」填 Base URL
3. 首次 `启用` bootstrap，否则登录

模拟器/本机：`http://127.0.0.1:8787`；真机：`http://192.168.x.x:8787`（同一网段）。明文 HTTP 只允许回环、`.local` 与字面量私网 IPv4（与 Android 同策略）；公网必须 HTTPS。Info.plist 已配 `NSAllowsLocalNetworking`。

Token 与用户缓存存 **Keychain**；401 时单飞刷新（并发请求复用新 token），刷新失败才清会话。

## 功能

与 Android 端对齐：界面以 Web 移动端为基准，iPhone 用横向照片轮播 + 遮罩面板；iPad / Mac 用 `NavigationSplitView` 双栏（列表 + 会话详情）。

| 模块 | 状态 |
|------|------|
| 登录 / bootstrap / JWT（Keychain + 单飞刷新） | ✅ |
| 时间线缩略图 / 搜索 / 筛选 / 排序 / 删除 | ✅ |
| 多图上传 / EXIF 日期与方向（ImageIO） | ✅ iOS 用 PhotosPicker，macOS 用文件选择 + 拖拽 |
| 分析 → 流式聊天 → 流式日记 | ✅ 走 `session/open` · `session/message` · `session/complete` |
| 日记编辑 / 日期修改 / 完成后继续聊天 | ✅ |
| Metal 粒子 + 双层 depth 视差 / 景深 / 环视 / 缩放 / 复位 | ✅ |
| 语音输入 | ✅ SFSpeechRecognizer（zh-CN，实时 partial） |
| 画像查看与编辑 | ✅ |
| 人物 / 人脸命名 / 合并 / 删除 | ✅ |
| 月报生成 | ✅ |
| 管理员家庭账号管理 | ✅ |
| macOS 菜单栏命令 / 快捷键（⌘N 上传、⌘F 搜索、⇧⌘R 回顾、⇧⌘P 人物、Esc 返回） | ✅ |

## 粒子说明

`ParticleEngine` 在应用根层只创建一次，登录、时间线和照片会话共用同一个 `MTKView`。照片在后台采样成粒子：iPhone/iPad 约 5.6 万（与 Web 移动端、Android 一致），macOS 约 24 万（与 Web 桌面端一致，持续掉帧时绘制密度自动减半）。位置、速度、目标、散射位置和颜色分别存入 `MTLBuffer`；每帧先跑 Metal 计算着色器积分物理，再按远到近的顺序（CPU 排序的 order buffer）绘制点精灵。

行为与 Web / Android 当前实现一致：

- 弹簧、阻尼、卷曲噪声、砂爆、脉冲、凝聚和触摸扰动
- `depth/mask/bg/bgDepth` 完整校验，异常数据退回普通深度
- 约 1/7 粒子填充被主体遮挡的背景，边界粒子侧视淡出
- 薄透镜景深、近距离光斑、亮点辉光、暗部提亮和镜头呼吸
- 拖拽横向环视、双指捏合（Mac 触控板）缩放 `0.7–2.3`、轻触脉冲、双击复位
- 最近八条对话的文字粒子消散（CoreText 排版采样），以及尘埃、雨、雪三种环境粒子
- 系统开启「减弱动态效果」时降低扰动和砂爆强度，并停止镜头呼吸

照片 JPEG、深度解析和文字位图采样都在后台队列执行；generation 版本号丢弃迟到结果；Timeline/Hidden 动画收敛后暂停 MTKView 停帧省电。`ParticleEngine.Listener` 提供照片准备完成、入场开始、渲染失败和性能采样回调；性能样本包含平均帧率及超过 33 毫秒的帧占比。

测试可通过 `setTestConfiguration(particleBudget:seed:animationTimeSeconds:)` 固定粒子预算、随机种子和着色器时间。生产环境不设置这些值，继续使用随机分布。
