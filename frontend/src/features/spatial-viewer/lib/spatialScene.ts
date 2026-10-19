import * as THREE from 'three';
import SoonSpace from 'soonspacejs';
import CpsSoonmanagerPlugin from '@soonspacejs/plugin-cps-soonmanager';
import { PCDLoader } from 'three/examples/jsm/loaders/PCDLoader.js';
import { ColladaLoader } from 'three/examples/jsm/loaders/ColladaLoader.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import URDFLoader from 'urdf-loader';
import { getRobotModel } from '../../../services/api/robotApi';
import type {
  MapEdition,
  NavigationPath,
  PathNode,
  QuaternionValue,
  RobotRuntime,
  RobotSummary,
  TopologyPath,
  Vector3Value,
} from '../../../shared/types/api';
import {
  robotToThreeMatrix,
  rosPositionToThree,
  rosQuaternionToThree,
  threePositionToRos,
  threeQuaternionToRos,
} from '../../../shared/utils/pose';
import type { LayerVisibility } from '../components/LayerDropdown';
import { createRobotFocusViewpoint } from './spatialCamera';
import { PointCloud2Parser, applyRobotToThree, type PointCloud2Message } from './pointCloud2Parser';
import { loadRobotUrdf, normalizeColladaGeometry, type LoadedRobotUrdf } from './robotUrdfLoader';

export interface RenderSettings {
  pointSize: 'small' | 'medium' | 'large';
  opacity: 'low' | 'medium' | 'solid';
  bimWireframe: boolean;
}

export interface ActivePathData {
  type: 'nav' | 'topo';
  path: NavigationPath | TopologyPath;
  selectedNodeIds: Set<string>;
}

export interface SpatialSceneAdapter {
  mount(container: HTMLDivElement): void;
  loadEdition(edition: MapEdition | null): Promise<void>;
  loadRobotModel(robot: RobotSummary | null): void;
  updateRobotRuntime(runtime: RobotRuntime | null): void;
  retryRobotModel(): void;
  getRobotModelError(): string | null;
  setNavigationData(navPaths: NavigationPath[], topoPaths: TopologyPath[]): void;
  setActivePathData(data: ActivePathData | null): void;
  setLayerVisibility(layers: LayerVisibility): void;
  setRenderSettings(settings: RenderSettings): void;
  updateRealtimePointCloud(message: PointCloud2Message): void;
  // 位姿标定
  enterPoseCalibration(): void;
  exitPoseCalibration(): void;
  confirmCalibration(): { position: Vector3Value; orientation: QuaternionValue } | null;
  onPoseConfirmed(cb: (pose: { position: Vector3Value; orientation: QuaternionValue }) => void): () => void;
  dispose(): void;
}

const pointSizes: Record<RenderSettings['pointSize'], number> = {
  small: 0.06,
  medium: 0.1,
  large: 0.16,
};

const opacityValues: Record<RenderSettings['opacity'], number> = {
  low: 0.35,
  medium: 0.65,
  solid: 1,
};

const pcdLoader = new PCDLoader();

class SoonSpaceSceneAdapter implements SpatialSceneAdapter {
  private ssp: SoonSpace | null = null;
  private cpsPlugin: CpsSoonmanagerPlugin | null = null;
  private container: HTMLDivElement | null = null;
  private renderSettings: RenderSettings = {
    pointSize: 'medium',
    opacity: 'solid',
    bimWireframe: false,
  };

  // 节点渲染复用的共享 geometry，避免每次 setActivePathData 时大量创建
  private readonly sharedGeometry = {
    nodeNormal: new THREE.SphereGeometry(0.1, 16, 16),
    nodeSelected: new THREE.SphereGeometry(0.15, 16, 16),
  };

  private readonly groups = {
    helpers: new THREE.Group(),
    bim: new THREE.Group(),
    globalPointCloud: new THREE.Group(),
    groundPointCloud: new THREE.Group(),
    realtimePointCloud: new THREE.Group(),
    paths: new THREE.Group(),
    calibration: new THREE.Group(),
  };
  private readonly robot = new THREE.Group();
  private realtimePointCloud: THREE.Points | null = null;
  // 当前已加载的机型标识，避免重复加载
  private loadedRobotModelKey: string | null = null;
  private selectedRobotId: string | null = null;
  private latestRuntime: RobotRuntime | null = null;
  private hasFocusedRobot = false;
  private robotModelPending = false;
  private robotModelGeneration = 0;
  private robotModelAbort: AbortController | null = null;
  private loadedRobotAsset: LoadedRobotUrdf | null = null;
  private currentRobot: RobotSummary | null = null;
  private robotModelError: string | null = null;

