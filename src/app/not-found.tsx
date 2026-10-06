import Link from "next/link";

export default function NotFound() {
  return (
    <div className="centered">
      <main className="card stack">
        <h1>That page does not exist</h1>
        <p className="lede">Nothing was charged and nothing was changed.</p>
        <Link href="/billing">Go to billing</Link>
      </main>
    </div>
  );
}
