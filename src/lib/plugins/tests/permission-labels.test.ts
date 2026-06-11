import { describe, it, expect } from "vitest";
import { permissionLabel, permissionDetail } from "../permission-labels.js";

describe("permissionLabel", () => {
  it("read-entries → 'Read your notes'", () => {
    expect(permissionLabel("read-entries")).toBe("Read your notes");
  });

  it("write-entries → 'Create and edit notes'", () => {
    expect(permissionLabel("write-entries")).toBe("Create and edit notes");
  });

  it("network:api.example.com → 'Connect to api.example.com'", () => {
    expect(permissionLabel("network:api.example.com")).toBe("Connect to api.example.com");
  });

  it("network:www.googleapis.com → 'Connect to www.googleapis.com'", () => {
    expect(permissionLabel("network:www.googleapis.com")).toBe("Connect to www.googleapis.com");
  });

  it("filesystem:/home/user/docs → 'Access files at /home/user/docs'", () => {
    expect(permissionLabel("filesystem:/home/user/docs")).toBe("Access files at /home/user/docs");
  });

  it("unknown permission → title-cased label", () => {
    // Should not throw; returns a readable fallback.
    const label = permissionLabel("some-unknown-perm");
    expect(typeof label).toBe("string");
    expect(label.length).toBeGreaterThan(0);
  });
});

describe("permissionDetail", () => {
  it("read-entries has a non-empty description", () => {
    const d = permissionDetail("read-entries");
    expect(d).toContain("read");
  });

  it("write-entries has a non-empty description", () => {
    const d = permissionDetail("write-entries");
    expect(d).toContain("creat");
  });

  it("network:<host> embeds the host in the description", () => {
    const d = permissionDetail("network:api.example.com");
    expect(d).toContain("api.example.com");
  });

  it("filesystem:<path> embeds the path in the description", () => {
    const d = permissionDetail("filesystem:/tmp/data");
    expect(d).toContain("/tmp/data");
  });

  it("unknown permission returns a non-empty string", () => {
    const d = permissionDetail("mystery-perm");
    expect(typeof d).toBe("string");
    expect(d.length).toBeGreaterThan(0);
  });
});
