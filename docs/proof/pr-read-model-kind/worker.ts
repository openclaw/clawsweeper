import { DurableObject } from "cloudflare:workers";
import {
  GithubWebhookReadModelStore,
  githubWebhookReadModelDeliveryFromWebhook,
} from "../../../dashboard/github-webhook-read-model.ts";

const secret = "synthetic-pr-kind-proof-secret";
globalThis.fetch = async () => { throw new Error("proof forbids outbound Worker requests"); };

export class ReadModelProof extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    const store = new GithubWebhookReadModelStore(this.ctx.storage);
    store.ensureSchemaSync();
    const body = await request.json() as Record<string, any>;
    const route = new URL(request.url).pathname;
    if (route === "/__proof/delivery") {
      const delivery = githubWebhookReadModelDeliveryFromWebhook(body as any);
      if (!delivery) throw new Error("invalid proof delivery");
      return Response.json(store.ingest(delivery));
    }
    if (route === "/__proof/old-row") {
      this.ctx.storage.sql.exec(
        `UPDATE github_webhook_read_model_items_v1
            SET snapshot_json = json_remove(snapshot_json, '$.pull_request')
          WHERE repository = ? AND number = ?`,
        body.repository, body.number,
      );
      return Response.json({ ok: true });
    }
    if (route === "/__proof/head") {
      if (body.sha) await this.ctx.storage.put("head", body.sha);
      return Response.json({ head: { sha: await this.ctx.storage.get("head") } });
    }
    if (route === "/__proof/comment") {
      const posted = (await this.ctx.storage.get<Record<string, unknown>[]>("posted")) ?? [];
      if (body.headSha) {
        posted.push(body);
        await this.ctx.storage.put("posted", posted);
      }
      return Response.json({ posted });
    }
    if (route === "/internal/state/github-read-model/item") {
      return Response.json(await store.readItem(body));
    }
    if (route === "/internal/state/github-read-model/placeholders") {
      return Response.json(await store.readPlaceholders(body));
    }
    if (route === "/internal/state/github-read-model/repair") {
      return Response.json(store.repair(body));
    }
    return new Response("unknown fixture route", { status: 404 });
  }
}

export default {
  async fetch(request: Request, env: { READ_MODEL: DurableObjectNamespace; PROOF_NONCE: string }) {
    if (new URL(request.url).pathname === "/__proof/ready") {
      return Response.json({ nonce: env.PROOF_NONCE });
    }
    const body = await request.clone().text();
    const key = await crypto.subtle.importKey(
      "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
    );
    const signature = Array.from(new Uint8Array(await crypto.subtle.sign(
      "HMAC", key, new TextEncoder().encode(body),
    )), (byte) => byte.toString(16).padStart(2, "0")).join("");
    if (request.headers.get("x-clawsweeper-exact-review-signature") !== `sha256=${signature}`) {
      return new Response("invalid proof signature", { status: 401 });
    }
    return env.READ_MODEL.get(env.READ_MODEL.idFromName("fixture")).fetch(request);
  },
};
