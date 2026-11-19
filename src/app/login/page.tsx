import { login } from "./actions";

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const { next, error } = await searchParams;
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <form action={login} className="w-full max-w-xs space-y-4">
        <h1 className="text-2xl font-semibold">ISA</h1>
        <input type="hidden" name="next" value={typeof next === "string" ? next : "/"} />
        <input
          type="password"
          name="password"
          placeholder="Password"
          autoFocus
          className="w-full rounded-lg border border-line bg-surface px-3 py-2"
        />
        {error ? <p className="text-sm text-danger">Wrong password.</p> : null}
        <button className="w-full rounded-lg bg-accent px-3 py-2 font-medium text-white">Sign in</button>
      </form>
    </main>
  );
}
