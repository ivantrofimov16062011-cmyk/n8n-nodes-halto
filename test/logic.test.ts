import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { checkAndMaybeWait, checkBody, outputFor, parseParams, protectBody, resultForModel, checkBaseUrl, type Json, type Requester } from "../nodes/Halto/logic";
import { isFreshDelivery, MAX_DELIVERY_AGE_MS, RecentDeliveries, verifySignature } from "../nodes/HaltoTrigger/signature";

const input = { tool: "gmail", action: "send_email", params: { to: "guest@example.com" }, sessionId: "n8n-1", contentSources: [{ type: "email", origin: "guest@example.com", content: "Hi!" }] };

/** A fake Halto that answers from a script and records the calls. */
function fakeHalto(script: Json[]) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const request: Requester = async (method, path, body) => {
    calls.push({ method, path, body });
    const next = script.shift();
    if (!next) throw new Error(`unexpected call ${method} ${path}`);
    return next;
  };
  return { calls, request };
}
const noSleep = async () => {};

describe("Halto Check node logic", () => {
  it("builds the /v1/check body and drops empty content sources", () => {
    expect(checkBody({ ...input, contentSources: [...input.contentSources, { type: "email", origin: "", content: "  " }] })).toEqual({
      tool: "gmail",
      action: "send_email",
      params: { to: "guest@example.com" },
      session_id: "n8n-1",
      content_sources: [{ type: "email", origin: "guest@example.com", content: "Hi!" }],
    });
  });

  it("accepts params as an object or JSON text, and rejects other JSON", () => {
    expect(parseParams({ a: 1 })).toEqual({ a: 1 });
    expect(parseParams('{"amount": 400}')).toEqual({ amount: 400 });
    expect(parseParams("")).toEqual({});
    expect(() => parseParams("[1,2]")).toThrow(/JSON object/);
  });

  it("routes allow, pending and block to outputs 0, 1 and 2 without waiting", async () => {
    for (const [decision, output] of [["allow", 0], ["pending", 1], ["block", 2]] as const) {
      const h = fakeHalto([{ decision, approval_id: decision === "pending" ? "ap-1" : undefined }]);
      expect((await checkAndMaybeWait(h.request, input, { waitMinutes: 0 })).output).toBe(output);
      expect(h.calls).toHaveLength(1);
    }
  });

  it("an answer without a valid decision is an error, never a route (the action doesn't run)", async () => {
    for (const answer of [{}, { decision: "maybe" }, { ok: true }, { decision: "Allow" }] as Json[]) {
      const h = fakeHalto([answer]);
      await expect(checkAndMaybeWait(h.request, input, { waitMinutes: 0 })).rejects.toThrow(/valid decision/);
    }
    // Also on the re-check after an approval.
    const h = fakeHalto([{ decision: "pending", approval_id: "ap-1" }, { status: "approved" }, { html: "<html>" }]);
    await expect(checkAndMaybeWait(h.request, input, { waitMinutes: 5, sleep: noSleep })).rejects.toThrow(/valid decision/);
  });

  it("waits for a human, then re-checks once and goes to Allowed", async () => {
    const h = fakeHalto([{ decision: "pending", approval_id: "ap-1" }, { status: "pending" }, { status: "approved", decided_by: "Ivan" }, { decision: "allow", action_id: "act-9" }]);
    const r = await checkAndMaybeWait(h.request, input, { waitMinutes: 5, sleep: noSleep });
    expect(r.output).toBe(0);
    expect(h.calls.map((c) => `${c.method} ${c.path}`)).toEqual(["POST /v1/check", "GET /v1/approvals/ap-1", "GET /v1/approvals/ap-1", "POST /v1/check"]);
    expect((r.result.approval as { decided_by?: string }).decided_by).toBe("Ivan");
  });

  it("a rejection or expiry goes to Blocked and never re-checks", async () => {
    for (const status of ["rejected", "expired"]) {
      const h = fakeHalto([{ decision: "pending", approval_id: "ap-2" }, { status, decided_by: "Ivan" }]);
      const r = await checkAndMaybeWait(h.request, input, { waitMinutes: 5, sleep: noSleep });
      expect(r.output).toBe(2);
      expect(h.calls).toHaveLength(2);
    }
  });

  it("gives up after the wait time and leaves through Needs approval", async () => {
    let t = 0;
    const h = fakeHalto([{ decision: "pending", approval_id: "ap-3" }, ...Array.from({ length: 50 }, () => ({ status: "pending" }))]);
    const r = await checkAndMaybeWait(h.request, input, { waitMinutes: 1, sleep: async (ms) => void (t += ms), now: () => t });
    expect(r.output).toBe(1);
    expect(t).toBeLessThanOrEqual(60_000);
  });
});

