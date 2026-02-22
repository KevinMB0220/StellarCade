import { AsyncStatus, AsyncActionResult } from "../../types/v1/async";

/**
 * Reusable logic for managing async action lifecycles.
 * 
 * This module provides UI-agnostic functions for handling idle/loading/success/error states.
 * 
 * @module utils/v1/useAsyncAction
 */

/**
 * Validates that the provided action is a function.
 */
export function validateAsyncAction(action: unknown): asserts action is (...args: any[]) => Promise<any> {
    if (typeof action !== "function") {
        throw new Error("Async action must be a function");
    }
}

/**
 * Creates an initial async action state.
 * 
 * @returns Initial state in 'idle' status
 */
export function createInitialState<T, E = Error>(): AsyncActionResult<T, E> {
    return {
        status: "idle",
        data: null,
        error: null,
        isLoading: false,
        isSuccess: false,
        isError: false,
        isIdle: true,
    };
}

/**
 * Transitions the async action state to a new status.
 * 
 * @param status - The new status to transition to
 * @param data - Optional result data (for 'success')
 * @param error - Optional error data (for 'error')
 * @returns The new async action state
 */
export function transitionState<T, E = Error>(
    status: AsyncStatus,
    data: T | null = null,
    error: E | null = null
): AsyncActionResult<T, E> {
    return {
        status,
        data,
        error,
        isLoading: status === "loading",
        isSuccess: status === "success",
        isError: status === "error",
        isIdle: status === "idle",
    };
}

/**
 * Guards against non-existent dependencies or invalid state.
 */
export function guardDependency<T>(dependency: T | undefined | null, name: string): T {
    if (dependency === undefined || dependency === null) {
        throw new Error(`Required dependency '${name}' is missing`);
    }
    return dependency;
}
