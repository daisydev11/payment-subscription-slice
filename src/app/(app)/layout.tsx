import Link from "next/link";
import { redirect } from "next/navigation";
import { SignOutButton } from "@/components/auth/SignOutButton";
import { getSessionUser } from "@/lib/auth/session";

// The minimal signed-in shell the billing screens hang on.
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await getSessionUser();
  if (!user) redirect("/signin");
  const offset = process.env.NODE_ENV === "production" ? 0 : Number(process.env.CLOCK_OFFSET_DAYS ?? 0);

  return (
    <div className="shell">
      <header className="shell-header">
        <nav aria-label="Main">
          <Link href="/plans">Plans</Link>
          <Link href="/billing">Billing</Link>
        </nav>
        <div className="shell-user">
          <span>{user.name}</span>
          <SignOutButton />
        </div>
      </header>
      {offset ? <p className="dev-banner">Development clock is {offset} days ahead of real time.</p> : null}
      <main className="shell-main">{children}</main>
    </div>
  );
}
