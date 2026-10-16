# SDK 4.1.0 同步验证记录

## 契约与字段映射

SDK 制品来自本机 Maven 仓库 `~/.m2/repository/io/github/bwtrobot/`，core、services、ws 统一使用 4.1.0；来源记录显示为本地安装，本次不据此推断远程仓库发布状态。详情字段依据同版本 sources.jar 核对。

- 机器人列表：SDK `RobotItem.modelCode()` → BFF `model_code`（沿用全局命名策略）→ 前端 `RobotSummary.model_code`，并兼容 camelCase `modelCode`。
- 机型详情：SDK `RobotModel` → BFF 显式 Map → 前端 `RobotModel`，保持原契约 camelCase；历史字段保持 `terminal_type`、`terminal_type_value`。
- 详情字段：id、deviceType、nameZh、nameEn、modelCode、terminal_type、terminal_type_value、urdfFileKey、urdfMainPath、cardPosterFileKey、ratioPosterFileKey、virtualActionSupported、autoChargeMode、status、enabledTime、description、createTime、updateTime、urdf、cardPoster、ratioPoster。
- 文件字段：fileId、fileName、contentType、url、disposition。文件和历史字段允许 null，不推导资源 URL 或旧枚举值。

## 基线

- 隔离 worktree 后端 `mvn -q test`：7 项通过。
- 隔离 worktree 前端 `npm test`：14 个文件、61 项通过。

## 验收原则

本地集成必须实际经过 BFF、SDK 和 HTTP 桩；前端 mock 降级必须保留来源标记。真实环境联调单独记录，只进行列表及详情 GET 查询，不执行机器人指令，不记录凭据、签名或资源下载令牌。


## 后端实现验证

- 实现前集成用例：7 项失败、0 错误，新增详情路由返回 404。列表用例起初遇到桩认证路径配置问题，修正为真实 SDK 使用的 `/api/open/v1/token` 后再验证升级后的列表链路。
- 实现后 `mvn -q -o test`：14 项通过，其中新增真实 SDK HTTP 集成 7 项、既有 RobotService 6 项、实时功能 1 项；无失败、错误或跳过。
- 集成用例覆盖 21 个详情字段的整份 JSON 比对、3 类文件引用各 5 字段、空引用/空历史字段、中文及 `+/?&=%` 与前后空格的原样传递、缺失/空白编码不上游、业务错误、HTTP 失败和列表动态编码。
- 集成入口为 WebTestClient 的真实 WebFlux HTTP 处理链，使用项目实际 Jackson 命名配置，再通过真实 SDK 访问随机端口 HTTP 上游；未 mock RobotService 或 SDK 客户端。
- 后端独立规格及质量审查通过；测试共享响应变量已声明 volatile，清理逻辑保证异常时关闭桩服务。

## 真实环境只读联调

使用现有环境变量提供的凭据，分别以项目默认开发环境地址和上游 SDK 集成测试中配置的开发 Open API 地址启动本次工作区的实际后端（临时端口 18080）。未打印、修改或保存凭据。

- `GET /robot/page?pageNo=1&pageSize=10`：BFF HTTP 500，统一错误 `INTERNAL_ERROR`，上游返回“缺少登陆凭证”。因此未取得有效机型编码，真实机型详情查询尚未完成。需要有效的开放 API 测试环境鉴权及可查询机型编码后再验收。
- 上游 SDK 集成测试地址 `https://dev-urobot.bwton-console.cn`：列表查询同样返回 BFF HTTP 500，错误为 `Token request failed`，未取得有效机型编码。该结果仅说明本次令牌请求未成功，不推断具体凭据或部署故障原因。
- 实际启动应用的 `GET /robot/model`：HTTP 400，`BAD_REQUEST`，提示 `modelCode 不能为空`，证明缺失参数在 BFF 被拒绝。
- 没有下发机器人操作指令，没有将本地桩或前端演示结果作为真实环境成功。联调临时服务已停止。


## 前端实现与最终回归

