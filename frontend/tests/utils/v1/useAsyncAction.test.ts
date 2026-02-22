import { describe, it, expect } from "vitest";
import {
    createInitialState,
    transitionState,
    validateAsyncAction,
    guardDependency
} from "../../../src/utils/v1/useAsyncAction";

describe("useAsyncAction Utilities", () => {
    describe("createInitialState", () => {
        it("returns the correct initial state", () => {
            const state = createInitialState();
            expect(state.status).toBe("idle");
            expect(state.data).toBeNull();
            expect(state.error).toBeNull();
            expect(state.isIdle).toBe(true);
            expect(state.isLoading).toBe(false);
            expect(state.isSuccess).toBe(false);
            expect(state.isError).toBe(false);
        });
    });

    describe("transitionState", () => {
        it("transitions to loading correctly", () => {
            const state = transitionState("loading");
            expect(state.status).toBe("loading");
            expect(state.isLoading).toBe(true);
            expect(state.isIdle).toBe(false);
        });

        it("transitions to success with data", () => {
            const data = { id: 1, name: "Test" };
            const state = transitionState("success", data);
            expect(state.status).toBe("success");
            expect(state.data).toEqual(data);
            expect(state.isSuccess).toBe(true);
            expect(state.isLoading).toBe(false);
        });

        it("transitions to error with error object", () => {
            const error = new Error("Failed");
            const state = transitionState("error", null, error);
            expect(state.status).toBe("error");
            expect(state.error).toBe(error);
            expect(state.isError).toBe(true);
            expect(state.isSuccess).toBe(false);
        });
    });

    describe("validateAsyncAction", () => {
        it("does not throw for valid functions", () => {
            expect(() => validateAsyncAction(async () => { })).not.toThrow();
            expect(() => validateAsyncAction(() => Promise.resolve())).not.toThrow();
        });

        it("throws for invalid inputs", () => {
            expect(() => validateAsyncAction(null)).toThrow("Async action must be a function");
            expect(() => validateAsyncAction("string")).toThrow("Async action must be a function");
            expect(() => validateAsyncAction({})).toThrow("Async action must be a function");
        });
    });

    describe("guardDependency", () => {
        it("returns the dependency if it exists", () => {
            const dep = { foo: "bar" };
            expect(guardDependency(dep, "testDep")).toBe(dep);
        });

        it("throws if dependency is missing", () => {
            expect(() => guardDependency(null, "testDep")).toThrow("Required dependency 'testDep' is missing");
            expect(() => guardDependency(undefined, "testDep")).toThrow("Required dependency 'testDep' is missing");
        });
    });
});
