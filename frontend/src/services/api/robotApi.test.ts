import type { AxiosAdapter } from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  activateMap,
  buildCommandPayload,
  getNarrationRuntime,
  getRobotRuntime,
  getTaskResults,
  listRobots,
  sendRobotCommand,
} from './robotApi';
import {
  getChargingPoints,
  getMapEdition,
  getMapEditions,
  listNavigationPaths,
  listTopologyPaths,
} from './mapApi';
import { clearApiLogs, http } from './httpClient';
import { mockRuntime } from '../mock/mockData';

describe('robotApi', () => {
  const originalAdapter = http.defaults.adapter;
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  afterEach(() => {
    http.defaults.adapter = originalAdapter;
    clearApiLogs();
    vi.restoreAllMocks();
  });

  it('builds robot command payloads with unique standard UUID task and command identifiers', () => {
    const first = buildCommandPayload('navigation', { target: 'point-a' });
    const second = buildCommandPayload('cmd_vel', { linear: 0.5 });

    expect(first).toMatchObject({
      type: 0,
      messagesType: 'task_submit',
      params: {
        task_command_info: [
          {
            command_code: 'navigation',
            command_param: { target: 'point-a' },
            parallel_commands: null,
          },
        ],
      },
    });
    expect(first.params.task_id).toMatch(uuidPattern);
    expect(first.params.task_command_info[0].command_id).toMatch(uuidPattern);
    expect(second.params.task_id).toMatch(uuidPattern);
    expect(second.type).toBe(23);
    expect(second.params.task_command_info[0].command_id).toMatch(uuidPattern);
    expect(second.params.task_id).not.toBe(first.params.task_id);
    expect(second.params.task_command_info[0].command_id).not.toBe(
      first.params.task_command_info[0].command_id,
    );
  });

  it('lists robots from the real page endpoint and falls back to a mock page', async () => {
    http.defaults.adapter = vi.fn(async (config) => ({
      data: {
        result: {
          rows: [{ id: 'robot-real', name: 'Real Robot' }],
          total_count: 1,
          page_no: 1,
          page_size: 10,
          total_page: 1,
        },
      },
      status: 200,
      statusText: 'OK',
      headers: {},
      config,
    })) as AxiosAdapter;

    const real = await listRobots();

    expect(http.defaults.adapter).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'get',
        url: '/robot/page',
      }),
    );
    expect(real).toMatchObject({
      source: 'real',
      data: {
        rows: [{ id: 'robot-real', name: 'Real Robot' }],
        total_count: 1,
      },
    });

    http.defaults.adapter = vi.fn(async () => {
      throw new Error('offline');
    }) as AxiosAdapter;

    const fallback = await listRobots();

    expect(fallback.source).toBe('mock');
    expect(fallback.data.rows).toHaveLength(3);
    expect(fallback.data.total_count).toBe(3);
  });

  it('按页请求机器人列表', async () => {
    http.defaults.adapter = vi.fn(async (config) => ({
      data: { result: { rows: [], total_count: 53, page_no: 2, page_size: 20, total_page: 3 } },
      status: 200, statusText: 'OK', headers: {}, config,
    })) as AxiosAdapter;

    await listRobots(2);

    expect(http.defaults.adapter).toHaveBeenCalledWith(expect.objectContaining({
      url: '/robot/page', params: { pageNo: 2, pageSize: 20 },
    }));
  });

  it('gets runtime from a rows result and from a direct result', async () => {
    http.defaults.adapter = vi.fn(async (config) => ({
      data: {
        result: {
          rows: [
            {
              robot_id: 'robot-row',
              soc: 47,
            },
          ],
        },
      },
      status: 200,
      statusText: 'OK',
      headers: {},
      config,
    })) as AxiosAdapter;

    const rowResult = await getRobotRuntime('robot-row');

    expect(http.defaults.adapter).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'get',
        url: '/robot/runtime/robot-row',
      }),
    );
    expect(rowResult).toEqual({
      data: { robot_id: 'robot-row', soc: 47 },
      source: 'real',
    });

    http.defaults.adapter = vi.fn(async (config) => ({
      data: {
        result: {
          robot_id: 'robot-direct',
          soc: 88,
        },
      },
      status: 200,
      statusText: 'OK',
      headers: {},
      config,
    })) as AxiosAdapter;

    const directResult = await getRobotRuntime('robot-direct');

    expect(directResult).toEqual({
      data: { robot_id: 'robot-direct', soc: 88 },
      source: 'real',
    });
  });

  it('falls back to mock runtime data', async () => {
    http.defaults.adapter = vi.fn(async () => {
      throw new Error('offline');
    }) as AxiosAdapter;

    const result = await getRobotRuntime('robot-alpha');

    expect(result).toMatchObject({
      source: 'mock',
      data: mockRuntime,
    });
  });

  it('treats empty runtime rows as mock data', async () => {
    http.defaults.adapter = vi.fn(async (config) => ({
      data: {
        result: {
          rows: [],
        },
      },
      status: 200,
      statusText: 'OK',
      headers: {},
      config,
    })) as AxiosAdapter;

    const result = await getRobotRuntime('robot-alpha');

    expect(result).toMatchObject({
      source: 'mock',
      reason: 'Empty runtime response',
      data: mockRuntime,
    });
    expect(result.data).not.toBe(mockRuntime);
  });

  it('sends robot commands and returns real or mock task identifiers', async () => {
    const payload = buildCommandPayload('robot_tts', { text: 'hello' });
    http.defaults.adapter = vi.fn(async (config) => ({
      data: { result: 'task-real' },
      status: 200,
      statusText: 'OK',
      headers: {},
      config,
    })) as AxiosAdapter;

    const real = await sendRobotCommand('robot-alpha', payload);

    expect(http.defaults.adapter).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'post',
        url: '/robot/command/robot-alpha',
      }),
    );
    const sentConfig = vi.mocked(http.defaults.adapter).mock.calls[0][0];
    expect(JSON.parse(String(sentConfig.data))).toEqual(payload);
    expect(real).toEqual({ data: 'task-real', source: 'real' });

    http.defaults.adapter = vi.fn(async () => {
      throw new Error('offline');
    }) as AxiosAdapter;

    const fallback = await sendRobotCommand('robot-alpha', payload);

    expect(fallback).toMatchObject({
      data: payload.params.task_id,
      source: 'mock',
    });
  });

  it('activates map through robot path variable endpoint with edition id in request body', async () => {
    http.defaults.adapter = vi.fn(async (config) => ({
      data: { result: 'task-activate' },
      status: 200,
      statusText: 'OK',
      headers: {},
      config,
    })) as AxiosAdapter;

    const result = await activateMap('robot-alpha', 'edition-main-v2');

    expect(http.defaults.adapter).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'post',
        url: '/robot/robot-alpha/activate-map',
      }),
    );
    const sentConfig = vi.mocked(http.defaults.adapter).mock.calls[0][0];
    expect(JSON.parse(String(sentConfig.data))).toEqual({ editionId: 'edition-main-v2' });
    expect(result).toEqual({ data: 'task-activate', source: 'real' });
  });

  it('controls narration with required edition context in request body', async () => {
    http.defaults.adapter = vi.fn(async (config) => ({
      data: {
        result: {
          accepted: true,
          editionId: 'edition-main-v1',
          processId: 'process-1',
          command: 'start',
        },
      },
      status: 200,
      statusText: 'OK',
      headers: {},
      config,
    })) as AxiosAdapter;

    const { controlNarration } = await import('./robotApi');
    const result = await controlNarration('robot-alpha', {
      editionId: 'edition-main-v1',
      processId: 'process-1',
      processName: '讲解流程',
      command: 'start',
      operationSource: 'web-example',
    });

    const sentConfig = vi.mocked(http.defaults.adapter).mock.calls[0][0];
    expect(sentConfig.url).toBe('/robot/robot-alpha/narration/control');
    expect(JSON.parse(String(sentConfig.data))).toMatchObject({
      editionId: 'edition-main-v1',
      processId: 'process-1',
      command: 'start',
    });
    expect(result.data).toMatchObject({
      accepted: true,
      editionId: 'edition-main-v1',
    });
  });

  it('requests narration runtime with segmentMode in query params only when provided', async () => {
    http.defaults.adapter = vi.fn(async (config) => ({
      data: { result: [] },
      status: 200,
      statusText: 'OK',
      headers: {},
      config,
    })) as AxiosAdapter;

    await getNarrationRuntime('robot-alpha', 'expanded');

    let sentConfig = vi.mocked(http.defaults.adapter).mock.calls[0][0];
    expect(sentConfig.url).toBe('/robot/robot-alpha/narration/runtime');
    expect(sentConfig.params.toString()).toBe('segmentMode=expanded');

    await getNarrationRuntime('robot-alpha');

    sentConfig = vi.mocked(http.defaults.adapter).mock.calls[1][0];
    expect(sentConfig.url).toBe('/robot/robot-alpha/narration/runtime');
    expect(sentConfig.params?.toString?.() ?? '').toBe('');
  });

  it('sends narration control segmentMode in query params and not in request body', async () => {
    http.defaults.adapter = vi.fn(async (config) => ({
      data: { result: { accepted: true } },
      status: 200,
      statusText: 'OK',
      headers: {},
      config,
    })) as AxiosAdapter;

    const { controlNarration } = await import('./robotApi');
    await controlNarration('robot-alpha', {
      editionId: 'edition-main-v1',
      processId: 'process-1',
      command: 'start',
    }, 'expanded');

    const sentConfig = vi.mocked(http.defaults.adapter).mock.calls[0][0];
    expect(sentConfig.url).toBe('/robot/robot-alpha/narration/control');
    expect(sentConfig.params.toString()).toBe('segmentMode=expanded');
    expect(JSON.parse(String(sentConfig.data))).toEqual({
      editionId: 'edition-main-v1',
      processId: 'process-1',
      command: 'start',
    });
  });

  it('rejects narration control before sending when edition or process context is missing', async () => {
    http.defaults.adapter = vi.fn() as AxiosAdapter;
    const { controlNarration } = await import('./robotApi');

    await expect(controlNarration('robot-alpha', {
      editionId: '',
      processId: 'process-1',
      command: 'start',
    })).rejects.toThrow('editionId 不能为空');

    await expect(controlNarration('robot-alpha', {
      editionId: 'edition-main-v1',
      processId: '',
      command: 'start',
    })).rejects.toThrow('processId 不能为空');

    expect(http.defaults.adapter).not.toHaveBeenCalled();
  });

  it('requests task results with repeated taskIds query params and falls back per task', async () => {
    http.defaults.adapter = vi.fn(async (config) => ({
      data: {
        result: [
          {
            task_id: 'task-1',
            task_status: 'running',
          },
        ],
      },
      status: 200,
      statusText: 'OK',
      headers: {},
      config,
    })) as AxiosAdapter;

    const real = await getTaskResults('robot-alpha', ['task-1', 'task-2']);

    expect(http.defaults.adapter).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'get',
        url: '/robot/task-result/robot-alpha',
      }),
    );
    const callConfig = (http.defaults.adapter as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callConfig.params.toString()).toBe('taskIds%5B0%5D=task-1&taskIds%5B1%5D=task-2');
    expect(real).toEqual({
      data: [{ task_id: 'task-1', task_status: 'running' }],
      source: 'real',
    });

    http.defaults.adapter = vi.fn(async () => {
      throw new Error('offline');
    }) as AxiosAdapter;

    const fallback = await getTaskResults('robot-alpha', ['task-1', 'task-2']);

    expect(fallback.source).toBe('mock');
    expect(fallback.data.map((task) => task.task_id)).toEqual(['task-1', 'task-2']);
  });
});