describe("Halto Trigger signature", () => {
  it("accepts Halto's signature and rejects anything else", () => {
    const body = '{"event":"approval.decided","status":"approved"}';
    const sig = `sha256=${createHmac("sha256", "whsec_x").update(body).digest("hex")}`;
    expect(verifySignature("whsec_x", body, sig)).toBe(true);
    expect(verifySignature("whsec_y", body, sig)).toBe(false);
    expect(verifySignature("whsec_x", body + " ", sig)).toBe(false);
    expect(verifySignature("whsec_x", body, "")).toBe(false);
  });

  it("refuses old deliveries (replays) and deliveries without a send time", () => {
    const now = Date.parse("2026-10-16T12:00:00Z");
    expect(isFreshDelivery("2026-10-16T11:58:00Z", now)).toBe(true);
    expect(isFreshDelivery("2026-10-16T11:50:00Z", now)).toBe(false);
    expect(isFreshDelivery("2026-10-16T12:06:00Z", now)).toBe(false);
    expect(isFreshDelivery("not a date", now)).toBe(false);
    expect(isFreshDelivery(undefined, now)).toBe(false);
    expect(isFreshDelivery(1760616000000, now)).toBe(false);
  });

  it("starts the workflow once per delivery id, even when the same signed delivery is sent again within 5 minutes", () => {
    const seen = new RecentDeliveries();
    const t0 = Date.parse("2026-10-16T12:00:00Z");
    expect(seen.accept("d-1", t0)).toBe(true);
    expect(seen.accept("d-1", t0 + 60_000)).toBe(false);
    expect(seen.accept("d-1", t0 + MAX_DELIVERY_AGE_MS)).toBe(false);
    expect(seen.accept("d-2", t0 + 60_000)).toBe(true);
    // No id, or something that isn't one: refused.
    for (const bad of [undefined, "", 42, "x".repeat(201)]) expect(seen.accept(bad, t0)).toBe(false);
    // Remembered across runs through the workflow's static data.
    const other = new RecentDeliveries();
    other.load(seen.snapshot(t0 + 60_000), t0 + 60_000);
    expect(other.accept("d-2", t0 + 120_000)).toBe(false);
    expect(other.accept("d-3", t0 + 120_000)).toBe(true);
    // Bounded memory: the oldest ids go first.
    const small = new RecentDeliveries(MAX_DELIVERY_AGE_MS * 2, 3);
    for (const id of ["a", "b", "c", "d"]) expect(small.accept(id, t0)).toBe(true);
    expect(small.accept("d", t0)).toBe(false);
    expect(small.accept("a", t0)).toBe(true);
  });
});

describe("Halto URL in the credential", () => {
  it("is https, or plain http only on this computer", () => {
    expect(checkBaseUrl("https://www.halto.tech/")).toEqual({ url: "https://www.halto.tech" });
    expect(checkBaseUrl(" http://localhost:3000 ")).toEqual({ url: "http://localhost:3000" });
    expect(checkBaseUrl("http://127.0.0.1:3000")).toEqual({ url: "http://127.0.0.1:3000" });
    expect(checkBaseUrl("http://[::1]:3000")).toEqual({ url: "http://[::1]:3000" });
    for (const bad of ["http://www.halto.tech", "http://localhost.attacker.example", "ftp://www.halto.tech", "www.halto.tech", "", undefined]) {
      expect(checkBaseUrl(bad), String(bad)).toHaveProperty("error");
    }
  });
});

describe("data guard in n8n", () => {
  it("Halto Protect asks Halto to clean the text and hide personal data", () => {
    expect(protectBody({ content: "Hi, I'm Maria, maria@gmail.com", type: "email", origin: " maria@gmail.com ", sessionId: "n8n-1" })).toEqual({
      content: "Hi, I'm Maria, maria@gmail.com",
      protect: true,
      type: "email",
      origin: "maria@gmail.com",
      session_id: "n8n-1",
    });
    expect(protectBody({ content: "x", origin: " ", sessionId: "" })).toEqual({ content: "x", protect: true });
  });

  it("an AI Agent calling Halto Check as a tool never gets the real values or Halto Fix texts back", () => {
    const result: Json = {
      decision: "allow",
      reason: "Allowed by rule",
      action_id: "act-1",
      final_params: { to: "maria@gmail.com", body: "Dear Maria Georgiou" },
      fix: { status: "approved", fields: ["body"], issues: [{ kind: "tone", before: "Dear Maria Georgiou", after: "Hi Maria" }] },
      risk: { score: 10, level: "low" },
      approval: { status: "approved", decided_by: "Ivan", note: "x" },
    };
    const forModel = resultForModel(result);
    expect(forModel).toEqual({ decision: "allow", reason: "Allowed by rule", action_id: "act-1", risk: { score: 10, level: "low" }, approval: { status: "approved", decided_by: "Ivan" } });
    expect(JSON.stringify(forModel)).not.toMatch(/maria|Georgiou/i);
  });
});

describe("outputFor", () => {
  it("keeps the three outputs in a workflow, and sends every decision to the first one for an AI Agent's tool", () => {
    // 0 Allowed, 1 Needs approval, 2 Blocked.
    expect([0, 1, 2].map((o) => outputFor(o, false))).toEqual([0, 1, 2]);
    // n8n gives a tool's model the first output only: "needs approval" and "blocked" must reach it too.
    expect([0, 1, 2].map((o) => outputFor(o, true))).toEqual([0, 0, 0]);
  });
});
