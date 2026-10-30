import {
  NodeApiError,
  NodeConnectionTypes,
  NodeOperationError,
  type IDataObject,
  type IExecuteFunctions,
  type IHttpRequestMethods,
  type INodeExecutionData,
  type INodeType,
  type INodeTypeDescription,
  type JsonObject,
} from "n8n-workflow";
import { checkAndMaybeWait, checkBaseUrl, parseParams, resultForModel, type Requester } from "./logic";

/**
 * "Halto Check": put it right before a risky node (send email, refund, delete…). Items leave through
 * Allowed, Needs approval or Blocked, so the risky node only runs on Allowed.
 */
export class Halto implements INodeType {
  description: INodeTypeDescription = {
    displayName: "Halto Check",
    name: "halto",
    icon: { light: "file:../../icons/halto.svg", dark: "file:../../icons/halto.dark.svg" },
    group: ["transform"],
    version: 1,
    subtitle: '={{$parameter["tool"] + "." + $parameter["action"]}}',
    description: "Ask Halto whether your AI agent may take an action: Allowed, Needs approval or Blocked",
    defaults: { name: "Halto Check" },
    // AI Agent nodes can call it as a tool: "ask Halto before doing X".
    usableAsTool: true,
    inputs: [NodeConnectionTypes.Main],
    outputs: [NodeConnectionTypes.Main, NodeConnectionTypes.Main, NodeConnectionTypes.Main],
    outputNames: ["Allowed", "Needs approval", "Blocked"],
    credentials: [{ name: "haltoApi", required: true }],
    properties: [
      {
        displayName: "Tool",
        name: "tool",
        type: "string",
        default: "gmail",
        required: true,
        description: "The system the agent wants to use, e.g. gmail, stripe, hubspot",
      },
      {
        displayName: "Action",
        name: "action",
        type: "string",
        default: "send_email",
        required: true,
        description: "What it wants to do, e.g. send_email, refund, delete_contact",
      },
      {
        displayName: "Parameters (JSON)",
        name: "params",
        type: "json",
        default: '{\n  "to": "",\n  "subject": "",\n  "body": ""\n}',
        description: "The action's details. Halto reads recipients, amounts and text from here to apply your rules.",
      },
      {
        displayName: "What the Agent Read",
        name: "contentSources",
        type: "fixedCollection",
        typeOptions: { multipleValues: true },
        placeholder: "Add Content",
        default: {},
        description: "The email, web page or form the agent read before this step. Halto checks it for hidden instructions (prompt injection).",
        options: [
          {
            name: "source",
            displayName: "Content",
            values: [
              {
                displayName: "Type",
                name: "type",
                type: "options",
                default: "email",
                options: [
                  { name: "Document", value: "document" },
                  { name: "Email", value: "email" },
                  { name: "Form", value: "form" },
                  { name: "Message", value: "message" },
                  { name: "Review", value: "review" },
                  { name: "Web Page", value: "web" },
                ],
              },
              { displayName: "From", name: "origin", type: "string", default: "", description: "Sender address or URL" },
              { displayName: "Content", name: "content", type: "string", typeOptions: { rows: 4 }, default: "" },
            ],
          },
        ],
      },
      {
        displayName: "Wait for Approval (Minutes)",
        name: "waitMinutes",
        type: "number",
        typeOptions: { minValue: 0, maxValue: 60 },
        default: 0,
        description:
          "0 = don't wait: items that need a human leave through Needs approval at once. More than 0 = keep this run open until someone approves (then Allowed) or rejects (then Blocked). For long waits use the Halto Trigger node instead.",
      },
      {
        displayName: "Additional Fields",
        name: "additionalFields",
        type: "collection",
        placeholder: "Add Field",
        default: {},
        options: [
          { displayName: "Session ID", name: "sessionId", type: "string", default: "={{$execution.id}}", description: "Links checks of one run, so content read earlier taints later actions" },
          { displayName: "Cost", name: "cost", type: "number", default: 0, description: "Estimated cost of the action, for budgets" },
        ],
      },
    ],
  };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const items = this.getInputData();
    const outputs: INodeExecutionData[][] = [[], [], []];
    const credentials = await this.getCredentials("haltoApi");
    const base = checkBaseUrl(credentials.baseUrl);
    if ("error" in base) throw new NodeOperationError(this.getNode(), base.error);
    const baseUrl = base.url;
    // Called by an AI Agent as a tool, the answer goes to the AI's model: then it gets the decision and the reason only,
    // never the real values behind placeholders (final_params). Older n8n versions lack isToolExecution.
    const toolMode = typeof this.isToolExecution === "function" ? this.isToolExecution() : this.getNode().type.endsWith("Tool");

    for (let i = 0; i < items.length; i++) {
      const request: Requester = async (method, path, body) => {
        try {
          return (await this.helpers.httpRequestWithAuthentication.call(this, "haltoApi", {
            method: method as IHttpRequestMethods,
            url: `${baseUrl}${path}`,
            body,
            json: true,
          })) as JsonObject;
        } catch (err) {
          throw new NodeApiError(this.getNode(), err as JsonObject, { itemIndex: i });
        }
      };
      try {
        let params: Record<string, unknown>;
        try {
          params = parseParams(this.getNodeParameter("params", i, "{}"));
        } catch (err) {
          throw new NodeOperationError(this.getNode(), (err as Error).message, { itemIndex: i });
        }
        const sources = (this.getNodeParameter("contentSources.source", i, []) as IDataObject[]).map((s) => ({
          type: String(s.type ?? "email"),
          origin: String(s.origin ?? ""),
          content: String(s.content ?? ""),
        }));
        const extra = this.getNodeParameter("additionalFields", i, {}) as IDataObject;
        const { output, result } = await checkAndMaybeWait(
          request,
          {
            tool: this.getNodeParameter("tool", i) as string,
            action: this.getNodeParameter("action", i) as string,
            params,
            sessionId: extra.sessionId ? String(extra.sessionId) : undefined,
            contentSources: sources,
            cost: typeof extra.cost === "number" ? extra.cost : undefined,
          },
          { waitMinutes: this.getNodeParameter("waitMinutes", i, 0) as number },
        );
        outputs[output]!.push({ json: { ...items[i]!.json, halto: (toolMode ? resultForModel(result) : result) as IDataObject }, pairedItem: { item: i } });
      } catch (err) {
        if (this.continueOnFail()) {
          // Fail closed: an error never lets the action through.
          outputs[2]!.push({ json: { ...items[i]!.json, halto: { decision: "block", reason: (err as Error).message } }, pairedItem: { item: i } });
          continue;
        }
        // An existing NodeOperationError passes through unchanged; an API error keeps its messages.
        throw new NodeOperationError(this.getNode(), err as Error, { itemIndex: i });
      }
    }
    return outputs;
  }
}
