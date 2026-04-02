import { ethers } from "hardhat";

async function main() {
  console.log("Deploying EpochstreamRouter to HashKey Testnet...");
  
  const Router = await ethers.getContractFactory("EpochstreamRouter");
  const router = await Router.deploy();
  
  await router.waitForDeployment();
  
  console.log("==================================================");
  console.log(`🚀 EpochstreamRouter successfully deployed to:`);
  console.log(`contractAddress: ${await router.getAddress()}`);
  console.log("==================================================");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
