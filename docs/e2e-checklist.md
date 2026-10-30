# 端到端验收记录

验收时间：2026-07-19

环境：Android 模拟器 1080x2400、Mock v1 服务 `http://10.0.2.2:18888`、Web/服务端本地工作区。

## 服务端 v1

- [x] 健康检查返回 `bootstrapped` 和 `apiVersion: 1`
- [x] 并发 bootstrap 只有一个请求成功，之后可正常登录
- [x] 无令牌访问 entries 返回 401
- [x] 不同用户之间的记忆数据隔离
- [x] multipart 上传、分析、聊天 SSE `delta/done`、日记和月报 SSE
- [x] 访问令牌刷新、退出撤销和修改密码后的令牌轮换
- [x] 旧 `/api/*` 路由已移除，统一返回 404
- [x] `pnpm test`：1 项接口 E2E 通过，0 失败

## Web

- [x] 首次启用和登录遮罩
- [x] 时间线、带鉴权缩略图、搜索和状态筛选
- [x] 打开记忆、粒子画面、分析、流式聊天和日记
- [x] 人物、画像和月度回顾
- [x] 修改密码和家庭成员账号管理
- [x] 退出后必须重新登录
- [x] `pnpm build`：服务端类型检查和 Web 生产构建通过

构建仍会提示现有大包和动态导入未拆包，未阻止产物生成。

## Android

- [x] Web 风格黑色沉浸界面、衬线标题、半透明控件和双列照片时间线
- [x] Base URL 持久化、连接探测、登录和会话恢复
- [x] 时间线缩略图、搜索、四种状态筛选和正反排序
- [x] 系统照片选择器、多图导入、压缩上传，并自动进入最后一张新记忆
- [x] 上传失败保留具体错误；删除前显示确认框
- [x] 照片粒子画面非空；拖动、双指缩放和双击复位有效
- [x] OpenGL ES 3.1 计算着色器在 Android 15 模拟器编译、链接和运行成功
- [x] 5.6 万预算的整张竖图可见，清晰照片先显示，460 毫秒后进入砂爆粒子
- [x] 8000×6000 JPEG 使用完整 5.6 万预算完成粒子化；解码位图限制为约 1000×750，过程无闪退或渲染错误
- [x] 分层深度接口返回 `layered: true`；宽角度环视可见前后层，主体边缘无深度长条
- [x] 根层手势观察不会被对话列表遮挡；横向环视、双指缩放、轻触和双击复位有效
- [x] 文字消散、照片凝聚、尘埃、雨、雪及日记/对话明暗切换状态测试通过
- [x] 强制销毁 EGL 上下文后，照片粒子从 CPU 数据恢复且画面非空
- [x] 粒子页面连续打开和手势操作无 OpenGL 原生崩溃
- [x] 聊天 SSE 分段显示，最终回复不重复，长对话自动显示最新消息
- [x] 日记流式生成、日记/对话切换、标题正文编辑和日期修改
- [x] 录音权限请求、开始和停止语音识别状态
- [x] 人物库、待确认人脸、人物命名入口
- [x] 画像、长期记忆和 6 月月度回顾生成
- [x] 家庭成员列表、禁用和重新启用成员
- [x] 修改密码后旧密码失效；退出后用新密码重新登录；验收后恢复原密码
- [x] 最新 APK 覆盖安装后可恢复登录并加载时间线
- [x] `logcat -b crash` 为空，应用进程保持存活
- [x] `./gradlew :app:testDebugUnitTest :app:connectedDebugAndroidTest :app:lintDebug :app:assembleDebug`：构建成功，Lint 0 错误

粒子 JVM 测试覆盖深度 JSON 校验、百分位归一化、双层预算分配、远近排序、情绪天气映射和场景状态转换。仪器测试覆盖 ES 3.1 运行、8000×6000 大图粒子化、整张照片、原生及根层手势、文字消散、天气状态和上下文重建；其余客户端行为继续由模拟器真实点击、接口状态、截图和崩溃日志共同验收。

Web 与 Android 已使用同一张照片对照稳定态、前视和宽角度环视。两端点尺寸、透明度、光圈、辉光、相机和动画常量一致；不同运行时的随机分布不适合直接计算 SSIM，正式截图验收需同时注入固定随机种子和时间。

60 秒 58 FPS 指标仍需在骁龙 8 Gen 2、天玑 9200 或更高的 1080×2400 真机上执行；模拟器的 SwiftShader 数据不能代替真机结论。

