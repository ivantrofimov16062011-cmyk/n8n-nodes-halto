import {
  NodeConnectionTypes,
  NodeOperationError,
  type IDataObject,
  type IHookFunctions,
  type IHttpRequestMethods,
  type INodeType,
  type INodeTypeDescription,
  type IWebhookFunctions,
  type IWebhookResponseData,
} from "n8n-workflow";
import { checkBaseUrl } from "../Halto/logic";
import { isFreshDelivery, recentDeliveries, verifySignature } from "./signature";

/** "Halto Trigger": starts a workflow the moment someone approves or rejects (or a request expires). */
export class HaltoTrigger implements INodeType {
  description: INodeTypeDescription = {
    displayName: "Halto Trigger",
    name: "haltoTrigger",
    icon: { light: "file:../../icons/halto.svg", dark: "file:../../icons/halto.dark.svg" },
    group: ["trigger"],
    version: 1,
    subtitle: '={{"Approval decided: " + $parameter["statuses"].join(", ")}}',
    description: "Starts when a human approves or rejects one of this agent's requests in Halto",
    defaults: { name: "Halto Trigger" },
    inputs: [],
    outputs: [NodeConnectionTypes.Main],
    credentials: [{ name: "haltoApi", required: true }],
    webhooks: [{ name: "default", httpMethod: "POST", responseMode: "onReceived", path: "halto" }],
    properties: [
      {
        displayName: "Only These Outcomes",
        name: "statuses",
        type: "multiOptions",
        default: ["approved", "rejected", "expired"],
        options: [
          { name: "Approved", value: "approved" },
          { name: "Expired", value: "expired" },
          { name: "Rejected", value: "rejected" },
        ],
      },
    ],
  };

  webhookMethods = {
    default: {
      async checkExists(this: IHookFunctions): Promise<boolean> {
        const data = this.getWorkflowStaticData("node");
        if (!data.hookId) return false;
        const { hooks } = (await call(this, "GET", "/v1/hooks")) as { hooks: { id: string; active: boolean }[] };
        return hooks.some((h) => h.id === data.hookId && h.active);
      },
      async create(this: IHookFunctions): Promise<boolean> {
        const res = (await call(this, "POST", "/v1/hooks", { target_url: this.getNodeWebhookUrl("default") })) as { id: string; secret: string };
        const data = this.getWorkflowStaticData("node");
        data.hookId = res.id;
        data.secret = res.secret;
        return true;
      },
      async delete(this: IHookFunctions): Promise<boolean> {
        const data = this.getWorkflowStaticData("node");
        if (data.hookId) await call(this, "DELETE", `/v1/hooks/${data.hookId}`).catch(() => undefined);
        delete data.hookId;
        delete data.secret;
        return true;
      },
    },
  };

  async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
    const req = this.getRequestObject() as unknown as { rawBody?: Buffer };
    const body = this.getBodyData() as IDataObject;
    const raw = req.rawBody ? req.rawBody.toString("utf8") : JSON.stringify(body);
    const secret = String(this.getWorkflowStaticData("node").secret ?? "");
    const signature = String(this.getHeaderData()["x-halto-signature"] ?? "");
    if (!secret || !verifySignature(secret, raw, signature) || !isFreshDelivery(body.sent_at)) {
      this.getResponseObject().status(401).send("Invalid signature");
      return { noWebhookResponse: true };
    }
    // A signed delivery replayed within its 5 minutes is refused too: each delivery_id starts the workflow once.
    const staticData = this.getWorkflowStaticData("node");
    recentDeliveries.load(staticData.deliveries as Record<string, number> | undefined);
    if (!recentDeliveries.accept(body.delivery_id)) {
      this.getResponseObject().status(409).send("Delivery already received");
      return { noWebhookResponse: true };
    }
    staticData.deliveries = recentDeliveries.snapshot();
    const wanted = this.getNodeParameter("statuses", ["approved", "rejected", "expired"]) as string[];
    if (!wanted.includes(String(body.status))) return { workflowData: [[]] };
    return { workflowData: [this.helpers.returnJsonArray([body])] };
  }
}

async function call(ctx: IHookFunctions, method: IHttpRequestMethods, path: string, body?: IDataObject) {
  const credentials = await ctx.getCredentials("haltoApi");
  const base = checkBaseUrl(credentials.baseUrl);
  if ("error" in base) throw new NodeOperationError(ctx.getNode(), base.error);
  return ctx.helpers.httpRequestWithAuthentication.call(ctx, "haltoApi", { method, url: `${base.url}${path}`, body, json: true });
}
