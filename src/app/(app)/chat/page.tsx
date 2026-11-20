import { redirect } from "next/navigation";

// Ask ISA now lives in the channels on the home screen.
export default async function ChatPage({ searchParams }: PageProps<"/chat">) {
  const { project, ask } = await searchParams;
  const params = new URLSearchParams();
  if (typeof project === "string") params.set("c", project);
  if (typeof ask === "string") params.set("ask", ask);
  redirect(params.size ? `/?${params}` : "/");
}
