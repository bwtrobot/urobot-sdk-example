import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RobotPicker } from './RobotPicker';

describe('机器人选择器', () => {
  it('滚动接近列表底部时请求下一页', () => {
    const loadMore = vi.fn();
    render(<RobotPicker
      robots={Array.from({ length: 20 }, (_, index) => ({ id: `robot-${index}`, name: `机器人 ${index}` }))}
      selectedRobotId="robot-0"
      onSelect={vi.fn()}
      hasMore
      loadingMore={false}
      loadError={false}
      onLoadMore={loadMore}
    />);
    fireEvent.click(screen.getByRole('button', { name: /机器人 0/ }));
    const list = screen.getByRole('listbox');
    Object.defineProperties(list, {
      scrollHeight: { value: 800 }, clientHeight: { value: 200 }, scrollTop: { value: 570, configurable: true },
    });
    fireEvent.scroll(list);
    expect(loadMore).toHaveBeenCalledTimes(1);
  });
});
