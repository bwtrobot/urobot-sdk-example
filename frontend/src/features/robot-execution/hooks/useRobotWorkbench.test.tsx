import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRobotWorkbench } from './useRobotWorkbench';
import {
  mockEdition,
  mockMaps,
  mockNavigationPath,
  mockNarrationProcesses,
  mockRobots,
  mockRuntime,
  mockTopologyPath,
} from '../../../services/mock/mockData';
import type { MapEdition } from '../../../shared/types/api';

vi.mock('../../../services/api/realtimeApi', () => ({
  createRealtimeClient: vi.fn(() => ({
    connect: vi.fn(),
    close: vi.fn(),
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
  })),
  getRealtimeSnapshot: vi.fn(async () => ({
    data: { status: 'DISCONNECTED', subscribedTopics: [] },
    source: 'real',
  })),
}));

vi.mock('../../../services/api/mapApi', () => ({
  getChargingPoints: vi.fn(async () => ({ data: [], source: 'real' })),
  getMapEdition: vi.fn(async (editionId: string) => ({
    data: [{ ...mockEdition, id: editionId }],
    source: 'real',
  })),
  getMapEditions: vi.fn(),
  listRobotMaps: vi.fn(async () => ({
    data: mockMaps,
    source: 'real',
  })),
  listNarrationProcesses: vi.fn(async () => ({ data: mockNarrationProcesses, source: 'real' })),
  listNavigationPaths: vi.fn(async () => ({
    data: { rows: [mockNavigationPath], total_count: 1, page_no: 1, page_size: 1, total_page: 1 },
    source: 'real',
  })),
  listTopologyPaths: vi.fn(async () => ({
    data: { rows: [mockTopologyPath], total_count: 1, page_no: 1, page_size: 1, total_page: 1 },
    source: 'real',
  })),
}));

vi.mock('../../../services/api/robotApi', () => ({
  activateMap: vi.fn(),
  buildCommandPayload: vi.fn((commandCode: string, commandParam: unknown) => ({
    type: 0,
    messagesType: 'task_submit',
    params: {
      task_id: `task-${commandCode}`,
      task_command_info: [{ command_id: `cmd-${commandCode}`, command_code: commandCode, command_param: commandParam }],
    },
  })),
  controlNarration: vi.fn(),
  getNarrationRuntime: vi.fn(async () => ({ data: [], source: 'real' })),
  getRobotRuntime: vi.fn(async () => ({ data: mockRuntime, source: 'real' })),
  getTaskResults: vi.fn(async () => ({ data: [], source: 'real' })),
  listRobots: vi.fn(async () => ({
    data: {
      rows: [mockRobots[0]],
      total_count: 1,
      page_no: 1,
      page_size: 1,
      total_page: 1,
    },
    source: 'real',
  })),
  sendRobotCommand: vi.fn(),
}));

