import { createHmac, timingSafeEqual } from "node:crypto";

/** Halto signs each delivery: `X-Halto-Signature: sha256=<hex HMAC-SHA256 of the raw body>`. */
export function verifySignature(secret: string, rawBody: string, header: string): boolean {
  const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(header);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Deliveries carry their send time inside the signed body; older ones are refused as possible replays. */
export const MAX_DELIVERY_AGE_MS = 5 * 60 * 1000;

/** A delivery must say when it was sent (inside the signed body), no more than 5 minutes from now. */
export function isFreshDelivery(sentAt: unknown, now = Date.now()): boolean {
  const t = typeof sentAt === "string" ? Date.parse(sentAt) : NaN;
  return Number.isFinite(t) && Math.abs(now - t) <= MAX_DELIVERY_AGE_MS;
}

/**
 * Delivery ids seen in the last few minutes (longer than the freshness window, so a replay of a fresh delivery is
 * caught too). Bounded: the oldest are dropped first. `seen` can be preloaded from the workflow's static data.
 */
export class RecentDeliveries {
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly keepMs = 2 * MAX_DELIVERY_AGE_MS,
    private readonly max = 5000,
  ) {}

  /** True the first time an id is offered within keepMs; false for a repeat (or a missing / odd id). */
  accept(id: unknown, now = Date.now()): boolean {
    if (typeof id !== "string" || !id || id.length > 200) return false;
    this.prune(now);
    const at = this.seen.get(id);
    if (at !== undefined && now - at <= this.keepMs) return false;
    this.seen.set(id, now);
    while (this.seen.size > this.max) this.seen.delete(this.seen.keys().next().value as string);
    return true;
  }

  /** Remember ids recorded elsewhere (e.g. by another run of the same workflow). */
  load(entries: Record<string, number> | undefined, now = Date.now()): void {
    for (const [id, at] of Object.entries(entries ?? {})) if (typeof at === "number" && now - at <= this.keepMs && !this.seen.has(id)) this.seen.set(id, at);
  }

  /** The ids still inside the window, for the workflow's static data. */
  snapshot(now = Date.now()): Record<string, number> {
    this.prune(now);
    return Object.fromEntries([...this.seen].slice(-500));
  }

  private prune(now: number): void {
    for (const [id, at] of this.seen) if (now - at > this.keepMs) this.seen.delete(id);
  }
}

/** One memory for every Halto Trigger in this n8n process (each delivery id is unique across hooks). */
export const recentDeliveries = new RecentDeliveries();
