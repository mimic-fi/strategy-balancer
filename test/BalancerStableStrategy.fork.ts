import {
  advanceTime,
  assertEvent,
  bn,
  deploy,
  fp,
  getSigners,
  impersonate,
  instanceAt,
  MAX_UINT256,
  MONTH,
} from '@mimic-fi/v1-helpers'
import { encodeSlippage } from '@mimic-fi/v1-portfolios/dist/helpers/encoding'
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/dist/src/signer-with-address'
import { expect } from 'chai'
import { BigNumber, Contract } from 'ethers'

/* eslint-disable no-secrets/no-secrets */

const BAL = '0xba100000625a3754423978a60c9317c58a424e3d'
const LDO = '0x5A98FcBEA516Cf06857215779Fd812CA3beF1B32'
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const WSTETH = '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0'
const WHALE_WITH_WETH = '0x4a18a50a8328b42773268B4b436254056b7d70CE'

const GAUGE_ADDER = '0xed5ba579bb5d516263ff6e1c10fcac1040075fe2'
const BALANCER_VAULT = '0xBA12222222228d8Ba445958a75a0704d566BF2C8'
const BALANCER_MINTER = '0x239e55F427D44C3cc793f49bFB507ebe76638a2b'

const POOL_BAL_WETH_ID = '0x5c6ee304399dbdb9c8ef030ab642b10820db8f56000200000000000000000014'
const POOL_LDO_WETH_ID = '0xbf96189eee9357a95c7719f4f5047f76bde804e5000200000000000000000087'
const POOL_wstETH_ETH_ID = '0x32296969ef14eb0c6d29669c550d4a0449130230000200000000000000000080'

const UNISWAP_V2_ROUTER = '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D'
const UNISWAP_V3_ROUTER = '0xE592427A0AEce92De3Edee1F18E0157C05861564'
const BALANCER_V2_VAULT = '0xBA12222222228d8Ba445958a75a0704d566BF2C8'

const CHAINLINK_ORACLE_BAL_ETH = '0xc1438aa3823a6ba0c159cfa8d98df5a994ba120b'
const CHAINLINK_ORACLE_LDO_ETH = '0x4e844125952d32acdf339be976c98e22f6f318db'
const PRICE_ONE_ORACLE = '0x1111111111111111111111111111111111111111'

