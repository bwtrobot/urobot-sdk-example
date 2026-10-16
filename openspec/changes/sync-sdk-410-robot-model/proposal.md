## Why

上游 `s1-maincenter/openspec/changes/sdk-robot-model-4-1` 已新增只读机型详情查询并将 SDK 升至 4.1.0。example 仍依赖 3.3.0，尚未提供查询入口和动态机型编码传递，无法验证新增能力。

## What Changes

- 将后端 core、services、ws 依赖统一升级到 4.1.0，验证既有接口兼容性。
- 新增 `GET /robot/model?modelCode=…`，通过真实 SDK 查询机型详情，保留嵌套文件及可空历史字段。
- 补齐机器人列表动态机型字段、前端机型类型和查询 API，沿用接口调试来源标记。
- 前端依据 `model_code`（兼容 `modelCode`）查询真实机型，加载直接 URDF 或 ZIP 中的主文件与网格资源，保留无编码旧数据兼容。
- 增加 BFF → SDK → HTTP 桩服务集成测试，验证参数、序列化和错误处理；执行前后端回归及构建。
- 记录真实环境只读联调的前置条件与结果，不将 mock 或本地桩结果当作真实环境验证。

## Capabilities

### New Capabilities

- `sdk-410-integration`: SDK 4.1.0 版本一致性及新增查询调用链的集成验收。

### Modified Capabilities

- `backend-api-endpoints`: 新增机型查询端点，并在机器人列表传递动态机型字段。
- `frontend-spatial-workbench`: 新增机型查询 API 和类型，保留动态编码及数据来源，并按机型编码加载三维机器人模型。

## Impact

涉及 backend/pom.xml、RobotHandler、RobotService、RobotResponse、前端共享类型与 robotApi、测试和 example 接入说明。无数据库变更，不新增机型写操作，支持远程三维机型资源加载；保留已有文档改动。接口为只读查询，不创建或执行机器人任务。
