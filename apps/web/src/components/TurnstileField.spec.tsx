import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TurnstileField } from '../components/TurnstileField';

type WidgetOptions = { sitekey: string; callback(token: string): void; 'expired-callback'(): void; 'error-callback'(): void };

function fakeTurnstile(): { render: ReturnType<typeof vi.fn>; options: WidgetOptions[] } {
  const options: WidgetOptions[] = [];
  const api = {
    render: vi.fn((_container: HTMLElement, opts: WidgetOptions) => {
      options.push(opts);
      return `widget-${options.length}`;
    }),
    reset: vi.fn(),
    remove: vi.fn(),
  };
  vi.stubGlobal('turnstile', api);
  return { render: api.render, options };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.querySelectorAll('script[data-cp-turnstile]').forEach((s) => s.remove());
  // Le module garde la promesse du script entre deux tests : on repart d'une page neuve.
  vi.resetModules();
});

const SITE_KEY = '1x0000000000000000000AA';

describe('TurnstileField', () => {
  it('n’affiche rien sans clé publique (jamais de secret côté client)', () => {
    const { render: renderWidget } = fakeTurnstile();
    render(<TurnstileField onChange={vi.fn()} />);
    expect(document.querySelector('[data-testid="cp-turnstile"]')).toBeNull();
    expect(renderWidget).not.toHaveBeenCalled();
  });

  it('rend le widget avec la clé publique et transmet le jeton', async () => {
    const { render: renderWidget, options } = fakeTurnstile();
    const onChange = vi.fn();
    render(<TurnstileField siteKey={SITE_KEY} onChange={onChange} />);
    await vi.waitFor(() => expect(renderWidget).toHaveBeenCalledOnce());

    const container = renderWidget.mock.calls[0]?.[0] as HTMLElement;
    expect(container.getAttribute('data-testid')).toBe('cp-turnstile');
    const widget = options.at(0);
    expect(widget?.sitekey).toBe(SITE_KEY);

    widget?.callback('jeton-abc');
    expect(onChange).toHaveBeenCalledWith('jeton-abc');
  });

  it('charge le script une seule fois pour plusieurs widgets', async () => {
    fakeTurnstile();
    const loadScript = vi.fn(async () => {});
    const { rerender } = render(<TurnstileField siteKey={SITE_KEY} onChange={vi.fn()} loadScript={loadScript} />);
    rerender(<TurnstileField siteKey={SITE_KEY} onChange={vi.fn()} loadScript={loadScript} />);
    await vi.waitFor(() => expect(loadScript).toHaveBeenCalledOnce());
  });

  it('un jeton expiré n’est plus utilisable', async () => {
    const { options } = fakeTurnstile();
    const onChange = vi.fn();
    render(<TurnstileField siteKey={SITE_KEY} onChange={onChange} />);
    await vi.waitFor(() => expect(options).toHaveLength(1));

    const widget = options.at(0);
    widget?.callback('jeton-abc');
    widget?.['expired-callback']();
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it('si le script ne se charge pas, la vérification est annoncée comme indisponible', async () => {
    const { render: renderWidget } = fakeTurnstile();
    const loadScript = vi.fn(async () => Promise.reject(new Error('réseau')));
    render(<TurnstileField siteKey={SITE_KEY} onChange={vi.fn()} loadScript={loadScript} />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('anti-robot');
    expect(renderWidget).not.toHaveBeenCalled();
  });
});
