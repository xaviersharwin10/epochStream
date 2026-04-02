import "@nomicfoundation/hardhat-ethers";
import "dotenv/config";

export default {
  solidity: "0.8.24",
  networks: {
    hashkey: {
      type: "http",
      url: "https://testnet.hsk.xyz",
      chainId: 133,
      accounts: ["0c8030724aaf1e16a575b7a3bbaaf071fc4c1f5fd1fa0e4bc67e7245171583b1"]
    }
  }
};
