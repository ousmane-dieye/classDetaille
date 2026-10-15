import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from './client';
import { listActiveClasses, register } from './auth';

vi.mock('./client', () => ({ apiFetch: vi.fn() }));

const mockedFetch = vi.mocked(apiFetch);

afterEach(() => {
  vi.clearAllMocks();
});

describe('api auth', () => {
  it('inscrit avec le corps attendu par le serveur', async () => {
    mockedFetch.mockResolvedValue({ id: 'u1' });
    const body = {
      firstName: 'Awa',
      lastName: 'Diop',
      email: 'awa@example.com',
      password: 'une phrase de passe assez longue',
      classId: 'c1',
      turnstileToken: 'jeton',
    };
    await expect(register(body)).resolves.toEqual({ id: 'u1' });
    expect(mockedFetch).toHaveBeenCalledWith('/api/auth/register', { method: 'POST', body });
  });

  it('demande la liste des classes actives', async () => {
    mockedFetch.mockResolvedValue([{ id: 'c1', name: 'GIT3', level: 'L3', academicYear: '2026-2027' }]);
    await expect(listActiveClasses()).resolves.toHaveLength(1);
    expect(mockedFetch).toHaveBeenCalledWith('/api/classes/active');
  });
});
