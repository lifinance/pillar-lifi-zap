import Lifi, { ChainId, Execution, ExecutionSettings, RoutesRequest } from '@lifinance/sdk'
import { BigNumberish, ethers } from 'ethers'
import 'dotenv/config'
import axios from 'axios'

const STAKE_KLIMA_CONTRACT_ADDRESS = '0x4D70a031Fc76DA6a9bC0C922101A05FA95c3A227'
const KLIMA_ADDRESS = '0x4e78011Ce80ee02d2c3e649Fb657E45898257815'
const sKLIMA_ADDRESS = '0xb0C22d8D350C67420f06F48936654f567C73E8C8'

const setupWallet = (chainId: number, providerUri: string) => {
  // setup wallet
  if (!process.env.MNEMONIC) {
    console.warn(
      'Please specify a MNEMONIC phrase in your environment variables: `export MNEMONIC="..."`'
    )
    throw 'STOPPED'
  }
  console.log(">> Setup Wallet")
  const provider = new ethers.providers.JsonRpcProvider(
    providerUri,
    chainId
  )
  const wallet = ethers.Wallet.fromMnemonic(process.env.MNEMONIC).connect(
    provider
  )

  return wallet
}

const getGasPrice = async (chainId: number) => {
  const map: Record<number, string> = {
    [ChainId.POL]: 'poly',
    [ChainId.FTM]: 'ftm',
  }
  const response = await axios.get(`https://owlracle.info/${map[chainId]}/gas`)
  return ethers.utils.parseUnits(response.data.speeds[2].gasPrice.toString(), 9)
}

const getSetAllowanceTransaction = async (tokenAddress: string, approvalAddress: string, amount: BigNumberish) => {
  const ERC20_ABI = [
    {
      "name": "approve",
      "inputs": [
        {
          "internalType": "address",
          "name": "spender",
          "type": "address"
        },
        {
          "internalType": "uint256",
          "name": "amount",
          "type": "uint256"
        }
      ],
      "outputs": [
        {
          "internalType": "bool",
          "name": "",
          "type": "bool"
        }
      ],
      "stateMutability": "nonpayable",
      "type": "function"
    },
    {
      "name": "allowance",
      "inputs": [
        {
          "internalType": "address",
          "name": "owner",
          "type": "address"
        },
        {
          "internalType": "address",
          "name": "spender",
          "type": "address"
        }
      ],
      "outputs": [
        {
          "internalType": "uint256",
          "name": "",
          "type": "uint256"
        }
      ],
      "stateMutability": "view",
      "type": "function"
    }
  ]

  const erc20 = new ethers.Contract(tokenAddress, ERC20_ABI)
  return erc20.populateTransaction.approve(approvalAddress, amount)
}

const getStakeKlimaTransaction = (amount: BigNumberish) => {
  const stakeKlimaABI = [{ "inputs": [{ "internalType": "address", "name": "_staking", "type": "address" }, { "internalType": "address", "name": "_KLIMA", "type": "address" }], "stateMutability": "nonpayable", "type": "constructor" }, { "inputs": [], "name": "KLIMA", "outputs": [{ "internalType": "address", "name": "", "type": "address" }], "stateMutability": "view", "type": "function" }, { "inputs": [{ "internalType": "uint256", "name": "_amount", "type": "uint256" }], "name": "stake", "outputs": [], "stateMutability": "nonpayable", "type": "function" }, { "inputs": [], "name": "staking", "outputs": [{ "internalType": "address", "name": "", "type": "address" }], "stateMutability": "view", "type": "function" }]
  const contract = new ethers.Contract(STAKE_KLIMA_CONTRACT_ADDRESS, stakeKlimaABI)
  return contract.populateTransaction.stake(amount)
}

