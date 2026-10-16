# SDK 4.1.0 动态机型模型加载实施计划

本计划使用 superpowers:writing-plans 编制，由 superpowers:subagent-driven-development 按任务执行并分别进行规格和质量审查。

**目标：** 在同一 OpenSpec 变更内完成 model_code 查询到实际三维模型的加载链路。

**架构：** 独立资源加载模块负责 URDF/ZIP、网格、贴图与释放；现有场景适配器负责查询、加载代次、占位、位姿和聚焦；组件只展示加载状态。已有 API 来源机制和旧型号映射复用。

**技术栈：** React、TypeScript、Three.js、urdf-loader、fflate、Vitest。

## 任务一：资源加载（对应 5.1、5.2）

文件：新增 `frontend/src/features/spatial-viewer/lib/robotUrdfLoader.ts` 与 `.test.ts`；更新 `frontend/package.json`、`package-lock.json`。

固定接口：

```ts
export interface RobotUrdfSource {
  url: string;
  mainPath?: string | null;
  fileName?: string | null;
  contentType?: string | null;
  packagePath?: string;
}
export interface LoadedRobotUrdf {
  robot: import('three').Object3D;
  dispose(): void;
}
export function loadRobotUrdf(source: RobotUrdfSource, signal?: AbortSignal): Promise<LoadedRobotUrdf>;
```

先写真实最小 URDF XML 与 fflate 生成 ZIP 的失败测试，再运行 `npx vitest run src/features/spatial-viewer/lib/robotUrdfLoader.test.ts` 确认失败来自缺失能力。实现 fetch 下载、异步解压、主文件确定、LoadingManager URL 映射、STL/DAE 网格及贴图，等待所有子资源完成。失败、取消和 dispose 必须释放对象及创建的 Blob URL，dispose 幂等。网格扩展名识别需兼容签名 query 与大小写，加载回调失败必须结束等待。再运行相同用例通过并完成两阶段审查。

## 任务二：场景接入（对应 5.3、5.4）

文件：修改 `frontend/src/features/spatial-viewer/lib/spatialScene.ts`、`frontend/src/features/spatial-viewer/components/SpatialViewer.tsx` 及相关 CSS；新增场景与组件测试。

先用可控 Promise 的查询与资源加载替身、轻量 SoonSpace 场景替身写接入测试，运行确认失败。`loadRobotModel` 改为 Promise<void>，组件用 `void` 调用并在作用域内维护加载反馈。场景以非空 model_code（兼容 modelCode）为动态键，同键返回在途 Promise 或复用已加载模型；新键取消旧加载并增加代次。只有真实详情且含 urdf.url 才调用资源加载器：

```ts
const response = await getRobotModel(modelCode);
if (response.source !== 'real' || !response.data?.urdf?.url) {
  throw new Error('机型资源不可用');
}
const asset = await loadRobotUrdf({
  url: response.data.urdf.url,
  mainPath: response.data.urdfMainPath,
  fileName: response.data.urdf.fileName,
  contentType: response.data.urdf.contentType,
}, signal);
```

过期 asset 只调用 dispose，当前 asset 替换占位后施加 -PI/2 X 轴坐标转换、最新位姿与聚焦；有编码失败只显示简易模型，无编码使用已有本地 URDF 配置。切换与销毁调用已显示 asset.dispose 并清除父组引用，防止重复释放。组件加载状态只由当前请求完成时更新，卸载不再更新状态。测试覆盖 A→B→A、同码不同机器人、失败重试、销毁后迟到、最新位姿和释放。

## 任务三：回归交付（对应 5.5）

运行 `npm test`、`npm run build` 和项目根目录 `openspec validate sync-sdk-410-robot-model --strict`。审查资源和场景测试通过后更新 README、validation.md 及任务勾选。真实环境上游 500 的既有结论保持，不把夹具模型渲染描述为真实环境通过。使用限定路径提交，保留用户其他文档及暂存内容，按已有授权合并到 feature/dev 并在原目录复验。
