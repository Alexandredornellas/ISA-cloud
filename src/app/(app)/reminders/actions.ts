"use server";

import { revalidatePath } from "next/cache";
import { addReminder, setReminderStatus } from "@/lib/reminders";

export async function reminderStatus(form: FormData) {
  const status = String(form.get("status"));
  if (status !== "open" && status !== "done" && status !== "dismissed") return;
  await setReminderStatus(String(form.get("id")), status);
  revalidatePath("/", "layout");
}

export async function newReminder(form: FormData) {
  const text = String(form.get("text") ?? "").trim();
  if (!text) return;
  await addReminder({
    text,
    person: String(form.get("person") ?? ""),
    due: String(form.get("due") ?? "") || null,
    projectId: String(form.get("projectId") ?? "") || null,
    direction: form.get("direction") === "theirs" ? "theirs" : "mine",
  });
  revalidatePath("/", "layout");
}
