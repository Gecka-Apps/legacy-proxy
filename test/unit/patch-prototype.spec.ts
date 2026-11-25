import { afterEach, expect, it } from "vitest";
import { applyPatch } from "../../src/jmap/methods/contacts.js";

// The ContactCard, Calendar and CalendarEvent /set handlers apply client
// patches with applyPatch (RFC 8620 §5.3).

afterEach(() => {
  for (const k of ["polluted", "nested"]) delete (Object.prototype as Record<string, unknown>)[k];
});

it("refuses a path that reaches a prototype, and changes nothing", () => {
  const target: Record<string, unknown> = { emails: { e1: { address: "a@x.io" } } };
  for (const path of ["__proto__/polluted", "emails/__proto__/polluted", "constructor/prototype/polluted", "emails/e1/__proto__", "prototype"]) {
    expect(() => applyPatch(target, { [path]: "yes" })).toThrow(expect.objectContaining({ type: "invalidPatch" }));
  }
  expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  expect(target).toEqual({ emails: { e1: { address: "a@x.io" } } });
});

it("walks only into own properties", () => {
  const target: Record<string, unknown> = {};
  applyPatch(target, { "toString/nested": 1 });
  expect(target).toEqual({ toString: { nested: 1 } });
  expect(typeof ({} as { toString: unknown }).toString).toBe("function");
});

it("still sets, replaces and removes along a path", () => {
  const target: Record<string, unknown> = { emails: { e1: { address: "a@x.io" } }, name: "A" };
  applyPatch(target, { "emails/e2/address": "b@x.io", "emails/e1": null, name: "B", "a~1b": 1 });
  expect(target).toEqual({ emails: { e2: { address: "b@x.io" } }, name: "B", "a/b": 1 });
});
