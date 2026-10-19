import { ChevronDown, ChevronRight, Pause, Play, RefreshCw, Square, StepForward } from 'lucide-react';
import { useState } from 'react';
import type {
  NarrationCommand,
  NarrationProcessNodeSummary,
  NarrationProcessSummary,
  NarrationRuntimeInfo,
  SegmentMode,
} from '../../../shared/types/api';
import { buildNarrationNodeBehaviors, getNarrationNodeStatus } from './narrationPanelUtils';
import './robot-execution.css';

interface NarrationPanelProps {
  editionId?: string;
  processes: NarrationProcessSummary[];
  selectedProcessId: string;
  onProcessSelect: (processId: string) => void;
  runtime: NarrationRuntimeInfo[];
  segmentMode: SegmentMode;
  onSegmentModeChange: (segmentMode: SegmentMode) => void;
  onControl: (
    command: NarrationCommand,
    options?: {
      processId?: string;
      processName?: string;
      editionId?: string;
      nodeId?: string;
      nodeName?: string;
    },
  ) => void;
}

export function NarrationPanel({
  editionId,
  processes,
  selectedProcessId,
  onProcessSelect,
  runtime,
  segmentMode,
  onSegmentModeChange,
  onControl,
}: NarrationPanelProps) {
  const [expandedNodeIds, setExpandedNodeIds] = useState<Set<string>>(new Set());
  const selectedProcess = processes.find((process) => process.id === selectedProcessId);
  const currentRuntime = runtime.find((item) => item.processId === selectedProcessId) ?? runtime[0];
  const runtimeNodeStatus = new Map(
    currentRuntime?.nodes?.map((node) => [node.nodeId, node.status ?? '']) ?? [],
  );
  const canControl = Boolean(editionId && selectedProcess);

  function send(command: NarrationCommand, node?: NarrationProcessNodeSummary) {
    if (!editionId || !selectedProcess) return;
    onControl(command, {
      editionId,
      processId: selectedProcess.id,
      processName: selectedProcess.name,
      nodeId: node?.id,
      nodeName: node?.name,
    });
  }

  function toggleNode(nodeKey: string) {
    setExpandedNodeIds((current) => {
      const next = new Set(current);
      if (next.has(nodeKey)) {
        next.delete(nodeKey);
      } else {
        next.add(nodeKey);
      }
      return next;
    });
  }

  return (
    <section className="side-card narration-card">
      <h2>讲解导览</h2>
      {processes.length === 0 ? (
        <p className="muted">当前地图版本无讲解流程</p>
      ) : (
        <>
          <label>
            讲解流程
            <select
              value={selectedProcessId}
              disabled={!editionId}
              onChange={(event) => onProcessSelect(event.target.value)}
            >
              {processes.map((process) => (
                <option key={process.id} value={process.id}>
                  {process.name}
                </option>
              ))}
            </select>
          </label>

          <div className="narration-view-toggle" role="group" aria-label="讲解片段视图">
            <button
              type="button"
              className={segmentMode === 'collapsed' ? 'active' : undefined}
              onClick={() => onSegmentModeChange('collapsed')}
            >
              折叠
            </button>
            <button
              type="button"
              className={segmentMode === 'expanded' ? 'active' : undefined}
              onClick={() => onSegmentModeChange('expanded')}
            >
              展开
            </button>
          </div>

          <div className="narration-runtime">
            <span>{currentRuntime?.status ?? '未开始'}</span>
            <strong>{currentRuntime?.currentNodeName ?? selectedProcess?.name ?? '-'}</strong>
          </div>

          <div className="command-grid">
            <button type="button" disabled={!canControl} onClick={() => send('start')}>
              <Play size={16} />
              开始
            </button>
            <button type="button" disabled={!canControl} onClick={() => send('pause')}>
              <Pause size={16} />
              暂停
            </button>
            <button type="button" disabled={!canControl} onClick={() => send('resume')}>
              <RefreshCw size={16} />
              恢复
            </button>
            <button type="button" disabled={!canControl} onClick={() => send('stop')}>
              <Square size={16} />
              停止
            </button>
          </div>

          <ul className="narration-node-list">
            {(selectedProcess?.nodes ?? []).map((node, index) => {
              // 上游节点 id 可能为空，位置后缀保证列表 key 和展开状态互不串联。
              const nodeKey = `${node.id || node.uuid || node.navNodeId || 'node'}:${index}`;
              const active = currentRuntime?.currentNodeId === node.id || currentRuntime?.currentNodeId === node.navNodeId;
              const segmentStatus = getNarrationNodeStatus(node.id, currentRuntime?.segments);
              const status = segmentMode === 'collapsed'
                ? segmentStatus ?? runtimeNodeStatus.get(node.id) ?? runtimeNodeStatus.get(node.navNodeId ?? '')
                : undefined;
              const behaviors = buildNarrationNodeBehaviors(node, currentRuntime?.segments, segmentMode);
              const stopoverLabel = node.stopover === false ? '不停留' : '停留';
              const expanded = expandedNodeIds.has(nodeKey);
              return (
                <li key={nodeKey}>
                  <div className="narration-node-row">
                    <button
                      type="button"
                      className="narration-node-toggle"
                      disabled={behaviors.length === 0}
                      onClick={() => toggleNode(nodeKey)}
                      title={expanded ? '收起行为' : '展开行为'}
                    >
                      {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    </button>
                    <button
                      type="button"
                      disabled={!canControl}
                      className={`narration-node-action${active ? ' active' : ''}`}
                      onClick={() => send('node-pick', node)}
                    >
                      <span className="node-name">{node.name}</span>
                      <span className="narration-node-meta">
                        <span>{stopoverLabel}</span>
                        <span>{status || (active ? '当前' : `#${node.order ?? '-'}`)}</span>
                      </span>
                      <StepForward size={14} />
                    </button>
                  </div>
                  {expanded && behaviors.length > 0 && (
                    <ol className="narration-behavior-list">
                      {behaviors.map((behavior) => (
                        <li key={`${node.id}-${behavior.index}`} className={behavior.valid ? undefined : 'invalid'}>
                          <span className="narration-behavior-index">{behavior.index + 1}</span>
                          <span className="narration-behavior-name">{behavior.name}</span>
                          {!behavior.valid && <span className="narration-behavior-invalid">无效</span>}
                          {segmentMode === 'expanded' && (
                            <span className="narration-behavior-status">{behavior.status ?? '-'}</span>
                          )}
                        </li>
                      ))}
                    </ol>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}
