import { describe, expect, it } from "vitest";
import { formatSignupVerificationCode } from "../../src/features/auth/signupVerificationCode";

describe("pending signup verification code", () => {
  it.each([
    ["123456", "123-456"],
    ["123-456", "123-456"],
    ["123 456", "123-456"],
    ["000123", "000-123"],
    ["12345678", "123-456"],
    ["12a3 4b56", "123-456"],
  ])("formats %s as %s", (input, expected) => {
    expect(formatSignupVerificationCode(input)).toBe(expected);
  });

  it("keeps partial input editable", () => {
    expect(formatSignupVerificationCode("0012")).toBe("001-2");
    expect(formatSignupVerificationCode("")).toBe("");
  });
});
