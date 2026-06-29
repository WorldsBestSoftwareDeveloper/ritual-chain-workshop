# Ritual Chain Workshop Hardhat Project

This Hardhat v3 project contains `AIJudge`, a bounty contract that uses a commit-reveal submission lifecycle and preserves the Ritual LLM precompile call used for AI judging.

## Bounty lifecycle

1. The owner creates a bounty with `createBounty(title, rubric, commitmentDeadline, revealDeadline)` and funds the reward with `msg.value`.
2. Participants commit before `commitmentDeadline` by calling `submitCommitment(bountyId, commitment)`.
3. Each commitment is computed offchain as:

   ```solidity
   keccak256(abi.encodePacked(answer, salt, participant, bountyId))
   ```

4. After the commitment deadline and before the reveal deadline, participants reveal with `revealAnswer(bountyId, answer, salt)`.
5. Invalid reveals are rejected, duplicate commitments are rejected, and unrevealed commitments are ignored.
6. After `revealDeadline`, the bounty owner calls `judgeAll(bountyId, llmInput)`. The contract forwards `llmInput` to the Ritual LLM precompile at `0x0802` and stores the returned AI review.
7. Once judging succeeds, the owner calls `finalizeWinner(bountyId, winnerIndex)` to pay the selected revealed submission.

Only revealed answers are stored as submissions, so `winnerIndex` always refers to the revealed-submission list returned by `getSubmission`.

## Commands

Install dependencies:

```shell
pnpm install
```

Run tests:

```shell
pnpm hardhat test
```

Deploy with Ignition:

```shell
pnpm hardhat ignition deploy ignition/modules/AIJudge.ts --network ritual
```
