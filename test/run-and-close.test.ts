import { describe, expect, it, vi } from 'vitest';
import { type RefmeshStore, runAndClose } from '../src/db/store.js';

function fakeStore(closeImpl?: () => void | Promise<void>): {
  store: RefmeshStore;
  closeSpy: ReturnType<typeof vi.fn>;
} {
  const closeSpy = vi.fn(async () => {
    if (closeImpl) await closeImpl();
  });
  // Only `close` is exercised by runAndClose; everything else is left as
  // type-cast empty objects to avoid pulling in real SQLite for these unit
  // tests.
  const store = {
    path: '',
    db: {} as RefmeshStore['db'],
    statements: {} as RefmeshStore['statements'],
    vectors: {} as RefmeshStore['vectors'],
    transaction: <T>(fn: () => T) => fn(),
    close: closeSpy as unknown as () => void,
  } satisfies RefmeshStore;
  return { store, closeSpy };
}

describe('runAndClose', () => {
  it('returns fn result and closes the store on success', async () => {
    const { store, closeSpy } = fakeStore();
    const result = await runAndClose(store, async (s) => {
      expect(s).toBe(store);
      return 42;
    });
    expect(result).toBe(42);
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('closes the store even when fn throws and re-throws the original error', async () => {
    const { store, closeSpy } = fakeStore();
    const boom = new Error('boom');
    await expect(
      runAndClose(store, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('swallows close failures on the success path so they do not mask fn result', async () => {
    const { store, closeSpy } = fakeStore(() => {
      throw new Error('close failed');
    });
    const result = await runAndClose(store, async () => 'ok');
    expect(result).toBe('ok');
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('swallows close failures on the error path so the original error is preserved', async () => {
    const { store, closeSpy } = fakeStore(() => {
      throw new Error('close failed');
    });
    const original = new Error('original');
    await expect(
      runAndClose(store, async () => {
        throw original;
      }),
    ).rejects.toBe(original);
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('awaits close before resolving', async () => {
    let closed = false;
    const { store } = fakeStore(async () => {
      await new Promise((r) => setTimeout(r, 5));
      closed = true;
    });
    await runAndClose(store, async () => 1);
    expect(closed).toBe(true);
  });
});