  mount(container: HTMLDivElement) {
    this.dispose();
    this.container = container;

    const ssp = new SoonSpace({
      el: container,
      options: {
        showInfo: false,
        showGrid: false,
        background: {
          color: 0xf6f8fb,
        },
      },
    });

    // 灯光
    ssp.createAmbientLight({ id: 'ambient', intensity: 0.7, color: 0xffffff });
    ssp.createDirectionalLight({
      id: 'directional',
      intensity: 0.75,
      color: 0xffffff,
      position: { x: 8, y: 12, z: 6 },
    });

    // 网格辅助线
    this.groups.helpers.add(new THREE.GridHelper(20, 20, 0xc6d0dc, 0xe0e6ee));

    // 将所有分组添加到 SoonSpace 的 Three.js 场景
    const scene = ssp.viewport.scene;
    Object.values(this.groups).forEach((group) => scene.add(group));
    this.buildFallbackRobotMesh();
    scene.add(this.robot);

    this.ssp = ssp;
  }

  async loadEdition(edition: MapEdition | null) {
    this.clearGroup(this.groups.bim);
    this.clearGroup(this.groups.globalPointCloud);
    this.clearGroup(this.groups.groundPointCloud);

    if (!edition) return;

    // 并行加载 BIM 和点云
    await Promise.all([
      this.loadBim(edition),
      this.loadPointCloud(edition.globalMap, 0x00ff00, this.groups.globalPointCloud),
      this.loadPointCloud(edition.groundMap, 0x0000ff, this.groups.groundPointCloud),
    ]);

    this.applyRenderSettings();
  }

  updateRobotRuntime(runtime: RobotRuntime | null) {
    this.latestRuntime = runtime;
    this.applyRobotRuntimePose(runtime);
    this.focusRobotOnce();
  }

  retryRobotModel() {
    if (!this.currentRobot) return;
    this.loadedRobotModelKey = null;
    this.loadRobotModel(this.currentRobot);
  }

  getRobotModelError() {
    return this.robotModelError;
  }

  private applyRobotRuntimePose(runtime: RobotRuntime | null) {
    const pose = runtime?.ros_odom?.pose;
    this.robot.visible = this.selectedRobotId !== null && !this.robotModelPending;
    if (!pose) {
      // 无定位数据时以地图原点预览，并让模型最低点落在地面上，避免 URDF 原点使机身陷入地图。
      this.robot.position.set(0, 0, 0);
      this.robot.quaternion.identity();
      const bounds = new THREE.Box3().setFromObject(this.robot);
      if (!bounds.isEmpty()) this.robot.position.y = -bounds.min.y;
      this.ssp?.render();
      return;
    }

    // ROS 坐标 → Three.js 坐标
    const threePos = rosPositionToThree(pose.position);
    this.robot.position.copy(threePos);

    const threeQuat = rosQuaternionToThree(pose.orientation);
    this.robot.quaternion.copy(threeQuat);
    this.ssp?.render();
  }

  /** @deprecated 由 setActivePathData 替代，仅保留向后兼容 */
  setNavigationData(_navPaths: NavigationPath[], _topoPaths: TopologyPath[]) {
    this.clearGroup(this.groups.paths);
  }

  setActivePathData(data: ActivePathData | null) {
    this.clearGroup(this.groups.paths);
    if (!data) return;

    const { type, path, selectedNodeIds } = data;
    const coordinateFrame = path.coordinateFrame ?? 'ROBOT';

    // 渲染路径线条
    if (type === 'nav') {
      const line = this.createLineFromPositions(
        path.nodes.map((n) => n.position),
        0xf97316,
        coordinateFrame,
      );
      if (line) this.groups.paths.add(line);
    } else {
      const topoPath = path as TopologyPath;
      const nodeById = new Map(topoPath.nodes.map((n) => [n.id, n.position]));
      topoPath.edges.forEach((edge) => {
        const start = nodeById.get(edge.snode);
        const end = nodeById.get(edge.enode);
        if (!start || !end) return;
        const line = this.createLineFromPositions([start, end], 0x6366f1, coordinateFrame);
        if (line) this.groups.paths.add(line);
      });
    }

    // 渲染节点圆球和名称标签
    path.nodes.forEach((node) => {
      const isSelected = selectedNodeIds.has(node.id);
      const geometry = isSelected ? this.sharedGeometry.nodeSelected : this.sharedGeometry.nodeNormal;
      const color = isSelected ? 0xfbbf24 : 0x94a3b8;

      // 计算节点在 Three.js 坐标系中的位置
      const pos = coordinateFrame === 'THREE'
        ? new THREE.Vector3(node.position.x, node.position.y, node.position.z)
        : rosPositionToThree(node.position);

      // 圆球标记（共享 geometry，仅创建新 material）
      const sphere = new THREE.Mesh(
        geometry,
        new THREE.MeshStandardMaterial({ color }),
      );
      sphere.position.copy(pos);
      this.groups.paths.add(sphere);

      // 名称文字标签（Canvas Sprite）
      if (node.name) {
        const sprite = this.createTextSprite(node.name);
        sprite.position.copy(pos);
        sprite.position.y += 0.25;
        this.groups.paths.add(sprite);
      }
    });
  }

