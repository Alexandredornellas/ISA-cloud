"use server";

import { revalidatePath } from "next/cache";
import { acceptSuggestion, addDuty, dismissSuggestion, removeDuty, removePerson, splitList, unlinkFromProject, updateDuty, updatePerson, upsertPerson } from "@/lib/people";

const str = (form: FormData, key: string) => String(form.get(key) ?? "").trim();

export async function savePersonForm(form: FormData) {
  const name = str(form, "name");
  if (!name) return;
  const id = str(form, "id");
  const fields = { name, email: str(form, "email") || null, title: str(form, "title") || null, team: str(form, "team") || null, notes: str(form, "notes") || null };
  let personId = id;
  if (id) {
    await updatePerson(id, fields);
  } else {
    personId = (await upsertPerson(fields)).id;
    await updatePerson(personId, fields);
  }
  // New people can list what they help with company-wide in one go.
  for (const text of splitList(str(form, "helps"))) await addDuty({ personId, text });
  revalidatePath("/", "layout");
}

export async function deletePerson(form: FormData) {
  await removePerson(str(form, "id"));
  revalidatePath("/", "layout");
}

/** Add a duty to a person: for one project, or company-wide when no project is picked. */
export async function newDuty(form: FormData) {
  const projectId = str(form, "projectId") || null;
  const name = str(form, "name");
  const personId = str(form, "personId") || (name ? (await upsertPerson({ name })).id : "");
  if (!personId) return;
  const texts = splitList(str(form, "text"));
  if (!texts.length && projectId) await addDuty({ personId, projectId });
  for (const text of texts) await addDuty({ personId, projectId, text });
  revalidatePath("/", "layout");
}

export async function editDuty(form: FormData) {
  await updateDuty(str(form, "id"), str(form, "text"));
  revalidatePath("/", "layout");
}

export async function deleteDuty(form: FormData) {
  await removeDuty(str(form, "id"));
  revalidatePath("/", "layout");
}

export async function removeStakeholder(form: FormData) {
  await unlinkFromProject(str(form, "projectId"), str(form, "personId"));
  revalidatePath("/", "layout");
}

export async function decideSuggestion(form: FormData) {
  const id = str(form, "id");
  if (form.get("decision") === "accept") await acceptSuggestion(id, str(form, "text") || null);
  else await dismissSuggestion(id);
  revalidatePath("/", "layout");
}
