import type { IAuthenticateGeneric, ICredentialTestRequest, ICredentialType, Icon, INodeProperties } from "n8n-workflow";

/** An agent key from Halto (Agents → the agent → Connect). One key per agent. */
export class HaltoApi implements ICredentialType {
  name = "haltoApi";
  displayName = "Halto API";
  icon: Icon = { light: "file:../icons/halto.svg", dark: "file:../icons/halto.dark.svg" };
  documentationUrl = "https://www.halto.tech/app/integrations";
  properties: INodeProperties[] = [
    {
      displayName: "Halto URL",
      name: "baseUrl",
      type: "string",
      default: "https://www.halto.tech",
      description: "The address of your Halto, starting with https:// (plain http:// only for localhost)",
    },
    {
      displayName: "Agent Key",
      name: "apiKey",
      type: "string",
      typeOptions: { password: true },
      default: "",
      placeholder: "hk_live_…",
      description: "The agent's key from Halto (shown once when you create the agent or a new key)",
    },
  ];

  authenticate: IAuthenticateGeneric = {
    type: "generic",
    properties: { headers: { Authorization: "=Bearer {{$credentials.apiKey}}" } },
  };

  // GET /v1/ping checks only the key and marks the agent as connected in Halto.
  test: ICredentialTestRequest = {
    request: { baseURL: "={{$credentials.baseUrl.replace(/\\/$/, '')}}", url: "/v1/ping", method: "GET" },
  };
}