Lint 剩余 10 个提示：8 个依赖有新版、目标 SDK 35 不是本机最新版本，以及局域网自建服务需要允许 HTTP。公网地址仍由客户端强制要求 HTTPS。

## 交付物

- APK：`android/app/build/outputs/apk/debug/app-debug.apk`
- SHA-256：`006c49b97b9f9499eb8dd909808d0816ee29b1ce3a9add835fd1efe9adb5a2cc`
- Lint 报告：`android/app/build/reports/lint-results-debug.html`

## 部署前检查

- [ ] 生产环境设置独立高强度 `JWT_SECRET`
- [ ] 配置数据目录备份和恢复演练
- [ ] 公网入口只开放 HTTPS

部署项不属于本地 E2E，发布到实际服务器时需要单独确认。

---

# 第二轮：2026-07-19 之后新增功能

上节记录停在 2026-07-19。此后新增的功能列于本节。服务端侧多数已由自动化测试覆盖，标注 ✅ 的无需人工重复；标注 ☐ 的需要真机或人眼判断。

最后一次自动化验证：2026-08-24（P5 收敛与计费之后），`pnpm typecheck` 0 错误，`pnpm test` 55 项中 54 通过、1 项因选中私有 core 而跳过（跳过原因直接打印在 `node --test` 输出里）。独立版 `:app:testDebugUnitTest` 136 项 0 失败、5 跳过（跳过为需真密钥/网络的 live 测试）。

本节所有 ☐ 项的逐步操作指引见私有仓 `core/docs/acceptance-20260824.md`（含独立版与 Apple 端验收）。

## 服务端（自动化已覆盖）

- ✅ 上传幂等与按 owner 去重 · `upload-idempotency.e2e.test.ts`
- ✅ SSE change-feed 变更同步 · `change-feed.e2e.test.ts`
- ✅ Ed25519 授权闸门，未授权降级演示模式 · `license.test.ts`
- ✅ scrypt 代价参数版本化，老账号登录透明升级 · `kdf-upgrade.e2e.test.ts`
- ✅ 家庭密钥轮换，中断后下次登录续跑 · `scope-rotation.test.ts`
- ✅ 渗透测试后的 HTTP 面加固（响应头、方法限制、找回流程） · `security.e2e.test.ts`
- ✅ 分享卡与年度册导出 · `exports.e2e.test.ts`
- ✅ 内容密文落盘，伪造 JWT 无法解密 · `crypto-at-rest.e2e.test.ts`
- ✅ 人物引用 cx 持久化 · `person-refs.test.ts`
- ✅ 关系图谱作用域与轮换 · `relationships.e2e.test.ts`
- ✅ 会话绑定 · `session-binding.e2e.test.ts`
- ✅ 管理台零用户密钥 · `ops.e2e.test.ts`
- ✅ 落盘格式迁移 · `migration.e2e.test.ts`、`at-rest-migration.test.ts`

## 导出（需真机 + 真实账号）

memory 记录的遗留项，是本轮优先级最高的验收内容。

- ☐ 分享卡：真实账号下的已完成记忆生成 JPEG，中文排版无截断、无豆腐块
- ☐ 分享卡：含绘文字的日记正文，绘文字被剥离而非渲染成豆腐块（825bb36）
- ☐ 年度册：整年记忆生成 PDF，页序、日期、分页正确
- ☐ 年度册：日期按本地时区而非 UTC 归属（c8a497c）
- ☐ 导出过程中关闭对话框，请求被 abort 而非继续占用服务端
- ☐ 嵌套对话框中按 Escape 只关闭最内层（c8a497c）
- ☐ Android：分享 action 唤起系统分享面板，落地文件可被第三方应用接收
- ☐ Apple：同上，经 UIActivityViewController / NSSharingService
- ☐ 服务端渲染耗时符合预期（参考值：单卡约 210 ms、年度册约 1.08 s）

## 同步与离线（需真机）

- ☐ 断网状态下上传排队，恢复网络后自动续传，不产生重复条目
- ☐ 一端新增/修改条目，另两端经 SSE 在数秒内自动出现
- ☐ 三端友好错误文案：网络失败、令牌过期、服务端锁定各自给出可读提示

## AI 与推理（需人眼判断）

- ☐ 多模态聊天：对话中附加照片，念念的回应与照片内容相符
- ☐ 人脸位置接地：念念描述「左边的人」与照片实际左右一致（旧照片需重新分析后才生效）
- ☐ 聊天时间接地：念念引用的日期与照片拍摄日期、带日期记忆一致
- ☐ matting v6 上线效果：人像边缘、场景 5 类分割在真实照片上的目视质量
- ☐ ZipDepth 深度：前后景分层与视差在真实照片上无边缘长条、无背景撕裂
- ☐ 场景类粒子运动：天空/植被/建筑/水面/地面各自的运动差异可辨

