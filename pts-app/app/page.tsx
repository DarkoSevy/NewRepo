import { HeroScrollDemo } from "@/components/ui/hero-scroll-demo";

export default function Home() {
  return (
    <main className="bg-white dark:bg-black">

      {/* ── Section 1: Landing hero so user has to scroll down ── */}
      <section className="h-screen flex flex-col items-center justify-center text-center px-6 bg-gradient-to-b from-zinc-50 to-white dark:from-zinc-950 dark:to-black">
        <p className="text-sm font-semibold tracking-widest text-zinc-400 uppercase mb-4">
          Scroll down to see the magic
        </p>
        <h1 className="text-5xl md:text-7xl font-bold text-zinc-900 dark:text-white leading-tight mb-6">
          Container Scroll
          <br />
          <span className="text-transparent bg-clip-text bg-gradient-to-r from-violet-500 to-indigo-500">
            Animation Demo
          </span>
        </h1>
        <p className="text-lg text-zinc-500 dark:text-zinc-400 max-w-xl mb-10">
          As you scroll, the card tilts from a 3D perspective into a flat view.
          Built with Framer Motion + shadcn + Tailwind.
        </p>
        {/* Bouncing arrow */}
        <div className="animate-bounce text-zinc-400 dark:text-zinc-600">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M12 5v14M5 12l7 7 7-7" />
          </svg>
        </div>
      </section>

      {/* ── Section 2: The scroll animation component ── */}
      <HeroScrollDemo />

      {/* ── Section 3: After the animation, show features ── */}
      <section className="py-32 px-6 bg-zinc-50 dark:bg-zinc-950">
        <div className="max-w-4xl mx-auto text-center mb-16">
          <p className="text-sm font-semibold tracking-widest text-violet-500 uppercase mb-3">
            How it works
          </p>
          <h2 className="text-4xl font-bold text-zinc-900 dark:text-white">
            Three moving parts
          </h2>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 max-w-4xl mx-auto">
          {[
            {
              icon: (
                <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
              ),
              title: "useScroll",
              desc: "Framer Motion tracks scrollYProgress (0 → 1) as the container passes through the viewport.",
            },
            {
              icon: (
                <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
              ),
              title: "useTransform",
              desc: "Maps scroll progress to rotateX (20° → 0°), scale (1.05 → 1), and translateY (0 → -100px).",
            },
            {
              icon: (
                <>
                  <rect x="2" y="3" width="20" height="14" rx="2" />
                  <path d="M8 21h8M12 17v4" />
                </>
              ),
              title: "motion.div",
              desc: "Applies the animated values to the card wrapper, creating the smooth 3D tilt-to-flat effect.",
            },
          ].map(({ icon, title, desc }) => (
            <div
              key={title}
              className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-2xl p-8 text-center"
            >
              <div className="w-12 h-12 rounded-xl bg-violet-100 dark:bg-violet-900/30 flex items-center justify-center mx-auto mb-5">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none"
                  stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"
                  className="text-violet-600 dark:text-violet-400">
                  {icon}
                </svg>
              </div>
              <h3 className="text-lg font-semibold text-zinc-900 dark:text-white mb-2">
                {title}
              </h3>
              <p className="text-sm text-zinc-500 dark:text-zinc-400 leading-relaxed">
                {desc}
              </p>
            </div>
          ))}
        </div>
      </section>

    </main>
  );
}