describe('BalancerStableStrategy - WETH/wstETH', function () {
  let vault: Contract, strategy: Contract
  let owner: SignerWithAddress, whale: SignerWithAddress, trader: SignerWithAddress
  let balancerVault: Contract, pool: Contract, gauge: Contract, weth: Contract, wstEth: Contract, ldo: Contract

  const SLIPPAGE = fp(0.03)
  const JOIN_AMOUNT = fp(50)

  const expectWithError = (actual: BigNumber, expected: BigNumber) => {
    expect(actual).to.be.at.least(bn(expected).sub(1))
    expect(actual).to.be.at.most(bn(expected).add(1))
  }

  before('load signers', async () => {
    // eslint-disable-next-line prettier/prettier
    [owner, trader] = await getSigners(2)
    owner = await impersonate(owner.address, fp(100))
    whale = await impersonate(WHALE_WITH_WETH, fp(100))
  })

  before('deploy vault', async () => {
    const maxSlippage = fp(0.02)
    const protocolFee = fp(0.00003)
    const whitelistedTokens: string[] = []
    const whitelistedStrategies: string[] = []
    const priceOracleTokens: string[] = [BAL, LDO, WETH, WSTETH]
    const priceOracleFeeds: string[] = [
      CHAINLINK_ORACLE_BAL_ETH,
      CHAINLINK_ORACLE_LDO_ETH,
      PRICE_ONE_ORACLE,
      PRICE_ONE_ORACLE,
    ]

    const priceOracle = await deploy(
      '@mimic-fi/v1-chainlink-price-oracle/artifacts/contracts/ChainLinkPriceOracle.sol/ChainLinkPriceOracle',
      [priceOracleTokens, priceOracleFeeds]
    )

    const swapConnector = await deploy(
      '@mimic-fi/v1-swap-connector/artifacts/contracts/SwapConnector.sol/SwapConnector',
      [priceOracle.address, UNISWAP_V3_ROUTER, UNISWAP_V2_ROUTER, BALANCER_V2_VAULT]
    )

    await swapConnector.setBalancerV2Path([BAL, WETH], [POOL_BAL_WETH_ID])
    await swapConnector.setBalancerV2Path([LDO, WETH], [POOL_LDO_WETH_ID])

    vault = await deploy('@mimic-fi/v1-vault/artifacts/contracts/Vault.sol/Vault', [
      maxSlippage,
      protocolFee,
      priceOracle.address,
      swapConnector.address,
      whitelistedTokens,
      whitelistedStrategies,
    ])
  })

  before('deploy strategy', async () => {
    const factory = await deploy('BalancerStableStrategyFactory', [
      vault.address,
      BALANCER_VAULT,
      BALANCER_MINTER,
      GAUGE_ADDER,
    ])
    const createTx = await factory.connect(owner).create(WETH, POOL_wstETH_ETH_ID, SLIPPAGE, 'metadata')
    const { args } = await assertEvent(createTx, 'StrategyCreated')
    strategy = await instanceAt('BalancerWeightedStrategy', args.strategy)
  })

  before('load dependencies', async () => {
    ldo = await instanceAt('IERC20', LDO)
    weth = await instanceAt('IERC20', WETH)
    wstEth = await instanceAt('IERC20', WSTETH)
    pool = await instanceAt('IBalancerPool', await strategy.getPool())
    gauge = await instanceAt('ILiquidityGauge', await strategy.getGauge())
    balancerVault = await instanceAt('IBalancerVault', BALANCER_VAULT)
  })

  before('deposit tokens', async () => {
    await weth.connect(whale).approve(vault.address, fp(100))
    await vault.connect(whale).deposit(whale.address, weth.address, fp(100), '0x')
  })

  it('has the correct owner', async () => {
    expect(await strategy.owner()).to.be.equal(owner.address)
  })

  it('sets metadata', async () => {
    await strategy.connect(owner).setMetadataURI('metadata:uri:2.0')
    expect(await strategy.getMetadataURI()).to.be.equal('metadata:uri:2.0')
  })

  it('joins strategy', async () => {
    const previousVaultBalance = await weth.balanceOf(vault.address)
    expect(previousVaultBalance).to.be.equal(fp(100))

    const previousStrategyBalance = await weth.balanceOf(strategy.address)
    expect(previousStrategyBalance).to.be.equal(0)

    const encodedSlippage = encodeSlippage(fp(0.01))
    await vault.connect(whale).join(whale.address, strategy.address, JOIN_AMOUNT, encodedSlippage)

    const currentVaultBalance = await weth.balanceOf(vault.address)
    expect(currentVaultBalance).to.be.equal(previousVaultBalance.sub(JOIN_AMOUNT))

    const currentStrategyBalance = await weth.balanceOf(strategy.address)
    expect(currentStrategyBalance).to.be.equal(previousStrategyBalance)

    const strategyBptBalance = await pool.balanceOf(strategy.address)
    expect(strategyBptBalance).to.be.equal(0)

    const rate = await pool.getRate()
    const stakedBptBalance = await gauge.balanceOf(strategy.address)
    const expectedValue = stakedBptBalance.mul(rate).div(fp(1))

    const { invested, shares } = await vault.getAccountInvestment(whale.address, strategy.address)
    expectWithError(invested, expectedValue)
    expectWithError(shares, expectedValue)

    const strategyShares = await vault.getStrategyShares(strategy.address)
    expect(strategyShares).to.be.equal(shares)

    const strategyShareValue = await vault.getStrategyShareValue(strategy.address)
    const accountValue = await vault.getAccountCurrentValue(whale.address, strategy.address)
    expectWithError(accountValue, strategyShares.mul(strategyShareValue).div(fp(1)))
  })

  it('accrues BAL and LDO earnings over time', async () => {
    const initialBalEarnings = await gauge.claimable_tokens(strategy.address)
    expect(initialBalEarnings).to.be.lt(100)

    const initialLdoEarnings = await gauge.claimable_reward(strategy.address, ldo.address)
    expect(initialLdoEarnings).to.be.lt(100)

    await advanceTime(MONTH)

    const currentBalEarnings = await gauge.claimable_tokens(strategy.address)
    expect(currentBalEarnings).to.be.gt(initialBalEarnings)

    const currentLdoEarnings = await gauge.claimable_reward(strategy.address, ldo.address)
    expect(currentLdoEarnings).to.be.gt(initialLdoEarnings)
  })

  it('gains swap fees from another trader account', async () => {
    const swap = async (from: SignerWithAddress, amount: BigNumber, assetIn: Contract, assetOut: Contract) => {
      await assetIn.connect(from).approve(balancerVault.address, amount)

      const singleSwap = {
        poolId: POOL_wstETH_ETH_ID,
        kind: 0, //GIVEN_IN
        assetIn: assetIn.address,
        assetOut: assetOut.address,
        amount,
        userData: '0x',
      }

      const funds = {
        sender: from.address,
        fromInternalBalance: false,
        recipient: from.address,
        toInternalBalance: false,
      }

      await balancerVault.connect(from).swap(singleSwap, funds, 0, MAX_UINT256)
    }

    await weth.connect(whale).transfer(trader.address, fp(1000))
    const previousValue = await vault.getAccountCurrentValue(whale.address, strategy.address)

    let amount: BigNumber
    for (let index = 0; index < 100; index++) {
      amount = fp(100)
      await swap(trader, amount, weth, wstEth)
      amount = await wstEth.balanceOf(trader.address)
      await swap(trader, amount, wstEth, weth)
    }

    const currentValue = await vault.getAccountCurrentValue(whale.address, strategy.address)
    expect(currentValue).to.be.gt(previousValue)
  })

  it('exits with a 50%', async () => {
    const previousBalance = await vault.getAccountBalance(whale.address, weth.address)
    const previousInvestment = await vault.getAccountInvestment(whale.address, strategy.address)

    const exitRatio = fp(0.5)
    const encodedSlippage = encodeSlippage(fp(0.02))
    await vault.connect(whale).exit(whale.address, strategy.address, exitRatio, false, encodedSlippage)

    // The user should at least have some gains
    const currentBalance = await vault.getAccountBalance(whale.address, weth.address)
    const minExpectedBalance = JOIN_AMOUNT.mul(exitRatio).div(fp(1))
    expect(currentBalance.sub(previousBalance)).to.be.gt(minExpectedBalance)

    // There should not be any remaining tokens in the strategy
    const strategyWethBalance = await weth.balanceOf(strategy.address)
    expect(strategyWethBalance).to.be.equal(0)

    const rate = await pool.getRate()
    const currentStakedBptBalance = await gauge.balanceOf(strategy.address)
    const expectedValue = currentStakedBptBalance.mul(rate).div(fp(1))
    const currentInvestment = await vault.getAccountInvestment(whale.address, strategy.address)
    expectWithError(currentInvestment.invested, expectedValue)

    const strategyShares = await vault.getStrategyShares(strategy.address)
    expectWithError(currentInvestment.shares, strategyShares)
    expectWithError(currentInvestment.shares, previousInvestment.shares.mul(exitRatio).div(fp(1)))

    // TODO: Review rounding issue
    const accountValue = await vault.getAccountCurrentValue(whale.address, strategy.address)
    const strategyShareValue = await vault.getStrategyShareValue(strategy.address)
    const expectedAccountValue = strategyShares.mul(strategyShareValue).div(fp(1))
    expect(accountValue).to.be.at.least(bn(expectedAccountValue).sub(50))
    expect(accountValue).to.be.at.most(bn(expectedAccountValue).add(50))

    // No rounding issues
    const totalValue = await strategy.getTotalValue()
    const strategyShareValueScaled = totalValue.mul(bn(1e36)).div(strategyShares)
    expectWithError(accountValue, strategyShares.mul(strategyShareValueScaled).div(bn(1e36)))
  })

  it('handles WETH airdrops', async () => {
    const previousValue = await vault.getAccountCurrentValue(whale.address, strategy.address)

    // Airdrop 1000 wETH and invest
    weth.connect(trader).transfer(strategy.address, fp(100))
    await strategy.invest(weth.address, SLIPPAGE)

    const currentValue = await vault.getAccountCurrentValue(whale.address, strategy.address)
    expect(currentValue).to.be.gt(previousValue)
  })

  it('exits with a 100%', async () => {
    const previousBalance = await vault.getAccountBalance(whale.address, weth.address)

    const exitRatio = fp(1)
    const encodedSlippage = encodeSlippage(fp(0.02))
    await vault.connect(whale).exit(whale.address, strategy.address, exitRatio, false, encodedSlippage)

    // The user should at least have some gains
    const currentBalance = await vault.getAccountBalance(whale.address, weth.address)
    const minExpectedBalance = JOIN_AMOUNT.mul(exitRatio).div(fp(1))
    expect(currentBalance.sub(previousBalance)).to.be.gt(minExpectedBalance)

    // There should not be any remaining tokens in the strategy
    const strategyWethBalance = await weth.balanceOf(strategy.address)
    expect(strategyWethBalance).to.be.equal(0)

    const currentInvestment = await vault.getAccountInvestment(whale.address, strategy.address)
    expectWithError(currentInvestment.invested, bn(0))
    expectWithError(currentInvestment.shares, bn(0))

    const strategyShares = await vault.getStrategyShares(strategy.address)
    expectWithError(strategyShares, bn(0))

    const accountValue = await vault.getAccountCurrentValue(whale.address, strategy.address)
    expectWithError(accountValue, bn(0))
  })
})
