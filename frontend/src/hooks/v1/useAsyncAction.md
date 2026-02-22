# useAsyncAction (v1)

Standard async action lifecycle hook for Stellarcade frontend.

## Overview

`useAsyncAction` provides a consistent way to handle asynchronous operations (like API calls, RPC requests, or wallet transactions) with full lifecycle state management. It tracks whether an operation is idle, loading, successful, or has failed, and prevents common issues like race conditions and concurrent execution.

## Installation

```typescript
import { useAsyncAction } from '@/hooks/v1/useAsyncAction';
```

## Basic Usage

```tsx
import { useAsyncAction } from '@/hooks/v1/useAsyncAction';

function UserProfile({ userId }) {
  const { run, data, isLoading, isError, error } = useAsyncAction(
    async (id: string) => fetchUser(id),
    {
      onSuccess: (user) => console.log('Loaded user:', user),
      onError: (err) => console.error('Failed to load user:', err)
    }
  );

  return (
    <div>
      <button onClick={() => run(userId)} disabled={isLoading}>
        {isLoading ? 'Loading...' : 'Load Profile'}
      </button>

      {data && <div>Name: {data.name}</div>}
      {isError && <div>Error: {error.message}</div>}
    </div>
  );
}
```

## API Reference

### `useAsyncAction(action, options)`

**Arguments:**
- `action: (...args: Args) => Promise<T>`: The async function to execute.
- `options: AsyncActionOptions<T, E>`:
  - `onSuccess?: (data: T) => void | Promise<void>`: Callback when action succeeds.
  - `onError?: (error: E) => void | Promise<void>`: Callback when action fails.
  - `preventConcurrent?: boolean`: If `true` (default), prevents starting a new run if one is already loading.

**Returns:**
- `status: "idle" | "loading" | "success" | "error"`: Current status.
- `data: T | null`: The result of the latest successful run.
- `error: E | null`: The error object of the latest failed run.
- `isLoading: boolean`: True if status is 'loading'.
- `isSuccess: boolean`: True if status is 'success'.
- `isError: boolean`: True if status is 'error'.
- `isIdle: boolean`: True if status is 'idle'.
- `run(...args: Args): Promise<T | undefined>`: Function to trigger the action.
- `reset(): void`: Resets the state to idle.

## Features

### Concurrency Control

By default, `useAsyncAction` prevents concurrent executions of the same action. If `run()` is called while an execution is already in progress, the call is ignored. This behavior can be disabled by setting `preventConcurrent: false`.

```typescript
const { run } = useAsyncAction(uploadFile, { preventConcurrent: false });
// Multiple calls will trigger multiple uploads
```

### Race Condition Prevention

Even when concurrent executions are allowed, `useAsyncAction` ensures that the hook state always reflects the **latest** triggered execution. If a late-finishing older promise returns after a newer one has already updated the state, the older result is discarded.

### Type Safety

The hook is fully generic and preserves the types of your action's result, error, and arguments.

```typescript
// result.current.data will be string[]
// result.current.run will expect (query: string)
const { run, data } = useAsyncAction<string[]>(
  async (query: string) => search(query)
);
```

## Best Practices

1. **Pass Stable Actions**: If your action function is defined inside a component, wrap it in `useCallback` or define it outside the component to avoid unnecessary re-triggers (though `useAsyncAction` handles this internally for its own logic).
2. **Handle Errors**: Always provide an `onError` handler or use the `isError`/`error` flags in your UI to give feedback to users.
3. **Reset on Unmount/Change**: Use the `reset()` function if you need to clear the state when a target ID changes or a modal is closed.