  setLayerVisibility(layers: LayerVisibility) {
    this.groups.bim.visible = layers.bim;
    this.groups.globalPointCloud.visible = layers.globalPointCloud;
    this.groups.groundPointCloud.visible = layers.groundPointCloud;
    this.groups.paths.visible = layers.paths;
    this.groups.realtimePointCloud.visible = layers.realtimePointCloud;
  }

  setRenderSettings(settings: RenderSettings) {
    this.renderSettings = settings;
    this.applyRenderSettings();
  }

  updateRealtimePointCloud(message: PointCloud2Message) {
    if (!this.ssp) return;
    try {
      const cloud = PointCloud2Parser.parse(message);
      applyRobotToThree(cloud.positions);
      const points = this.ensureRealtimePointCloud(cloud.count);
      const geometry = points.geometry;
      const position = geometry.getAttribute('position') as THREE.BufferAttribute;
      const color = geometry.getAttribute('color') as THREE.BufferAttribute;
      position.array.set(cloud.positions);
      color.array.set(cloud.colors);
      position.needsUpdate = true;
      color.needsUpdate = true;
      geometry.setDrawRange(0, cloud.count);
      this.ssp.render();
    } catch (error) {
      console.warn('[RealtimePointCloud] 解析失败', error);
    }
  }

  dispose() {
    this.robotModelGeneration++;
    this.robotModelAbort?.abort();
    this.robotModelAbort = null;
    this.releaseRobotAsset();
    Object.values(this.groups).forEach((group) => this.clearGroup(group));
    this.clearGroup(this.robot);

    // 销毁 SoonSpace 实例（内部清理 scene、renderer、controls）
    if (this.ssp) {
      this.ssp.dispose();
      this.ssp = null;
    }
    this.cpsPlugin = null;
    this.loadedRobotModelKey = null;
    this.currentRobot = null;
    this.robotModelError = null;
    this.selectedRobotId = null;
    this.latestRuntime = null;
    this.hasFocusedRobot = false;
    this.robotModelPending = false;
  }

  // ── BIM 加载 ──

  private async loadBim(edition: MapEdition) {
    if (!edition.bim?.fileUrl || !this.ssp) return;

    // 注册 CPS 插件并加载 BIM 场景
    const cpsPlugin = this.ssp.registerPlugin(CpsSoonmanagerPlugin, 'cps');
    this.cpsPlugin = cpsPlugin;

    cpsPlugin.setPath(edition.bim.fileUrl);
    await cpsPlugin.loadScene();

    // CPS 插件加载的模型通过 sceneGroup 访问，移入 bim 分组统一管理图层可见性
    if (cpsPlugin.sceneGroup) {
      const sceneObj = cpsPlugin.sceneGroup as unknown as THREE.Object3D;
      sceneObj.parent?.remove(sceneObj);
      this.groups.bim.add(sceneObj);
    }

    // 应用 BIM 变换参数（已是 Three.js 坐标系，直接应用）
    const bim = edition.bim;
    this.groups.bim.position.set(bim.position.x, bim.position.y, bim.position.z);
    this.groups.bim.scale.set(bim.scale.x, bim.scale.y, bim.scale.z);
    this.groups.bim.quaternion.set(
      bim.orientation.x,
      bim.orientation.y,
      bim.orientation.z,
      bim.orientation.w,
    );
  }

  // ── 点云加载 ──

  private async loadPointCloud(url: string | undefined, color: number, group: THREE.Group) {
    if (!url) return;

    const points = await pcdLoader.loadAsync(url);
    const material = points.material as THREE.PointsMaterial;
    material.color.set(color);
    material.size = pointSizes[this.renderSettings.pointSize];

    // ROS 坐标系 → Three.js 坐标系
    points.applyMatrix4(robotToThreeMatrix);
    group.add(points);
  }

  // ── 机器人 mesh ──

  /** 构建默认的简易机器人 Mesh（无 URDF 时使用） */
  private buildFallbackRobotMesh() {
    this.releaseRobotAsset();
    this.clearGroup(this.robot);

    const body = new THREE.Mesh(
      new THREE.BoxGeometry(0.7, 0.35, 0.5),
      new THREE.MeshStandardMaterial({ color: 0x0f766e, roughness: 0.45 }),
    );
    body.position.y = 0.18;

    const heading = new THREE.Mesh(
      new THREE.ConeGeometry(0.18, 0.35, 24),
      new THREE.MeshStandardMaterial({ color: 0xf59e0b, roughness: 0.4 }),
    );
    heading.position.set(0, 0.38, -0.35);
    heading.rotation.x = Math.PI / 2;

    this.robot.add(body, heading);
    this.robot.visible = false;
  }