const run = async () => {
  const chains = await Lifi.getChains()
  const fantom = chains.find(chain => chain.id === ChainId.FTM)!
  const polygon = chains.find(chain => chain.id === ChainId.POL)!
  const tokenFantomUSDC = await Lifi.getToken(fantom.id, 'USDC')!
  const tokenPolygonUSDC = await Lifi.getToken(polygon.id, 'USDC')!
  const tokenPolygonMATIC = await Lifi.getToken(polygon.id, 'MATIC')!
  const tokenPolygonKLIMA = await Lifi.getToken(polygon.id, KLIMA_ADDRESS)!
  const tokenPolygonSKLIMA = await Lifi.getToken(polygon.id, sKLIMA_ADDRESS)!

  // Setup Wallet
  const wallet = setupWallet(fantom.id, fantom.metamask.rpcUrls[0])

  // Init Etherspot SDK
  // > TODO: get future smart contract wallet address on destination chain (Polygon)
  const smartWalletPolygonAddress = await wallet.getAddress()

  // Bridge Transfer
  // > get LI.FI quote for transfer
  //   - from key based wallet on Fantom
  //   - to smart contract wallet on Polygon
  const routeRequest: RoutesRequest = {
    fromChainId: fantom.id,
    fromTokenAddress: tokenFantomUSDC.address,
    fromAddress: await wallet.getAddress(),
    fromAmount: ethers.utils.parseUnits('1', tokenFantomUSDC.decimals).toString(),
    toChainId: polygon.id,
    toTokenAddress: tokenPolygonUSDC.address,
    toAddress: smartWalletPolygonAddress,

    options: {
      bridges: {
        allow: ['connext'],
      },
    },
  }
  console.log('Request route:', routeRequest)
  const routesResponse = await Lifi.getRoutes(routeRequest)
  const route = routesResponse.routes[0]!

  // > execute quote
  const settings: ExecutionSettings = {
    updateCallback: (updatedRoute) => {
      let lastExecution: Execution | undefined = undefined
      for (const step of updatedRoute.steps) {
        if (step.execution) {
          lastExecution = step.execution
        }
      }
      console.log(lastExecution)
    },
  }

  console.log('Execute quote:', route)
  const executed = await Lifi.executeRoute(wallet, route, settings)

  // > wait for transmission
  console.log('Transfer executed:', executed)

  // read how many funds have been transferred
  const tokenAmountUsdc = (await Lifi.getTokenBalance(smartWalletPolygonAddress, tokenPolygonUSDC))!
  const amountUsdc = ethers.utils.parseUnits(tokenAmountUsdc.amount, tokenAmountUsdc.decimals)
  const amountUsdcToMatic = ethers.utils.parseUnits('0.2', tokenPolygonUSDC.decimals).toString()
  const amountUsdcToKlima = amountUsdc.sub(amountUsdcToMatic).toString()
  console.log(`Wallet contains ${amountUsdc.toString()} USDC.`)

  // Perform Actions on destination chain
  // > TODO: pre-fund smart wallet

  // Batch 1:
  // > TODO: create smart contract wallet
  // > TODO: approve & swap some tokens to gas (get quote from LI.FI)
  const quoteUsdcToMatic = await Lifi.getQuote(
    polygon.id,
    tokenPolygonUSDC.address,
    smartWalletPolygonAddress,
    amountUsdcToMatic,
    polygon.id,
    tokenPolygonMATIC.address
  )
  console.log(quoteUsdcToMatic)
  console.log(`Swap quote ${quoteUsdcToMatic.estimate.fromAmount} USDC to ${quoteUsdcToMatic.estimate.toAmount} MATIC.`)

  // > TODO: approve & swap remaining tokens to Klima (get quote from LI.FI)
  const quoteUsdcToKlima = await Lifi.getQuote(
    polygon.id,
    tokenPolygonUSDC.address,
    smartWalletPolygonAddress,
    amountUsdcToKlima,
    polygon.id,
    tokenPolygonMATIC.address
  )
  console.log(quoteUsdcToKlima)
  console.log(`Swap quote ${quoteUsdcToKlima.estimate.fromAmount} USDC to ${quoteUsdcToKlima.estimate.toAmount} KLIMA.`)

  // TODO: (relayer uses the swapped gas to pay for transaction, pay back pre-fund)

  // read how many Klima tokens are in the smart contract wallet
  const tokenAmountKlima = (await Lifi.getTokenBalance(smartWalletPolygonAddress, tokenPolygonKLIMA))!
  const amountKlima = ethers.utils.parseUnits(tokenAmountKlima.amount, tokenAmountKlima.decimals)
  console.log(`Wallet contains ${amountKlima.toString()} KLIMA.`)
  const walletPolygon = setupWallet(polygon.id, polygon.metamask.rpcUrls[0])

  // DEBUG:
  const gasPrice = await getGasPrice(ChainId.POL)
  console.log(`Current gas price is ${gasPrice.toString()}`)

  // Transaction 2:
  // > TODO: approve KLIMA tokens
  // approve KLIMA: e.g. https://polygonscan.com/tx/0xb1aca780869956f7a79d9915ff58fd47acbaf9b34f0eb13f9b18d1772f1abef2
  console.log('Approve KLIMA')
  const txAllow = await getSetAllowanceTransaction(tokenPolygonKLIMA.address, STAKE_KLIMA_CONTRACT_ADDRESS, amountKlima)

  // DEBUG:
  txAllow.gasPrice = gasPrice
  const txAllowResponse = await walletPolygon.sendTransaction(txAllow)
  console.log(txAllowResponse)
  const txAllowReceipt = await txAllowResponse.wait()
  console.log(txAllowReceipt)

  // > TODO: stake Klima tokens (sender received sKLIMA tokens 1:1)
  // stake KLIMA: e.g. https://polygonscan.com/tx/0x5c392aa3487a1fa9e617c5697fe050d9d85930a44508ce74c90caf1bd36264bf
  console.log('Stake KLIMA')
  const txStake = await getStakeKlimaTransaction(amountKlima)

  // DEBUG:
  txStake.gasPrice = gasPrice
  const txStakeResponse = await walletPolygon.sendTransaction(txStake)
  console.log(txStakeResponse)
  const txStakeReceipt = await txStakeResponse.wait()
  console.log(txStakeReceipt)

  // > TODO: send sKLIMA token to Key Based Wallet
  console.log('Send sKLIMA')
  const tokenAmountSKlima = (await Lifi.getTokenBalance(smartWalletPolygonAddress, tokenPolygonSKLIMA))!
  const amountSKlima = ethers.utils.parseUnits(tokenAmountSKlima.amount, tokenAmountSKlima.decimals)
  console.log(`Wallet contains ${amountSKlima.toString()} sKLIMA.`)
}

run()
