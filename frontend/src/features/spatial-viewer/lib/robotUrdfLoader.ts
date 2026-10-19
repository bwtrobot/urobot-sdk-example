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

/**
 * ColladaLoader 在部分 DAE 的多边形属性索引不一致时会生成破面。
 * 这里把所有属性展开到位置属性的三角顶点上，确保渲染只使用同一套索引。
 */
export function normalizeColladaGeometry(geometry: THREE.BufferGeometry) {
  const position = geometry.getAttribute('position');
  if (!position) return;

  const source = geometry.index ? geometry.toNonIndexed() : geometry;
  const vertexCount = source.getAttribute('position').count;
  const copyAttribute = (name: string, itemSize: number, fallback: number[]) => {
    const attribute = source.getAttribute(name);
    const values = new Float32Array(vertexCount * itemSize);
    for (let vertex = 0; vertex < vertexCount; vertex += 1) {
      const sourceVertex = attribute && attribute.count > 0 ? Math.min(vertex, attribute.count - 1) : -1;
      for (let component = 0; component < itemSize; component += 1) {
        values[vertex * itemSize + component] = sourceVertex >= 0
          ? attribute.getComponent(sourceVertex, component)
          : fallback[component] ?? 0;
      }
    }
    source.setAttribute(name, new THREE.BufferAttribute(values, itemSize));
  };

  // 法线和 UV 均补齐到与三角化后的位置顶点相同的数量。
  const hadNormals = Boolean(source.getAttribute('normal'));
  copyAttribute('normal', 3, [0, 1, 0]);
  if (!hadNormals) {
    source.computeVertexNormals();
  }
  copyAttribute('uv', 2, [0, 0]);
  if (source !== geometry) {
    geometry.copy(source);
  }
  geometry.setIndex(null);
}

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
        const candidates = Object.keys(files).filter(path => /\.urdf$/i.test(path));
        if (source.mainPath) {
          const requested = normalize(source.mainPath);
          if (files[requested]) main = requested;
          else {
            // mainPath 可能是对象存储完整键；只按目录边界匹配 ZIP 中真实存在的后缀。
            const matches = candidates.filter(path => requested.endsWith(`/${path}`)).sort((a, b) => b.length - a.length);
            if (matches.length > 0 && (matches.length === 1 || matches[0].length > matches[1].length)) main = matches[0];
          }
        } else {
          if (candidates.length !== 1) throw new Error('ZIP 中缺少唯一 URDF 主文件，请指定 mainPath');
          main = candidates[0];
        }
        if (!files[main]) throw new Error(`ZIP 中缺少主文件：${source.mainPath ?? main}`);
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
        const resolved = new URL(rest.join('/'), root).href;
        if (files && !files[normalize(resolved)]) {
          // 部分 ZIP 扁平化了 package 目录，优先用归档内实际存在的主文件相邻资源。
          const adjacent = new URL(rest.join('/'), base).href;
          if (files[normalize(adjacent)]) return adjacent;
        }
        return resolved;
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
              dae.scene.traverse((node) => {
                if (node instanceof THREE.Mesh) normalizeColladaGeometry(node.geometry);
              });
              // URDFLoader 挂载网格时会清除 DAE 根旋转；异步替换也需保留 ROS 的 Z-up 坐标系。
              dae.scene.quaternion.identity();
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
