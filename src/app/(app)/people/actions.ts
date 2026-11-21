"use server";

import { revalidatePath } from "next/cache";
import {
  acceptSuggestion,
  dismissSuggestion,
  linkToProject,
  removePerson,
  splitList,
  unlinkFromProject,
  updatePerson,
  upsertPerson,
} from "@/lib/people";

const str = (form: FormData, key: string) => String(form.get(key) ?? "").trim();

export async function savePersonForm(form: FormData) {
  const name = str(form, "name");
  if (!name) return;
  const id = str(form, "id");
  const fields = {
    name,
    email: str(form, "email") || null,
    title: str(form, "title") || null,
    team: str(form, "team") || null,
    canHelpWith: splitList(str(form, "canHelpWith")),
    notes: str(form, "notes") || null,
  };
  if (id) {
    await updatePerson(id, fields);
  } else {
    const person = await upsertPerson(fields);
    await updatePerson(person.id, { ...fields, canHelpWith: [...person.canHelpWith, ...fields.canHelpWith] });
  }
  revalidatePath("/", "layout");
}

export async function deletePerson(form: FormData) {
  await removePerson(str(form, "id"));
  revalidatePath("/", "layout");
}

/** Add someone (new or from the directory) to a project, with how they move it forward. */
export async function addStakeholder(form: FormData) {
  const projectId = str(form, "projectId");
  const name = str(form, "name");
  if (!projectId || !name) return;
  const person = await upsertPerson({ name });
  await linkToProject(projectId, person.id, str(form, "role") || null, true);
  revalidatePath("/", "layout");
}

export async function setStakeholderRole(form: FormData) {
  await linkToProject(str(form, "projectId"), str(form, "personId"), str(form, "role") || null, true);
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
