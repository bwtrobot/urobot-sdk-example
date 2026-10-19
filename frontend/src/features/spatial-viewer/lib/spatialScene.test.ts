import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { createRobotFocusViewpoint } from './spatialCamera';
import { createSpatialScene } from './spatialScene';
import { getRobotModel } from '../../../services/api/robotApi';
import { loadRobotUrdf } from './robotUrdfLoader';

vi.mock('../../../services/api/robotApi', () => ({ getRobotModel: vi.fn() }));
vi.mock('./robotUrdfLoader', () => ({ loadRobotUrdf: vi.fn() }));
vi.mock('@soonspacejs/plugin-cps-soonmanager', () => ({ default: class {} }));
vi.mock('soonspacejs', () => ({ default: class {} }));

afterEach(() => vi.clearAllMocks());

describe('机器人机型资源', () => {
  it('使用 model_code 查询出的 URDF 地址，而非本地机型文件', async () => {
    const scene = createSpatialScene();
    const asset = { robot: new THREE.Group(), dispose: vi.fn() };
    vi.mocked(getRobotModel).mockResolvedValue({ source: 'real', data: {
      modelCode: 'new-model', urdfMainPath: 'robot/main.urdf',
      urdf: { url: 'https://robot.test/model.zip', fileName: 'model.zip', contentType: 'application/zip', fileId: 'file-1', disposition: null },
    } as Awaited<ReturnType<typeof getRobotModel>>['data'] });
    vi.mocked(loadRobotUrdf).mockResolvedValue(asset);

    scene.loadRobotModel({ id: 'robot-1', name: '测试机器人', model_code: 'new-model', terminalTypeValue: 1 });
    await vi.waitFor(() => expect(loadRobotUrdf).toHaveBeenCalledWith({
      url: 'https://robot.test/model.zip', mainPath: 'robot/main.urdf',
      fileName: 'model.zip', contentType: 'application/zip',
    }, expect.any(AbortSignal)));
    expect(getRobotModel).toHaveBeenCalledWith('new-model');
    scene.dispose();
    expect(asset.dispose).toHaveBeenCalledTimes(1);
  });

  it('同编码复用在途查询，切换后忽略旧查询结果', async () => {
    const scene = createSpatialScene();
    let resolveOld!: (value: Awaited<ReturnType<typeof getRobotModel>>) => void;
    vi.mocked(getRobotModel).mockImplementation(code => code === 'old'
      ? new Promise(resolve => { resolveOld = resolve; })
      : Promise.resolve({ source: 'mock', data: {} as Awaited<ReturnType<typeof getRobotModel>>['data'] }));
    const oldRobot = { id: '1', name: '旧机器人', model_code: 'old' };
    scene.loadRobotModel(oldRobot);
    scene.loadRobotModel({ ...oldRobot, id: '2' });
    expect(getRobotModel).toHaveBeenCalledTimes(1);
    scene.loadRobotModel({ id: '3', name: '新机器人', model_code: 'new' });
    resolveOld({ source: 'real', data: {
      urdf: { url: 'https://robot.test/old.urdf' },
    } as Awaited<ReturnType<typeof getRobotModel>>['data'] });
    await vi.waitFor(() => expect(getRobotModel).toHaveBeenCalledTimes(2));
    await Promise.resolve();
    expect(loadRobotUrdf).not.toHaveBeenCalled();
    scene.dispose();
  });

  it('mock 机型没有资源时使用简易模型且允许重试', async () => {
    const scene = createSpatialScene();
    vi.mocked(getRobotModel).mockResolvedValue({ source: 'mock', data: {} as Awaited<ReturnType<typeof getRobotModel>>['data'] });
    const robot = { id: '1', name: '测试机器人', modelCode: 'demo', terminalTypeValue: 1 };
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    scene.loadRobotModel(robot);
    await vi.waitFor(() => expect(warning).toHaveBeenCalled());
    expect(loadRobotUrdf).not.toHaveBeenCalled();
    scene.loadRobotModel(robot);
    await vi.waitFor(() => expect(getRobotModel).toHaveBeenCalledTimes(2));
    scene.dispose();
    warning.mockRestore();
  });

  it('资源下载期间保留最新位姿的简易模型', () => {
    const scene = createSpatialScene();
    vi.mocked(getRobotModel).mockImplementation(() => new Promise(() => {}));
    scene.loadRobotModel({ id: '1', name: '测试机器人', model_code: 'pending' });
    scene.updateRobotRuntime({ ros_odom: { pose: {
      position: { x: 2, y: 3, z: 0 },
      orientation: { x: 0, y: 0, z: 0, w: 1 },
    } } });
    const robotGroup = (scene as unknown as { robot: THREE.Group }).robot;
    expect(robotGroup.visible).toBe(false);
    expect(robotGroup.position.length()).toBeGreaterThan(0);
    scene.dispose();
  });

  it('选中机器人但运行时缺少位姿时显示原点模型，不沿用上一台坐标', async () => {
    const scene = createSpatialScene();
    const asset = { robot: new THREE.Group(), dispose: vi.fn() };
    const setLookAt = vi.fn().mockResolvedValue(undefined);
    const renderScene = vi.fn();
    const disposeScene = vi.fn();
    (scene as unknown as { ssp: unknown }).ssp = {
      controls: { setLookAt }, render: renderScene, dispose: disposeScene,
    };
    vi.mocked(getRobotModel).mockResolvedValue({ source: 'real', data: {
      urdfMainPath: 'g1_29dof.urdf',
      urdf: { url: 'https://robot.test/u2_urdf.zip', fileName: 'u2_urdf.zip' },
    } as Awaited<ReturnType<typeof getRobotModel>>['data'] });
    vi.mocked(loadRobotUrdf).mockResolvedValue(asset);
    scene.loadRobotModel({ id: 'old', name: '旧机器人' });
    scene.updateRobotRuntime({ ros_odom: { pose: {
      position: { x: 3, y: 4, z: 0 },
      orientation: { x: 0, y: 0, z: 0, w: 1 },
    } } });
    scene.loadRobotModel({ id: 'u2', name: 'U2', model_code: 'U2' });
    scene.updateRobotRuntime(null);
    await vi.waitFor(() => expect(loadRobotUrdf).toHaveBeenCalled());
    const robotGroup = (scene as unknown as { robot: THREE.Group }).robot;
    await vi.waitFor(() => expect(robotGroup.children).toContain(asset.robot));
    expect(robotGroup.visible).toBe(true);
    expect(robotGroup.position.toArray()).toEqual([0, 0, 0]);
    expect(setLookAt).toHaveBeenCalled();
    scene.dispose();
  });

  it('无位姿预览将 URDF 最低点放在地面，真实位姿不受预览偏移影响', async () => {
    const scene = createSpatialScene();
    const model = new THREE.Group();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    mesh.position.y = -0.5;
    model.add(mesh);
    const asset = { robot: model, dispose: vi.fn() };
    vi.mocked(getRobotModel).mockResolvedValue({ source: 'real', data: {
      urdfMainPath: 'b2_description.urdf',
      urdf: { url: 'https://robot.test/B2_urdf.zip', fileName: 'B2_urdf.zip' },
    } as Awaited<ReturnType<typeof getRobotModel>>['data'] });
    vi.mocked(loadRobotUrdf).mockResolvedValue(asset);

    scene.loadRobotModel({ id: 'b2', name: 'B2', model_code: 'B2' });
    const robotGroup = (scene as unknown as { robot: THREE.Group }).robot;
    await vi.waitFor(() => expect(robotGroup.children).toContain(model));
    expect(new THREE.Box3().setFromObject(robotGroup).min.y).toBeCloseTo(0);

    scene.updateRobotRuntime({ ros_odom: { pose: {
      position: { x: 2, y: 3, z: 4 },
      orientation: { x: 0, y: 0, z: 0, w: 1 },
    } } });
    expect(robotGroup.position.y).toBeCloseTo(4);
    scene.updateRobotRuntime(null);
    expect(new THREE.Box3().setFromObject(robotGroup).min.y).toBeCloseTo(0);
    scene.dispose();
  });

  it('URDF 失败时记录错误并支持重新加载', async () => {
    const scene = createSpatialScene();
    const asset = { robot: new THREE.Group(), dispose: vi.fn() };
    vi.mocked(getRobotModel).mockResolvedValue({ source: 'real', data: {
      urdfMainPath: 'b2_description.urdf',
      urdf: { url: 'https://robot.test/B2_urdf.zip', fileName: 'B2_urdf.zip' },
    } as Awaited<ReturnType<typeof getRobotModel>>['data'] });
    vi.mocked(loadRobotUrdf)
      .mockRejectedValueOnce(new Error('DAE 三角化失败'))
      .mockResolvedValueOnce(asset);

    const robot = { id: 'b2', name: 'B2', model_code: 'B2' };
    scene.loadRobotModel(robot);
    await vi.waitFor(() => expect(scene.getRobotModelError()).toBe('DAE 三角化失败'));
    expect((scene as unknown as { robot: THREE.Group }).robot.visible).toBe(true);

    scene.retryRobotModel();
    await vi.waitFor(() => expect(loadRobotUrdf).toHaveBeenCalledTimes(2));
    expect(scene.getRobotModelError()).toBeNull();
    scene.dispose();
  });
});

