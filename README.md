# n8n-nodes-halto

[Halto](https://www.halto.tech) is a safety gateway for AI agents. This package adds three nodes to n8n:

- **Halto Protect**: put it between what your agent reads (an email, a CRM record, a web page) and the AI
  step. The AI gets the text with personal and confidential data replaced by placeholders such as
  `[[EMAIL_K7Q2M]]` and hidden instructions removed.

- **Halto Check**: put it right before a risky step (send an email, issue a refund, delete a record).
  It asks Halto whether your agent may do it and sends each item out through one of three outputs:
  **Allowed**, **Needs approval** or **Blocked**. Connect the risky step to *Allowed* only.
- **Halto Trigger**: starts a workflow the moment someone approves or rejects one of the agent's
  requests (or a request expires). Use it to continue long approvals without keeping a run open.

## Install

In n8n: **Settings → Community nodes → Install**, enter `n8n-nodes-halto`, and confirm.
(Self-hosted n8n only, until the package is verified for n8n Cloud.)

## Connect

1. In Halto: **Agents → New agent**, then copy the agent key (`hk_…`, shown once).
2. In n8n: add a **Halto Check** node, create a **Halto API** credential, and paste your Halto URL
   (for example `https://www.halto.tech`) and the agent key. **Test** turns the agent green in Halto.
   The URL must start with `https://`; plain `http://` works only for a Halto on `localhost` / `127.0.0.1`.

## Halto Check

| Field | What to put there |
|---|---|
| Tool / Action | What the agent wants to do, e.g. `gmail` / `send_email`, `stripe` / `refund` |
| Parameters (JSON) | The action's details: recipients, amount, text. Your rules are applied to these. |
| What the Agent Read | The email, web page or form the agent read earlier, so Halto can catch hidden instructions |
| Wait for Approval (Minutes) | `0` sends items that need a human to *Needs approval* at once. More than `0` keeps the run open until someone decides: approved items continue through *Allowed*, rejected or expired ones through *Blocked*. |

Each item leaves with the original data plus a `halto` field: `decision`, `reason`, `approval_id`,
`risk`, on *Allowed* `final_params` (the values for the risky step, with the real data put back behind
placeholders) and, after waiting, `approval` (who decided and how).

## Keeping customer data away from the AI

1. Trigger → **Halto Protect** (Text = the email body, Type *Email*, From = sender).
2. Your AI step reads `{{ $json.halto.content }}` (never the original) and writes placeholders such as
   `[[EMAIL_K7Q2M]]` where the customer's data goes.
3. **Halto Check** with the AI's draft → *Allowed* → the risky step uses `{{ $json.halto.final_params.to }}`,
   `{{ $json.halto.final_params.body }}`: Halto puts the real data back, only where your rules let it go.

Never feed `final_params` back into an AI step. When an **AI Agent** calls Halto Check as a tool, Halto
returns only the decision and the reason: real values never reach the AI's model. For an AI Agent that
uses tools itself, connect those tools through Halto's MCP gateway (the **MCP Client Tool** node with your
Halto MCP address): Halto then puts the real values back and sends them to the tool on its own.

If Halto can't be reached, or answers without a valid decision, the node fails. With **Settings → On Error → Continue** the item goes to
**Blocked**: the risky step never runs because of an error.

## Halto Trigger

Activate a workflow that starts with **Halto Trigger** and Halto calls it for every decision on that
agent's requests (filter by outcome in the node). Each call is signed and checked: a call without Halto's
signature, older than 5 minutes, or one the node has already received (same `delivery_id`) is refused. The item contains
`approval_id`, `status` (`approved`, `rejected` or `expired`), `decided_by`, `channel` and `decided_at`.
An approval is used once: after `approved`, send the same Halto Check again and it will be allowed.

## Links

- Halto: <https://www.halto.tech>
- Source and issues: <https://github.com/ivantrofimov16062011-cmyk/halto>
