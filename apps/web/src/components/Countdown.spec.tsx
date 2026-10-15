import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Countdown } from './Countdown';

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe('Countdown', () => {
  it('affiche le temps restant au format minute:seconde', () => {
    render(<Countdown seconds={522} />);
    expect(screen.getByText('08:42')).toBeTruthy();
  });

  it('baisse d’une seconde et s’arrête à zéro', () => {
    const onDone = vi.fn();
    render(<Countdown seconds={2} onDone={onDone} />);
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.getByText('00:01')).toBeTruthy();
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.getByText('00:00')).toBeTruthy();
    expect(onDone).toHaveBeenCalledOnce();
    act(() => vi.advanceTimersByTime(5000));
    expect(onDone).toHaveBeenCalledOnce();
  });

  it('n’affiche rien tant qu’il n’y a pas de délai à afficher', () => {
    const { container } = render(<Countdown seconds={null} />);
    expect(container.textContent).toBe('');
  });

  it('annonce le décompte poliment', () => {
    render(<Countdown seconds={60} />);
    expect(screen.getByText('01:00').getAttribute('aria-live')).toBe('polite');
  });
});
