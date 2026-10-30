/**
 * The node's logic, free of n8n types so it can be tested directly: build the /v1/check body, wait for a
 * human when asked to, and pick the output (0 Allowed, 1 Needs approval, 2 Blocked).
 */

import { sleep as n8nSleep } from "n8n-workflow";

export type Decision = "allow" | "pending" | "block";
/** A JSON object from Halto's API. */
export type Json = Record<string, unknown>;
export type Requester = (method: "GET" | "POST", path: string, body?: Json) => Promise<Json>;

/**
 * The credential's Halto URL without a trailing slash. Only https, except a Halto on this computer (localhost,
 * 127.0.0.1, [::1]): over plain http the agent key and every request would travel readable.
 */
export function checkBaseUrl(raw: unknown): { url: string } | { error: string } {
  const url = String(raw ?? "").trim().replace(/\/+$/, "");
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { error: "The Halto URL in the credential is not a valid address, e.g. https://www.halto.tech" };
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (u.protocol === "https:" || (u.protocol === "http:" && local)) return { url };
  return { error: "The Halto URL in the credential must start with https:// (plain http is only allowed for localhost)." };
}

export interface CheckInput {
  tool: string;
  action: string;
  params: Record<string, unknown>;
  sessionId?: string;
  contentSources?: { type?: string; origin?: string; content?: string }[];
  cost?: number;
}

export const OUTPUT = { allow: 0, pending: 1, block: 2 } as const;

/** A proxy page, an empty body or a broken deployment answering 200 is not a decision: fail instead of routing it. */
export function checkAnswer(result: Json): Json {
  if (!result || typeof result !== "object" || !["allow", "pending", "block"].includes(String(result.decision))) {
    throw new Error("Halto answered without a valid decision (allow, pending or block). Check the Halto URL in the credential; the action was not run.");
  }
  return result;
}

export function checkBody(input: CheckInput): Record<string, unknown> {
  const sources = (input.contentSources ?? []).filter((s) => (s.content ?? "").trim() || (s.origin ?? "").trim());
  return {
    tool: input.tool.trim(),
    action: input.action.trim(),
    params: input.params,
    ...(input.sessionId?.trim() ? { session_id: input.sessionId.trim() } : {}),
    ...(sources.length ? { content_sources: sources } : {}),
    ...(typeof input.cost === "number" && input.cost > 0 ? { cost: input.cost } : {}),
  };
}

/** Params may arrive as an object (expression) or as JSON text typed into the field. */
export function parseParams(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === "string" && value.trim()) {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    throw new Error("Parameters must be a JSON object, e.g. { \"to\": \"guest@example.com\" }");
  }
  return {};
}

const defaultSleep = (ms: number) => n8nSleep(ms);

/**
 * Check; if Halto asks a human and `waitMinutes` > 0, poll until they decide. An approval is used once,
 * so after "approved" the same check runs again and its answer decides the output.
 */
export async function checkAndMaybeWait(
  request: Requester,
  input: CheckInput,
  opts: { waitMinutes: number; intervalMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number },
): Promise<{ output: 0 | 1 | 2; result: Json }> {
  const body = checkBody(input);
  let result = checkAnswer(await request("POST", "/v1/check", body));
  if (result.decision === "pending" && result.approval_id && opts.waitMinutes > 0) {
    const sleep = opts.sleep ?? defaultSleep;
    const now = opts.now ?? Date.now;
    const deadline = now() + Math.min(opts.waitMinutes, 60) * 60_000;
    let interval = opts.intervalMs ?? 5_000;
    let status: Json = { status: "pending" };
    while (status.status === "pending" && now() + interval <= deadline) {
      await sleep(interval);
      interval = Math.min(interval * 1.5, 30_000);
      status = await request("GET", `/v1/approvals/${encodeURIComponent(String(result.approval_id))}`);
    }
    if (status.status === "approved") {
      result = { ...checkAnswer(await request("POST", "/v1/check", body)), approval: status };
    } else if (status.status !== "pending") {
      // Rejected or expired: never run the action.
      result = { ...result, decision: "block", reason: `${status.status === "expired" ? "No one answered in time" : "Rejected"}${status.decided_by ? ` by ${String(status.decided_by)}` : ""}.`, approval: status };
    } else {
      result = { ...result, approval: status };
    }
  }
  return { output: OUTPUT[result.decision as Decision], result };
}

export interface ProtectInput {
  content: string;
  type?: string;
  origin?: string;
  sessionId?: string;
}

/** /v1/clean body for Halto Protect: clean what the AI will read and hide personal and confidential values. */
export function protectBody(input: ProtectInput): Record<string, unknown> {
  return {
    content: input.content,
    protect: true,
    ...(input.type?.trim() ? { type: input.type.trim() } : {}),
    ...(input.origin?.trim() ? { origin: input.origin.trim() } : {}),
    ...(input.sessionId?.trim() ? { session_id: input.sessionId.trim() } : {}),
  };
}

const FOR_MODEL = ["decision", "reason", "action_id", "approval_id", "approval_expires_at", "risk", "category", "session_tainted"];

/**
 * What an AI Agent gets back when it calls Halto Check as a tool: the decision and why. Never `final_params` (the real
 * values behind placeholders, meant for the tool only) or Halto Fix's texts: they would reach the AI's model.
 */
export function resultForModel(result: Json): Json {
  const out: Json = Object.fromEntries(FOR_MODEL.filter((k) => k in result).map((k) => [k, result[k]]));
  const approval = result.approval;
  if (approval && typeof approval === "object") out.approval = { status: (approval as Json).status, decided_by: (approval as Json).decided_by };
  return out;
}
