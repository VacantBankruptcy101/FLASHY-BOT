// ethers-client.js
//
// v3: transactions to real mainnet are now signed locally and broadcast
// through a private relay (Flashbots Protect by default) instead of the
// public mempool. This is what actually closes the front-running/sandwich
// window a plain broadcast leaves open — it does NOT create profit that
// wasn't already found by dex-scanner.js.
//
// Local fork networks (development/ganache/*-fork) are untouched: private
// relays only accept real mainnet transactions, and there's no MEV to
// protect against on a private local chain anyway, so those still use a
// normal contract.method() call + tx.wait().
//
// Prereqs:
//   npm install ethers dotenv
//   ganache-cli --fork https://mainnet.infura.io/v3/$INFURA_KEY@22429499 \
//               --unlock 0xE68d531d8B4d035bf3F4BC2DaBb70f51FbB14E23
//   truffle migrate --network development   (writes deployed-addresses.json)
//
// .env additions for mainnet:
//   MAINNET_RPC_URL=https://mainnet.infura.io/v3/your_key   (reads: quotes, gas, nonce)
//   PRIVATE_RELAY_URL=https://rpc.flashbots.net              (writes: tx broadcast only)
//   DISABLE_PRIVATE_RELAY=true                                (opt out, not recommended)
//
// Usage from Node:
//   const client = require("./ethers-client");
//   const result = await client.findAndExecute("WETH", "TOKE", "10");
//   if (!result.executed) console.log(result.reason);
//   await client.withdraw("WETH", 100);
//   await client.emergencyWithdraw(["WETH", "DAI"]);

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const scanner = require("./dex-scanner");

const NETWORK_KEY = process.env.TRUFFLE_NETWORK || "development";
const TOKENS = scanner.TOKENS;

const PRIVATE_RELAY_URL = process.env.PRIVATE_RELAY_URL || "https://rpc.flashbots.net";

function isLocalNetwork(network) {
  return network.includes("development") || network.includes("ganache") || network.includes("fork");
}

// Real MEV protection only applies to real mainnet — never on a local fork.
function usesPrivateRelay(network) {
  return !isLocalNetwork(network) && process.env.DISABLE_PRIVATE_RELAY !== "true";
}

function resolveRpcUrl(network) {
  if (isLocalNetwork(network)) return process.env.GANACHE_RPC_URL || "http://127.0.0.1:8545";
  if (process.env.MAINNET_RPC_URL) return process.env.MAINNET_RPC_URL;
  if (process.env.INFURA_KEY) return `https://mainnet.infura.io/v3/${process.env.INFURA_KEY}`;
  throw new Error(`No RPC URL configured for network "${network}". Set MAINNET_RPC_URL or INFURA_KEY in .env.`);
}

// ABI for the real Flashy.sol v2. loadAbi() prefers the compiled artifact
// at build/contracts/Flashy.json (from `truffle compile`) and only falls
// back to this if that hasn't been generated yet.
const FALLBACK_ABI = [
  "function executeFlashLoan(address borrowAsset, uint256 amount, tuple(uint8 dexType, address router, address tokenOut, uint24 feeTier, uint256 minAmountOut)[] legs, uint256 minProfit) external",
  "function withdraw(address asset, uint256 percentBps) external",
  "function withdrawETH(uint256 percentBps) external",
  "function emergencyWithdraw(address[] assets) external",
  "function owner() view returns (address)",
  "event FlashLoanExecuted(address indexed borrowAsset, uint256 amount, uint256 profit, uint8 legCount, bool success)",
  "event Withdrawn(address indexed asset, address indexed to, uint256 amount)",
  "event EmergencyWithdrawn(address indexed to, uint256 ethAmount, address[] tokens)",
];

function loadAbi() {
  const artifactPath = path.join(__dirname, "build", "contracts", "Flashy.json");
  if (fs.existsSync(artifactPath)) {
    return JSON.parse(fs.readFileSync(artifactPath, "utf8")).abi;
  }
  console.warn("⚠ build/contracts/Flashy.json not found — using FALLBACK_ABI. Run `truffle compile`.");
  return FALLBACK_ABI;
}

