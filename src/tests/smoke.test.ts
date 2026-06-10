import { describe, it, expect } from "vitest";
import { APP_NAME } from "../version.js";

describe("smoke", () => {
  it("imports APP_NAME correctly", () => {
    expect(APP_NAME).toBe("ToNoteDo");
  });
});
