"use client";
export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <main className="wrap">
      <div className="card">
        <h2>Something went wrong</h2>
        <p>Please try again. Your saved jobs are safe.</p>
        <button className="btn" onClick={reset}>
          Try again
        </button>
      </div>
    </main>
  );
}
