import fs from "fs";
import solc from "solc";
import { ethers } from "ethers";

function findImports(path) {
    if (path.startsWith('@openzeppelin/')) {
        return { contents: fs.readFileSync(`node_modules/${path}`, 'utf8') };
    }
    return { error: 'File not found' };
}

async function main() {
  console.log("Compiling EpochstreamRouter.sol using raw solc...");

  const sourceStr = fs.readFileSync("EpochstreamRouter.sol", "utf8");

  const input = {
    language: "Solidity",
    sources: { "EpochstreamRouter.sol": { content: sourceStr } },
    settings: { evmVersion: "cancun", outputSelection: { "*": { "*": ["*"] } } },
  };

  const output = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));
  
  if (output.errors) {
      output.errors.forEach(err => console.error(err.formattedMessage || err.message));
      if(output.errors.some(e => e.severity === 'error')) return;
  }

  const contract = output.contracts["EpochstreamRouter.sol"]["EpochstreamRouter"];
  const abi = contract.abi;
  const bytecode = contract.evm.bytecode.object;

  console.log("Compiled successfully! Deploying to HashKey Testnet...");

  const rpcUrl = "https://testnet.hsk.xyz";
  const privateKey = "0c8030724aaf1e16a575b7a3bbaaf071fc4c1f5fd1fa0e4bc67e7245171583b1";
  
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(privateKey, provider);
  
  const factory = new ethers.ContractFactory(abi, bytecode, wallet);

  const tx = await factory.deploy();
  console.log("Transaction Hash:", tx.deploymentTransaction()?.hash);
  
  const deployedContract = await tx.waitForDeployment();
  const address = await deployedContract.getAddress();
  
  console.log(`\n✅ Contract formally deployed at address: ${address}\n`);
  
  // Update Backend server.ts automatically!
  const serverPath = "../backend/server.ts";
  let serverCode = fs.readFileSync(serverPath, "utf8");
  serverCode = serverCode.replace(
      /const CONTRACT_ADDRESS = .*?;/,
      `const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS || "${address}";`
  );
  fs.writeFileSync(serverPath, serverCode);
  console.log("Updated backend/server.ts with the true contract address!");
}

main().catch(console.error);
