# Android 客户端

源码：`android/`（Kotlin · Jetpack Compose · Ktor · OpenGL ES 3.1 计算着色器）

## 环境

- JDK 17+
- Android SDK 35 / minSdk 26
- OpenGL ES 3.1；清单将其声明为必需能力，不支持的设备不能安装
- 本机 `android/local.properties`：

```
sdk.dir=/path/to/Android/sdk
```

## 构建

```bash
cd android
./gradlew :app:assembleDebug
# APK: app/build/outputs/apk/debug/app-debug.apk
```

Android Studio 打开 `android/` 目录即可运行。

## 连接服务器

1. 启动念想服务（`/api/v1` 可用）
2. App 启动页填写 Base URL（局域网 IP 或 HTTPS 域名）
3. 点「探测连接」→ 首次 `启用` bootstrap，否则登录

模拟器访问宿主机：`http://10.0.2.2:8787`  
真机：`http://192.168.x.x:8787`（需同一网段）

## 功能

界面以 Web 移动端为基准：时间线使用横向照片轮播，回顾、人物、画像、账号和连接设置通过遮罩面板打开；照片会话保留原生 GLES 粒子、系统语音和照片选择能力。

| 模块 | 状态 |
|------|------|
| 登录 / bootstrap / JWT | ✅ |
| 时间线缩略图 / 搜索 / 筛选 / 排序 / 删除 | ✅ |
| 多图上传 / EXIF 日期与方向 | ✅ |
| 分析 → 流式聊天 → 流式日记 | ✅ 走 `session/open` · `session/message` · `session/complete` |
| 日记编辑 / 日期修改 / 完成后继续聊天 | ✅ |
| ES 3.1 粒子 + 双层 depth 视差 / 景深 / 环视 / 缩放 / 复位 | ✅ |
| 语音输入 | ✅ 系统 SpeechRecognizer |
| 画像查看与编辑 | ✅ |
| 人物 / 人脸命名 / 合并 / 删除 | ✅ |
| 月报生成 | ✅ |
| 管理员家庭账号管理 | ✅ |

单元测试、连接设备测试和完整构建：

```bash
cd android
./gradlew :app:testDebugUnitTest
./gradlew :app:connectedDebugAndroidTest
./gradlew :app:lintDebug :app:assembleDebug
```

## 粒子说明

`ParticleView` 在应用根层只创建一次，登录、时间线和照片会话共用同一个 OpenGL 上下文。照片在后台采样成约 5.6 万个粒子，位置、速度、目标、散射位置和颜色分别上传到 Shader Storage Buffer Object；每帧先运行 ES 3.1 计算着色器，再按远到近的顺序绘制。

行为与 Web 当前实现一致：

- 弹簧、阻尼、卷曲噪声、砂爆、脉冲、凝聚和触摸扰动
- `depth/mask/bg/bgDepth` 完整校验，异常数据退回普通深度
- 约 1/7 粒子填充被主体遮挡的背景，边界粒子侧视淡出
- 薄透镜景深、近距离光斑、亮点辉光、暗部提亮和镜头呼吸
- 单指横向环视、双指缩放 `0.7–2.3`、轻触脉冲、双击复位
- 最近八条对话的文字粒子消散，以及尘埃、雨、雪三种环境粒子
- 系统关闭动画时降低扰动和砂爆强度，并停止镜头呼吸

照片 JPEG、深度解析和文字位图采样都在后台线程执行。照片版本号会丢弃迟到结果；OpenGL 上下文重建时会从最近一次 CPU 粒子数据恢复。`ParticleView.Listener` 提供照片准备完成、过渡开始、渲染失败和性能采样回调；性能样本包含平均帧率及超过 33 毫秒的帧占比。

测试可通过 `setTestConfiguration(particleBudget, seed, animationTimeSeconds)` 固定粒子预算、随机种子和着色器时间。生产环境不设置这些值，继续使用随机分布。