- 测试先行：新增 7 项机型 API 测试最初因 `getRobotModel` 缺失而失败，实现后全部通过。
- `npm test`：15 个测试文件、68 项通过，无失败；包含新增 7 项参数编码、详情/空值、动态编码列表、网络/HTTP/业务失败与空白输入用例。
- `npm run build`：TypeScript 检查及 Vite 生产构建成功。构建存在 SoonSpace 依赖中 `eval` 的警告，以及现有产物体积超过 500 kB 的提示；本次未调整三维依赖或打包策略。
- `mvn -q -o test`：主代理最终复跑 14 项通过，0 失败、0 错误、0 跳过。
- 前端独立规格与质量审查通过；新增 `rejectBusinessFailure` 显式选择启用，业务错误不会泄漏为真实机型数据，也不改变旧接口默认语义。
- 既有测试涵盖讲解、任务请求及实时服务，本次未在真实机器人上执行导航、讲解、运动或任务闭环。


## 审查与规格校验

前后端分别完成规格符合性与代码质量审查，随后整体审查通过，无 Critical / Important 遗留问题。前端新增夹具和 fallback 已按字段展开，格式调整后机型 API 的 7 项测试再次通过。

`openspec validate sync-sdk-410-robot-model --strict` 通过，`git diff --check` 通过。本次保留原工作区已有文档修改，所有实现位于 `feature/sync-sdk-410-robot-model` 隔离分支。


## IDEA 启动日志诊断补充

用户提供的启动日志来自原工作区 `feature/dev`，classpath 中 core、services、ws 均为 3.3.0；4.1.0 的实现位于隔离分支，尚未合并到原工作区。启动成功不代表已加载本次升级。

使用本地 4.1.0 SDK 和同一组环境凭据进行脱敏只读诊断，令牌和签名仅保留在内存中，日志不输出值。诊断传输使用不跟随重定向的 JDK HTTP 连接；没有修改产品请求协议或原工作区源码。

1. 既有默认服务地址返回 HTTP 200 的令牌响应，字段为 accessToken、refreshToken、needChangePassword，确认 accessToken 非空。
2. 业务请求携带标准 Authorization 头，机器人列表仍返回 401；重新获取令牌后依旧 401。未观察到重定向。
3. 仅额外添加服务端源码支持的同值 v-Authorization 头，机器人列表变为 HTTP 200、success=true。该对照说明现有入口存在鉴权头兼容问题；尚不能仅凭客户端证据断定是网关移除了标准头，还是部署中的服务过滤器处理有差异。
4. 从真实列表取得非空机型编码后，携带上述兼容头调用新增 `/api/open/v1/robot-model`，上游返回 HTTP 500，errcode 为 2001001000，errmsg 为 `{validation.legacy.8e1f6788e588}`。源码语言资源对应“系统异常，请稍后重试”。因此实际机型详情仍未验收成功，需要结合服务端异常日志定位；不能把它归为原先的列表 401。

当前结论：实际只读列表已通过诊断兼容头验证成功；原 BFF 默认传输链路仍存在鉴权头问题，机型详情另有上游 500。修复标准头转发或明确兼容方案后，仍需从实际 BFF 入口重做联调。产品代码未启用临时兼容头，未合并分支，也未下发机器人指令。


## 2026-10-16 当前代码合并交接

按用户要求先将当前代码合并到实际开发分支 `feature/dev`，由用户进行验证。此前 SDK 4.1.0 接口同步已于提交 `4b20f6a` 合入；本轮新增资源加载模块、14 项资源测试、fflate 直接依赖及同一变更内的模型渲染规范和实施计划。

本轮合并前执行 `npm test -- src/features/spatial-viewer/lib/robotUrdfLoader.test.ts`，14 项通过；随后修正两处 TypeScript 类型问题，`npm run build` 成功。构建仍有既有 SoonSpace eval 与产物体积提示。本轮未重新执行前后端全量测试，也未完成新增资源模块的独立审查及浏览器资源验证；此前全量结果仅适用于上方记录的 SDK 接口同步阶段。

当前范围限制：`getRobotModel(modelCode)` 接口和资源加载模块已存在，但场景尚未调用该模块；任务 5.3 的动态机型场景接入、任务 5.4 的加载反馈和任务 5.5 的完整验收仍待完成。仅合并当前代码，不代表按 `model_code` 自动加载三维模型已经完成。现有 README 中沿用本地 URDF 的描述仍符合当前场景行为。

真实环境只读复查中，机器人列表返回成功且含机型编码，机型详情仍返回上游 500；未取得可用于实际三维渲染验收的模型资源。未下发机器人指令。