describe('mapApi', () => {
  const originalAdapter = http.defaults.adapter;

  afterEach(() => {
    http.defaults.adapter = originalAdapter;
    clearApiLogs();
    vi.restoreAllMocks();
  });

  it('gets map editions and falls back to mock edition rows', async () => {
    http.defaults.adapter = vi.fn(async (config) => ({
      data: {
        result: [{ id: 'edition-real', mapId: 'map-real', name: 'Real', mapName: 'Map' }],
      },
      status: 200,
      statusText: 'OK',
      headers: {},
      config,
    })) as AxiosAdapter;

    const real = await getMapEditions('map-real');

    expect(http.defaults.adapter).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'get',
        url: '/map/map-real/editions',
      }),
    );
    expect(real.data[0].id).toBe('edition-real');

    http.defaults.adapter = vi.fn(async () => {
      throw new Error('offline');
    }) as AxiosAdapter;

    const fallback = await getMapEditions('map-main');

    expect(fallback.source).toBe('mock');
    expect(fallback.data).toHaveLength(1);
    expect(fallback.data[0].id).toBe('edition-main-v1');
  });

  it('gets map edition detail and map resources with mock fallbacks', async () => {
    const seenUrls: string[] = [];
    http.defaults.adapter = vi.fn(async (config) => {
      seenUrls.push(config.url ?? '');
      return {
        data: {
          result: config.url?.includes('charging-stations')
            ? [{ id: 'charge-real', uuid: 'charge-real', name: 'Charge', x: 1, y: 2, z: 0 }]
            : config.url?.includes('nav-path')
              ? {
                  rows: [
                    {
                      id: 'nav-real',
                      uuid: 'nav-real',
                      name: 'Nav',
                      mapId: 'map-real',
                      editionId: 'edition-real',
                      nodes: [],
                    },
                  ],
                }
            : config.url?.includes('topo-path')
                ? {
                    rows: [
                      {
                        id: 'topology-real',
                        uuid: 'topology-real',
                        name: 'Topology',
                        mapId: 'map-real',
                        editionId: 'edition-real',
                        nodes: [],
                        edges: [],
                      },
                    ],
                  }
                : [{ id: 'edition-real', mapId: 'map-real', name: 'Real', mapName: 'Map' }],
        },
        status: 200,
        statusText: 'OK',
        headers: {},
        config,
      };
    }) as AxiosAdapter;

    await expect(getMapEdition('edition-real')).resolves.toMatchObject({
      data: [{ id: 'edition-real' }],
      source: 'real',
    });
    await expect(getChargingPoints('edition-real')).resolves.toMatchObject({
      data: [{ id: 'charge-real' }],
      source: 'real',
    });
    await expect(listNavigationPaths('edition-real')).resolves.toMatchObject({
      data: {
        rows: [{ id: 'nav-real' }],
      },
      source: 'real',
    });
    expect(http.defaults.adapter).toHaveBeenLastCalledWith(
      expect.objectContaining({
        params: { editionId: 'edition-real', pageNo: 1, pageSize: 20 },
      }),
    );
    await expect(listTopologyPaths('edition-real')).resolves.toMatchObject({
      data: {
        rows: [{ id: 'topology-real' }],
      },
      source: 'real',
    });
    expect(http.defaults.adapter).toHaveBeenLastCalledWith(
      expect.objectContaining({
        params: { editionId: 'edition-real', pageNo: 1, pageSize: 20 },
      }),
    );
    expect(seenUrls).toEqual([
      '/map/edition/edition-real',
      '/map/edition/edition-real/charging-stations',
      '/map/nav-path/page',
      '/map/topo-path/page',
    ]);

    http.defaults.adapter = vi.fn(async () => {
      throw new Error('offline');
    }) as AxiosAdapter;

    await expect(getMapEdition('edition-main-v1')).resolves.toMatchObject({
      data: [{ id: 'edition-main-v1' }],
      source: 'mock',
    });
    await expect(getChargingPoints('edition-main-v1')).resolves.toMatchObject({
      data: expect.arrayContaining([expect.objectContaining({ id: 'charge-1' })]),
      source: 'mock',
    });
    await expect(listNavigationPaths('edition-main-v1')).resolves.toMatchObject({
      data: {
        rows: [expect.objectContaining({ id: 'nav-path-main' })],
        total_count: 1,
      },
      source: 'mock',
    });
    await expect(listTopologyPaths('edition-main-v1')).resolves.toMatchObject({
      data: {
        rows: [expect.objectContaining({ id: 'topology-main' })],
        total_count: 1,
      },
      source: 'mock',
    });
  });
});
