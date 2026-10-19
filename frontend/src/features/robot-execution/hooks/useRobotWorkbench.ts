import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  getChargingPoints,
  getMapEdition,
  getMapEditions,
  listRobotMaps,
  listNarrationProcesses,
  listNavigationPaths,
  listTopologyPaths,
} from '../../../services/api/mapApi';
import { threePositionToRos, threeQuaternionToRos } from '../../../shared/utils/pose';
import { isRobotOffline } from '../../../shared/utils/robotStatus';
import {
  activateMap as activateMapApi,
  buildCommandPayload,
  controlNarration as controlNarrationApi,
  getNarrationRuntime,
  getRobotRuntime,
  getTaskResults,
  listRobots,
  sendRobotCommand,
  type RobotCommandCode,
} from '../../../services/api/robotApi';
import { createRealtimeClient, getRealtimeSnapshot, type RealtimeClient } from '../../../services/api/realtimeApi';
import type { ApiRequestResult } from '../../../services/api/httpClient';
import type {
  MapEdition,
  MapItem,
  NavigationPath,
  NarrationCommand,
  NarrationProcessSummary,
  NarrationRuntimeInfo,
  PathNode,
  RealtimeConnectionStatus,
  RealtimeEvent,
  RealtimePushSummaryEntry,
  RealtimeTopicSubscription,
  RobotRuntime,
  RobotSummary,
  SegmentMode,
  TaskResult,
  TopologyPath,
} from '../../../shared/types/api';

// 任务终态集合，轮询到这些状态时停止
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'canceled', 'timeout', '完成', '失败', '已取消', '超时']);
const RUNTIME_POLL_INTERVAL_MS = 3000;
const NARRATION_RUNTIME_POLL_INTERVAL_MS = 10000;
const TASK_RESULT_MAX_POLLS = 30;
const TASK_RESULT_REALTIME_POLL_INTERVAL_MS = 5000;
const TASK_RESULT_FALLBACK_POLL_INTERVAL_MS = 2000;

export interface WorkbenchTask {
  taskId: string;
  commandCode: RobotCommandCode | 'activate_map';
  source: 'real' | 'mock';
  status: string;
  result?: TaskResult;
  realtimeSource?: boolean;
  updatedAt?: string;
  resultSummary?: string;
  compensationStatus?: 'idle' | 'polling' | 'done';
}

type WorkbenchTaskCommandCode = RobotCommandCode | 'activate_map';

export type ActivePathType = 'nav' | 'topo';

const ROBOT_CACHE_KEY = 'urobot-sdk:selected-robot-id';

export interface UseRobotWorkbenchOptions {
  // 点云/相机等渲染类 Topic 的解析后消息（rosbridge msg 体），交由页面分发到三维场景或相机画面
  onRealtimeTopicMessage?: (topic: string, message: Record<string, unknown>) => void;
}

export const realtimeTopicCatalog: RealtimeTopicSubscription[] = [
  { topic: '/x_nav/current_pointcloud', label: '实时点云', binary: true, throttleRate: 333, minFps: 1, maxFps: 10 },
  { topic: '/camera/color/image_raw/compressed/webp', label: '相机画面', binary: true, throttleRate: 200, minFps: 1, maxFps: 15 },
];

// 渲染类 Topic（点云/相机）：从「实时推送」摘要剥离，解析后直接渲染，不进摘要列表
const renderedRealtimeTopics = new Set(
  realtimeTopicCatalog.filter((item) => item.binary).map((item) => item.topic),
);

