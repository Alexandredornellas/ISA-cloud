import "dotenv/config";
import { db, schema } from "../src/db";
import type { Plan } from "../src/lib/plan";

// Adds one pending "new project" proposal so the Approve flow can be tried before the
// meeting bot and Claude are wired in. Safe to run more than once.
async function main() {
  const now = new Date();
  const [event] = await db
    .insert(schema.events)
    .values({
      source: "manual",
      externalId: `seed-${now.getTime()}`,
      title: "Kickoff call: customer portal login",
      author: "Alexandre",
      occurredAt: now,
      content:
        "We need a login page for the customer portal. Users sign in with email and password, " +
        "then confirm with a one-time code from an authenticator app. Lock the account after five failed attempts.",
    })
    .returning();

  const plan: Plan = {
    summary: "A new login page for the customer portal with multi-factor authentication.",
    projectName: "Customer portal login",
    requirementChanges: [
      {
        ref: "R1",
        op: "create",
        title: "Email and password sign-in",
        description: "Users sign in with their email address and password.",
        status: "approved",
        approvedBy: "Alexandre",
        reason: "Stated in the kickoff call.",
      },
      {
        ref: "R2",
        op: "create",
        title: "Authenticator app code after password",
        description: "After the password, users enter a one-time code from an authenticator app.",
        status: "approved",
        approvedBy: "Alexandre",
        reason: "Stated in the kickoff call.",
      },
      {
        ref: "R3",
        op: "create",
        title: "Lock account after five failed attempts",
        description: "Five failed sign-in attempts in a row lock the account.",
        status: "proposed",
        approvedBy: null,
        reason: "Mentioned in the kickoff call; the unlock process was not discussed.",
      },
    ],
    actions: [
      {
        type: "jira_create",
        requirementRef: "R1",
        summary: "Login page: email and password sign-in",
        description:
          "As a customer, I sign in with my email and password.\n\nAcceptance criteria:\n- Email and password fields with validation\n- Clear error on wrong credentials",
        issueType: "Story",
      },
      {
        type: "jira_create",
        requirementRef: "R2",
        summary: "Login page: authenticator app code (MFA)",
        description:
          "After a correct password, the customer enters a 6-digit code from an authenticator app.\n\nAcceptance criteria:\n- Code is required to finish sign-in\n- Setup flow shows a QR code",
        issueType: "Story",
      },
      {
        type: "jira_create",
        requirementRef: "R3",
        summary: "Lock account after five failed sign-in attempts",
        description: "Five failed attempts in a row lock the account.\n\nOpen question: how is an account unlocked?",
        issueType: "Task",
      },
    ],
    openQuestions: ["How does a locked-out customer unlock their account?"],
  };

  await db.insert(schema.proposals).values({
    kind: "new_project",
    title: "New project: Customer portal login",
    plan,
    eventIds: [event.id],
  });
  console.log("Seeded one pending proposal");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