  /** 优先按动态机型编码加载资源；旧数据仍按终端类型选择本地模型。 */
  loadRobotModel(robot: RobotSummary | null) {
    this.currentRobot = robot;
    this.robotModelError = null;
    if (this.selectedRobotId !== (robot?.id ?? null)) {
      this.selectedRobotId = robot?.id ?? null;
      this.latestRuntime = null;
    }
    const modelCode = robot?.model_code?.trim() ? robot.model_code : robot?.modelCode?.trim() ? robot.modelCode : null;
    const robotModelType = this.resolveRobotModelType(robot);
    const robotModelKey = modelCode ? `code:${modelCode}` : robotModelType?.key ?? null;
    // 同一机型不重复加载
    if (robotModelKey === this.loadedRobotModelKey) {
      this.applyRobotRuntimePose(this.latestRuntime);
      this.focusRobotOnce();
      return;
    }
    this.robotModelGeneration++;
    this.robotModelAbort?.abort();
    this.robotModelAbort = null;
    this.loadedRobotModelKey = robotModelKey;
    this.hasFocusedRobot = false;

    if (modelCode) {
      this.buildFallbackRobotMesh();
      this.robotModelPending = true;
      // 资源未完整加载前不展示占位模型，避免用户误以为 URDF 已经渲染完成。
      this.robot.visible = false;
      const generation = this.robotModelGeneration;
      const controller = new AbortController();
      this.robotModelAbort = controller;
      // 查询与资源下载跨越两个异步边界，代次检查防止旧机型覆盖新场景。
      void (async () => {
        try {
          const response = await getRobotModel(modelCode);
          if (controller.signal.aborted || generation !== this.robotModelGeneration) return;
          const file = response.source === 'real' ? response.data.urdf : null;
          if (!file?.url) throw new Error('机型 URDF 资源不可用');
          const asset = await loadRobotUrdf({
            url: file.url,
            mainPath: response.data.urdfMainPath,
            fileName: file.fileName,
            contentType: file.contentType,
          }, controller.signal);
          if (controller.signal.aborted || generation !== this.robotModelGeneration) {
            asset.dispose();
            return;
          }
          this.clearGroup(this.robot);
          this.loadedRobotAsset = asset;
          asset.robot.rotation.x = -Math.PI / 2;
          this.robot.add(asset.robot);
          this.robotModelPending = false;
          this.robotModelError = null;
          this.applyRobotRuntimePose(this.latestRuntime);
          this.focusRobotOnce();
          this.ssp?.render();
        } catch (error) {
          if (controller.signal.aborted || generation !== this.robotModelGeneration) return;
          console.warn('[URDF] 机型资源加载失败，使用默认模型', error);
          this.robotModelPending = false;
          this.robotModelError = error instanceof Error ? error.message : '机器人 URDF 资源加载失败';
          this.loadedRobotModelKey = null;
          this.buildFallbackRobotMesh();
          this.applyRobotRuntimePose(this.latestRuntime);
          this.focusRobotOnce();
        }
      })();
      return;
    }

    // 无法识别机型时使用默认 Mesh
    if (!robotModelType) {
      this.robotModelPending = false;
            this.robotModelError = null;
      this.buildFallbackRobotMesh();
      this.applyRobotRuntimePose(this.latestRuntime);
      this.focusRobotOnce();
      return;
    }

    // 判定机型分类：CANINE 前缀 = 四足，HUMAN 前缀 = 人形
    const urdfConfig = this.resolveUrdfConfig(robotModelType);
    if (!urdfConfig) {
      this.robotModelPending = false;
      this.buildFallbackRobotMesh();
      this.applyRobotRuntimePose(this.latestRuntime);
      this.focusRobotOnce();
      return;
    }

    // 异步加载 URDF 模型
    this.robotModelPending = true;
    this.robot.visible = false;
    const loader = new URDFLoader();
    loader.loadMeshCb = this.createUrdfMeshLoader();
    loader.packages = () => urdfConfig.packagePath;
    const generation = this.robotModelGeneration;
    loader.loadAsync(urdfConfig.urdfUrl).then((urdfRobot) => {
      // 确保加载完成时机型未切换
      if (generation !== this.robotModelGeneration) {
        this.disposeObject(urdfRobot);
        return;
      }
      this.robotModelPending = false;
      this.clearGroup(this.robot);
      // URDF 坐标系为 Z-up（ROS），Three.js/SoonSpace 为 Y-up，需绕 X 轴旋转 -90°
      urdfRobot.rotation.x = -Math.PI / 2;
      // 统一材质为金属质感
      urdfRobot.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          child.material = new THREE.MeshStandardMaterial({
            color: (child.material as THREE.MeshStandardMaterial).color ?? new THREE.Color(0x888888),
            metalness: 0.7,
            roughness: 0.5,
          });
        }
      });
      this.robot.add(urdfRobot);
      // URDF 是异步加载的，runtime 可能已经先到；加载完成后必须重新应用最新位姿，避免模型被隐藏在原点。
      this.applyRobotRuntimePose(this.latestRuntime);
      this.focusRobotOnce();
      this.ssp?.render();
    }).catch((err) => {
      console.warn('[URDF] 加载失败，使用默认模型', err);
      if (generation === this.robotModelGeneration) {
        this.robotModelPending = false;
        this.robotModelError = err instanceof Error ? err.message : '机器人 URDF 资源加载失败';
        this.buildFallbackRobotMesh();
        this.applyRobotRuntimePose(this.latestRuntime);
        this.focusRobotOnce();
      }
    });
  }

  private releaseRobotAsset() {
    if (!this.loadedRobotAsset) return;
    this.loadedRobotAsset.robot.removeFromParent();
    this.loadedRobotAsset.dispose();
    this.loadedRobotAsset = null;
  }

  /**
   * 根据机器人类型解析 URDF 文件路径
   * 值定义参考后端 TerminalTypeEnums
   */
  private resolveUrdfConfig(robotModelType: { category: 'human' | 'canine'; value?: number }): { packagePath: string; urdfUrl: string } | null {
    // HUMAN 人形: 1=G1-23, 4=G1-29, 7=H2, 8=PM01
    // CANINE 四足: 0=Go2, 2=B2, 3=X30, 5=B2-W, 6=Go2-W, 9=A2, 10=Q25, 11=A2-W
    if (robotModelType.category === 'human') {
      // 人形统一使用 g1_23dof URDF（项目中可用的人形模型）
      const urdfFile = robotModelType.value === 4 ? 'g1_29dof.urdf' : 'g1_23dof.urdf';
      return {
        packagePath: '/urdf/g1_description/',
        urdfUrl: `/urdf/g1_description/${urdfFile}`,
      };
    }
    if (robotModelType.category === 'canine') {
      // 四足统一使用 b2_description URDF（项目中可用的四足模型）
      return {
        packagePath: '/urdf/b2_description',
        urdfUrl: '/urdf/b2_description/b2_description.urdf',
      };
    }
    return null;
  }

  private resolveRobotModelType(robot: RobotSummary | null): { key: string; category: 'human' | 'canine'; value?: number } | null {
    const terminalValue = robot?.terminalTypeValue ?? robot?.terminal_type_value;
    const humanTypes = new Set([1, 4, 7, 8]);
    const canineTypes = new Set([0, 2, 3, 5, 6, 9, 10, 11]);

    if (terminalValue != null) {
      if (humanTypes.has(terminalValue)) return { key: `human-${terminalValue}`, category: 'human', value: terminalValue };
      if (canineTypes.has(terminalValue)) return { key: `canine-${terminalValue}`, category: 'canine', value: terminalValue };
    }

    const typeText = [
      robot?.terminalType,
      robot?.terminal_type,
      robot?.deviceTypeDesc,
      robot?.device_type_desc,
    ].filter(Boolean).join(' ').toLowerCase();

    // 兼容平台只返回字符串描述的场景，避免缺失 terminal_type_value 时无法加载 URDF。
    if (/(human|humanoid|人形|g1|h2|pm01)/i.test(typeText)) {
      return { key: `human-${typeText}`, category: 'human' };
    }
    if (/(canine|quadruped|四足|机器狗|go2|b2|x30|a2|q25)/i.test(typeText)) {
      return { key: `canine-${typeText}`, category: 'canine' };
    }

    return null;
  }

  /** URDF Mesh 加载回调：支持 DAE (Collada) 和 STL 格式 */
  private createUrdfMeshLoader() {
    return (
      path: string,
      manager: THREE.LoadingManager,
      done: (mesh: THREE.Object3D, err?: Error) => void,
    ) => {
      if (/\.dae$/i.test(path)) {
        new ColladaLoader(manager).load(path, (dae) => {
          if (dae?.scene) {
            dae.scene.traverse((node) => {
              if (node instanceof THREE.Mesh) normalizeColladaGeometry(node.geometry);
            });
            done(dae.scene);
          }
        });
      } else if (/\.stl$/i.test(path)) {
        new STLLoader(manager).load(path, (geom) => done(new THREE.Mesh(geom)));
      } else {
        console.warn(`[URDF] 不支持的 mesh 格式: ${path}`);
      }
    };
  }

  private focusRobotOnce() {
    if (!this.ssp || this.robotModelPending || this.hasFocusedRobot || !this.robot.visible) return;

    const box = new THREE.Box3().setFromObject(this.robot);
    const center = box.isEmpty()
      ? this.robot.position.clone()
      : box.getCenter(new THREE.Vector3());
    const sphere = box.isEmpty()
      ? new THREE.Sphere(center, 1)
      : box.getBoundingSphere(new THREE.Sphere());
    const viewpoint = createRobotFocusViewpoint(center, sphere.radius);

    this.hasFocusedRobot = true;
    void this.ssp.controls.setLookAt(
      viewpoint.position.x,
      viewpoint.position.y,
      viewpoint.position.z,
      viewpoint.target.x,
      viewpoint.target.y,
      viewpoint.target.z,
      true,
    ).then(() => this.ssp?.render());
  }

  // ── 路径渲染 ──

  private createLineFromPositions(
    positions: Vector3Value[],
    color: number,
    coordinateFrame: 'ROBOT' | 'THREE' = 'ROBOT',
  ) {
    if (positions.length < 2) return null;

    // 路径详情可能来自 SDK 的 THREE 坐标，也可能来自 mock/旧接口的 ROBOT 坐标。
    const points = positions.map((p) => {
      const v = coordinateFrame === 'THREE'
        ? new THREE.Vector3(p.x, p.y, p.z)
        : rosPositionToThree(p);
      v.y += 0.03;
      return v;
    });

    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    return new THREE.Line(
      geometry,
      new THREE.LineBasicMaterial({ color, linewidth: 2 }),
    );
  }

  // ── 渲染设置 ──

  private applyRenderSettings() {
    const settings = this.renderSettings;
    const pointSize = pointSizes[settings.pointSize];
    const opacity = opacityValues[settings.opacity];

    [this.groups.globalPointCloud, this.groups.groundPointCloud, this.groups.realtimePointCloud].forEach((group) => {
      group.traverse((object) => {
        if (object instanceof THREE.Points) {
          const material = object.material as THREE.PointsMaterial;
          material.size = pointSize;
          material.opacity = opacity;
          material.transparent = opacity < 1;
          material.needsUpdate = true;
        }
      });
    });

    this.groups.bim.traverse((object) => {
      if (object instanceof THREE.Mesh) {
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        materials.forEach((mat: THREE.Material) => {
          if (mat instanceof THREE.MeshStandardMaterial || mat instanceof THREE.MeshBasicMaterial) {
            mat.wireframe = settings.bimWireframe;
            mat.opacity = opacity;
            mat.transparent = opacity < 1;
            mat.needsUpdate = true;
          }
        });
      }
    });
  }

  private ensureRealtimePointCloud(maxPoints: number) {
    if (this.realtimePointCloud) return this.realtimePointCloud;

    const geometry = new THREE.BufferGeometry();
    const position = new THREE.BufferAttribute(new Float32Array(maxPoints * 3), 3);
    const color = new THREE.BufferAttribute(new Float32Array(maxPoints * 3), 3);
    position.setUsage(THREE.DynamicDrawUsage);
    color.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('position', position);
    geometry.setAttribute('color', color);
    geometry.setDrawRange(0, 0);

    const material = new THREE.PointsMaterial({
      size: pointSizes[this.renderSettings.pointSize],
      color: 0xff2b2b,
      vertexColors: false,
      opacity: opacityValues[this.renderSettings.opacity],
      transparent: this.renderSettings.opacity !== 'solid',
    });
    this.realtimePointCloud = new THREE.Points(geometry, material);
    this.groups.realtimePointCloud.add(this.realtimePointCloud);
    return this.realtimePointCloud;
  }

  // ── 文字标签 ──

  private createTextSprite(text: string): THREE.Sprite {
    const scale = Math.min(window.devicePixelRatio, 2) * 2;
    const fontSize = 14 * scale;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d')!;

    ctx.font = `bold ${fontSize}px sans-serif`;
    const metrics = ctx.measureText(text);
    const padding = 4 * scale;
    canvas.width = metrics.width + padding * 2;
    canvas.height = fontSize + padding * 2;

    // 重设 font（canvas 尺寸变更后会重置）
    ctx.font = `bold ${fontSize}px sans-serif`;
    ctx.fillStyle = '#1e293b';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, padding, canvas.height / 2);

    const texture = new THREE.CanvasTexture(canvas);
    texture.minFilter = THREE.LinearFilter;
    const material = new THREE.SpriteMaterial({ map: texture, depthTest: false });
    const sprite = new THREE.Sprite(material);
    // 保持文字大小适中
    sprite.scale.set(canvas.width / canvas.height * 0.3, 0.3, 1);
    return sprite;
  }

  // ── 位姿标定（参照 robot-central-web PoseControls 实现） ──

  private calibrationState: {
    active: boolean;
    arrow: THREE.Mesh | null;
    arrowDirection: THREE.Vector3;
    confirmCallback: ((pose: { position: Vector3Value; orientation: QuaternionValue }) => void) | null;
    pointerDownHandler: ((e: PointerEvent) => void) | null;
    pointerMoveHandler: ((e: PointerEvent) => void) | null;
    pointerUpHandler: ((e: PointerEvent) => void) | null;
    intersectPoint: THREE.Vector3 | null;
    isDragging: boolean;
  } = {
    active: false,
    arrow: null,
    arrowDirection: new THREE.Vector3(1, 0, 0),
    confirmCallback: null,
    pointerDownHandler: null,
    pointerMoveHandler: null,
    pointerUpHandler: null,
    intersectPoint: null,
    isDragging: false,
  };

  /**
   * 创建 3D 箭头 Mesh（圆柱杆 + 圆锥头），与 robot-central-web Arrow 一致
   */
  private createArrowMesh(origin: THREE.Vector3): THREE.Mesh {
    const length = 0.8;
    const headLength = 0.15;
    const shaftDiameter = 0.07;
    const headDiameter = 0.15;
    const shaftLength = length - headLength;

    // 箭杆：圆柱体
    const shaftGeo = new THREE.CylinderGeometry(shaftDiameter * 0.5, shaftDiameter * 0.5, shaftLength, 12, 1);
    shaftGeo.applyMatrix4(new THREE.Matrix4().makeTranslation(0, shaftLength * 0.5, 0));

    // 箭头：圆锥体
    const headGeo = new THREE.CylinderGeometry(0, headDiameter * 0.5, headLength, 12, 1);
    headGeo.applyMatrix4(new THREE.Matrix4().makeTranslation(0, shaftLength + headLength * 0.5, 0));

    // 合并几何体
    const merged = mergeGeometries([shaftGeo, headGeo]);
    const material = new THREE.MeshStandardMaterial({ color: 0xff0000, depthTest: false });
    const mesh = new THREE.Mesh(merged ?? shaftGeo, material);
    mesh.renderOrder = 999;
    mesh.position.copy(origin);
    return mesh;
  }

  /**
   * 设置箭头朝向（direction 为 XZ 平面上的方向向量）
   */
  private setArrowDirection(arrow: THREE.Mesh, direction: THREE.Vector3) {
    const up = new THREE.Vector3(0, 1, 0);
    const axis = new THREE.Vector3().crossVectors(up, direction);
    if (axis.length() < 1e-6) return;
    const radians = Math.acos(Math.min(1, up.dot(direction.clone().normalize())));
    const rotMatrix = new THREE.Matrix4().makeRotationAxis(axis.normalize(), radians);
    arrow.rotation.setFromRotationMatrix(rotMatrix);
  }

  enterPoseCalibration() {
    if (!this.ssp) return;
    // 防御重复进入：先清理上一次标定状态
    if (this.calibrationState.active) {
      this.exitPoseCalibration();
    }
    this.calibrationState.active = true;

    const ssp = this.ssp;
    // 禁用相机左键旋转，防止标定拖拽被拦截（参照 PoseControls 方式）
    const originalMouseLeft = ssp.controls.mouseButtons.left;
    const originalTouchOne = ssp.controls.touches.one;

    // 确保地面点云可见（标定依赖它）
    this.groups.groundPointCloud.visible = true;

    // 配置点云射线检测阈值
    ssp.viewport.raycaster.params.Points.threshold = 0.5;

    // 水平参考面（用于拖拽计算朝向）
    const plane = new THREE.Plane(new THREE.Vector3(0, -1, 0), 0);
    const dirVec = new THREE.Vector3();

    // 事件绑定目标：SoonSpace 的 domElement
    const eventTarget = ssp.domElement as HTMLElement;

    // 鼠标按下：射线检测点云 → 创建箭头
    this.calibrationState.pointerDownHandler = (e: PointerEvent) => {
      if (this.calibrationState.intersectPoint) return;

      // 使用 SoonSpace 内置射线检测（getIntersects 接受 PointerEvent）
      const intersects = ssp.viewport
        .getIntersects(e, [this.groups.groundPointCloud])
        .sort((a: THREE.Intersection, b: THREE.Intersection) =>
          ((a as any).distanceToRay ?? a.distance) - ((b as any).distanceToRay ?? b.distance));

      const hit = intersects[0];
      if (!hit) return;

      // 点云类型需要从 geometry attribute 获取精确顶点位置
      const snapPoint = new THREE.Vector3();
      if (hit.object instanceof THREE.Points && hit.index != null) {
        snapPoint
          .fromBufferAttribute(hit.object.geometry.getAttribute('position') as THREE.BufferAttribute, hit.index)
          .applyMatrix4(hit.object.matrixWorld);
      } else {
        snapPoint.copy(hit.point);
      }

      // 清除上一个箭头
      if (this.calibrationState.arrow) {
        ssp.removeObject(this.calibrationState.arrow);
      }

      // 创建箭头 Mesh 并通过 SoonSpace API 添加到场景
      const arrow = this.createArrowMesh(snapPoint);
      ssp.addObject(arrow);
      ssp.render();

      this.calibrationState.arrow = arrow;
      this.calibrationState.intersectPoint = snapPoint.clone();
      this.calibrationState.isDragging = true;

      // 设置参考面高度为吸附点 Y 值
      plane.constant = snapPoint.y;

      // 禁用相机控制（与参考项目一致的方式）
      ssp.controls.mouseButtons.left = SoonSpace.ACTION.NONE;
      ssp.controls.touches.one = SoonSpace.ACTION.NONE;

      eventTarget.setPointerCapture(e.pointerId);
    };

    // 鼠标移动：拖拽更新箭头朝向
    this.calibrationState.pointerMoveHandler = (e: PointerEvent) => {
      if (!this.calibrationState.isDragging || !this.calibrationState.arrow || !this.calibrationState.intersectPoint) return;
      e.preventDefault();

      // 更新 raycaster
      const rect = eventTarget.getBoundingClientRect();
      const pointer = new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      );
      ssp.viewport.raycaster.setFromCamera(pointer, ssp.viewport.camera);

      // 射线与水平面求交，计算拖拽方向
      ssp.viewport.raycaster.ray.intersectPlane(plane, dirVec);
      dirVec.sub(this.calibrationState.intersectPoint).normalize();

      // 更新箭头朝向并记录方向
      this.setArrowDirection(this.calibrationState.arrow, dirVec);
      this.calibrationState.arrowDirection.copy(dirVec);
      ssp.render();
    };

    // 鼠标抬起：结束拖拽
    this.calibrationState.pointerUpHandler = (e: PointerEvent) => {
      if (!this.calibrationState.isDragging) return;
      this.calibrationState.isDragging = false;
      eventTarget.releasePointerCapture(e.pointerId);

      // 恢复相机控制
      ssp.controls.mouseButtons.left = originalMouseLeft;
      ssp.controls.touches.one = originalTouchOne;
    };

    eventTarget.addEventListener('pointerdown', this.calibrationState.pointerDownHandler);
    eventTarget.addEventListener('pointermove', this.calibrationState.pointerMoveHandler);
    eventTarget.addEventListener('pointerup', this.calibrationState.pointerUpHandler);
    eventTarget.addEventListener('pointercancel', this.calibrationState.pointerUpHandler);
  }

  exitPoseCalibration() {
    if (!this.ssp) return;
    const state = this.calibrationState;

    // 清理事件监听
    const eventTarget = this.ssp.domElement as HTMLElement | null;
    if (eventTarget) {
      if (state.pointerDownHandler) eventTarget.removeEventListener('pointerdown', state.pointerDownHandler);
      if (state.pointerMoveHandler) eventTarget.removeEventListener('pointermove', state.pointerMoveHandler);
      if (state.pointerUpHandler) {
        eventTarget.removeEventListener('pointerup', state.pointerUpHandler);
        eventTarget.removeEventListener('pointercancel', state.pointerUpHandler);
      }
    }

    // 通过 SoonSpace API 移除箭头对象
    if (state.arrow) {
      this.ssp.removeObject(state.arrow);
      this.ssp.render();
    }

    // 恢复相机控制
    this.ssp.controls.enabled = true;

    // 重置状态
    this.calibrationState = {
      active: false, arrow: null, arrowDirection: new THREE.Vector3(1, 0, 0),
      confirmCallback: null, pointerDownHandler: null, pointerMoveHandler: null,
      pointerUpHandler: null, intersectPoint: null, isDragging: false,
    };
  }

  onPoseConfirmed(cb: (pose: { position: Vector3Value; orientation: QuaternionValue }) => void): () => void {
    this.calibrationState.confirmCallback = cb;
    return () => { this.calibrationState.confirmCallback = null; };
  }

  /** 外部调用确认标定，返回当前标记的 ROS 坐标位姿 */
  confirmCalibration(): { position: Vector3Value; orientation: QuaternionValue } | null {
    const { arrow, arrowDirection, confirmCallback } = this.calibrationState;
    if (!arrow) return null;

    // 将 Three.js 箭头位置转换为 ROS 坐标
    const position = threePositionToRos(arrow.position);

    // 将 Three.js 箭头方向转换为 ROS 四元数
    // Three.js 方向 → ROS 方向，再求与 ROS 初始前方 (1,0,0) 的旋转四元数
    const threeToRobot = robotToThreeMatrix.clone().invert();
    const robotDir = arrowDirection.clone().applyMatrix4(threeToRobot).normalize();
    const initialDir = new THREE.Vector3(1, 0, 0); // ROS 前方
    const quat = new THREE.Quaternion().setFromUnitVectors(initialDir, robotDir);
    const orientation = { x: quat.x, y: quat.y, z: quat.z, w: quat.w };

    const pose = { position, orientation };
    if (confirmCallback) confirmCallback(pose);
    return pose;
  }

  // ── 工具方法 ──

  private clearGroup(group: THREE.Group) {
    group.children.slice().forEach((child) => {
      group.remove(child);
      this.disposeObject(child);
    });
  }

  private disposeObject(object: THREE.Object3D) {
    object.traverse((child) => {
      if (child instanceof THREE.Mesh || child instanceof THREE.Points || child instanceof THREE.Line) {
        child.geometry.dispose();
        const materials = Array.isArray(child.material) ? child.material : [child.material];
        materials.forEach((m) => m?.dispose());
      }
    });
  }
}

export function createSpatialScene(): SpatialSceneAdapter {
  return new SoonSpaceSceneAdapter();
}
