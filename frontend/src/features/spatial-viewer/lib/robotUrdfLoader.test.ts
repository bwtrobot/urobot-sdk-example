import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { zipSync, strToU8 } from 'fflate';
import { loadRobotUrdf } from './robotUrdfLoader';

const meshLoads = vi.hoisted(() => [] as Array<{url: string; done: (g: THREE.BufferGeometry) => void; fail: (e: Error) => void; manager: THREE.LoadingManager}>);
vi.mock('three/examples/jsm/loaders/STLLoader.js', () => ({ STLLoader: class {
  constructor(private manager: THREE.LoadingManager) {}
  load(url: string, done: (g: THREE.BufferGeometry) => void, _: unknown, fail: (e: Error) => void) { meshLoads.push({ url, done, fail, manager: this.manager }); }
} }));
const xml = (filename?: string) => `<robot name="测试"><link name="base"><visual><geometry>${filename ? `<mesh filename="${filename}"/>` : '<box size="1 2 3"/>'}</geometry></visual></link></robot>`;
function respond(body: string | Uint8Array, type = '') {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, headers: new Headers({ 'Content-Type': type }), arrayBuffer: async () => typeof body === 'string' ? strToU8(body).buffer : body.buffer })));
}
afterEach(() => { vi.unstubAllGlobals(); meshLoads.length = 0; });
describe('机器人 URDF 资源加载', () => {
  it('真实解析直接 XML，重复释放仅销毁一次', async () => {
    respond(xml());
    const result = await loadRobotUrdf({ url: 'https://robot.test/a/model.urdf' });
    expect(result.robot.name).toBe('base');
    let mesh!: THREE.Mesh;
    result.robot.traverse(o => { if (o instanceof THREE.Mesh) mesh = o; });
    const dispose = vi.spyOn(mesh.geometry, 'dispose');
    result.dispose(); result.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
  });
  it.each(['../meshes/A.STL?sign=123#v', 'package://demo/meshes/A.STL?sign=123#v'])('等待网格并正确解析路径 %s', async filename => {
    respond(xml(filename));
    let settled = false;
    const pending = loadRobotUrdf({ url: 'https://robot.test/demo/urdf/model.urdf', packagePath: 'https://robot.test/demo' }).then(v => { settled = true; return v; });
    await vi.waitFor(() => expect(meshLoads).toHaveLength(1));
    expect(meshLoads[0].url).toBe('https://robot.test/demo/meshes/A.STL?sign=123#v');
    expect(settled).toBe(false);
    meshLoads[0].done(new THREE.BufferGeometry());
    (await pending).dispose();
  });
  it('ZIP 精确选择主路径并为引用创建和释放 Blob URL', async () => {
    const create = vi.fn(() => 'blob:mesh'); const revoke = vi.fn();
    vi.stubGlobal('URL', Object.assign(class extends URL {}, { createObjectURL: create, revokeObjectURL: revoke }));
    respond(zipSync({ 'demo/urdf/main.urdf': strToU8(xml('../mesh.stl')), 'demo/mesh.stl': new Uint8Array([1]), 'other.urdf': strToU8(xml()) }));
    const pending = loadRobotUrdf({ url: 'https://robot.test/archive?token=x', mainPath: 'demo/urdf/main.urdf' });
    await vi.waitFor(() => expect(meshLoads).toHaveLength(1));
    expect(meshLoads[0].manager.resolveURL(meshLoads[0].url)).toBe('blob:mesh');
    meshLoads[0].done(new THREE.BufferGeometry());
    (await pending).dispose();
    expect(create).toHaveBeenCalledTimes(1); expect(revoke).toHaveBeenCalledWith('blob:mesh');
  });
  const invalidArchives: Array<Record<string, Uint8Array>> = [{ 'a.urdf': strToU8(xml()), 'b.urdf': strToU8(xml()) }, { 'readme.txt': strToU8('无模型') }];
  it.each(invalidArchives)('ZIP 主文件缺失或歧义时失败', async files => {
    respond(zipSync(files as Record<string, Uint8Array>));
    await expect(loadRobotUrdf({ url: 'https://robot.test/model.zip' })).rejects.toThrow();
  });
  it('非法 XML 和未知网格格式失败', async () => {
    respond('<html/>'); await expect(loadRobotUrdf({ url: 'https://robot.test/a' })).rejects.toThrow();
    respond(xml('a.obj')); await expect(loadRobotUrdf({ url: 'https://robot.test/a' })).rejects.toThrow();
  });
  it('网格失败向调用方报告', async () => {
    respond(xml('a.stl'));
    const pending = loadRobotUrdf({ url: 'https://robot.test/a' });
    const assertion = expect(pending).rejects.toThrow('网格失败');
    await vi.waitFor(() => expect(meshLoads).toHaveLength(1));
    meshLoads[0].fail(new Error('网格失败')); await assertion;
  });
  it('取消后拒绝并销毁迟到网格', async () => {
    respond(xml('a.stl')); const materialDispose = vi.spyOn(THREE.Material.prototype, 'dispose'); const controller = new AbortController();
    const pending = loadRobotUrdf({ url: 'https://robot.test/a' }, controller.signal);
    const assertion = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(meshLoads).toHaveLength(1));
    controller.abort(); await assertion;
    expect(materialDispose).toHaveBeenCalled(); materialDispose.mockRestore();
    const geometry = new THREE.BufferGeometry(); const dispose = vi.spyOn(geometry, 'dispose');
    meshLoads[0].done(geometry); expect(dispose).toHaveBeenCalledTimes(1);
  });
});