function loadDeployment(network = NETWORK_KEY) {
  const recordPath = path.join(__dirname, "deployed-addresses.json");
  if (!fs.existsSync(recordPath)) {
    throw new Error(`No deployed-addresses.json found. Run "truffle migrate --network ${network}" first.`);
  }
  const all = JSON.parse(fs.readFileSync(recordPath, "utf8"));
  const record = all[network];
  if (!record) throw new Error(`No deployment recorded for network "${network}" in deployed-addresses.json.`);
  return record;
}

function getProvider(network = NETWORK_KEY) {
  return new ethers.JsonRpcProvider(resolveRpcUrl(network));
}

// Signer: prefer PRIVATE_KEY from .env; otherwise fall back to the first
// unlocked account (only works on a local fork — real mainnet needs a key).
async function getSigner(provider) {
  provider = provider || getProvider();
  if (process.env.PRIVATE_KEY) {
    return new ethers.Wallet(process.env.PRIVATE_KEY, provider);
  }
  const accounts = await provider.listAccounts();
  if (!accounts.length) throw new Error("No unlocked accounts available — set PRIVATE_KEY in .env for real networks.");
  return provider.getSigner(accounts[0].address ?? accounts[0]);
}

async function getContract(network = NETWORK_KEY) {
  const { address } = loadDeployment(network);
  const provider = getProvider(network);
  const signer = await getSigner(provider);
  const abi = loadAbi();
  return new ethers.Contract(address, abi, signer);
}

// ---- Private-relay-aware transaction sender ----
//
// On a local fork: identical to `await contract[method](...args); tx.wait()`.
// On real mainnet: builds the tx, signs it locally, and broadcasts ONLY to
// the private relay — it never touches the public mempool, so a searcher
// watching pending transactions never sees it before it's mined (or dropped).
async function sendTx(contract, signer, method, args, network = NETWORK_KEY) {
  if (!usesPrivateRelay(network)) {
    const tx = await contract[method](...args);
    return tx.wait();
  }

  const readProvider = signer.provider;
  const from = await signer.getAddress();
  const populated = await contract[method].populateTransaction(...args);

  const [nonce, feeData, net, gasLimit] = await Promise.all([
    readProvider.getTransactionCount(from, "pending"),
    readProvider.getFeeData(),
    readProvider.getNetwork(),
    readProvider.estimateGas({ ...populated, from }),
  ]);

  const txRequest = {
    ...populated,
    from,
    nonce,
    chainId: net.chainId,
    type: 2,
    maxFeePerGas: feeData.maxFeePerGas,
    maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
    gasLimit: (gasLimit * 120n) / 100n, // 20% buffer
  };

  const signedTx = await signer.signTransaction(txRequest);
  const relayProvider = new ethers.JsonRpcProvider(PRIVATE_RELAY_URL);

  console.log(`🔒 Submitting privately via ${PRIVATE_RELAY_URL} — not broadcast to the public mempool`);
  const txResponse = await relayProvider.broadcastTransaction(signedTx);

  // Poll for the receipt through the normal read RPC — once the relay's
  // builder includes it, it shows up there like any other mined tx.
  const receipt = await readProvider.waitForTransaction(txResponse.hash);
  return receipt;
}

// ---- Core: scan first, only execute if genuinely profitable ----

// borrowSymbol/targetSymbol: token symbols from TOKENS. amount: human units
// (e.g. "10" for 10 WETH). feeTier: used only for V3 legs found by the scan.
async function findAndExecute(borrowSymbol, targetSymbol, amount, feeTier = 3000) {
  const provider = getProvider();
  const route = await scanner.findBestRoute(provider, borrowSymbol, targetSymbol, amount, feeTier);

  if (!route.profitable) {
    console.log(`⚠ No profitable route found: ${route.reason}`);
    return { executed: false, reason: route.reason };
  }

  console.log(
    `⚡ Best route: ${route.route} — expected profit ${route.expectedProfit} ${borrowSymbol} ` +
      `(net of ~${route.estimatedGasEth} ETH gas: ${route.expectedNetProfit} ${borrowSymbol})`
  );
  if (usesPrivateRelay(NETWORK_KEY)) {
    console.log(`🔒 Real mainnet detected — this tx will be submitted privately, not to the public mempool.`);
  }

  const contract = await getContract();
  const receipt = await sendTx(
    contract,
    contract.runner,
    "executeFlashLoan",
    [TOKENS[borrowSymbol].addr, route.amountIn, route.legs, route.minProfitWei]
  );
  console.log(`✅ Mined in block ${receipt.blockNumber}: ${receipt.hash}`);
  return { executed: true, route, receipt };
}