export function useRobotWorkbench(options: UseRobotWorkbenchOptions = {}) {
  const [robots, setRobots] = useState<RobotSummary[]>([]);
  const [robotsHasMore, setRobotsHasMore] = useState(false);
  const [robotsLoadingMore, setRobotsLoadingMore] = useState(false);
  const [robotsPageError, setRobotsPageError] = useState(false);
  const nextRobotPageRef = useRef(2);
  const robotPageBusyRef = useRef(false);
  const robotsHasMoreRef = useRef(false);
  // 优先从 localStorage 恢复上次选中的机器人
  const [selectedRobotId, setSelectedRobotIdRaw] = useState<string>(
    () => localStorage.getItem(ROBOT_CACHE_KEY) ?? '',
  );
  const [runtime, setRuntime] = useState<RobotRuntime | undefined>();
  const [edition, setEdition] = useState<MapEdition | undefined>();
  const [navPaths, setNavPaths] = useState<NavigationPath[]>([]);
  const [topoPaths, setTopoPaths] = useState<TopologyPath[]>([]);
  const [allMaps, setAllMaps] = useState<MapItem[]>([]);
  const [editionsMap, setEditionsMap] = useState<Record<string, MapEdition[]>>({});
  const [switchingEditionId, setSwitchingEditionId] = useState<string | undefined>();
  const [narrationProcesses, setNarrationProcesses] = useState<NarrationProcessSummary[]>([]);
  const [selectedProcessId, setSelectedProcessId] = useState('');
  const [narrationRuntime, setNarrationRuntime] = useState<NarrationRuntimeInfo[]>([]);
  const [segmentMode, setSegmentMode] = useState<SegmentMode>('collapsed');
  const segmentModeRef = useRef<SegmentMode>('collapsed');
  const narrationRuntimeRequestSeqRef = useRef(0);
  const [tasks, setTasks] = useState<WorkbenchTask[]>([]);
  const [realtimeStatus, setRealtimeStatus] = useState<RealtimeConnectionStatus>('DISCONNECTED');
  const [subscribedTopics, setSubscribedTopics] = useState<Set<string>>(new Set());
  const [latestRobotInfo, setLatestRobotInfo] = useState<Record<string, unknown> | undefined>();
  const [realtimeEvents, setRealtimeEvents] = useState<RealtimePushSummaryEntry[]>([]);
  const [demoMode, setDemoMode] = useState(false);
  const [loading, setLoading] = useState(true);
  // 交互模式：idle=常规, calibrating=位姿标定, nav-picking=单点导航选点
  const [interactionMode, setInteractionMode] = useState<'idle' | 'calibrating' | 'nav-picking'>('idle');

  // 选中机器人时同步写入 localStorage 缓存
  const setSelectedRobotId = useCallback((id: string | ((prev: string) => string)) => {
    setSelectedRobotIdRaw((prev) => {
      const next = typeof id === 'function' ? id(prev) : id;
      if (next) localStorage.setItem(ROBOT_CACHE_KEY, next);
      return next;
    });
  }, []);

  // 路径互斥选择状态
  const [activePathType, setActivePathType] = useState<ActivePathType>('nav');
  const [selectedPathId, setSelectedPathId] = useState<string>('');
  const [selectedNodeIds, setSelectedNodeIds] = useState<Set<string>>(new Set());
  const realtimeClientRef = useRef<RealtimeClient | null>(null);
  const realtimeTopicHandlerRef = useRef(options.onRealtimeTopicMessage);
  const realtimeSeqRef = useRef(0);

  useEffect(() => {
    realtimeTopicHandlerRef.current = options.onRealtimeTopicMessage;
  }, [options.onRealtimeTopicMessage]);

  useEffect(() => {
    segmentModeRef.current = segmentMode;
  }, [segmentMode]);

  useEffect(() => {
    let cancelled = false;
    void listRobots(1).then((response) => {
      if (cancelled) return;
      const rows = response.data.rows;
      setRobots(rows);
      const pageNo = response.data.page_no ?? response.data.pageNo ?? 1;
      const pageSize = response.data.page_size ?? response.data.pageSize ?? 20;
      const totalPage = response.data.total_page ?? response.data.totalPage;
      const totalCount = response.data.total_count ?? response.data.totalCount;
      const hasMore = totalPage != null ? pageNo < totalPage
        : totalCount != null ? pageNo * pageSize < totalCount : rows.length >= pageSize;
      nextRobotPageRef.current = pageNo + 1;
      robotsHasMoreRef.current = hasMore;
      setRobotsHasMore(hasMore);
      // 优先使用缓存的机器人 ID（需在列表中存在且在线），否则选第一个在线机器人
      setSelectedRobotId((current) => {
        if (current && rows.some((r) => r.id === current && !isRobotOffline(r))) return current;
        return rows.find((r) => !isRobotOffline(r))?.id || '';
      });
      setDemoMode(response.source === 'mock');
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const loadMoreRobots = useCallback(async () => {
    if (robotPageBusyRef.current || !robotsHasMoreRef.current) return;
    robotPageBusyRef.current = true;
    setRobotsLoadingMore(true);
    try {
      const response = await listRobots(nextRobotPageRef.current);
      if (response.source === 'mock') {
        setRobotsPageError(true);
        return;
      }
      setRobotsPageError(false);
      const pageNo = response.data.page_no ?? response.data.pageNo ?? nextRobotPageRef.current;
      const pageSize = response.data.page_size ?? response.data.pageSize ?? 20;
      const totalPage = response.data.total_page ?? response.data.totalPage;
      const totalCount = response.data.total_count ?? response.data.totalCount;
      // 保留已加载项的顺序，避免翻页边界上的重复机器人产生重复选项。
      setRobots(current => {
        const ids = new Set(current.map(robot => robot.id));
        return [...current, ...response.data.rows.filter(robot => !ids.has(robot.id))];
      });
      const hasMore = totalPage != null ? pageNo < totalPage
        : totalCount != null ? pageNo * pageSize < totalCount : response.data.rows.length >= pageSize;
      nextRobotPageRef.current = pageNo + 1;
      robotsHasMoreRef.current = hasMore;
      setRobotsHasMore(hasMore);
    } catch (error) {
      console.warn('加载下一页机器人失败', error);
      setRobotsPageError(true);
    } finally {
      robotPageBusyRef.current = false;
      setRobotsLoadingMore(false);
    }
  }, []);

  // 加载机器人关联的地图列表及各地图的版本列表，供「地图切换」面板使用
  useEffect(() => {
    if (!selectedRobotId) {
      setAllMaps([]);
      setEditionsMap({});
      return;
    }
    let cancelled = false;
    void listRobotMaps(selectedRobotId).then(async (response) => {
      if (cancelled) return;
      const mapRows = response.data;
      setAllMaps(mapRows);
      // 单个地图版本列表失败不应阻断其他地图，避免切换面板长期停留在加载态
      const editionResults = await Promise.all(
        mapRows.map((m) =>
          getMapEditions(m.id)
            .then((r) => ({ mapId: m.id, editions: r.data }))
            .catch((error) => {
              console.warn('加载地图版本列表失败', m.id, error);
              return { mapId: m.id, editions: [] as MapEdition[] };
            }),
        ),
      );
      if (cancelled) return;
      const map: Record<string, MapEdition[]> = {};
      for (const item of editionResults) {
        map[item.mapId] = item.editions;
      }
      setEditionsMap(map);
    });
    return () => { cancelled = true; };
  }, [selectedRobotId]);

  const selectedRobot = useMemo(
    () => robots.find((robot) => robot.id === selectedRobotId),
    [robots, selectedRobotId],
  );

  const mergeRobotInfo = useCallback((jsonData?: string) => {
    if (!jsonData) return;
    try {
      const parsed = JSON.parse(jsonData) as Record<string, unknown>;
      setLatestRobotInfo(parsed);
      setRuntime((current) => mergeRuntimeWithRobotInfo(current, parsed));
    } catch (error) {
      console.warn('解析实时机器人状态失败', error);
    }
  }, []);

  const handleRealtimeEvent = useCallback((event: RealtimeEvent) => {
    console.log('[RealtimeEvent]', event);
    const eventStatus = event.status as RealtimeConnectionStatus | undefined;
    if (eventStatus) setRealtimeStatus(eventStatus);
    if (event.type === 'connected') setRealtimeStatus('CONNECTED');
    if (event.type === 'disconnected') setRealtimeStatus('DISCONNECTED');
    if (event.type === 'reconnecting') setRealtimeStatus('RECONNECTING');
    if (event.type === 'kicked') setRealtimeStatus('KICKED');
    if (event.type === 'error') setRealtimeStatus('ERROR');

    const jsonData = event.jsonData ?? event.json_data;

    // 点云/相机为高频渲染类 Topic：从摘要剥离，解析 rosbridge 信封后交页面渲染（msg.data 内含 base64）
    if (event.type === 'topic' && event.topic && renderedRealtimeTopics.has(event.topic)) {
      if (jsonData) {
        try {
          const parsed = JSON.parse(jsonData) as { msg?: Record<string, unknown> };
          const message = parsed.msg ?? (parsed as Record<string, unknown>);
          realtimeTopicHandlerRef.current?.(event.topic, message);
        } catch (error) {
          console.warn('解析实时渲染 Topic 失败', event.topic, error);
        }
      }
      return;
    }

    // 摘要级 Topic 推送（topic / robot_info / task_reply）按时间累积，供「实时推送」摘要卡片展示
    if (event.type === 'topic' || event.type === 'robot_info' || event.type === 'task_reply') {
      const binarySize = event.binarySize ?? event.binary_size;
      const timestamp = event.timestamp ?? new Date().toISOString();
      const entry: RealtimePushSummaryEntry = {
        id: `${timestamp}-${(realtimeSeqRef.current += 1)}`,
        type: event.type,
        topic: event.topic,
        timestamp,
        jsonSummary: jsonData ? jsonData.slice(0, 120) : undefined,
        binarySize: binarySize ?? undefined,
      };
      setRealtimeEvents((current) => [entry, ...current].slice(0, 50));
    }

    if (event.type === 'robot_info') {
      mergeRobotInfo(jsonData);
    }
    if (event.type === 'task_reply') {
      const taskId = event.taskId ?? event.task_id;
      if (!taskId) return;
      setTasks((current) =>
        current.map((task) =>
          task.taskId === taskId
            ? {
              ...task,
              status: event.status ?? task.status,
              realtimeSource: true,
              updatedAt: event.timestamp ?? new Date().toISOString(),
              resultSummary: jsonData,
            }
            : task,
        ),
      );
    }
  }, [mergeRobotInfo]);

  useEffect(() => {
    realtimeClientRef.current?.close();
    realtimeClientRef.current = null;
    setSubscribedTopics(new Set());
    setLatestRobotInfo(undefined);
    setRealtimeEvents([]);
    setRealtimeStatus('DISCONNECTED');

    if (!selectedRobotId) return;

    const client = createRealtimeClient({
      robotId: selectedRobotId,
      onEvent: handleRealtimeEvent,
      onStatus: (status) => {
        if (status === 'open') setRealtimeStatus('CONNECTING');
        if (status === 'closed') setRealtimeStatus('DISCONNECTED');
        if (status === 'error') setRealtimeStatus('ERROR');
        if (status === 'mock') setDemoMode(true);
      },
    });
    realtimeClientRef.current = client;
    client.connect();

    void getRealtimeSnapshot(selectedRobotId).then((snapshot) => {
      setDemoMode((current) => current || snapshot.source === 'mock');
      setRealtimeStatus(snapshot.data.status);
      const info = snapshot.data.robotInfo ?? snapshot.data.robot_info;
      mergeRobotInfo(info);
      const topics = snapshot.data.subscribedTopics ?? snapshot.data.subscribed_topics ?? [];
      setSubscribedTopics(new Set(topics));
    });

    return () => {
      client.close();
      if (realtimeClientRef.current === client) {
        realtimeClientRef.current = null;
      }
    };
  }, [selectedRobotId, handleRealtimeEvent, mergeRobotInfo]);

  useEffect(() => {
    if (!selectedRobotId) return;
    let cancelled = false;

    async function refreshRuntime() {
      const response = await getRobotRuntime(selectedRobotId);
      if (!cancelled) {
        setRuntime(response.data);
        setDemoMode((current) => current || response.source === 'mock');
      }
    }

    void refreshRuntime();
    if (realtimeStatus === 'CONNECTED') {
      return () => {
        cancelled = true;
      };
    }
    const timer = window.setInterval(refreshRuntime, RUNTIME_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [selectedRobotId, realtimeStatus]);

  // 从 version_path 中解析 editionId，格式: {mapId}/maincenter/{editionId}
  const runtimeEditionId = useMemo(() => {
    const versionPath = runtime?.version_path;
    if (!versionPath) return undefined;
    const parts = versionPath.split('/');
    return parts.length >= 3 ? parts[parts.length - 1] : undefined;
  }, [runtime]);

  useEffect(() => {
    const mapId = selectedRobot?.map?.id;
    // 优先使用 robot 列表中的 editionId，其次从 runtime 的 version_path 解析
    const editionId = selectedRobot?.map?.edition_id ?? selectedRobot?.map?.editionId ?? runtimeEditionId;
    if (!mapId && !editionId) return;
    let cancelled = false;

    async function loadMapData() {
      const editionResponse = editionId ? await getMapEdition(editionId) : await getMapEditions(mapId as string);
      const currentEdition = editionResponse.data[0];
      if (!currentEdition || cancelled) return;

      const [navResponse, topoResponse, narrationResponse, chargingResponse] = await Promise.all([
        listNavigationPaths(currentEdition.id),
        listTopologyPaths(currentEdition.id),
        listNarrationProcesses(currentEdition.id),
        getChargingPoints(currentEdition.id),
      ]);

      if (!cancelled) {
        setEdition(currentEdition);
        setNavPaths(navResponse.data.rows);
        setTopoPaths(topoResponse.data.rows);
        setNarrationProcesses(narrationResponse.data);
        setDemoMode(
          (current) =>
            current ||
            editionResponse.source === 'mock' ||
            navResponse.source === 'mock' ||
            topoResponse.source === 'mock' ||
            narrationResponse.source === 'mock' ||
            chargingResponse.source === 'mock',
        );
      }
    }

    void loadMapData();
    return () => {
      cancelled = true;
    };
  }, [selectedRobot, runtimeEditionId]);

  // 讲解流程随地图版本变化，默认选中第一条可用流程；无流程时清理选择。
  useEffect(() => {
    setSelectedProcessId((current) => {
      if (narrationProcesses.length === 0) return '';
      if (narrationProcesses.find((process) => process.id === current)) return current;
      return narrationProcesses[0].id;
    });
  }, [narrationProcesses]);

  // 当路径数据加载完成后，自动选中第一条路径；路径为空时清理选中状态
  useEffect(() => {
    const paths = activePathType === 'nav' ? navPaths : topoPaths;
    if (paths.length === 0) {
      setSelectedPathId('');
      setSelectedNodeIds(new Set());
    } else if (!paths.find((p) => p.id === selectedPathId)) {
      setSelectedPathId(paths[0].id);
      setSelectedNodeIds(new Set());
    }
  }, [activePathType, navPaths, topoPaths, selectedPathId]);

  // 切换路径类型时重置选中状态
  const handlePathTypeChange = useCallback((type: ActivePathType) => {
    setActivePathType(type);
    setSelectedPathId('');
    setSelectedNodeIds(new Set());
  }, []);

  // 当前路径类型下的路径列表
  const currentPaths = useMemo(
    () => (activePathType === 'nav' ? navPaths : topoPaths),
    [activePathType, navPaths, topoPaths],
  );

  // 当前选中路径
  const activePath = useMemo(
    () => currentPaths.find((p) => p.id === selectedPathId),
    [currentPaths, selectedPathId],
  );

  // 当前路径的节点列表
  const activeNodes: PathNode[] = useMemo(
    () => activePath?.nodes ?? [],
    [activePath],
  );

  // 跟踪活跃的任务轮询，在机器人切换或组件卸载时取消
  const pollingAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      // 组件卸载时取消所有进行中的轮询
      pollingAbortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    // 切换机器人时取消上一个机器人的轮询
    pollingAbortRef.current?.abort();
    pollingAbortRef.current = null;
  }, [selectedRobotId]);

  const refreshNarrationRuntime = useCallback(async (
    isCancelled?: () => boolean,
    requestSegmentMode: SegmentMode = segmentMode,
  ) => {
    const requestSeq = narrationRuntimeRequestSeqRef.current + 1;
    narrationRuntimeRequestSeqRef.current = requestSeq;
    if (!selectedRobotId) {
      setNarrationRuntime([]);
      return;
    }
    const response = await getNarrationRuntime(selectedRobotId, requestSegmentMode);
    if (
      isCancelled?.() ||
      requestSeq !== narrationRuntimeRequestSeqRef.current ||
      requestSegmentMode !== segmentModeRef.current
    ) {
      return;
    }
    setNarrationRuntime(response.data);
    setDemoMode((current) => current || response.source === 'mock');
  }, [selectedRobotId, segmentMode]);

  const handleSegmentModeChange = useCallback((nextSegmentMode: SegmentMode) => {
    narrationRuntimeRequestSeqRef.current += 1;
    setNarrationRuntime([]);
    setSegmentMode(nextSegmentMode);
  }, []);

  useEffect(() => {
    if (!selectedRobotId) {
      setNarrationRuntime([]);
      return;
    }
    let cancelled = false;

    async function refresh() {
      await refreshNarrationRuntime(() => cancelled);
    }

    void refresh();
    const timer = window.setInterval(
      () => void refresh().catch(() => {}),
      NARRATION_RUNTIME_POLL_INTERVAL_MS,
    );
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [selectedRobotId, refreshNarrationRuntime]);

  const subscribeRealtimeTopic = useCallback((topic: string, options?: { binary?: boolean; throttleRate?: number }) => {
    realtimeClientRef.current?.subscribe([topic], options);
    setSubscribedTopics((current) => new Set(current).add(topic));
  }, []);

  const unsubscribeRealtimeTopic = useCallback((topic: string) => {
    realtimeClientRef.current?.unsubscribe(topic);
    setSubscribedTopics((current) => {
      const next = new Set(current);
      next.delete(topic);
      return next;
    });
  }, []);

  const setRealtimeTopicFps = useCallback((topic: string, fps: number, binary = true) => {
    const throttleRate = Math.round(1000 / Math.max(1, fps));
    realtimeClientRef.current?.subscribe([topic], { binary, throttleRate });
    setSubscribedTopics((current) => new Set(current).add(topic));
  }, []);

  const trackRobotTask = useCallback(
    async (commandCode: WorkbenchTaskCommandCode, submit: () => Promise<ApiRequestResult<string>>, errorMessage: string) => {
      if (!selectedRobotId) return false;
      pollingAbortRef.current?.abort();
      const abortController = new AbortController();
      pollingAbortRef.current = abortController;

      try {
        const response = await submit();
        const taskId = response.data;
        setDemoMode((current) => current || response.source === 'mock');
        setTasks((current) => [
          {
            taskId,
            commandCode,
            source: response.source,
            status: realtimeStatus === 'CONNECTED' ? 'PENDING' : response.source === 'mock' ? '演示执行中' : '已下发',
            realtimeSource: realtimeStatus === 'CONNECTED',
            updatedAt: new Date().toISOString(),
            compensationStatus: realtimeStatus === 'CONNECTED' ? 'polling' : 'idle',
          },
          ...current,
        ]);

        // HTTP 查询作为最终一致性补偿：实时已连接时降低频率，断线或 Mock 时保持原轮询频率。
        const pollInterval = realtimeStatus === 'CONNECTED'
          ? TASK_RESULT_REALTIME_POLL_INTERVAL_MS
          : TASK_RESULT_FALLBACK_POLL_INTERVAL_MS;
        for (let i = 0; i < TASK_RESULT_MAX_POLLS; i++) {
          if (abortController.signal.aborted) break;
          await new Promise((resolve) => setTimeout(resolve, pollInterval));
          if (abortController.signal.aborted) break;
          const taskResponse = await getTaskResults(selectedRobotId, [taskId]);
          if (abortController.signal.aborted) break;
          const latestStatus = taskResponse.data[0]?.task_status ?? '';
          setTasks((current) =>
            current.map((task) =>
              task.taskId === taskId
                ? {
                  ...task,
                  status: latestStatus || task.status,
                  result: taskResponse.data[0],
                  updatedAt: new Date().toISOString(),
                  compensationStatus: TERMINAL_STATUSES.has(latestStatus) ? 'done' : 'polling',
                }
                : task,
            ),
          );
          if (TERMINAL_STATUSES.has(latestStatus)) break;
        }
        return !abortController.signal.aborted;
      } catch (error) {
        if (!abortController.signal.aborted) {
          console.error(errorMessage, error);
        }
        return false;
      }
    },
    [selectedRobotId, realtimeStatus],
  );

  const sendCommand = useCallback(
    async (commandCode: RobotCommandCode, commandParam: unknown) => {
      if (!selectedRobotId) return;
      const payload = buildCommandPayload(commandCode, commandParam);
      await trackRobotTask(commandCode, () => sendRobotCommand(selectedRobotId, payload), '发送命令失败');
    },
    [selectedRobotId, trackRobotTask],
  );

  // 切换激活地图版本：支持指定 editionId，切换完成后自动加载新版本数据
  const activateMap = useCallback(async (targetEditionId?: string) => {
    const eid = targetEditionId ?? edition?.id;
    if (!selectedRobotId || !eid) return;
    setSwitchingEditionId(eid);
    try {
      const activated = await trackRobotTask('activate_map', () => activateMapApi(selectedRobotId, eid), '激活地图失败');
      if (!activated) return;
      // 切换成功后加载新版本的地图数据
      if (targetEditionId && targetEditionId !== edition?.id) {
        const editionResponse = await getMapEdition(targetEditionId);
        const newEdition = editionResponse.data[0];
        if (newEdition) {
          const [navResponse, topoResponse, narrationResponse, chargingResponse] = await Promise.all([
            listNavigationPaths(newEdition.id),
            listTopologyPaths(newEdition.id),
            listNarrationProcesses(newEdition.id),
            getChargingPoints(newEdition.id),
          ]);
          setEdition(newEdition);
          setNavPaths(navResponse.data.rows);
          setTopoPaths(topoResponse.data.rows);
          setNarrationProcesses(narrationResponse.data);
          setDemoMode(
            (current) =>
              current ||
              editionResponse.source === 'mock' ||
              navResponse.source === 'mock' ||
              topoResponse.source === 'mock' ||
              narrationResponse.source === 'mock' ||
              chargingResponse.source === 'mock',
          );
        }
      }
    } finally {
      setSwitchingEditionId(undefined);
    }
  }, [selectedRobotId, edition?.id, trackRobotTask]);

  const controlNarration = useCallback(
    async (
      command: NarrationCommand,
      options: {
        processId?: string;
        processName?: string;
        editionId?: string;
        nodeId?: string;
        nodeName?: string;
      } = {},
    ) => {
      const processId = options.processId ?? selectedProcessId;
      const targetEditionId = options.editionId ?? edition?.id;
      if (!selectedRobotId || !targetEditionId || !processId) return;
      const process = narrationProcesses.find((item) => item.id === processId);
      const requestSegmentMode = segmentMode;

      try {
        const response = await controlNarrationApi(selectedRobotId, {
          editionId: targetEditionId,
          processId,
          processName: options.processName ?? process?.name,
          command,
          operationSource: 'web-example',
          nodeId: options.nodeId,
          nodeName: options.nodeName,
        }, requestSegmentMode);
        setDemoMode((current) => current || response.source === 'mock');
        await refreshNarrationRuntime(undefined, requestSegmentMode);
        if (requestSegmentMode === segmentModeRef.current) {
          setNarrationRuntime((current) => current.length > 0 ? current : [response.data]);
        }
      } catch (error) {
        console.error('讲解控制失败', error);
      }
    },
    [selectedRobotId, edition?.id, selectedProcessId, narrationProcesses, refreshNarrationRuntime, segmentMode],
  );

  // 根据选中节点构造并下发导航指令
  const navigateToSelected = useCallback(() => {
    if (selectedNodeIds.size === 0 || !activePath) return;

    const coordinateFrame = activePath.coordinateFrame ?? 'ROBOT';
    const selectedNodes = activeNodes
      .filter((n) => selectedNodeIds.has(n.id))
      .sort((a, b) => a.order - b.order);

    // 根据 coordinateFrame 转换坐标到 ROS 坐标系
    function toRosPosition(node: PathNode) {
      if (coordinateFrame === 'THREE') {
        return threePositionToRos(node.position);
      }
      return node.position;
    }

    function toRosOrientation(node: PathNode) {
      if (coordinateFrame === 'THREE' && node.orientation) {
        return threeQuaternionToRos(node.orientation);
      }
      return node.orientation ?? { x: 0, y: 0, z: 0, w: 1 };
    }

    if (selectedNodes.length === 1) {
      // 单点导航
      const node = selectedNodes[0];
      void sendCommand('navigation', {
        point_name: node.name || node.id,
        position: toRosPosition(node),
        orientation: toRosOrientation(node),
        look_at: true,
      });
    } else {
      // 多点导航
      const points = selectedNodes.map((node) => ({
        position: toRosPosition(node),
        orientation: toRosOrientation(node),
        look_at: true,
      }));
      void sendCommand('topology_navigation', { point: points });
    }
  }, [selectedNodeIds, activePath, activeNodes, sendCommand]);

  return {
    robots,
    robotsHasMore,
    robotsLoadingMore,
    robotsPageError,
    loadMoreRobots,
    selectedRobot,
    selectedRobotId,
    setSelectedRobotId,
    runtime,
    realtimeStatus,
    subscribedTopics,
    latestRobotInfo,
    realtimeEvents,
    edition,
    allMaps,
    editionsMap,
    switchingEditionId,
    navPaths,
    topoPaths,
    narrationProcesses,
    selectedProcessId,
    setSelectedProcessId,
    narrationRuntime,
    segmentMode,
    setSegmentMode: handleSegmentModeChange,
    tasks,
    demoMode,
    loading,
    sendCommand,
    controlNarration,
    activateMap,
    subscribeRealtimeTopic,
    unsubscribeRealtimeTopic,
    setRealtimeTopicFps,
    // 路径互斥选择
    activePathType,
    handlePathTypeChange,
    selectedPathId,
    setSelectedPathId,
    selectedNodeIds,
    setSelectedNodeIds,
    currentPaths,
    activePath,
    activeNodes,
    navigateToSelected,
    // 交互模式
    interactionMode,
    setInteractionMode,
  };
}

function mergeRuntimeWithRobotInfo(current: RobotRuntime | undefined, info: Record<string, unknown>): RobotRuntime {
  const next: RobotRuntime = { ...(current ?? {}) };
  const soc = readNumber(info, ['soc', 'battery', 'battery_soc']);
  if (soc != null) next.soc = soc;

  const terminalStatus = readString(info, ['terminal_status', 'terminalStatus', 'status']);
  if (terminalStatus) next.terminal_status = terminalStatus;

  const charge = readNumber(info, ['charge', 'charge_status']);
  if (charge != null) {
    next.charge = { ...(next.charge ?? {}), status: charge };
  }

  const pose = readObject(info, ['pose', 'odom.pose', 'ros_odom.pose']);
  if (pose) {
    const position = readObject(pose, ['position']);
    const orientation = readObject(pose, ['orientation']);
    if (position && orientation) {
      next.ros_odom = {
        ...(next.ros_odom ?? {}),
        pose: {
          position: {
            x: readNumber(position, ['x']) ?? 0,
            y: readNumber(position, ['y']) ?? 0,
            z: readNumber(position, ['z']) ?? 0,
          },
          orientation: {
            x: readNumber(orientation, ['x']) ?? 0,
            y: readNumber(orientation, ['y']) ?? 0,
            z: readNumber(orientation, ['z']) ?? 0,
            w: readNumber(orientation, ['w']) ?? 1,
          },
        },
      };
    }
  }

  return next;
}

function readNumber(source: Record<string, unknown>, paths: string[]) {
  for (const path of paths) {
    const value = readPath(source, path);
    if (typeof value === 'number') return value;
    if (typeof value === 'string' && value.trim() !== '') {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

function readString(source: Record<string, unknown>, paths: string[]) {
  for (const path of paths) {
    const value = readPath(source, path);
    if (typeof value === 'string') return value;
  }
  return undefined;
}

function readObject(source: Record<string, unknown>, paths: string[]) {
  for (const path of paths) {
    const value = readPath(source, path);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  }
  return undefined;
}

function readPath(source: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((current, key) => {
    if (!current || typeof current !== 'object') return undefined;
    return (current as Record<string, unknown>)[key];
  }, source);
}
