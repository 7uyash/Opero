import { describe, expect, it } from "vitest";
import { classifySmtpError, extractVariables, findUnknownVariables, renderTemplate, textToHtml, unsubscribeToken, valuesForLead } from "../src";

describe("renderTemplate", () => {
  const values = { customer_name: "Rahul Sharma", business_name: "Acme", inquiry_subject: "Website Development" };

  it("fills variables, tolerating spaces inside braces", () => {
    const r = renderTemplate("Hi {{customer_name}}, thanks for contacting {{ business_name }}!", values);
    expect(r.output).toBe("Hi Rahul Sharma, thanks for contacting Acme!");
    expect(r.missing).toEqual([]);
  });

  it("uses fallbacks for missing data and tidies punctuation", () => {
    const r = renderTemplate("Hi {{customer_name}}, regarding {{inquiry_subject}}.", {});
    expect(r.output).toBe("Hi there, regarding your requirements.");
    expect(r.missing.sort()).toEqual(["customer_name", "inquiry_subject"]);
    // Empty fallback leaves no "Hi ," behind.
    expect(renderTemplate("Call {{customer_phone}} today", {}).output).toBe("Call today");
  });

  it("supports custom variables and leaves unknown ones visible", () => {
    const r = renderTemplate("Visit us at {{office_address}}. {{typo_var}}", {}, { office_address: "MG Road" });
    expect(r.output).toBe("Visit us at MG Road. {{typo_var}}");
    expect(r.unknown).toEqual(["typo_var"]);
  });

  it("finds variables and unknown variables", () => {
    expect(extractVariables("{{a}} {{ b }} {{a}}")).toEqual(["a", "b"]);
    expect(findUnknownVariables("{{customer_name}} {{nope}}", [])).toEqual(["nope"]);
    expect(findUnknownVariables("{{office}}", ["office"])).toEqual([]);
  });

  it("never greets a customer by their email address", () => {
    const v = valuesForLead({ name: "rahul@example.com", email: "rahul@example.com", phone: null, company: null, subject: null }, { name: "Acme", email: "a@a.com", website: null });
    expect(renderTemplate("Hi {{customer_first_name}},", v).output).toBe("Hi there,");
  });
});

describe("textToHtml", () => {
  it("escapes HTML and keeps paragraphs and links", () => {
    const html = textToHtml("Hi <b>you</b>\n\nSee https://acme.example/x?a=1&b=2\nThanks");
    expect(html).toContain("&lt;b&gt;you&lt;/b&gt;");
    expect(html).toContain('<a href="https://acme.example/x?a=1&amp;b=2">');
    expect(html).toContain("<br>");
    expect(html.match(/<p>/g)).toHaveLength(2);
  });
});

describe("classifySmtpError", () => {
  it("treats 5xx and auth failures as permanent", () => {
    expect(classifySmtpError(Object.assign(new Error("550 no such user"), { responseCode: 550 })).kind).toBe("permanent");
    expect(classifySmtpError(Object.assign(new Error("bad login"), { code: "EAUTH" })).kind).toBe("permanent");
  });
  it("treats 4xx and connection failures before sending as temporary", () => {
    expect(classifySmtpError(Object.assign(new Error("421 try later"), { responseCode: 421 })).kind).toBe("temporary");
    expect(classifySmtpError(Object.assign(new Error("refused"), { code: "ECONNECTION", command: "CONN" })).kind).toBe("temporary");
  });
  it("treats a dropped connection during DATA as delivery unknown (never auto-retried)", () => {
    const e = classifySmtpError(Object.assign(new Error("timeout"), { code: "ETIMEDOUT", command: "DATA" }));
    expect(e.kind).toBe("delivery_unknown");
    expect(e.retryable).toBe(false);
  });
});

describe("unsubscribe tokens", () => {
  it("are signed per lead and channel", () => {
    const a = unsubscribeToken("lead_1", "EMAIL");
    expect(a).not.toBe(unsubscribeToken("lead_2", "EMAIL"));
    expect(a).not.toBe(unsubscribeToken("lead_1", "WHATSAPP"));
    expect(a.startsWith("lead_1.EMAIL.")).toBe(true);
  });
});
