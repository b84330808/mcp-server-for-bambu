import { describe, it, expect } from "vitest";
import { validateInput } from "../src/setup.js";

describe("validateInput", () => {
  it("accepts a well-formed input", () => {
    expect(
      validateInput({
        ip: "192.168.1.50",
        serial: "01P00A1234567890",
        access_code: "12345678",
      }),
    ).toBeNull();
  });

  it("rejects a non-IP string", () => {
    expect(
      validateInput({
        ip: "not-an-ip",
        serial: "01P00A1234567890",
        access_code: "12345678",
      }),
    ).toMatch(/IP/);
  });

  it("rejects a too-short serial", () => {
    expect(
      validateInput({
        ip: "192.168.1.50",
        serial: "abc",
        access_code: "12345678",
      }),
    ).toMatch(/Serial/);
  });

  it("rejects a serial with whitespace", () => {
    expect(
      validateInput({
        ip: "192.168.1.50",
        serial: "01P00A 1234567890",
        access_code: "12345678",
      }),
    ).toMatch(/Serial/);
  });

  it("rejects an access code that is not exactly 8 chars", () => {
    expect(
      validateInput({
        ip: "192.168.1.50",
        serial: "01P00A1234567890",
        access_code: "1234567",
      }),
    ).toMatch(/Access code/);
    expect(
      validateInput({
        ip: "192.168.1.50",
        serial: "01P00A1234567890",
        access_code: "123456789",
      }),
    ).toMatch(/Access code/);
  });
});
