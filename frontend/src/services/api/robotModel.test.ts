import { AxiosError, type AxiosAdapter } from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as robotApi from './robotApi';
import { clearApiLogs, getApiLogs, http } from './httpClient';
import type { RobotModel, RobotModelFile } from '../../shared/types/api';

const file: RobotModelFile = {
  fileId: '文件',
  fileName: '机器人.urdf',
  contentType: 'application/xml',
  url: '/resource/模型?x=1',
  disposition: null,
};
const model: RobotModel = {
  id: 'model-1',
  deviceType: 7,
  nameZh: '测试机型',
  nameEn: 'Model',
  modelCode: '动态 中文 +&?编码',
  terminal_type: null,
  terminal_type_value: null,
  urdfFileKey: 'urdf-key',
  urdfMainPath: 'robot/main.urdf',
  cardPosterFileKey: 'card-key',
  ratioPosterFileKey: 'ratio-key',
  virtualActionSupported: true,
  autoChargeMode: 'manual',
  status: 1,
  enabledTime: '2026-10-16',
  description: '动态机型',
  createTime: '2026-10-15',
  updateTime: '2026-10-16',
  urdf: file,
  cardPoster: file,
  ratioPoster: file,
};

describe('机器人机型接口', () => {
  const originalAdapter = http.defaults.adapter;
  afterEach(() => {
    http.defaults.adapter = originalAdapter;
    clearApiLogs();
    vi.restoreAllMocks();
  });

  it('通过查询参数往返保留完整动态编码与全部详情字段', async () => {
    http.defaults.adapter = vi.fn(async (config) => {
      const uri = http.getUri(config);
      expect(config.url).toBe('/robot/model');
      expect(config.method).toBe('get');
      expect(config.params).toBeInstanceOf(URLSearchParams);
      expect(new URL(uri, 'http://localhost').searchParams.get('modelCode')).toBe(model.modelCode);
      expect(uri).toContain('%2B%26%3F');
      return {
        data: { success: true, result: model },
        status: 200,
        statusText: 'OK',
        headers: {},
        config,
      };
    }) as AxiosAdapter;
    expect(await robotApi.getRobotModel(model.modelCode!)).toEqual({ source: 'real', data: model });
    expect(getApiLogs()[0]).toMatchObject({ source: 'real', status: 'success', url: '/robot/model' });
  });

  it('保留详情及嵌套文件的所有空值', async () => {
    const nullFile: RobotModelFile = {
      fileId: null,
      fileName: null,
      contentType: null,
      url: null,
      disposition: null,
    };
    const nullModel: RobotModel = {
      id: null,
      deviceType: null,
      nameZh: null,
      nameEn: null,
      modelCode: null,
      terminal_type: null,
      terminal_type_value: null,
      urdfFileKey: null,
      urdfMainPath: null,
      cardPosterFileKey: null,
      ratioPosterFileKey: null,
      virtualActionSupported: null,
      autoChargeMode: null,
      status: null,
      enabledTime: null,
      description: null,
      createTime: null,
      updateTime: null,
      urdf: nullFile,
      cardPoster: null,
      ratioPoster: null,
    };
    http.defaults.adapter = vi.fn(async (config) => ({
      data: { result: nullModel },
      status: 200,
      statusText: 'OK',
      headers: {},
      config,
    })) as AxiosAdapter;
    expect((await robotApi.getRobotModel('custom')).data).toEqual(nullModel);
  });

  it('从列表获取未预设的机型编码再查询详情', async () => {
    const code = '新机型 + &?';
    http.defaults.adapter = vi.fn(async (config) => {
      const result = config.url === '/robot/page'
        ? {
            rows: [{
              id: 'r1',
              name: '机器人',
              modelCode: code,
              model_code: code,
              terminalType: null,
              terminal_type: null,
              terminalTypeValue: null,
              terminal_type_value: null,
            }],
          }
        : {
            ...model,
            modelCode: new URLSearchParams(config.params).get('modelCode'),
          };
      return {
        data: { result },
        status: 200,
        statusText: 'OK',
        headers: {},
        config,
      };
    }) as AxiosAdapter;
    const list = await robotApi.listRobots();
    const row = list.data.rows[0];
    expect(row.model_code).toBe(code);
    expect((await robotApi.getRobotModel(row.modelCode!)).data.modelCode).toBe(code);
  });

  it.each(['网络', 'HTTP', '业务'])('%s失败使用明确演示数据并记录mock来源', async (failure) => {
    http.defaults.adapter = vi.fn(async (config) => {
      if (failure === '网络') throw new Error('网络不可用');
      if (failure === 'HTTP') {
        throw new AxiosError('HTTP 503', 'ERR_BAD_RESPONSE', config, undefined, {
          data: {},
          status: 503,
          statusText: 'Unavailable',
          headers: {},
          config,
        });
      }
      return {
        data: { success: false, errmsg: '机型不存在', result: null },
        status: 200,
        statusText: 'OK',
        headers: {},
        config,
      };
    }) as AxiosAdapter;
    const result = await robotApi.getRobotModel('演示 +&?');
    expect(result).toMatchObject({
      source: 'mock',
      data: {
        modelCode: '演示 +&?',
        nameZh: expect.stringContaining('演示'),
        urdf: null,
        cardPoster: null,
        ratioPoster: null,
      },
    });
    expect(result.reason).toBeTruthy();
    expect(getApiLogs()[0]).toMatchObject({ source: 'mock', status: 'mock', url: '/robot/model' });
  });

  it('空白输入在发出请求前拒绝', async () => {
    http.defaults.adapter = vi.fn() as AxiosAdapter;
    await expect(robotApi.getRobotModel(' \t\n')).rejects.toThrow('modelCode 不能为空');
    expect(http.defaults.adapter).not.toHaveBeenCalled();
    expect(getApiLogs()).toEqual([]);
  });
});
