import { act, renderHook, waitFor } from '@testing-library/react-native';
import { useAsync } from './useAsync';

describe('useAsync', () => {
  test('loading → success, and reload runs the loader again', async () => {
    const load = jest.fn().mockResolvedValue(42);
    const { result } = await renderHook(() => useAsync(load));
    await waitFor(() => expect(result.current.status).toBe('success'));
    expect(result.current.data).toBe(42);
    await act(async () => result.current.reload());
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  });

  test('errors are captured', async () => {
    const failure = new Error('nope');
    const load = () => Promise.reject(failure);
    const { result } = await renderHook(() => useAsync(load));
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.error).toBe(failure);
  });

  test('a stale result from an older loader is never shown', async () => {
    let resolveOld: (v: string) => void = () => {};
    const oldLoad = () => new Promise<string>((r) => (resolveOld = r));
    const newLoad = () => Promise.resolve('new');
    const { result, rerender } = await renderHook(
      (props: { load: () => Promise<string> }) => useAsync(props.load),
      {
        initialProps: { load: oldLoad },
      },
    );
    await rerender({ load: newLoad });
    await waitFor(() => expect(result.current.data).toBe('new'));
    await act(async () => resolveOld('old'));
    expect(result.current.data).toBe('new');
  });
});
