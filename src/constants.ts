/**
 * Arc network constants.
 *
 * Verified on-chain 2026-09-18 (eth_chainId / eth_call against the public RPCs), not copied from a
 * chain list: ChainList and sequence.xyz both publish 1243 for Arc mainnet, which is WRONG.
 */
export const ARC = {
  mainnet: {
    chainId: 5042, // 0x13b2 — verified via eth_chainId
    network: "eip155:5042",
    rpcUrl: "https://rpc.mainnet.arc.io",
    explorer: "https://explorer.arc.io",
  },
  testnet: {
    chainId: 5042002, // 0x4cef52 — verified via eth_chainId
    network: "eip155:5042002",
    rpcUrl: "https://rpc.testnet.arc.io",
    explorer: "https://explorer.testnet.arc.io",
  },
} as const;

export type ArcChain = (typeof ARC)[keyof typeof ARC];

/**
 * The USDC predeploy. Same address on mainnet and testnet, and it is a standard FiatTokenV2:
 * `name() = "USDC"`, `version() = "2"`, `decimals() = 6`, with EIP-3009 live (verified by signing a
 * `transferWithAuthorization` and static-calling it: a correct signature reverts with
 * "ERC20: transfer amount exceeds balance", a tampered one with "FiatTokenV2: invalid signature").
 *
 * ⚠️ THE 10^12 TRAP: this is ONE balance exposed at TWO precisions. As the native gas token USDC has
 * 18 decimals; through this ERC-20 interface it has 6. Payment amounts are ALWAYS the 6-decimal view.
 * Reading `eth_getBalance` and comparing it to a payment amount without scaling is off by 10^12.
 */
export const ARC_USDC = "0x3600000000000000000000000000000000000000";
export const ARC_USDC_DECIMALS = 6;
export const ARC_NATIVE_DECIMALS = 18;

/** EIP-712 domain fields of the Arc USDC predeploy (read on-chain; the domain separator differs per chain). */
export const ARC_USDC_EIP712 = { name: "USDC", version: "2" } as const;

/**
 * The asset transfer method this package implements, per x402 proposal #3504 ("exact on networks
 * where gas is the payment asset"). The client broadcasts its own EIP-3009 authorization — on Arc it
 * can, because gas IS USDC, so the facilitator's reason to exist (sponsoring gas) does not apply.
 */
export const ASSET_TRANSFER_METHOD = "eip3009-client-broadcast";

/**
 * Event topics, computed with keccak256 and re-derived in test/constants.test.ts so a typo here
 * cannot silently make every verification fail (or, worse, match the wrong event).
 */
export const TOPIC_TRANSFER =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"; // Transfer(address,address,uint256)
export const TOPIC_AUTHORIZATION_USED =
  "0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5"; // AuthorizationUsed(address,bytes32)
