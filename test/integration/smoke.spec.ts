// Integration smoke test - requires `compose.test.yml` to be up.
// Skipped by default; run with `npm run test:integration` after `docker compose
// -f compose.test.yml up -d`.

import { describe, expect, it } from "vitest";

const PROXY = process.env.PROXY_URL ?? "http://localhost:8080";
const SHOULD_RUN = process.env.RUN_INTEGRATION === "1";

(SHOULD_RUN ? describe : describe.skip)("legacy-proxy integration", () => {
  it("serves a JMAP session for a logged-in user", async () => {
    const login = await fetch(`${PROXY}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: process.env.TEST_USER ?? "test@local",
        password: process.env.TEST_PASS ?? "test",
        provider: process.env.TEST_PROVIDER ?? "stalwart-test",
      }),
    });
    expect(login.ok).toBe(true);
    const { token } = (await login.json()) as { token: string };

    const sess = await fetch(`${PROXY}/jmap/session`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(sess.ok).toBe(true);
    const body = (await sess.json()) as { capabilities: Record<string, unknown> };
    expect(body.capabilities["urn:ietf:params:jmap:core"]).toBeTruthy();
    expect(body.capabilities["urn:ietf:params:jmap:mail"]).toBeTruthy();
    expect(body.capabilities["urn:ietf:params:jmap:submission"]).toBeTruthy();
    expect(body.capabilities["urn:ietf:params:jmap:vacationresponse"]).toBeTruthy();
  });
});

(SHOULD_RUN ? describe : describe.skip)("sieve + calendar over the proxy", () => {
  async function login(): Promise<{ token: string; accountId: string }> {
    const r = await fetch(`${PROXY}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: process.env.TEST_USER ?? "test@local",
        password: process.env.TEST_PASS ?? "test",
        provider: process.env.TEST_PROVIDER ?? "stalwart-test",
      }),
    });
    expect(r.ok).toBe(true);
    return (await r.json()) as { token: string; accountId: string };
  }

  async function jmap(token: string, using: string[], calls: unknown[]): Promise<unknown[][]> {
    const r = await fetch(`${PROXY}/jmap`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ using: ["urn:ietf:params:jmap:core", ...using], methodCalls: calls }),
    });
    expect(r.ok).toBe(true);
    return ((await r.json()) as { methodResponses: unknown[][] }).methodResponses;
  }

  it("round-trips a filter script through SieveScript/set and activates it", async () => {
    const { token, accountId } = await login();
    const script = 'require ["fileinto"];\r\nif header :contains "subject" "[proxy-test]" { fileinto "INBOX"; }\r\n';
    const up = await fetch(`${PROXY}/jmap/upload/${accountId}`, {
      method: "POST",
      headers: { "content-type": "application/sieve", authorization: `Bearer ${token}` },
      body: script,
    });
    const { blobId } = (await up.json()) as { blobId: string };
    const [set] = await jmap(token, ["urn:ietf:params:jmap:sieve"], [
      ["SieveScript/set", { accountId, create: { s: { name: "filters", blobId } }, onSuccessActivateScript: "#s" }, "0"],
    ]);
    const created = (set![1] as { created?: Record<string, { id: string; isActive: boolean }> }).created?.s;
    expect(created?.isActive).toBe(true);

    const [get] = await jmap(token, ["urn:ietf:params:jmap:sieve"], [["SieveScript/get", { accountId }, "0"]]);
    const list = (get![1] as { list: Array<{ name: string; blobId: string; isActive: boolean }> }).list;
    const mine = list.find((s) => s.name === "filters");
    expect(mine?.isActive).toBe(true);
    const dl = await fetch(`${PROXY}/jmap/download/${accountId}/${mine!.blobId}/application%2Fsieve/script.sieve`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(await dl.text()).toBe(script);

    await jmap(token, ["urn:ietf:params:jmap:sieve"], [
      ["SieveScript/set", { accountId, onSuccessActivateScript: null }, "0"],
      ["SieveScript/set", { accountId, destroy: [created!.id] }, "1"],
    ]);
  });

  it("creates, reads back and deletes a calendar event", async () => {
    const { token, accountId } = await login();
    const using = ["urn:ietf:params:jmap:calendars"];
    const [set] = await jmap(token, using, [
      ["CalendarEvent/set", {
        accountId,
        create: { e: { "@type": "Event", title: "proxy smoke", start: "2030-01-15T10:00:00", duration: "PT1H", timeZone: "Europe/Paris" } },
      }, "0"],
    ]);
    const created = (set![1] as { created?: Record<string, { id: string }>; notCreated?: unknown }).created?.e;
    expect(created?.id, JSON.stringify(set![1])).toBeTruthy();

    const [query, get] = await jmap(token, using, [
      ["CalendarEvent/query", { accountId, filter: { after: "2030-01-01T00:00:00", before: "2030-02-01T00:00:00" }, timeZone: "Europe/Paris" }, "0"],
      ["CalendarEvent/get", { accountId, "#ids": { resultOf: "0", name: "CalendarEvent/query", path: "/ids" } }, "1"],
    ]);
    expect((query![1] as { ids: string[] }).ids).toContain(created!.id);
    const ev = (get![1] as { list: Array<Record<string, unknown>> }).list.find((e) => e.id === created!.id);
    expect(ev).toMatchObject({ title: "proxy smoke", start: "2030-01-15T10:00:00", timeZone: "Europe/Paris", utcStart: "2030-01-15T09:00:00Z" });

    const [del] = await jmap(token, using, [["CalendarEvent/set", { accountId, destroy: [created!.id] }, "0"]]);
    expect((del![1] as { destroyed: string[] }).destroyed).toEqual([created!.id]);
  });
});
