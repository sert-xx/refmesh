import { describe, expect, it, vi } from 'vitest';
import { type RefmeshHybridStores, runAndClose } from '../src/db/connection.js';

function fakeStores(closeImpl?: () => Promise<void> | void): {
  stores: RefmeshHybridStores;
  closeSpy: ReturnType<typeof vi.fn>;
} {
  const closeSpy = vi.fn(async () => {
    if (closeImpl) await closeImpl();
  });
  // Only the `close` method is exercised by runAndClose; the rest is unused.
  const stores = {
    graph: {} as RefmeshHybridStores['graph'],
    vector: {} as RefmeshHybridStores['vector'],
    close: closeSpy,
  } satisfies RefmeshHybridStores;
  return { stores, closeSpy };
}

describe('runAndClose', () => {
  it('returns fn result and closes stores on success', async () => {
    const { stores, closeSpy } = fakeStores();
    const result = await runAndClose(stores, async (s) => {
      expect(s).toBe(stores);
      return 42;
    });
    expect(result).toBe(42);
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('closes stores even when fn throws and re-throws the original error', async () => {
    const { stores, closeSpy } = fakeStores();
    const boom = new Error('boom');
    await expect(
      runAndClose(stores, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('swallows close failures on the success path so they do not mask fn result', async () => {
    const { stores, closeSpy } = fakeStores(() => {
      throw new Error('close failed');
    });
    const result = await runAndClose(stores, async () => 'ok');
    expect(result).toBe('ok');
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('swallows close failures on the error path so the original error is preserved', async () => {
    const { stores, closeSpy } = fakeStores(() => {
      throw new Error('close failed');
    });
    const original = new Error('original');
    await expect(
      runAndClose(stores, async () => {
        throw original;
      }),
    ).rejects.toBe(original);
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('awaits close before resolving', async () => {
    let closed = false;
    const { stores } = fakeStores(async () => {
      await new Promise((r) => setTimeout(r, 5));
      closed = true;
    });
    await runAndClose(stores, async () => 1);
    expect(closed).toBe(true);
  });
});
