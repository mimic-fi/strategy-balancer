// SPDX-License-Identifier: GPL-3.0-or-later
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.

// You should have received a copy of the GNU General Public License
// along with this program.  If not, see <http://www.gnu.org/licenses/>.

pragma solidity ^0.8.0;

import '@openzeppelin/contracts/utils/math/SafeCast.sol';

import './BalancerStableStrategy.sol';

/**
 * @title BalancerBoostedStrategy
 * @dev This strategy provides liquidity in Balancer boosted pools through batch swaps.
 */
contract BalancerBoostedStrategy is BalancerStrategy {
    using FixedPoint for uint256;

    // Index of the strategy token to be used in swaps
    uint256 private constant TOKEN_INDEX = 0;

    // Index of the linear BPT token to be used in swaps
    uint256 private constant LINEAR_BPT_INDEX = 1;

    // Index of the BPT token to be used in swaps
    uint256 private constant BPT_INDEX = 2;

    // Balancer V2's internal identifier for the Balancer linear pool
    bytes32 internal immutable _linearPoolId;

    // Address of the Balancer linear pool contract associated to the strategy
    IERC20 internal immutable _linearPool;

    /**
     * @dev Initializes the Balancer strategy contract
     * @param vault Protocol vault reference
     * @param balancerVault Balancer V2 Vault reference
     * @param balancerMinter Balancer Minter reference
     * @param token Token to be used as the strategy entry point
     * @param poolId Id of the Balancer pool to create the strategy for
     * @param gauge Address of the gauge associated to the pool to be used
     * @param gaugeType Type of the gauges created by the associated factory: liquidity or rewards only
     * @param slippage Slippage value to be used in order to swap rewards
     * @param metadataURI Metadata URI associated to the strategy
     */
    constructor(
        IVault vault,
        IBalancerVault balancerVault,
        IBalancerMinter balancerMinter,
        IERC20 token,
        bytes32 poolId,
        bytes32 linearPoolId,
        IGauge gauge,
        IGauge.Type gaugeType,
        uint256 slippage,
        string memory metadataURI
    ) BalancerStrategy(vault, balancerVault, balancerMinter, token, poolId, gauge, gaugeType, slippage, metadataURI) {
        _linearPoolId = linearPoolId;
        (address linearPoolAddress, ) = balancerVault.getPool(linearPoolId);
        _linearPool = IERC20(linearPoolAddress);
    }

    /**
     * @dev Tells the address of the Balancer linear pool associated to the strategy
     */
    function getLinearPool() external view returns (address) {
        return address(_linearPool);
    }

    /**
     * @dev Tells the ID of the Balancer linear pool associated to the strategy
     */
    function getLinearPoolId() external view returns (bytes32) {
        return _linearPoolId;
    }

    /**
     * @dev Tells the exchange rate for a BPT expressed in the strategy token. Since here we are working with stable
     *      pools, it can be simply computed using the pool rate.
     */
    function getTokenPerBptPrice() public view override returns (uint256) {
        uint256 rate = IBalancerPool(address(_pool)).getRate();
        return rate / _tokenScale;
    }

    /**
     * @dev Internal function to join the Balancer boosted pool, a batch swap must be used
     * @param amount Amount of strategy tokens to invest
     * @param slippage Slippage to be used to join the Balancer pool
     */
    function _joinBalancer(uint256 amount, uint256 slippage) internal override returns (uint256 bptBalance) {
        if (amount == 0) return 0;

        // Estimate how much BPT the strategy will get after joining with `amount` tokens
        uint256 minimumBpt = _getMinAmountOut(_token, _pool, amount, slippage);

        // Build the Balancer join data using the strategy token as the only entry point, which will result in
        // a batch-swap, and ask the minimum BPT based on what was estimated right before
        address[] memory assets = _buildAssetsParam();
        int256[] memory limits = new int256[](3);
        limits[TOKEN_INDEX] = SafeCast.toInt256(amount);
        limits[BPT_INDEX] = -SafeCast.toInt256(minimumBpt);
        IBalancerVault.FundManagement memory funds = _buildFundsParam();
        IBalancerVault.BatchSwapStep[] memory swaps = _buildBatchSwapStepsParam(
            amount,
            _linearPoolId,
            _poolId,
            TOKEN_INDEX,
            LINEAR_BPT_INDEX,
            BPT_INDEX
        );

        // Approve tokens and join the Balancer pool
        _token.approve(address(_balancerVault), amount);
        _balancerVault.batchSwap(IBalancerVault.SwapKind.GIVEN_IN, swaps, assets, funds, limits, block.timestamp);

        // Approve and stake the total BPT in the corresponding gauge
        bptBalance = _pool.balanceOf(address(this));
        _pool.approve(address(_gauge), bptBalance);
        _gauge.deposit(bptBalance);
    }

    /**
     * @dev Internal function to exit the Balancer pool, a batch swap must be used
     * @param ratio Ratio of the invested position to exit
     * @param slippage Slippage to be used to exit the Balancer pool
     */
    function _exitBalancer(uint256 ratio, uint256 slippage)
        internal
        override
        returns (uint256 tokenBalance, uint256 bptAmount, uint256 bptBalance)
    {
        // Compute the amount of BPT to exit from the Balancer pool based on the given ratio and unstake it from the gauge
        uint256 initialStakedBptBalance = _gauge.balanceOf(address(this));
        bptAmount = SafeMath.div(initialStakedBptBalance.mulDown(ratio), VAULT_EXIT_RATIO_PRECISION);
        _gauge.withdraw(bptAmount);

        // Estimate the expected amount out Compute the amount of BPT to exit from the Balancer pool based on the given ratio
        // The user is exiting the requested ratio, no other investments are affected
        uint256 minAmount = _getMinAmountOut(_pool, _token, bptAmount, slippage);

        // Build the Balancer exit data using the strategy token as the only entry point, which will result in
        // an batchSwap, and ask the minimum amount out based on what was estimated right before
        address[] memory assets = _buildAssetsParam();
        int256[] memory limits = new int256[](3);
        limits[TOKEN_INDEX] = -SafeCast.toInt256(minAmount);
        limits[BPT_INDEX] = SafeCast.toInt256(bptAmount);
        IBalancerVault.FundManagement memory funds = _buildFundsParam();
        IBalancerVault.BatchSwapStep[] memory swaps = _buildBatchSwapStepsParam(
            bptAmount,
            _poolId,
            _linearPoolId,
            BPT_INDEX,
            LINEAR_BPT_INDEX,
            TOKEN_INDEX
        );

        // Exit Balancer pool
        _balancerVault.batchSwap(IBalancerVault.SwapKind.GIVEN_IN, swaps, assets, funds, limits, block.timestamp);
        tokenBalance = _token.balanceOf(address(this));
        bptBalance = initialStakedBptBalance.sub(bptAmount);
    }

    /**
     * @dev Internal method in order to build the funds params to be used in batch swaps
     */
    function _buildFundsParam() private view returns (IBalancerVault.FundManagement memory funds) {
        funds = IBalancerVault.FundManagement({
            sender: address(this),
            fromInternalBalance: false,
            recipient: payable(address(this)),
            toInternalBalance: false
        });
    }

    /**
     * @dev Internal method in order to build the assets list to be used in batch swaps
     */
    function _buildAssetsParam() private view returns (address[] memory assets) {
        assets = new address[](3);
        assets[0] = address(_token);
        assets[1] = address(_linearPool);
        assets[2] = address(_pool);
    }

    /**
     * @dev Internal method in order to build the batch swaps steps to provide liquidity in the boosted pool
     * @param amountIn Amount of the assetIn token to be swapped
     * @param pool1 Address of the first pool to be used in the batch swap
     * @param pool1 Address of the second pool to be used in the batch swap
     * @param assetInIndex Index of the assetIn token in the list of assets passed in the batch swap
     * @param assetConnectIndex Index of the assetConnect token in the list of assets passed in the batch swap
     * @param assetOutIndex Index of the assetOut token in the list of assets passed in the batch swap
     */
    function _buildBatchSwapStepsParam(
        uint256 amountIn,
        bytes32 pool1,
        bytes32 pool2,
        uint256 assetInIndex,
        uint256 assetConnectIndex,
        uint256 assetOutIndex
    ) private pure returns (IBalancerVault.BatchSwapStep[] memory swaps) {
        swaps = new IBalancerVault.BatchSwapStep[](2);

        swaps[0] = IBalancerVault.BatchSwapStep({
            poolId: pool1,
            assetInIndex: assetInIndex,
            assetOutIndex: assetConnectIndex,
            amount: amountIn,
            userData: new bytes(0)
        });

        swaps[1] = IBalancerVault.BatchSwapStep({
            poolId: pool2,
            assetInIndex: assetConnectIndex,
            assetOutIndex: assetOutIndex,
            amount: 0,
            userData: new bytes(0)
        });

        return swaps;
    }
}
