import Lifi, { ChainId, Execution, ExecutionSettings, RoutesRequest } from '@lifinance/sdk'
import { ethers } from 'ethers'
import 'dotenv/config'

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


const run = async () => {
  const chains = await Lifi.getChains()
  const fantom = chains.find(chain => chain.id === ChainId.FTM)!
  const polygon = chains.find(chain => chain.id === ChainId.POL)!
  const tokenFantomUSDC = await Lifi.getToken(fantom.id, 'USDC')!
  const tokenPolygonUSDC = await Lifi.getToken(polygon.id, 'USDC')!
  const tokenPolygonMATIC = await Lifi.getToken(polygon.id, 'MATIC')!
  const tokenPolygonKLIMA = await Lifi.getToken(polygon.id, '0x4e78011Ce80ee02d2c3e649Fb657E45898257815')!

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

  // Transaction 2:
  // > TODO: approve & stake Klima tokens and let the LP tokens be sent to the key based wallet
}

run()
