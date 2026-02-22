/**
 * Types for async action lifecycle management.
 * 
 * @module types/v1/async
 */

/**
 * Status of an async operation
 */
export type AsyncStatus = "idle" | "loading" | "success" | "error";

/**
 * Result of an async action execution
 */
export interface AsyncActionResult<T, E = Error> {
    status: AsyncStatus;
    data: T | null;
    error: E | null;
    isLoading: boolean;
    isSuccess: boolean;
    isError: boolean;
    isIdle: boolean;
}

/**
 * Configuration options for async actions
 */
export interface AsyncActionOptions<T, E = Error> {
    /**
     * Callback triggered when the action succeeds
     */
    onSuccess?: (data: T) => void | Promise<void>;

    /**
     * Callback triggered when the action fails
     */
    onError?: (error: E) => void | Promise<void>;

    /**
     * If true, prevents multiple concurrent executions of the action.
     * If an execution is in progress, subsequent calls to run() will be ignored.
     * Default: true
     */
    preventConcurrent?: boolean;
}

/**
 * Functional interface for an async action manager
 */
export interface AsyncActionManager<T, E = Error, Args extends any[] = any[]> {
    /**
     * Current state of the async action
     */
    state: AsyncActionResult<T, E>;

    /**
     * Executes the async action with the provided arguments
     */
    run: (...args: Args) => Promise<T | undefined>;

    /**
     * Resets the state to idle
     */
    reset: () => void;
}
