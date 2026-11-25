/**
 * Wraps one page inside the layout: while its code is still downloading, only the page area shows a spinner (the
 * sidebar and header stay — no white flash of the whole screen), and if the page fails to load or crashes, a
 * "dobara koshish" card shows instead of a blank white screen.
 */
import { Component, Suspense, type ReactNode } from "react";
import { Loading } from "./ui";

class Catch extends Component<{ children: ReactNode }, { err: Error | null }> {
  state = { err: null as Error | null };
  static getDerivedStateFromError(err: Error) { return { err }; }
  componentDidCatch(err: Error) { console.error("page failed", err); }
  render() {
    const { err } = this.state;
    if (!err) return this.props.children;
    const net = /fetch|dynamically imported|import|chunk|load/i.test(err.message);
    return (
      <div className="card mx-auto mt-6 max-w-lg p-6 text-center" role="alert">
        <div className="text-3xl">{net ? "📶" : "⚠️"}</div>
        <h2 className="mt-2 text-lg font-semibold">{net ? "Page load nahi hua" : "Is page mein masla aa gaya"} · <span lang="ur" className="font-urdu font-normal">صفحہ نہیں کھلا</span></h2>
        <p className="mt-1 text-sm text-slate-600">{net ? "Net ya server abhi slow hai. Thori dair baad dobara koshish karein — aap ka data mehfooz hai." : "Dobara koshish karein. Masla rahe to screenshot bhej dein."}</p>
        <div className="mt-4 flex justify-center gap-2">
          {/* a page whose code failed to download stays failed until the app reloads (React keeps the failed load) */}
          <button type="button" className="btn-primary" onClick={() => (net ? window.location.reload() : this.setState({ err: null }))}>🔄 Dobara koshish</button>
          {!net && <button type="button" className="btn-secondary" onClick={() => window.location.reload()}>Page refresh</button>}
        </div>
      </div>
    );
  }
}

export function PageBoundary({ children }: { children: ReactNode }) {
  return <Catch><Suspense fallback={<Loading />}>{children}</Suspense></Catch>;
}
