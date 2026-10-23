"use client";
import { useState } from "react";
import { browserClient } from "@/lib/supabase/client";
import Link from "next/link";
type Mode = "signin" | "signup" | "forgot-password" | "reset-password";
export default function AuthForm({ mode }: { mode: Mode }) {
  const [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  const title = {
    signin: "Sign in",
    signup: "Create account",
    "forgot-password": "Forgot password",
    "reset-password": "Reset password",
  }[mode];
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    const form = new FormData(event.currentTarget),
      email = String(form.get("email") || ""),
      password = String(form.get("password") || "");
    try {
      const db = browserClient();
      if (mode === "forgot-password") {
        await db.auth.resetPasswordForEmail(email, {
          redirectTo: window.location.origin + "/auth/confirm",
        });
        setMessage(
          "If an account exists for this email, we've sent a reset link.",
        );
      } else if (mode === "reset-password") {
        if (password !== form.get("confirm"))
          throw new Error("Passwords do not match.");
        const { error } = await db.auth.updateUser({ password });
        if (error) throw error;
        await db.auth.signOut();
        window.location.assign("/signin?reset=success");
      } else if (mode === "signup") {
        const { error } = await db.auth.signUp({
          email,
          password,
          options: {
            data: { display_name: String(form.get("display_name")) },
            emailRedirectTo: window.location.origin + "/auth/confirm",
          },
        });
        if (error) throw error;
        setMessage("Check your email to confirm your account, then sign in.");
      } else {
        const { error } = await db.auth.signInWithPassword({ email, password });
        if (error)
          throw new Error("Unable to sign in. Check your email and password.");
        window.location.assign("/dashboard");
      }
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Please try again.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="wrap">
      <Link className="logo" href="/">
        Timeline Tools
      </Link>
      <form className="card auth" onSubmit={submit}>
        <h2>{title}</h2>
        {mode === "signup" && (
          <label>
            Name
            <input
              name="display_name"
              maxLength={100}
              required
              autoComplete="name"
            />
          </label>
        )}
        {mode !== "reset-password" && (
          <label>
            Email
            <input name="email" type="email" required autoComplete="email" />
          </label>
        )}
        {mode !== "forgot-password" && (
          <label>
            Password
            <input
              name="password"
              type="password"
              minLength={10}
              maxLength={128}
              required
              autoComplete={
                mode === "signin" ? "current-password" : "new-password"
              }
            />
          </label>
        )}
        {mode === "reset-password" && (
          <label>
            Confirm password
            <input
              name="confirm"
              type="password"
              minLength={10}
              required
              autoComplete="new-password"
            />
          </label>
        )}
        <button className="btn" disabled={busy}>
          {busy ? "Please wait…" : title}
        </button>
        <p role="status">{message}</p>
        <div className="row">
          <Link href="/signin">Sign in</Link>
          <Link href="/signup">Sign up</Link>
          {mode === "signin" && (
            <Link href="/forgot-password">Forgot password?</Link>
          )}
        </div>
      </form>
    </main>
  );
}
