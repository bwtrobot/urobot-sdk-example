import { useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import type { RobotSummary } from '../../shared/types/api';
import { getRobotStatusLabel, isRobotOffline } from '../../shared/utils/robotStatus';

interface RobotPickerProps {
  robots: RobotSummary[];
  selectedRobotId: string;
  onSelect(id: string): void;
  hasMore: boolean;
  loadingMore: boolean;
  loadError: boolean;
  onLoadMore(): void;
}

export function RobotPicker({ robots, selectedRobotId, onSelect, hasMore, loadingMore, loadError, onLoadMore }: RobotPickerProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const selected = robots.find(robot => robot.id === selectedRobotId);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', closeOutside);
    return () => document.removeEventListener('pointerdown', closeOutside);
  }, [open]);

  return (
    <div className="robot-picker" ref={rootRef} onKeyDown={event => {
      if (event.key === 'Escape') { setOpen(false); triggerRef.current?.focus(); }
      if (open && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
        event.preventDefault();
        const options = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
        const current = options.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === 'ArrowDown' ? (current + 1) % options.length : (current - 1 + options.length) % options.length;
        options[next]?.focus();
      }
    }}>
      <button ref={triggerRef} type="button" className="robot-picker-trigger" aria-expanded={open} aria-haspopup="listbox" onClick={() => setOpen(current => !current)}>
        <span>{selected ? `${selected.name} · ${getRobotStatusLabel(selected)}` : '选择机器人'}</span>
        <ChevronDown size={16} aria-hidden="true" />
      </button>
      {open && (
        <div ref={listRef} className="robot-picker-list" role="listbox" aria-label="机器人列表" onScroll={event => {
          const list = event.currentTarget;
          if (hasMore && !loadingMore && !loadError && list.scrollHeight - list.scrollTop - list.clientHeight < 48) onLoadMore();
        }}>
          {robots.map(robot => {
            const offline = isRobotOffline(robot);
            return (
              <button key={robot.id} type="button" role="option" aria-selected={robot.id === selectedRobotId}
                disabled={offline} className="robot-picker-option" onClick={() => { onSelect(robot.id); setOpen(false); triggerRef.current?.focus(); }}>
                <span>{robot.name}</span>
                <small>{getRobotStatusLabel(robot)}{offline ? ' · 不可选' : ''}</small>
              </button>
            );
          })}
          {loadingMore && <div className="robot-picker-status" role="status">加载中…</div>}
          {loadError && <button type="button" className="robot-picker-retry" onClick={onLoadMore}>加载失败，重试</button>}
          {!hasMore && robots.length > 0 && <div className="robot-picker-status">已加载全部机器人</div>}
          {robots.length === 0 && <div className="robot-picker-status">暂无机器人</div>}
        </div>
      )}
    </div>
  );
}
