## ADDED Requirements

### Requirement: 只读机型详情查询端点
系统 SHALL 提供 `GET /robot/model?modelCode=…`，通过 SDK 查询开放机型接口，返回统一 Result 包装的详情，包含上游机型全部详情字段及嵌套文件引用。系统 MUST 保留 camelCase 字段和历史 `terminal_type`、`terminal_type_value` 的名称及 null 语义。

#### Scenario: 查询动态机型
- **WHEN** 客户端提供有效的动态 modelCode
- **THEN** 返回对应机型详情和文件引用，不依赖旧机型枚举

#### Scenario: 历史字段为空
- **WHEN** 上游返回历史字段为 null 且包含嵌套文件信息
- **THEN** 响应保留 null 和嵌套文件字段，不返回空对象或虚构旧枚举值

#### Scenario: 参数缺失或空白
- **WHEN** modelCode 缺失、为空字符串或全部为空白
- **THEN** 返回统一错误响应，不发起上游查询

#### Scenario: 上游失败
- **WHEN** 上游返回业务错误或 HTTP 失败
- **THEN** 返回统一错误响应，不伪装为成功的机型详情

### Requirement: 机器人列表保留动态机型字段
系统 SHALL 在机器人列表响应中保留上游提供的动态机型编码及相关机型字段，不使用旧枚举替换或过滤动态编码。

#### Scenario: 动态机型机器人列表
- **WHEN** 上游列表返回具有动态机型编码的机器人
- **THEN** 下游能够读取原始编码并据此查询机型详情