describe('useRobotWorkbench', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('滚动加载下一页时追加机器人并在末页停止', async () => {
    const { listRobots } = await import('../../../services/api/robotApi');
    const { getMapEditions } = await import('../../../services/api/mapApi');
    vi.mocked(getMapEditions).mockResolvedValue({ data: [], source: 'real' });
    const nextRobot = { id: 'robot-next', name: '下一页机器人', status: '空闲' };
    vi.mocked(listRobots)
      .mockResolvedValueOnce({ data: { rows: [mockRobots[0]], total_count: 2, page_no: 1, page_size: 1, total_page: 2 }, source: 'real' })
      .mockResolvedValueOnce({ data: { rows: [nextRobot], total_count: 2, page_no: 2, page_size: 1, total_page: 2 }, source: 'real' });
    const { result } = renderHook(() => useRobotWorkbench());
    await waitFor(() => expect(result.current.robotsHasMore).toBe(true));

    await act(async () => { await result.current.loadMoreRobots(); });

    expect(listRobots).toHaveBeenNthCalledWith(2, 2);
    expect(result.current.robots.map(robot => robot.id)).toEqual([mockRobots[0].id, nextRobot.id]);
    expect(result.current.robotsHasMore).toBe(false);
  });

  it('下一页请求失败后保留页码以便重试', async () => {
    const { listRobots } = await import('../../../services/api/robotApi');
    const { getMapEditions } = await import('../../../services/api/mapApi');
    vi.mocked(getMapEditions).mockResolvedValue({ data: [], source: 'real' });
    vi.mocked(listRobots)
      .mockResolvedValueOnce({ data: { rows: [mockRobots[0]], page_no: 1, total_page: 2 }, source: 'real' })
      .mockResolvedValueOnce({ data: { rows: [], page_no: 1, total_page: 0 }, source: 'mock' })
      .mockResolvedValueOnce({ data: { rows: [{ id: 'second', name: '第二页' }], page_no: 2, total_page: 2 }, source: 'real' });
    const { result } = renderHook(() => useRobotWorkbench());
    await waitFor(() => expect(result.current.robotsHasMore).toBe(true));

    await act(async () => { await result.current.loadMoreRobots(); });
    expect(result.current.robotsPageError).toBe(true);
    expect(result.current.robotsHasMore).toBe(true);

    await act(async () => { await result.current.loadMoreRobots(); });
    expect(listRobots).toHaveBeenNthCalledWith(3, 2);
    expect(result.current.robotsPageError).toBe(false);
  });

  it('加载地图版本列表时允许单个地图失败并保留其他地图版本', async () => {
    const { getMapEditions } = await import('../../../services/api/mapApi');
    const availableEdition: MapEdition = { ...mockEdition, id: 'edition-ok', mapId: mockMaps[0].id };
    vi.mocked(getMapEditions)
      .mockResolvedValueOnce({ data: [availableEdition], source: 'real' })
      .mockRejectedValueOnce(new Error('版本列表加载失败'));

    const { result } = renderHook(() => useRobotWorkbench());

    await waitFor(() => {
      expect(result.current.editionsMap[mockMaps[0].id]).toEqual([availableEdition]);
    });
    expect(result.current.editionsMap[mockMaps[1].id]).toEqual([]);
  });

  it('激活地图任务提交失败时不加载目标版本数据', async () => {
    const { activateMap } = await import('../../../services/api/robotApi');
    const { getMapEdition, getMapEditions } = await import('../../../services/api/mapApi');
    vi.mocked(getMapEditions).mockResolvedValue({ data: [mockEdition], source: 'real' });
    vi.mocked(activateMap).mockRejectedValue(new Error('激活地图失败'));

    const { result } = renderHook(() => useRobotWorkbench());

    await waitFor(() => {
      expect(result.current.edition?.id).toBe('edition-main-v1');
    });
    vi.mocked(getMapEdition).mockClear();

    await act(async () => {
      await result.current.activateMap('edition-next');
    });

    expect(getMapEdition).not.toHaveBeenCalled();
  });

  it('讲解控制下发时携带地图版本和流程上下文', async () => {
    const { controlNarration } = await import('../../../services/api/robotApi');

    vi.mocked(controlNarration).mockResolvedValue({
      data: {
        accepted: true,
        editionId: 'edition-main-v1',
        processId: 'narration-process-1',
        command: 'start',
      },
      source: 'real',
    });

    const { result } = renderHook(() => useRobotWorkbench());

    await waitFor(() => {
      expect(result.current.edition?.id).toBe('edition-main-v1');
      expect(result.current.selectedProcessId).toBe(mockNarrationProcesses[0].id);
    });

    await act(async () => {
      await result.current.controlNarration('start');
    });

    expect(controlNarration).toHaveBeenCalledWith(
      mockRobots[0].id,
      expect.objectContaining({
        editionId: 'edition-main-v1',
        processId: mockNarrationProcesses[0].id,
        processName: mockNarrationProcesses[0].name,
        command: 'start',
        operationSource: 'web-example',
      }),
      'collapsed',
    );
  });

  it('切换讲解片段视图后立即刷新运行时', async () => {
    const { getNarrationRuntime } = await import('../../../services/api/robotApi');

    const { result } = renderHook(() => useRobotWorkbench());

    await waitFor(() => {
      expect(result.current.selectedRobotId).toBe(mockRobots[0].id);
    });

    vi.mocked(getNarrationRuntime).mockClear();

    await act(async () => {
      result.current.setSegmentMode('expanded');
    });

    await waitFor(() => {
      expect(getNarrationRuntime).toHaveBeenCalledWith(mockRobots[0].id, 'expanded');
    });
    expect(result.current.segmentMode).toBe('expanded');
  });

  it('忽略切换视图前返回的过期运行时响应', async () => {
    const { getNarrationRuntime } = await import('../../../services/api/robotApi');
    let resolveCollapsed: ((value: { data: Array<{ processId: string; status: string }>; source: 'real' }) => void) | undefined;

    vi.mocked(getNarrationRuntime)
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveCollapsed = resolve;
      }))
      .mockResolvedValueOnce({
        data: [{ processId: 'narration-main-route', status: 'expanded-runtime' }],
        source: 'real',
      });

    const { result } = renderHook(() => useRobotWorkbench());

    await waitFor(() => {
      expect(getNarrationRuntime).toHaveBeenCalledWith(mockRobots[0].id, 'collapsed');
    });

    await act(async () => {
      result.current.setSegmentMode('expanded');
    });

    await waitFor(() => {
      expect(result.current.narrationRuntime[0]?.status).toBe('expanded-runtime');
    });

    await act(async () => {
      resolveCollapsed?.({
        data: [{ processId: 'narration-main-route', status: 'stale-collapsed-runtime' }],
        source: 'real',
      });
    });

    expect(result.current.narrationRuntime[0]?.status).toBe('expanded-runtime');
  });
});
