import { expect } from 'chai'
import { BigNumber, Contract } from 'ethers'
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/dist/src/signer-with-address'
import { deploy, fp, bn, getSigner, impersonate, impersonateWhale, instanceAt } from '@mimic-fi/v1-helpers'

describe('BalancerStrategy - Join', function () {
  let whale: SignerWithAddress,
    whale2: SignerWithAddress,
    trader: SignerWithAddress,
    vault: Contract,
    strategy: Contract,
    dai: Contract,
    bal: Contract,
    bVault: Contract,
    bpt: Contract,
    weth: Contract,
    usdc: Contract

  const WHALE_WITH_BAL = '0x967159C42568A54D11a4761fC86a6089eD42B7ba'
  const BALANCER_VAULT = '0xBA12222222228d8Ba445958a75a0704d566BF2C8'
  const DAI = '0x6B175474E89094C44Da98b954EedeAC495271d0F'
  const POOL_ID = '0x0b09dea16768f0799065c475be02919503cb2a3500020000000000000000001a'
  const POOL_ADDRESS = '0x0b09deA16768f0799065C475bE02919503cB2a35'
  const TOKEN_INDEX = 0
  const BAL = '0xba100000625a3754423978a60c9317c58a424e3D'
  const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
  const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
  const UNISWAP_V2_ROUTER_ADDRESS = '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D'

  const MAX_UINT_256 = bn(2).pow(256).sub(1)

  const swap = async (amount: BigNumber, assetIn: Contract, assetOut: Contract) => {
    await assetIn.connect(trader).approve(bVault.address, amount)

    const singleSwap = {
      poolId: POOL_ID,
      kind: 0, //GIVEN_IN
      assetIn: assetIn.address,
      assetOut: assetOut.address,
      amount,
      userData: '0x',
    }

    const funds = {
      sender: trader.address,
      fromInternalBalance: false,
      recipient: trader.address,
      toInternalBalance: false,
    }
    const deadline = Math.floor(Date.now() / 1000) + 60 * 20

    await bVault.connect(trader).swap(singleSwap, funds, 0, deadline)
  }

  before('load signers', async () => {
    trader = await getSigner(1)
    whale = await impersonateWhale(fp(100))
    whale2 = await impersonate(WHALE_WITH_BAL, fp(100))
  })

  before('deploy vault', async () => {
    const protocolFee = fp(0.00003)
    const whitelistedStrategies: string[] = []

    const swapConnector = await deploy('UniswapConnector', [UNISWAP_V2_ROUTER_ADDRESS])

    vault = await deploy('Vault', [protocolFee, swapConnector.address, whitelistedStrategies])
  })

  before('load tokens', async () => {
    bVault = await instanceAt('IBalancerVault', BALANCER_VAULT)
    dai = await instanceAt('IERC20', DAI)
    bpt = await instanceAt('IERC20', POOL_ADDRESS)
    bal = await instanceAt('IERC20', BAL)
    weth = await instanceAt('IERC20', WETH)
    usdc = await instanceAt('IERC20', USDC)
  })

  before('deposit to Vault', async () => {
    await dai.connect(whale).approve(vault.address, fp(100))
    await vault.connect(whale).deposit(whale.address, [dai.address], [fp(100)])

    await dai.connect(whale).transfer(trader.address, fp(1000000))
  })

  before('deploy strategy', async () => {
    strategy = await deploy('BalancerStrategy', [vault.address, dai.address, bVault.address, POOL_ID, TOKEN_INDEX, bal.address, 'metadata:uri'])
  })

  it('vault has max DAI allowance', async () => {
    const allowance = await dai.allowance(strategy.address, vault.address)
    expect(allowance).to.be.equal(MAX_UINT_256)
  })

  it('join strategy', async () => {
    const amount = fp(50)

    const previousVaultBalance = await dai.balanceOf(vault.address)

    const previousStrategyBalance = await dai.balanceOf(strategy.address)
    expect(previousStrategyBalance).to.be.equal(0)

    await vault.connect(whale).join(whale.address, strategy.address, amount, '0x')

    const currentVaultBalance = await dai.balanceOf(vault.address)
    expect(currentVaultBalance).to.be.equal(previousVaultBalance.sub(amount))

    const currentStrategyBalance = await dai.balanceOf(strategy.address)
    expect(currentStrategyBalance).to.be.equal(previousStrategyBalance)

    const currentInvestment = await vault.getAccountInvestment(whale.address, strategy.address)
    expect(currentInvestment[0]).to.be.equal(amount)
    expect(currentInvestment[1].gt(0)).to.be.true

    const bptBalance = await bpt.balanceOf(strategy.address)
    const totalShares = await strategy.getTotalShares()
    expect(totalShares).to.be.equal(bptBalance)
  })

  let initialBalance: BigNumber
  before('save initial Balance', async () => {
    initialBalance = await strategy.getTokenBalance()
  })

  it('has strategy gains on swap DAI to WETH', async () => {
    //Trader swaps the pool
    const amount = fp(1000000)
    await swap(amount, dai, weth)

    const finalBalance = await strategy.getTokenBalance()
    expect(finalBalance.gt(initialBalance)).to.be.true
  })

  it('still has strategy gains on swap back WETH to DAI', async () => {
    //Trader swaps the pool
    const amount = await weth.balanceOf(trader.address)
    await swap(amount, weth, dai)

    const finalBalance = await strategy.getTokenBalance()
    expect(finalBalance.gt(initialBalance)).to.be.true
  })

  it('more gains to recover lost in single token join slipage', async () => {
    let amount: BigNumber
    for (let index = 0; index < 30; index++) {
      amount = await dai.balanceOf(trader.address)
      await swap(amount, dai, weth)
      amount = await weth.balanceOf(trader.address)
      await swap(amount, weth, dai)
    }
  })

  it('exit strategy', async () => {
    const initialAmount = fp(50)
    const initialBalance = await vault.getAccountBalance(whale.address, dai.address)

    await vault.connect(whale).exit(whale.address, strategy.address, fp(1), '0x')

    const currentBalance = await vault.getAccountBalance(whale.address, dai.address)
    const finalAmount = currentBalance.sub(initialBalance)

    expect(finalAmount.gt(initialAmount)).to.be.true

    const currentStrategyBalance = await dai.balanceOf(strategy.address)
    expect(currentStrategyBalance).to.be.equal(0)

    const currentInvestment = await vault.getAccountInvestment(whale.address, strategy.address)

    expect(currentInvestment[0]).to.be.equal(0)
    expect(currentInvestment[1]).to.be.equal(0)

    const bptBalance = await bpt.balanceOf(strategy.address)
    expect(bptBalance).to.be.equal(0)

    const totalShares = await strategy.getTotalShares()
    expect(totalShares).to.be.equal(0)
  })

  it('can give allowance to other tokens', async () => {
    await strategy.approveVault(weth.address)

    const allowance = await weth.allowance(strategy.address, vault.address)
    expect(allowance).to.be.equal(MAX_UINT_256)
  })

  it('cannot give BPT allowance to vault ', async () => {
    await expect(strategy.approveVault(bpt.address)).to.be.revertedWith('BALANCER_INTERNAL_TOKEN')
  })

  it('cannot give BAL allowance to vault ', async () => {
    await expect(strategy.approveVault(bal.address)).to.be.revertedWith('BALANCER_INTERNAL_TOKEN')
  })

  it('handle DAI airdrops', async () => {
    //airdrop 1000
    dai.connect(whale).transfer(strategy.address, fp(1000))

    //total shares = bpt
    const initialBptBalance = await bpt.balanceOf(strategy.address)
    const initialShares = await strategy.getTotalShares()

    expect(initialShares).to.be.equal(initialBptBalance)

    //invest aidrop
    await strategy.investAll()

    //total shares < bpt
    const finalBptBalance = await bpt.balanceOf(strategy.address)
    const finalShares = await strategy.getTotalShares()

    expect(initialBptBalance.lt(finalBptBalance)).to.be.true
    expect(initialShares).to.be.equal(finalShares)
  })

  it('handle USDC airdrops', async () => {
    //airdrop 1000
    usdc.connect(whale).transfer(strategy.address, fp(1000).div(bn('1e12')))

    const daiBalance = await dai.balanceOf(strategy.address)
    expect(daiBalance).to.be.equal(0)

    const initialBptBalance = await bpt.balanceOf(strategy.address)
    const initialShares = await strategy.getTotalShares()

    //invest aidrop
    await strategy.tradeAndInvest(usdc.address)

    const finalBptBalance = await bpt.balanceOf(strategy.address)
    const finalShares = await strategy.getTotalShares()

    expect(initialBptBalance.lt(finalBptBalance)).to.be.true
    expect(initialShares).to.be.equal(finalShares)
  })

  it('handle USDC airdrops + Join', async () => {
    //Make it so there are some previous shares
    await vault.connect(whale).join(whale.address, strategy.address, fp(50), '0x')

    const aidrop = fp(100000)
    const joinAmount = fp(50)

    //airdrop 1000
    usdc.connect(whale).transfer(strategy.address, aidrop.div(bn('1e12')))

    const daiBalance = await dai.balanceOf(strategy.address)
    expect(daiBalance).to.be.equal(0)

    const initialShares = await strategy.getTotalShares()

    //whale joins
    await vault.connect(whale).join(whale.address, strategy.address, joinAmount, '0x')

    //Final token balance includes 100k airdrop + joinAmount
    const finalTokenBalance = await strategy.getTokenBalance()
    const finalShares = await strategy.getTotalShares()

    const whaleSharesExpected = joinAmount.mul(initialShares).div(finalTokenBalance)
    const whaleSharesObtained = finalShares.sub(initialShares)

    //shares obtained by the whale should be close to how much dai it addd and not the airdropped one
    expect(whaleSharesExpected.sub(whaleSharesObtained).abs().lt(fp(0.0001))).to.be.true
  })

  it('handle BAL airdrops', async () => {
    //cannot test claim, so we airdrop 1000
    bal.connect(whale2).transfer(strategy.address, fp(1000))

    const daiBalance = await dai.balanceOf(strategy.address)
    expect(daiBalance).to.be.equal(0)

    const initialBptBalance = await bpt.balanceOf(strategy.address)
    const initialShares = await strategy.getTotalShares()

    //invest aidrop
    await strategy.claimAndInvest()

    const finalBptBalance = await bpt.balanceOf(strategy.address)
    const finalShares = await strategy.getTotalShares()

    expect(initialBptBalance.lt(finalBptBalance)).to.be.true
    expect(initialShares).to.be.equal(finalShares)
  })
})
