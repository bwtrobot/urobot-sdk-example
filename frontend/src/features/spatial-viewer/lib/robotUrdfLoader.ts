import * as THREE from 'three';
import URDFLoader from 'urdf-loader';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { ColladaLoader } from 'three/examples/jsm/loaders/ColladaLoader.js';
import { unzip } from 'fflate';

export interface RobotUrdfSource {
  url: string;
  mainPath?: string | null;
  fileName?: string | null;
  contentType?: string | null;
  packagePath?: string;
}
export interface LoadedRobotUrdf { robot: THREE.Object3D; dispose(): void; }

/** 下载并持有整个机器人资源，调用方移除场景节点后释放。 */
export function loadRobotUrdf(source: RobotUrdfSource, signal?: AbortSignal): Promise<LoadedRobotUrdf> {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const released = new Set<object>();
    const pendingMaterials = new Set<THREE.Material>();
    const blobUrls = new Map<string, string>();
    let robot: THREE.Object3D | undefined;
    let closed = false;
    let delivered = false;
    let manager: THREE.LoadingManager | undefined;
    let cancelUnzip: (() => void) | undefined;
    const release = (resource: { dispose(): void }) => {
      if (!released.has(resource)) { released.add(resource); resource.dispose(); }
    };
    const releaseObject = (object: THREE.Object3D) => object.traverse(node => {
      const mesh = node as THREE.Mesh;
      if (mesh.geometry) release(mesh.geometry);
      const materials = mesh.material ? (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) : [];
      for (const material of materials) {
        for (const value of Object.values(material)) if (value instanceof THREE.Texture) release(value);
        release(material);
      }
    });
    const dispose = () => {
      if (closed) return;
      closed = true;
      controller.abort(); cancelUnzip?.(); manager?.abort();
      signal?.removeEventListener('abort', abort);
      if (robot) releaseObject(robot);
      for (const material of pendingMaterials) {
        for (const value of Object.values(material)) if (value instanceof THREE.Texture) release(value);
        release(material);
      }
      for (const url of blobUrls.values()) URL.revokeObjectURL(url);
      blobUrls.clear();
    };
    const fail = (error: unknown) => { if (!closed) { dispose(); reject(error); } };
    const abort = () => fail(new DOMException('机器人资源加载已取消', 'AbortError'));
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });
    void (async () => {
      const response = await fetch(source.url, { signal: controller.signal });
      if (!response.ok) throw new Error(`机器人资源下载失败：HTTP ${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (closed) return;
      const documentUrl = new URL(source.url, globalThis.location?.href || 'http://localhost/');
      const isZip = /\.zip$/i.test(new URL(source.fileName || documentUrl.pathname, documentUrl).pathname)
        || /zip/i.test(source.contentType || response.headers.get('content-type') || '')
        || (bytes[0] === 0x50 && bytes[1] === 0x4b);
      let files: Record<string, Uint8Array> | undefined;
      let main = '';
      const virtualRoot = 'https://robot-archive.invalid/';
      const normalize = (path: string) => decodeURIComponent(new URL(path.replace(/\\/g, '/'), virtualRoot).pathname.slice(1));
      if (isZip) {
        files = await new Promise<Record<string, Uint8Array>>((done, error) => {
          cancelUnzip = unzip(bytes, (err, result) => err ? error(err) : done(result));
        });
        if (closed) return;
        // 保留完整目录关系，禁止通过同名文件猜测网格或主文件。
        files = Object.fromEntries(Object.entries(files).map(([path, value]) => [normalize(path), value]));
        if (source.mainPath) main = normalize(source.mainPath);
        else {
          const candidates = Object.keys(files).filter(path => /\.urdf$/i.test(path));
          if (candidates.length !== 1) throw new Error('ZIP 中缺少唯一 URDF 主文件，请指定 mainPath');
          main = candidates[0];
        }
        if (!files[main]) throw new Error(`ZIP 中缺少主文件：${main}`);
      }
      const text = new TextDecoder().decode(files ? files[main] : bytes);
      const document = new DOMParser().parseFromString(text, 'application/xml');
      if (document.querySelector('parsererror') || document.documentElement.tagName !== 'robot') throw new Error('机器人资源不是有效 URDF XML');
      const base = files ? new URL(main, virtualRoot) : documentUrl;
      const resolveReference = (reference: string) => {
        if (!reference.startsWith('package://')) return new URL(reference, base).href;
        const [pkg, ...rest] = reference.slice(10).split('/');
        let root: URL;
        if (source.packagePath) {
          root = new URL(source.packagePath.replace(/\/$/, '') + '/', files ? virtualRoot : documentUrl);
          if (root.pathname.split('/').filter(Boolean).slice(-1)[0] !== pkg) root = new URL(pkg + '/', root);
        } else {
          const parts = base.pathname.split('/');
          const index = parts.lastIndexOf(pkg);
          root = index >= 0 ? new URL(parts.slice(0, index + 1).join('/') + '/', base) : new URL('../' + pkg + '/', base);
        }
        return new URL(rest.join('/'), root).href;
      };
      // 先规范化路径，避免 URDFLoader 对绝对路径重复拼接 workingPath。
      for (const element of document.querySelectorAll('mesh[filename], texture[filename]')) {
        const url = resolveReference(element.getAttribute('filename')!);
        if (files && !files[normalize(url)]) throw new Error(`ZIP 中缺少引用资源：${normalize(url)}`);
        element.setAttribute('filename', url);
      }
      manager = new THREE.LoadingManager();
      const loadingManager = manager;
      manager.setURLModifier(url => {
        if (!files) return url;
        const path = normalize(url);
        if (!files[path]) throw new Error(`ZIP 中缺少引用资源：${path}`);
        if (!blobUrls.has(path)) blobUrls.set(path, URL.createObjectURL(new Blob([files[path].slice().buffer])));
        return blobUrls.get(path)!;
      });
      manager.onError = url => fail(new Error(`机器人引用资源加载失败：${url}`));
      manager.onLoad = () => {
        if (closed || delivered || !robot) return;
        delivered = true;
        resolve({ robot, dispose });
      };
      const loader = new URDFLoader(manager);
      loader.workingPath = '';
      loader.loadMeshCb = (url, _, done) => {
        // 独立哨兵覆盖解析器回调，确保网格挂载之后才允许整体完成。
        loadingManager.itemStart(url);
        // 先让解析器把 URDF 材质交给占位节点，取消期间也能确定释放归属。
        const placeholder = new THREE.Mesh();
        release(placeholder.geometry);
        for (const material of Array.isArray(placeholder.material) ? placeholder.material : [placeholder.material]) release(material);
        done(placeholder);
        const urdfMaterial = placeholder.material;
        for (const material of Array.isArray(urdfMaterial) ? urdfMaterial : [urdfMaterial]) pendingMaterials.add(material);
        const complete = (object?: THREE.Object3D, error?: unknown) => {
          if (closed) { if (object) releaseObject(object); loadingManager.itemEnd(url); return; }
          if (error) { fail(error); loadingManager.itemEnd(url); return; }
          if (object) {
            const parent = placeholder.parent;
            placeholder.removeFromParent();
            if (object instanceof THREE.Mesh) object.material = urdfMaterial;
            parent?.add(object);
          }
          loadingManager.itemEnd(url);
        };
        const extension = new URL(url, base).pathname.toLowerCase();
        try {
          if (extension.endsWith('.stl')) {
            new STLLoader(loadingManager).load(url, geometry => {
              const material = new THREE.MeshPhongMaterial();
              const mesh = new THREE.Mesh(geometry, material);
              complete(mesh);
              // URDFLoader 会同步替换 STL 临时材质，释放被替换的实例。
              release(material);
            }, undefined, error => complete(undefined, error));
          } else if (extension.endsWith('.dae')) {
            new ColladaLoader(loadingManager).load(url, dae => {
              if (!dae) { complete(undefined, new Error('DAE 资源为空')); return; }
              const group = new THREE.Group(); group.add(dae.scene); complete(group);
            }, undefined, error => complete(undefined, error));
          } else complete(undefined, new Error(`不支持的机器人网格格式：${url}`));
        } catch (error) { complete(undefined, error); }
      };
      manager.itemStart('机器人解析');
      robot = loader.parse(document);
      // 同步解析失败或取消时，补释放尚未赋值时创建的节点。
      if (closed) releaseObject(robot);
      manager.itemEnd('机器人解析');
    })().catch(fail);
  });
}