it('HTTP 错误立即失败', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 403 })));
  await expect(loadRobotUrdf({ url: 'https://robot.test/a' })).rejects.toThrow('403');
});
it.each([
  { files: { 'a.urdf': strToU8(xml()) }, mainPath: 'missing.urdf' },
  { files: { 'a.urdf': strToU8(xml('missing.stl')) }, mainPath: 'a.urdf' },
])('指定主文件或引用文件不存在时失败', async ({files, mainPath}) => {
  respond(zipSync(files as Record<string, Uint8Array>));
  await expect(loadRobotUrdf({ url: 'https://robot.test/a.zip', mainPath })).rejects.toThrow('缺少');
});
it('ZIP 包路径按完整目录解析', async () => {
  respond(zipSync({ 'root/demo/urdf/main.urdf': strToU8(xml('package://demo/meshes/a.stl')), 'root/demo/meshes/a.stl': new Uint8Array([1]) }));
  const pending = loadRobotUrdf({ url: 'https://robot.test/a.zip' });
  await vi.waitFor(() => expect(meshLoads).toHaveLength(1));
  expect(meshLoads[0].url).toBe('https://robot-archive.invalid/root/demo/meshes/a.stl');
  meshLoads[0].done(new THREE.BufferGeometry()); (await pending).dispose();
});
it('纹理完成后交付并释放纹理与材质', async () => {
  const texture = new THREE.Texture<HTMLImageElement>(); const disposeTexture = vi.spyOn(texture, 'dispose');
  let finish!: () => void;
  const load = vi.spyOn(THREE.TextureLoader.prototype, 'load').mockImplementation(function (this: THREE.TextureLoader, url: string) {
    this.manager.itemStart(url); finish = () => this.manager.itemEnd(url); return texture;
  });
  respond(xml().replace('<geometry>', '<material name="贴图"><texture filename="skin.png"/></material><geometry>'));
  let settled = false;
  const pending = loadRobotUrdf({ url: 'https://robot.test/robot.urdf' }).then(value => { settled = true; return value; });
  await vi.waitFor(() => expect(load).toHaveBeenCalled());
  expect(load.mock.calls[0][0]).toBe('https://robot.test/skin.png'); expect(settled).toBe(false);
  finish(); const result = await pending;
  let material!: THREE.Material;
  result.robot.traverse(node => { if (node instanceof THREE.Mesh) material = node.material as THREE.Material; });
  const disposeMaterial = vi.spyOn(material, 'dispose'); result.dispose(); result.dispose();
  expect(disposeTexture).toHaveBeenCalledTimes(1); expect(disposeMaterial).toHaveBeenCalledTimes(1); load.mockRestore();
});
