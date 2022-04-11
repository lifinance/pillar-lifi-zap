import Lifi, { ChainId, Execution, ExecutionSettings, RoutesRequest } from '@lifinance/sdk'
import { BigNumberish, ethers, constants, BigNumber } from 'ethers'
import { AccountStates, EnvNames, NetworkNames, Sdk } from 'etherspot';
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
  const polygonWallet = setupWallet(polygon.id, polygon.metamask.rpcUrls[0]);

  // Init Etherspot SDK

  const polygonSdk = new Sdk(polygonWallet, {
    networkName: NetworkNames.Matic,
  });

  await polygonSdk.computeContractAccount();

  console.log('Smart wallet address' , polygonSdk.state.accountAddress);

  // Bridge Transfer - Sends 1 USDC to Polygon
  // > get LI.FI quote for transfer
  //   - from key based wallet on Fantom
  //   - to smart contract wallet on Polygon
  const routeRequest: RoutesRequest = {
    fromChainId: fantom.id,
    fromTokenAddress: tokenFantomUSDC.address,
    fromAddress: await fantomWallet.getAddress(),
    fromAmount: ethers.utils.parseUnits('1', tokenFantomUSDC.decimals).toString(),
    toChainId: polygon.id,
    toTokenAddress: tokenPolygonUSDC.address,
    toAddress: polygonSdk.state.accountAddress,

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
  const executed = await Lifi.executeRoute(fantomWallet, route, settings)

  // > wait for transmission
  console.log('Transfer executed:', executed)

  // read how many funds have been transferred
  const tokenAmountUsdc = (await Lifi.getTokenBalance(polygonSdk.state.accountAddress, tokenPolygonUSDC))!
  const amountUsdc = ethers.utils.parseUnits(tokenAmountUsdc.amount, tokenAmountUsdc.decimals)
  const amountUsdcToMatic = ethers.utils.parseUnits('0.2', tokenPolygonUSDC.decimals).toString()
  const amountUsdcToKlima = amountUsdc.sub(amountUsdcToMatic).toString()
  console.log(`Wallet contains ${amountUsdc.toString()} USDC.`)

  // Perform Actions on destination chain
  // Batch 1:
  const quoteUsdcToMatic = await Lifi.getQuote(
    polygon.id,
    tokenPolygonUSDC.address,
    polygonSdk.state.accountAddress,
    amountUsdcToMatic,
    polygon.id,
    tokenPolygonMATIC.address,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    ['sushiswap-pol'],
  )
  console.log(quoteUsdcToMatic)
  console.log(`Swap quote ${quoteUsdcToMatic.estimate.fromAmount} USDC to ${quoteUsdcToMatic.estimate.toAmount} MATIC.`)

  const quoteUsdcToKlima = await Lifi.getQuote(
    polygon.id,
    tokenPolygonUSDC.address,
    polygonSdk.state.accountAddress,
    amountUsdcToKlima,
    polygon.id,
    tokenPolygonKLIMA.address,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    ['sushiswap-pol'],
  )
  console.log(quoteUsdcToKlima)
  console.log(`Swap quote ${quoteUsdcToKlima.estimate.fromAmount} USDC to ${quoteUsdcToKlima.estimate.toAmount} KLIMA.`)

  // Add Approve and Swap transactions to Gateway batch
  if (
      quoteUsdcToMatic.transactionRequest &&
      quoteUsdcToKlima.transactionRequest &&
      quoteUsdcToMatic.estimate.approvalAddress === quoteUsdcToKlima.estimate.approvalAddress
    ) {
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
  } else  {
    return;
  }
  
  const amountKlima = quoteUsdcToKlima.estimate.toAmount;

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
  const txTransfer = await getTransferTransaction(tokenPolygonSKLIMA.address, polygonWallet.address, amountKlima);
  await polygonSdk.batchExecuteAccountTransaction({
    to: txTransfer.to as string,
    data: txTransfer.data as string,
  });
  const gatewayBatch = await polygonSdk.estimateGatewayBatch();

  console.log(gatewayBatch);

  await polygonSdk.submitGatewayBatch();

  const tokenAmountSKlima = (await Lifi.getTokenBalance(polygonWallet.address, tokenPolygonSKLIMA))!
  const amountSKlima = ethers.utils.parseUnits(tokenAmountSKlima.amount, tokenAmountSKlima.decimals)
  console.log(`Wallet contains ${amountSKlima.toString()} sKLIMA.`)
}

run()
