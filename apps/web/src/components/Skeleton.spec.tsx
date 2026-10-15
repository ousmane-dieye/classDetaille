import type { ReactElement } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Skeleton, useDelayedFlag } from './Skeleton';

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

function Probe({ active }: { active: boolean }): ReactElement {
  const show = useDelayedFlag(active, 300);
  return <div data-testid="probe">{show ? 'chargement' : 'vide'}</div>;
}

describe('Skeleton', () => {
  it('est masqué aux lecteurs d’écran', () => {
    const { container } = render(<Skeleton height={64} />);
    const el = container.firstElementChild as HTMLElement;
    expect(el.getAttribute('aria-hidden')).toBe('true');
    expect(el.className).toContain('cp-skeleton');
  });
});

describe('useDelayedFlag', () => {
  it('reste silencieux sous 300 ms', () => {
    render(<Probe active />);
    expect(screen_probe()).toBe('vide');
    act(() => vi.advanceTimersByTime(299));
    expect(screen_probe()).toBe('vide');
  });

  it('s’affiche au-delà de 300 ms et disparaît aussitôt si l’attente cesse', () => {
    render(<Probe active />);
    act(() => vi.advanceTimersByTime(301));
    expect(screen_probe()).toBe('chargement');
  });
});

const screen_probe = (): string | null => document.querySelector('[data-testid="probe"]')?.textContent ?? null;
