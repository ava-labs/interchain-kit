// Negative-path assertion helper for e2e scripts.

import type { Abi, Address, PublicClient } from "viem";

/**
 * Assert that simulating `call` reverts with an error whose decoded message
 * contains `expectedError` (typically a custom error name like
 * `"SenderNotAllowed"`, or a substring of a string revert reason).
 *
 * Uses eth_call simulation: needs no gas from the caller, leaves no on-chain
 * trace, and viem decodes custom errors as long as they appear in `abi`.
 *
 * Throws when the call unexpectedly succeeds, or when it reverts with a
 * different error (the original error text is included for diagnosis).
 */
export async function expectRevert(
  publicClient: PublicClient,
  call: {
    address: Address;
    abi: Abi;
    functionName: string;
    args?: readonly unknown[];
    /** Simulate as this account (defaults to no specific sender). */
    account?: Address;
  },
  expectedError: string,
  label?: string,
): Promise<void> {
  const what = label ?? `${call.functionName}()`;
  try {
    await publicClient.simulateContract({
      address: call.address,
      abi: call.abi,
      functionName: call.functionName,
      args: call.args as unknown[],
      account: call.account,
    });
  } catch (err) {
    const msg = String((err as Error).message ?? err);
    if (!msg.includes(expectedError)) {
      throw new Error(
        `${what}: reverted, but not with "${expectedError}":\n${msg.slice(0, 600)}`,
      );
    }
    return;
  }
  throw new Error(`${what}: expected revert "${expectedError}", but the call succeeded`);
}
