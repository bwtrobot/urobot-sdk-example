# urobot-sdk-example

uRobot SDK Example 是 uTwin 机器人平台的全栈 SDK 示例应用。项目初始状态仅有一个 Spring Boot WebFlux 后端脚手架（含机器人列表端点）和空白前端。需要补全完整的前后端链路，包括 3D 空间可视化、机器人执行控制、后端 API 端点。 

当前后端使用 Java 8 / Spring Boot WebFlux，统一依赖 `urobot-opensdk-core`、`urobot-opensdk-services` 和 `urobot-opensdk-ws` 4.1.0。

前端基于 React 18 / Vite / TypeScript，3D 渲染使用 SoonSpace.js（内置 Three.js）。

![img.png](img.png)

# [API Documentation](https://bwtrobot.github.io/urobot-sdk-example/)


## Goals

- 提供一个可运行的全栈 SDK 示例，展示 uTwin 平台核心能力
- 前端在后端不可用时自动降级为演示模式（Mock 数据）
- 3D 场景支持 BIM 模型、PCD 点云、机器人位姿、导航路径的分层渲染
- ROS 坐标系到 Three.js 坐标系的统一变换


## SDK 4.1.0 机型查询

后端读取 `UROBOT_ACCESS_KEY`、`UROBOT_SECRET_KEY` 和 `UROBOT_ENDPOINT`。将 endpoint 指向已部署对应开放接口的服务地址，不包含 `/api/open/v1`；未配置时沿用项目既有开发环境默认值。前端开发服务器将 `/api` 代理到本地 8080。请通过环境变量配置凭据，不写入仓库。

机器人列表返回动态机型编码 `model_code`，可将其传给只读机型查询：

```bash
curl --get 'http://localhost:8080/robot/model' --data-urlencode 'modelCode=实际机型编码'
```

前端通过 `getRobotModel(modelCode)` 调用同一接口，返回 `{ data, source, reason? }`。详情保持 camelCase，历史字段为 `terminal_type` 和 `terminal_type_value`，字段或文件引用可能为 null。列表兼容 `model_code` 与 `modelCode`，无需将动态编码转换为旧枚举。

查询失败时沿用前端演示降级，`source: 'mock'` 及调试日志明确标记演示来源。演示资源不代表真实下载地址；真实集成验收必须确认 `source: 'real'`。本次接入查询能力，三维模型仍沿用现有本地 URDF 加载逻辑。

验证命令：

```bash
mvn -q test
cd frontend
npm test
npm run build
```

本地后端集成测试通过 BFF 和真实 SDK 访问随机端口 HTTP 桩，测试参数编码、完整详情、文件引用、空值和失败响应；测试使用虚拟凭据。真实环境只读联调另见[验证记录](openspec/changes/sync-sdk-410-robot-model/validation.md)，其中分别记录本地集成成功与测试环境鉴权失败的结果。
