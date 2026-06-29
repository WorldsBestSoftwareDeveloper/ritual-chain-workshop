import assert from "node:assert/strict";
import { describe, it } from "node:test";
import hre from "hardhat";
import {
  encodePacked,
  keccak256,
  parseEther,
  stringToHex,
  type Address,
  type Hex,
} from "viem";

const connection = await hre.network.create();
const { viem, networkHelpers } = connection;

const BOUNTY_ID = 1n;
const LLM_PRECOMPILE = "0x0000000000000000000000000000000000000802";
const REWARD = parseEther("1");

function salt(label: string): Hex {
  return stringToHex(label, { size: 32 });
}

function commitmentFor(
  answer: string,
  revealSalt: Hex,
  submitter: Address,
  bountyId = BOUNTY_ID,
): Hex {
  return keccak256(
    encodePacked(
      ["string", "bytes32", "address", "uint256"],
      [answer, revealSalt, submitter, bountyId],
    ),
  );
}

async function deployFixture() {
  const [owner, alice, bob] = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();

  const aiJudge = await viem.deployContract("AIJudge");
  const mockLlm = await viem.deployContract("MockLLMPrecompile");
  const mockCode = await publicClient.getCode({ address: mockLlm.address });

  assert.ok(mockCode, "mock LLM precompile code missing");

  await connection.provider.request({
    method: "hardhat_setCode",
    params: [LLM_PRECOMPILE, mockCode],
  });

  const now = BigInt(await networkHelpers.time.latest());
  const commitmentDeadline = now + 100n;
  const revealDeadline = now + 200n;

  await aiJudge.write.createBounty(
    ["Essay bounty", "Pick the strongest answer", commitmentDeadline, revealDeadline],
    { value: REWARD },
  );

  return {
    aiJudge,
    owner,
    alice,
    bob,
    commitmentDeadline,
    revealDeadline,
  };
}

