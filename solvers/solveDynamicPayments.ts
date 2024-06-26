import { updateRelayingSuccess } from "../actions/actions.ts";
import {
  updateDynamicPaymentRequestJobTo,
  updatePaymentIntentAccountBalanceTooLowForDynamic,
} from "../actions/fetch.ts";
import { formatEther } from "../ethers.min.js";
import {
  ChainIds,
  DynamicPaymentRequestJobRow,
  DynamicPaymentRequestJobsStatus,
} from "../web3/constants..ts";
import {
  parseEther,
  relayPayment,
  transactionGasCalculationsForDynamicPayments,
} from "../web3/web3.ts";

export async function solveDynamicPayments(
  paymentRequest: DynamicPaymentRequestJobRow,
) {
  console.log("Starting to handle a dynamic payment for a payment intent!");
  const paymentIntentRow = paymentRequest.paymentIntent_id;
  const chainId = paymentIntentRow.network as ChainIds;
  const proof = paymentIntentRow.proof;
  const publicSignals = paymentIntentRow.publicSignals;

  //Relayer balance was already allocated so I don't need to handle relayer gas here. Phew!
  //Estimate Gas for the transaction and check if the Allocated Gas covers it!
  const gasCalculations = await transactionGasCalculationsForDynamicPayments({
    proof,
    publicSignals,
    paymentIntentRow,
    chainId,
    dynamicPaymentAmount: paymentRequest.requestedAmount,
  });

  // If there was an error with estimate gas I reject the transaction!
  if (gasCalculations.errored) {
    await updateDynamicPaymentRequestJobTo(
      DynamicPaymentRequestJobsStatus.REJECETED,
      paymentRequest.id,
      paymentIntentRow.paymentIntent,
    );

    // if the account balance is too low I will update the payment intent
    if (gasCalculations.accountBalanceEnough === false) {
      // save the dynamic payment balance to show on the UI for the account owner!

      await updatePaymentIntentAccountBalanceTooLowForDynamic(
        paymentIntentRow.id,
        paymentRequest.requestedAmount,
      );
    }
    return;
  }

  // Now I can relay the transaction since the relayer and the account has enough balance and the estimateGas succeeded
  const tx = await relayPayment(
    {
      proof,
      publicSignals,
      payeeAddress: paymentIntentRow.payee_address,
      maxDebitAmount: paymentIntentRow.maxDebitAmount,
      actualDebitedAmount: paymentRequest.requestedAmount,
      debitTimes: paymentIntentRow.debitTimes,
      debitInterval: paymentIntentRow.debitInterval,
    },
    chainId,
    gasCalculations.gasLimit,
    gasCalculations.gasPrice,
    paymentIntentRow.account_id.accountType,
  ).catch((err) => {
    return false;
  });

  if (!tx) {
    // The transaction sending fails for some reason, I return and can  try again later!
    await updateDynamicPaymentRequestJobTo(
      DynamicPaymentRequestJobsStatus.CREATED,
      paymentRequest.id,
      paymentIntentRow.paymentIntent,
    );
    return;
  }

  await tx.wait().then(async (receipt: any) => {
    if (receipt.status === 1) {
      const fee = receipt.fee;
      const newAccountBalance =
        parseEther(paymentIntentRow.account_id.balance) -
        parseEther(paymentRequest.requestedAmount);

      //Update the relayer!
      //and the account balance!

      await updateRelayingSuccess({
        network: chainId,
        payee_user_id: paymentIntentRow.payee_user_id,
        allGasUsed: formatEther(fee),
        paymentIntentRow,
        submittedTransaction: receipt.hash,
        commitment: paymentIntentRow.commitment,
        newAccountBalance: formatEther(newAccountBalance),
        paymentAmount: paymentIntentRow.maxDebitAmount,
      });

      await updateDynamicPaymentRequestJobTo(
        DynamicPaymentRequestJobsStatus.COMPLETED,
        paymentRequest.id,
        paymentIntentRow.paymentIntent,
      );
    } else {
      // The transaction failed, should not occur as estimateGas runs before
      // For now nothing happens. Need to handle this edge case later!
    }
  });
}
