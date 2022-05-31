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

import '@openzeppelin/contracts/token/ERC20/IERC20.sol';

// solhint-disable func-name-mixedcase

interface ILiquidityGauge {
    function deposit(uint256 value) external;

    function withdraw(uint256 value) external;

    function claim_rewards(address user) external;

    function lp_token() external view returns (IERC20);

    function reward_count() external view returns (uint256);

    function reward_tokens(uint256 i) external view returns (IERC20);

    function balanceOf(address user) external view returns (uint256);

    function claimable_tokens(address user) external returns (uint256);

    function claimable_reward(address user, address token) external view returns (uint256);
}