describe('createRobotFocusViewpoint', () => {
  it('根据机器人位置生成斜上方初始视角', () => {
    const target = new THREE.Vector3(2, 0.5, -3);

    const viewpoint = createRobotFocusViewpoint(target, 1.2);

    expect(viewpoint.target).toEqual({ x: 2, y: 0.5, z: -3 });
    expect(viewpoint.position.x).toBeGreaterThan(viewpoint.target.x);
    expect(viewpoint.position.y).toBeGreaterThan(viewpoint.target.y);
    expect(viewpoint.position.z).toBeGreaterThan(viewpoint.target.z);
  });

  it('对过小包围盒使用最小观察距离', () => {
    const target = new THREE.Vector3(0, 0, 0);

    const viewpoint = createRobotFocusViewpoint(target, 0);

    const distance = new THREE.Vector3(
      viewpoint.position.x - viewpoint.target.x,
      viewpoint.position.y - viewpoint.target.y,
      viewpoint.position.z - viewpoint.target.z,
    ).length();
    expect(distance).toBeCloseTo(1.9);
    expect(viewpoint.target).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('B2 模型聚焦后在 50 度相机中占据至少一半画面高度', () => {
    const radius = 0.6884;
    const viewpoint = createRobotFocusViewpoint(new THREE.Vector3(), radius);
    const distance = new THREE.Vector3(
      viewpoint.position.x - viewpoint.target.x,
      viewpoint.position.y - viewpoint.target.y,
      viewpoint.position.z - viewpoint.target.z,
    ).length();
    const visibleHeight = 2 * distance * Math.tan(THREE.MathUtils.degToRad(25));

    expect(0.9776 / visibleHeight).toBeGreaterThan(0.5);
  });
});