// Lower-level: execute a specific pre-built route.
async function executeRoute(borrowSymbol, amountIn, legs, minProfitWei) {
  const contract = await getContract();
  const receipt = await sendTx(
    contract,
    contract.runner,
    "executeFlashLoan",
    [TOKENS[borrowSymbol].addr, amountIn, legs, minProfitWei]
  );
  console.log(`✅ Mined in block ${receipt.blockNumber}: ${receipt.hash}`);
  return receipt;
}

// asset: token symbol (e.g. "WETH") or "ETH" for raw ether.
async function withdraw(asset = "WETH", percent = 100) {
  const contract = await getContract();
  const bps = Math.round(percent * 100);
  const receipt =
    asset === "ETH"
      ? await sendTx(contract, contract.runner, "withdrawETH", [bps])
      : await sendTx(contract, contract.runner, "withdraw", [TOKENS[asset].addr, bps]);
  console.log(`✅ Withdraw ${percent}% of ${asset} mined: ${receipt.hash}`);
  return receipt;
}

// assetSymbols: array of token symbols to sweep, e.g. ["WETH","DAI"]. Raw ETH is always swept too.
async function emergencyWithdraw(assetSymbols = Object.keys(TOKENS)) {
  const contract = await getContract();
  const addresses = assetSymbols.map((s) => {
    const t = TOKENS[s];
    if (!t) throw new Error(`Unknown token symbol: ${s}`);
    return t.addr;
  });
  const receipt = await sendTx(contract, contract.runner, "emergencyWithdraw", [addresses]);
  console.log(`✅ Emergency withdraw mined: ${receipt.hash}`);
  return receipt;
}

async function getContractBalance() {
  const { address } = loadDeployment();
  const provider = getProvider();
  const wei = await provider.getBalance(address);
  return ethers.formatEther(wei);
}

// Subscribe to contract events and format them for a UI's transaction log.
async function watchEvents(onEvent) {
  const contract = await getContract();
  contract.on("FlashLoanExecuted", (borrowAsset, amount, profit, legCount, success, evt) => {
    onEvent({
      type: "FLASH_LOAN",
      hash: evt.log.transactionHash,
      status: success ? "success" : "reverted",
      asset: borrowAsset,
      legCount,
      amount: ethers.formatEther(amount),
      profit: ethers.formatEther(profit),
    });
  });
  contract.on("Withdrawn", (asset, to, amount, evt) => {
    onEvent({ type: "WITHDRAW", hash: evt.log.transactionHash, status: "success", asset, profit: ethers.formatEther(amount) });
  });
  contract.on("EmergencyWithdrawn", (to, ethAmount, tokens, evt) => {
    onEvent({ type: "EMERGENCY", hash: evt.log.transactionHash, status: "success", asset: "ALL", profit: ethers.formatEther(ethAmount) });
  });
  return contract;
}

module.exports = {
  TOKENS,
  getProvider,
  getSigner,
  getContract,
  loadDeployment,
  usesPrivateRelay,
  findAndExecute,
  executeRoute,
  withdraw,
  emergencyWithdraw,
  getContractBalance,
  watchEvents,
};

// Quick CLI smoke test: `node ethers-client.js`
if (require.main === module) {
  (async () => {
    try {
      const { address, network } = loadDeployment();
      console.log(`Connected to Flashy @ ${address} on "${network}" via ${resolveRpcUrl(network)}`);
      console.log(`Private relay: ${usesPrivateRelay(network) ? `ON (${PRIVATE_RELAY_URL})` : "off (local fork)"}`);
      console.log(`Contract ETH balance: ${await getContractBalance()} ETH`);
    } catch (err) {
      console.error("❌", err.message);
    }
  })();
}
