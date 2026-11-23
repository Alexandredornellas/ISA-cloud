"use server";

import { revalidatePath } from "next/cache";
import { claudeStructured } from "@/lib/brain/llm";
import { alsoFileEvent, confirmClarification, placeClarification, processEvent, refileEvent } from "@/lib/brain/pipeline";
import { ignoreEvent, unfileEvent } from "@/lib/intake";

const str = (form: FormData, key: string) => String(form.get(key) ?? "").trim();

function fail(err: unknown, what: string) {
  console.error(`intake ${what} failed`, { error: err instanceof Error ? err.name : "unknown" });
}

/** "Yes, it's about X." */
export async function confirmPlace(form: FormData) {
  try {
    await confirmClarification(str(form, "proposalId"), claudeStructured);
  } catch (err) {
    fail(err, "confirm");
  }
  revalidatePath("/", "layout");
}

/** File an item under a project, or a new one: answers a question, moves it, or adds a project. */
export async function fileItem(form: FormData) {
  const eventId = str(form, "eventId");
  const proposalId = str(form, "proposalId");
  const target = str(form, "target");
  const mode = str(form, "mode"); // place | move | also
  const name = str(form, "newProjectName");
  if (!target) return;
  const to: { projectId: string } | { newProjectName: string } = target === "new" ? { newProjectName: name || "New project" } : { projectId: target };
  try {
    if (proposalId && mode === "place") await placeClarification(proposalId, to, claudeStructured);
    else if (mode === "also" && "projectId" in to) await alsoFileEvent(eventId, to.projectId, str(form, "about") || "Filed here by the owner", claudeStructured);
    else await refileEvent(eventId, to, claudeStructured);
  } catch (err) {
    fail(err, "file");
  }
  revalidatePath("/", "layout");
}

export async function ignoreItem(form: FormData) {
  await ignoreEvent(str(form, "eventId"));
  revalidatePath("/", "layout");
}

export async function unfileItem(form: FormData) {
  await unfileEvent(str(form, "eventId"), str(form, "projectId"));
  revalidatePath("/", "layout");
}

export async function retryItem(form: FormData) {
  try {
    await processEvent(str(form, "eventId"), claudeStructured);
  } catch (err) {
    fail(err, "retry");
  }
  revalidatePath("/", "layout");
}
