// Server-side Coston2 reads for the Smart Accounts / FAssets path.
//
// ⭐ Every address here is resolved through `FlareContractRegistry` at request
// time, never hardcoded — HANDOFF.md §2.5. The registry address itself is the
// one documented literal (it is identical on every Flare network), and
// FCC's own contracts remain the separate exception noted in
// FCE_METHODOLOGY.md §5.
//
// This lives on the server rather than in the browser for two reasons: it keeps
// viem out of the client bundle, and it keeps the registry lookup in exactly one
// place so a redeploy is a cache flush rather than a hunt.

import { createPublicClient, http, type PublicClient } from "viem";

export const COSTON2_RPC = process.env.COSTON2_RPC_URL ?? "https://coston2-api.flare.network/ext/C/rpc";

// Same address on testnet and mainnet; the only literal in this file.
const CONTRACT_REGISTRY = "0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019" as const;

const registryAbi = [
  {
    name: "getContractAddressByName",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "_name", type: "string" }],
    outputs: [{ type: "address" }],
  },
] as const;

const macAbi = [
  { name: "getPersonalAccount", type: "function", stateMutability: "view", inputs: [{ type: "string" }], outputs: [{ type: "address" }] },
  { name: "getNonce", type: "function", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { name: "getXrplProviderWallets", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "string[]" }] },
  { name: "getExecutor", type: "function", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "address" }] },
] as const;

const assetManagerAbi = [
  { name: "getCoreVaultManager", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { name: "lotSize", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { name: "assetMintingDecimals", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { name: "fAsset", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  // Direct-minting fees. The names come from the Dev Hub's operational-parameters
  // page and were confirmed to answer on Coston2 — an earlier round of guesses
  // (directMintingFeeUBA, getInstructionFee, …) all reverted.
  { name: "getDirectMintingFeeBIPS", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { name: "getDirectMintingMinimumFeeUBA", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { name: "getDirectMintingExecutorFeeUBA", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

const coreVaultAbi = [
  { name: "coreVaultAddress", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
] as const;

let client: PublicClient | null = null;
function rpc(): PublicClient {
  client ??= createPublicClient({ transport: http(COSTON2_RPC) });
  return client;
}

// Registry lookups are stable between deploys, so they are memoised per process.
// A redeploy needs a restart — the same caveat FCC's addresses carry.
const addressCache = new Map<string, `0x${string}`>();

export async function resolveContract(name: string): Promise<`0x${string}`> {
  const hit = addressCache.get(name);
  if (hit) return hit;
  const address = (await rpc().readContract({
    address: CONTRACT_REGISTRY,
    abi: registryAbi,
    functionName: "getContractAddressByName",
    args: [name],
  })) as `0x${string}`;
  if (/^0x0{40}$/i.test(address)) throw new Error(`${name} is not registered on this network`);
  addressCache.set(name, address);
  return address;
}

export interface SmartAccountInfo {
  /** The XRPL address this was derived for. */
  xrplAccount: string;
  /** Deterministic — resolves before the account is ever deployed. */
  personalAccount: `0x${string}`;
  /** PackedUserOperation.nonce must equal this exactly. */
  nonce: string;
  /** Pinned executor, or null when none is set. */
  executor: `0x${string}` | null;
  /** Destination for a COPY: an XRPL Payment here direct-mints FXRP. */
  coreVaultXrplAddress: string;
  /** Destination for a FADE: carries the 0x02 redemption instruction. */
  operatorXrplAddress: string;
  /** Redemption is lot-granular; read, never assumed. */
  lotSizeUBA: string;
  assetMintingDecimals: number;
  /** Whole FXRP per lot, derived from the two values above. */
  lotSizeFxrp: number;
  fxrpAddress: `0x${string}`;
  masterAccountController: `0x${string}`;
  assetManager: `0x${string}`;
  /** Direct-minting fees, read live. Strings because they are UBA/bigint. */
  directMintingFeeBIPS: string;
  directMintingMinimumFeeUBA: string;
  directMintingExecutorFeeUBA: string;
}

/**
 * Everything the copy/fade ticket needs, read live.
 *
 * Returns the fee *parameters* rather than a finished Payment amount. The
 * arithmetic that turns them into a total lives in `directMintingPayment`
 * (lib/smart-accounts.ts) so it can be unit-tested, and it is derived from the
 * Dev Hub's prose rather than from a verified transaction — the UI presents it
 * as a breakdown to check, not a number to trust. A direct mint whose amount is
 * short does not bounce: it reverts on the Flare side and the XRP stays at the
 * Core Vault until a `0xE0` recovery runs.
 */
export async function getSmartAccountInfo(xrplAccount: string): Promise<SmartAccountInfo> {
  const c = rpc();
  const [mac, assetManager] = await Promise.all([
    resolveContract("MasterAccountController"),
    resolveContract("AssetManagerFXRP"),
  ]);

  const [personalAccount, providerWallets, coreVaultManager, lotSizeUBA, decimals, fxrpAddress, feeBIPS, minFeeUBA, execFeeUBA] =
    await Promise.all([
      c.readContract({ address: mac, abi: macAbi, functionName: "getPersonalAccount", args: [xrplAccount] }),
      c.readContract({ address: mac, abi: macAbi, functionName: "getXrplProviderWallets" }),
      c.readContract({ address: assetManager, abi: assetManagerAbi, functionName: "getCoreVaultManager" }),
      c.readContract({ address: assetManager, abi: assetManagerAbi, functionName: "lotSize" }),
      c.readContract({ address: assetManager, abi: assetManagerAbi, functionName: "assetMintingDecimals" }),
      c.readContract({ address: assetManager, abi: assetManagerAbi, functionName: "fAsset" }),
      c.readContract({ address: assetManager, abi: assetManagerAbi, functionName: "getDirectMintingFeeBIPS" }),
      c.readContract({ address: assetManager, abi: assetManagerAbi, functionName: "getDirectMintingMinimumFeeUBA" }),
      c.readContract({ address: assetManager, abi: assetManagerAbi, functionName: "getDirectMintingExecutorFeeUBA" }),
    ]);

  const [nonce, executor, coreVaultXrplAddress] = await Promise.all([
    c.readContract({ address: mac, abi: macAbi, functionName: "getNonce", args: [personalAccount] }),
    c.readContract({ address: mac, abi: macAbi, functionName: "getExecutor", args: [personalAccount] }),
    c.readContract({ address: coreVaultManager, abi: coreVaultAbi, functionName: "coreVaultAddress" }),
  ]);

  if (providerWallets.length === 0) throw new Error("no operator XRPL wallet is registered on this network");

  return {
    xrplAccount,
    personalAccount,
    nonce: nonce.toString(),
    executor: /^0x0{40}$/i.test(executor) ? null : executor,
    coreVaultXrplAddress,
    operatorXrplAddress: providerWallets[0],
    lotSizeUBA: lotSizeUBA.toString(),
    assetMintingDecimals: decimals,
    lotSizeFxrp: Number(lotSizeUBA) / 10 ** decimals,
    fxrpAddress,
    masterAccountController: mac,
    assetManager,
    directMintingFeeBIPS: feeBIPS.toString(),
    directMintingMinimumFeeUBA: minFeeUBA.toString(),
    directMintingExecutorFeeUBA: execFeeUBA.toString(),
  };
}
