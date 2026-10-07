import { createServer } from "node:http";
import { AddressInfo } from "node:net";
import axios from "axios";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { wrapAxiosWithPayment, x402Client, x402HTTPClient } from "./index";

describe("payment-required request URL", () => {
  let origin: string;
  const server = createServer((req, res) => {
    if (req.headers["x-test-access"]) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ path: req.url }));
      return;
    }
    const challenge = {
      x402Version: 2,
      resource: { url: `${origin}${req.url}` },
      accepts: [],
    };
    res.writeHead(402, {
      "payment-required": Buffer.from(JSON.stringify(challenge)).toString("base64"),
    });
    res.end();
  });

  beforeAll(async () => {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close(error => (error ? reject(error) : resolve())),
    );
  });

  it.each([
    ["fetch", "/v1", "/quote", "/v1/quote?city=Seoul"],
    ["fetch", "/v1", "quote", "/v1/quote?city=Seoul"],
    ["fetch", "/v1/", "/quote", "/v1/quote?city=Seoul"],
    ["fetch", "", "/quote", "/quote?city=Seoul"],
    ["http", "/v1", "/quote", "/v1/quote?city=Seoul"],
  ])("matches %s request with base %s and path %s", async (transport, basePath, path, expected) => {
    let hookUrl: string | undefined;
    const client = new x402HTTPClient(new x402Client()).onPaymentRequired(async context => {
      hookUrl = context.requestUrl;
      return { headers: { "X-Test-Access": "yes" } };
    });
    const api = wrapAxiosWithPayment(
      axios.create({
        baseURL: basePath ? `${origin}${basePath}` : undefined,
        adapter: transport,
        proxy: false,
      }),
      client,
    );
    const response = await api.get(basePath ? path : `${origin}${path}`, {
      params: { city: "Seoul" },
    });

    expect(response.data.path).toBe(expected);
    expect(hookUrl).toBe(`${origin}${response.data.path}`);
  });

  it("uses the instance's default params and custom serializer", async () => {
    let hookUrl: string | undefined;
    const client = new x402HTTPClient(new x402Client()).onPaymentRequired(async context => {
      hookUrl = context.requestUrl;
      return { headers: { "X-Test-Access": "yes" } };
    });
    const api = wrapAxiosWithPayment(
      axios.create({
        baseURL: `${origin}/v1`,
        adapter: "fetch",
        proxy: false,
        params: { tag: ["a", "b"] },
        paramsSerializer: { serialize: params => `tag=${params.tag.join(",")}` },
      }),
      client,
    );
    const response = await api.get("/quote");

    expect(response.data.path).toBe("/v1/quote?tag=a,b");
    expect(hookUrl).toBe(`${origin}${response.data.path}`);
  });
});

describe("paid retry Cookie serialization", () => {
  let origin: string;
  const cookies: string[] = [];
  const server = createServer((req, res) => {
    cookies.push(req.headers.cookie ?? "");
    if (!req.headers["payment-signature"]) {
      const challenge = {
        x402Version: 2,
        resource: { url: `${origin}/paid` },
        accepts: [
          {
            scheme: "fixture",
            network: "fixture:1",
            amount: "1",
            asset: "fixture",
            payTo: "fixture",
            maxTimeoutSeconds: 60,
            extra: {},
          },
        ],
      };
      res.writeHead(402, {
        "content-type": "application/json",
        "payment-required": Buffer.from(JSON.stringify(challenge)).toString("base64"),
      });
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });

  beforeAll(async () => {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close(error => (error ? reject(error) : resolve())),
    );
  });

  it("joins a Cookie array with semicolons on the paid retry", async () => {
    const client = new x402Client().setSpendControls(false).register("fixture:1", {
      scheme: "fixture",
      createPaymentPayload: async () => ({ x402Version: 2, payload: { fixture: true } }),
    });
    const api = wrapAxiosWithPayment(axios.create({ baseURL: origin, proxy: false }), client);
    const response = await api.get("/paid", {
      headers: { Cookie: ["session=demo", "locale=zh"] },
    });

    expect(response.status).toBe(200);
    expect(cookies).toEqual(["session=demo; locale=zh", "session=demo; locale=zh"]);
  });
});
