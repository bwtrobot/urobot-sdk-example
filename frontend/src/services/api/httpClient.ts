import axios, { type AxiosRequestConfig, type Method } from 'axios';
import type { ApiResult } from '../../shared/types/api';

export const http = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL ?? '/api',
  timeout: 10000,
});

export type ApiSource = 'real' | 'mock';
export type ApiLogStatus = 'success' | 'mock' | 'error';

export interface ApiLogEntry {
  id: string;
  timestamp: string;
  method: Method;
  url: string;
  status: ApiLogStatus;
  source: ApiSource;
  reason?: string;
  durationMs: number;
}

export interface ApiRequestOptions<T> extends Omit<AxiosRequestConfig, 'method' | 'url'> {
  method: Method;
  url: string;
  fallbackData: T;
  fallbackReason?: string;
  rejectBusinessFailure?: boolean;
}

export interface ApiRequestResult<T> {
  data: T;
  source: ApiSource;
  reason?: string;
}

type ApiLogSubscriber = (logs: ApiLogEntry[]) => void;

const maxLogEntries = 80;
let logs: ApiLogEntry[] = [];
const subscribers = new Set<ApiLogSubscriber>();

function getErrorReason(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return 'Request failed, using mock data';
}

function appendLog(entry: Omit<ApiLogEntry, 'id' | 'timestamp'>) {
  logs = [
    {
      ...entry,
      id: createLogId(),
      timestamp: new Date().toISOString(),
    },
    ...logs,
  ].slice(0, maxLogEntries);

  const snapshot = getApiLogs();
  notifySubscribers(snapshot);
}

function createLogId() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }

  return `log-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function getApiLogs(): ApiLogEntry[] {
  return logs;
}

getApiLogs.subscribe = (subscriber: ApiLogSubscriber) => {
  subscribers.add(subscriber);

  return () => {
    subscribers.delete(subscriber);
  };
};

export function clearApiLogs() {
  logs = [];
  notifySubscribers(getApiLogs());
}

function notifySubscribers(snapshot: ApiLogEntry[]) {
  subscribers.forEach((subscriber) => {
    try {
      subscriber(snapshot);
    } catch {
      // Observers must not affect API request semantics.
    }
  });
}

function cloneFallbackData<T>(data: T): T {
  return structuredClone(data);
}

export async function apiRequest<T>(options: ApiRequestOptions<T>): Promise<ApiRequestResult<T>> {
  const { fallbackData, fallbackReason, rejectBusinessFailure, ...requestConfig } = options;
  const startTime = performance.now();

  try {
    const response = await http.request<ApiResult<T>>(requestConfig);
    // 按接口显式开启业务失败校验，使失败响应走统一降级与来源日志。
    if (rejectBusinessFailure && response.data.success === false) {
      throw new Error(response.data.errmsg || response.data.errcode || '接口返回业务失败');
    }
    const data = response.data.result;

    appendLog({
      method: options.method,
      url: options.url,
      status: 'success',
      source: 'real',
      durationMs: Math.round(performance.now() - startTime),
    });

    return {
      data,
      source: 'real',
    };
  } catch (error) {
    const reason = fallbackReason ?? getErrorReason(error);

    appendLog({
      method: options.method,
      url: options.url,
      status: 'mock',
      source: 'mock',
      reason,
      durationMs: Math.round(performance.now() - startTime),
    });

    return {
      data: cloneFallbackData(fallbackData),
      source: 'mock',
      reason,
    };
  }
}
