// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Minimal mintable ERC20 used as the source-side token in the ICTT
///         transfer demo. NOT a production token — `mint` has no access
///         control. Anyone can mint to any address; useful only on local nets.
contract DemoERC20 is ERC20 {
    uint8 private immutable _decimals;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        _decimals = decimals_;
        // Mint a huge initial supply to the deployer. Demo only — never do
        // this on real chains.
        _mint(msg.sender, 1e28);
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    /// @notice Mint `amount` to `to`. Public on purpose — demo only.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
