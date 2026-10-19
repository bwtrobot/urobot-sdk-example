import { useEffect, useImperativeHandle, useRef, useState, forwardRef, type ReactNode } from 'react';
import type {
  MapEdition,
  NavigationPath,
  RobotRuntime,
  RobotSummary,
  TopologyPath,
} from '../../../shared/types/api';
import { createSpatialScene, type ActivePathData, type RenderSettings, type SpatialSceneAdapter } from '../lib/spatialScene';

export interface SpatialViewerHandle {
  getAdapter(): SpatialSceneAdapter;
}
import { LayerDropdown, type LayerVisibility } from './LayerDropdown';
import { RenderDropdown } from './RenderDropdown';
import './spatial-viewer.css';

interface SpatialViewerProps {
  edition: MapEdition | null;
  robot: RobotSummary | null;
  runtime: RobotRuntime | null;
  navPaths: NavigationPath[];
  topoPaths: TopologyPath[];
  activePathData?: ActivePathData | null;
  layers: LayerVisibility;
  renderSettings: RenderSettings;
  onLayersChange: (layers: LayerVisibility) => void;
  onRenderSettingsChange: (settings: RenderSettings) => void;
  motionPad?: ReactNode;
  debugDrawer?: ReactNode;
}

export const SpatialViewer = forwardRef<SpatialViewerHandle, SpatialViewerProps>(function SpatialViewer({
  edition,
  robot,
  runtime,
  navPaths,
  topoPaths,
  activePathData,
  layers,
  renderSettings,
  onLayersChange,
  onRenderSettingsChange,
  motionPad,
  debugDrawer,
}, ref) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const adapterRef = useRef(createSpatialScene());

  useImperativeHandle(ref, () => ({
    getAdapter: () => adapterRef.current,
  }));
  const [viewerError, setViewerError] = useState<string | null>(null);
  const [robotModelError, setRobotModelError] = useState<string | null>(null);
  const [viewerReady, setViewerReady] = useState(false);

  useEffect(() => {
    const host = hostRef.current;
    const adapter = adapterRef.current;

    if (!host) {
      return;
    }

    setViewerError(null);
    setViewerReady(false);

    try {
      adapter.mount(host);
      setViewerReady(true);
    } catch (error) {
      const message = error instanceof Error ? error.message : '3D viewer unavailable';
      setViewerError(message);
    }

    return () => {
      adapter.dispose();
      setViewerReady(false);
    };
  }, []);

  useEffect(() => {
    if (!viewerReady) return;
    void adapterRef.current.loadEdition(edition);
  }, [edition, viewerReady]);

  useEffect(() => {
    if (!viewerReady) return;
    adapterRef.current.loadRobotModel(robot);
    setRobotModelError(null);
  }, [robot, viewerReady]);

  useEffect(() => {
    if (!viewerReady) return;
    const syncError = () => setRobotModelError(adapterRef.current.getRobotModelError());
    syncError();
    const timer = window.setInterval(syncError, 250);
    return () => window.clearInterval(timer);
  }, [viewerReady]);

  useEffect(() => {
    if (!viewerReady) return;
    adapterRef.current.updateRobotRuntime(runtime);
  }, [runtime, viewerReady]);

  useEffect(() => {
    if (!viewerReady) return;
    // 优先使用互斥路径数据，否则回退旧接口
    if (activePathData !== undefined) {
      adapterRef.current.setActivePathData(activePathData ?? null);
    } else {
      adapterRef.current.setNavigationData(navPaths, topoPaths);
    }
  }, [navPaths, topoPaths, activePathData, viewerReady]);

  useEffect(() => {
    if (!viewerReady) return;
    adapterRef.current.setLayerVisibility(layers);
  }, [layers, viewerReady]);

  useEffect(() => {
    if (!viewerReady) return;
    adapterRef.current.setRenderSettings(renderSettings);
  }, [renderSettings, viewerReady]);

  return (
    <section className="spatial-viewer" aria-label="Spatial viewer">
      <div ref={hostRef} className="spatial-canvas-host" />
      {viewerError ? (
        <div className="spatial-viewer-fallback" role="status">
          3D 视图不可用：{viewerError}
        </div>
      ) : null}
      {robotModelError ? (
        <div className="spatial-robot-error" role="alert">
          <span>机器人模型加载失败：{robotModelError}</span>
          <button type="button" onClick={() => { adapterRef.current.retryRobotModel(); setRobotModelError(null); }}>
            重试
          </button>
        </div>
      ) : null}

      <div className="spatial-toolbar" aria-label="Spatial viewer toolbar">
        <LayerDropdown layers={layers} onChange={onLayersChange} />
        <RenderDropdown
          settings={renderSettings}
          onChange={onRenderSettingsChange}
        />
      </div>

      {motionPad ? <div className="spatial-motion-slot">{motionPad}</div> : null}
      {debugDrawer ? <div className="spatial-debug-slot">{debugDrawer}</div> : null}
    </section>
  );
});
