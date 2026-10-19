import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NarrationPanel } from './NarrationPanel';

afterEach(() => vi.restoreAllMocks());

describe('讲解节点列表', () => {
  it('多个缺少 id 的节点拥有独立的列表项和展开状态', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<NarrationPanel
      editionId="edition-1"
      processes={[{ id: 'process-1', name: '测试流程', nodes: [
        { id: null as unknown as string, uuid: 'node-a', name: '甲', selfScripts: ['script-a'] },
        { id: null as unknown as string, uuid: 'node-b', name: '乙', selfScripts: ['script-b'] },
      ] }]}
      selectedProcessId="process-1"
      onProcessSelect={vi.fn()}
      runtime={[]}
      segmentMode="expanded"
      onSegmentModeChange={vi.fn()}
      onControl={vi.fn()}
    />);

    const toggles = screen.getAllByTitle('展开行为');
    fireEvent.click(toggles[0]);
    expect(screen.getByText('script-a')).toBeTruthy();
    expect(screen.queryByText('script-b')).toBeNull();
    expect(errors.mock.calls.some(call => String(call[0]).includes('same key'))).toBe(false);
  });
});
