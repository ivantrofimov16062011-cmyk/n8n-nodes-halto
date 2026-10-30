import {
  NodeApiError,
  NodeConnectionTypes,
  NodeOperationError,
  type IDataObject,
  type IExecuteFunctions,
  type INodeExecutionData,
  type INodeType,
  type INodeTypeDescription,
  type JsonObject,
} from "n8n-workflow";
import { checkBaseUrl, protectBody } from "../Halto/logic";

/**
 * "Halto Protect": put it between what your agent reads (an email, a CRM record, a web page) and the AI step. The AI
 * gets the text with hidden instructions removed and personal and confidential data as placeholders ([[EMAIL_K7Q2M]]).
 * Halto Check later hands the real values to the tool in final_params, only where they may go.
 */
export class HaltoProtect implements INodeType {
  description: INodeTypeDescription = {
    displayName: "Halto Protect",
    name: "haltoProtect",
    icon: { light: "file:../../icons/halto.svg", dark: "file:../../icons/halto.dark.svg" },
    group: ["transform"],
    version: 1,
    subtitle: '={{$parameter["type"]}}',
    description: "Hide personal and confidential data from your AI, and remove hidden instructions, before the AI reads a text",
    defaults: { name: "Halto Protect" },
    // An AI Agent may call it too: what comes back (the protected text) is safe for its model.
    usableAsTool: true,
    inputs: [NodeConnectionTypes.Main],
    outputs: [NodeConnectionTypes.Main],
    credentials: [{ name: "haltoApi", required: true }],
    properties: [
      {
        displayName: "Text the AI Will Read",
        name: "content",
        type: "string",
        typeOptions: { rows: 6 },
        default: "",
        required: true,
        description: "The email, web page, document or record your AI is about to read. For a whole record, use an expression that turns it into text.",
      },
      {
        displayName: "Type",
        name: "type",
        type: "options",
        default: "email",
        options: [
          { name: "Data From an App (CRM, Database…)", value: "api" },
          { name: "Document", value: "document" },
          { name: "Email", value: "email" },
          { name: "Form", value: "form" },
          { name: "Message", value: "message" },
          { name: "Review", value: "review" },
          { name: "Web Page", value: "web" },
        ],
      },
      { displayName: "From", name: "origin", type: "string", default: "", description: "Sender address or URL" },
      {
        displayName: "Session ID",
        name: "sessionId",
        type: "string",
        default: "={{$execution.id}}",
        description: "Links this text to the Halto Check steps of the same run, so an action right after reading something suspicious gets a closer look",
      },
    ],
  };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const items = this.getInputData();
    const out: INodeExecutionData[] = [];
    const credentials = await this.getCredentials("haltoApi");
    const base = checkBaseUrl(credentials.baseUrl);
    if ("error" in base) throw new NodeOperationError(this.getNode(), base.error);
    const baseUrl = base.url;
    for (let i = 0; i < items.length; i++) {
      try {
        const body = protectBody({
          content: String(this.getNodeParameter("content", i, "")),
          type: String(this.getNodeParameter("type", i, "email")),
          origin: String(this.getNodeParameter("origin", i, "")),
          sessionId: String(this.getNodeParameter("sessionId", i, "")),
        });
        let result: JsonObject;
        try {
          result = (await this.helpers.httpRequestWithAuthentication.call(this, "haltoApi", { method: "POST", url: `${baseUrl}/v1/clean`, body, json: true })) as JsonObject;
        } catch (err) {
          throw new NodeApiError(this.getNode(), err as JsonObject, { itemIndex: i });
        }
        out.push({ json: { ...items[i]!.json, halto: result as IDataObject }, pairedItem: { item: i } });
      } catch (err) {
        if (this.continueOnFail()) {
          // Fail closed: without Halto's answer the AI gets no text at all, never the unprotected original.
          out.push({ json: { ...items[i]!.json, halto: { content: "", protection: "failed", error: (err as Error).message } }, pairedItem: { item: i } });
          continue;
        }
        throw new NodeOperationError(this.getNode(), err as Error, { itemIndex: i });
      }
    }
    return [out];
  }
}
