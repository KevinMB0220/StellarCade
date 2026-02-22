/**
 * Unit tests for validation hooks.
 *
 * Tests cover hook behavior, state management, and integration with validators.
 */

import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import {
  useWagerValidation,
  useGameIdValidation,
  useEnumValidation,
  useAddressValidation,
  useStringValidation,
  useNumberValidation,
  useFormValidation,
} from "../../../src/hooks/v1/validation";
import { ValidationErrorCode } from "../../../src/utils/v1/validation";

describe("useWagerValidation", () => {
  it("initializes with default values", () => {
    const { result } = renderHook(() => useWagerValidation());
    
    expect(result.current.value).toBe("");
    expect(result.current.error).toBeNull();
    expect(result.current.isValid).toBe(true);
    expect(result.current.isDirty).toBe(false);
  });

  it("initializes with custom value", () => {
    const { result } = renderHook(() => useWagerValidation("50000000"));
    
    expect(result.current.value).toBe("50000000");
  });

  it("updates value and marks as dirty", () => {
    const { result } = renderHook(() => useWagerValidation());
    
    act(() => {
      result.current.setValue("100000000");
    });
    
    expect(result.current.value).toBe("100000000");
    expect(result.current.isDirty).toBe(true);
  });

  it("validates on touch", () => {
    const { result } = renderHook(() => useWagerValidation("invalid"));
    
    act(() => {
      result.current.touch();
    });
    
    expect(result.current.isDirty).toBe(true);
    expect(result.current.error).not.toBeNull();
    expect(result.current.error?.code).toBe(ValidationErrorCode.InvalidType);
  });

  it("validates valid wager", () => {
    const { result } = renderHook(() => useWagerValidation("50000000"));
    
    let isValid: boolean = false;
    act(() => {
      isValid = result.current.validate();
    });
    
    expect(isValid).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it("validates invalid wager", () => {
    const { result } = renderHook(() => useWagerValidation("100"));
    
    let isValid: boolean = false;
    act(() => {
      isValid = result.current.validate();
    });
    
    expect(isValid).toBe(false);
    expect(result.current.error).not.toBeNull();
    expect(result.current.error?.code).toBe(ValidationErrorCode.OutOfRange);
  });

  it("clears error on value change", () => {
    const { result } = renderHook(() => useWagerValidation("invalid"));
    
    act(() => {
      result.current.touch();
    });
    
    expect(result.current.error).not.toBeNull();
    
    act(() => {
      result.current.setValue("50000000");
    });
    
    expect(result.current.error).toBeNull();
  });

  it("resets to initial value", () => {
    const { result } = renderHook(() => useWagerValidation("50000000"));
    
    act(() => {
      result.current.setValue("100000000");
      result.current.touch();
    });
    
    expect(result.current.value).toBe("100000000");
    expect(result.current.isDirty).toBe(true);
    
    act(() => {
      result.current.reset();
    });
    
    expect(result.current.value).toBe("50000000");
    expect(result.current.isDirty).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("resets to new value", () => {
    const { result } = renderHook(() => useWagerValidation("50000000"));
    
    act(() => {
      result.current.reset("200000000");
    });
    
    expect(result.current.value).toBe("200000000");
    expect(result.current.isDirty).toBe(false);
  });

  it("respects custom bounds", () => {
    const customBounds = { min: 1000n, max: 5000n };
    const { result } = renderHook(() => useWagerValidation("3000", customBounds));
    
    let isValid: boolean = false;
    act(() => {
      isValid = result.current.validate();
    });
    
    expect(isValid).toBe(true);
  });

  it("validates against custom bounds", () => {
    const customBounds = { min: 1000n, max: 5000n };
    const { result } = renderHook(() => useWagerValidation("10000", customBounds));
    
    let isValid: boolean = false;
    act(() => {
      isValid = result.current.validate();
    });
    
    expect(isValid).toBe(false);
    expect(result.current.error?.code).toBe(ValidationErrorCode.OutOfRange);
  });
});

describe("useGameIdValidation", () => {
  it("initializes with default values", () => {
    const { result } = renderHook(() => useGameIdValidation());
    
    expect(result.current.value).toBe("");
    expect(result.current.error).toBeNull();
    expect(result.current.isDirty).toBe(false);
  });

  it("validates valid game ID", () => {
    const { result } = renderHook(() => useGameIdValidation("12345"));
    
    let isValid: boolean = false;
    act(() => {
      isValid = result.current.validate();
    });
    
    expect(isValid).toBe(true);
  });

  it("validates invalid game ID", () => {
    const { result } = renderHook(() => useGameIdValidation("-1"));
    
    let isValid: boolean = false;
    act(() => {
      isValid = result.current.validate();
    });
    
    expect(isValid).toBe(false);
    expect(result.current.error?.code).toBe(ValidationErrorCode.OutOfRange);
  });

  it("accepts zero as valid ID", () => {
    const { result } = renderHook(() => useGameIdValidation("0"));
    
    let isValid: boolean = false;
    act(() => {
      isValid = result.current.validate();
    });
    
    expect(isValid).toBe(true);
  });
});

describe("useEnumValidation", () => {
  const allowedSides = ["heads", "tails"] as const;

  it("initializes with default values", () => {
    const { result } = renderHook(() => 
      useEnumValidation<"heads" | "tails">("heads", allowedSides, "side")
    );
    
    expect(result.current.value).toBe("heads");
    expect(result.current.error).toBeNull();
  });

  it("validates valid enum value", () => {
    const { result } = renderHook(() => 
      useEnumValidation<"heads" | "tails">("tails", allowedSides, "side")
    );
    
    let isValid: boolean = false;
    act(() => {
      isValid = result.current.validate();
    });
    
    expect(isValid).toBe(true);
  });

  it("validates empty value as invalid", () => {
    const { result } = renderHook(() => 
      useEnumValidation<"heads" | "tails">("", allowedSides, "side")
    );
    
    let isValid: boolean = false;
    act(() => {
      isValid = result.current.validate();
    });
    
    expect(isValid).toBe(false);
    expect(result.current.error?.code).toBe("REQUIRED" as any);
  });

  it("updates value correctly", () => {
    const { result } = renderHook(() => 
      useEnumValidation<"heads" | "tails">("heads", allowedSides, "side")
    );
    
    act(() => {
      result.current.setValue("tails");
    });
    
    expect(result.current.value).toBe("tails");
    expect(result.current.isDirty).toBe(true);
  });
});

describe("useAddressValidation", () => {
  const validAddress = "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW";

  it("initializes with default values", () => {
    const { result } = renderHook(() => useAddressValidation());
    
    expect(result.current.value).toBe("");
    expect(result.current.error).toBeNull();
  });

  it("validates valid address", () => {
    const { result } = renderHook(() => useAddressValidation(validAddress));
    
    let isValid: boolean = false;
    act(() => {
      isValid = result.current.validate();
    });
    
    expect(isValid).toBe(true);
  });

  it("validates invalid address", () => {
    const { result } = renderHook(() => useAddressValidation("invalid"));
    
    let isValid: boolean = false;
    act(() => {
      isValid = result.current.validate();
    });
    
    expect(isValid).toBe(false);
    expect(result.current.error?.code).toBe(ValidationErrorCode.InvalidAddress);
  });
});

describe("useStringValidation", () => {
  it("initializes with default values", () => {
    const { result } = renderHook(() => useStringValidation("", "username"));
    
    expect(result.current.value).toBe("");
    expect(result.current.error).toBeNull();
  });

  it("validates valid string", () => {
    const { result } = renderHook(() => 
      useStringValidation("john_doe", "username", { minLength: 3, maxLength: 20 })
    );
    
    let isValid: boolean = false;
    act(() => {
      isValid = result.current.validate();
    });
    
    expect(isValid).toBe(true);
  });

  it("validates string too short", () => {
    const { result } = renderHook(() => 
      useStringValidation("ab", "username", { minLength: 3 })
    );
    
    let isValid: boolean = false;
    act(() => {
      isValid = result.current.validate();
    });
    
    expect(isValid).toBe(false);
    expect(result.current.error?.code).toBe(ValidationErrorCode.TooShort);
  });

  it("validates string too long", () => {
    const { result } = renderHook(() => 
      useStringValidation("verylongusername", "username", { maxLength: 10 })
    );
    
    let isValid: boolean = false;
    act(() => {
      isValid = result.current.validate();
    });
    
    expect(isValid).toBe(false);
    expect(result.current.error?.code).toBe(ValidationErrorCode.TooLong);
  });

  it("validates pattern mismatch", () => {
    const { result } = renderHook(() => 
      useStringValidation("john!", "username", { 
        pattern: /^[a-z_]+$/,
        patternDescription: "lowercase letters and underscores"
      })
    );
    
    let isValid: boolean = false;
    act(() => {
      isValid = result.current.validate();
    });
    
    expect(isValid).toBe(false);
    expect(result.current.error?.code).toBe(ValidationErrorCode.InvalidFormat);
  });
});

describe("useNumberValidation", () => {
  it("initializes with default values", () => {
    const { result } = renderHook(() => useNumberValidation("", "age"));
    
    expect(result.current.value).toBe("");
    expect(result.current.error).toBeNull();
  });

  it("validates valid number", () => {
    const { result } = renderHook(() => useNumberValidation("25", "age", { min: 18, max: 100 }));
    
    let isValid: boolean = false;
    act(() => {
      isValid = result.current.validate();
    });
    
    expect(isValid).toBe(true);
  });

  it("validates number below minimum", () => {
    const { result } = renderHook(() => useNumberValidation("10", "age", { min: 18 }));
    
    let isValid: boolean = false;
    act(() => {
      isValid = result.current.validate();
    });
    
    expect(isValid).toBe(false);
    expect(result.current.error?.code).toBe(ValidationErrorCode.OutOfRange);
  });

  it("validates number above maximum", () => {
    const { result } = renderHook(() => useNumberValidation("150", "age", { max: 100 }));
    
    let isValid: boolean = false;
    act(() => {
      isValid = result.current.validate();
    });
    
    expect(isValid).toBe(false);
    expect(result.current.error?.code).toBe(ValidationErrorCode.OutOfRange);
  });
});

describe("useFormValidation", () => {
  it("validates all fields", () => {
    const { result: wagerResult } = renderHook(() => useWagerValidation("50000000"));
    const { result: sideResult } = renderHook(() => 
      useEnumValidation<"heads" | "tails">("heads", ["heads", "tails"], "side")
    );
    
    const { result: formResult } = renderHook(() => 
      useFormValidation({
        wager: wagerResult.current,
        side: sideResult.current,
      })
    );
    
    let allValid: boolean = false;
    act(() => {
      allValid = formResult.current.validateAll();
    });
    
    expect(allValid).toBe(true);
  });

  it("detects invalid fields", () => {
    const { result: wagerResult } = renderHook(() => useWagerValidation("invalid"));
    const { result: sideResult } = renderHook(() => 
      useEnumValidation<"heads" | "tails">("heads", ["heads", "tails"], "side")
    );
    
    const { result: formResult } = renderHook(() => 
      useFormValidation({
        wager: wagerResult.current,
        side: sideResult.current,
      })
    );
    
    let allValid: boolean = false;
    act(() => {
      allValid = formResult.current.validateAll();
    });
    
    expect(allValid).toBe(false);
  });

  it("touches all fields", () => {
    const { result: wagerResult } = renderHook(() => useWagerValidation());
    const { result: sideResult } = renderHook(() => 
      useEnumValidation<"heads" | "tails">("", ["heads", "tails"], "side")
    );
    
    const { result: formResult } = renderHook(() => 
      useFormValidation({
        wager: wagerResult.current,
        side: sideResult.current,
      })
    );
    
    expect(wagerResult.current.isDirty).toBe(false);
    expect(sideResult.current.isDirty).toBe(false);
    
    act(() => {
      formResult.current.touchAll();
    });
    
    expect(wagerResult.current.isDirty).toBe(true);
    expect(sideResult.current.isDirty).toBe(true);
  });
});

describe("Hook Stability", () => {
  it("maintains stable function references", () => {
    const { result, rerender } = renderHook(() => useWagerValidation());
    
    const initialSetValue = result.current.setValue;
    const initialValidate = result.current.validate;
    const initialReset = result.current.reset;
    
    rerender();
    
    expect(result.current.setValue).toBe(initialSetValue);
    expect(result.current.validate).toBe(initialValidate);
    expect(result.current.reset).toBe(initialReset);
  });

  it("handles rapid value changes", () => {
    const { result } = renderHook(() => useWagerValidation());
    
    act(() => {
      result.current.setValue("10000000");
      result.current.setValue("20000000");
      result.current.setValue("30000000");
    });
    
    expect(result.current.value).toBe("30000000");
    expect(result.current.isDirty).toBe(true);
  });

  it("handles validation during value change", () => {
    const { result } = renderHook(() => useWagerValidation("invalid"));
    
    act(() => {
      result.current.validate();
    });
    
    expect(result.current.error).not.toBeNull();
    
    act(() => {
      result.current.setValue("50000000");
    });
    
    expect(result.current.error).toBeNull();
    
    act(() => {
      result.current.validate();
    });
    
    expect(result.current.error).toBeNull();
  });
});
