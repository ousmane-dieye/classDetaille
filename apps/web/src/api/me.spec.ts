import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEnrollment } from './me';

vi.mock('./client', () => ({ apiFetch: vi.fn() }));

afterEach(() => {
  vi.clearAllMocks();
});

describe('api me (lot 2)', () => {
  it('POST /api/me/enrollment ne porte que le classId (R16)', async () => {
    const { apiFetch } = await import('./client');
    vi.mocked(apiFetch).mockResolvedValue({});
    await createEnrollment('c1');
    expect(vi.mocked(apiFetch).mock.calls[0]).toEqual(['/api/me/enrollment', { method: 'POST', body: { classId: 'c1' } }]);
  });
});
