import Lifi, { Chain, ChainId, ExchangeTool, Execution, ExecutionSettings, RoutesRequest, Token } from '@lifinance/sdk'
import { BigNumberish, ethers, BigNumber, Signer } from 'ethers'
import { NetworkNames, Sdk } from 'etherspot';
import 'dotenv/config'
import axios from 'axios'

import {
  erc20Abi,
  stakeKlimaAbi,
  STAKE_KLIMA_CONTRACT_ADDRESS,
  KLIMA_ADDRESS,
  sKLIMA_ADDRESS,
} from './constants';

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
  const erc20 = new ethers.Contract(tokenAddress, erc20Abi)
  return erc20.populateTransaction.approve(approvalAddress, amount)
}

const getTransferTransaction = async (tokenAddress: string, toAddress: string, amount: BigNumberish) => {
  const erc20 = new ethers.Contract(tokenAddress, erc20Abi)
  return erc20.populateTransaction.transfer(toAddress, amount)
}

const getStakeKlimaTransaction = (amount: BigNumberish) => {
  const contract = new ethers.Contract(STAKE_KLIMA_CONTRACT_ADDRESS, stakeKlimaAbi)
  return contract.populateTransaction.stake(amount)
}

const executeBridgeTransfer = async (fromWallet: Signer, fromChain: Chain, fromToken: Token, fromAmount: string, toChain: Chain, toToken: Token, toAddress: string) => {
  // > get LI.FI quote for transfer
  //   - from key based wallet on Fantom
  //   - to smart contract wallet on Polygon
  const routeRequest: RoutesRequest = {
    fromChainId: fromChain.id,
    fromTokenAddress: fromToken.address,
    fromAddress: await fromWallet.getAddress(),
    fromAmount: fromAmount,
    toChainId: toChain.id,
    toTokenAddress: toToken.address,
    toAddress: toAddress,

    options: {
      integrator: 'lifi-pillar',
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
  const executed = await Lifi.executeRoute(fromWallet, route, settings)

  // > wait for transmission
  console.log('Transfer executed:', executed)
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
  const fantomWallet = setupWallet(fantom.id, fantom.metamask.rpcUrls[0]);
  // Not needed, we handle everything from the fantom wallet
  // const polygonWallet = setupWallet(polygon.id, polygon.metamask.rpcUrls[0]);
  // We use the same wallet address as on fantom
  const polygonWalletAddress = await fantomWallet.getAddress()

  // Init Etherspot SDK
  const polygonSdk = new Sdk(fantomWallet, {
    networkName: NetworkNames.Matic,
  });

  await polygonSdk.computeContractAccount({
    sync: false,
  });

  console.log('Smart wallet address', polygonSdk.state.accountAddress);

  // Bridge Transfer - Sends 1 USDC to Polygon
  const amount = ethers.utils.parseUnits('1', tokenFantomUSDC.decimals).toString();
  const recipient = polygonSdk.state.accountAddress;
  await executeBridgeTransfer(fantomWallet, fantom, tokenFantomUSDC, amount, polygon, tokenPolygonUSDC, recipient);

  // read how many funds have been transferred
  const tokenAmountUsdc = (await Lifi.getTokenBalance(polygonSdk.state.accountAddress, tokenPolygonUSDC))!
  const amountUsdc = ethers.utils.parseUnits(tokenAmountUsdc.amount, tokenAmountUsdc.decimals)
  const amountUsdcToMatic = ethers.utils.parseUnits('0.2', tokenPolygonUSDC.decimals).toString()
  const maxAmountUsdc = ethers.utils.parseUnits('1', tokenPolygonUSDC.decimals) // just for testing
  const diffAmountUsdc = amountUsdc.sub(amountUsdcToMatic)
  const amountUsdcToKlima = maxAmountUsdc.lt(diffAmountUsdc) ? maxAmountUsdc : diffAmountUsdc
  console.log(`Wallet contains ${amountUsdc.toString()} USDC.`)

  // Perform Actions on destination chain
  // Batch 1:
  const allowedDex = ExchangeTool.paraswap
  const quoteUsdcToMatic = await Lifi.getQuote(
    polygon.id,
    tokenPolygonUSDC.address,
    polygonSdk.state.accountAddress,
    amountUsdcToMatic,
    polygon.id,
    tokenPolygonMATIC.address,
    undefined,
    0.003,
    'lifi-pillar',
    undefined,
    undefined,
    undefined,
    undefined,
    [allowedDex],
  )
  console.log(quoteUsdcToMatic)
  console.log(`Swap quote ${quoteUsdcToMatic.estimate.fromAmount} USDC to ${quoteUsdcToMatic.estimate.toAmountMin} MATIC.`)

  const quoteUsdcToKlima = await Lifi.getQuote(
    polygon.id,
    tokenPolygonUSDC.address,
    polygonSdk.state.accountAddress,
    amountUsdcToKlima.toString(),
    polygon.id,
    tokenPolygonKLIMA.address,
    undefined,
    0.003,
    'lifi-pillar',
    undefined,
    undefined,
    undefined,
    undefined,
    [allowedDex],
  )
  console.log(quoteUsdcToKlima)
  console.log(`Swap quote ${quoteUsdcToKlima.estimate.fromAmount} USDC to ${quoteUsdcToKlima.estimate.toAmountMin} KLIMA.`)

  // Validate swap data
  if (
      !quoteUsdcToMatic.transactionRequest ||
      !quoteUsdcToKlima.transactionRequest ||
      quoteUsdcToMatic.estimate.approvalAddress !== quoteUsdcToKlima.estimate.approvalAddress
    ) {
    throw 'Swaps validation failed';
  }
  
  // Add Approve and Swap transactions to Gateway batch
  // Approve
  const totalAmount = BigNumber.from(quoteUsdcToMatic.estimate.fromAmount).add(quoteUsdcToKlima.estimate.fromAmount)
  const txAllowTotal = await getSetAllowanceTransaction(
    tokenPolygonUSDC.address,
    quoteUsdcToMatic.estimate.approvalAddress as string,
    totalAmount,
  );

  await polygonSdk.batchExecuteAccountTransaction({
    to: txAllowTotal.to as string,
    data: txAllowTotal.data as string,
  });

  // Swap
  await polygonSdk.batchExecuteAccountTransaction({
    to: quoteUsdcToMatic.transactionRequest.to as string,
    data: quoteUsdcToMatic.transactionRequest.data as string,
  });

  await polygonSdk.batchExecuteAccountTransaction({
    to: quoteUsdcToKlima.transactionRequest.to as string,
    data: quoteUsdcToKlima.transactionRequest.data as string,
  });
  
  const amountKlima = quoteUsdcToKlima.estimate.toAmountMin;

  // approve KLIMA: e.g. https://polygonscan.com/tx/0xb1aca780869956f7a79d9915ff58fd47acbaf9b34f0eb13f9b18d1772f1abef2
  console.log('Approve KLIMA')
  const txAllow = await getSetAllowanceTransaction(tokenPolygonKLIMA.address, STAKE_KLIMA_CONTRACT_ADDRESS, amountKlima)
  await polygonSdk.batchExecuteAccountTransaction({
    to: txAllow.to as string,
    data: txAllow.data as string,
  });

  // stake KLIMA: e.g. https://polygonscan.com/tx/0x5c392aa3487a1fa9e617c5697fe050d9d85930a44508ce74c90caf1bd36264bf
  console.log('Stake KLIMA')
  const txStake = await getStakeKlimaTransaction(amountKlima)
  await polygonSdk.batchExecuteAccountTransaction({
    to: txStake.to as string,
    data: txStake.data as string,
  })

  console.log('Send sKLIMA')
  const txTransfer = await getTransferTransaction(tokenPolygonSKLIMA.address, polygonWalletAddress, amountKlima);
  await polygonSdk.batchExecuteAccountTransaction({
    to: txTransfer.to as string,
    data: txTransfer.data as string,
  });

  const gatewayBatch = await polygonSdk.estimateGatewayBatch();

  const enoughMATIC = BigNumber.from(quoteUsdcToMatic.estimate.toAmountMin).gte(gatewayBatch.estimation.feeAmount);
  if (!enoughMATIC) {
    throw 'MATIC amount to be swapped would be too low to cover fees';
  }
  console.log(gatewayBatch);

  let batch = await polygonSdk.submitGatewayBatch();
  console.log('gateway submitted batch', batch);

  console.log('Waiting for batch execution')
  // info: batch.state seams to wait for a lot of confirmations (6 minutes) before changing to 'Sent'
  let isDone = !!(batch.transaction && batch.transaction.hash)
  while (!isDone) {
    console.log('check batch execution')
    batch = await polygonSdk.getGatewaySubmittedBatch({
      hash: batch.hash,
    })

    isDone = !!(batch.transaction && batch.transaction.hash)
    if (!isDone) {
      await new Promise((resolve) => {
        setTimeout(resolve, 1000)
      })
    }
  }
  console.log('gateway executed batch', batch.transaction.hash, batch);

  const tokenAmountSKlima = (await Lifi.getTokenBalance(polygonWalletAddress, tokenPolygonSKLIMA))!
  const amountSKlima = ethers.utils.parseUnits(tokenAmountSKlima.amount, tokenAmountSKlima.decimals)
  console.log(`Wallet contains ${amountSKlima.toString()} sKLIMA.`)
}

run()
