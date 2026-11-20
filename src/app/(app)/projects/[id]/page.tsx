import { redirect } from "next/navigation";

/** A project lives on its screen in the sidebar now; old links land there. */
export default async function ProjectPage({ params }: PageProps<"/projects/[id]">) {
  const { id } = await params;
  redirect(`/?c=${encodeURIComponent(id)}`);
}
