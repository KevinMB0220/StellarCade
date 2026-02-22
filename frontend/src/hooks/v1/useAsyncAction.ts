import { useState, useCallback, useRef } from "react";
import type {
    AsyncActionResult,
    AsyncActionOptions,
} from "../../types/v1/async";
import {
    validateAsyncAction,
    createInitialState,
    transitionState
} from "../../utils/v1/useAsyncAction";

/**
 * Standard async action lifecycle hook.
 * 
 * Wraps async operations with idle/loading/success/error lifecycle.
 * Prevents concurrent race conditions when configured.
 * Provides typed callbacks for success and failure outcomes.
 * 
 * @param action - The async function to wrap
 * @param options - Configuration for success/error handlers and concurrency
 * @returns State and control functions (run, reset)
 * 
 * @example
 * ```typescript
 * const { run, isLoading, data, error } = useAsyncAction(
 *   async (id: string) => fetchUser(id),
 *   {
 *     onSuccess: (user) => console.log('Loaded:', user),
 *     onError: (err) => notifyError(err.message)
 *   }
 * );
 * 
 * return <button onClick={() => run("123")} disabled={isLoading}>Load User</button>;
 * ```
 */
export function useAsyncAction<T, E = Error, Args extends any[] = any[]>(
    action: (...args: Args) => Promise<T>,
    options: AsyncActionOptions<T, E> = {}
): AsyncActionResult<T, E> & {
    run: (...args: Args) => Promise<T | undefined>;
    reset: () => void;
} {
    const [state, setState] = useState<AsyncActionResult<T, E>>(() => createInitialState<T, E>());

    const { preventConcurrent = true } = options;

    // Ref to track the latest execution ID to prevent race conditions from outdated promises
    const lastExecutionId = useRef(0);

    // Ref for steady access to options without triggering re-renders or dependency changes
    const optionsRef = useRef(options);
    optionsRef.current = options;

    const reset = useCallback(() => {
        setState(createInitialState<T, E>());
    }, []);

    const run = useCallback(async (...args: Args): Promise<T | undefined> => {
        // Validate action at runtime
        validateAsyncAction(action);

        // Prevent concurrent runs if configured
        if (preventConcurrent && state.status === "loading") {
            return undefined;
        }

        const executionId = ++lastExecutionId.current;

        // Transition to loading
        setState(transitionState<T, E>("loading"));

        try {
            const result = await action(...args);

            // Only update state if this is still the latest execution
            if (executionId === lastExecutionId.current) {
                setState(transitionState<T, E>("success", result));

                if (optionsRef.current.onSuccess) {
                    await optionsRef.current.onSuccess(result);
                }
            }
            return result;
        } catch (err) {
            // Only update state if this is still the latest execution
            if (executionId === lastExecutionId.current) {
                const typedError = err as E;
                setState(transitionState<T, E>("error", null, typedError));

                if (optionsRef.current.onError) {
                    await optionsRef.current.onError(typedError);
                }
            }
            // Re-throw so the caller can also handle it if needed
            throw err;
        }
    }, [action, preventConcurrent, state.status]);

    return {
        ...state,
        run,
        reset,
    };
}
