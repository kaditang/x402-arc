/**
 * Guards that keep this package honest about two things it cannot control: the x402 core interfaces,
 * and keccak topic hashes.
 *
 * The type assertions below are the point of the file — if @x402/core changes a signature, `npm run
 * typecheck` fails here instead of the payment path failing in production. They run at compile time;
 * the runtime assertions just keep the test visible in the report.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { keccak256, toHex } from "viem";
import type { FacilitatorClient } from "@x402/core/server";
import type { SchemeNetworkServer } from "@x402/core/types";
import { ArcLocalFacilitator } from "../src/facilitator.js";
import { ArcExactScheme } from "../src/scheme.js";
import { ArcRpc } from "../src/rpc.js";
import { TOPIC_AUTHORIZATION_USED, TOPIC_TRANSFER } from "../src/constants.js";

test("ArcLocalFacilitator satisfies @x402/core's FacilitatorClient", () => {
  const rpc = new ArcRpc({ url: "http://stub", fetchImpl: (async () => new Response("{}")) as unknown as typeof fetch });
  const facilitator: FacilitatorClient = new ArcLocalFacilitator({ secret: "s", rpc });
  assert.ok(typeof facilitator.verify === "function");
  assert.ok(typeof facilitator.settle === "function");
  assert.ok(typeof facilitator.getSupported === "function");
});

test("ArcExactScheme satisfies @x402/core's SchemeNetworkServer", () => {
  const scheme: SchemeNetworkServer = new ArcExactScheme({ secret: "s" });
  assert.equal(scheme.scheme, "exact");
});

test("event topics are the real keccak hashes, not remembered constants", () => {
  assert.equal(TOPIC_TRANSFER, keccak256(toHex("Transfer(address,address,uint256)")));
  assert.equal(TOPIC_AUTHORIZATION_USED, keccak256(toHex("AuthorizationUsed(address,bytes32)")));
});