describe("AIJudge commit-reveal workflow", function () {
  it("accepts a valid reveal and stores the revealed answer", async function () {
    const { aiJudge, alice, commitmentDeadline } =
      await networkHelpers.loadFixture(deployFixture);
    const answer = "The best answer";
    const revealSalt = salt("valid reveal");
    const commitment = commitmentFor(
      answer,
      revealSalt,
      alice.account.address,
    );

    await aiJudge.write.submitCommitment([BOUNTY_ID, commitment], {
      account: alice.account,
    });
    await networkHelpers.time.increaseTo(commitmentDeadline);

    await viem.assertions.emitWithArgs(
      aiJudge.write.revealAnswer([BOUNTY_ID, answer, revealSalt], {
        account: alice.account,
      }),
      aiJudge,
      "AnswerRevealed",
      [BOUNTY_ID, 0n, alice.account.address, answer],
    );

    const [, , revealed] = await aiJudge.read.getCommitment([
      BOUNTY_ID,
      alice.account.address,
    ]);
    const [submitter, storedAnswer] = await aiJudge.read.getSubmission([
      BOUNTY_ID,
      0n,
    ]);
    const bounty = await aiJudge.read.getBounty([BOUNTY_ID]);

    assert.equal(revealed, true);
    assert.equal(submitter.toLowerCase(), alice.account.address.toLowerCase());
    assert.equal(storedAnswer, answer);
    assert.equal(bounty[8], 1n);
  });

  it("rejects invalid reveals", async function () {
    const { aiJudge, alice, commitmentDeadline } =
      await networkHelpers.loadFixture(deployFixture);
    const answer = "Committed answer";
    const revealSalt = salt("correct salt");
    const commitment = commitmentFor(
      answer,
      revealSalt,
      alice.account.address,
    );

    await aiJudge.write.submitCommitment([BOUNTY_ID, commitment], {
      account: alice.account,
    });
    await networkHelpers.time.increaseTo(commitmentDeadline);

    await viem.assertions.revertWith(
      aiJudge.write.revealAnswer([BOUNTY_ID, answer, salt("wrong salt")], {
        account: alice.account,
      }),
      "invalid reveal",
    );

    const bounty = await aiJudge.read.getBounty([BOUNTY_ID]);
    assert.equal(bounty[8], 0n);
  });

  it("rejects duplicate commitments from the same participant", async function () {
    const { aiJudge, alice } = await networkHelpers.loadFixture(deployFixture);
    const first = commitmentFor(
      "First answer",
      salt("first"),
      alice.account.address,
    );
    const second = commitmentFor(
      "Second answer",
      salt("second"),
      alice.account.address,
    );

    await aiJudge.write.submitCommitment([BOUNTY_ID, first], {
      account: alice.account,
    });

    await viem.assertions.revertWith(
      aiJudge.write.submitCommitment([BOUNTY_ID, second], {
        account: alice.account,
      }),
      "commitment exists",
    );
  });

  it("enforces commitment, reveal, and judging deadlines", async function () {
    const { aiJudge, alice, commitmentDeadline, revealDeadline } =
      await networkHelpers.loadFixture(deployFixture);
    const now = BigInt(await networkHelpers.time.latest());
    const answer = "Deadline answer";
    const revealSalt = salt("deadlines");
    const commitment = commitmentFor(
      answer,
      revealSalt,
      alice.account.address,
    );

    await viem.assertions.revertWith(
      aiJudge.write.createBounty([
        "Past commitment",
        "Rubric",
        now,
        now + 1n,
      ], {
        value: REWARD,
      }),
      "commitment deadline passed",
    );

    await viem.assertions.revertWith(
      aiJudge.write.createBounty([
        "Bad reveal",
        "Rubric",
        now + 10n,
        now + 10n,
      ], {
        value: REWARD,
      }),
      "invalid reveal deadline",
    );

    await aiJudge.write.submitCommitment([BOUNTY_ID, commitment], {
      account: alice.account,
    });

    await viem.assertions.revertWith(
      aiJudge.write.revealAnswer([BOUNTY_ID, answer, revealSalt], {
        account: alice.account,
      }),
      "reveal not open",
    );

    await viem.assertions.revertWith(
      aiJudge.write.judgeAll([BOUNTY_ID, "0x"]),
      "reveal still open",
    );

    await networkHelpers.time.increaseTo(commitmentDeadline);

    await viem.assertions.revertWith(
      aiJudge.write.submitCommitment([
        BOUNTY_ID,
        commitmentFor("Late answer", salt("late"), alice.account.address),
      ], {
        account: alice.account,
      }),
      "commitments closed",
    );

    await aiJudge.write.revealAnswer([BOUNTY_ID, answer, revealSalt], {
      account: alice.account,
    });

    await viem.assertions.revertWith(
      aiJudge.write.judgeAll([BOUNTY_ID, "0x"]),
      "reveal still open",
    );

    await networkHelpers.time.increaseTo(revealDeadline);

    await viem.assertions.revertWith(
      aiJudge.write.revealAnswer([BOUNTY_ID, answer, revealSalt], {
        account: alice.account,
      }),
      "reveal closed",
    );
  });

  it("ignores unrevealed commitments during judging", async function () {
    const { aiJudge, alice, bob, commitmentDeadline, revealDeadline } =
      await networkHelpers.loadFixture(deployFixture);
    const aliceAnswer = "Revealed answer";
    const bobAnswer = "Unrevealed answer";
    const aliceSalt = salt("alice");
    const bobSalt = salt("bob");

    await aiJudge.write.submitCommitment(
      [
        BOUNTY_ID,
        commitmentFor(aliceAnswer, aliceSalt, alice.account.address),
      ],
      { account: alice.account },
    );
    await aiJudge.write.submitCommitment(
      [BOUNTY_ID, commitmentFor(bobAnswer, bobSalt, bob.account.address)],
      { account: bob.account },
    );

    await networkHelpers.time.increaseTo(commitmentDeadline);
    await aiJudge.write.revealAnswer([BOUNTY_ID, aliceAnswer, aliceSalt], {
      account: alice.account,
    });
    await networkHelpers.time.increaseTo(revealDeadline);

    await viem.assertions.emitWithArgs(
      aiJudge.write.judgeAll([BOUNTY_ID, "0x"]),
      aiJudge,
      "AllAnswersJudged",
      [BOUNTY_ID, stringToHex("mock ai review")],
    );

    const bounty = await aiJudge.read.getBounty([BOUNTY_ID]);
    const commitmentCount = await aiJudge.read.getCommitmentCount([BOUNTY_ID]);
    const [submitter] = await aiJudge.read.getSubmission([BOUNTY_ID, 0n]);

    assert.equal(commitmentCount, 2n);
    assert.equal(bounty[8], 1n);
    assert.equal(submitter.toLowerCase(), alice.account.address.toLowerCase());
  });

  it("only finalizes after judging and rejects invalid winners", async function () {
    const { aiJudge, alice, commitmentDeadline, revealDeadline } =
      await networkHelpers.loadFixture(deployFixture);
    const answer = "Winning answer";
    const revealSalt = salt("winner");

    await aiJudge.write.submitCommitment(
      [
        BOUNTY_ID,
        commitmentFor(answer, revealSalt, alice.account.address),
      ],
      { account: alice.account },
    );
    await networkHelpers.time.increaseTo(commitmentDeadline);
    await aiJudge.write.revealAnswer([BOUNTY_ID, answer, revealSalt], {
      account: alice.account,
    });
    await networkHelpers.time.increaseTo(revealDeadline);

    await viem.assertions.revertWith(
      aiJudge.write.finalizeWinner([BOUNTY_ID, 0n]),
      "not judged yet",
    );

    await aiJudge.write.judgeAll([BOUNTY_ID, "0x"]);

    await viem.assertions.revertWith(
      aiJudge.write.finalizeWinner([BOUNTY_ID, 1n]),
      "invalid winner",
    );

    await viem.assertions.emitWithArgs(
      aiJudge.write.finalizeWinner([BOUNTY_ID, 0n]),
      aiJudge,
      "WinnerFinalized",
      [BOUNTY_ID, 0n, alice.account.address, REWARD],
    );

    await viem.assertions.revertWith(
      aiJudge.write.finalizeWinner([BOUNTY_ID, 0n]),
      "already finalized",
    );
  });
});
