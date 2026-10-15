import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useOnline } from './online';

describe('useOnline (M14)', () => {
  it('suit l’état initial du navigateur', () => {
    const { result } = renderHook(() => useOnline());
    expect(result.current).toBe(true);
  });

  it('descend hors ligne puis revient avec les événements du navigateur', () => {
    const { result } = renderHook(() => useOnline());

    act(() => {
      window.dispatchEvent(new Event('offline'));
    });
    expect(result.current).toBe(false);

    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    expect(result.current).toBe(true);
  });

  it('retire ses écouteurs au démontage (pas de fuite)', () => {
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    const { unmount } = renderHook(() => useOnline());
    unmount();

    const count = (calls: unknown[][], type: string): number => calls.filter(([name]) => name === type).length;
    expect(count(add.mock.calls, 'offline')).toBe(1);
    expect(count(remove.mock.calls, 'offline')).toBe(1);
    expect(count(add.mock.calls, 'online')).toBe(1);
    expect(count(remove.mock.calls, 'online')).toBe(1);
    vi.restoreAllMocks();
  });
});
