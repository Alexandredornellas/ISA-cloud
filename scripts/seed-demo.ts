import "dotenv/config";
import { db, schema } from "../src/db";
import type { Plan } from "../src/lib/plan";
import { saveSettings, getSettings } from "../src/lib/settings";

// Demo story: one product manager, Marina, keeps three projects on track with ISA.
// - Checkout redesign is at risk: a client call changed a requirement, Jira still has the old
//   version, a developer edited a ticket, and the payment contract Rafael promised is late.
// - Partner API v2 needs attention: an email brought a new requirement and Marina owes a changelog today.
// - Mobile onboarding is on track: approved, ticketed, and moving.
//
// It REPLACES all of ISA's projects, items, suggestions and reminders. Run it on a local or demo
// database with the worker off (its Jira keys are made up), never on the real one:
//   npm run seed:demo -- --reset
const HOUR = 3600000;
const DAY = 24 * HOUR;

async function main() {
  if (!process.argv.includes("--reset")) {
    console.error("This replaces all projects, items, suggestions and reminders. Run it again with --reset to go ahead.");
    process.exit(1);
  }
  const now = Date.now();
  const ago = (ms: number) => new Date(now - ms);
  const inDays = (d: number) => new Date(new Date(now + d * DAY).toISOString().slice(0, 10) + "T12:00:00Z");

  for (const t of [schema.reminders, schema.ticketChanges, schema.jiraTickets, schema.actions, schema.proposals, schema.eventProjects, schema.chatMessages, schema.projectRules, schema.requirements, schema.events, schema.projects]) {
    await db.delete(t);
  }
  await saveSettings({ ...(await getSettings()), ownerName: "Marina Alves" });

  const people = {
    rafael: { name: "Rafael Costa", email: "rafael@lojaviva.example", slackUserId: null, role: "Client, Head of e-commerce at Loja Viva" },
    joao: { name: "João Lima", email: null, slackUserId: null, role: "Tech lead, checkout" },
    bruno: { name: "Bruno Reis", email: null, slackUserId: null, role: "Backend engineer, Partner API" },
    priya: { name: "Priya Nair", email: "priya@globex.example", slackUserId: null, role: "Partner integrations, Globex" },
    lia: { name: "Lia Santos", email: null, slackUserId: null, role: "Designer, mobile" },
  };

  const [checkout, api, mobile] = await db
    .insert(schema.projects)
    .values([
      { name: "Checkout redesign", summary: "New one-page checkout for Loja Viva's web store: guest checkout, saved cards and local payment methods.", people: [people.rafael, people.joao] },
      { name: "Partner API v2", summary: "Version 2 of the public API for partners like Globex: OAuth, per-tier rate limits and webhooks.", people: [people.bruno, people.priya] },
      { name: "Mobile onboarding", summary: "Shorter sign-up on the iOS and Android apps, with social login and a 3-step tour.", people: [people.lia] },
    ])
    .returning();

  // Requirements and their Jira tickets.
  await db.insert(schema.requirements).values([
    { projectId: checkout.id, title: "Guest checkout without an account", description: "Buyers can pay with email only. Now must also offer Pix (agreed with Rafael on Thursday).", status: "changed", approvedBy: "Rafael Costa", jiraIssueKey: "CHK-14", jiraStatus: "In progress" },
    { projectId: checkout.id, title: "Save cards for returning buyers", description: "Tokenized cards via the payment provider.", status: "approved", approvedBy: "Rafael Costa", jiraIssueKey: "CHK-12", jiraStatus: "In progress" },
    { projectId: checkout.id, title: "One-page layout on mobile web", description: "", status: "approved", approvedBy: "Rafael Costa", jiraIssueKey: "CHK-11", jiraStatus: "Done" },
    { projectId: api.id, title: "OAuth 2.0 client credentials for partners", description: "", status: "approved", approvedBy: "Priya Nair", jiraIssueKey: "API-7", jiraStatus: "In review" },
    { projectId: api.id, title: "Webhooks for order status", description: "", status: "proposed", approvedBy: null, jiraIssueKey: "API-9", jiraStatus: "To do" },
    { projectId: mobile.id, title: "Sign up with Google and Apple", description: "", status: "approved", approvedBy: "Lia Santos", jiraIssueKey: "MOB-3", jiraStatus: "In progress" },
    { projectId: mobile.id, title: "3-step product tour after sign-up", description: "", status: "approved", approvedBy: "Lia Santos", jiraIssueKey: "MOB-4", jiraStatus: "To do" },
    { projectId: mobile.id, title: "Remove the phone number step", description: "", status: "done", approvedBy: "Lia Santos", jiraIssueKey: "MOB-2", jiraStatus: "Done" },
  ]);
  await db.insert(schema.jiraTickets).values([
    { key: "CHK-10", projectId: checkout.id, issueType: "Epic", summary: "Checkout redesign", status: "In progress" },
    { key: "CHK-14", projectId: checkout.id, issueType: "Story", summary: "Guest checkout without an account", status: "In progress" },
    { key: "CHK-12", projectId: checkout.id, issueType: "Story", summary: "Save cards for returning buyers", status: "In progress" },
    { key: "API-1", projectId: api.id, issueType: "Epic", summary: "Partner API v2", status: "In progress" },
    { key: "MOB-1", projectId: mobile.id, issueType: "Epic", summary: "Mobile onboarding", status: "In progress" },
  ]);
  await db.insert(schema.ticketChanges).values([
    { key: "CHK-12", projectId: checkout.id, historyId: "demo-1", field: "description", fromValue: "Cards tokenized by the provider", toValue: "Store card numbers encrypted in our DB", author: "João Lima", changedAt: ago(5 * HOUR), byIsa: "no" },
    { key: "MOB-3", projectId: mobile.id, historyId: "demo-2", field: "status", fromValue: "To do", toValue: "In progress", author: "Lia Santos", changedAt: ago(26 * HOUR), byIsa: "no" },
  ]);

  // What ISA heard.
  const [call, slack, email, mobileCall] = await db
    .insert(schema.events)
    .values([
      {
        source: "zoom", externalId: "demo-call-1", title: "Loja Viva weekly", author: "Rafael Costa", occurredAt: ago(20 * HOUR), status: "sorted",
        participants: [people.rafael, people.joao],
        content: "Rafael: Our Black Friday numbers say 40% of buyers want Pix. Guest checkout has to offer Pix, not only cards.\nMarina: Understood, I'll update the guest checkout story and send you the revised scope by Monday.\nRafael: Great. I'll send the final contract with the payment provider tomorrow so João can start.\nJoão: Pix needs the provider's QR API, so I need that contract first.",
      },
      {
        source: "slack", externalId: "demo-slack-1", title: "#checkout-dev", author: "João Lima", occurredAt: ago(5 * HOUR), status: "sorted",
        content: "João: Changed CHK-12 to store card numbers encrypted in our DB, the provider's vault is slow in tests.",
      },
      {
        source: "gmail", externalId: "demo-mail-1", title: "Rate limits for Globex tiers", author: "Priya Nair <priya@globex.example>", occurredAt: ago(3 * HOUR), status: "sorted",
        content: "Hi Marina, our Enterprise tier needs 1,000 requests per minute, Standard 100. Can v2 enforce limits per tier? Also, could you send me the API changelog today so I can brief our team? Thanks, Priya",
      },
      {
        source: "meet", externalId: "demo-call-2", title: "Onboarding design review", author: "Lia Santos", occurredAt: ago(2 * DAY), status: "sorted",
        content: "Lia: The phone step is gone and sign-up time dropped from 3 minutes to 70 seconds. Next is the product tour.\nBruno: I'll share the load-test results for the API with Marina on Monday.",
      },
    ])
    .returning();
  await db.insert(schema.eventProjects).values([
    { eventId: call.id, projectId: checkout.id, relation: "change", note: "Rafael changed guest checkout: it must offer Pix as well as cards. He will send the payment provider contract tomorrow; João needs it to start." },
    { eventId: slack.id, projectId: checkout.id, relation: "change", note: "João changed CHK-12 to store card numbers in our own database instead of the provider's vault." },
    { eventId: email.id, projectId: api.id, relation: "new", note: "Priya asks for rate limits per partner tier (Enterprise 1,000/min, Standard 100/min) and the API changelog today." },
    { eventId: mobileCall.id, projectId: mobile.id, relation: "approval", note: "Lia confirmed the phone step is removed (sign-up 3 min → 70 s). Next: the product tour." },
  ]);

  // Suggestions waiting for Marina, and one already done.
  const pix: Plan = {
    summary: "In Thursday's Loja Viva call, Rafael asked for Pix in guest checkout. CHK-14 still describes cards only. João needs the provider contract before he can start.",
    projectName: null,
    people: [],
    requirementChanges: [],
    actions: [
      { type: "jira_update", requirementRef: "R", issueKey: "CHK-14", summary: "Guest checkout with cards and Pix", description: "Buyers can check out with email only and pay by card or Pix (QR code).\n\nWhy and sources\nRafael Costa, Loja Viva weekly (Zoom), Nov 19: 40% of Black Friday buyers want Pix." },
      { type: "jira_comment", requirementRef: "R", issueKey: "CHK-14", body: "Scope changed in the Loja Viva weekly: Pix added. Blocked until the payment provider contract arrives (Rafael)." },
      { type: "slack_message", channel: "C0DEMO", recipientLabel: "#checkout-dev", threadTs: null, text: "Heads up: guest checkout now includes Pix (CHK-14 updated). João, Pix depends on the provider's QR API, contract expected from Rafael." },
    ],
    openQuestions: ["Should Pix also be offered to logged-in buyers, or only in guest checkout?"],
  };
  const tiers: Plan = {
    summary: "Priya (Globex) asked for rate limits per partner tier: Enterprise 1,000 requests/min, Standard 100/min.",
    projectName: null,
    people: [],
    requirementChanges: [{ ref: "R1", op: "create", title: "Rate limits per partner tier", description: "Enterprise 1,000 req/min; Standard 100 req/min.", status: "proposed", approvedBy: null, reason: "Priya Nair by email, today" }],
    actions: [
      { type: "jira_create", requirementRef: "R1", summary: "Rate limits per partner tier", description: "Enforce per-tier limits: Enterprise 1,000 requests/min, Standard 100/min. Return 429 with Retry-After.\n\nWhy and sources\nPriya Nair (Globex), email \"Rate limits for Globex tiers\".", kind: "story", epicRef: "API-1" },
      { type: "email", to: ["priya@globex.example"], subject: "Re: Rate limits for Globex tiers", body: "Hi Priya, thanks, we've added per-tier limits to v2's scope. I'll send the changelog later today. Marina", threadId: null },
    ],
    openQuestions: ["What should happen above the limit: reject with 429, or queue?"],
  };
  await db
    .insert(schema.proposals)
    .values([
      { kind: "update", projectId: checkout.id, title: "Add Pix to guest checkout", plan: pix, eventIds: [call.id], createdAt: ago(19 * HOUR) },
      { kind: "update", projectId: api.id, title: "Rate limits per partner tier", plan: tiers, eventIds: [email.id], createdAt: ago(3 * HOUR) },
    ]);
  const tour: Plan = {
    summary: "Lia confirmed the phone step is gone; sign-up dropped from 3 minutes to 70 seconds.",
    projectName: null,
    people: [],
    requirementChanges: [],
    actions: [{ type: "jira_comment", requirementRef: "R", issueKey: "MOB-2", body: "Confirmed in the design review: sign-up now takes 70 s (was 3 min)." }],
    openQuestions: [],
  };
  const [done] = await db
    .insert(schema.proposals)
    .values({ kind: "update", projectId: mobile.id, title: "Phone step removed", plan: tour, eventIds: [mobileCall.id], status: "executed", decidedAt: ago(47 * HOUR), createdAt: ago(47 * HOUR) })
    .returning();
  await db.insert(schema.actions).values({ proposalId: done.id, projectId: mobile.id, type: "jira_comment", position: 0, status: "done", payload: tour.actions[0], result: { key: "MOB-2" } });

  // Who owes what.
  await db.insert(schema.reminders).values([
    { projectId: checkout.id, eventId: call.id, direction: "mine", text: "Send Rafael the revised checkout scope with Pix", person: "Rafael Costa", due: inDays(3), dueText: "by Monday", quote: "I'll update the guest checkout story and send you the revised scope by Monday." },
    { projectId: checkout.id, eventId: call.id, direction: "theirs", text: "Send the final payment provider contract", person: "Rafael Costa", due: inDays(-1), dueText: "tomorrow", quote: "I'll send the final contract with the payment provider tomorrow." },
    { projectId: api.id, eventId: email.id, direction: "mine", text: "Send Priya the API v2 changelog", person: "Priya Nair", due: inDays(0), dueText: "today", quote: "could you send me the API changelog today" },
    { projectId: api.id, eventId: mobileCall.id, direction: "theirs", text: "Share the API load-test results", person: "Bruno Reis", due: inDays(3), dueText: "on Monday", quote: "I'll share the load-test results for the API with Marina on Monday." },
  ]);

  console.log("Demo data loaded: Checkout redesign (at risk), Partner API v2 (needs attention), Mobile onboarding (on track).");
  process.exit(0);
}


main().catch((err) => {
  console.error(err);
  process.exit(1);
});
