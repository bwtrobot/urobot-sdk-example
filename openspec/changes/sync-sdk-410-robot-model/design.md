## Context

动机见 proposal.md。后端为 Java 8、Spring WebFlux，SDK 阻塞调用通过 boundedElastic 调度；前端使用 React、TypeScript 和带来源记录的 API 降级机制。上游变更已完成只读开放路由 `GET /api/open/v1/robot-model` 与 SDK 请求、响应模型。当前机器人列表的 BFF 映射和前端类型未传递动态机型字段。

## Goals / Non-Goals

**Goals:** 打通机型编码从列表到查询接口的链路，完整保留字段、嵌套文件和 null；以真实 SDK 证明 HTTP 契约正确，并验证升级兼容性。

**Non-Goals:** 不新增机型管理写操作，不下发机器人运动指令，不修改上游 SDK 或覆盖用户已有文档改动。

## Decisions

### 统一 SDK 版本

core、services、ws 共用 4.1.0 版本属性，避免模块混用。实施时以已发布或本地可验证的 4.1.0 制品为准；依赖不可解析时报告阻塞，不静默退回旧版本。仅升级依赖不能覆盖新增能力，故同时接入查询链路。

### BFF 保持现有响应约定

新增 `GET /robot/model?modelCode=…`，由 RobotHandler 委托 RobotService，构建 GetRobotModelRequest 并调用 `uRobotClient.robot().getRobotModel()`。参数缺失或空白在调用前失败；不对有效编码执行大小写转换。沿用 boundedElastic 和统一 Result 错误处理。显式映射 SDK 机型及文件对象，避免 SDK 非 JavaBean 访问器造成空 JSON。字段逐项核对 RobotModel、RobotModelFile 和上游契约；camelCase 与历史 `terminal_type`、`terminal_type_value` 原样保留，允许 null。

机器人列表通过 RobotResponse 保留 SDK 实际提供的动态机型字段，前端 RobotSummary 同步类型，不从旧枚举推导动态编码。

### 前端提供查询封装

robotApi 新增 getRobotModel(modelCode)，经现有 `/api` 前缀访问 BFF，查询参数交给 HTTP 客户端编码。补齐 RobotModel、RobotModelFile 类型，允许历史字段及可空资源为空。沿用 mock 来源记录，查询失败的演示数据明确标记 mock；真实集成验收必须断言来源为 real。本次不新增控制面板；三维模型优先使用机型查询返回的资源，无编码的旧数据兼容既有本地 URDF。

### 验证从 BFF 入口穿过真实 SDK

使用随机本地端口的 HTTP 桩和测试配置创建真实 SDK 客户端，从 BFF HTTP 入口调用，核对 SDK 发往开放路由的路径与 modelCode 编码。测试包含完整详情、嵌套文件、历史字段 null、编码含特殊字符、缺失/空白参数、上游业务及 HTTP 失败。测试不 mock RobotClient 或 RobotService；每项异常断言不得变成成功结果，校验失败不得发起上游查询。凭据使用测试值，不依赖生产密钥。

前端验证参数、返回类型与来源；回归现有导航、讲解、任务查询和实时测试，执行生产构建。真实环境联调只查询用户授权的测试机型；报告脱敏，不保存密钥和签名。

### 前端根据机型编码加载三维模型

选择非空 `model_code`，兼容 `modelCode`，保留有效编码原始内容。有编码时调用现有 getRobotModel，只采用 source=real 且 urdf.url 有效的详情；演示响应、查询失败、资源缺失或资源加载失败统一显示简易模型。有编码时不回退其他型号的本地模型；无编码时保留现有 terminal_type 映射。

新增 `frontend/src/features/spatial-viewer/lib/robotUrdfLoader.ts`，提供 `loadRobotUrdf(source, signal?)`，返回 `{ robot, dispose }`。直接 URDF 解析相对网格与 package 引用；ZIP 根据 urdfMainPath 选择主文件，主路径缺省时仅允许唯一 URDF，通过解压文件映射及 LoadingManager 解析网格、贴图引用。将已存在的 fflate 声明为直接依赖，使用异步解压。主文件不明确、路径无法解析、HTTP 或网格错误均失败，不构造伪资源地址。

场景适配器复用同一机型的在途及已加载结果；切换或销毁时取消旧资源加载，并通过加载代次忽略过期的机型查询响应并递增加载代次，迟到结果仅释放资源，不覆盖当前场景。URDF 和网格加载完成后应用最新 ROS 位姿、初始聚焦并触发渲染。保持实际模型材质与贴图；替换及销毁时释放对象、材质、贴图和 Blob URL。失败结果不永久缓存，下次选择可重试。

SpatialViewer 使用加载 Promise 展示局部加载状态及 aria-busy，卸载和快速切换时忽略旧 Promise 的状态更新。位姿轮询与控制面板继续工作。测试覆盖真实 XML/ZIP 解析与资源路径，以及场景 API → 查询 → 加载 → 位姿的连接，避免只测试辅助函数。

## Risks / Trade-offs

- [4.1.0 制品未发布或本地缺失] → 首先检查解析与构建，记录制品来源和失败原因。
- [SDK 不可变模型字段丢失] → 显式映射，并对完整嵌套 JSON 和 null 做集成断言。
- [mock 掩盖上游失败] → 分别断言来源与错误，独立记录真实环境验收状态。
- [远程资源跨域或签名地址失效] → 显示简易模型并保留接口来源，重选后重新获取资源；不通过 mock 冒充真实模型。
- [异步网格晚于机器人切换] → 加载代次及取消信号共同保护，迟到模型立即释放；Blob URL 保留到资源加载结束或销毁。
- [升级影响既有 API] → 编译并执行前后端回归，不更改既有任务闭环。
- [测试环境缺少凭据或有效编码] → 本地集成照常完成，真实联调标为未执行并列出缺失条件，不宣称已完成真实联调。

## Migration Plan

先补测试、统一 SDK 版本，再接入 BFF 和前端封装，最后回归并更新说明。无数据库迁移。回滚时一并回退依赖和新增调用入口；保留已有接口契约与用户改动。