## 粒子视觉（需真机，模拟器数据不可代替）

- ☐ 1080×2400 真机 60 秒 58 FPS（骁龙 8 Gen 2 / 天玑 9200 或更高）
- ☐ 三端同一张照片的稳定态、前视、宽角度环视视觉一致
- ☐ Android 性能降级档位在低端机上生效且不崩溃

## 运维

- ☐ `/ops` 控制台显示的模型版本、运行时状态、推理速度与实际一致（e4f5ed3）
- ☐ 管理员账号可管账号与备份，但读不到任何用户内容

---

# 第三轮：P5 收敛与计费（2026-08-24 之后新增）

## 服务端与运维（自动化已覆盖）

- ✅ 套餐额度闸门：软阈 80% 响应头、硬阈 100% `QUOTA_EXCEEDED`、调用与 token 两个维度独立触发 · `billing.e2e.test.ts`
- ✅ 非 AI 端点不受额度影响（额度用尽后仍可列表、上传、读取） · `billing.e2e.test.ts`
- ✅ 年度册为套餐能力，`free` 下返回 `FORBIDDEN` 而非 `QUOTA_EXCEEDED` · `billing.e2e.test.ts`
- ✅ 运维台切换套餐、清零当月计数，两者均入审计且不泄漏口令 · `billing.e2e.test.ts`
- ✅ 授权令牌的 `seats` / `plans` 声明解析、缺省兼容、非法取值拒绝、签名覆盖 · `license.test.ts`
- ✅ 套餐配额表与席位计数的边界 · `entitlements.test.ts`
- ✅ 单实例锁：第二实例拒绝启动、死 pid 锁重夺、截断锁不卡启动 · `instance-lock.e2e.test.ts`
- ✅ 独立版 LLM 密钥密文落盘、锁库时不暴露、清空即关闭 · 独立版 `LlmSettingsTest`

## 一次性核对（命令即判据，无需真机）

- ✅ 独立版 release APK 不含密钥：`unzip -p app-release.apk classes.dex | strings | grep -cE 'sk-[A-Za-z0-9]{20,}'` → 0
- ✅ 配置面三处一致：`./scripts/check-env-parity.sh` → `env parity OK (22 个变量,三处一致)`
- ✅ 孤儿权重清零：`/ops` 模型页签无 `orphan` 标记（matting v1/v2/v3 已删，`server/models` 559M → 424M）
- ✅ 两个 Android 工程 `lintDebug` 0 错误（此前各有 1 个：NAS 缺 `ACCESS_NETWORK_STATE`、独立版 `setIsStrongBoxBacked` 的 NewApi）

## 需真机或人眼判断

- ☐ 独立版：「设置 → 模型」填入自己的 API 密钥后念念可对话；清空密钥后仅念念停口，导入 / 粒子 / 认人 / 导出照常
- ☐ 独立版：覆盖安装内置密钥版之后，`llm-config.json` 随存量库一同加密迁移，填入密钥即可用
- ☐ 首启无密钥时的提示文案指向设置页（不再提 local.properties）
- ☐ 运维台「授权」页签显示的 licensee / 到期 / 席位占用与实际令牌一致
- ☐ 运维台账户页签切换套餐后，该账户的额度行为随即改变
- ☐ 达到额度后三端（Web / Android / Apple）显示「本月的 AI 额度已用完…」而非通用错误
- ☐ 已用 80% 后 Web 出现一次额度提醒 toast
- ☐ 同一 `data/` 目录启动第二个实例被拒绝，日志给出占用 pid（NAS 上验证一次）
- ☐ NAS Android 客户端反复切后台/回前台不崩溃（补 `ACCESS_NETWORK_STATE` 之后；此前 `registerDefaultNetworkCallback` 按 API 契约会抛 `SecurityException`，该推断未实测）
- ☐ NAS Android 客户端断网导入排队、恢复网络自动续传（依赖上一条；第二轮同名条目此前从未通过验收）

## 部署前必办

- ☐ **轮换已泄漏的 Moonshot 密钥**：它随 0.1.0 版 APK 分发过，代码修复不能追回已发出的密钥
- ☐ NAS 部署前建立成对回滚句柄（镜像 + data 备份）：本轮改动 `Account.plan` 字段语义并新增 `data/migration-plan.json` 迁移标记
